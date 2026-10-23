import { SELL_REFUND_RATE } from '../sim/pricing';
import { UPGRADES } from '../sim/economy';
import type { NodeRuntime, Simulation } from '../sim/simulation';
import { DATA_ACCESS } from '../sim/config';
import { REQ_KINDS, type ReqKind } from '../sim/types';
import { bandwidth, compact, dataSize, money } from './format';

const KIND_LABEL: Record<ReqKind, string> = { static: '静的', read: '読み込み', write: '書き込み' };

/**
 * 盤面と詳細で使うノードの呼び名。同じ種類が複数あるときは番号を付ける(WEB 1, WEB 2…)。
 * 番号は置いた順(id 順)なので、撤去すると詰まる。
 */
export function nodeName(sim: Simulation, node: NodeRuntime): string {
  const same = [...sim.nodes.values()].filter((n) => n.kind === node.kind);
  if (same.length <= 1) return node.def.label;
  same.sort((a, b) => a.id - b.id);
  return `${node.def.label} ${same.indexOf(node) + 1}`;
}

/** レプリカに届く書き込みは利用者の書き込みではなく、複製の反映 */
const kindLabel = (node: NodeRuntime, k: ReqKind) => (node.def.replicaOf && k === 'write' ? '複製の反映' : KIND_LABEL[k]);

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** 負荷率に応じて色を付けた % 表示 */
function load(ratio: number): string {
  const cls = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok';
  return `<span class="${cls}">${pct(ratio)}</span>`;
}

function section(title: string, rows: [string, string][]): string {
  if (!rows.length) return '';
  return `
    <section class="info-sec">
      <h4>${title}</h4>
      <div class="rows-box">${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('')}</div>
    </section>`;
}

/** ノード詳細の本文(数値は呼ぶたびに最新になる) */
export function nodeInfoHtml(sim: Simulation, node: NodeRuntime): string {
  const d = node.def;
  const inRps = sim.inRpsOf(node);
  const avgKB = inRps > 0 ? node.inKBps / inRps : 0;
  const kinds = REQ_KINDS.filter((k) => node.inRps[k] >= 0.05);
  const byKind = kinds.map((k) => `${kindLabel(node, k)} ${compact(node.inRps[k], 1)}`).join(' / ');

  // ---- 流れ
  const flow: [string, string][] = [];
  if (node.kind === 'internet') {
    flow.push(['送り出し', `${compact(inRps, 1)} rps`]);
    if (kinds.length > 1) flow.push(['内訳', byKind]);
    if (sim.dataShare > 0) {
      flow.push(['データを使う割合', `${pct(sim.dataShare)}(読み込み ${pct(DATA_ACCESS.readShare)}・書き込み ${pct(1 - DATA_ACCESS.readShare)})`]);
    }
  } else {
    flow.push(['受信', `${compact(inRps, 1)} rps`]);
    if (kinds.length > 1) flow.push(['内訳', byKind]);
  }
  flow.push(['データ量', `${bandwidth(node.inKBps / 1000)}(平均 ${dataSize(avgKB)}/件)`]);
  if (d.cache) flow.push(['キャッシュから返却', `${compact(node.hitRps, 1)} rps`]);
  else if (d.terminates.length) {
    flow.push([`ここで完了(${d.terminates.filter((k) => d.accepts.includes(k)).map((k) => KIND_LABEL[k]).join('・')})`, `${compact(node.servedRps, 1)} rps`]);
  }
  for (const to of node.out) {
    const target = sim.nodes.get(to);
    if (!target) continue;
    const note = d.replicatesTo === target.kind ? '(複製)' : '';
    flow.push([`→ ${nodeName(sim, target)}${note}`, `${compact(sim.edgeRpsOf(node.id, to), 1)} rps`]);
  }
  if (d.localFallback && sim.dataShare > 0) {
    // 送り先がない種類は静的として返している(単価が下がる)
    for (const k of ['read', 'write'] as const) {
      if (d.accepts.includes(k) && !sim.routeTargets(node, k).length) {
        flow.push([`${KIND_LABEL[k]}の送り先`, '<span class="warn">なし(静的として返す)</span>']);
      }
    }
  } else if (d.maxOut > 0 && !node.out.length && !d.localFallback) {
    flow.push(['送り先', '<span class="bad">未接続</span>']);
  }
  if (d.replicaOf && !sim.isFed(node)) {
    flow.push(['複製元', '<span class="bad">DB から未接続(読み込みを受けられない)</span>']);
  }

  // ---- 能力
  const capacity: [string, string][] = [];
  if (node.kind !== 'internet') {
    const cap = sim.capacityRpsOf(node);
    const cpu = sim.cpuCapacityRpsOf(node);
    const bw = sim.bandwidthMBpsOf(node);
    capacity.push(['上限', `${compact(cap, 1)} rps(${load(cap > 0 ? inRps / cap : 0)})`]);
    capacity.push(['余裕', `${compact(Math.max(0, cap - inRps), 1)} rps`]);
    const times = REQ_KINDS.filter((k) => d.serviceMs[k] > 0)
      .map((k) => `${kindLabel(node, k)} ${sim.serviceMs(node, k).toFixed(1)}ms`)
      .join(' / ');
    capacity.push(['処理', `${d.workers} 並列 × ${times}`]);
    capacity.push(['処理の上限', `${compact(cpu)} rps(${load(inRps / cpu)})`]);
    if (Number.isFinite(bw)) {
      const used = node.inKBps / 1000;
      capacity.push(['帯域', `${bandwidth(used)} / ${bandwidth(bw)}(${load(used / bw)})`]);
      capacity.push(['帯域の上限', `${compact(sim.bandwidthCapacityRpsOf(node))} rps`]);
    }
    if (d.cache) capacity.push(['ヒット率', pct(sim.cacheHitRateOf(node))]);
    const max = sim.maxCountOf(node.kind);
    if (Number.isFinite(max)) capacity.push(['台数', `${sim.countOf(node.kind)} / ${max}`]);
    for (const u of UPGRADES.filter((x) => x.target?.nodes.includes(node.kind))) {
      capacity.push([u.name, `Lv ${sim.upgrades[u.id]}`]);
    }
  }

  // ---- 状態
  const status: [string, string][] = [];
  if (node.kind !== 'internet') {
    status.push(['処理中', `${node.busy.length} / ${d.workers}`]);
    status.push(['キュー', `${node.queue.length} / ${d.queueMax}`]);
    status.push(['平均待ち', `${Math.round(node.waitMs)}ms`]);
  }
  const e = node.errorsBy;
  status.push([
    'エラー累計',
    node.errors
      ? `溢れ ${compact(e.drop)} / 時間切れ ${compact(e.timeout)} / 行き先なし ${compact(e['no-route'])}`
      : '0',
  ]);

  // ---- 費用
  const cost: [string, string][] = [];
  if (node.kind !== 'internet') {
    cost.push(['維持費', `$${sim.upkeepOf(node.kind)}/秒`]);
    cost.push(['撤去で返金', money(Math.floor(node.paid * SELL_REFUND_RATE))]);
  }

  return section('流れ', flow) + section('能力', capacity) + section('状態', status) + section('費用', cost);
}
