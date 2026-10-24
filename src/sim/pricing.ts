/**
 * お金まわりの設定。価格と維持費はすべてここで調整できる。
 *
 *  - START_MONEY …… 最初の資金
 *  - PRICE_SCALE …… すべての購入価格(機器・ラック・ケーブル・解放・強化)に掛かる倍率
 *  - MODEL_PRICES …… 機器の価格。first が 1 台目、growth が同じ機種を 1 台増やすごとの倍率(1 なら定価のまま)
 *  - RACK_PRICE …… ラック区画を借りる初期費用(2 本目から)
 *  - UPKEEP …… 維持費($/秒)。ラックの賃料は電力契約のレベルで、回線は契約速度で変わる
 *  - CABLE_PRICES …… ケーブルの値段(本体 + 1m あたり)
 *  - UNLOCK_PRICES / UPGRADE_PRICES …… 投資の価格(新しいサービスを始める価格も UNLOCK_PRICES)
 *  - CAMPAIGN_PRICE …… ショッピングのキャンペーンの価格(ユーザー数で変わる)
 *
 * n 回目(0 始まり)の価格 = first × growth^n × PRICE_SCALE
 * 変えたら `npm run balance` で節目の時刻を確認する。
 */
import type { ModelId, UnlockId, UpgradeId } from './types';

export interface GrowingPrice {
  /** 最初の 1 回の価格 */
  readonly first: number;
  /** 1 回買うごとに次の価格が何倍になるか */
  readonly growth: number;
}

export const START_MONEY = 400;

/** 全体の物価。2 にすると何もかも 2 倍の値段になる */
export const PRICE_SCALE = 1;

/** 機器を撤去(中古で売却)したときに戻ってくる割合 */
export const SELL_REFUND_RATE = 0.5;

export const MODEL_PRICES: Readonly<Record<Exclude<ModelId, 'handoff'>, GrowingPrice>> = {
  'srv-1u-e': { first: 300, growth: 1 },
  'srv-1u-d': { first: 900, growth: 1 },
  'srv-2u-db': { first: 2500, growth: 1 },
  'srv-2u-hv': { first: 8000, growth: 1 },
  'nas-2u': { first: 15_000, growth: 1 },
  'sw-24': { first: 150, growth: 1 },
  'sw-48': { first: 1500, growth: 1 },
  'agg-10g': { first: 6000, growth: 1 },
};

/** ラック区画を借りる初期費用。1 本目は最初から借りているので、2 本目が first */
export const RACK_PRICE: GrowingPrice = { first: 3000, growth: 1.25 };

export const UPKEEP = {
  /** ラック 1 本あたりの賃料($/秒)。電力契約のレベルごと */
  rackByPowerLevel: [0.1, 0.2, 0.3, 0.5],
  /** 回線契約($/秒)。契約のレベルごと */
  uplinkByLevel: [0.02, 0.4, 3],
  /** 電気代: 実際に使っている電力 1kW あたり($/秒) */
  perKw: 0.1,
} as const;

/** ケーブル: 本体(コネクタやトランシーバ込み)+ 長さ 1m あたり */
export const CABLE_PRICES = {
  copper: { base: 2, perM: 0.4 },
  fiber: { base: 60, perM: 1 },
} as const;

export const UNLOCK_PRICES: Readonly<Record<UnlockId, number>> = {
  // 事業
  images: 2500,
  comments: 6000,
  // 新しいサービス
  shop: 10_000,
  photo: 40_000,
  video: 150_000,
  // ソフトウェア
  lb: 800,
  cache: 2000,
  replication: 8000,
  virtualization: 20_000,
  // 機器
  tenGig: 5000,
  agg: 12_000,
  storage: 30_000,
  bgp: 15_000,
};

export const UPGRADE_PRICES: Readonly<Record<UpgradeId, GrowingPrice>> = {
  marketing: { first: 25, growth: 2 },
  monetize: { first: 80, growth: 2.3 },
  /** 回線契約: 100M → 1G → 10G */
  uplink: { first: 1500, growth: 15 },
  /** 電力契約: すべてのラックの電力上限を上げる */
  rackPower: { first: 2500, growth: 3 },
};

/** キャンペーン 1 回の価格 = base + ショッピングのユーザー 1 人あたり perUser */
export const CAMPAIGN_PRICE = { base: 500, perUser: 1 } as const;

export function campaignPrice(users: number): number {
  return Math.round((CAMPAIGN_PRICE.base + CAMPAIGN_PRICE.perUser * users) * PRICE_SCALE);
}

/** n 回目(0 始まり)の購入価格 */
export function growingPrice(p: GrowingPrice, n: number): number {
  return Math.round(p.first * p.growth ** n * PRICE_SCALE);
}

export function unlockPrice(id: UnlockId): number {
  return Math.round(UNLOCK_PRICES[id] * PRICE_SCALE);
}

export function modelPrice(id: ModelId, owned: number): number {
  if (id === 'handoff') return 0;
  return growingPrice(MODEL_PRICES[id], owned);
}

export function cablePrice(fiber: boolean, meters: number): number {
  const p = fiber ? CABLE_PRICES.fiber : CABLE_PRICES.copper;
  return Math.round((p.base + p.perM * meters) * PRICE_SCALE);
}
