/** サーバに割り当てる役割(ソフトウェア) */
export type RoleId = 'web' | 'db' | 'cache' | 'lb' | 'replica';

export const ROLE_IDS: readonly RoleId[] = ['lb', 'web', 'cache', 'db', 'replica'];

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
  | 'cache'
  | 'lb'
  | 'replication'
  | 'virtualization'
  | 'tenGig'
  | 'agg'
  | 'storage';

/** 何度でも(上限まで)買える強化・契約 */
export type UpgradeId = 'marketing' | 'monetize' | 'uplink' | 'rackPower';

/** ポートの指定。port は機器のポートを先頭から数えた番号 */
export interface PortRef {
  readonly device: number;
  readonly port: number;
}
