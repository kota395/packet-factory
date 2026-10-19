import {
  BASE_REVENUE,
  CHURN,
  DATA_SIZE_KB,
  DAY_AMPLITUDE,
  DAY_CYCLE_MS,
  GRID_H,
  GRID_W,
  GROWTH_RATE,
  INTERNET_POS,
  LINK_BUFFER_MS,
  MAX_HOPS,
  MIN_TRANSIT_MS,
  MIN_USERS,
  NODE_COST_GROWTH,
  NODE_DEFS,
  REQ_PER_USER,
  SELL_REFUND_RATE,
  START_MONEY,
  START_USERS,
  TICK_MS,
  TIMEOUT_MS,
  TRANSIT_MS_PER_CELL,
  WRITE_SHARE,
  type NodeKindDef,
} from './config';
import { UNLOCKS, UNLOCK_BY_ID, UPGRADE_BY_ID, emptyUpgrades, upgradeCost, type FeatureEffect } from './economy';
import { Metrics } from './metrics';
import { mulberry32, poisson } from './rng';
import type { ErrorReason, NodeKind, ReqKind, Request, UnlockId, UpgradeId } from './types';

export interface Job {
  readonly req: Request;
  readonly doneAt: number;
}

export interface NodeRuntime {
  readonly id: number;
  readonly kind: NodeKind;
  readonly def: NodeKindDef;
  x: number;
  y: number;
  /** 購入時に払った額(撤去時の返金に使う) */
  readonly paid: number;
  queue: Request[];
  busy: Job[];
  /** 接続先ノード ID */
  out: number[];
  /** ラウンドロビンの位置 */
  rr: number;
  processed: number;
  errors: number;
  lastErrorAt: number;
  /** 今の 1 秒間に届いた数(internet は送り出した数) */
  arrivals: Record<ReqKind, number>;
  /** 届いているリクエスト数/秒(種類別、直近数秒の平滑値) */
  inRps: Record<ReqKind, number>;
  /** 今の 1 秒間に届いたデータ量(KB) */
  arrivalsKB: number;
  /** 届いているデータ量(KB/秒、平滑値) */
  inKBps: number;
  /** 帯域を持つノードで、回線が次に空く時刻 */
  linkFreeAt: number;
}

/** 受信量の平滑化係数(1 秒ごと)。大きいほど直近の値を重視する */
const IN_RPS_SMOOTHING = 0.5;

/** ノード間を移動中のリクエスト */
export interface Transit {
  readonly req: Request;
  readonly from: number;
  readonly to: number;
  readonly start: number;
  readonly end: number;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: number;
}

export interface SimOptions {
  seed?: number;
  startMoney?: number;
  startUsers?: number;
  /**
   * 流入量(rps)を固定の関数で与える。指定するとユーザー数による流量計算と
   * ユーザーの増減を行わない(主にテスト用)
   */
  traffic?: (tMs: number) => number;
  /** 書き込みの割合を固定する(テスト用) */
  writeShare?: number;
  unlocks?: Iterable<UnlockId>;
  /** 解放済みだがオフにしている配信コンテンツ */
  disabledFeatures?: Iterable<UnlockId>;
  upgrades?: Partial<Record<UpgradeId, number>>;
}

/**
 * 描画から独立したシミュレーション本体。
 * 固定刻み(TICK_MS)で進む離散時間モデルで、各ノードは
 * 「同時処理数(workers)・キュー・処理時間」を持つ待ち行列として振る舞う。
 *
 * 経済: ユーザー数 × REQ_PER_USER が流量になり、成功したリクエストが収益になる。
 * ユーザーは市場規模に向かって自然に増え、エラーや遅延が多いと離脱する。
 */
export class Simulation {
  time = 0;
  money: number;
  users: number;
  /** 累計の売上 */
  lifetimeEarned = 0;
  /** ノードや接続が変わるたびに増える。描画側の再構築判定に使う */
  layoutVersion = 0;
  /** 投資(解放・強化)のたびに増える。UI の再構築判定に使う */
  purchaseVersion = 0;
  readonly nodes = new Map<number, NodeRuntime>();
  transits: Transit[] = [];
  readonly metrics = new Metrics();
  readonly internetId: number;
  readonly unlocks: Set<UnlockId>;
  readonly upgrades: Record<UpgradeId, number>;
  readonly disabledFeatures: Set<UnlockId>;

  private readonly rng: () => number;
  private readonly fixedTraffic: ((tMs: number) => number) | null;
  private readonly fixedWriteShare: number | null;
  private nextNodeId = 1;
  private nextReqId = 1;
  private pendingMs = 0;

  constructor(opts: SimOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.money = opts.startMoney ?? START_MONEY;
    this.users = opts.startUsers ?? START_USERS;
    this.fixedTraffic = opts.traffic ?? null;
    this.fixedWriteShare = opts.writeShare ?? null;
    this.unlocks = new Set(opts.unlocks ?? []);
    this.upgrades = { ...emptyUpgrades(), ...opts.upgrades };
    this.disabledFeatures = new Set(opts.disabledFeatures ?? []);
    this.internetId = this.createNode('internet', INTERNET_POS.x, INTERNET_POS.y, 0).id;
  }

  // ---------------------------------------------------------------- 経済の参照

  /** 潜在ユーザー数。ユーザーはここに向かって増える */
  get marketSize(): number {
    return UPGRADE_BY_ID.marketing.effect(this.upgrades.marketing);
  }

  get revenueMultiplier(): number {
    return UPGRADE_BY_ID.monetize.effect(this.upgrades.monetize);
  }

  /** 書き込みの割合。会員機能を解放し、DB を 1 台以上置いてから流れ始める */
  get writeShare(): number {
    if (this.fixedWriteShare !== null) return this.fixedWriteShare;
    return this.unlocks.has('writes') && this.countOf('db') > 0 ? WRITE_SHARE : 0;
  }

  get upkeepPerSec(): number {
    let sum = 0;
    for (const n of this.nodes.values()) sum += n.def.upkeepPerSec;
    return sum;
  }

  /** 直近の収支(売上 − 維持費)/秒 */
  get incomePerSec(): number {
    return this.metrics.rolling.revenuePerSec - this.upkeepPerSec;
  }

  /** 時刻 t における平均流入量(rps) */
  trafficAt(tMs: number): number {
    if (this.fixedTraffic) return this.fixedTraffic(tMs);
    const wave = 1 + DAY_AMPLITUDE * Math.sin((2 * Math.PI * tMs) / DAY_CYCLE_MS);
    return this.users * REQ_PER_USER * wave;
  }

  /** 1 件あたりの収益(収益化の強化と配信コンテンツの倍率込み) */
  revenueOf(kind: ReqKind): number {
    return BASE_REVENUE[kind] * this.revenueMultiplier * this.featureMultiplier('revenue', kind);
  }

  /** 1 件あたりのデータ量(KB)。配信コンテンツで重くなる */
  dataSizeKB(kind: ReqKind): number {
    return DATA_SIZE_KB[kind] * this.featureMultiplier('dataSize', kind);
  }

  /** 解放済みでオンになっている配信コンテンツの倍率の積 */
  private featureMultiplier(field: keyof FeatureEffect, kind: ReqKind): number {
    let m = 1;
    for (const u of UNLOCKS) {
      const factor = u.effect?.[field]?.[kind];
      if (factor !== undefined && this.isFeatureActive(u.id)) m *= factor;
    }
    return m;
  }

  /** 帯域(MB/秒)。帯域の制限がないノードは Infinity */
  bandwidthMBpsOf(node: NodeRuntime): number {
    const base = node.def.bandwidthMBps;
    if (base === undefined) return Infinity;
    if (node.kind === 'lb') return base * UPGRADE_BY_ID.lbBandwidth.effect(this.upgrades.lbBandwidth);
    return base;
  }

  /** 強化を反映した処理時間(ms) */
  serviceMs(node: NodeRuntime, kind: ReqKind): number {
    const base = node.def.serviceMs[kind];
    if (node.kind === 'web') return base / UPGRADE_BY_ID.webPerf.effect(this.upgrades.webPerf);
    if (node.kind === 'db') return base / UPGRADE_BY_ID.dbPerf.effect(this.upgrades.dbPerf);
    return base;
  }

  countOf(kind: NodeKind): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.kind === kind) n++;
    return n;
  }

  /** 次の 1 台の価格 */
  nodeCost(kind: NodeKind): number {
    return Math.round(NODE_DEFS[kind].cost * NODE_COST_GROWTH ** this.countOf(kind));
  }

  /** これ以上置けないか */
  isAtMaxCount(kind: NodeKind): boolean {
    const max = NODE_DEFS[kind].maxCount;
    return max !== undefined && this.countOf(kind) >= max;
  }

  isKindUnlocked(kind: NodeKind): boolean {
    const req = NODE_DEFS[kind].requires;
    return !req || this.unlocks.has(req);
  }

  // ---------------------------------------------------------------- 投資

  upgradeCost(id: UpgradeId): number {
    return upgradeCost(UPGRADE_BY_ID[id], this.upgrades[id]);
  }

  canBuyUpgrade(id: UpgradeId): string | null {
    const def = UPGRADE_BY_ID[id];
    if (def.requires && !this.unlocks.has(def.requires)) return `「${UNLOCK_BY_ID[def.requires].name}」が必要です`;
    if (this.money < this.upgradeCost(id)) return '資金が足りません';
    return null;
  }

  buyUpgrade(id: UpgradeId): ActionResult {
    const err = this.canBuyUpgrade(id);
    if (err) return { ok: false, message: err };
    this.money -= this.upgradeCost(id);
    this.upgrades[id]++;
    this.purchaseVersion++;
    return { ok: true, message: `${UPGRADE_BY_ID[id].name} Lv${this.upgrades[id]}` };
  }

  canUnlock(id: UnlockId): string | null {
    const def = UNLOCK_BY_ID[id];
    if (this.unlocks.has(id)) return '導入済みです';
    if (def.requires && !this.unlocks.has(def.requires)) return `「${UNLOCK_BY_ID[def.requires].name}」が必要です`;
    if (this.money < def.cost) return '資金が足りません';
    return null;
  }

  unlock(id: UnlockId): ActionResult {
    const err = this.canUnlock(id);
    if (err) return { ok: false, message: err };
    this.money -= UNLOCK_BY_ID[id].cost;
    this.unlocks.add(id);
    this.purchaseVersion++;
    return { ok: true, message: `${UNLOCK_BY_ID[id].name}を導入しました` };
  }

  /** 解放済みで、オフにしていないか */
  isFeatureActive(id: UnlockId): boolean {
    return this.unlocks.has(id) && !this.disabledFeatures.has(id);
  }

  /** 配信コンテンツ(効果のある解放)のオン/オフを切り替える */
  setFeatureEnabled(id: UnlockId, enabled: boolean): ActionResult {
    const def = UNLOCK_BY_ID[id];
    if (!def.effect) return { ok: false, message: `${def.name}は切り替えられません` };
    if (!this.unlocks.has(id)) return { ok: false, message: `${def.name}はまだ導入していません` };
    if (enabled) this.disabledFeatures.delete(id);
    else this.disabledFeatures.add(id);
    this.purchaseVersion++;
    return { ok: true, message: `${def.name}を${enabled ? 'オン' : 'オフ'}にしました` };
  }

  // ---------------------------------------------------------------- 盤面の参照

  /** そのノードに届いているリクエスト数/秒(internet は送り出している数) */
  inRpsOf(node: NodeRuntime): number {
    return node.inRps.static + node.inRps.write;
  }

  /**
   * そのノードが捌ける上限(リクエスト/秒)。同時処理数 ÷ 平均処理時間で、
   * 平均は実際に届いている種類の割合で重み付けする。上限が実質ないノードは Infinity。
   */
  capacityRpsOf(node: NodeRuntime): number {
    return Math.min(this.cpuCapacityRpsOf(node), this.bandwidthCapacityRpsOf(node));
  }

  /** 届いているデータ量(KB/秒) */
  inKBpsOf(node: NodeRuntime): number {
    return node.inKBps;
  }

  /** 帯域から見た上限(リクエスト/秒)= 帯域 ÷ 平均データ量 */
  bandwidthCapacityRpsOf(node: NodeRuntime): number {
    const bw = this.bandwidthMBpsOf(node);
    if (!Number.isFinite(bw)) return Infinity;
    const inRps = this.inRpsOf(node);
    let avgKB = 0;
    if (inRps > 0 && node.inKBps > 0) {
      avgKB = node.inKBps / inRps;
    } else {
      for (const k of node.def.accepts) avgKB += this.expectedShare(node, k) * this.dataSizeKB(k);
    }
    // 1 MB/秒 = 1,000 KB/秒
    return avgKB > 0 ? (bw * 1000) / avgKB : Infinity;
  }

  /** 処理能力から見た上限(リクエスト/秒)= 同時処理数 ÷ 平均処理時間 */
  cpuCapacityRpsOf(node: NodeRuntime): number {
    if (node.kind === 'internet') return Infinity;
    const accepted = node.def.accepts;
    let total = 0;
    for (const k of accepted) total += node.inRps[k];
    let avgMs = 0;
    for (const k of accepted) {
      // まだ何も届いていなければ、今の流入の割合で見積もる
      const share = total > 0 ? node.inRps[k] / total : this.expectedShare(node, k);
      avgMs += share * this.serviceMs(node, k);
    }
    return avgMs > 0 ? (node.def.workers * 1000) / avgMs : Infinity;
  }

  private expectedShare(node: NodeRuntime, kind: ReqKind): number {
    if (node.def.accepts.length === 1) return node.def.accepts[0] === kind ? 1 : 0;
    const w = this.writeShare;
    return kind === 'write' ? w : 1 - w;
  }

  nodeAt(x: number, y: number): NodeRuntime | undefined {
    for (const n of this.nodes.values()) if (n.x === x && n.y === y) return n;
    return undefined;
  }

  hasEdge(from: number, to: number): boolean {
    return this.nodes.get(from)?.out.includes(to) ?? false;
  }

  /** 接続できない理由を返す。接続できるなら null */
  connectError(from: number, to: number): string | null {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (!a || !b) return 'ノードが見つかりません';
    if (a === b) return '自分自身には接続できません';
    if (a.def.maxOut === 0) return `${a.def.name}から先へは接続できません`;
    if (!a.def.connectsTo.includes(b.kind)) return `${a.def.name}から${b.def.name}へは接続できません`;
    if (a.out.includes(to)) return 'すでに接続されています';
    if (a.out.length >= a.def.maxOut) return `${a.def.name}の接続先は ${a.def.maxOut} 個までです`;
    return null;
  }

  // ---------------------------------------------------------------- 盤面の操作

  /**
   * ノードを配置する。free を指定するとお金を払わない(セーブからの復元用)。
   * paid は撤去時の返金計算に使う、購入時に払った額。
   */
  addNode(kind: NodeKind, x: number, y: number, opts: { free?: boolean; paid?: number } = {}): ActionResult {
    const def = NODE_DEFS[kind];
    if (!def.placeable) return { ok: false, message: `${def.name}は配置できません` };
    if (!this.isKindUnlocked(kind) && !opts.free) {
      return { ok: false, message: `投資メニューで「${UNLOCK_BY_ID[def.requires!].name}」を解放してください` };
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) {
      return { ok: false, message: '盤面の外です' };
    }
    if (this.nodeAt(x, y)) return { ok: false, message: 'そのマスは使用中です' };
    // セーブからの復元(free)では、昔の上限で置かれたノードもそのまま戻す
    if (!opts.free && this.isAtMaxCount(kind)) {
      return { ok: false, message: `${def.name}は ${def.maxCount} 台までです` };
    }
    const cost = this.nodeCost(kind);
    if (!opts.free) {
      if (this.money < cost) return { ok: false, message: `資金が足りません($${cost} 必要)` };
      this.money -= cost;
    }
    const node = this.createNode(kind, x, y, opts.paid ?? cost);
    return { ok: true, id: node.id };
  }

  /** ノードを空いているマスへ動かす。接続はそのまま */
  moveNode(id: number, x: number, y: number): ActionResult {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, message: 'ノードが見つかりません' };
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) {
      return { ok: false, message: '盤面の外です' };
    }
    if (node.x === x && node.y === y) return { ok: true };
    if (this.nodeAt(x, y)) return { ok: false, message: 'そのマスは使用中です' };
    node.x = x;
    node.y = y;
    this.layoutVersion++;
    return { ok: true };
  }

  removeNode(id: number): ActionResult {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, message: 'ノードが見つかりません' };
    if (node.kind === 'internet') return { ok: false, message: 'インターネットは撤去できません' };

    // 処理中・待機中のリクエストは失敗扱い
    for (const job of node.busy) this.fail(job.req, 'drop', undefined, this.time);
    for (const req of node.queue) this.fail(req, 'drop', undefined, this.time);
    this.transits = this.transits.filter((t) => {
      if (t.to === id) {
        this.fail(t.req, 'drop', undefined, this.time);
        return false;
      }
      return true;
    });

    this.nodes.delete(id);
    for (const n of this.nodes.values()) n.out = n.out.filter((o) => o !== id);
    const refund = Math.floor(node.paid * SELL_REFUND_RATE);
    this.money += refund;
    this.layoutVersion++;
    return { ok: true, message: `${node.def.name}を撤去しました(+$${refund})` };
  }

  connect(from: number, to: number): ActionResult {
    const err = this.connectError(from, to);
    if (err) return { ok: false, message: err };
    this.nodes.get(from)!.out.push(to);
    this.layoutVersion++;
    return { ok: true };
  }

  disconnect(from: number, to: number): ActionResult {
    const a = this.nodes.get(from);
    if (!a || !a.out.includes(to)) return { ok: false, message: '接続がありません' };
    a.out = a.out.filter((o) => o !== to);
    this.layoutVersion++;
    return { ok: true };
  }

  /** 未接続なら接続、接続済みなら解除 */
  toggleEdge(from: number, to: number): ActionResult {
    if (this.hasEdge(from, to)) {
      const r = this.disconnect(from, to);
      return r.ok ? { ok: true, message: '接続を解除しました' } : r;
    }
    return this.connect(from, to);
  }

  // ---------------------------------------------------------------- 時間進行

  /** 経過時間 ms 分だけ進める(端数は次回へ持ち越し) */
  step(ms: number): void {
    this.pendingMs += ms;
    while (this.pendingMs >= TICK_MS) {
      this.pendingMs -= TICK_MS;
      this.tick();
    }
  }

  private tick(): void {
    const now = this.time + TICK_MS;

    // 1. 流入
    const lambda = (this.trafficAt(now) * TICK_MS) / 1000;
    const count = poisson(lambda, this.rng);
    const internet = this.nodes.get(this.internetId)!;
    const writeShare = this.writeShare;
    const size = { static: this.dataSizeKB('static'), write: this.dataSizeKB('write') };
    for (let i = 0; i < count; i++) {
      const kind: ReqKind = this.rng() < writeShare ? 'write' : 'static';
      const req: Request = {
        id: this.nextReqId++,
        kind,
        createdAt: now,
        hops: 0,
        readyAt: now,
        sizeKB: size[kind],
      };
      internet.arrivals[req.kind]++;
      internet.arrivalsKB += req.sizeKB;
      this.route(internet, req, now);
    }

    // 2. 到着した移動中リクエストをキューへ
    if (this.transits.length) {
      const still: Transit[] = [];
      for (const t of this.transits) {
        if (t.end <= now) this.deliver(t, now);
        else still.push(t);
      }
      this.transits = still;
    }

    // 3. 各ノードの処理
    for (const node of this.nodes.values()) {
      if (node.kind !== 'internet') this.process(node, now);
    }

    // 4. 維持費とユーザーの増減
    const dt = TICK_MS / 1000;
    this.money -= this.upkeepPerSec * dt;
    if (!this.fixedTraffic) this.updateUsers(dt);

    if (Math.floor(now / 1000) !== Math.floor(this.time / 1000)) this.rollNodeStats();
    this.time = now;
    this.metrics.advance(now, this.users);
  }

  /** 1 秒ごとに各ノードの受信量を平滑化して更新する */
  private rollNodeStats(): void {
    for (const n of this.nodes.values()) {
      for (const k of ['static', 'write'] as const) {
        n.inRps[k] += IN_RPS_SMOOTHING * (n.arrivals[k] - n.inRps[k]);
        n.arrivals[k] = 0;
      }
      n.inKBps += IN_RPS_SMOOTHING * (n.arrivalsKB - n.inKBps);
      n.arrivalsKB = 0;
    }
  }

  /** ロジスティック成長 − 品質による離脱 */
  private updateUsers(dt: number): void {
    const u = this.users;
    const growth = GROWTH_RATE * u * (1 - u / this.marketSize);
    const r = this.metrics.rolling;
    let churnRate = 0;
    if (r.errorRate > CHURN.errorThreshold) churnRate += CHURN.errorFactor * (r.errorRate - CHURN.errorThreshold);
    if (r.p99 > CHURN.slowP99Ms) churnRate += CHURN.slowRate;
    this.users = Math.max(MIN_USERS, u + (growth - churnRate * u) * dt);
  }

  /**
   * 1 刻み分の処理。空いた作業枠は「空いた時刻」から次の仕事を始めるので、
   * 処理時間が刻み(TICK_MS)より短くても 1 刻みに何件でも正確にこなせる。
   */
  private process(node: NodeRuntime, now: number): void {
    // この刻みの中で空いている(空く)作業枠の時刻
    const free: number[] = [];
    const busy: Job[] = [];
    for (const job of node.busy) {
      if (job.doneAt <= now) {
        this.complete(node, job.req, job.doneAt);
        free.push(job.doneAt);
      } else {
        busy.push(job);
      }
    }
    for (let i = node.busy.length; i < node.def.workers; i++) free.push(this.time);

    while (free.length && node.queue.length) {
      // 一番早く空く枠を使う
      let slot = 0;
      for (let i = 1; i < free.length; i++) if (free[i] < free[slot]) slot = i;
      const req = node.queue.shift()!;
      const start = Math.max(free[slot], req.readyAt);
      if (start - req.createdAt > TIMEOUT_MS) {
        this.fail(req, 'timeout', node, start);
        continue;
      }
      const doneAt = start + this.serviceMs(node, req.kind);
      if (doneAt <= now) {
        this.complete(node, req, doneAt);
        free[slot] = doneAt;
      } else {
        busy.push({ req, doneAt });
        free.splice(slot, 1);
      }
    }
    node.busy = busy;
  }

  private complete(node: NodeRuntime, req: Request, t: number): void {
    node.processed++;
    if (node.def.terminates.includes(req.kind)) {
      this.succeed(req, node, t);
      return;
    }
    const bw = this.bandwidthMBpsOf(node);
    if (Number.isFinite(bw)) {
      // 回線は 1 本で、データ量 ÷ 帯域 だけ占有する。混みすぎていたら捨てる
      const start = Math.max(node.linkFreeAt, t);
      if (start - t > LINK_BUFFER_MS) {
        this.fail(req, 'drop', node, t);
        return;
      }
      // 1 MB/秒 = 1 KB/ms
      node.linkFreeAt = start + req.sizeKB / bw;
      this.route(node, req, node.linkFreeAt);
      return;
    }
    this.route(node, req, t);
  }

  /** 接続先のうち、その種類を受け付けるノードへラウンドロビンで送る */
  private route(node: NodeRuntime, req: Request, t: number): void {
    if (req.hops >= MAX_HOPS) {
      this.fail(req, 'no-route', node, t);
      return;
    }
    const candidates: NodeRuntime[] = [];
    for (const id of node.out) {
      const target = this.nodes.get(id);
      if (target && target.def.accepts.includes(req.kind)) candidates.push(target);
    }
    if (!candidates.length) {
      this.fail(req, 'no-route', node, t);
      return;
    }
    const target = candidates[node.rr++ % candidates.length];
    req.hops++;
    const dist = Math.hypot(target.x - node.x, target.y - node.y);
    const travel = Math.max(MIN_TRANSIT_MS, Math.round(dist * TRANSIT_MS_PER_CELL));
    this.transits.push({ req, from: node.id, to: target.id, start: t, end: t + travel });
  }

  private deliver(t: Transit, now: number): void {
    const target = this.nodes.get(t.to);
    if (!target) {
      this.fail(t.req, 'drop', undefined, now);
      return;
    }
    target.arrivals[t.req.kind]++;
    target.arrivalsKB += t.req.sizeKB;
    if (target.queue.length >= target.def.queueMax) {
      this.fail(t.req, 'drop', target, now);
      return;
    }
    t.req.readyAt = t.end;
    target.queue.push(t.req);
  }

  private succeed(req: Request, node: NodeRuntime, t: number): void {
    const latency = t - req.createdAt;
    if (latency > TIMEOUT_MS) {
      this.fail(req, 'timeout', node, t);
      return;
    }
    const revenue = this.revenueOf(req.kind);
    this.metrics.recordSuccess(req.kind, latency);
    this.metrics.recordRevenue(revenue);
    this.money += revenue;
    this.lifetimeEarned += revenue;
  }

  private fail(_req: Request, reason: ErrorReason, node: NodeRuntime | undefined, t: number): void {
    this.metrics.recordError(reason);
    if (node) {
      node.errors++;
      node.lastErrorAt = t;
    }
  }

  private createNode(kind: NodeKind, x: number, y: number, paid: number): NodeRuntime {
    const node: NodeRuntime = {
      id: kind === 'internet' ? 0 : this.nextNodeId++,
      kind,
      def: NODE_DEFS[kind],
      x,
      y,
      paid,
      queue: [],
      busy: [],
      out: [],
      rr: 0,
      processed: 0,
      errors: 0,
      lastErrorAt: -Infinity,
      arrivals: { static: 0, write: 0 },
      inRps: { static: 0, write: 0 },
      arrivalsKB: 0,
      inKBps: 0,
      linkFreeAt: 0,
    };
    this.nodes.set(node.id, node);
    this.layoutVersion++;
    return node;
  }
}
