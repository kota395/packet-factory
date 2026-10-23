/** 直近の統計と推移。流量モデルの結果を一定間隔ごとに受け取って集計する */

const WINDOW_MS = 5000;
const HISTORY_MAX = 900;

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

/** 1 秒ごとの推移。グラフ表示用 */
export interface History {
  t: number[];
  pv: number[];
  p99: number[];
  errorRate: number[];
  users: number[];
}

interface Sample {
  dtMs: number;
  pv: number;
  errors: number;
  latencyMs: number;
  p99Ms: number;
  revenue: number;
}

export class Metrics {
  totalPv = 0;
  totalErrors = 0;
  readonly history: History = { t: [], pv: [], p99: [], errorRate: [], users: [] };

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
      if (span > WINDOW_MS) {
        this.samples.splice(0, i);
        break;
      }
    }
    this.recompute();
  }

  /** 秒の境目で推移を記録する */
  advance(timeMs: number, users: number): void {
    const sec = Math.floor(timeMs / 1000);
    while (this.second < sec) {
      this.second++;
      const h = this.history;
      h.t.push(this.second);
      h.pv.push(this.stats.pv);
      h.p99.push(this.stats.p99Ms);
      h.errorRate.push(this.stats.errorRate);
      h.users.push(users);
      if (h.t.length > HISTORY_MAX) for (const series of Object.values(h)) series.shift();
    }
  }

  get rolling(): RollingStats {
    return this.stats;
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
