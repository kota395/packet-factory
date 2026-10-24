/**
 * 投資(解放・強化・契約)の効果と、段階・タブのまとめ方。
 * 価格は pricing.ts、機器の性能は catalog.ts、仕事量は config.ts にある。
 */
import { BASE_MARKET, RACK, UPLINK_LEVELS_GBPS } from './config';
import { UPGRADE_PRICES, growingPrice, unlockPrice } from './pricing';
import type { RoleId, UnlockId, UpgradeId } from './types';

/** 配信内容を変える解放の効果。オン/オフを切り替えられる */
export interface FeatureEffect {
  /** 1 ページビューあたりの収益の倍率 */
  readonly revenue: number;
}

export interface UnlockDef {
  readonly id: UnlockId;
  readonly name: string;
  readonly description: string;
  readonly requires?: UnlockId;
  readonly effect?: FeatureEffect;
  /** この解放で割り当てられるようになる役割 */
  readonly role?: RoleId;
}

export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly description: string;
  readonly requires?: UnlockId;
  /** レベル → 効果の値 */
  readonly effect: (level: number) => number;
  /** 効果の値の表示 */
  readonly format: (value: number) => string;
  readonly maxLevel?: number;
}

export const UNLOCKS: readonly UnlockDef[] = [
  {
    id: 'images',
    name: '画像投稿',
    description: '記事に画像が載る。1 ページの単価が上がるが、返すデータが 6 倍になり回線とネットワークが詰まりやすくなる。',
    effect: { revenue: 2 },
  },
  {
    id: 'comments',
    name: 'コメント機能',
    description: '読者がコメントを書ける。単価が上がるが、db に書き込みが来る(書き込みはディスク IO を多く使う)。',
    effect: { revenue: 1.3 },
  },
  {
    id: 'lb',
    name: 'ロードバランサ(LVS)',
    description: '役割「lb」を割り当てられる。LB がないとインターネットから届くのは web 1 台だけ。',
    role: 'lb',
  },
  {
    id: 'cache',
    name: 'memcached',
    description: '役割「cache」を割り当てられる。db の読み込みの多くを肩代わりする。',
    role: 'cache',
  },
  {
    id: 'replication',
    name: 'MySQL レプリケーション',
    description:
      '役割「replica」を割り当てられる。db(プライマリ)の複製で、読み込みを肩代わりする。書き込みはすべてのレプリカに複製されるので、書き込みが多いとレプリカも忙しい。',
    role: 'replica',
  },
  {
    id: 'virtualization',
    name: '仮想化(ハイパーバイザ)',
    description:
      'サーバをハイパーバイザにして VM を載せられる。役割は VM に付ける。仮想化ホスト向けの大きな機種も買えるようになる。',
  },
  {
    id: 'tenGig',
    name: '10G 機器',
    description: '10G のアップリンクを持つ 48 ポートスイッチを買えるようになる。',
  },
  {
    id: 'agg',
    name: '集約ネットワーク',
    description: 'ラックごとの ToR スイッチをまとめる 10G 集約スイッチを買えるようになる。',
    requires: 'tenGig',
  },
  {
    id: 'bgp',
    name: 'BGP(L3 の冗長化)',
    description:
      'サーバと ToR スイッチの間で BGP を使えるようになる。物理サーバは詳細で「BGP を使う」をオンにする(ハイパーバイザは自動)。2 台の ToR につなぐと ECMP で両方に流れ、片方が止まっても残りで続く。BGP なしのサーバは一番若いポートの 1 本しか使わない。',
  },
  {
    id: 'storage',
    name: '共有ストレージ',
    description:
      'ストレージアプライアンスを買えるようになり、VM のディスクを共有ストレージに置ける。共有ディスクの VM はホストを止めずに移せる。',
    requires: 'virtualization',
  },
];

const gbps = (v: number) => (v >= 1 ? `${v} Gbps` : `${v * 1000} Mbps`);

export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: 'marketing',
    name: '広告',
    description: '潜在ユーザー数(市場規模)を増やす。',
    effect: (l) => BASE_MARKET * 1.6 ** l,
    format: (v) => `${Math.round(v).toLocaleString('en-US')} 人`,
  },
  {
    id: 'monetize',
    name: '収益化の改善',
    description: '1 ページビューあたりの収益を増やす。',
    effect: (l) => 1.25 ** l,
    format: (v) => `×${v.toFixed(2)}`,
  },
  {
    id: 'uplink',
    name: '回線契約',
    description: 'キャリアとの回線契約を上げる。回線終端のポートの速度が上がる(月額も上がる)。',
    effect: (l) => UPLINK_LEVELS_GBPS[Math.min(l, UPLINK_LEVELS_GBPS.length - 1)],
    format: gbps,
    maxLevel: UPLINK_LEVELS_GBPS.length - 1,
  },
  {
    id: 'rackPower',
    name: '電力契約',
    description: 'すべてのラックの電力の上限を上げる(賃料も上がる)。',
    effect: (l) => RACK.powerLevelsW[Math.min(l, RACK.powerLevelsW.length - 1)],
    format: (v) => `${(v / 1000).toFixed(1)} kW / ラック`,
    maxLevel: RACK.powerLevelsW.length - 1,
  },
];

/** 段階。いまどこにいるかの目安として投資メニューの上に出す */
export interface StageDef {
  readonly id: number;
  readonly name: string;
  readonly summary: string;
  /** この段階に入った目印になる解放(どれか 1 つを買ったら) */
  readonly unlocks: readonly UnlockId[];
}

export const STAGES: readonly StageDef[] = [
  {
    id: 1,
    name: '黎明期',
    summary: '1 ラック・1 台の LAMP。最初に詰まるのは db のディスク IO。メモリの多い機種へ db を移す。',
    unlocks: [],
  },
  {
    id: 2,
    name: '役割の分離',
    summary: 'db と web を別のサーバに分け、LB の後ろに web を並べる。',
    unlocks: ['lb'],
  },
  {
    id: 3,
    name: 'キャッシュ',
    summary: 'memcached で db の読み込みを逃がす。',
    unlocks: ['cache'],
  },
  {
    id: 4,
    name: '増床',
    summary: '電力が尽きたら 2 本目のラックへ。ToR スイッチを集約スイッチでまとめ、ラック間の帯域を考える。',
    unlocks: ['tenGig', 'agg'],
  },
  {
    id: 5,
    name: 'DB の冗長化',
    summary: 'プライマリは 1 台のまま、読み込みをリードレプリカに分ける。書き込みは全レプリカに複製される。',
    unlocks: ['replication'],
  },
  {
    id: 6,
    name: '仮想化',
    summary: '大きなホストに VM をまとめ、U と電力を節約する。同じホストの VM 同士はネットワークを通らない。',
    unlocks: ['virtualization'],
  },
  {
    id: 7,
    name: '共有ストレージ',
    summary: 'VM のディスクを共有ストレージへ。止めずに移せるが、IO がネットワークを通るのでストレージ用の経路を分けたい。',
    unlocks: ['storage'],
  },
  {
    id: 8,
    name: 'ネットワークの冗長化',
    summary: 'サーバを 2 台の ToR につなぎ、BGP と ECMP で両方に流す。スイッチが 1 台止まってもサービスは続く。',
    unlocks: ['bgp'],
  },
];

/** 投資メニューのタブ */
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
    summary: 'ユーザーを集めて単価を上げる。新機能は単価が上がるぶん、インフラの負荷も増える。',
    unlocks: ['images', 'comments'],
    upgrades: ['marketing', 'monetize'],
  },
  {
    id: 'facility',
    name: '回線・電力',
    summary: 'キャリアやデータセンターとの契約。回線の太さとラックの電力。',
    unlocks: [],
    upgrades: ['uplink', 'rackPower'],
  },
  {
    id: 'software',
    name: 'ソフトウェア',
    summary: 'サーバに割り当てられる役割を増やす。',
    unlocks: ['lb', 'cache', 'replication', 'virtualization'],
    upgrades: [],
  },
  {
    id: 'hardware',
    name: '機器',
    summary: '買える機種を増やす。サーバの機種は前面の空き U から買う。',
    unlocks: ['tenGig', 'agg', 'storage', 'bgp'],
    upgrades: [],
  },
];

export const UNLOCK_BY_ID = Object.fromEntries(UNLOCKS.map((u) => [u.id, u])) as Record<UnlockId, UnlockDef>;
export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u])) as Record<UpgradeId, UpgradeDef>;

export function upgradeCost(id: UpgradeId, level: number): number {
  return growingPrice(UPGRADE_PRICES[id], level);
}

export function unlockCost(id: UnlockId): number {
  return unlockPrice(id);
}

export const emptyUpgrades = (): Record<UpgradeId, number> => ({
  marketing: 0,
  monetize: 0,
  uplink: 0,
  rackPower: 0,
});
