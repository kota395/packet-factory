import { Application, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { GRID_H, GRID_W } from '../sim/config';
import type { NodeRuntime, Simulation } from '../sim/simulation';
import type { ReqKind } from '../sim/types';

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
} as const;

/** 描画するパケット数の上限。超えたら間引いて表示する */
const MAX_PACKET_SPRITES = 2500;
/** エラー時にノードの枠を赤くする時間(シミュレーション時間 ms) */
const ERROR_FLASH_MS = 400;

export interface ViewState {
  selectedId: number | null;
  connectFrom: number | null;
}

interface NodeView {
  container: Container;
  body: Graphics;
  gauges: Graphics;
  label: Text;
}

/**
 * Simulation の状態を PixiJS で描画する。シミュレーションには一切書き込まない。
 * 縦長画面では盤面を転置し、インターネットが上に来るように表示する。
 */
export class BoardRenderer {
  readonly app = new Application();
  /** 盤面のマスがタップされたとき(シミュレーション座標) */
  onCellTap: ((x: number, y: number) => void) | null = null;

  private readonly board = new Container();
  private readonly gridG = new Graphics();
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

    this.board.addChild(this.gridG, this.edgeG, this.packetLayer, this.nodeLayer);
    this.app.stage.addChild(this.board);

    const dot = new Graphics().circle(0, 0, 8).fill(0xffffff);
    this.packetTexture = this.app.renderer.generateTexture(dot);
    dot.destroy();

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointertap', (e) => {
      const p = this.board.toLocal(e.global);
      const cell = this.toCell(p.x, p.y);
      if (cell) this.onCellTap?.(cell.x, cell.y);
    });
  }

  draw(sim: Simulation, view: ViewState): void {
    const { width, height } = this.app.screen;
    if (width !== this.lastW || height !== this.lastH) this.relayout(width, height);
    if (sim !== this.builtSim || sim.layoutVersion !== this.builtLayoutVersion) this.rebuildNodes(sim);

    this.drawEdges(sim, view);
    this.drawPackets(sim);
    for (const node of sim.nodes.values()) this.updateNode(node, sim, view);
  }

  // ---------------------------------------------------------------- 座標変換

  private get cols(): number {
    return this.portrait ? GRID_H : GRID_W;
  }

  private get rows(): number {
    return this.portrait ? GRID_W : GRID_H;
  }

  /** シミュレーション座標 → 盤面ローカル座標(マスの中心) */
  private center(x: number, y: number): { x: number; y: number } {
    const [c, r] = this.portrait ? [y, x] : [x, y];
    return { x: (c + 0.5) * this.cell, y: (r + 0.5) * this.cell };
  }

  private toCell(px: number, py: number): { x: number; y: number } | null {
    const c = Math.floor(px / this.cell);
    const r = Math.floor(py / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return null;
    return this.portrait ? { x: r, y: c } : { x: c, y: r };
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

    for (const node of sim.nodes.values()) {
      const container = new Container();
      const body = new Graphics();
      const gauges = new Graphics();
      const label = new Text({
        text: node.def.label,
        style: {
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: Math.max(9, Math.round(this.cell * 0.24)),
          fontWeight: '700',
          fill: 0xffffff,
          letterSpacing: 0.5,
        },
      });
      label.anchor.set(0.5);
      label.y = node.kind === 'internet' ? 0 : -this.cell * 0.1;
      container.addChild(body, label, gauges);
      const c = this.center(node.x, node.y);
      container.position.set(c.x, c.y);
      this.nodeLayer.addChild(container);
      this.nodeViews.set(node.id, { container, body, gauges, label });
    }
    this.builtSim = sim;
    this.builtLayoutVersion = sim.layoutVersion;
  }

  private updateNode(node: NodeRuntime, sim: Simulation, view: ViewState): void {
    const v = this.nodeViews.get(node.id);
    if (!v) return;
    const size = this.cell * 0.8;
    const half = size / 2;

    let stroke: number = node.def.color;
    let strokeWidth = Math.max(1.5, this.cell * 0.04);
    if (sim.time - node.lastErrorAt < ERROR_FLASH_MS) stroke = COLORS.error;
    if (view.connectFrom === node.id) {
      stroke = COLORS.connectFrom;
      strokeWidth *= 1.8;
    } else if (view.selectedId === node.id) {
      stroke = COLORS.selected;
      strokeWidth *= 1.8;
    }

    v.body
      .clear()
      .roundRect(-half, -half, size, size, size * 0.18)
      .fill({ color: node.def.color, alpha: 0.18 })
      .stroke({ width: strokeWidth, color: stroke });

    const g = v.gauges.clear();
    if (node.kind === 'internet') return;

    // CPU(同時処理数の使用率)とキュー長のゲージ
    const w = size * 0.72;
    const h = Math.max(3, this.cell * 0.07);
    const x = -w / 2;
    const cpu = node.busy.length / node.def.workers;
    const queue = node.queue.length / node.def.queueMax;
    const bars: [number, number, number][] = [
      [this.cell * 0.12, cpu, cpu > 0.9 ? COLORS.error : cpu > 0.7 ? COLORS.warn : COLORS.ok],
      [this.cell * 0.12 + h + 2, queue, queue > 0.6 ? COLORS.error : queue > 0.25 ? COLORS.warn : COLORS.packet.static],
    ];
    for (const [y, ratio, color] of bars) {
      g.rect(x, y, w, h).fill(COLORS.gaugeBg);
      if (ratio > 0) g.rect(x, y, w * Math.min(1, ratio), h).fill(color);
    }
  }

  private drawEdges(sim: Simulation, view: ViewState): void {
    const g = this.edgeG.clear();
    const inset = this.cell * 0.42;
    const head = Math.max(5, this.cell * 0.16);
    const width = Math.max(1.5, this.cell * 0.05);

    for (const from of sim.nodes.values()) {
      for (const toId of from.out) {
        const to = sim.nodes.get(toId);
        if (!to) continue;
        const a = this.center(from.x, from.y);
        const b = this.center(to.x, to.y);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < inset * 2) continue;
        const ux = dx / len;
        const uy = dy / len;
        const sx = a.x + ux * inset;
        const sy = a.y + uy * inset;
        const ex = b.x - ux * inset;
        const ey = b.y - uy * inset;
        const color = view.connectFrom === from.id || view.selectedId === from.id ? COLORS.edgeActive : COLORS.edge;

        g.moveTo(sx, sy).lineTo(ex - ux * head * 0.6, ey - uy * head * 0.6).stroke({ width, color, alpha: 0.9 });
        g.poly([
          ex,
          ey,
          ex - ux * head - uy * head * 0.55,
          ey - uy * head + ux * head * 0.55,
          ex - ux * head + uy * head * 0.55,
          ey - uy * head - ux * head * 0.55,
        ]).fill({ color, alpha: 0.9 });
      }
    }
  }

  private drawPackets(sim: Simulation): void {
    const transits = sim.transits;
    const stride = Math.max(1, Math.ceil(transits.length / MAX_PACKET_SPRITES));
    const scale = Math.max(0.25, (this.cell * 0.09) / 8);
    let used = 0;

    for (let i = 0; i < transits.length; i += stride) {
      const t = transits[i];
      const from = sim.nodes.get(t.from);
      const to = sim.nodes.get(t.to);
      if (!from || !to) continue;
      const a = this.center(from.x, from.y);
      const b = this.center(to.x, to.y);
      const p = Math.min(1, Math.max(0, (sim.time - t.start) / (t.end - t.start)));

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
      sprite.position.set(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p);
      used++;
    }
    for (let i = used; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }
}
