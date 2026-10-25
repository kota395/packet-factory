/**
 * お金まわりの設定。価格と維持費はすべてここで調整できる。
 *
 *  - START_MONEY …… 最初の資金
 *  - PRICE_SCALE …… すべての購入価格(機器・ラック・ケーブル・解放・強化)に掛かる倍率
 *  - MODEL_PRICES …… スイッチ・ストレージの価格。first が 1 台目、growth が同じ機種を 1 台増やすごとの倍率(1 なら定価のまま)
 *  - CHASSIS_PRICES / CPU_PRICES / MEMORY_PRICE_PER_GB / DRIVE_PRICES / NIC_PRICES …… サーバのシャーシとパーツの価格
 *    (サーバの価格 = シャーシ + パーツ。パーツを替えると、新しいパーツの価格から外したパーツの下取りを引いた額)
 *  - RACK_PRICE …… ラック区画を借りる初期費用(2 本目から)
 *  - UPKEEP …… 維持費($/秒)。ラックの賃料は電力契約のレベルで、回線は契約速度で変わる
 *  - CABLE_PRICES …… ケーブルの値段(本体 + 1m あたり)
 *  - UNLOCK_PRICES / UPGRADE_PRICES …… 投資の価格(新しいサービスを始める価格も UNLOCK_PRICES)
 *  - CAMPAIGN_PRICE …… ショッピングのキャンペーンの価格(ユーザー数で変わる)
 *
 * n 回目(0 始まり)の価格 = first × growth^n × PRICE_SCALE
 * 変えたら `npm run balance` で節目の時刻を確認する。
 */
import type { DriveType, ModelId, NicId, ServerParts, UnlockId, UpgradeId } from './types';

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

export const MODEL_PRICES: Readonly<Record<Exclude<ModelId, 'handoff' | 'srv-1u' | 'srv-2u'>, GrowingPrice>> = {
  'nas-2u': { first: 15_000, growth: 1 },
  'sw-24': { first: 150, growth: 1 },
  'sw-48': { first: 1500, growth: 1 },
  'agg-10g': { first: 6000, growth: 1 },
};

/** サーバのシャーシ(電源・ファン・オンボード NIC 込み。2U は背面の OS 用 SSD 2 本も込み) */
export const CHASSIS_PRICES: Readonly<Record<'srv-1u' | 'srv-2u', number>> = {
  'srv-1u': 150,
  'srv-2u': 400,
};

/** CPU(コア数ごと)。コア数が多いほど 1 コアあたりは安い */
export const CPU_PRICES: Readonly<Record<number, number>> = {
  4: 150,
  8: 260,
  16: 450,
  24: 620,
  32: 780,
  48: 1050,
  64: 1300,
};

/** メモリ 1GB あたり */
export const MEMORY_PRICE_PER_GB = 3;

/** ドライブ 1 本あたり(容量は扱わない) */
export const DRIVE_PRICES: Readonly<Record<DriveType, number>> = {
  hdd: 60,
  ssd: 150,
  nvme: 400,
};

export const NIC_PRICES: Readonly<Record<NicId, number>> = {
  none: 0,
  sfp10: 300,
};

/** 2U の前面のバックプレーン(3.5 インチ ⇄ 2.5 インチ)を替える工賃 */
export const BACKPLANE_PRICE = 100;

/** パーツの下取り(替えたときに戻ってくる割合) */
export const PART_REFUND_RATE = 0.5;

export const cpuPrice = (cores: number) => Math.round((CPU_PRICES[cores] ?? 0) * PRICE_SCALE);
export const memoryPrice = (gb: number) => Math.round(gb * MEMORY_PRICE_PER_GB * PRICE_SCALE);
export const drivePrice = (t: DriveType) => Math.round(DRIVE_PRICES[t] * PRICE_SCALE);
export const nicPrice = (n: NicId) => Math.round(NIC_PRICES[n] * PRICE_SCALE);

/** サーバの価格(シャーシ + パーツ) */
export function serverPrice(model: 'srv-1u' | 'srv-2u', p: ServerParts): number {
  return (
    Math.round(CHASSIS_PRICES[model] * PRICE_SCALE) +
    cpuPrice(p.cpu) +
    memoryPrice(p.memGB) +
    p.drives.reduce((s, t) => s + drivePrice(t), 0) +
    nicPrice(p.nic)
  );
}

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
  kubernetes: 25_000,
  // 機器
  tenGig: 5000,
  agg: 12_000,
  storage: 30_000,
  nvme: 10_000,
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

/** スイッチ・ストレージの価格(サーバは serverPrice) */
export function modelPrice(id: ModelId, owned: number): number {
  if (id === 'handoff') return 0;
  if (id === 'srv-1u' || id === 'srv-2u') return Math.round(CHASSIS_PRICES[id] * PRICE_SCALE);
  return growingPrice(MODEL_PRICES[id], owned);
}

export function cablePrice(fiber: boolean, meters: number): number {
  const p = fiber ? CABLE_PRICES.fiber : CABLE_PRICES.copper;
  return Math.round((p.base + p.perM * meters) * PRICE_SCALE);
}
