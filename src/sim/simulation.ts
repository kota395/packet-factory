import {
  BASE_REVENUE,
  CHURN,
  DAY_AMPLITUDE,
  DAY_CYCLE_MS,
  GRID_H,
  GRID_W,
  GROWTH_RATE,
  INTERNET_POS,
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
import { UNLOCK_BY_ID, UPGRADE_BY_ID, emptyUpgrades, upgradeCost } from './economy';
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
  readonly x: number;
  readonly y: number;
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
}

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

  revenueOf(kind: ReqKind): number {
    return BASE_REVENUE[kind] * this.revenueMultiplier;
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

  // ---------------------------------------------------------------- 盤面の参照

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
    const cost = this.nodeCost(kind);
    if (!opts.free) {
      if (this.money < cost) return { ok: false, message: `資金が足りません($${cost} 必要)` };
      this.money -= cost;
    }
    const node = this.createNode(kind, x, y, opts.paid ?? cost);
    return { ok: true, id: node.id };
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
    for (let i = 0; i < count; i++) {
      const req: Request = {
        id: this.nextReqId++,
        kind: this.rng() < writeShare ? 'write' : 'static',
        createdAt: now,
        hops: 0,
      };
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

    this.time = now;
    this.metrics.advance(now, this.users);
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

  private process(node: NodeRuntime, now: number): void {
    if (node.busy.length) {
      const remaining: Job[] = [];
      for (const job of node.busy) {
        if (job.doneAt <= now) this.complete(node, job.req, job.doneAt);
        else remaining.push(job);
      }
      node.busy = remaining;
    }
    while (node.busy.length < node.def.workers && node.queue.length) {
      const req = node.queue.shift()!;
      if (now - req.createdAt > TIMEOUT_MS) {
        this.fail(req, 'timeout', node, now);
        continue;
      }
      node.busy.push({ req, doneAt: now + this.serviceMs(node, req.kind) });
    }
  }

  private complete(node: NodeRuntime, req: Request, t: number): void {
    node.processed++;
    if (node.def.terminates.includes(req.kind)) this.succeed(req, node, t);
    else this.route(node, req, t);
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
    if (target.queue.length >= target.def.queueMax) {
      this.fail(t.req, 'drop', target, now);
      return;
    }
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
    };
    this.nodes.set(node.id, node);
    this.layoutVersion++;
    return node;
  }
}
