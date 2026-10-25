/**
 * 機器のカタログ。
 *  - スイッチ・ストレージなどは機種ごとに性能が決まっている
 *  - サーバはシャーシ(1U / 2U)に CPU・メモリ・ドライブ・NIC を載せた構成で、パーツはあとから替えられる。
 *    買うときはプリセット(PRESETS)から選ぶ
 * 価格は pricing.ts(機種は MODEL_PRICES、サーバはシャーシとパーツごと)。
 */
import type { Backplane, Category, DriveType, Media, ModelId, NicId, ServerParts, UnlockId } from './types';

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
  /** 消費電力(W)。サーバはシャーシだけの分で、パーツの分が足される */
  readonly powerW: number;
  readonly ports: readonly PortGroupDef[];
  /** ストレージの IOPS(サーバは構成から計算する) */
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
    id: 'srv-1u',
    category: 'server',
    name: '1U サーバ',
    short: '1U',
    description:
      '前面に 2.5 インチのベイが 10 本(SSD・NVMe を混ぜられる)。オンボードの 1GbE が 2 ポート。CPU・メモリ・ドライブ・NIC はあとから替えられる。',
    u: 1,
    powerW: 40,
    ports: [rj45(2)],
    color: 0x2ec4b6,
  },
  {
    id: 'srv-2u',
    category: 'server',
    name: '2U サーバ',
    short: '2U',
    description:
      '前面は 3.5 インチ HDD 12 本か、2.5 インチ 24 本(SSD・NVMe を混ぜられる)。背面に OS 用の SSD 2 本(ミラー)。オンボードの 1GbE が 2 ポート。',
    u: 2,
    powerW: 70,
    ports: [rj45(2)],
    color: 0xf4a261,
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

/** 機器のポートを先頭から並べたもの */
export interface PortDef {
  readonly index: number;
  readonly speedGbps: number;
  readonly media: Media;
  readonly label: string;
  /** グループの中での番号(1 始まり) */
  readonly number: number;
}

// ---------------------------------------------------------------- サーバのパーツ

/** すべてのサーバの 1 コアの性能(1.0 が基準) */
export const CORE_SPEED = 1;

/** CPU。コア数が多いほど、1 コアあたりの電力(と価格)は下がる */
export const CPU_OPTIONS: readonly { readonly cores: number; readonly powerW: number }[] = [
  { cores: 4, powerW: 45 },
  { cores: 8, powerW: 65 },
  { cores: 16, powerW: 105 },
  { cores: 24, powerW: 140 },
  { cores: 32, powerW: 170 },
  { cores: 48, powerW: 225 },
  { cores: 64, powerW: 280 },
];

/** メモリの容量(GB)。電力は容量にほぼ比例 */
export const MEMORY_OPTIONS: readonly number[] = [8, 16, 32, 64, 128, 256, 512, 1024];
export const memoryPowerW = (gb: number) => Math.round(3 + gb / 16);

export interface DriveDef {
  readonly id: DriveType;
  readonly name: string;
  /** 1 本あたりのランダム IO 性能と消費電力(W) */
  readonly iops: number;
  readonly powerW: number;
  /** 入るベイ */
  readonly bay: Backplane;
  readonly requires?: UnlockId;
}

/** ドライブ。容量は扱わず、本数と種類で性能が決まる */
export const DRIVES: Readonly<Record<DriveType, DriveDef>> = {
  hdd: { id: 'hdd', name: 'HDD', iops: 75, powerW: 9, bay: 'lff' },
  ssd: { id: 'ssd', name: 'SSD', iops: 2000, powerW: 4, bay: 'sff' },
  nvme: { id: 'nvme', name: 'NVMe', iops: 10_000, powerW: 10, bay: 'sff', requires: 'nvme' },
};

/** ドライブは 2 本ずつのミラー(RAID1 / RAID10)。書き込みは 2 本に行くので、性能は本数ぶんの半分 */
export const RAID_EFFICIENCY = 0.5;

export interface NicDef {
  readonly id: NicId;
  readonly name: string;
  readonly ports: readonly PortGroupDef[];
  readonly powerW: number;
  readonly requires?: UnlockId;
}

export const NICS: Readonly<Record<NicId, NicDef>> = {
  none: { id: 'none', name: 'なし', ports: [], powerW: 0 },
  sfp10: { id: 'sfp10', name: '10G SFP+ 2 ポート', ports: [sfp(2, 10)], powerW: 12, requires: 'tenGig' },
};

export interface ChassisDef {
  /** 前面のベイの数(バックプレーンごと。0 なら選べない) */
  readonly bays: Readonly<Record<Backplane, number>>;
  /** 背面の OS 用 SSD(ミラー)の本数。OS だけで、データは前面に置く */
  readonly rearSsd: number;
  /** 前面に最低限要るドライブの本数(データ用のミラー 1 組) */
  readonly minDrives: number;
}

export const CHASSIS: Readonly<Record<'srv-1u' | 'srv-2u', ChassisDef>> = {
  'srv-1u': { bays: { sff: 10, lff: 0 }, rearSsd: 0, minDrives: 2 },
  'srv-2u': { bays: { sff: 24, lff: 12 }, rearSsd: 2, minDrives: 2 },
};

export const isServerModel = (m: ModelId): m is 'srv-1u' | 'srv-2u' => m === 'srv-1u' || m === 'srv-2u';

/** 買うときに選ぶ構成 */
export interface PresetDef {
  readonly id: string;
  readonly model: 'srv-1u' | 'srv-2u';
  readonly name: string;
  readonly description: string;
  readonly parts: ServerParts;
}

const drives = (type: DriveType, n: number): DriveType[] => new Array<DriveType>(n).fill(type);

export const PRESETS: readonly PresetDef[] = [
  {
    id: '1u-small',
    model: 'srv-1u',
    name: '1U 小型',
    description: '安くて省電力。最初の web と同じ構成。',
    parts: { cpu: 4, memGB: 8, backplane: 'sff', drives: drives('ssd', 2), nic: 'none' },
  },
  {
    id: '1u-web',
    model: 'srv-1u',
    name: '1U web 向け',
    description: 'web を並べるならこれ。',
    parts: { cpu: 8, memGB: 16, backplane: 'sff', drives: drives('ssd', 2), nic: 'none' },
  },
  {
    id: '1u-compute',
    model: 'srv-1u',
    name: '1U 計算向け',
    description: 'コアの多い CPU。web・worker・Kubernetes のワーカーに。',
    parts: { cpu: 32, memGB: 64, backplane: 'sff', drives: drives('ssd', 2), nic: 'none' },
  },
  {
    id: '2u-hdd',
    model: 'srv-2u',
    name: '2U HDD',
    description: 'HDD 12 本。安いがランダム IO は遅い。最初の db と同じシャーシ。',
    parts: { cpu: 8, memGB: 32, backplane: 'lff', drives: drives('hdd', 12), nic: 'none' },
  },
  {
    id: '2u-ssd',
    model: 'srv-2u',
    name: '2U SSD DB',
    description: 'SSD 8 本とメモリ 128GB。db・レプリカ向け。',
    parts: { cpu: 16, memGB: 128, backplane: 'sff', drives: drives('ssd', 8), nic: 'none' },
  },
  {
    id: '2u-nvme',
    model: 'srv-2u',
    name: '2U NVMe DB',
    description: 'NVMe 8 本とメモリ 512GB。書き込みの多い db に。',
    parts: { cpu: 32, memGB: 512, backplane: 'sff', drives: drives('nvme', 8), nic: 'sfp10' },
  },
  {
    id: '2u-hv',
    model: 'srv-2u',
    name: '2U 仮想化ホスト',
    description: '48 コア・メモリ 256GB・10G NIC。ハイパーバイザにして VM を載せる。',
    parts: { cpu: 48, memGB: 256, backplane: 'sff', drives: drives('ssd', 4), nic: 'sfp10' },
  },
];

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p])) as Record<string, PresetDef>;

/** 最初から入っているサーバの構成: リクエストを受ける 1U と、db 用の 2U(HDD) */
export const START_PARTS = {
  web: { cpu: 4, memGB: 8, backplane: 'sff', drives: drives('ssd', 2), nic: 'none' } as ServerParts,
  db: { cpu: 4, memGB: 8, backplane: 'lff', drives: drives('hdd', 2), nic: 'none' } as ServerParts,
};

/** 構成で使う解放(NVMe・10G NIC) */
export function partsRequires(parts: ServerParts): UnlockId[] {
  const out = new Set<UnlockId>();
  for (const d of parts.drives) if (DRIVES[d].requires) out.add(DRIVES[d].requires!);
  if (NICS[parts.nic].requires) out.add(NICS[parts.nic].requires!);
  return [...out];
}

/** 構成がシャーシに収まらない理由(収まれば null) */
export function partsError(model: 'srv-1u' | 'srv-2u', parts: ServerParts): string | null {
  const c = CHASSIS[model];
  if (!CPU_OPTIONS.some((o) => o.cores === parts.cpu)) return 'その CPU はありません';
  if (!MEMORY_OPTIONS.includes(parts.memGB)) return 'その容量のメモリはありません';
  const bays = c.bays[parts.backplane];
  if (!bays) return 'そのバックプレーンは選べません';
  if (parts.drives.length > bays) return `前面のベイは ${bays} 本までです`;
  if (parts.drives.length < c.minDrives) return `ドライブは最低 ${c.minDrives} 本要ります`;
  if (parts.drives.length % 2) return 'ドライブは 2 本ずつ(ミラー)です';
  for (const d of parts.drives) {
    if (DRIVES[d].bay !== parts.backplane) {
      return parts.backplane === 'lff' ? '3.5 インチのベイには HDD だけが入ります' : '2.5 インチのベイには SSD・NVMe だけが入ります';
    }
  }
  return null;
}

/** 機器の性能。サーバは構成から、それ以外は機種から */
export interface Spec {
  readonly cores: number;
  readonly coreSpeed: number;
  readonly memGB: number;
  readonly diskIops: number;
  readonly powerW: number;
  readonly ports: readonly PortGroupDef[];
}

/** 構成(パーツはまるごと差し替えるので、同じオブジェクトなら同じ性能)ごとの計算結果 */
const specCache = new WeakMap<ServerParts, Map<ModelId, Spec>>();
const fixedSpec = new Map<ModelId, Spec>();

export function specOf(d: { readonly model: ModelId; readonly parts?: ServerParts | null }): Spec {
  const m = MODEL_BY_ID[d.model];
  if (!isServerModel(d.model) || !d.parts) {
    let f = fixedSpec.get(d.model);
    if (!f) {
      f = { cores: 0, coreSpeed: CORE_SPEED, memGB: 0, diskIops: m.diskIops ?? 0, powerW: m.powerW, ports: m.ports };
      fixedSpec.set(d.model, f);
    }
    return f;
  }
  let byModel = specCache.get(d.parts);
  if (!byModel) specCache.set(d.parts, (byModel = new Map()));
  const hit = byModel.get(d.model);
  if (hit) return hit;
  const spec = serverSpec(d.model, d.parts);
  byModel.set(d.model, spec);
  return spec;
}

function serverSpec(model: 'srv-1u' | 'srv-2u', p: ServerParts): Spec {
  const d = { model };
  const m = MODEL_BY_ID[model];
  const c = CHASSIS[d.model];
  const cpu = CPU_OPTIONS.find((o) => o.cores === p.cpu) ?? CPU_OPTIONS[0];
  // データは前面のドライブに置く(背面の SSD は OS だけ)
  const diskIops = Math.max(1, p.drives.reduce((s, t) => s + DRIVES[t].iops, 0) * RAID_EFFICIENCY);
  const powerW =
    m.powerW +
    cpu.powerW +
    memoryPowerW(p.memGB) +
    p.drives.reduce((s, t) => s + DRIVES[t].powerW, 0) +
    c.rearSsd * DRIVES.ssd.powerW +
    NICS[p.nic].powerW;
  return {
    cores: cpu.cores,
    coreSpeed: CORE_SPEED,
    memGB: p.memGB,
    diskIops,
    powerW,
    ports: [...m.ports, ...NICS[p.nic].ports],
  };
}

const portCache = new Map<string, PortDef[]>();

/** 機器のポート(サーバは増設 NIC の分も) */
export function portsOf(d: { readonly model: ModelId; readonly parts?: ServerParts | null }): readonly PortDef[] {
  const key = `${d.model}|${d.parts?.nic ?? ''}`;
  let list = portCache.get(key);
  if (!list) {
    list = [];
    for (const g of specOf(d).ports) {
      for (let i = 0; i < g.count; i++) {
        list.push({ index: list.length, speedGbps: g.speedGbps, media: g.media, label: g.label, number: i + 1 });
      }
    }
    portCache.set(key, list);
  }
  return list;
}

/** 構成の短い説明(例: 8C・32GB・HDD×12) */
export function partsSummary(p: ServerParts): string {
  const counts = new Map<DriveType, number>();
  for (const d of p.drives) counts.set(d, (counts.get(d) ?? 0) + 1);
  const dr = [...counts].map(([t, n]) => `${DRIVES[t].name}×${n}`).join('+') || 'ドライブなし';
  return `${p.cpu}C・${p.memGB}GB・${dr}${p.nic !== 'none' ? '・10G' : ''}`;
}
