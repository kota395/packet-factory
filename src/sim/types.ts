/** 事業(サービス)。ブログ → ショッピング → 写真共有 → 動画配信 の順に始められる */
export type ServiceId = 'blog' | 'shop' | 'photo' | 'video';

export const SERVICE_IDS: readonly ServiceId[] = ['blog', 'shop', 'photo', 'video'];

/** 役割(ソフトウェア)の種類 */
export type RoleId = 'lb' | 'web' | 'cache' | 'db' | 'replica' | 'search' | 'media' | 'worker';

export const ROLE_IDS: readonly RoleId[] = ['lb', 'web', 'cache', 'db', 'replica', 'search', 'media', 'worker'];

/**
 * サーバ・VM に割り当てる役割。サービスごとに付けるので「shop:web」のように書く。
 * 1 台に複数のサービスの役割を相乗りさせても、サービスごとに分けてもよい
 */
export type RoleKey = `${ServiceId}:${RoleId}`;

export const roleKey = (service: ServiceId, role: RoleId): RoleKey => `${service}:${role}`;

export function splitRole(key: RoleKey): [ServiceId, RoleId] {
  const [s, r] = key.split(':');
  return [s as ServiceId, r as RoleId];
}

export function isRoleKey(x: unknown): x is RoleKey {
  if (typeof x !== 'string') return false;
  const [s, r] = x.split(':');
  return SERVICE_IDS.includes(s as ServiceId) && ROLE_IDS.includes(r as RoleId);
}

/** VM の大きさ */
export type VmSize = 's' | 'm' | 'l';

/** VM のディスクの置き場所: ホストのローカルディスク / 共有ストレージ */
export type DiskKind = 'local' | 'shared';

/** 機器の分類 */
export type Category = 'server' | 'switch' | 'handoff' | 'storage';

/** 機種 */
export type ModelId =
  | 'handoff'
  | 'srv-1u'
  | 'srv-2u'
  | 'nas-2u'
  | 'sw-24'
  | 'sw-48'
  | 'agg-10g';

/** ポートの差し込み口 */
export type Media = 'rj45' | 'sfp';

/** 一度買えば解放される機能 */
export type UnlockId =
  | 'images'
  | 'comments'
  | 'shop'
  | 'photo'
  | 'video'
  | 'cache'
  | 'lb'
  | 'replication'
  | 'virtualization'
  | 'kubernetes'
  | 'tenGig'
  | 'agg'
  | 'storage'
  | 'nvme'
  | 'bgp'
  | 'partition'
  | 'sharding'
  | 'multihoming'
  | 'cdn';

/** 何度でも(上限まで)買える強化・契約 */
export type UpgradeId = 'marketing' | 'monetize' | 'uplink' | 'rackPower';

/** お金を払ってすぐ始める施策(終わるとしばらく使えない) */
export type CampaignId = 'shopSale';

/** ポートの指定。port は機器のポートを先頭から数えた番号 */
export interface PortRef {
  readonly device: number;
  readonly port: number;
}

/** サーバのドライブの種類 */
export type DriveType = 'hdd' | 'ssd' | 'nvme';

/** 2U の前面のバックプレーン: 2.5 インチ(SSD・NVMe)か 3.5 インチ(HDD) */
export type Backplane = 'sff' | 'lff';

/** 増設の NIC */
export type NicId = 'none' | 'sfp10';

/** サーバの構成(シャーシに載せたパーツ) */
export interface ServerParts {
  /** CPU のコア数(CPU_OPTIONS のどれか) */
  readonly cpu: number;
  /** メモリ(GB、MEMORY_OPTIONS のどれか) */
  readonly memGB: number;
  readonly backplane: Backplane;
  /** 前面のドライブ。2 本ずつミラーにする */
  readonly drives: readonly DriveType[];
  readonly nic: NicId;
}
