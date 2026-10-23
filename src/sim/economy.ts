/**
 * 投資(解放・強化)の効果と、拡張の段階。
 * 価格は pricing.ts、ノードの性能やデータ量の基準値は config.ts にある。
 * 段階の考え方は docs/scaling.md。
 */
import { BASE_MARKET } from './config';
import { UPGRADE_PRICES, growingPrice, unlockPrice } from './pricing';
import type { NodeKind, ReqKind, UnlockId, UpgradeId } from './types';

/** 解放したときに有効になる効果。種類ごとの倍率で、複数の解放の効果は掛け算で重なる */
export interface FeatureEffect {
  /** 1 件あたりの収益の倍率 */
  readonly revenue?: Partial<Record<ReqKind, number>>;
  /** 1 件あたりのデータ量の倍率 */
  readonly dataSize?: Partial<Record<ReqKind, number>>;
}

/** 一度だけ買う解放。価格は pricing.ts の UNLOCK_PRICES */
export interface UnlockDef {
  readonly id: UnlockId;
  readonly name: string;
  readonly description: string;
  readonly requires?: UnlockId;
  /** 配信内容を変える解放の効果。指定があると、購入後にオン/オフを切り替えられる */
  readonly effect?: FeatureEffect;
}

/**
 * 強化がノードのどの能力に効くか。同じ能力への強化は掛け算(maxCount は足し算)で重なる。
 *  - speed: 処理速度の倍率(処理時間 ÷ 値)
 *  - bandwidth: 帯域の倍率
 *  - hitRate: キャッシュの外れる割合に掛かる倍率(0.75 なら外れが 3/4 に)
 *  - maxCount: 置ける台数に足す数
 */
export type NodeStat = 'speed' | 'bandwidth' | 'hitRate' | 'maxCount';

/** 何度でも買える強化。価格は pricing.ts の UPGRADE_PRICES */
export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly description: string;
  readonly requires?: UnlockId;
  /** レベル → 効果の値(意味は stat による) */
  readonly effect: (level: number) => number;
  /** ノードの能力に効く強化。ない場合は経済全体に効く(広告・収益化) */
  readonly target?: { readonly nodes: readonly NodeKind[]; readonly stat: NodeStat };
  /**
   * 上げられるレベルの上限(なければ無制限)。
   * スケールアップは 1 台の性能に限りがあることの表現で、上限に達したら台数で分散するしかない
   */
  readonly maxLevel?: number;
}

/** 拡張の段階。投資メニューはこの順にまとめて表示する */
export interface StageDef {
  readonly id: number;
  readonly name: string;
  /** 何が詰まり、何で解決するか */
  readonly summary: string;
  readonly unlocks: readonly UnlockId[];
  readonly upgrades: readonly UpgradeId[];
}

export const UNLOCKS: readonly UnlockDef[] = [
  {
    id: 'lb',
    name: 'ロードバランサー導入',
    description: 'LB を配置できるようになり、複数の WEB に振り分けられる。',
  },
  {
    id: 'writes',
    name: '会員機能(DB)',
    description:
      'DB を配置できるようになる。WEB に DB をつなぐと、届いたリクエストの 1/5 が単価の高い読み込み・書き込みとして DB に流れる。',
    requires: 'lb',
  },
  {
    id: 'cache',
    name: 'キャッシュサーバー導入',
    description: 'キャッシュを配置できる。WEB と DB の間に置くと、読み込みの多くをメモリから返して DB の負荷を減らす。',
    requires: 'writes',
  },
  {
    id: 'replica',
    name: 'リードレプリカ導入',
    description: 'DB の複製を配置できる。読み込みを複数台に分散できる。書き込みは DB(プライマリ)だけが受ける。',
    requires: 'writes',
  },
  // ---- 配信コンテンツ: 単価は上がるが 1 件が重くなり、LB の帯域を圧迫する ----
  {
    id: 'images',
    name: '画像投稿',
    description: 'ページに画像が載る。静的リクエストの単価が上がるが、データ量も増える。',
    requires: 'lb',
    effect: { revenue: { static: 2 }, dataSize: { static: 5 } },
  },
  {
    id: 'cdn',
    name: 'CDN 導入',
    description: 'CDN を配置できるようになる。NET と LB の間に置くと、静的コンテンツをキャッシュから返して LB の帯域を空けられる。',
    requires: 'images',
  },
  {
    id: 'video',
    name: '動画配信',
    description: '動画を配信する。単価は大きく上がるが、データ量は桁違いに増える。',
    requires: 'images',
    effect: { revenue: { static: 3 }, dataSize: { static: 8 } },
  },
  {
    id: 'sharding',
    name: 'シャーディング',
    description: 'データをユーザーごとに分割し、DB(プライマリ)を複数台に分けて持てるようになる。台数は「シャード追加」で増やす。',
    requires: 'replica',
  },
];

export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: 'marketing',
    name: '広告キャンペーン',
    description: '潜在ユーザー数(市場規模)を増やす。',
    effect: (l) => BASE_MARKET * 1.6 ** l,
  },
  {
    id: 'monetize',
    name: '収益化の改善',
    description: 'リクエストあたりの収益を増やす。',
    effect: (l) => 1.25 ** l,
  },
  {
    id: 'webPerf',
    name: 'WEB スケールアップ',
    description: 'すべての WEB をより高性能なサーバーに入れ替え、1 台あたりの処理能力を上げる。機種には上限がある。',
    effect: (l) => 1.2 ** l,
    maxLevel: 6,
    target: { nodes: ['web'], stat: 'speed' },
  },
  {
    id: 'lbBandwidth',
    name: 'LB 回線増強',
    description: 'ロードバランサーの帯域(通せるデータ量)を増やす。',
    requires: 'lb',
    effect: (l) => 1.5 ** l,
    target: { nodes: ['lb'], stat: 'bandwidth' },
  },
  {
    id: 'dbPerf',
    name: 'DB スケールアップ',
    description: 'すべての DB とレプリカをより高性能なサーバーに入れ替え、1 台あたりの処理能力を上げる。機種には上限がある。',
    requires: 'writes',
    effect: (l) => 1.2 ** l,
    maxLevel: 8,
    target: { nodes: ['db', 'replica'], stat: 'speed' },
  },
  {
    id: 'cacheMemory',
    name: 'キャッシュ容量拡張',
    description: 'キャッシュのメモリを増やし、読み込みを返せる割合(ヒット率)を上げる。',
    requires: 'cache',
    effect: (l) => 0.7 ** l,
    target: { nodes: ['cache'], stat: 'hitRate' },
  },
  {
    id: 'cdnCache',
    name: 'CDN キャッシュ拡張',
    description: 'キャッシュの容量を増やし、CDN で返せる割合(ヒット率)を上げる。',
    requires: 'cdn',
    effect: (l) => 0.75 ** l,
    target: { nodes: ['cdn'], stat: 'hitRate' },
  },
  {
    id: 'cdnBandwidth',
    name: 'CDN 回線増強',
    description: 'CDN の帯域(配信できるデータ量)を増やす。',
    requires: 'cdn',
    effect: (l) => 1.5 ** l,
    target: { nodes: ['cdn'], stat: 'bandwidth' },
  },
  {
    id: 'dbShards',
    name: 'シャード追加',
    description: 'データの分割数を増やし、DB(プライマリ)を置ける台数を 1 台増やす。書き込みが分散する。',
    requires: 'sharding',
    effect: (l) => l,
    target: { nodes: ['db'], stat: 'maxCount' },
  },
];

export const STAGES: readonly StageDef[] = [
  {
    id: 0,
    name: '共通',
    summary: 'ユーザーを集めて単価を上げる。どの段階でも買える。',
    unlocks: [],
    upgrades: ['marketing', 'monetize'],
  },
  {
    id: 1,
    name: '1 台構成',
    summary: 'WEB 1 台の CPU が詰まる → スケールアップで 1 台を速くする。',
    unlocks: [],
    upgrades: ['webPerf'],
  },
  {
    id: 2,
    name: '水平分散',
    summary: 'WEB を並べて振り分ける → 次は LB の帯域が詰まる。',
    unlocks: ['lb'],
    upgrades: ['lbBandwidth'],
  },
  {
    id: 3,
    name: 'データ層の分離',
    summary: 'DB は正本を持つので並べられない → WEB を増やしても DB に集中する。',
    unlocks: ['writes'],
    upgrades: ['dbPerf'],
  },
  {
    id: 4,
    name: '読み込みの分散',
    summary: '読み込みはキャッシュとレプリカに逃がせる → 書き込みはプライマリに残る。',
    unlocks: ['cache', 'replica'],
    upgrades: ['cacheMemory'],
  },
  {
    id: 5,
    name: '重いコンテンツ',
    summary: '画像・動画でデータ量が増え、帯域が詰まる → CDN で手前から返す。',
    unlocks: ['images', 'cdn', 'video'],
    upgrades: ['cdnCache', 'cdnBandwidth'],
  },
  {
    id: 6,
    name: '書き込みの分散',
    summary: 'プライマリの書き込みが詰まる → データを分割してプライマリを増やす。',
    unlocks: ['sharding'],
    upgrades: ['dbShards'],
  },
];

/**
 * 投資メニューのタブ(系統)。どのノードの層に効くかでまとめる。
 * 各タブの中は段階の順に並べる
 */
export interface LineDef {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly unlocks: readonly UnlockId[];
  readonly upgrades: readonly UpgradeId[];
}

export const LINES: readonly LineDef[] = [
  {
    id: 'business',
    name: '事業',
    summary: 'ユーザーを集めて単価を上げる。配信コンテンツは単価が上がるぶんデータが重くなる。',
    unlocks: ['images', 'video'],
    upgrades: ['marketing', 'monetize'],
  },
  {
    id: 'web',
    name: 'WEB',
    summary: 'ページを組み立てる層。状態を持たないので台数を並べられる。1 台の性能はスケールアップで上げる。',
    unlocks: [],
    upgrades: ['webPerf'],
  },
  {
    id: 'network',
    name: '回線',
    summary: 'LB と CDN。振り分けと配信で、詰まるのは主に帯域。',
    unlocks: ['lb', 'cdn'],
    upgrades: ['lbBandwidth', 'cdnCache', 'cdnBandwidth'],
  },
  {
    id: 'data',
    name: 'データ',
    summary: 'DB・キャッシュ・レプリカ。正本は増やせないので、読み込みは逃がし、書き込みは分割する。',
    unlocks: ['writes', 'cache', 'replica', 'sharding'],
    upgrades: ['dbPerf', 'cacheMemory', 'dbShards'],
  },
];

/** その強化が属する段階 */
export function stageOfUpgrade(id: UpgradeId): StageDef {
  return STAGES.find((s) => s.upgrades.includes(id))!;
}

export const UNLOCK_BY_ID = Object.fromEntries(UNLOCKS.map((u) => [u.id, u])) as Record<UnlockId, UnlockDef>;
export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u])) as Record<UpgradeId, UpgradeDef>;

/** その解放が属する段階 */
export function stageOfUnlock(id: UnlockId): StageDef {
  return STAGES.find((s) => s.unlocks.includes(id))!;
}

export function upgradeCost(def: UpgradeDef, level: number): number {
  return growingPrice(UPGRADE_PRICES[def.id], level);
}

export function unlockCost(id: UnlockId): number {
  return unlockPrice(id);
}

export const emptyUpgrades = (): Record<UpgradeId, number> => ({
  marketing: 0,
  monetize: 0,
  webPerf: 0,
  lbBandwidth: 0,
  dbPerf: 0,
  cacheMemory: 0,
  cdnCache: 0,
  cdnBandwidth: 0,
  dbShards: 0,
});
