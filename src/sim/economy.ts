import { BASE_MARKET } from './config';
import type { UnlockId, UpgradeId } from './types';

/** 一度だけ買う解放 */
export interface UnlockDef {
  readonly id: UnlockId;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly requires?: UnlockId;
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
  /** 効果の値の表示形式 */
  readonly unit: 'users' | 'multiplier';
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
    id: 'lbPerf',
    name: 'LB チューニング',
    description: 'ロードバランサーの処理速度を上げる。',
    baseCost: 300,
    growth: 2.0,
    requires: 'lb',
    effect: (l) => 1.25 ** l,
    unit: 'multiplier',
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
  lbPerf: 0,
  webPerf: 0,
  dbPerf: 0,
});
