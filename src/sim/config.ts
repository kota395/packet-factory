/**
 * ゲームの調整値。数値はここで変えれば全体に反映される。
 *  - ノードの性能・価格 …… NODE_DEFS
 *  - 1 件あたりのデータ量 …… DATA_SIZE_KB(画像・動画の倍率は economy.ts の UNLOCKS)
 *  - ユーザーの増減 …… ユーザーとトラフィック / CHURN
 *  - 投資の価格と効果 …… economy.ts
 * 変えたら `npm run balance` で進行の速さを確認する。
 */
import type { NodeKind, ReqKind, UnlockId } from './types';

// ---- 盤面 -------------------------------------------------------------
export const GRID_W = 16;
export const GRID_H = 9;
export const INTERNET_POS = { x: 0, y: 4 } as const;
/** 新規ゲームで最初から置いてある WEB の位置 */
export const STARTER_WEB_POS = { x: 3, y: 4 } as const;

// ---- 時間 -------------------------------------------------------------
/** シミュレーションの固定刻み(ms) */
export const TICK_MS = 10;
/** これを超えたリクエストはタイムアウト扱い */
export const TIMEOUT_MS = 1500;
/** ノード間を 1 マス移動するのにかかる時間。配置の距離がレイテンシに効く */
export const TRANSIT_MS_PER_CELL = 20;
export const MIN_TRANSIT_MS = 10;
/** これ以上ノードを経由したらループとみなして破棄 */
export const MAX_HOPS = 12;

// ---- ユーザーとトラフィック ---------------------------------------------
export const START_USERS = 300;
/** ユーザーがこれ以下には減らない(サービスを続けている限りの固定客) */
export const MIN_USERS = 50;
/** ユーザー 1 人あたりの平均リクエスト数(/秒) */
export const REQ_PER_USER = 0.01;
/** 1 日の周期(シミュレーション時間)。流量はこの周期で波打つ */
export const DAY_CYCLE_MS = 120_000;
export const DAY_AMPLITUDE = 0.2;
/** 市場規模(潜在ユーザー数)の初期値 */
export const BASE_MARKET = 1500;
/** 口コミによる自然増加率(/秒)。市場規模に近づくほど鈍る(ロジスティック成長) */
export const GROWTH_RATE = 0.03;
/** 会員機能を解放したあと、WEB に届いたリクエストのうち DB へ流す割合(DB が接続されている WEB のみ) */
export const WEB_TO_DB_SHARE = 0.2;

/** 品質が悪いときの離脱 */
export const CHURN = {
  /** エラー率がこれを超えると離脱が始まる */
  errorThreshold: 0.01,
  /** 超過したエラー率 1 あたりの離脱率(/秒) */
  errorFactor: 0.3,
  /** p99 がこれを超えると遅さによる離脱が起きる */
  slowP99Ms: 1000,
  slowRate: 0.003,
} as const;

// ---- データ量 ---------------------------------------------------------
/**
 * 1 件あたりのデータ量(KB)の基準値。テキスト中心の Web サービスを想定。
 * 画像投稿・動画配信を解放すると economy.ts の倍率が掛かって重くなる。
 */
export const DATA_SIZE_KB: Record<ReqKind, number> = { static: 20, write: 5 };
/**
 * 帯域を持つノード(LB)の送信待ちの上限(ms)。
 * 回線が混んでこれ以上待つことになるリクエストは捨てる(パケットロス)。
 */
export const LINK_BUFFER_MS = 100;

// ---- お金 -------------------------------------------------------------
export const START_MONEY = 60;
export const SELL_REFUND_RATE = 0.5;
/** 成功 1 件あたりの基本収益 */
export const BASE_REVENUE: Record<ReqKind, number> = { static: 0.05, write: 0.15 };
/** 同じ種類のノードを 1 台増やすごとの価格上昇率 */
export const NODE_COST_GROWTH = 1.15;

/** 放置(ページを閉じている間)の収入 */
export const OFFLINE = {
  /** これより短い不在は数えない */
  minMs: 30_000,
  /** 最大で何時間分まで */
  maxMs: 8 * 60 * 60 * 1000,
  /** 最後の収入/秒に対する効率 */
  efficiency: 0.5,
} as const;

// ---- ノード定義 -------------------------------------------------------
export interface NodeKindDef {
  readonly kind: NodeKind;
  /** 盤面に表示する短いラベル */
  readonly label: string;
  readonly name: string;
  readonly description: string;
  /** 1 台目の価格。2 台目以降は NODE_COST_GROWTH 倍ずつ上がる */
  readonly cost: number;
  readonly upkeepPerSec: number;
  /** 同時に処理できる数 */
  readonly workers: number;
  readonly queueMax: number;
  /** 種類ごとの処理時間(ms)。強化前の値 */
  readonly serviceMs: Readonly<Record<ReqKind, number>>;
  /**
   * 帯域(MB/秒)。指定したノードは、処理のあとデータを回線に流してから次へ送る。
   * 1 件ずつ「データ量 ÷ 帯域」だけ回線を占有するので、重いコンテンツほど詰まりやすい
   */
  readonly bandwidthMBps?: number;
  /**
   * キャッシュ(CDN)。kinds のリクエストは hitRate の確率でここで返し、外れたら接続先(オリジン)へ送る。
   * 返したデータも外れたデータも、このノードの帯域を通る
   */
  readonly cache?: { readonly kinds: readonly ReqKind[]; readonly hitRate: number };
  /** 受け付けるリクエストの種類 */
  readonly accepts: readonly ReqKind[];
  /** ここで処理が完了する(=レスポンスを返せる)種類。それ以外は次へ転送 */
  readonly terminates: readonly ReqKind[];
  /** 接続できる先のノード種別 */
  readonly connectsTo: readonly NodeKind[];
  readonly maxOut: number;
  /** 置ける台数の上限(なければ無制限) */
  readonly maxCount?: number;
  readonly placeable: boolean;
  /** 配置に必要な解放 */
  readonly requires?: UnlockId;
  /** 処理のあと、この割合で接続先の別ノードへ転送する(書き込みとして扱う) */
  readonly forwardsToDb?: boolean;
  /** 盤面上の色 */
  readonly color: number;
}

export const NODE_DEFS: Readonly<Record<NodeKind, NodeKindDef>> = {
  internet: {
    kind: 'internet',
    label: 'NET',
    name: 'インターネット',
    description: 'ユーザーからのリクエストの流入元。接続先は 1 つだけ。',
    cost: 0,
    upkeepPerSec: 0,
    workers: 0,
    queueMax: 0,
    serviceMs: { static: 0, write: 0 },
    accepts: [],
    terminates: [],
    connectsTo: ['cdn', 'lb', 'web'],
    maxOut: 1,
    placeable: false,
    color: 0x8b98a5,
  },
  cdn: {
    kind: 'cdn',
    label: 'CDN',
    name: 'CDN',
    description:
      'ユーザーの近くで静的コンテンツをキャッシュして返す。当たった分は LB・WEB を通らないので、重い画像や動画の帯域を肩代わりできる。外れた分と書き込みはオリジン(LB / WEB)へ送る。',
    cost: 2000,
    upkeepPerSec: 1,
    // 処理は非常に速く、詰まるのは帯域
    workers: 256,
    queueMax: 2000,
    serviceMs: { static: 1, write: 1 },
    // 400 MB/秒 = 3.2 Gbps。LB の 8 倍
    bandwidthMBps: 400,
    // 静的リクエストの 60% をキャッシュから返す(「CDN キャッシュ拡張」で上がる)
    cache: { kinds: ['static'], hitRate: 0.6 },
    accepts: ['static', 'write'],
    terminates: [],
    connectsTo: ['lb', 'web'],
    maxOut: 1,
    // LB と同じく、サービス 1 つにつき 1 つ
    maxCount: 1,
    placeable: true,
    requires: 'cdn',
    color: 0x5bc0eb,
  },
  lb: {
    kind: 'lb',
    label: 'LB',
    name: 'ロードバランサー',
    description: '接続先の WEB へ順番に振り分ける。処理は速いが、通せるデータ量(帯域)に限りがある。',
    cost: 150,
    upkeepPerSec: 0.1,
    // 処理能力は十分高く(64 並列 × 2ms = 32,000 rps)、詰まるのは主に帯域
    workers: 64,
    queueMax: 500,
    serviceMs: { static: 2, write: 2 },
    // 50 MB/秒 = 400 Mbps。テキストのみ(平均 15KB 前後)なら約 3,000 rps 通せる
    bandwidthMBps: 50,
    accepts: ['static', 'write'],
    terminates: [],
    connectsTo: ['web'],
    maxOut: 64,
    // インターネット(=サービス)が 1 つの間は LB も 1 台で足りる。サービスが増えたら見直す
    maxCount: 1,
    placeable: true,
    requires: 'lb',
    color: 0x9d8cff,
  },
  web: {
    kind: 'web',
    label: 'WEB',
    name: 'Web サーバー',
    description: 'リクエストを処理する。会員機能のあとは 1/5 を DB へ転送。',
    cost: 50,
    upkeepPerSec: 0.05,
    workers: 4,
    queueMax: 40,
    serviceMs: { static: 60, write: 30 },
    accepts: ['static'],
    terminates: ['static'],
    forwardsToDb: true,
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
    cost: 400,
    upkeepPerSec: 0.3,
    workers: 4,
    queueMax: 40,
    serviceMs: { static: 0, write: 80 },
    accepts: ['write'],
    terminates: ['write'],
    connectsTo: [],
    maxOut: 0,
    placeable: true,
    requires: 'writes',
    color: 0xf4a261,
  },
};

export const PLACEABLE_KINDS = (Object.keys(NODE_DEFS) as NodeKind[]).filter(
  (k) => NODE_DEFS[k].placeable,
);
