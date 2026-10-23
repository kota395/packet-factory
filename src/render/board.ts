import { Application, Container, Graphics, Sprite, Text, type FederatedPointerEvent, type Texture } from 'pixi.js';
import { GRID_H, GRID_W } from '../sim/config';
import type { NodeRuntime, Simulation } from '../sim/simulation';
import type { ReqKind } from '../sim/types';
import { compact } from '../ui/format';
import { nodeName } from '../ui/node-info';

const COLORS = {
  bg: 0x0b0f14,
  cell: 0x111821,
  cellLine: 0x1a2430,
  cellLineMajor: 0x223042,
  edge: 0x4a5a6d,
  edgeActive: 0xe8edf2,
  packet: { static: 0x4aa3ff, read: 0x7bd88f, write: 0xff9f43 } satisfies Record<ReqKind, number>,
  error: 0xff4d4f,
  selected: 0xffffff,
  connectFrom: 0xffd166,
  gaugeBg: 0x0b0f14,
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  text: 0xe8edf2,
  muted: 0x8b98a5,
} as const;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** 盤面の 1 マスの大きさ(ワールド座標)。画面上の大きさはこれ × ズーム */
const CELL = 64;
/** 描画するパケット数の上限。超えたら間引いて表示する */
const MAX_PACKET_SPRITES = 2500;
/** エラー時にノードの枠を赤くする時間(シミュレーション時間 ms) */
const ERROR_FLASH_MS = 400;
/** これ以上指が動いたらタップではなくドラッグとみなす(px) */
const DRAG_THRESHOLD = 8;
/** ノード上の数値を更新する間隔(ms) */
const STATS_INTERVAL_MS = 250;
/** 画面上のマスがこれ以上なら、メーターの見出しを出す(px) */
const DETAIL_CELL = 52;
/** 画面上のマスがこれ以上なら、接続線に流量を出す(px) */
const EDGE_LABEL_CELL = 40;
/** ズームの上限 */
const MAX_ZOOM = 2;
/** 「全体を表示」で寄りすぎないための上限 */
const FIT_MAX_ZOOM = 1.15;
/** 文字をズームしてもにじまないように、高めの解像度で描く */
const TEXT_RESOLUTION = 3;
/** 出力端子(●)の半径と、つかめる範囲(マスに対する割合) */
const PORT_RADIUS = 0.085;
const PORT_HIT = 0.22;

export interface ViewState {
  selectedId: number | null;
  connectFrom: number | null;
  /** 接続ツール中は、ノード本体からのドラッグも配線になる */
  connectMode: boolean;
}

interface Point {
  x: number;
  y: number;
}

type Curve = [Point, Point, Point, Point];

interface NodeView {
  container: Container;
  body: Graphics;
  label: Text;
  stats: Text;
  bar: Graphics;
  /** バーの見出し(拡大しているときだけ表示) */
  captions: Text[];
}

/** ノードに出すメーター 1 本分 */
interface Meter {
  caption: string;
  /** 0〜1(1 を超えたら満杯で表示) */
  ratio: number;
  /** 指定がなければ負荷率の色(緑→黄→赤) */
  color?: number;
}

/** 種類ごとに、ノードに出すメーター */
function metersOf(node: NodeRuntime, sim: Simulation): Meter[] {
  const inRps = sim.inRpsOf(node);
  const cpu = sim.cpuCapacityRpsOf(node);
  const bw = sim.bandwidthMBpsOf(node);
  const cpuMeter: Meter = { caption: '処理', ratio: Number.isFinite(cpu) && cpu > 0 ? inRps / cpu : 0 };
  const bwMeter: Meter = { caption: '帯域', ratio: Number.isFinite(bw) ? node.inKBps / 1000 / bw : 0 };
  const queueMeter: Meter = { caption: '待ち', ratio: node.queue.length / node.def.queueMax };
  if (node.kind === 'internet') return [];
  // 能力に合わせて大事なものから 2 本: 帯域 → キャッシュ → 処理 → 待ち
  const meters: Meter[] = [];
  if (Number.isFinite(bw)) meters.push(bwMeter);
  const cache = node.def.cache;
  if (cache) meters.push({ caption: 'HIT', ratio: sim.cacheHitRateOf(node), color: COLORS.packet[cache.kinds[0]] });
  meters.push(cpuMeter, queueMeter);
  return meters.slice(0, 2);
}

/** 負荷率(受信 / 上限)に応じた色 */
const loadColor = (ratio: number) => (ratio >= 0.9 ? COLORS.error : ratio >= 0.7 ? COLORS.warn : COLORS.ok);

function bezier(c: Curve, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  };
}

/** 押してからの操作。動かすまではどれになるか未定(pending) */
type Gesture =
  | { kind: 'pending'; sx: number; sy: number; cell: Point | null; nodeId: number | null; wireFrom: number | null }
  | { kind: 'move'; nodeId: number; x: number; y: number }
  | { kind: 'wire'; from: number; x: number; y: number }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'pinch'; dist: number; mid: Point };

/**
 * Simulation の状態を PixiJS で描画する。シミュレーションには書き込まず、
 * タップやドラッグはコールバックで呼び出し側へ渡す。
 *
 * 盤面は画面より広いので、カメラ(ワールドの拡大率と位置)で見る範囲を決める。
 * 空きマスのドラッグ・ホイール・ピンチで動かせる。
 * 縦長画面では盤面を転置し、インターネットが上に来るように表示する。
 */
export class BoardRenderer {
  readonly app = new Application();
  /** 盤面のマスがタップされたとき(シミュレーション座標) */
  onCellTap: ((x: number, y: number) => void) | null = null;
  /** ノードがドラッグで別のマスへ落とされたとき */
  onNodeMove: ((id: number, x: number, y: number) => void) | null = null;
  /** 出力端子(または接続ツール中のノード)から別のノードへドラッグして離したとき */
  onConnect: ((from: number, to: number) => void) | null = null;

  private readonly world = new Container();
  private readonly gridG = new Graphics();
  private readonly dropG = new Graphics();
  private readonly edgeG = new Graphics();
  private readonly wireG = new Graphics();
  private readonly packetLayer = new Container();
  private readonly nodeLayer = new Container();
  private readonly edgeLabelLayer = new Container();
  private readonly edgeLabels = new Map<string, Text>();
  private packetTexture!: Texture;
  private readonly sprites: Sprite[] = [];
  private readonly nodeViews = new Map<number, NodeView>();

  private zoom = 1;
  private portrait = false;
  private lastW = 0;
  private lastH = 0;
  private builtLayoutVersion = -1;
  private builtSim: Simulation | null = null;
  /** カメラを合わせたシミュレーション(読み込み・新規ゲームで合わせ直す) */
  private fittedSim: Simulation | null = null;
  private lastStatsAt = 0;
  private statsRefreshedThisFrame = false;
  private view: ViewState = { selectedId: null, connectFrom: null, connectMode: false };

  private gesture: Gesture | null = null;
  /** 画面に触れている指(ピンチ用) */
  private readonly pointers = new Map<number, Point>();

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      background: COLORS.bg,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    host.appendChild(this.app.canvas);
    // resizeTo はウィンドウのリサイズしか見ないので、HUD やグラフの開閉で盤面の高さが変わったときにも追従させる
    new ResizeObserver(() => this.app.queueResize()).observe(host);

    this.nodeLayer.sortableChildren = true;
    this.world.addChild(
      this.gridG,
      this.dropG,
      this.edgeG,
      this.packetLayer,
      this.edgeLabelLayer,
      this.wireG,
      this.nodeLayer,
    );
    this.app.stage.addChild(this.world);

    const dot = new Graphics().circle(0, 0, 8).fill(0xffffff);
    this.packetTexture = this.app.renderer.generateTexture(dot);
    dot.destroy();

    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e) => this.handleDown(e));
    stage.on('globalpointermove', (e) => this.handleMove(e));
    stage.on('pointerup', (e) => this.handleUp(e));
    stage.on('pointerupoutside', (e) => this.handleUp(e));
    this.app.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.app.canvas.getBoundingClientRect();
        // トラックパッドの細かいスクロールでも滑らかに拡大縮小する
        this.zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  draw(sim: Simulation, view: ViewState): void {
    this.view = view;
    const { width, height } = this.app.screen;
    if (width !== this.lastW || height !== this.lastH) this.relayout(width, height);
    if (sim !== this.builtSim || sim.layoutVersion !== this.builtLayoutVersion) this.rebuildNodes(sim);
    if (sim !== this.fittedSim) this.fit(sim);
    const g = this.gesture;
    if (g?.kind === 'move' && !sim.nodes.has(g.nodeId)) this.gesture = null;
    if (g?.kind === 'wire' && !sim.nodes.has(g.from)) this.gesture = null;

    const now = performance.now();
    const refreshStats = now - this.lastStatsAt >= STATS_INTERVAL_MS;
    if (refreshStats) this.lastStatsAt = now;
    this.statsRefreshedThisFrame = refreshStats;

    this.drawDropTarget(sim);
    this.drawEdges(sim, view);
    this.drawWire(sim);
    this.drawPackets(sim);
    const detail = this.screenCell >= DETAIL_CELL;
    for (const node of sim.nodes.values()) this.updateNode(node, sim, view, refreshStats, detail);
  }

  // ---------------------------------------------------------------- カメラ

  /** 画面上のマスの大きさ(px) */
  private get screenCell(): number {
    return CELL * this.zoom;
  }

  /** 盤面全体が画面に収まる拡大率(これより小さくはしない) */
  private get minZoom(): number {
    const { width, height } = this.app.screen;
    return Math.min(width / (this.cols * CELL), height / (this.rows * CELL)) * 0.95;
  }

  /** 置いてあるノードがすべて見えるようにカメラを合わせる */
  fit(sim: Simulation | null = this.builtSim): void {
    if (!sim) return;
    this.fittedSim = sim;
    const { width, height } = this.app.screen;
    if (!width || !height) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of sim.nodes.values()) {
      const c = this.center(n.x, n.y);
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
    // 周りに 2 マスずつ余白を取り、少なくとも 12×7 マス分は見せる
    const margin = CELL * 2.5;
    const w = Math.max(maxX - minX + margin * 2, (this.portrait ? 7 : 12) * CELL);
    const h = Math.max(maxY - minY + margin * 2, (this.portrait ? 12 : 7) * CELL);
    this.zoom = clamp(Math.min(width / w, height / h), this.minZoom, FIT_MAX_ZOOM);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.world.scale.set(this.zoom);
    this.world.position.set(width / 2 - cx * this.zoom, height / 2 - cy * this.zoom);
    this.clampPan();
  }

  /** 画面の中心を基準に拡大・縮小する(ボタン用) */
  zoomBy(factor: number): void {
    const { width, height } = this.app.screen;
    this.zoomAt({ x: width / 2, y: height / 2 }, factor);
  }

  /** 画面上の点 p を動かさずに拡大・縮小する */
  private zoomAt(p: Point, factor: number): void {
    const next = clamp(this.zoom * factor, this.minZoom, MAX_ZOOM);
    if (next === this.zoom) return;
    const wx = (p.x - this.world.x) / this.zoom;
    const wy = (p.y - this.world.y) / this.zoom;
    this.zoom = next;
    this.world.scale.set(next);
    this.world.position.set(p.x - wx * next, p.y - wy * next);
    this.clampPan();
  }

  /** 盤面が画面の外へ行きすぎないようにする。画面より小さければ中央に置く */
  private clampPan(): void {
    const { width, height } = this.app.screen;
    const gw = this.cols * CELL * this.zoom;
    const gh = this.rows * CELL * this.zoom;
    const slack = 0.25;
    const fit = (pos: number, size: number, screen: number) =>
      size <= screen ? (screen - size) / 2 : clamp(pos, screen - size - screen * slack, screen * slack);
    this.world.position.set(fit(this.world.x, gw, width), fit(this.world.y, gh, height));
  }

  // ---------------------------------------------------------------- 入力

  private handleDown(e: FederatedPointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
    if (this.pointers.size >= 2) {
      // 2 本目の指が触れたらピンチ。進行中の操作は取り消す
      this.gesture = this.pinchGesture();
      return;
    }
    const p = this.world.toLocal(e.global);
    const cell = this.toCell(p.x, p.y);
    const node = cell && this.builtSim ? this.builtSim.nodeAt(cell.x, cell.y) : undefined;
    // 出力端子をつかんだら配線。接続ツール中はノード本体からでも配線
    const port = this.portAt(p);
    let wireFrom: number | null = port?.id ?? null;
    if (wireFrom === null && node && this.view.connectMode && node.def.maxOut > 0) wireFrom = node.id;
    this.gesture = {
      kind: 'pending',
      sx: e.global.x,
      sy: e.global.y,
      cell,
      nodeId: port?.id ?? node?.id ?? null,
      wireFrom,
    };
  }

  private handleMove(e: FederatedPointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      const next = this.pinchGesture();
      if (next.kind !== 'pinch' || g.dist <= 0) return;
      this.zoomAt(next.mid, next.dist / g.dist);
      this.world.position.set(this.world.x + next.mid.x - g.mid.x, this.world.y + next.mid.y - g.mid.y);
      this.clampPan();
      this.gesture = next;
      return;
    }
    if (g.kind === 'pending') {
      if (Math.hypot(e.global.x - g.sx, e.global.y - g.sy) < DRAG_THRESHOLD) return;
      if (g.wireFrom !== null) this.gesture = { kind: 'wire', from: g.wireFrom, x: 0, y: 0 };
      else if (g.nodeId !== null) this.gesture = { kind: 'move', nodeId: g.nodeId, x: 0, y: 0 };
      else this.gesture = { kind: 'pan', lastX: g.sx, lastY: g.sy };
    }
    const cur = this.gesture!;
    if (cur.kind === 'pan') {
      this.world.position.set(this.world.x + e.global.x - cur.lastX, this.world.y + e.global.y - cur.lastY);
      this.clampPan();
      cur.lastX = e.global.x;
      cur.lastY = e.global.y;
    } else if (cur.kind === 'move' || cur.kind === 'wire') {
      const p = this.world.toLocal(e.global);
      cur.x = p.x;
      cur.y = p.y;
    }
  }

  private handleUp(e: FederatedPointerEvent): void {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (g?.kind === 'pinch') {
      // 指が 1 本残っても、離すまでは何もしない(誤タップを防ぐ)
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    this.gesture = null;
    if (!g) return;
    if (g.kind === 'move') {
      const cell = this.toCell(g.x, g.y);
      if (cell) this.onNodeMove?.(g.nodeId, cell.x, cell.y);
    } else if (g.kind === 'wire') {
      const target = this.nodeAtPoint(g);
      if (target && target.id !== g.from) this.onConnect?.(g.from, target.id);
    } else if (g.kind === 'pending' && g.cell) {
      this.onCellTap?.(g.cell.x, g.cell.y);
    }
  }

  private pinchGesture(): Gesture {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { kind: 'pinch', dist: 0, mid: { x: 0, y: 0 } };
    return { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  // ---------------------------------------------------------------- 座標変換

  private get cols(): number {
    return this.portrait ? GRID_H : GRID_W;
  }

  private get rows(): number {
    return this.portrait ? GRID_W : GRID_H;
  }

  /** 流れの向き(横長なら右、縦長なら下) */
  private get dir(): Point {
    return this.portrait ? { x: 0, y: 1 } : { x: 1, y: 0 };
  }

  /** シミュレーション座標 → ワールド座標(マスの中心) */
  private center(x: number, y: number): Point {
    const [c, r] = this.portrait ? [y, x] : [x, y];
    return { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL };
  }

  /** ノードの表示位置。ドラッグ中は指に追従する */
  private positionOf(node: NodeRuntime): Point {
    const g = this.gesture;
    if (g?.kind === 'move' && g.nodeId === node.id) return { x: g.x, y: g.y };
    return this.center(node.x, node.y);
  }

  /** 出力端子(●)の位置。流れの向きの辺の真ん中 */
  private portOf(node: NodeRuntime): Point {
    const p = this.positionOf(node);
    const half = CELL * 0.43;
    return { x: p.x + this.dir.x * half, y: p.y + this.dir.y * half };
  }

  /** ワールド座標 p のそばにある出力端子のノード */
  private portAt(p: Point): NodeRuntime | null {
    if (!this.builtSim) return null;
    // 縮小しているときでも指でつかめるよう、画面上で最低 14px は取る
    const r = Math.max(CELL * PORT_HIT, 14 / this.zoom);
    for (const n of this.builtSim.nodes.values()) {
      if (n.def.maxOut === 0) continue;
      const q = this.portOf(n);
      if (Math.hypot(q.x - p.x, q.y - p.y) <= r) return n;
    }
    return null;
  }

  private nodeAtPoint(p: Point): NodeRuntime | undefined {
    const cell = this.toCell(p.x, p.y);
    return cell && this.builtSim ? this.builtSim.nodeAt(cell.x, cell.y) : undefined;
  }

  private toCell(px: number, py: number): Point | null {
    const c = Math.floor(px / CELL);
    const r = Math.floor(py / CELL);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return null;
    return this.portrait ? { x: r, y: c } : { x: c, y: r };
  }

  /**
   * p0(出る点)から p3(入る点)への接続線(3 次ベジェ)。流れの向きに
   * ノードの辺から直角に出て、相手の反対側の辺へ直角に入る S 字になる。
   */
  private curveBetween(p0: Point, p3: Point): Curve {
    const minBend = CELL * 0.7;
    const d = this.dir;
    const span = Math.abs(d.x ? p3.x - p0.x : p3.y - p0.y);
    const k = Math.max(span * 0.5, minBend);
    return [p0, { x: p0.x + d.x * k, y: p0.y + d.y * k }, { x: p3.x - d.x * k, y: p3.y - d.y * k }, p3];
  }

  /** ノード a からノード b への線 */
  private curve(a: Point, b: Point): Curve {
    const half = CELL * 0.43;
    const d = this.dir;
    return this.curveBetween({ x: a.x + d.x * half, y: a.y + d.y * half }, { x: b.x - d.x * half, y: b.y - d.y * half });
  }

  // ---------------------------------------------------------------- 盤面

  private relayout(width: number, height: number): void {
    // 画面の真ん中に見えていたワールドの点を、サイズが変わっても真ん中に保つ
    const keep = this.lastW ? this.world.toLocal({ x: this.lastW / 2, y: this.lastH / 2 }) : null;
    const wasPortrait = this.portrait;
    this.lastW = width;
    this.lastH = height;
    this.portrait = height > width * 1.1;
    this.app.stage.hitArea = this.app.screen;

    const g = this.gridG.clear();
    const s = CELL;
    g.rect(0, 0, this.cols * s, this.rows * s).fill(COLORS.cell);
    for (let c = 0; c <= this.cols; c++) g.moveTo(c * s, 0).lineTo(c * s, this.rows * s);
    for (let r = 0; r <= this.rows; r++) g.moveTo(0, r * s).lineTo(this.cols * s, r * s);
    g.stroke({ width: 1, color: COLORS.cellLine });
    // 8 マスごとに少し濃い線を引いて、広い盤面でも位置をつかみやすくする
    for (let c = 0; c <= this.cols; c += 8) g.moveTo(c * s, 0).lineTo(c * s, this.rows * s);
    for (let r = 0; r <= this.rows; r += 8) g.moveTo(0, r * s).lineTo(this.cols * s, r * s);
    g.stroke({ width: 2, color: COLORS.cellLineMajor });

    this.builtLayoutVersion = -1;
    if (this.portrait !== wasPortrait || !keep) {
      // 向きが変わったら盤面の並びが変わるので、ノードに合わせ直す
      this.fittedSim = null;
    } else {
      this.zoom = clamp(this.zoom, this.minZoom, MAX_ZOOM);
      this.world.scale.set(this.zoom);
      this.world.position.set(width / 2 - keep.x * this.zoom, height / 2 - keep.y * this.zoom);
      this.clampPan();
    }
  }

  private rebuildNodes(sim: Simulation): void {
    for (const v of this.nodeViews.values()) v.container.destroy({ children: true });
    this.nodeViews.clear();
    for (const t of this.edgeLabels.values()) t.destroy();
    this.edgeLabels.clear();

    const size = CELL * 0.86;
    const text = (fontSize: number, fill: number, bold = false) => {
      const t = new Text({
        text: '',
        style: { fontFamily: FONT, fontSize, fontWeight: bold ? '700' : '400', fill },
        resolution: TEXT_RESOLUTION,
      });
      t.anchor.set(0.5);
      return t;
    };
    for (const node of sim.nodes.values()) {
      const container = new Container();
      const body = new Graphics();
      const bar = new Graphics();
      const label = text(Math.round(CELL * 0.19), COLORS.text, true);
      label.text = nodeName(sim, node);
      const stats = text(Math.round(CELL * 0.165), COLORS.muted);
      if (label.width > size * 0.92) label.scale.set((size * 0.92) / label.width);
      const meters = metersOf(node, sim).length;
      label.y = meters ? -size * 0.31 : -size * 0.14;
      stats.y = meters ? -size * 0.09 : size * 0.14;
      container.addChild(body, label, stats, bar);

      const captions: Text[] = [];
      for (let i = 0; i < meters; i++) {
        const t = text(Math.round(CELL * 0.12), COLORS.muted);
        t.anchor.set(0, 0.5);
        container.addChild(t);
        captions.push(t);
      }
      this.nodeLayer.addChild(container);
      this.nodeViews.set(node.id, { container, body, label, stats, bar, captions });

      for (const to of node.out) {
        const t = new Text({
          text: '',
          style: {
            fontFamily: FONT,
            fontSize: Math.round(CELL * 0.14),
            fill: COLORS.muted,
            stroke: { color: COLORS.cell, width: 3 },
          },
          resolution: TEXT_RESOLUTION,
        });
        t.anchor.set(0.5);
        this.edgeLabelLayer.addChild(t);
        this.edgeLabels.set(`${node.id}>${to}`, t);
      }
    }
    this.builtSim = sim;
    this.builtLayoutVersion = sim.layoutVersion;
    this.lastStatsAt = 0;
  }

  private updateNode(node: NodeRuntime, sim: Simulation, view: ViewState, refreshStats: boolean, detail: boolean): void {
    const v = this.nodeViews.get(node.id);
    if (!v) return;
    const size = CELL * 0.86;
    const half = size / 2;
    const g = this.gesture;
    const dragging = g?.kind === 'move' && g.nodeId === node.id;
    const wiringFrom = g?.kind === 'wire' && g.from === node.id;
    const pos = this.positionOf(node);
    v.container.position.set(pos.x, pos.y);
    v.container.zIndex = dragging ? 10 : 0;
    v.container.alpha = dragging ? 0.85 : 1;

    let stroke: number = node.def.color;
    let strokeWidth = Math.max(2.5, CELL * 0.04);
    if (sim.time - node.lastErrorAt < ERROR_FLASH_MS) stroke = COLORS.error;
    if (view.connectFrom === node.id || wiringFrom) {
      stroke = COLORS.connectFrom;
      strokeWidth *= 1.8;
    } else if (view.selectedId === node.id || dragging) {
      stroke = COLORS.selected;
      strokeWidth *= 1.8;
    }
    // 画面上で細くなりすぎないように、縮小しているときは線を太くする
    strokeWidth = Math.max(strokeWidth, 1.5 / this.zoom);
    v.body
      .clear()
      .roundRect(-half, -half, size, size, size * 0.16)
      .fill({ color: node.def.color, alpha: 0.18 })
      .stroke({ width: strokeWidth, color: stroke });
    // 出力端子: ここからドラッグして接続先へ線を引く
    if (node.def.maxOut > 0) {
      const d = this.dir;
      const r = CELL * PORT_RADIUS;
      const full = node.out.length >= node.def.maxOut;
      v.body
        .circle(d.x * CELL * 0.43, d.y * CELL * 0.43, r)
        .fill(wiringFrom ? COLORS.connectFrom : full ? COLORS.muted : node.def.color)
        .stroke({ width: Math.max(2, 1.5 / this.zoom), color: COLORS.bg });
    }

    for (const c of v.captions) c.visible = detail;
    if (!refreshStats) return;

    // 受信量 / 上限(rps)
    const inRps = sim.inRpsOf(node);
    const cap = sim.capacityRpsOf(node);
    const unit = detail ? ' rps' : '';
    if (Number.isFinite(cap)) {
      const ratio = cap > 0 ? inRps / cap : 0;
      v.stats.text = `${compact(inRps)}/${compact(cap)}${unit}`;
      v.stats.style.fill = ratio >= 0.9 ? COLORS.error : ratio >= 0.7 ? COLORS.warn : COLORS.text;
    } else {
      // インターネット: 送り出している量
      v.stats.text = `${compact(inRps)}${unit || '/s'}`;
      v.stats.style.fill = COLORS.muted;
    }
    // 桁が増えても枠からはみ出さないように縮める
    v.stats.scale.set(1);
    if (v.stats.width > size * 0.92) v.stats.scale.set((size * 0.92) / v.stats.width);

    // メーター(拡大しているときは見出し付き)
    const meters = metersOf(node, sim);
    const bar = v.bar.clear();
    const h = CELL * 0.07;
    const gap = CELL * 0.05;
    const captionW = detail && v.captions.length ? size * 0.32 : 0;
    const w = size * 0.78 - captionW;
    const x = -size * 0.39 + captionW;
    meters.forEach((m, i) => {
      const y = size * 0.1 + i * (h + gap);
      bar.rect(x, y, w, h).fill(COLORS.gaugeBg);
      if (m.ratio > 0) bar.rect(x, y, w * Math.min(1, m.ratio), h).fill(m.color ?? loadColor(m.ratio));
      const caption = v.captions[i];
      if (caption) {
        caption.text = m.caption;
        caption.position.set(-size * 0.4, y + h / 2);
      }
    });
  }

  private drawDropTarget(sim: Simulation): void {
    const g = this.dropG.clear();
    const gesture = this.gesture;
    if (gesture?.kind !== 'move') return;
    const cell = this.toCell(gesture.x, gesture.y);
    if (!cell) return;
    const occupant = sim.nodeAt(cell.x, cell.y);
    const ok = !occupant || occupant.id === gesture.nodeId;
    const c = this.center(cell.x, cell.y);
    const size = CELL * 0.9;
    g.roundRect(c.x - size / 2, c.y - size / 2, size, size, size * 0.16)
      .fill({ color: ok ? COLORS.ok : COLORS.error, alpha: 0.12 })
      .stroke({ width: 2, color: ok ? COLORS.ok : COLORS.error, alpha: 0.8 });
  }

  /** 線と、終点の向きに合わせた矢印を描く */
  private arrow(g: Graphics, curve: Curve, color: number, width: number, alpha = 0.9): void {
    const [p0, c1, c2, p3] = curve;
    const head = Math.max(CELL * 0.15, 7 / this.zoom);
    // 終点での向き(最後の制御点 → 終点)
    let dx = p3.x - c2.x;
    let dy = p3.y - c2.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // 矢印の分だけ手前で線を止める
    const tip = { x: p3.x - dx * head * 0.7, y: p3.y - dy * head * 0.7 };
    g.moveTo(p0.x, p0.y).bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tip.x, tip.y).stroke({ width, color, alpha });
    const nx = -dy;
    const ny = dx;
    g.poly([
      p3.x,
      p3.y,
      p3.x - dx * head + nx * head * 0.55,
      p3.y - dy * head + ny * head * 0.55,
      p3.x - dx * head - nx * head * 0.55,
      p3.y - dy * head - ny * head * 0.55,
    ]).fill({ color, alpha });
  }

  private drawEdges(sim: Simulation, view: ViewState): void {
    const g = this.edgeG.clear();
    const width = Math.max(CELL * 0.045, 1.5 / this.zoom);
    for (const from of sim.nodes.values()) {
      for (const toId of from.out) {
        const to = sim.nodes.get(toId);
        if (!to) continue;
        const curve = this.curve(this.positionOf(from), this.positionOf(to));
        this.placeEdgeLabel(sim, from.id, toId, curve);
        const active = view.connectFrom === from.id || view.selectedId === from.id || view.selectedId === to.id;
        this.arrow(g, curve, active ? COLORS.edgeActive : COLORS.edge, width);
      }
    }
  }

  /**
   * 配線中の線。出力端子から指の位置まで矢印が追従し、
   * つなげる相手の上では吸い付いて色で可否を示す(緑: つなぐ / 黄: 解除 / 赤: つなげない)
   */
  private drawWire(sim: Simulation): void {
    const g = this.wireG.clear();
    const w = this.gesture;
    if (w?.kind !== 'wire') return;
    const from = sim.nodes.get(w.from);
    if (!from) return;
    const target = this.nodeAtPoint(w);
    let end: Point = { x: w.x, y: w.y };
    let color: number = COLORS.connectFrom;
    if (target && target.id !== from.id) {
      const p = this.positionOf(target);
      const d = this.dir;
      end = { x: p.x - d.x * CELL * 0.43, y: p.y - d.y * CELL * 0.43 };
      color = sim.hasEdge(from.id, target.id) ? COLORS.warn : sim.connectError(from.id, target.id) ? COLORS.error : COLORS.ok;
      const size = CELL * 0.96;
      g.roundRect(p.x - size / 2, p.y - size / 2, size, size, size * 0.16).stroke({
        width: Math.max(3, 2 / this.zoom),
        color,
        alpha: 0.9,
      });
    }
    this.arrow(g, this.curveBetween(this.portOf(from), end), color, Math.max(CELL * 0.055, 2 / this.zoom), 1);
  }

  /** 接続線の真ん中に、その線を通っている量(rps)を出す */
  private placeEdgeLabel(sim: Simulation, from: number, to: number, curve: Curve): void {
    const label = this.edgeLabels.get(`${from}>${to}`);
    if (!label) return;
    const rps = sim.edgeRpsOf(from, to);
    label.visible = this.screenCell >= EDGE_LABEL_CELL && rps >= 0.5;
    if (!label.visible) return;
    const mid = bezier(curve, 0.5);
    label.position.set(mid.x, mid.y);
    if (this.statsRefreshedThisFrame) label.text = compact(rps);
  }

  private drawPackets(sim: Simulation): void {
    const transits = sim.transits;
    const stride = Math.max(1, Math.ceil(transits.length / MAX_PACKET_SPRITES));
    // 縮小しても点が見えるよう、画面上で 2.5px は確保する
    const scale = Math.max((CELL * 0.085) / 8, 2.5 / 8 / this.zoom);
    let used = 0;

    for (let i = 0; i < transits.length; i += stride) {
      const t = transits[i];
      const from = sim.nodes.get(t.from);
      const to = sim.nodes.get(t.to);
      if (!from || !to) continue;
      const p = Math.min(1, Math.max(0, (sim.time - t.start) / (t.end - t.start)));
      const pos = bezier(this.curve(this.positionOf(from), this.positionOf(to)), p);

      let sprite = this.sprites[used];
      if (!sprite) {
        sprite = new Sprite(this.packetTexture);
        sprite.anchor.set(0.5);
        this.packetLayer.addChild(sprite);
        this.sprites.push(sprite);
      }
      sprite.visible = true;
      sprite.scale.set(scale);
      sprite.tint = COLORS.packet[t.req.kind];
      sprite.position.set(pos.x, pos.y);
      used++;
    }
    for (let i = used; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
