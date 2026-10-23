/**
 * 直近の統計と推移。流量モデルの結果を一定間隔ごとに受け取って集計し、
 * 1 秒ごとにダッシュボード用の推移(最大 METRICS.historySec 秒)を残す。
 */
import { METRICS } from './config';

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

interface Sample {
  dtMs: number;
  pv: number;
  errors: number;
  latencyMs: number;
  p99Ms: number;
  revenue: number;
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

export class Metrics {
  totalPv = 0;
  totalErrors = 0;
  readonly history: History = emptyHistory();
  /** 資源ごとの使用率の推移。history.t と同じ長さで、その秒に無かった資源は null */
  readonly resources = new Map<string, { label: string; rho: (number | null)[] }>();

  private samples: Sample[] = [];
  private second = 0;
  private stats: RollingStats = { pv: 0, errorRate: 0, latencyMs: 0, p99Ms: 0, revenuePerSec: 0 };

  /** dtMs の間に pv 件(/秒ではなく件数)が来て、errors 件が失敗し、revenue を稼いだ */
  record(dtMs: number, pv: number, errors: number, latencyMs: number, p99Ms: number, revenue: number): void {
    this.totalPv += pv;
    this.totalErrors += errors;
    this.samples.push({ dtMs, pv, errors, latencyMs, p99Ms, revenue });
    let span = 0;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      span += this.samples[i].dtMs;
      if (span > METRICS.windowMs) {
        this.samples.splice(0, i);
        break;
      }
    }
    this.recompute();
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
    return this.stats;
  }

  private push(sec: number, s: Snapshot): void {
    const h = this.history;
    h.t.push(sec);
    h.pv.push(this.stats.pv);
    h.errorRate.push(this.stats.errorRate);
    h.latency.push(this.stats.latencyMs);
    h.p99.push(this.stats.p99Ms);
    h.users.push(s.users);
    h.market.push(s.market);
    h.revenue.push(this.stats.revenuePerSec);
    h.upkeep.push(s.upkeep);
    h.money.push(s.money);
    h.capacity.push(s.capacity);
    const len = h.t.length;
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
      for (const [key, series] of this.resources) {
        series.rho.shift();
        if (series.rho.every((v) => v === null)) this.resources.delete(key);
      }
    }
  }

  private recompute(): void {
    let ms = 0;
    let pv = 0;
    let errors = 0;
    let revenue = 0;
    let lat = 0;
    let p99 = 0;
    for (const s of this.samples) {
      ms += s.dtMs;
      pv += s.pv;
      errors += s.errors;
      revenue += s.revenue;
      lat += s.latencyMs * s.pv;
      p99 = Math.max(p99, s.p99Ms);
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
