/**
 * 需要予測。ユーザー数はロジスティック成長(市場規模に近づくほど鈍る)なので、
 * 今のユーザー数・市場規模・成長率から先の値と、ある量に届くまでの時間を式で出せる。
 * 離脱(エラーや遅さ)は入れていないので、捌けている前提の「伸びる場合」の予測。
 */

/** t 秒後のユーザー数 */
export function logistic(u0: number, market: number, rate: number, tSec: number): number {
  if (u0 <= 0 || market <= 0) return 0;
  if (rate <= 0 || tSec <= 0) return u0;
  return market / (1 + ((market - u0) / u0) * Math.exp(-rate * tSec));
}

/** ユーザー数が target に届くまでの秒数。届かない(市場規模以上・成長率が 0 以下)なら null */
export function secondsUntil(u0: number, market: number, rate: number, target: number): number | null {
  if (target <= u0) return 0;
  if (target >= market || u0 <= 0 || rate <= 0) return null;
  return Math.log((market - u0) / u0 / (market / target - 1)) / rate;
}

/** 予測の点列(秒, ユーザー数) */
export function forecastSeries(u0: number, market: number, rate: number, horizonSec: number, stepSec: number): [number[], number[]] {
  const t: number[] = [];
  const u: number[] = [];
  for (let s = 0; s <= horizonSec; s += stepSec) {
    t.push(s);
    u.push(logistic(u0, market, rate, s));
  }
  return [t, u];
}
