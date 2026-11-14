/** 分析基盤: 各サービスの web からログを Hadoop に集め、機械学習のノードへ渡す。集められた割合で単価が上がる */
import { ANALYTICS } from '../config';
import { roleKey } from '../types';
import type { RoleId } from '../types';
import type { AnalyticsFlow, FlowInput } from './types';
import { avg } from './math';
import type { Ledger } from './ledger';
import type { ServicePlan } from './service';

/** 負荷を積む。返す finish() は、負荷が積み終わったあとに結果(どれだけ集計・学習できたか)を求め、警告を足す */
export function planAnalytics(ledger: Ledger, input: FlowInput, plans: readonly ServicePlan[]) {
  const { problems, nodeList, name, isActive, path, send, addWork, addGpuWork, hasGpu, addIo, nodePass } = ledger;
  // ---- 分析基盤: 各サービスの web からログを Hadoop に集め、機械学習のノードへ渡す
  const dataNodes = (role: RoleId) => nodeList.filter((n) => n.roles.includes(roleKey('data', role)) && isActive(roleKey('data', role))).map((n) => n.id);
  const hadoops = input.analytics?.hadoop ? dataNodes('hadoop') : [];
  const mls = input.analytics?.ml ? dataNodes('ml') : [];
  let logMBps = 0;
  let deliveredMBps = 0;
  for (const p of plans) {
    const mb = (p.svc.pv * ANALYTICS.logKB) / 1000;
    logMBps += mb;
    if (!hadoops.length) continue;
    const per = p.webs.length ? mb / p.webs.length : 0;
    for (const w of p.webs) {
      const reach = hadoops.filter((h) => path(w, h));
      for (const h of reach) send(w, h, ((per / reach.length) * 8) / 1000, 0);
      if (reach.length) deliveredMBps += per;
    }
  }
  const mbPerHadoop = hadoops.length ? deliveredMBps / hadoops.length : 0;
  for (const h of hadoops) {
    addWork(h, roleKey('data', 'hadoop'), mbPerHadoop, ANALYTICS.hadoopCpuMsPerMB);
    addIo(h, mbPerHadoop * ANALYTICS.hadoopIoPerMB);
  }
  // 学習は集めたログ全体を使う。Hadoop から学習のノードへ渡す
  const mbPerMl = mls.length && hadoops.length ? deliveredMBps / mls.length : 0;
  for (const m of mls) {
    for (const h of hadoops) if (path(h, m)) send(h, m, ((mbPerMl / hadoops.length) * 8) / 1000, 0);
    if (hasGpu(m)) addGpuWork(m, roleKey('data', 'ml'), mbPerMl, ANALYTICS.mlGpuMsPerMB);
    else addWork(m, roleKey('data', 'ml'), mbPerMl, ANALYTICS.mlGpuMsPerMB * ANALYTICS.mlCpuSlowdown);
  }

  const finish = (): AnalyticsFlow => {
    // 分析: 届いたログのうち、溢れずに処理できた割合
    const coverage = logMBps > 0 && hadoops.length ? (deliveredMBps / logMBps) * avg(hadoops.map(nodePass)) : 0;
    const mlCoverage = coverage > 0 && mls.length ? coverage * avg(mls.map(nodePass)) : 0;
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
    for (const m of mls) if (!hasGpu(m)) problems.push(`分析基盤: ${name(m)} に GPU がないので、機械学習を CPU で動かしています(遅い)`);
    return analytics;
  };
  return { finish };
}
