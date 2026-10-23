/**
 * ゲームの調整値。数値はここで変えれば全体に反映される。
 *  - ノードの性能 …… NODE_DEFS
 *  - データ層へのアクセスの割合 …… DATA_ACCESS
 *  - 1 件あたりのデータ量 …… DATA_SIZE_KB(画像・動画の倍率は economy.ts の UNLOCKS)
 *  - ユーザーの増減 …… ユーザーとトラフィック / CHURN
 *  - 価格・維持費・初期資金 …… pricing.ts
 *  - 投資の効果と段階 …… economy.ts
 * 拡張の段階の考え方は docs/scaling.md。変えたら `npm run balance` で進行の速さを確認する。
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
/**
 * データを使うリクエスト(動的なリクエスト)。会員機能を解放したあと、利用者のリクエストのうち
 * share の割合がデータを使い、そのうち readShare が読み込み、残りが書き込みになる。
 * CDN はこれらをキャッシュできないので、CDN を置いても必ずオリジン(WEB)まで届く。
 * WEB にデータ層がつながっていなければ、WEB だけで静的として返す(エラーにはしない)。
 */
export const DATA_ACCESS = { share: 0.2, readShare: 0.8 } as const;

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
export const DATA_SIZE_KB: Record<ReqKind, number> = { static: 20, read: 5, write: 5 };
/**
 * 帯域を持つノード(LB)の送信待ちの上限(ms)。
 * 回線が混んでこれ以上待つことになるリクエストは捨てる(パケットロス)。
 */
export const LINK_BUFFER_MS = 100;

// ---- 収益(価格は pricing.ts) ------------------------------------------
/** 成功 1 件あたりの基本収益。データ層まで使うリクエストは会員向けの機能なので高い */
export const BASE_REVENUE: Record<ReqKind, number> = { static: 0.05, read: 0.15, write: 0.15 };

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
/**
 * ノードの振る舞いは種類ごとの分岐ではなく、以下の項目の組み合わせで決まる。
 * 新しいノードは定義を足し、pricing.ts に価格を足せば動く。
 */
export interface NodeKindDef {
  readonly kind: NodeKind;
  /** 盤面に表示する短いラベル */
  readonly label: string;
  readonly name: string;
  readonly description: string;
  /** 同時に処理できる数 */
  readonly workers: number;
  readonly queueMax: number;
  /** 種類ごとの処理時間(ms)。スケールアップ前の値。受け付けない種類は 0 */
  readonly serviceMs: Readonly<Record<ReqKind, number>>;
  /**
   * 帯域(MB/秒)。指定したノードは、処理のあとデータを回線に流してから次へ送る。
   * 1 件ずつ「データ量 ÷ 帯域」だけ回線を占有するので、重いコンテンツほど詰まりやすい
   */
  readonly bandwidthMBps?: number;
  /**
   * キャッシュ。kinds のリクエストは hitRate の確率でここで返し、外れたら接続先へ送る。
   * ヒット率は強化(stat: hitRate)で上がる
   */
  readonly cache?: { readonly kinds: readonly ReqKind[]; readonly hitRate: number };
  /** 振り分けで受け付けるリクエストの種類 */
  readonly accepts: readonly ReqKind[];
  /** ここで処理が完了する(=レスポンスを返せる)種類。それ以外は次へ転送 */
  readonly terminates: readonly ReqKind[];
  /**
   * 振り分け先としての優先度(種類ごと、なければ 0)。
   * 送り元の接続先に優先度の高いノードがあれば、そちらだけに送る(例: 読み込みはキャッシュ > レプリカ > DB)
   */
  readonly routePriority?: Partial<Record<ReqKind, number>>;
  /**
   * 送り先がない種類を、エラーにせずここで静的として返す。
   * WEB にデータ層がつながっていないとき、会員機能が使えないだけでページは返せる、という表現
   */
  readonly localFallback?: boolean;
  /** ここで完了した書き込みを、接続先のこの種類のノードへ複製する(内部の仕事として) */
  readonly replicatesTo?: NodeKind;
  /** この種類のノードから接続(複製)されていないと、振り分け先に選ばれない */
  readonly replicaOf?: NodeKind;
  /** 接続できる先のノード種別 */
  readonly connectsTo: readonly NodeKind[];
  readonly maxOut: number;
  /** 置ける台数の上限(なければ無制限)。強化(stat: maxCount)で増える */
  readonly maxCount?: number;
  /** 上限に達したときに出す説明(なぜ増やせないか、代わりに何をするか) */
  readonly maxCountNote?: string;
  readonly placeable: boolean;
  /** 配置に必要な解放 */
  readonly requires?: UnlockId;
  /** 盤面上の色 */
  readonly color: number;
}

/** 受け付けない種類の処理時間は 0 にしておく */
const ms = (v: Partial<Record<ReqKind, number>>): Record<ReqKind, number> => ({ static: 0, read: 0, write: 0, ...v });

export const NODE_DEFS: Readonly<Record<NodeKind, NodeKindDef>> = {
  internet: {
    kind: 'internet',
    label: 'NET',
    name: 'インターネット',
    description: 'ユーザーからのリクエストの流入元。接続先は 1 つだけ。',
    workers: 0,
    queueMax: 0,
    serviceMs: ms({}),
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
      'ユーザーの近くで静的コンテンツをキャッシュして返す。当たった分は LB・WEB を通らないので、重い画像や動画の帯域を肩代わりできる。外れた分と、データを使う読み込み・書き込みはオリジン(LB / WEB)へ送る。',
    // 処理は非常に速く、詰まるのは帯域
    workers: 256,
    queueMax: 2000,
    serviceMs: ms({ static: 1, read: 1, write: 1 }),
    // 400 MB/秒 = 3.2 Gbps。LB の 8 倍
    bandwidthMBps: 400,
    // 静的リクエストの 60% をキャッシュから返す(「CDN キャッシュ拡張」で上がる)
    cache: { kinds: ['static'], hitRate: 0.6 },
    accepts: ['static', 'read', 'write'],
    terminates: [],
    connectsTo: ['lb', 'web'],
    maxOut: 1,
    // LB と同じく、サービス 1 つにつき 1 つ
    maxCount: 1,
    maxCountNote: 'CDN はサービス 1 つにつき 1 つ。ヒット率と帯域は投資の「CDN キャッシュ拡張」「CDN 回線増強」で上げる。',
    placeable: true,
    requires: 'cdn',
    color: 0x5bc0eb,
  },
  lb: {
    kind: 'lb',
    label: 'LB',
    name: 'ロードバランサー',
    description: '接続先の WEB へ順番に振り分ける。処理は速いが、通せるデータ量(帯域)に限りがある。',
    // 処理能力は十分高く(64 並列 × 2ms = 32,000 rps)、詰まるのは主に帯域
    workers: 64,
    queueMax: 500,
    serviceMs: ms({ static: 2, read: 2, write: 2 }),
    // 50 MB/秒 = 400 Mbps。テキストのみ(平均 20KB)なら約 2,500 rps 通せる
    bandwidthMBps: 50,
    accepts: ['static', 'read', 'write'],
    terminates: [],
    connectsTo: ['web'],
    maxOut: 64,
    // インターネット(=サービス)が 1 つの間は LB も 1 台で足りる。サービスが増えたら見直す
    maxCount: 1,
    maxCountNote: 'LB はサービス 1 つにつき 1 台。帯域は投資の「LB 回線増強」で増やす。',
    placeable: true,
    requires: 'lb',
    color: 0x9d8cff,
  },
  web: {
    kind: 'web',
    label: 'WEB',
    name: 'Web サーバー',
    description:
      'ページを組み立てて返す。状態を持たないので何台でも並べられる。読み込み・書き込みはデータ層(キャッシュ / DB / レプリカ)へ問い合わせる。',
    workers: 4,
    queueMax: 40,
    serviceMs: ms({ static: 60, read: 60, write: 60 }),
    accepts: ['static', 'read', 'write'],
    terminates: ['static'],
    localFallback: true,
    connectsTo: ['cache', 'db', 'replica'],
    maxOut: 8,
    placeable: true,
    color: 0x2ec4b6,
  },
  cache: {
    kind: 'cache',
    label: 'CACHE',
    name: 'キャッシュサーバー',
    description:
      'よく読まれるデータをメモリに置き、読み込みを当たればここで返す。外れた分は接続先の DB / レプリカへ。書き込みは扱わない。',
    workers: 16,
    queueMax: 400,
    serviceMs: ms({ read: 2 }),
    // 読み込みの 70% を返す(「キャッシュ容量拡張」で上がる)
    cache: { kinds: ['read'], hitRate: 0.7 },
    accepts: ['read'],
    terminates: [],
    routePriority: { read: 2 },
    connectsTo: ['db', 'replica'],
    maxOut: 8,
    placeable: true,
    requires: 'cache',
    color: 0xe76f51,
  },
  db: {
    kind: 'db',
    label: 'DB',
    name: 'データベース(プライマリ)',
    description:
      'データの正本を持ち、読み込みと書き込みを処理する。書き込みはここでしか受けられない。正本は 1 か所なので台数は増やせず、スケールアップか、シャーディングで分割する。',
    // WEB より大きな機種(16 並列)。書き込みだけなら 160 件/秒
    workers: 16,
    queueMax: 160,
    serviceMs: ms({ read: 60, write: 100 }),
    accepts: ['read', 'write'],
    terminates: ['read', 'write'],
    replicatesTo: 'replica',
    connectsTo: ['replica'],
    maxOut: 8,
    maxCount: 1,
    maxCountNote:
      'DB(プライマリ)はデータの正本なので台数を増やせない。読み込みはキャッシュ・レプリカへ逃がし、書き込みはシャーディングで分割する。',
    placeable: true,
    requires: 'writes',
    color: 0xf4a261,
  },
  replica: {
    kind: 'replica',
    label: 'REPLICA',
    name: 'リードレプリカ',
    description:
      'DB の複製。読み込みを肩代わりでき、台数を増やして分散できる。DB からつないでおく必要があり、DB の書き込みをすべて反映し続けるので、書き込みが多いと忙しくなる。',
    workers: 16,
    queueMax: 160,
    // write はレプリケーションの反映にかかる時間
    serviceMs: ms({ read: 60, write: 25 }),
    accepts: ['read'],
    terminates: ['read', 'write'],
    routePriority: { read: 1 },
    replicaOf: 'db',
    connectsTo: [],
    maxOut: 0,
    placeable: true,
    requires: 'replica',
    color: 0xe9c46a,
  },
};

export const PLACEABLE_KINDS = (Object.keys(NODE_DEFS) as NodeKind[]).filter(
  (k) => NODE_DEFS[k].placeable,
);
