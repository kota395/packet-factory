/** リクエストの種類。色分けして描画する。 */
export type ReqKind = 'static' | 'write';

/** ノードの種類。internet はステージに 1 つだけ固定で置かれる流入元。 */
export type NodeKind = 'internet' | 'cdn' | 'lb' | 'web' | 'db';

/** 失敗理由。drop=キュー溢れ, timeout=時間切れ, no-route=行き先なし */
export type ErrorReason = 'drop' | 'timeout' | 'no-route';

/** 一度買えば解放される機能 */
export type UnlockId = 'lb' | 'writes' | 'images' | 'video' | 'cdn';

/** 何度でも買える強化 */
export type UpgradeId =
  | 'marketing'
  | 'monetize'
  | 'cdnCache'
  | 'cdnBandwidth'
  | 'lbBandwidth'
  | 'webPerf'
  | 'dbPerf';

export interface Request {
  readonly id: number;
  /** WEB から DB へ回るときに write へ変わる */
  kind: ReqKind;
  /** 生成時刻(シミュレーション時間 ms) */
  readonly createdAt: number;
  /** 経由したノード数。ループ検出に使う */
  hops: number;
  /** 今いるノードのキューに入った時刻。処理開始はこれより前にならない */
  readyAt: number;
  /** データ量(KB)。生成時の配信内容で決まる */
  sizeKB: number;
}
