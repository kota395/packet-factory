/**
 * ゲームの調整値。数値はここで変えれば全体に反映される。
 *  - 列とラック …… ROW / RACK / UPLINK_LEVELS_GBPS
 *  - ケーブルの長さ …… CABLE
 *  - サービスの仕事量(1 ページビューあたり)…… WORK / SERVICES / BLOG_FEATURES / CAMPAIGN
 *  - ユーザーの増減 …… ユーザー / CHURN
 *  - 機器の性能 …… catalog.ts
 *  - 価格・維持費 …… pricing.ts
 *  - 投資の効果と段階 …… economy.ts
 * 設計は docs/design.md。変えたら `npm run balance` で進行の速さを確認する。
 */
import type { RoleId, ServiceId } from './types';

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

// ---- 仕事量 -----------------------------------------------------------
/** どのサービスでも共通の仕事量(1 リクエスト・1 クエリあたり) */
export const WORK = {
  /** リクエストの大きさ(KB) */
  requestKB: 1,
  /** LB の CPU 時間(コア性能 1.0 で ms) */
  lbCpuMs: 0.2,
  /** db の読み込み 1 回の CPU 時間(ms)・返るデータ(KB)・クエリの大きさ(KB) */
  dbReadCpuMs: 1.2,
  dbReadKB: 4,
  queryKB: 0.5,
  /** 書き込み 1 回の CPU 時間(ms)とディスク IO 数 */
  dbWriteCpuMs: 3,
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

/**
 * サービスの 1 ページビューあたりの仕事量。
 *  - search: 検索。役割「search」がなければ db が LIKE 検索で肩代わりする(重い)
 *  - media: 画像・動画の配信。ページとは別のリクエストで、役割「media」がなければ web が配る
 *  - upload: 投稿。web が受けて、役割「worker」が加工(サムネイル・エンコード)して media に保存する。
 *    worker がなければ web が加工する
 */
export interface Workload {
  /** 返すページ(HTML など)の大きさ(KB) */
  readonly pageKB: number;
  /** web の CPU 時間(ms) */
  readonly webCpuMs: number;
  /** db への読み込みクエリ数と書き込み数 */
  readonly dbReads: number;
  readonly dbWrites: number;
  readonly search?: {
    /** 1 ページあたりの検索の回数 */
    readonly perPv: number;
    /** 検索サーバの CPU 時間(ms)と返す結果(KB) */
    readonly cpuMs: number;
    readonly resultKB: number;
    /** 検索の索引がメモリに乗らない割合 = この値 ÷ 使えるメモリ(GB)。外れるとディスク IO が 1 回 */
    readonly missPerGB: number;
    /** search がなく db が肩代わりするときの CPU 時間(ms)と、読むディスク IO の数 */
    readonly dbCpuMs: number;
    readonly dbIo: number;
  };
  readonly media?: {
    /** 1 ページあたりの取得の回数と 1 回の大きさ(KB) */
    readonly perPv: number;
    readonly kb: number;
    /** 1 回の CPU 時間(ms) */
    readonly cpuMs: number;
    /** 1 回のディスク IO 数(メモリに乗らなかったとき) */
    readonly io: number;
    /** メモリに乗らない割合 = この値 ÷ 使えるメモリ(GB) */
    readonly missPerGB: number;
  };
  readonly upload?: {
    /** 1 ページあたりの投稿の数と 1 件の大きさ(KB) */
    readonly perPv: number;
    readonly kb: number;
    /** 加工(サムネイル生成・エンコード)の CPU 時間(ms) */
    readonly workerCpuMs: number;
    /** 保存する大きさ(KB)と、保存のディスク IO 数 */
    readonly storedKB: number;
    readonly storeIo: number;
  };
}

export interface ServiceDef {
  readonly name: string;
  /** このサービスで使う役割(並び順は UI の表示順) */
  readonly roles: readonly RoleId[];
  /** 始めたときのユーザー数・市場規模(広告 Lv0)・1 ページビューあたりの基本収益 */
  readonly startUsers: number;
  readonly baseMarket: number;
  readonly revenuePerPv: number;
  readonly work: Workload;
}

export const SERVICES: Readonly<Record<ServiceId, ServiceDef>> = {
  blog: {
    name: 'ブログ',
    roles: ['lb', 'web', 'cache', 'db', 'replica'],
    startUsers: 300,
    baseMarket: 1500,
    revenuePerPv: 0.05,
    work: { pageKB: 30, webCpuMs: 12, dbReads: 3, dbWrites: 0 },
  },
  shop: {
    name: 'ショッピング',
    roles: ['lb', 'web', 'cache', 'search', 'db', 'replica'],
    startUsers: 200,
    baseMarket: 3000,
    revenuePerPv: 0.15,
    work: {
      pageKB: 40,
      webCpuMs: 18,
      dbReads: 6,
      // 注文とカート。在庫の整合性のため書き込みは db(プライマリ)だけ
      dbWrites: 0.04,
      search: { perPv: 0.4, cpuMs: 6, resultKB: 6, missPerGB: 4, dbCpuMs: 40, dbIo: 4 },
    },
  },
  photo: {
    name: '写真共有',
    roles: ['lb', 'web', 'cache', 'db', 'replica', 'media', 'worker'],
    startUsers: 200,
    baseMarket: 6000,
    revenuePerPv: 0.08,
    work: {
      pageKB: 25,
      webCpuMs: 10,
      dbReads: 4,
      dbWrites: 0.02,
      // 1 ページにサムネイルがたくさん並ぶ
      media: { perPv: 12, kb: 40, cpuMs: 0.1, io: 1, missPerGB: 6 },
      upload: { perPv: 0.02, kb: 3000, workerCpuMs: 400, storedKB: 3200, storeIo: 8 },
    },
  },
  video: {
    name: '動画配信',
    roles: ['lb', 'web', 'cache', 'db', 'replica', 'media', 'worker'],
    startUsers: 100,
    baseMarket: 5000,
    revenuePerPv: 0.6,
    work: {
      pageKB: 40,
      webCpuMs: 15,
      dbReads: 4,
      dbWrites: 0.01,
      // 1 ページビュー = 数秒ぶんの動画の取得
      media: { perPv: 1, kb: 6000, cpuMs: 0.5, io: 24, missPerGB: 1.5 },
      upload: { perPv: 0.002, kb: 200_000, workerCpuMs: 60_000, storedKB: 300_000, storeIo: 1200 },
    },
  },
};

/** ブログの機能(投資)で増える仕事量 */
export const BLOG_FEATURES = {
  /** 画像投稿を入れたときに 1 ページに載る画像(KB) */
  imageKB: 150,
  /** コメント機能を入れたあとの、1 ページあたりの書き込み数 */
  commentWrites: 0.05,
} as const;

/** ショッピングのキャンペーン: お金を払うとすぐ始まり、終わるとしばらく使えない(価格は pricing.ts) */
export const CAMPAIGN = {
  /** 続く時間とクールタイム(秒) */
  durationSec: 90,
  cooldownSec: 300,
  /** 期間中の訪問(ページビュー)の倍率と、1 ページビューあたりの収益の倍率(注文が増える) */
  trafficMul: 2.5,
  revenueMul: 1.3,
  /** 期間中に新しく来て、そのまま残るユーザーの割合(期間中の市場規模に対して) */
  retainRate: 0.05,
} as const;

/** 役割ごとに使うメモリ(GB)。db・レプリカ・search・media はサーバの残りのメモリをキャッシュに使う */
export const ROLE_MEM_GB: Readonly<Record<RoleId, number>> = {
  web: 1,
  lb: 0.5,
  cache: 2,
  db: 1,
  replica: 1,
  search: 1,
  media: 0.5,
  worker: 1,
};

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
// 始めたときのユーザー数・市場規模・単価はサービスごと(SERVICES)
export const MIN_USERS = 50;
/** ユーザー 1 人あたりのページビュー/秒 */
export const PV_PER_USER = 0.01;
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
  /**
   * 障害。オンにすると、回線終端以外の機器がときどき止まり、しばらくすると直る。
   * 冗長化(BGP で 2 台の ToR につなぐ、web を並べる など)が効いてくる
   */
  failures: {
    enabled: false,
    /** 機器 1 台が平均して何秒に 1 回壊れるか */
    mtbfSec: 1800,
    /** 直るまでの秒数 */
    repairSec: 60,
  },
};

/** メトリクス(ダッシュボード)と需要予測 */
export const METRICS = {
  /** HUD などの「直近」の集計に使う幅(ms) */
  windowMs: 5000,
  /** 推移を残す長さ(秒) */
  historySec: 3600,
  /** 今の構成で捌ける量(キャパシティ)を見積もり直す間隔(シミュレーション時間 ms) */
  capacityEveryMs: 2000,
  /** キャパシティ = 成功率がこの値を保てる最大のページビュー/秒 */
  capacitySuccess: 0.99,
  /** 需要予測を何秒先まで出すか */
  forecastSec: 900,
} as const;

/** 放置(ページを閉じている間)の収入 */
export const OFFLINE = {
  minMs: 30_000,
  maxMs: 8 * 60 * 60 * 1000,
  efficiency: 0.5,
} as const;
