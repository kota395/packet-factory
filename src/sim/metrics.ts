/**
 * 直近の統計と推移。流量モデルの結果を一定間隔ごとに受け取って集計し、
 * 1 秒ごとにダッシュボード用の推移(最大 METRICS.historySec 秒)を残す。
 */
import { METRICS } from './config';
import type { ServiceId } from './types';

export interface RollingStats {
  /** ページビュー/秒(成功 + 失敗) */
  pv: number;
  /** 0〜1 */
  errorRate: number;
  /** 平均応答と p99 の見積もり(ms) */
  latencyMs: number;
  p99Ms: number;
  /** 直近の売上(/秒)。維持費は含まない */
  revenuePerSec: number;
}

/** 1 秒ごとに残す値。秒の境目でシミュレーションから受け取る */
export interface Snapshot {
  users: number;
  market: number;
  money: number;
  upkeep: number;
  /** 今の構成で捌けるページビュー/秒の見積もり */
  capacity: number;
  /** 資源ごとの使用率(キーは識別子、label は表示名) */
  resources: { key: string; label: string; rho: number }[];
  /** 動いているサービスごとのユーザー数・市場規模・キャパシティ */
  services: { id: ServiceId; users: number; market: number; capacity: number }[];
}

/** サービスごとの推移。History.t と同じ長さで、サービスを始める前は null */
export interface ServiceHistory {
  pv: (number | null)[];
  errorRate: (number | null)[];
  latency: (number | null)[];
  p99: (number | null)[];
  users: (number | null)[];
  market: (number | null)[];
  revenue: (number | null)[];
  capacity: (number | null)[];
}

/** 1 回の記録(dtMs の間の件数) */
export interface Sample {
  dtMs: number;
  pv: number;
  errors: number;
  latencyMs: number;
  p99Ms: number;
  revenue: number;
}

/** 1 秒ごとの推移。同じ長さの配列を並べる(uPlot にそのまま渡せる形) */
export interface History {
  t: number[];
  pv: number[];
  errorRate: number[];
  latency: number[];
  p99: number[];
  users: number[];
  market: number[];
  revenue: number[];
  upkeep: number[];
  money: number[];
  capacity: number[];
}

const emptyHistory = (): History => ({
  t: [],
  pv: [],
  errorRate: [],
  latency: [],
  p99: [],
  users: [],
  market: [],
  revenue: [],
  upkeep: [],
  money: [],
  capacity: [],
});

const emptyStats = (): RollingStats => ({ pv: 0, errorRate: 0, latencyMs: 0, p99Ms: 0, revenuePerSec: 0 });

/** 直近 METRICS.windowMs の集計 */
class Rolling {
  stats: RollingStats = emptyStats();
  private samples: Sample[] = [];

  add(s: Sample): void {
    this.samples.push(s);
    let span = 0;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      span += this.samples[i].dtMs;
      if (span > METRICS.windowMs) {
        this.samples.splice(0, i);
        break;
      }
    }
    let ms = 0;
    let pv = 0;
    let errors = 0;
    let revenue = 0;
    let lat = 0;
    let p99 = 0;
    for (const x of this.samples) {
      ms += x.dtMs;
      pv += x.pv;
      errors += x.errors;
      revenue += x.revenue;
      lat += x.latencyMs * x.pv;
      p99 = Math.max(p99, x.p99Ms);
    }
    const sec = ms / 1000;
    this.stats = {
      pv: sec ? pv / sec : 0,
      errorRate: pv ? errors / pv : 0,
      latencyMs: pv ? lat / pv : 0,
      p99Ms: pv ? p99 : 0,
      revenuePerSec: sec ? revenue / sec : 0,
    };
  }
}

const emptyServiceHistory = (len: number): ServiceHistory => {
  const nulls = () => new Array<number | null>(len).fill(null);
  return {
    pv: nulls(),
    errorRate: nulls(),
    latency: nulls(),
    p99: nulls(),
    users: nulls(),
    market: nulls(),
    revenue: nulls(),
    capacity: nulls(),
  };
};

export class Metrics {
  totalPv = 0;
  totalErrors = 0;
  readonly history: History = emptyHistory();
  /** サービスごとの推移 */
  readonly services = new Map<ServiceId, ServiceHistory>();
  /** 資源ごとの使用率の推移。history.t と同じ長さで、その秒に無かった資源は null */
  readonly resources = new Map<string, { label: string; rho: (number | null)[] }>();

  private second = 0;
  private total = new Rolling();
  private bySvc = new Map<ServiceId, Rolling>();

  /**
   * dtMs の間に pv 件(/秒ではなく件数)が来て、errors 件が失敗し、revenue を稼いだ。
   * services はサービスごとの内訳(合計が total)
   */
  record(total: Sample, services: (Sample & { id: ServiceId })[] = []): void {
    this.totalPv += total.pv;
    this.totalErrors += total.errors;
    this.total.add(total);
    for (const s of services) {
      let r = this.bySvc.get(s.id);
      if (!r) this.bySvc.set(s.id, (r = new Rolling()));
      r.add(s);
    }
  }

  /** サービスの直近の集計(まだ動いていなければすべて 0) */
  rollingOf(id: ServiceId): RollingStats {
    return this.bySvc.get(id)?.stats ?? emptyStats();
  }

  /** 秒の境目で推移を記録する。snapshot は境目を越えたときだけ呼ばれる */
  advance(timeMs: number, snapshot: () => Snapshot): void {
    const sec = Math.floor(timeMs / 1000);
    if (this.second >= sec) return;
    const snap = snapshot();
    while (this.second < sec) {
      this.second++;
      this.push(this.second, snap);
    }
  }

  get rolling(): RollingStats {
    return this.total.stats;
  }

  private push(sec: number, s: Snapshot): void {
    const h = this.history;
    const st = this.total.stats;
    h.t.push(sec);
    h.pv.push(st.pv);
    h.errorRate.push(st.errorRate);
    h.latency.push(st.latencyMs);
    h.p99.push(st.p99Ms);
    h.users.push(s.users);
    h.market.push(s.market);
    h.revenue.push(st.revenuePerSec);
    h.upkeep.push(s.upkeep);
    h.money.push(s.money);
    h.capacity.push(s.capacity);
    const len = h.t.length;
    for (const svc of s.services) {
      if (!this.services.has(svc.id)) this.services.set(svc.id, emptyServiceHistory(len - 1));
    }
    for (const [id, sh] of this.services) {
      const snap = s.services.find((x) => x.id === id);
      const r = this.bySvc.get(id)?.stats;
      sh.pv.push(snap && r ? r.pv : null);
      sh.errorRate.push(snap && r ? r.errorRate : null);
      sh.latency.push(snap && r ? r.latencyMs : null);
      sh.p99.push(snap && r ? r.p99Ms : null);
      sh.revenue.push(snap && r ? r.revenuePerSec : null);
      sh.users.push(snap?.users ?? null);
      sh.market.push(snap?.market ?? null);
      sh.capacity.push(snap?.capacity ?? null);
    }
    const seen = new Set<string>();
    for (const r of s.resources) {
      seen.add(r.key);
      let series = this.resources.get(r.key);
      if (!series) {
        series = { label: r.label, rho: new Array(len - 1).fill(null) };
        this.resources.set(r.key, series);
      }
      series.label = r.label;
      series.rho.push(r.rho);
    }
    for (const [key, series] of this.resources) if (!seen.has(key)) series.rho.push(null);

    if (len > METRICS.historySec) {
      for (const series of Object.values(h)) series.shift();
      for (const sh of this.services.values()) for (const series of Object.values(sh)) series.shift();
      for (const [key, series] of this.resources) {
        series.rho.shift();
        if (series.rho.every((v) => v === null)) this.resources.delete(key);
      }
    }
  }
}
