import { Application, Container, Graphics, Sprite, Text, type FederatedPointerEvent, type Texture } from 'pixi.js';
import { GRID_H, GRID_W } from '../sim/config';
import type { NodeRuntime, Simulation } from '../sim/simulation';
import type { ReqKind } from '../sim/types';
import { compact } from '../ui/format';

const COLORS = {
  bg: 0x0b0f14,
  cell: 0x111821,
  cellLine: 0x1a2430,
  edge: 0x4a5a6d,
  edgeActive: 0xe8edf2,
  packet: { static: 0x4aa3ff, write: 0xff9f43 } satisfies Record<ReqKind, number>,
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
/** 描画するパケット数の上限。超えたら間引いて表示する */
const MAX_PACKET_SPRITES = 2500;
/** エラー時にノードの枠を赤くする時間(シミュレーション時間 ms) */
const ERROR_FLASH_MS = 400;
/** これ以上指が動いたらタップではなくドラッグとみなす(px) */
const DRAG_THRESHOLD = 8;
/** ノード上の数値を更新する間隔(ms) */
const STATS_INTERVAL_MS = 250;

export interface ViewState {
  selectedId: number | null;
  connectFrom: number | null;
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

/**
 * Simulation の状態を PixiJS で描画する。シミュレーションには書き込まず、
 * タップやドラッグはコールバックで呼び出し側へ渡す。
 * 縦長画面では盤面を転置し、インターネットが上に来るように表示する。
 */
export class BoardRenderer {
  readonly app = new Application();
  /** 盤面のマスがタップされたとき(シミュレーション座標) */
  onCellTap: ((x: number, y: number) => void) | null = null;
  /** ノードがドラッグで別のマスへ落とされたとき */
  onNodeMove: ((id: number, x: number, y: number) => void) | null = null;

  private readonly board = new Container();
  private readonly gridG = new Graphics();
  private readonly dropG = new Graphics();
  private readonly edgeG = new Graphics();
  private readonly packetLayer = new Container();
  private readonly nodeLayer = new Container();
  private packetTexture!: Texture;
  private readonly sprites: Sprite[] = [];
  private readonly nodeViews = new Map<number, NodeView>();

  private cell = 40;
  private portrait = false;
  private lastW = 0;
  private lastH = 0;
  private builtLayoutVersion = -1;
  private builtSim: Simulation | null = null;
  private lastStatsAt = 0;

  /** 押している間の情報(タップかドラッグかはまだ未定) */
  private press: { sx: number; sy: number; cell: Point | null; nodeId: number | null } | null = null;
  /** ドラッグ中のノードと、指の位置(盤面ローカル座標) */
  private drag: { nodeId: number; x: number; y: number } | null = null;

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
    this.board.addChild(this.gridG, this.dropG, this.edgeG, this.packetLayer, this.nodeLayer);
    this.app.stage.addChild(this.board);

    const dot = new Graphics().circle(0, 0, 8).fill(0xffffff);
    this.packetTexture = this.app.renderer.generateTexture(dot);
    dot.destroy();

    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e) => this.handleDown(e));
    stage.on('globalpointermove', (e) => this.handleMove(e));
    stage.on('pointerup', () => this.handleUp());
    stage.on('pointerupoutside', () => this.handleUp());
  }

  draw(sim: Simulation, view: ViewState): void {
    const { width, height } = this.app.screen;
    if (width !== this.lastW || height !== this.lastH) this.relayout(width, height);
    if (sim !== this.builtSim || sim.layoutVersion !== this.builtLayoutVersion) this.rebuildNodes(sim);
    if (this.drag && !sim.nodes.has(this.drag.nodeId)) this.drag = null;

    const now = performance.now();
    const refreshStats = now - this.lastStatsAt >= STATS_INTERVAL_MS;
    if (refreshStats) this.lastStatsAt = now;

    this.drawDropTarget(sim);
    this.drawEdges(sim, view);
    this.drawPackets(sim);
    for (const node of sim.nodes.values()) this.updateNode(node, sim, view, refreshStats);
  }

  // ---------------------------------------------------------------- 入力

  private handleDown(e: FederatedPointerEvent): void {
    const p = this.board.toLocal(e.global);
    const cell = this.toCell(p.x, p.y);
    const node = cell && this.builtSim ? this.builtSim.nodeAt(cell.x, cell.y) : undefined;
    this.press = { sx: e.global.x, sy: e.global.y, cell, nodeId: node?.id ?? null };
  }

  private handleMove(e: FederatedPointerEvent): void {
    if (!this.press) return;
    if (!this.drag) {
      if (this.press.nodeId === null) return;
      if (Math.hypot(e.global.x - this.press.sx, e.global.y - this.press.sy) < DRAG_THRESHOLD) return;
      this.drag = { nodeId: this.press.nodeId, x: 0, y: 0 };
    }
    const p = this.board.toLocal(e.global);
    this.drag.x = p.x;
    this.drag.y = p.y;
  }

  private handleUp(): void {
    if (this.drag) {
      const cell = this.toCell(this.drag.x, this.drag.y);
      const id = this.drag.nodeId;
      this.drag = null;
      if (cell) this.onNodeMove?.(id, cell.x, cell.y);
    } else if (this.press?.cell) {
      this.onCellTap?.(this.press.cell.x, this.press.cell.y);
    }
    this.press = null;
  }

  // ---------------------------------------------------------------- 座標変換

  private get cols(): number {
    return this.portrait ? GRID_H : GRID_W;
  }

  private get rows(): number {
    return this.portrait ? GRID_W : GRID_H;
  }

  /** シミュレーション座標 → 盤面ローカル座標(マスの中心) */
  private center(x: number, y: number): Point {
    const [c, r] = this.portrait ? [y, x] : [x, y];
    return { x: (c + 0.5) * this.cell, y: (r + 0.5) * this.cell };
  }

  /** ノードの表示位置。ドラッグ中は指に追従する */
  private positionOf(node: NodeRuntime): Point {
    if (this.drag?.nodeId === node.id) return { x: this.drag.x, y: this.drag.y };
    return this.center(node.x, node.y);
  }

  private toCell(px: number, py: number): Point | null {
    const c = Math.floor(px / this.cell);
    const r = Math.floor(py / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return null;
    return this.portrait ? { x: r, y: c } : { x: c, y: r };
  }

  /**
   * a から b への接続線(3 次ベジェ)。流れの向き(横長なら右、縦長なら下)に
   * ノードの辺から直角に出て、相手の反対側の辺へ直角に入る S 字になる。
   */
  private curve(a: Point, b: Point): Curve {
    const half = this.cell * 0.42;
    const minBend = this.cell * 0.7;
    if (this.portrait) {
      const p0 = { x: a.x, y: a.y + half };
      const p3 = { x: b.x, y: b.y - half };
      const d = Math.max(Math.abs(p3.y - p0.y) * 0.5, minBend);
      return [p0, { x: p0.x, y: p0.y + d }, { x: p3.x, y: p3.y - d }, p3];
    }
    const p0 = { x: a.x + half, y: a.y };
    const p3 = { x: b.x - half, y: b.y };
    const d = Math.max(Math.abs(p3.x - p0.x) * 0.5, minBend);
    return [p0, { x: p0.x + d, y: p0.y }, { x: p3.x - d, y: p3.y }, p3];
  }

  // ---------------------------------------------------------------- 盤面

  private relayout(width: number, height: number): void {
    this.lastW = width;
    this.lastH = height;
    this.portrait = height > width * 1.1;
    const pad = 8;
    this.cell = Math.max(16, Math.floor(Math.min((width - pad * 2) / this.cols, (height - pad * 2) / this.rows)));
    this.board.position.set(
      Math.round((width - this.cols * this.cell) / 2),
      Math.round((height - this.rows * this.cell) / 2),
    );
    this.app.stage.hitArea = this.app.screen;

    const g = this.gridG.clear();
    const s = this.cell;
    g.rect(0, 0, this.cols * s, this.rows * s).fill(COLORS.cell);
    for (let c = 0; c <= this.cols; c++) g.moveTo(c * s, 0).lineTo(c * s, this.rows * s);
    for (let r = 0; r <= this.rows; r++) g.moveTo(0, r * s).lineTo(this.cols * s, r * s);
    g.stroke({ width: 1, color: COLORS.cellLine });

    this.builtLayoutVersion = -1;
  }

  private rebuildNodes(sim: Simulation): void {
    for (const v of this.nodeViews.values()) v.container.destroy({ children: true });
    this.nodeViews.clear();

    const size = this.cell * 0.84;
    for (const node of sim.nodes.values()) {
      const container = new Container();
      const body = new Graphics();
      const bar = new Graphics();
      const label = new Text({
        text: node.def.label,
        style: { fontFamily: FONT, fontSize: Math.max(8, Math.round(this.cell * 0.2)), fontWeight: '700', fill: COLORS.text },
      });
      const stats = new Text({
        text: '',
        style: { fontFamily: FONT, fontSize: Math.max(8, Math.round(this.cell * 0.19)), fill: COLORS.muted },
      });
      label.anchor.set(0.5);
      stats.anchor.set(0.5);
      const hasBar = Number.isFinite(sim.capacityRpsOf(node));
      label.y = hasBar ? -size * 0.24 : -size * 0.13;
      stats.y = hasBar ? size * 0.04 : size * 0.17;
      container.addChild(body, label, stats, bar);
      this.nodeLayer.addChild(container);
      this.nodeViews.set(node.id, { container, body, label, stats, bar });
    }
    this.builtSim = sim;
    this.builtLayoutVersion = sim.layoutVersion;
    this.lastStatsAt = 0;
  }

  private updateNode(node: NodeRuntime, sim: Simulation, view: ViewState, refreshStats: boolean): void {
    const v = this.nodeViews.get(node.id);
    if (!v) return;
    const size = this.cell * 0.84;
    const half = size / 2;
    const dragging = this.drag?.nodeId === node.id;
    const pos = this.positionOf(node);
    v.container.position.set(pos.x, pos.y);
    v.container.zIndex = dragging ? 10 : 0;
    v.container.alpha = dragging ? 0.85 : 1;

    let stroke: number = node.def.color;
    let strokeWidth = Math.max(1.5, this.cell * 0.04);
    if (sim.time - node.lastErrorAt < ERROR_FLASH_MS) stroke = COLORS.error;
    if (view.connectFrom === node.id) {
      stroke = COLORS.connectFrom;
      strokeWidth *= 1.8;
    } else if (view.selectedId === node.id || dragging) {
      stroke = COLORS.selected;
      strokeWidth *= 1.8;
    }
    v.body
      .clear()
      .roundRect(-half, -half, size, size, size * 0.16)
      .fill({ color: node.def.color, alpha: 0.18 })
      .stroke({ width: strokeWidth, color: stroke });

    if (!refreshStats) return;

    // 受信量 / 上限 と負荷バー
    const inRps = sim.inRpsOf(node);
    const cap = sim.capacityRpsOf(node);
    const bar = v.bar.clear();
    if (Number.isFinite(cap)) {
      const ratio = cap > 0 ? inRps / cap : 0;
      v.stats.text = `${compact(inRps)}/${compact(cap)}`;
      v.stats.style.fill = ratio >= 0.9 ? COLORS.error : ratio >= 0.7 ? COLORS.warn : COLORS.text;
      const w = size * 0.74;
      const h = Math.max(3, this.cell * 0.075);
      const y = size * 0.25;
      bar.rect(-w / 2, y, w, h).fill(COLORS.gaugeBg);
      if (ratio > 0) bar.rect(-w / 2, y, w * Math.min(1, ratio), h).fill(loadColor(ratio));
    } else {
      v.stats.text = `${compact(inRps)}/s`;
      v.stats.style.fill = COLORS.muted;
    }
  }

  private drawDropTarget(sim: Simulation): void {
    const g = this.dropG.clear();
    if (!this.drag) return;
    const cell = this.toCell(this.drag.x, this.drag.y);
    if (!cell) return;
    const occupant = sim.nodeAt(cell.x, cell.y);
    const ok = !occupant || occupant.id === this.drag.nodeId;
    const c = this.center(cell.x, cell.y);
    const size = this.cell * 0.9;
    g.roundRect(c.x - size / 2, c.y - size / 2, size, size, size * 0.16)
      .fill({ color: ok ? COLORS.ok : COLORS.error, alpha: 0.12 })
      .stroke({ width: 2, color: ok ? COLORS.ok : COLORS.error, alpha: 0.8 });
  }

  private drawEdges(sim: Simulation, view: ViewState): void {
    const g = this.edgeG.clear();
    const head = Math.max(5, this.cell * 0.15);
    const width = Math.max(1.5, this.cell * 0.045);
    const dir = this.portrait ? { x: 0, y: 1 } : { x: 1, y: 0 };

    for (const from of sim.nodes.values()) {
      for (const toId of from.out) {
        const to = sim.nodes.get(toId);
        if (!to) continue;
        const [p0, c1, c2, p3] = this.curve(this.positionOf(from), this.positionOf(to));
        const active =
          view.connectFrom === from.id || view.selectedId === from.id || view.selectedId === to.id;
        const color = active ? COLORS.edgeActive : COLORS.edge;

        // 矢印の分だけ手前で線を止める
        const tip = { x: p3.x - dir.x * head * 0.7, y: p3.y - dir.y * head * 0.7 };
        g.moveTo(p0.x, p0.y)
          .bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tip.x, tip.y)
          .stroke({ width, color, alpha: 0.9 });

        const nx = -dir.y;
        const ny = dir.x;
        g.poly([
          p3.x,
          p3.y,
          p3.x - dir.x * head + nx * head * 0.55,
          p3.y - dir.y * head + ny * head * 0.55,
          p3.x - dir.x * head - nx * head * 0.55,
          p3.y - dir.y * head - ny * head * 0.55,
        ]).fill({ color, alpha: 0.9 });
      }
    }
  }

  private drawPackets(sim: Simulation): void {
    const transits = sim.transits;
    const stride = Math.max(1, Math.ceil(transits.length / MAX_PACKET_SPRITES));
    const scale = Math.max(0.25, (this.cell * 0.085) / 8);
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
