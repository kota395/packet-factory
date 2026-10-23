/**
 * 機器のカタログ。機種ごとに性能が決まっていて、買ったあとにスペックは上げられない。
 * 性能を上げたいときは上位機種を買い、役割を移す。価格は pricing.ts の MODEL_PRICES。
 */
import type { Category, Media, ModelId, UnlockId } from './types';

export interface PortGroupDef {
  readonly count: number;
  readonly speedGbps: number;
  readonly media: Media;
  /** 背面の表示や詳細で使う名前 */
  readonly label: string;
}

export interface ModelDef {
  readonly id: ModelId;
  readonly category: Category;
  readonly name: string;
  /** ラックの前面に出す短い名前 */
  readonly short: string;
  readonly description: string;
  /** 高さ(U) */
  readonly u: number;
  /** 消費電力(W) */
  readonly powerW: number;
  readonly ports: readonly PortGroupDef[];
  /** サーバ: コア数・コア性能(1.0 が基準)・メモリ(GB)・ディスク IOPS。ストレージは diskIops だけ使う */
  readonly cores?: number;
  readonly coreSpeed?: number;
  readonly memGB?: number;
  readonly diskIops?: number;
  /** スイッチ: 全ポート合計で捌ける量(Gbps) */
  readonly fabricGbps?: number;
  /** 買えるようになるのに必要な解放 */
  readonly requires?: UnlockId;
  /** 前面の色 */
  readonly color: number;
}

const rj45 = (count: number, speedGbps = 1): PortGroupDef => ({
  count,
  speedGbps,
  media: 'rj45',
  label: speedGbps >= 1 ? `${speedGbps}GbE` : `${speedGbps * 1000}M`,
});
const sfp = (count: number, speedGbps: number): PortGroupDef => ({
  count,
  speedGbps,
  media: 'sfp',
  label: speedGbps >= 10 ? `${speedGbps}G SFP+` : `${speedGbps}G SFP`,
});

export const MODELS: readonly ModelDef[] = [
  {
    id: 'handoff',
    category: 'handoff',
    name: '回線終端装置',
    short: '回線',
    description: 'キャリアの回線の終端。ここからインターネットにつながる。速度は回線契約で決まる。動かせない。',
    u: 1,
    powerW: 15,
    // 速度は契約で決まる(シミュレーション側で上書き)
    ports: [rj45(1, 10)],
    color: 0x8b98a5,
  },
  {
    id: 'srv-1u-e',
    category: 'server',
    name: '1U サーバ(エントリー)',
    short: '1U-E',
    description: '安くて省電力。2 コア・メモリ 4GB・SATA ディスク 1 本。db を載せるとディスク IO がすぐ詰まる。',
    u: 1,
    powerW: 150,
    ports: [rj45(2)],
    cores: 2,
    coreSpeed: 1,
    memGB: 4,
    diskIops: 150,
    color: 0x2ec4b6,
  },
  {
    id: 'srv-1u-d',
    category: 'server',
    name: '1U サーバ(2 CPU)',
    short: '1U-D',
    description: 'CPU 2 基で 8 コア・メモリ 16GB・SAS ディスク RAID1。web を並べるならこれ。',
    u: 1,
    powerW: 280,
    ports: [rj45(2)],
    cores: 8,
    coreSpeed: 1.2,
    memGB: 16,
    diskIops: 400,
    color: 0x2a9d8f,
  },
  {
    id: 'srv-2u-db',
    category: 'server',
    name: '2U サーバ(DB 向け)',
    short: '2U-DB',
    description: '8 コア・メモリ 48GB・15k SAS 8 本の RAID10。読み込みの多くがメモリに乗り、ディスクも速い。',
    u: 2,
    powerW: 450,
    ports: [rj45(2)],
    cores: 8,
    coreSpeed: 1.2,
    memGB: 48,
    diskIops: 2000,
    color: 0xf4a261,
  },
  {
    id: 'srv-2u-hv',
    category: 'server',
    name: '2U サーバ(仮想化ホスト)',
    short: '2U-HV',
    description:
      '24 コア・メモリ 256GB・10G NIC 2 ポート。ハイパーバイザにして VM を何台も載せる前提の機種。1 台あたりの電力とラックの U を節約できる。',
    u: 2,
    powerW: 650,
    ports: [rj45(2), sfp(2, 10)],
    cores: 24,
    coreSpeed: 1.4,
    memGB: 256,
    diskIops: 1500,
    requires: 'virtualization',
    color: 0x52b788,
  },
  {
    id: 'nas-2u',
    category: 'storage',
    name: 'ストレージアプライアンス',
    short: 'NAS',
    description:
      'SSD キャッシュ付きの共有ストレージ。VM のディスクを置くと、ホストを替えても止めずに移せる(ライブマイグレーション)。IO はネットワークを通るので、ストレージ用のネットワークを分けたくなる。',
    u: 2,
    powerW: 500,
    ports: [sfp(4, 10)],
    diskIops: 40_000,
    requires: 'storage',
    color: 0xc77dff,
  },
  {
    id: 'sw-24',
    category: 'switch',
    name: 'L2 スイッチ 24 ポート',
    short: 'SW24',
    description: '1GbE が 24 ポート。ラックの上(ToR)に置いてサーバを集める。アップリンクも 1G。',
    u: 1,
    powerW: 30,
    ports: [rj45(24)],
    fabricGbps: 48,
    color: 0x9d8cff,
  },
  {
    id: 'sw-48',
    category: 'switch',
    name: 'L2 スイッチ 48 ポート(10G アップリンク)',
    short: 'SW48',
    description: '1GbE が 48 ポートと、集約へつなぐ 10G SFP+ が 4 ポート。',
    u: 1,
    powerW: 80,
    ports: [rj45(48), sfp(4, 10)],
    fabricGbps: 176,
    requires: 'tenGig',
    color: 0x7b6cf0,
  },
  {
    id: 'agg-10g',
    category: 'switch',
    name: '集約スイッチ 10G 24 ポート',
    short: 'AGG',
    description: '10G SFP+ が 24 ポート。各ラックの ToR スイッチをまとめる。',
    u: 1,
    powerW: 180,
    ports: [sfp(24, 10)],
    fabricGbps: 480,
    requires: 'agg',
    color: 0xe76f51,
  },
];

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m])) as Record<ModelId, ModelDef>;

/** 買える機種(回線終端は除く) */
export const BUYABLE_MODELS = MODELS.filter((m) => m.category !== 'handoff');

/** 機種のポートを先頭から並べたもの */
export interface PortDef {
  readonly index: number;
  readonly speedGbps: number;
  readonly media: Media;
  readonly label: string;
  /** グループの中での番号(1 始まり) */
  readonly number: number;
}

const portCache = new Map<ModelId, PortDef[]>();

export function portsOf(model: ModelId): readonly PortDef[] {
  let list = portCache.get(model);
  if (!list) {
    list = [];
    for (const g of MODEL_BY_ID[model].ports) {
      for (let i = 0; i < g.count; i++) {
        list.push({ index: list.length, speedGbps: g.speedGbps, media: g.media, label: g.label, number: i + 1 });
      }
    }
    portCache.set(model, list);
  }
  return list;
}
