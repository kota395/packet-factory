/**
 * 投資(解放・強化)の定義。価格や効果を調整するときはこのファイルを触る。
 * ノードの性能やデータ量の基準値は config.ts にある。
 */
import { BASE_MARKET } from './config';
import type { ReqKind, UnlockId, UpgradeId } from './types';

/** 解放したときに有効になる効果。種類ごとの倍率で、複数の解放の効果は掛け算で重なる */
export interface FeatureEffect {
  /** 1 件あたりの収益の倍率 */
  readonly revenue?: Partial<Record<ReqKind, number>>;
  /** 1 件あたりのデータ量の倍率 */
  readonly dataSize?: Partial<Record<ReqKind, number>>;
}

/** 一度だけ買う解放 */
export interface UnlockDef {
  readonly id: UnlockId;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly requires?: UnlockId;
  /** 配信内容を変える解放の効果。指定があると、購入後にオン/オフを切り替えられる */
  readonly effect?: FeatureEffect;
}

/** 何度でも買える強化。価格は baseCost × growth^レベル */
export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly description: string;
  readonly baseCost: number;
  readonly growth: number;
  readonly requires?: UnlockId;
  /** レベル → 効果の値 */
  readonly effect: (level: number) => number;
  /** 効果の値の表示形式(bandwidth は LB の基準帯域に掛けた値を表示する) */
  readonly unit: 'users' | 'multiplier' | 'bandwidth';
}

export const UNLOCKS: readonly UnlockDef[] = [
  {
    id: 'lb',
    name: 'ロードバランサー導入',
    description: 'LB を配置できるようになり、複数の WEB に振り分けられる。',
    cost: 120,
  },
  {
    id: 'writes',
    name: '会員機能(書き込み)',
    description: 'DB を配置できるようになる。DB を置くと単価の高い書き込みリクエストが流れ始める。',
    cost: 1500,
    requires: 'lb',
  },
  // ---- 配信コンテンツ: 単価は上がるが 1 件が重くなり、LB の帯域を圧迫する ----
  {
    id: 'images',
    name: '画像投稿',
    description: 'ページに画像が載る。静的リクエストの単価が上がるが、データ量も増える。',
    cost: 6000,
    requires: 'lb',
    effect: { revenue: { static: 2 }, dataSize: { static: 5 } },
  },
  {
    id: 'video',
    name: '動画配信',
    description: '動画を配信する。単価は大きく上がるが、データ量は桁違いに増える。',
    cost: 300_000,
    requires: 'images',
    effect: { revenue: { static: 3 }, dataSize: { static: 8 } },
  },
];

export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: 'marketing',
    name: '広告キャンペーン',
    description: '潜在ユーザー数(市場規模)を増やす。',
    baseCost: 25,
    growth: 1.8,
    effect: (l) => BASE_MARKET * 1.6 ** l,
    unit: 'users',
  },
  {
    id: 'monetize',
    name: '収益化の改善',
    description: 'リクエストあたりの収益を増やす。',
    baseCost: 80,
    growth: 2.1,
    effect: (l) => 1.25 ** l,
    unit: 'multiplier',
  },
  {
    id: 'lbBandwidth',
    name: 'LB 回線増強',
    description: 'ロードバランサーの帯域(通せるデータ量)を増やす。',
    baseCost: 500,
    growth: 2.2,
    requires: 'lb',
    effect: (l) => 1.5 ** l,
    unit: 'bandwidth',
  },
  {
    id: 'webPerf',
    name: 'WEB チューニング',
    description: 'すべての WEB の処理速度を上げる。',
    baseCost: 150,
    growth: 2.2,
    effect: (l) => 1.2 ** l,
    unit: 'multiplier',
  },
  {
    id: 'dbPerf',
    name: 'DB チューニング',
    description: 'すべての DB の処理速度を上げる。',
    baseCost: 800,
    growth: 2.2,
    requires: 'writes',
    effect: (l) => 1.2 ** l,
    unit: 'multiplier',
  },
];

export const UNLOCK_BY_ID = Object.fromEntries(UNLOCKS.map((u) => [u.id, u])) as Record<UnlockId, UnlockDef>;
export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u])) as Record<UpgradeId, UpgradeDef>;

export function upgradeCost(def: UpgradeDef, level: number): number {
  return Math.round(def.baseCost * def.growth ** level);
}

export const emptyUpgrades = (): Record<UpgradeId, number> => ({
  marketing: 0,
  monetize: 0,
  lbBandwidth: 0,
  webPerf: 0,
  dbPerf: 0,
});
