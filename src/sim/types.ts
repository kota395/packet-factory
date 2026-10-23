/**
 * リクエストの種類。色分けして描画する。
 * static: ページ・画像などの静的コンテンツ(CDN でキャッシュできる)
 * read / write: データを使うリクエスト。WEB を経てデータ層(キャッシュ・DB・レプリカ)まで届く
 */
export type ReqKind = 'static' | 'read' | 'write';

export const REQ_KINDS: readonly ReqKind[] = ['static', 'read', 'write'];

/** ノードの種類。internet はステージに 1 つだけ固定で置かれる流入元。 */
export type NodeKind = 'internet' | 'cdn' | 'lb' | 'web' | 'cache' | 'db' | 'replica';

/** 失敗理由。drop=キュー溢れ, timeout=時間切れ, no-route=行き先なし */
export type ErrorReason = 'drop' | 'timeout' | 'no-route';

/** 一度買えば解放される機能 */
export type UnlockId = 'lb' | 'writes' | 'cache' | 'replica' | 'images' | 'cdn' | 'video' | 'sharding';

/** 何度でも買える強化 */
export type UpgradeId =
  | 'marketing'
  | 'monetize'
  | 'cdnCache'
  | 'cdnBandwidth'
  | 'lbBandwidth'
  | 'webPerf'
  | 'dbPerf'
  | 'cacheMemory'
  | 'dbShards';

export interface Request {
  readonly id: number;
  /** WEB にデータ層がつながっていないとき、read / write は static として返す */
  kind: ReqKind;
  /** レプリケーションなど、利用者に見えない内部の仕事(売上・エラー率に数えない) */
  readonly internal?: boolean;
  /** 生成時刻(シミュレーション時間 ms) */
  readonly createdAt: number;
  /** 経由したノード数。ループ検出に使う */
  hops: number;
  /** 今いるノードのキューに入った時刻。処理開始はこれより前にならない */
  readyAt: number;
  /** データ量(KB)。生成時の配信内容で決まる */
  sizeKB: number;
}
