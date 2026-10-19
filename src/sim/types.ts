/** リクエストの種類。色分けして描画する。 */
export type ReqKind = 'static' | 'write';

/** ノードの種類。internet はステージに 1 つだけ固定で置かれる流入元。 */
export type NodeKind = 'internet' | 'lb' | 'web' | 'db';

/** 失敗理由。drop=キュー溢れ, timeout=時間切れ, no-route=行き先なし */
export type ErrorReason = 'drop' | 'timeout' | 'no-route';

/** 一度買えば解放される機能 */
export type UnlockId = 'lb' | 'writes';

/** 何度でも買える強化 */
export type UpgradeId = 'marketing' | 'monetize' | 'webPerf' | 'dbPerf';

export interface Request {
  readonly id: number;
  readonly kind: ReqKind;
  /** 生成時刻(シミュレーション時間 ms) */
  readonly createdAt: number;
  /** 経由したノード数。ループ検出に使う */
  hops: number;
}
