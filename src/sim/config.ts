/**
 * ゲームの調整値。数値はここで変えれば全体に反映される。
 *  - 列とラック …… ROW / RACK / UPLINK_LEVELS_GBPS
 *  - ケーブルの長さ …… CABLE
 *  - ブログの仕事量(1 ページビューあたり)…… BLOG
 *  - ユーザーの増減 …… ユーザー / CHURN
 *  - 機器の性能 …… catalog.ts
 *  - 価格・維持費 …… pricing.ts
 *  - 投資の効果と段階 …… economy.ts
 * 設計は docs/design.md。変えたら `npm run balance` で進行の速さを確認する。
 */
import type { RoleId } from './types';

// ---- 列とラック -------------------------------------------------------
export const ROW = {
  /** 1 列に置けるラックの数 */
  maxRacks: 20,
} as const;

export const RACK = {
  /** ラックの高さ(U) */
  units: 42,
  /** 電力の上限(W)。電力契約の強化で上がる。レベル 0 が最初 */
  powerLevelsW: [2000, 3000, 4000, 6000],
} as const;

/** 回線契約の速度(Gbps)。レベル 0 が最初 */
export const UPLINK_LEVELS_GBPS = [0.1, 1, 10] as const;

// ---- ケーブル ---------------------------------------------------------
export const CABLE = {
  /** 同じラック内: 基本の長さ + 1U あたりの長さ(m) */
  sameRackBaseM: 1,
  perUnitM: 0.045,
  /** ラック間: ケーブルトレイまで上がって下りる分 + ラック 1 本ぶん横に進むごとの長さ(m) */
  crossRackBaseM: 4,
  perRackM: 0.6,
} as const;

// ---- 時間 -------------------------------------------------------------
/** 流量を計算し直す間隔(シミュレーション時間 ms) */
export const TICK_MS = 200;

// ---- ブログの仕事量(1 ページビューあたり) ----------------------------
export const BLOG = {
  /** リクエストの大きさ(KB) */
  requestKB: 1,
  /** 返すページ(HTML など)の大きさ(KB) */
  pageKB: 30,
  /** 画像投稿を入れたときに 1 ページに載る画像(KB) */
  imageKB: 150,
  /** web の CPU 時間(コア性能 1.0 で ms) */
  webCpuMs: 12,
  /** LB の CPU 時間(ms) */
  lbCpuMs: 0.2,
  /** db への読み込みクエリ数 */
  dbReads: 3,
  dbReadCpuMs: 1.2,
  /** 読み込み 1 回で返るデータ(KB)とクエリの大きさ(KB) */
  dbReadKB: 4,
  queryKB: 0.5,
  /** コメント機能を入れたあとの、1 ページあたりの書き込み数 */
  dbWrites: 0.05,
  dbWriteCpuMs: 3,
  /** 書き込み 1 回のディスク IO 数 */
  dbWriteIo: 3,
  /** 読み込みがディスクに行く割合 = この値 ÷ db に使えるメモリ(GB)。メモリが多いほどキャッシュに乗る */
  dbMissPerGB: 2.4,
  /** 読み込みの外れ率の下限 */
  dbMissMin: 0.03,
  /** ディスクに行ったときの待ち時間(ms) */
  diskMs: 6,
  /** memcached のヒット率と、1 回あたりの CPU 時間(ms) */
  cacheHitRate: 0.85,
  cacheCpuMs: 0.05,
} as const;

/** 役割ごとに使うメモリ(GB)。db とレプリカはサーバの残りのメモリを読み込みのキャッシュに使う */
export const ROLE_MEM_GB: Readonly<Record<RoleId, number>> = { web: 1, lb: 0.5, cache: 2, db: 1, replica: 1 };

/** レプリケーション: レプリカが書き込みを反映するときの CPU と IO(元の書き込みに対する割合) */
export const REPLICATION = {
  applyCpu: 0.5,
  applyIo: 1,
} as const;

// ---- 仮想化とストレージ ----------------------------------------------
export const VIRT = {
  /** VM の大きさ: vCPU とメモリ(GB) */
  sizes: {
    s: { vcpu: 2, memGB: 4, label: 'S' },
    m: { vcpu: 4, memGB: 16, label: 'M' },
    l: { vcpu: 8, memGB: 48, label: 'L' },
  },
  /** ハイパーバイザ自身が使うメモリ(GB) */
  hostMemGB: 8,
  /** vCPU はホストのコア数の何倍まで割り当てられるか(オーバーコミット) */
  vcpuOvercommit: 2,
  /** VM の CPU 負荷にかかる仮想化のオーバーヘッド */
  cpuOverhead: 1.1,
  /** ローカルディスクの VM を別のホストへ移すときに止まる時間(ms)。共有ストレージなら止まらない */
  migrateDowntimeMs: 20_000,
  /** 共有ストレージへの IO 1 回あたりのデータ(KB)と待ち時間(ms) */
  storageIoKB: 16,
  storageMs: 1.5,
} as const;

export const NET = {
  /** 利用者とのやり取りの往復時間(ms) */
  internetRttMs: 40,
  /** スイッチ 1 台を通るごとの遅延(ms) */
  hopMs: 0.05,
} as const;

/** 待ち時間の計算では、使用率をこれ以上として扱わない(無限大にしない) */
export const MAX_QUEUE_RHO = 0.97;
/** p99 の見積もり = 平均応答 × この倍率 */
export const P99_FACTOR = 2.5;

// ---- ユーザー ---------------------------------------------------------
export const START_USERS = 300;
export const MIN_USERS = 50;
/** ユーザー 1 人あたりのページビュー/秒 */
export const PV_PER_USER = 0.01;
/** 1 ページビューあたりの基本収益(広告など) */
export const REVENUE_PER_PV = 0.05;
/** 市場規模(潜在ユーザー数)の初期値 */
export const BASE_MARKET = 1500;
/** 口コミによる自然増加率(/秒)。市場規模に近づくほど鈍る(ロジスティック成長) */
export const GROWTH_RATE = 0.03;

/** 品質が悪いときの離脱 */
export const CHURN = {
  /** エラー率がこれを超えると離脱が始まる */
  errorThreshold: 0.01,
  /** 超過したエラー率 1 あたりの離脱率(/秒) */
  errorFactor: 0.3,
  /** 応答(p99 の見積もり)がこれを超えると遅さによる離脱が起きる */
  slowMs: 1500,
  slowRate: 0.003,
} as const;

/**
 * 難易度のオプション。最初はオフ。
 * 難易度を上げるモードを作るときにオンにする(障害などのイベントもここに足していく)。
 */
export const DIFFICULTY = {
  /** 1 日の波(昼夜で流量が上下する)の振れ幅。0.2 なら ±20%。0 でなし */
  dayWave: 0,
  dayCycleMs: 120_000,
};

/** 放置(ページを閉じている間)の収入 */
export const OFFLINE = {
  minMs: 30_000,
  maxMs: 8 * 60 * 60 * 1000,
  efficiency: 0.5,
} as const;
