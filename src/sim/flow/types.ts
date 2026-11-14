/** 流量モデルの入力と結果の型 */
import type { Workload } from '../config';
import type { DiskKind, RoleId, RoleKey, ServiceId } from '../types';

/** 動いているサービスの流量と、1 ページビューあたりの仕事量(機能のオン/オフを反映したもの) */
export interface ServiceLoad {
  readonly id: ServiceId;
  readonly pv: number;
  readonly work: Workload;
}

/** 同じワーカーに置いた、同じ役割の Pod のまとまり */
export interface PodGroup {
  /** ノードの ID(機器・VM と重ならない大きな数) */
  readonly id: number;
  /** 置いたワーカー(物理サーバは機器 ID、VM は −VM ID) */
  readonly worker: number;
  readonly role: RoleKey;
  readonly count: number;
}

/** Pod のまとまりのノード ID はこの数から */
export const POD_ID_BASE = 1_000_000;

export interface FlowInput {
  readonly services: readonly ServiceLoad[];
  /** Kubernetes の Pod(なければ空) */
  readonly pods?: readonly PodGroup[];
  readonly uplinkGbps: number;
  /** 解放済みの役割の種類 */
  readonly roles: ReadonlySet<RoleId>;
  /** シミュレーション時刻(移行中の VM を除くのに使う) */
  readonly now: number;
  /** BGP を解放しているか */
  readonly bgp: boolean;
  /** 分析基盤: Hadoop・機械学習を解放しているか */
  readonly analytics?: { readonly hadoop: boolean; readonly ml: boolean };
  /** db(プライマリ)を分けられるか: 1 台だけ / 機能分割(2 台)/ シャーディング(何台でも) */
  readonly dbSplit?: 'none' | 'functional' | 'shard';
  /** 止まっている機器(メンテナンス・障害) */
  readonly down: ReadonlySet<number>;
}

/**
 * 経路。ECMP で複数の経路に分かれることがあるので、リンクごとに流れる割合(frac)を持つ。
 * 同じ機器の中(同じホストの VM 同士など)なら edges は空
 */
export interface Route {
  readonly edges: { link: LinkLoad; forward: boolean; frac: number }[];
  /** 中継するスイッチと、そこを通る割合 */
  readonly transit: { id: number; frac: number }[];
}

/** 役割を動かす単位。物理サーバは機器 ID(正の数)、VM は −VM ID(負の数) */
export interface ComputeNode {
  readonly id: number;
  readonly name: string;
  /** 通信の出入りに使う物理機器(VM ならホスト) */
  readonly host: number;
  readonly cores: number;
  readonly coreSpeed: number;
  readonly memGB: number;
  readonly roles: readonly RoleKey[];
  readonly vm: boolean;
  readonly disk: DiskKind;
  /** Pod のまとまりなら、置いたワーカーのノード(ワーカーの CPU も使う) */
  readonly parent?: number;
  /** Pod のまとまりなら、その Pod の数 */
  readonly pods?: number;
  /** BGP で外へ広報している(LB なしでインターネットから直接受けられる) */
  readonly advertised?: boolean;
  /** LB アプライアンスなら、1 秒あたりに振り分けられるリクエスト数 */
  readonly lbRps?: number;
  /** 使える GPU の枚数。VM と Pod は、載っているサーバの GPU を分け合う(パススルー) */
  readonly gpus?: number;
}

export interface NodeLoad {
  /** CPU(VM なら割り当てた vCPU)の使用率 */
  cpu: number;
  /** ディスク(ローカルならホストのディスク、共有ならストレージ)の使用率 */
  io: number;
  /** このノードが出しているディスク IO(回/秒) */
  ioOps: number;
  /** GPU の使用率(GPU があるノードだけ) */
  gpu?: number;
  /** 役割ごとの処理量(/秒) */
  work: Partial<Record<RoleKey, number>>;
  /** 役割ごとの、読み込みがメモリに乗らずディスクに行く割合(db・レプリカ・search・media) */
  miss: Partial<Record<RoleKey, number>>;
  /** 共有ディスクに使っているストレージ(機器 ID)。届かなければ null */
  storage?: number | null;
}

export interface DeviceLoad {
  /** CPU・ディスク IO(ストレージは IOPS)・スイッチの処理能力の使用率(0〜、1 超えは溢れ)。VM のホストは VM の合計 */
  cpu: number;
  io: number;
  fabric: number;
  /** GPU の使用率(GPU を載せたサーバだけ) */
  gpu: number;
  /** この機器を通る(出入りする)通信量(Gbps) */
  gbps: number;
}

/** 2 台の機器の間のリンク(複数のケーブルはまとめて 1 本として扱う) */
export interface LinkLoad {
  readonly a: number;
  readonly b: number;
  readonly capacityGbps: number;
  readonly cables: number[];
  /** a → b と b → a の流量(Gbps) */
  ab: number;
  ba: number;
}

export interface Bottleneck {
  readonly label: string;
  readonly rho: number;
}

/** サービスごとの結果 */
export interface ServiceFlow {
  readonly id: ServiceId;
  readonly pv: number;
  /** 成功する割合(0〜1) */
  readonly success: number;
  readonly latencyMs: number;
  readonly p99Ms: number;
  /** 役割ごとに実際に使われているノード */
  readonly instances: Record<RoleId, number[]>;
  /** インターネットから最初に受けるノード */
  readonly entries: number[];
  /** このサービスの警告 */
  readonly problems: string[];
}

/** 分析基盤の結果 */
export interface AnalyticsFlow {
  /** 全サービスのログ(MB/秒) */
  readonly logMBps: number;
  /** 処理しきれた割合(Hadoop の集計と、機械学習) */
  readonly coverage: number;
  readonly mlCoverage: number;
  /** 1 ページビューあたりの収益の倍率 */
  readonly boost: number;
  readonly hadoop: number[];
  readonly ml: number[];
}

export interface FlowResult {
  /** すべてのサービスの合計 */
  readonly pv: number;
  /** 成功する割合(0〜1)と応答。サービスのページビューで重み付けした平均 */
  readonly success: number;
  readonly latencyMs: number;
  readonly p99Ms: number;
  readonly services: Partial<Record<ServiceId, ServiceFlow>>;
  readonly analytics: AnalyticsFlow;
  readonly devices: Map<number, DeviceLoad>;
  readonly links: LinkLoad[];
  /** 役割を動かしているノード(物理サーバと VM)と、その負荷 */
  readonly nodes: Map<number, ComputeNode>;
  readonly nodeLoads: Map<number, NodeLoad>;
  /** 未接続・役割の不足などの警告(複数のサービスが動いていればサービス名つき) */
  readonly problems: string[];
  /** 一番使用率の高い資源 */
  readonly bottleneck: Bottleneck | null;
}
