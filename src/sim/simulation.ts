import {
  GRID_H,
  GRID_W,
  INTERNET_POS,
  MAX_HOPS,
  MIN_TRANSIT_MS,
  NODE_DEFS,
  REVENUE,
  SELL_REFUND_RATE,
  SLA_TARGET,
  STAGE_DURATION_MS,
  START_MONEY,
  TICK_MS,
  TIMEOUT_MS,
  TRANSIT_MS_PER_CELL,
  WRITE_SHARE,
  trafficRps,
  type NodeKindDef,
} from './config';
import { Metrics } from './metrics';
import { mulberry32, poisson } from './rng';
import type { ErrorReason, NodeKind, Request } from './types';

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

export type SimStatus = 'running' | 'cleared' | 'failed' | 'bankrupt';

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: number;
}

export interface SimOptions {
  seed?: number;
  startMoney?: number;
  durationMs?: number;
  /** 時刻(ms)→ 平均流入量(rps)。テストで差し替えられるようにしている */
  traffic?: (tMs: number) => number;
  writeShare?: number;
}

/**
 * 描画から独立したシミュレーション本体。
 * 固定刻み(TICK_MS)で進む離散時間モデルで、各ノードは
 * 「同時処理数(workers)・キュー・処理時間」を持つ待ち行列として振る舞う。
 */
export class Simulation {
  time = 0;
  money: number;
  status: SimStatus = 'running';
  /** ノードや接続が変わるたびに増える。描画側の再構築判定に使う */
  layoutVersion = 0;
  readonly startMoney: number;
  readonly durationMs: number;
  readonly nodes = new Map<number, NodeRuntime>();
  transits: Transit[] = [];
  readonly metrics = new Metrics();
  readonly internetId: number;

  private readonly rng: () => number;
  private readonly traffic: (tMs: number) => number;
  private readonly writeShare: number;
  private nextNodeId = 1;
  private nextReqId = 1;
  private pendingMs = 0;

  constructor(opts: SimOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.startMoney = opts.startMoney ?? START_MONEY;
    this.money = this.startMoney;
    this.durationMs = opts.durationMs ?? STAGE_DURATION_MS;
    this.traffic = opts.traffic ?? trafficRps;
    this.writeShare = opts.writeShare ?? WRITE_SHARE;
    this.internetId = this.createNode('internet', INTERNET_POS.x, INTERNET_POS.y).id;
  }

  // ---------------------------------------------------------------- 参照系

  get upkeepPerSec(): number {
    let sum = 0;
    for (const n of this.nodes.values()) sum += n.def.upkeepPerSec;
    return sum;
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

  // ---------------------------------------------------------------- 操作系

  addNode(kind: NodeKind, x: number, y: number): ActionResult {
    const def = NODE_DEFS[kind];
    if (!def.placeable) return { ok: false, message: `${def.name}は配置できません` };
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) {
      return { ok: false, message: '盤面の外です' };
    }
    if (this.nodeAt(x, y)) return { ok: false, message: 'そのマスは使用中です' };
    if (this.money < def.cost) return { ok: false, message: `予算が足りません($${def.cost} 必要)` };
    this.money -= def.cost;
    const node = this.createNode(kind, x, y);
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
    const refund = Math.floor(node.def.cost * SELL_REFUND_RATE);
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
    if (this.status !== 'running') return;
    this.pendingMs += ms;
    while (this.pendingMs >= TICK_MS && this.status === 'running') {
      this.pendingMs -= TICK_MS;
      this.tick();
    }
  }

  private tick(): void {
    const now = this.time + TICK_MS;

    // 1. 流入
    const lambda = (this.traffic(now) * TICK_MS) / 1000;
    const count = poisson(lambda, this.rng);
    const internet = this.nodes.get(this.internetId)!;
    for (let i = 0; i < count; i++) {
      const req: Request = {
        id: this.nextReqId++,
        kind: this.rng() < this.writeShare ? 'write' : 'static',
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

    // 4. 維持費
    this.money -= (this.upkeepPerSec * TICK_MS) / 1000;

    this.time = now;
    this.metrics.advance(now);

    // 5. 終了判定
    if (this.money < 0) {
      this.status = 'bankrupt';
    } else if (this.time >= this.durationMs) {
      this.status = this.metrics.availability >= SLA_TARGET ? 'cleared' : 'failed';
    }
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
      node.busy.push({ req, doneAt: now + node.def.serviceMs[req.kind] });
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
    this.metrics.recordSuccess(req.kind, latency);
    this.money += REVENUE[req.kind];
  }

  private fail(_req: Request, reason: ErrorReason, node: NodeRuntime | undefined, t: number): void {
    this.metrics.recordError(reason);
    if (node) {
      node.errors++;
      node.lastErrorAt = t;
    }
  }

  private createNode(kind: NodeKind, x: number, y: number): NodeRuntime {
    const node: NodeRuntime = {
      id: kind === 'internet' ? 0 : this.nextNodeId++,
      kind,
      def: NODE_DEFS[kind],
      x,
      y,
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
