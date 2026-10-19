import type { NodeKind, ReqKind } from './types';

// ---- 盤面 -------------------------------------------------------------
export const GRID_W = 16;
export const GRID_H = 9;
export const INTERNET_POS = { x: 0, y: 4 } as const;

// ---- 時間 -------------------------------------------------------------
/** シミュレーションの固定刻み(ms) */
export const TICK_MS = 10;
/** 1 ステージの長さ(シミュレーション時間)。ゲーム内では 24 時間として表示する */
export const STAGE_DURATION_MS = 300_000;
/** これを超えたリクエストはタイムアウト扱い */
export const TIMEOUT_MS = 1500;
/** ノード間を 1 マス移動するのにかかる時間。配置の距離がレイテンシに効く */
export const TRANSIT_MS_PER_CELL = 20;
export const MIN_TRANSIT_MS = 10;
/** これ以上ノードを経由したらループとみなして破棄 */
export const MAX_HOPS = 12;

// ---- 経済 -------------------------------------------------------------
export const START_MONEY = 800;
export const SELL_REFUND_RATE = 0.5;
/** 成功 1 件あたりの収益 */
export const REVENUE: Record<ReqKind, number> = { static: 0.025, write: 0.06 };

// ---- 目標 -------------------------------------------------------------
/** ステージ終了時に必要な可用性 */
export const SLA_TARGET = 0.99;

// ---- トラフィック -----------------------------------------------------
export const WRITE_SHARE = 0.25;

/** 時刻 t(ms)における平均流入量(リクエスト/秒)。徐々に増え、緩やかに波打つ */
export function trafficRps(tMs: number): number {
  const p = Math.min(1, Math.max(0, tMs / STAGE_DURATION_MS));
  const base = 15 + 205 * Math.pow(p, 1.4);
  const wave = 1 + 0.12 * Math.sin(tMs / 9000);
  return base * wave;
}

// ---- ノード定義 -------------------------------------------------------
export interface NodeKindDef {
  readonly kind: NodeKind;
  /** 盤面に表示する短いラベル */
  readonly label: string;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly upkeepPerSec: number;
  /** 同時に処理できる数 */
  readonly workers: number;
  readonly queueMax: number;
  /** 種類ごとの処理時間(ms) */
  readonly serviceMs: Readonly<Record<ReqKind, number>>;
  /** 受け付けるリクエストの種類 */
  readonly accepts: readonly ReqKind[];
  /** ここで処理が完了する(=レスポンスを返せる)種類。それ以外は次へ転送 */
  readonly terminates: readonly ReqKind[];
  /** 接続できる先のノード種別 */
  readonly connectsTo: readonly NodeKind[];
  readonly maxOut: number;
  readonly placeable: boolean;
  /** 盤面上の色 */
  readonly color: number;
}

export const NODE_DEFS: Readonly<Record<NodeKind, NodeKindDef>> = {
  internet: {
    kind: 'internet',
    label: 'NET',
    name: 'インターネット',
    description: 'リクエストの流入元。接続先は 1 つだけ。',
    cost: 0,
    upkeepPerSec: 0,
    workers: 0,
    queueMax: 0,
    serviceMs: { static: 0, write: 0 },
    accepts: [],
    terminates: [],
    connectsTo: ['lb', 'web'],
    maxOut: 1,
    placeable: false,
    color: 0x8b98a5,
  },
  lb: {
    kind: 'lb',
    label: 'LB',
    name: 'ロードバランサー',
    description: '接続先へ順番に振り分ける。',
    cost: 150,
    upkeepPerSec: 0.1,
    workers: 1000,
    queueMax: 2000,
    serviceMs: { static: 1, write: 1 },
    accepts: ['static', 'write'],
    terminates: [],
    connectsTo: ['web', 'lb'],
    maxOut: 8,
    placeable: true,
    color: 0x9d8cff,
  },
  web: {
    kind: 'web',
    label: 'WEB',
    name: 'Web サーバー',
    description: '静的リクエストを処理する。書き込みは DB へ転送。',
    cost: 100,
    upkeepPerSec: 0.15,
    workers: 4,
    queueMax: 40,
    serviceMs: { static: 60, write: 30 },
    accepts: ['static', 'write'],
    terminates: ['static'],
    connectsTo: ['db'],
    maxOut: 4,
    placeable: true,
    color: 0x2ec4b6,
  },
  db: {
    kind: 'db',
    label: 'DB',
    name: 'データベース',
    description: '書き込みを処理する。静的リクエストは受け付けない。',
    cost: 300,
    upkeepPerSec: 0.4,
    workers: 4,
    queueMax: 40,
    serviceMs: { static: 0, write: 80 },
    accepts: ['write'],
    terminates: ['write'],
    connectsTo: [],
    maxOut: 0,
    placeable: true,
    color: 0xf4a261,
  },
};

export const PLACEABLE_KINDS = (Object.keys(NODE_DEFS) as NodeKind[]).filter(
  (k) => NODE_DEFS[k].placeable,
);
