import { TIMEOUT_MS } from './config';
import type { ErrorReason, ReqKind } from './types';

const BIN_MS = 10;
const BIN_COUNT = Math.ceil(TIMEOUT_MS / BIN_MS) + 1;
const WINDOW_SECONDS = 5;
const HISTORY_MAX = 900;

/** レイテンシのヒストグラム。10ms 刻みで数えて、パーセンタイルを安く求める */
export class LatencyHistogram {
  readonly counts = new Uint32Array(BIN_COUNT);
  total = 0;

  add(ms: number): void {
    const i = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(ms / BIN_MS)));
    this.counts[i]++;
    this.total++;
  }

  addAll(other: LatencyHistogram): void {
    for (let i = 0; i < BIN_COUNT; i++) this.counts[i] += other.counts[i];
    this.total += other.total;
  }

  /** q は 0〜1。ビンの上端を返すので、実際の値以上の保守的な見積もりになる */
  percentile(q: number): number {
    if (this.total === 0) return 0;
    const target = Math.max(1, Math.ceil(q * this.total));
    let acc = 0;
    for (let i = 0; i < BIN_COUNT; i++) {
      acc += this.counts[i];
      if (acc >= target) return (i + 1) * BIN_MS;
    }
    return BIN_COUNT * BIN_MS;
  }
}

interface Bucket {
  success: number;
  errors: number;
  hist: LatencyHistogram;
}

const newBucket = (): Bucket => ({ success: 0, errors: 0, hist: new LatencyHistogram() });

export interface RollingStats {
  /** 直近の流量(成功+失敗 / 秒) */
  rps: number;
  p50: number;
  p99: number;
  /** 0〜1 */
  errorRate: number;
}

/** 1 秒ごとの推移。グラフ表示用 */
export interface History {
  t: number[];
  rps: number[];
  p99: number[];
  errorRate: number[];
}

export class Metrics {
  totalSuccess = 0;
  totalErrors = 0;
  readonly successByKind: Record<ReqKind, number> = { static: 0, write: 0 };
  readonly errorsByReason: Record<ErrorReason, number> = { drop: 0, timeout: 0, 'no-route': 0 };
  readonly overall = new LatencyHistogram();
  readonly history: History = { t: [], rps: [], p99: [], errorRate: [] };

  private window: Bucket[] = [];
  private current: Bucket = newBucket();
  private second = 0;
  private stats: RollingStats = { rps: 0, p50: 0, p99: 0, errorRate: 0 };

  recordSuccess(kind: ReqKind, latencyMs: number): void {
    this.totalSuccess++;
    this.successByKind[kind]++;
    this.overall.add(latencyMs);
    this.current.success++;
    this.current.hist.add(latencyMs);
  }

  recordError(reason: ErrorReason): void {
    this.totalErrors++;
    this.errorsByReason[reason]++;
    this.current.errors++;
  }

  /** シミュレーション時刻を進める。秒の境目で直近の統計と履歴を更新する */
  advance(timeMs: number): void {
    const sec = Math.floor(timeMs / 1000);
    while (this.second < sec) {
      this.window.push(this.current);
      if (this.window.length > WINDOW_SECONDS) this.window.shift();
      this.current = newBucket();
      this.second++;
      this.recompute();
      this.pushHistory(this.second);
    }
  }

  get rolling(): RollingStats {
    return this.stats;
  }

  /** ステージ開始からの可用性(0〜1)。リクエストが無ければ 1 */
  get availability(): number {
    const n = this.totalSuccess + this.totalErrors;
    return n === 0 ? 1 : this.totalSuccess / n;
  }

  private recompute(): void {
    const hist = new LatencyHistogram();
    let success = 0;
    let errors = 0;
    for (const b of this.window) {
      hist.addAll(b.hist);
      success += b.success;
      errors += b.errors;
    }
    const n = success + errors;
    this.stats = {
      rps: this.window.length ? n / this.window.length : 0,
      p50: hist.percentile(0.5),
      p99: hist.percentile(0.99),
      errorRate: n ? errors / n : 0,
    };
  }

  private pushHistory(sec: number): void {
    const h = this.history;
    h.t.push(sec);
    h.rps.push(this.stats.rps);
    h.p99.push(this.stats.p99);
    h.errorRate.push(this.stats.errorRate);
    if (h.t.length > HISTORY_MAX) {
      h.t.shift();
      h.rps.shift();
      h.p99.shift();
      h.errorRate.shift();
    }
  }
}
