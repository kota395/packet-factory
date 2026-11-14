/** 詳細パネルの中身: サービス全体の詳細(リクエストの流れ、詰まっている所)と、分析基盤 */
import { MODEL_BY_ID } from '../../sim/catalog';
import { ANALYTICS, CAMPAIGN, K8S, RACK, SERVICES, scopeName } from '../../sim/config';
import { nodeName } from '../../sim/flow';
import type { Simulation } from '../../sim/simulation';
import { ROLE_IDS, SERVICE_IDS, roleKey } from '../../sim/types';
import type { RoleId, Scope } from '../../sim/types';
import { compact, dataSize, money, rate } from '../format';
import { ROLE_LABEL, pct, load, gbps, rows, section } from './common';
import type { Content } from './common';

/** サービスの詳細のタブ(始めているサービスと、分析基盤があれば「データ」) */
export function serviceScopes(sim: Simulation): Scope[] {
  return [...sim.activeServices, ...(sim.isScopeActive('data') ? (['data'] as Scope[]) : [])];
}

/** 分析基盤: ログの量、処理しきれた割合、単価の上がり方、役割ごとのサーバ */
function analyticsContent(sim: Simulation, base: string, tabs: string): Content {
  const a = sim.flow.analytics;
  const f = sim.facility;
  const name = (id: number) => sim.flow.nodes.get(id)?.name ?? nodeName(f, id);
  const nodeRow = (id: number): [string, string] => {
    const l = sim.flow.nodeLoads.get(id);
    const gpu = l?.gpu !== undefined ? ` / GPU ${load(l.gpu)}` : '';
    return [name(id), l ? `CPU ${load(l.cpu)} / IO ${load(l.io)}${gpu}` : '-'];
  };
  const cov = (v: number) => `<span class="${v >= 0.99 ? 'ok' : v >= 0.7 ? 'warn' : 'bad'}">${pct(v)}</span>`;
  const summary: [string, string][] = [
    ['ログ', `${a.logMBps.toFixed(2)} MB/秒(1 ページビュー ${ANALYTICS.logKB} KB)`],
    ['集計(Hadoop)', `${cov(a.coverage)} 処理 → 単価 +${Math.round(ANALYTICS.hadoopBoost * a.coverage * 100)}%`],
  ];
  if (sim.unlocks.has('ml')) {
    summary.push(['機械学習', `${cov(a.mlCoverage)} 処理 → 単価 +${Math.round(ANALYTICS.mlBoost * a.mlCoverage * 100)}%`]);
  }
  summary.push(['すべてのサービスの単価', `<b>×${a.boost.toFixed(2)}</b>`]);
  const problems = sim.flow.problems.filter((p) => p.startsWith('分析基盤')).map((p) => `<li>${p.replace('分析基盤: ', '')}</li>`);
  return {
    key: `service:data@${base}`,
    title: 'サービス',
    subtitle: '分析基盤',
    desc: 'すべてのサービスの web からアクセスログを hadoop に集めて集計し、ml(機械学習)で広告とおすすめを当てる。処理しきれた割合に応じて単価が上がる。',
    fixed: tabs,
    live:
      section('効果', rows(summary)) +
      (problems.length ? section('警告', `<ul class="problems">${problems.join('')}</ul>`) : '') +
      section('hadoop', a.hadoop.length ? rows(a.hadoop.map(nodeRow)) : '<div class="muted small">まだありません(サーバか VM に役割「hadoop」を付ける)</div>') +
      (sim.unlocks.has('ml')
        ? section('ml', a.ml.length ? rows(a.ml.map(nodeRow)) : '<div class="muted small">まだありません(GPU を載せたサーバに役割「ml」を付ける)</div>')
        : ''),
  };
}

export function serviceContent(sim: Simulation, base: string, tab: Scope): Content {
  const flow = sim.flow;
  const f = sim.facility;
  const name = (id: number) => flow.nodes.get(id)?.name ?? nodeName(f, id);
  const active = sim.activeServices;
  // サービスのタブ(2 つ以上始めているか、分析基盤があれば)
  const scopes = serviceScopes(sim);
  const tabs =
    scopes.length > 1
      ? `<div class="svc-tabs">${scopes
          .map((s) => `<button type="button" class="${s === tab ? 'on' : ''}" data-act="svc" data-svc="${s}">${scopeName(s)}</button>`)
          .join('')}</div>`
      : '';
  if (tab === 'data') return analyticsContent(sim, base, tabs);
  const id = tab;
  const def = SERVICES[id];
  const sf = flow.services[id];
  const r = sim.metrics.rollingOf(id);
  const W = sim.workloadOf(id);

  let fixed = tabs;
  // キャンペーン(ショッピング)
  let campaign = '';
  if (id === 'shop') {
    const err = sim.campaignError();
    const state = sim.campaignActive
      ? `<span class="ok">実施中(あと ${Math.ceil((sim.campaign.until - sim.time) / 1000)} 秒)</span>`
      : sim.campaign.cooldownUntil > sim.time
        ? `<span class="muted">次まであと ${Math.ceil((sim.campaign.cooldownUntil - sim.time) / 1000)} 秒</span>`
        : '打てます';
    fixed += section(
      'キャンペーン',
      `<div class="desc small">払うとすぐ始まり、${CAMPAIGN.durationSec} 秒間 訪問が ×${CAMPAIGN.trafficMul}、注文の単価が ×${CAMPAIGN.revenueMul}。終わると ${CAMPAIGN.cooldownSec} 秒は打てない。</div>` +
        `<div class="actions"><button type="button" class="primary" data-act="campaign" ${err ? `disabled title="${err}"` : ''}>キャンペーンを打つ(${money(sim.campaignPrice())})</button></div>`,
    );
    campaign = section('キャンペーンの状態', rows([['状態', state]]));
  }
  // Kubernetes: 役割を Deployment にすると、Pod が自動で置かれて増減する
  let k8s = '';
  if (sim.unlocks.has('kubernetes')) {
    const deployable = def.roles.filter((role) => K8S.roles.includes(role));
    const buttons = deployable
      .map((role) => {
        const key = roleKey(id, role);
        const on = sim.deployments.has(key);
        const err = sim.deploymentError(key);
        return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="deploy" data-role="${key}" ${err && !on ? `disabled title="${err}"` : ''}>${ROLE_LABEL[role]}</button>`;
      })
      .join('');
    fixed += section(
      'Kubernetes(Deployment にする役割)',
      `<div class="desc small">Pod は CPU ${Math.round(K8S.targetCpu * 100)}% を目標に ${K8S.minPods}〜${K8S.maxPods} 個で自動で増減します。BGP を使うワーカーの Pod は LB なしで受けられます。</div><div class="role-buttons">${buttons}</div>`,
    );
    const podList: [string, string][] = [];
    for (const role of deployable) {
      const key = roleKey(id, role);
      if (!sim.deployments.has(key)) continue;
      const placed = sim.pods.filter((p) => p.role === key).reduce((n, p) => n + p.count, 0);
      const pending = sim.podsPending.get(key) ?? 0;
      podList.push([
        role,
        `Pod ${placed}${pending ? ` <span class="bad">(待ち ${pending})</span>` : ''} / 目標 ${sim.deployments.get(key)}`,
      ]);
    }
    if (podList.length) k8s = section('Pod', rows(podList));
  }

  const inst = sf?.instances;
  const count = (role: RoleId) => inst?.[role].length ?? 0;
  const chain: string[] = [`回線 ${gbps(sim.uplinkGbps)}`];
  // LB: アプライアンス(HA ペアはアクティブの 1 台)と SLB
  const lbEntries = (sf?.entries ?? []).filter((n) => {
    const dev = f.devices.get(n);
    return n > 0 && dev && MODEL_BY_ID[dev.model].category === 'lb';
  }).length;
  if (lbEntries) chain.push(`LB ×${lbEntries}`);
  if (count('lb')) chain.push(`SLB ×${count('lb')}`);
  chain.push(`web ×${count('web')}`);
  if (count('cache')) chain.push(`cache ×${count('cache')}`);
  if (W.search) chain.push(count('search') ? `search ×${count('search')}` : 'search(db が肩代わり)');
  const dbMode =
    count('db') > 1 ? (sim.unlocks.has('sharding') ? '(シャーディング)' : sim.unlocks.has('partition') ? '(機能分割)' : '') : '';
  chain.push(`db ×${count('db')}${dbMode}`);
  if (count('replica')) chain.push(`replica ×${count('replica')}`);
  const side: string[] = [];
  if (W.media) side.push(count('media') ? `media ×${count('media')}` : 'media(web が肩代わり)');
  if (W.upload) side.push(count('worker') ? `worker ×${count('worker')}` : 'worker(web が肩代わり)');

  const roleRows: [string, string][] = [];
  if (inst) {
    for (const role of ROLE_IDS) {
      for (const n of inst[role]) {
        const l = flow.nodeLoads.get(n);
        if (!l) continue;
        const io = ['db', 'replica', 'search', 'media'].includes(role) ? ` / IO ${load(l.io)}` : '';
        roleRows.push([`${role}: ${name(n)}`, `CPU ${load(l.cpu)}${io}`]);
      }
    }
  }

  const work: [string, string][] = [
    ['ユーザー', `${compact(sim.serviceUsers[id])} / 市場 ${compact(sim.marketOf(id))} 人`],
    ['ページビュー', `${compact(r.pv, 1)} /秒(キャパシティ ${compact(sim.capacityOf(id), 1)})`],
    ['1 ページで返すデータ', dataSize(W.pageKB)],
    ['db の読み込み / 書き込み', `${W.dbReads} / ${W.dbWrites || 'なし'} 回/ページ`],
  ];
  if (W.search) work.push(['検索', `${W.search.perPv} 回/ページ`]);
  if (W.media) work.push(['画像・動画の取得', `${W.media.perPv} 回 × ${dataSize(W.media.kb)}/ページ`]);
  if (W.upload) work.push(['投稿', `${W.upload.perPv} 件 × ${dataSize(W.upload.kb)}/ページ(加工 ${W.upload.workerCpuMs / 1000} 秒)`]);
  work.push(
    ['成功率', `<span class="${r.errorRate > 0.05 ? 'bad' : r.errorRate > 0.01 ? 'warn' : 'ok'}">${(100 - r.errorRate * 100).toFixed(1)}%</span>`],
    ['応答(平均 / p99 見積もり)', `${Math.round(r.latencyMs)} / ${Math.round(r.p99Ms)} ms`],
  );
  const u = sim.upkeep;
  const money_: [string, string][] = [
    ...active.map((s): [string, string] => [`売上(${SERVICES[s].name})`, rate(sim.metrics.rollingOf(s).revenuePerSec)]),
    ['ラック賃料', rate(-u.racks)],
    [`回線(${sim.lineCount} 本)`, rate(-u.uplink)],
    ...(sim.unlocks.has('cdn') ? ([[`CDN(${(sim.cdnGBps * 8).toFixed(2)} Gbps)`, rate(-u.cdn)]] as [string, string][]) : []),
    ['電気代', rate(-u.power)],
  ];
  const b = flow.bottleneck;
  // 複数のサービスが動いていれば、このサービスの警告と、機器など全体の警告だけ
  const list =
    active.length > 1
      ? [...(sf?.problems ?? []), ...flow.problems.filter((p) => !SERVICE_IDS.some((s) => p.startsWith(`${SERVICES[s].name}: `)))]
      : flow.problems;
  const problems = list.map((p) => `<li>${p}</li>`).join('');
  return {
    key: `service:${id}@${base}@${active.length}`,
    title: 'サービス',
    subtitle: def.name,
    desc: '',
    fixed,
    live:
      campaign +
      k8s +
      section(
        '流れ',
        `<div class="chain">${chain.join(' → ')}</div>` + (side.length ? `<div class="chain">${side.join('・')}</div>` : ''),
      ) +
      (problems ? section('警告', `<ul class="problems">${problems}</ul>`) : '') +
      section('一番詰まっている所(全体)', b ? rows([[b.label, load(b.rho)]]) : '<div class="muted small">なし</div>') +
      section('役割ごとのサーバ', rows(roleRows)) +
      section('仕事量', rows(work)) +
      section('収支', rows(money_)) +
      `<div class="muted small">ラックの電力上限 ${sim.rackPowerW}W・高さ ${RACK.units}U</div>`,
  };
}
