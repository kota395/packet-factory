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
  | 'srv-1u-e'
  | 'srv-1u-d'
  | 'srv-2u-db'
  | 'srv-2u-hv'
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
  | 'bgp';

/** 何度でも(上限まで)買える強化・契約 */
export type UpgradeId = 'marketing' | 'monetize' | 'uplink' | 'rackPower';

/** お金を払ってすぐ始める施策(終わるとしばらく使えない) */
export type CampaignId = 'shopSale';

/** ポートの指定。port は機器のポートを先頭から数えた番号 */
export interface PortRef {
  readonly device: number;
  readonly port: number;
}
