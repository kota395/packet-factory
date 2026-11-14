/**
 * 流量モデル。ページビュー/秒と、機器・配線・役割から、各資源の使用率と成功率・応答時間を求める。
 * パケットを 1 個ずつ流す代わりに、流量の合計で計算するので機器が増えても軽い。
 *
 * サービス(ブログ・ショッピング・写真共有・動画配信)ごとに流れを積み、同じ機器やリンクを使えば負荷は合算される。
 * 1 ページビューの流れ: 回線 → (LB) → web → (cache) → db / レプリカ(ショッピングは検索も)
 * 写真・動画は、ページとは別に media から画像・動画を取得し、投稿は web → worker(加工)→ media(保存)へ流れる。
 * 通信はケーブルとスイッチを通り、通った資源の使用率が 1 を超えるとその分が溢れてエラーになる。
 *
 * 役割を動かす単位(ノード)は物理サーバか VM。VM はホストの CPU を分け合い、通信はホストの NIC から出入りする。
 * VM のディスクは、ホストのローカルディスクか共有ストレージ(ネットワーク越しの IO)に置く。
 */
import { MODEL_BY_ID } from './catalog';
import { NET, P99_FACTOR, SERVICES } from './config';
import type { Facility } from './facility';
import { planAnalytics } from './flow/analytics';
import { createLedger } from './flow/ledger';
import { avg } from './flow/math';
import { planService } from './flow/service';
import type { Bottleneck, FlowInput, FlowResult, ServiceFlow } from './flow/types';
import type { ServiceId } from './types';

export * from './flow/types';
export { isHaPort, lbGroups } from './flow/network';
export { computeNodes, nodeName } from './flow/nodes';

/**
 * 1 回ぶんの流量計算。
 *  1. 台帳を作る(ノード・経路・LB の HA)…… flow/ledger.ts
 *  2. サービスごとに負荷を積む …… flow/service.ts
 *  3. 分析基盤の負荷を積む …… flow/analytics.ts
 *  4. 使用率を確定して、サービスごとの成功率と応答時間、一番詰まっている所を求める
 */
export function computeFlow(facility: Facility, input: FlowInput): FlowResult {
  const ledger = createLedger(facility, input);
  const { g, devices, problems, nodeList, nodes, name, loads, linkRho } = ledger;
  const plans = input.services.map((svc) => planService(ledger, input, svc));
  const analyticsPlan = planAnalytics(ledger, input, plans);
  ledger.settle();
  const analytics = analyticsPlan.finish();

  const services: Partial<Record<ServiceId, ServiceFlow>> = {};
  let totalPv = 0;
  let okPv = 0;
  let latPv = 0;
  const many = plans.length > 1;
  for (const p of plans) {
    const { success, latencyMs } = p.evaluate();
    p.warnRoutes();
    const pv = p.svc.pv;
    services[p.svc.id] = {
      id: p.svc.id,
      pv,
      success,
      latencyMs,
      p99Ms: latencyMs * P99_FACTOR,
      instances: p.inst,
      entries: p.entries,
      problems: p.sp,
    };
    totalPv += pv;
    okPv += pv * success;
    latPv += pv * latencyMs;
    for (const msg of p.sp) problems.push(many ? `${SERVICES[p.svc.id].name}: ${msg}` : msg);
  }
  const success = totalPv > 0 ? okPv / totalPv : avg(plans.map((p) => services[p.svc.id]!.success));
  const latencyMs = totalPv > 0 ? latPv / totalPv : avg(plans.map((p) => services[p.svc.id]!.latencyMs));

  // ---- 表示用: ケーブルごとの使用率と、一番詰まっている所
  let bottleneck: Bottleneck | null = null;
  const consider = (label: string, rho: number) => {
    if (rho > 0 && (!bottleneck || rho > bottleneck.rho)) bottleneck = { label, rho };
  };
  for (const d of facility.devices.values()) {
    const l = devices.get(d.id)!;
    const storage = MODEL_BY_ID[d.model].category === 'storage';
    consider(MODEL_BY_ID[d.model].category === 'lb' ? `${d.name} の処理能力` : `${d.name} の CPU`, l.cpu);
    consider(storage ? `${d.name} の IOPS` : `${d.name} のディスク IO`, l.io);
    consider(`${d.name} の処理能力`, l.fabric);
  }
  for (const n of nodeList) if (n.vm) consider(`${n.name} の vCPU`, loads.get(n.id)!.cpu);
  for (const d of facility.devices.values()) consider(`${d.name} の GPU`, devices.get(d.id)!.gpu);
  for (const l of g.links) consider(`${name(l.a)} ⇄ ${name(l.b)} の帯域`, linkRho(l));

  return {
    pv: totalPv,
    success: plans.length ? success : 1,
    latencyMs: plans.length ? latencyMs : NET.internetRttMs,
    p99Ms: (plans.length ? latencyMs : NET.internetRttMs) * P99_FACTOR,
    services,
    analytics,
    devices,
    links: g.links,
    nodes,
    nodeLoads: loads,
    problems,
    bottleneck,
  };
}
