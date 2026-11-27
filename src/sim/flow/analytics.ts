/** 分析基盤: 各サービスの web からログを Hadoop に集め、機械学習のノードへ渡す。集められた割合で単価が上がる */
import { ANALYTICS } from '../config';
import { roleKey } from '../types';
import type { RoleId } from '../types';
import type { AnalyticsFlow, FlowInput } from './types';
import type { Ledger } from './ledger';
import type { ServicePlan } from './service';

/** 負荷を積む。返す finish() は、負荷が積み終わったあとに結果(どれだけ集計・学習できたか)を求め、警告を足す */
export function planAnalytics(ledger: Ledger, input: FlowInput, plans: readonly ServicePlan[]) {
  const { problems, nodeList, name, isActive, path, send, addWork, addGpuWork, hasGpu, addIo, nodePass, along } = ledger;
  // ---- 分析基盤: 各サービスの web からログを Hadoop に集め、機械学習のノードへ渡す
  const dataNodes = (role: RoleId) => nodeList.filter((n) => n.roles.includes(roleKey('data', role)) && isActive(roleKey('data', role))).map((n) => n.id);
  const hadoops = input.analytics?.hadoop ? dataNodes('hadoop') : [];
  const mls = input.analytics?.ml ? dataNodes('ml') : [];
  let logMBps = 0;
  /** web → hadoop、hadoop → ml に送ったログ(MB/秒)。カバー率は、届いた経路と受けたノードが溢れずに通した分で数える */
  const toHadoop: { from: number; to: number; mb: number }[] = [];
  const toMl: { from: number; to: number; mb: number }[] = [];
  const received = new Map<number, number>(hadoops.map((h) => [h, 0]));
  for (const p of plans) {
    const mb = (p.svc.pv * ANALYTICS.logKB) / 1000;
    logMBps += mb;
    if (!hadoops.length) continue;
    const per = p.webs.length ? mb / p.webs.length : 0;
    for (const w of p.webs) {
      const reach = hadoops.filter((h) => path(w, h));
      for (const h of reach) {
        const share = per / reach.length;
        send(w, h, (share * 8) / 1000, 0);
        toHadoop.push({ from: w, to: h, mb: share });
        received.set(h, received.get(h)! + share);
      }
    }
  }
  const deliveredMBps = [...received.values()].reduce((a, b) => a + b, 0);
  // 集計は、そのノードに届いたぶんだけ(届いていない hadoop は何もしない)
  for (const h of hadoops) {
    const mb = received.get(h)!;
    addWork(h, roleKey('data', 'hadoop'), mb, ANALYTICS.hadoopCpuMsPerMB);
    addIo(h, mb * ANALYTICS.hadoopIoPerMB);
  }
  // 学習は集めたログ全体を使う。各 hadoop は、届く学習のノードへ等分して渡す
  const learned = new Map<number, number>(mls.map((m) => [m, 0]));
  for (const h of hadoops) {
    const reach = mls.filter((m) => path(h, m));
    const mb = received.get(h)!;
    for (const m of reach) {
      const share = mb / reach.length;
      send(h, m, (share * 8) / 1000, 0);
      toMl.push({ from: h, to: m, mb: share });
      learned.set(m, learned.get(m)! + share);
    }
  }
  for (const m of mls) {
    const mb = learned.get(m)!;
    if (hasGpu(m)) addGpuWork(m, roleKey('data', 'ml'), mb, ANALYTICS.mlGpuMsPerMB);
    else addWork(m, roleKey('data', 'ml'), mb, ANALYTICS.mlGpuMsPerMB * ANALYTICS.mlCpuSlowdown);
  }

  const finish = (): AnalyticsFlow => {
    // 分析: 出たログのうち、経路で溢れずに hadoop へ届き、hadoop が溢れずに処理できた割合
    const okAt = new Map<number, number>();
    let processed = 0;
    for (const t of toHadoop) {
      const ok = t.mb * along(path(t.from, t.to))[0] * nodePass(t.to);
      okAt.set(t.to, (okAt.get(t.to) ?? 0) + ok);
      processed += ok;
    }
    const coverage = logMBps > 0 ? processed / logMBps : 0;
    // 学習: そのうち、ml へ溢れずに届いて学習できた割合
    let trained = 0;
    for (const t of toMl) {
      const rate = okAt.get(t.from)! / received.get(t.from)!;
      trained += t.mb * rate * along(path(t.from, t.to))[0] * nodePass(t.to);
    }
    const mlCoverage = logMBps > 0 ? trained / logMBps : 0;
    const analytics: AnalyticsFlow = {
      logMBps,
      coverage,
      mlCoverage,
      boost: 1 + ANALYTICS.hadoopBoost * coverage + ANALYTICS.mlBoost * mlCoverage,
      hadoop: hadoops,
      ml: mls,
    };
    if (input.analytics?.hadoop && !hadoops.length) problems.push('分析基盤: 役割「hadoop」のサーバがありません(ログを集められない)');
    if (hadoops.length && deliveredMBps < logMBps - 1e-9) problems.push('分析基盤: web から hadoop に届かないログがあります');
    if (input.analytics?.ml && hadoops.length && !mls.length) problems.push('分析基盤: 役割「ml」のサーバがありません');
    for (const h of hadoops) if (deliveredMBps > 0 && !received.get(h)) problems.push(`分析基盤: ${name(h)} にログが届いていません(web からの経路がない)`);
    for (const m of mls) if (deliveredMBps > 0 && !learned.get(m)) problems.push(`分析基盤: ${name(m)} にログが届いていません(hadoop からの経路がない)`);
    for (const m of mls) if (!hasGpu(m)) problems.push(`分析基盤: ${name(m)} に GPU がないので、機械学習を CPU で動かしています(遅い)`);
    return analytics;
  };
  return { finish };
}
