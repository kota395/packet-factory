/**
 * お金まわりの設定。価格はすべてここで調整できる。
 *
 *  - START_MONEY …… 最初の資金
 *  - PRICE_SCALE …… すべての購入価格(ノード・解放・強化)に掛かる倍率
 *  - NODE_PRICES …… ノードの 1 台目の価格 first、1 台増やすごとの倍率 growth、維持費 upkeep($/秒)
 *  - UNLOCK_PRICES …… 解放(一度だけ買う)の価格
 *  - UPGRADE_PRICES …… 強化の Lv0 → Lv1 の価格 first と、1 レベル上げるごとの倍率 growth
 *
 * n 台目(0 始まり)のノードの価格 = first × growth^n × PRICE_SCALE
 * Lv n → n+1 の強化の価格 = first × growth^n × PRICE_SCALE
 *
 * 変えたら `npm run balance` で節目の時刻を確認する。
 */
import type { NodeKind, UnlockId, UpgradeId } from './types';

export interface GrowingPrice {
  /** 最初の 1 回の価格 */
  readonly first: number;
  /** 1 回買うごとに次の価格が何倍になるか */
  readonly growth: number;
}

export interface NodePrice extends GrowingPrice {
  /** 1 台あたりの維持費($/秒) */
  readonly upkeep: number;
}

export const START_MONEY = 60;

/** 全体の物価。2 にすると何もかも 2 倍の値段になる */
export const PRICE_SCALE = 1;

/** 撤去したときに戻ってくる割合(払った額に対して) */
export const SELL_REFUND_RATE = 0.5;

export const NODE_PRICES: Readonly<Record<Exclude<NodeKind, 'internet'>, NodePrice>> = {
  web: { first: 50, growth: 1.15, upkeep: 0.05 },
  lb: { first: 150, growth: 1.15, upkeep: 0.1 },
  db: { first: 400, growth: 1.5, upkeep: 0.3 },
  cache: { first: 600, growth: 1.2, upkeep: 0.2 },
  replica: { first: 500, growth: 1.2, upkeep: 0.3 },
  cdn: { first: 2000, growth: 1.15, upkeep: 1 },
};

export const UNLOCK_PRICES: Readonly<Record<UnlockId, number>> = {
  // 段階 2: 水平分散
  lb: 120,
  // 段階 3: データ層の分離
  writes: 1500,
  // 段階 4: 読み込みの分散
  cache: 3000,
  replica: 5000,
  // 段階 5: 重いコンテンツ
  images: 6000,
  cdn: 20_000,
  video: 300_000,
  // 段階 6: 書き込みの分散
  sharding: 2_500_000,
};

export const UPGRADE_PRICES: Readonly<Record<UpgradeId, GrowingPrice>> = {
  marketing: { first: 25, growth: 1.8 },
  monetize: { first: 80, growth: 2.1 },
  webPerf: { first: 150, growth: 2.2 },
  lbBandwidth: { first: 500, growth: 2.2 },
  dbPerf: { first: 800, growth: 2.2 },
  cacheMemory: { first: 2000, growth: 2.4 },
  cdnCache: { first: 15_000, growth: 2.5 },
  cdnBandwidth: { first: 10_000, growth: 2.2 },
  dbShards: { first: 500_000, growth: 4 },
};

/** n 回目(0 始まり)の購入価格 */
export function growingPrice(p: GrowingPrice, n: number): number {
  return Math.round(p.first * p.growth ** n * PRICE_SCALE);
}

export function unlockPrice(id: UnlockId): number {
  return Math.round(UNLOCK_PRICES[id] * PRICE_SCALE);
}
