import { Application, Container, Graphics, Text, type FederatedPointerEvent } from 'pixi.js';
import { DRIVES, MODEL_BY_ID } from '../sim/catalog';
import { lbGroups } from '../sim/flow';
import { RACK, ROW } from '../sim/config';
import type { Device } from '../sim/facility';
import type { Simulation } from '../sim/simulation';
import { compact, money, rolesText } from '../ui/format';
import { RACK_W, RAIL, ROW_H, TOP, U_H, deviceRect, rackRect, slotAt, unitAt, unitTop, type Point, type Rect } from './geometry';

/** タップされたもの */
export type Target =
  { kind: 'device'; id: number } | { kind: 'vm'; id: number } | { kind: 'unit'; slot: number; u: number } | { kind: 'slot'; slot: number } | { kind: 'none' };

export interface ViewState {
  selected: Target | null;
  /** チュートリアルで目立たせる機器と U(点滅する枠) */
  highlight?: { devices?: number[]; units?: { slot: number; u: number }[] } | null;
}

const COLORS = {
  bg: 0x0b0f14,
  floor: 0x151c24,
  rail: 0x2a3542,
  railEdge: 0x3a4757,
  inside: 0x0e141b,
  unitLine: 0x161e28,
  empty: 0x2a3542,
  text: 0xe8edf2,
  muted: 0x8b98a5,
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  bad: 0xff4d4f,
  accent: 0x4aa3ff,
  select: 0xffffff,
} as const;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const DRAG_THRESHOLD = 8;
const STATS_INTERVAL_MS = 250;
const MAX_ZOOM = 4;
const TEXT_RESOLUTION = 3;

const loadColor = (r: number) => (r >= 0.9 ? COLORS.bad : r >= 0.7 ? COLORS.warn : COLORS.ok);

type Gesture =
  | {
      kind: 'pending';
      sx: number;
      sy: number;
      world: Point;
      moveId: number | null;
      grabU: number;
    }
  | { kind: 'move'; id: number; grabU: number; x: number; y: number }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'pinch'; dist: number; mid: Point };

/**
 * 列の立面図(ラックの前面)。機器の設置と移動をする。配線は自動(sim/wiring.ts)なので描かない。
 * カメラ(拡大率と位置)で、列全体からラックの U まで見る範囲を変えられる。
 */
export class RowRenderer {
  readonly app = new Application();
  onTap: ((t: Target) => void) | null = null;
  onDeviceMove: ((id: number, slot: number, u: number) => void) | null = null;

  private readonly world = new Container();
  private readonly staticG = new Graphics();
  private readonly labels = new Container();
  private readonly dynamicG = new Graphics();
  private readonly overlayG = new Graphics();
  private readonly overlayText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 12, fill: COLORS.text, stroke: { color: COLORS.bg, width: 4 } },
    resolution: TEXT_RESOLUTION,
  });
  /** ラックごとの見出し(電力など。数値は定期的に更新) */
  private readonly rackTexts = new Map<number, Text>();

  private sim: Simulation | null = null;
  private builtKey = '';
  private fitted: Simulation | null = null;
  private zoom = 1;
  private lastW = 0;
  private lastH = 0;
  private lastStatsAt = 0;
  private gesture: Gesture | null = null;
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
    new ResizeObserver(() => this.app.queueResize()).observe(host);

    this.overlayText.anchor.set(0, 1);
    this.world.addChild(this.staticG, this.dynamicG, this.labels, this.overlayG, this.overlayText);
    this.app.stage.addChild(this.world);

    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e) => this.handleDown(e));
    stage.on('globalpointermove', (e) => this.handleMove(e));
    stage.on('pointerup', (e) => this.handleUp(e));
    stage.on('pointerupoutside', (e) => this.handleUp(e));
    // OS に横取りされた指(pointercancel)は、離したのと同じように片付ける
    this.app.canvas.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.gesture = null;
      else if (this.gesture?.kind === 'pinch') {
        const rest = [...this.pointers.values()][0];
        this.gesture = { kind: 'pan', lastX: rest.x, lastY: rest.y };
      }
    });
    this.app.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.app.canvas.getBoundingClientRect();
        this.zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  draw(sim: Simulation, view: ViewState): void {
    this.sim = sim;
    const { width, height } = this.app.screen;
    if (width !== this.lastW || height !== this.lastH) this.relayout(width, height);
    const key = `${sim.layoutVersion}|${sim.rackPowerW}|${sim.facility.racks.size}|${sim.podVersion}`;
    if (key !== this.builtKey || this.labels.children.length === 0) this.rebuild(sim, key);
    if (this.fitted !== sim) this.fit();

    const now = performance.now();
    const refresh = now - this.lastStatsAt >= STATS_INTERVAL_MS;
    if (refresh) {
      this.lastStatsAt = now;
      this.updateRackTexts(sim);
    }
    this.drawDynamic(sim);
    this.drawOverlay(sim, view);
  }

  // ---------------------------------------------------------------- カメラ

  /**
   * カメラで動ける横の範囲。借りているラックと、その隣の空き区画 2 つまで
   * (20 区画すべてを入れると、縮小したときにラックが点になり、拡大すると空き区画しか見えなくなる)
   */
  private get spanX(): { x: number; w: number } {
    const slots = this.sim ? [...this.sim.facility.racks.keys()] : [];
    const lo = Math.max(0, Math.min(...slots, 0) - 1);
    const hi = Math.min(ROW.maxRacks - 1, Math.max(...slots, 0) + 2);
    const x = rackRect(lo).x - 40;
    return { x, w: rackRect(hi).x + rackRect(hi).w + 40 - x };
  }

  private get minZoom(): number {
    const { width, height } = this.app.screen;
    return Math.min(width / this.spanX.w, height / (ROW_H + 80)) * 0.95;
  }

  /**
   * 借りているラックの、機器が入っているあたりに合わせる。
   * ラック全体(42U)を入れると文字が読めないほど小さくなるので、使っている U の前後を中心に見せる
   */
  fit(): void {
    const sim = this.sim;
    if (!sim) return;
    this.fitted = sim;
    const { width, height } = this.app.screen;
    if (!width || !height) return;
    const slots = [...sim.facility.racks.keys()];
    const lo = Math.min(...slots, 0);
    // 狭い画面ではラック 1 本だけに合わせる(並べると小さすぎて読めない)
    const hi = width < 640 ? lo : Math.max(...slots, 0);
    let top: number = RACK.units;
    let bottom = 1;
    let any = false;
    for (const d of sim.facility.devices.values()) {
      const h = MODEL_BY_ID[d.model].u;
      if (!any) {
        top = d.u + h - 1;
        bottom = d.u;
        any = true;
      }
      top = Math.max(top, d.u + h - 1);
      bottom = Math.min(bottom, d.u);
    }
    // 下に 8U ほど空きを見せて、少なくとも 16U 分の高さにする
    bottom = Math.max(1, Math.min(bottom - 8, top - 16));
    const a = rackRect(lo);
    const b = rackRect(hi);
    const y0 = TOP - 108;
    const y1 = unitTop(bottom) + U_H;
    const box = { x: a.x - 24, y: y0, w: b.x + b.w - a.x + 48, h: y1 - y0 + 16 };
    this.zoom = clamp(Math.min(width / box.w, height / box.h), this.minZoom, 1.8);
    this.world.scale.set(this.zoom);
    this.world.position.set(width / 2 - (box.x + box.w / 2) * this.zoom, height / 2 - (box.y + box.h / 2) * this.zoom);
    this.clampPan();
  }

  zoomBy(factor: number): void {
    const { width, height } = this.app.screen;
    this.zoomAt({ x: width / 2, y: height / 2 }, factor);
  }

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

  /** 列が画面の外へ行きすぎないようにする(端から少しはみ出すのは許す) */
  private clampPan(): void {
    const { width, height } = this.app.screen;
    const slack = 0.15;
    const fit = (pos: number, min: number, size: number, screen: number) => {
      const s = size * this.zoom;
      const left = pos + min * this.zoom;
      const lo = Math.min(0, screen - s) - screen * slack;
      const hi = Math.max(0, screen - s) + screen * slack;
      return clamp(left, lo, hi) - min * this.zoom;
    };
    this.world.position.set(fit(this.world.x, this.spanX.x, this.spanX.w, width), fit(this.world.y, TOP - 120, ROW_H - TOP + 160, height));
  }

  private relayout(width: number, height: number): void {
    const keep = this.lastW ? this.world.toLocal({ x: this.lastW / 2, y: this.lastH / 2 }) : null;
    this.lastW = width;
    this.lastH = height;
    this.app.stage.hitArea = this.app.screen;
    if (keep) {
      this.zoom = clamp(this.zoom, this.minZoom, MAX_ZOOM);
      this.world.scale.set(this.zoom);
      this.world.position.set(width / 2 - keep.x * this.zoom, height / 2 - keep.y * this.zoom);
      this.clampPan();
    }
  }

  // ---------------------------------------------------------------- 入力

  private handleDown(e: FederatedPointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
    if (this.pointers.size >= 2) {
      this.gesture = this.pinch();
      return;
    }
    const p = this.world.toLocal(e.global);
    const f = this.sim?.facility;
    let moveId: number | null = null;
    let grabU = 0;
    if (f) {
      const d = this.deviceAtPoint(p);
      if (d && !this.sim!.isMainLine(d.id)) {
        moveId = d.id;
        grabU = (unitAt(p.y) ?? d.u) - d.u;
      }
    }
    this.gesture = { kind: 'pending', sx: e.global.x, sy: e.global.y, world: p, moveId, grabU };
  }

  private handleMove(e: FederatedPointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      // 指が 2 本そろっている間だけ拡大・縮小する(1 本離した直後に距離 0 で計算すると、一気に最小まで縮んでしまう)
      if (this.pointers.size < 2) return;
      const next = this.pinch();
      if (next.kind !== 'pinch' || g.dist <= 0 || next.dist <= 0) return;
      // 1 回の動きで極端に変わらないよう抑える(取りこぼしたイベントで飛ばないように)
      this.zoomAt(next.mid, clamp(next.dist / g.dist, 0.5, 2));
      this.world.position.set(this.world.x + next.mid.x - g.mid.x, this.world.y + next.mid.y - g.mid.y);
      this.clampPan();
      this.gesture = next;
      return;
    }
    if (g.kind === 'pending') {
      if (Math.hypot(e.global.x - g.sx, e.global.y - g.sy) < DRAG_THRESHOLD) return;
      if (g.moveId !== null) this.gesture = { kind: 'move', id: g.moveId, grabU: g.grabU, x: g.world.x, y: g.world.y };
      else this.gesture = { kind: 'pan', lastX: g.sx, lastY: g.sy };
    }
    const cur = this.gesture!;
    if (cur.kind === 'pan') {
      this.world.position.set(this.world.x + e.global.x - cur.lastX, this.world.y + e.global.y - cur.lastY);
      this.clampPan();
      cur.lastX = e.global.x;
      cur.lastY = e.global.y;
    } else if (cur.kind === 'move') {
      const p = this.world.toLocal(e.global);
      cur.x = p.x;
      cur.y = p.y;
    }
  }

  private handleUp(e: FederatedPointerEvent): void {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (g?.kind === 'pinch') {
      // 1 本残っていれば、その指でそのまま動かせるようにする
      const rest = [...this.pointers.values()][0];
      this.gesture = rest ? { kind: 'pan', lastX: rest.x, lastY: rest.y } : null;
      return;
    }
    this.gesture = null;
    if (!g || !this.sim) return;
    if (g.kind === 'move') {
      const drop = this.dropTarget(g);
      if (drop) this.onDeviceMove?.(g.id, drop.slot, drop.u);
    } else if (g.kind === 'pending') {
      this.onTap?.(this.targetAt(g.world));
    }
  }

  private pinch(): Gesture {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { kind: 'pinch', dist: 0, mid: { x: 0, y: 0 } };
    return { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private deviceAtPoint(p: Point): Device | undefined {
    const slot = slotAt(p.x);
    const u = unitAt(p.y);
    if (slot === null || u === null || !this.sim) return undefined;
    return this.sim.facility.deviceAt(slot, u);
  }

  private targetAt(p: Point): Target {
    const sim = this.sim!;
    const f = sim.facility;
    const slot = slotAt(p.x);
    if (slot === null) return { kind: 'none' };
    if (!f.isRented(slot)) {
      const r = rackRect(slot);
      return p.y >= TOP - 60 && p.y <= r.y + r.h ? { kind: 'slot', slot } : { kind: 'none' };
    }
    const u = unitAt(p.y);
    if (u === null) return { kind: 'none' };
    const d = f.deviceAt(slot, u);
    return d ? { kind: 'device', id: d.id } : { kind: 'unit', slot, u };
  }

  /** 移動中の機器を落とす先(一番下の U)。ラックの外なら null */
  private dropTarget(g: { id: number; grabU: number; x: number; y: number }): { slot: number; u: number } | null {
    const slot = slotAt(g.x);
    const u = unitAt(g.y);
    if (slot === null || u === null) return null;
    return { slot, u: u - g.grabU };
  }

  // ---------------------------------------------------------------- 静的な部分(配置が変わったときだけ描く)

  private rebuild(sim: Simulation, key: string): void {
    this.builtKey = key;
    const g = this.staticG.clear();
    for (const c of this.labels.removeChildren()) c.destroy();
    this.rackTexts.clear();
    const f = sim.facility;

    // 床
    g.rect(-40, TOP + RACK.units * U_H, ROW_W_WITH_MARGIN, 24).fill(COLORS.floor);

    for (let slot = 0; slot < ROW.maxRacks; slot++) {
      const r = rackRect(slot);
      if (!f.isRented(slot)) {
        dashedRect(g, r, COLORS.empty);
        this.label(`区画 ${slot + 1}`, r.x + r.w / 2, r.y + r.h / 2 - 14, 13, COLORS.muted, 0.5);
        this.label(`+ 借りる ${money(sim.rackPrice())}`, r.x + r.w / 2, r.y + r.h / 2 + 8, 13, COLORS.accent, 0.5);
        continue;
      }
      // 柱と内側
      g.rect(r.x, r.y, r.w, r.h).fill(COLORS.rail);
      g.rect(r.x + RAIL, r.y, RACK_W, r.h).fill(COLORS.inside);
      for (let u = 1; u <= RACK.units; u++) {
        const y = unitTop(u);
        g.moveTo(r.x + RAIL, y).lineTo(r.x + RAIL + RACK_W, y);
        if (u % 5 === 0 || u === 1) this.label(String(u), r.x + RAIL / 2, y + U_H / 2, 8, COLORS.muted, 0.5, true);
      }
      g.stroke({ width: 1, color: COLORS.unitLine });
      g.rect(r.x, r.y, r.w, r.h).stroke({ width: 2, color: COLORS.railEdge });
      // 見出し(数値は updateRackTexts で入れる)
      this.label(`ラック ${slot + 1}`, r.x, TOP - 96, 15, COLORS.text, 0, false, true);
      const t = this.label('', r.x + r.w, TOP - 96, 11, COLORS.muted, 1);
      this.rackTexts.set(slot, t);
    }

    for (const d of f.devices.values()) {
      const m = MODEL_BY_ID[d.model];
      const r = deviceRect(d);
      g.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 3)
        .fill({ color: m.color, alpha: 0.22 })
        .stroke({ width: 1.5, color: m.color });
      this.label(d.name, r.x + 8, r.y + r.h / 2, 11, COLORS.text, 0, true, true);
      // サーバはデータを置くドライブの種類も(例: 2U HDD)
      const kind = d.parts?.gpus ? 'GPU' : d.parts?.drives.length ? DRIVES[d.parts.drives[d.parts.drives.length - 1]].name : d.parts ? 'SSD' : '';
      const short = d.hv ? `${m.short} HV` : kind ? `${m.short} ${kind}` : m.short;
      this.label(short, r.x + 56, r.y + r.h / 2, 10, d.hv ? 0x95d5b2 : COLORS.muted, 0, true);
      if (d.hv) {
        // VM はサービスごとの台数だけ出す(例: VM 5 台 web×3・db・cache)
        const vms = f.vmsOn(d.id);
        const count = new Map<string, number>();
        for (const v of vms) {
          const key = v.k8s ? 'k8s' : v.roles.length ? rolesText(v.roles) : '役割なし';
          count.set(key, (count.get(key) ?? 0) + 1);
        }
        const parts = [...count].map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
        const text = vms.length ? `VM ${vms.length} 台: ${parts.join('・')}` : 'VM なし';
        const t = this.label(text, r.x + 108, r.y + r.h / 2, 10, 0xb7e4c7, 0, false, true);
        const maxW = r.w - 108 - 64;
        if (t.width > maxW) t.scale.set(maxW / t.width);
      } else if (m.category === 'lb') {
        // LB: HA の状態
        const gr = lbGroups(f, sim.downDevices).find((x) => x.members.includes(d.id));
        const stopped = sim.downDevices.has(d.id);
        const text = stopped ? '停止中' : !gr || gr.members.length < 2 ? 'HA なし' : gr.active === d.id ? 'HA アクティブ' : 'HA スタンバイ';
        this.label(text, r.x + 108, r.y + r.h / 2, 10, gr && gr.members.length > 1 ? 0xffd166 : COLORS.muted, 0, false, true);
      } else if (d.k8s) {
        // Kubernetes のワーカー: 置かれた Pod を役割ごとに
        const parts = sim.pods.filter((p) => p.worker === d.id).map((p) => `${rolesText([p.role])}×${p.count}`);
        const t = this.label(`k8s ${parts.join('・') || 'Pod なし'}`, r.x + 108, r.y + r.h / 2, 10, 0xc9b6ff, 0, false, true);
        const maxW = r.w - 108 - 64;
        if (t.width > maxW) t.scale.set(maxW / t.width);
      } else if (d.roles.length) {
        const t = this.label(rolesText(d.roles), r.x + 108, r.y + r.h / 2, 11, 0x9fd8ff, 0, false, true);
        const maxW = r.w - 108 - 64;
        if (t.width > maxW) t.scale.set(maxW / t.width);
      }
      // 自動配線でつながらなかった機器(スイッチのポートが足りないなど)
      if (f.unwired.has(d.id)) {
        g.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 3).stroke({ width: 2, color: COLORS.bad });
        this.label('未接続', r.x + r.w - 62, r.y + r.h / 2, 10, COLORS.bad, 1, false, true);
      }
    }
  }

  private label(text: string, x: number, y: number, size: number, fill: number, anchorX: number, mono = false, bold = false): Text {
    const t = new Text({
      text,
      style: { fontFamily: mono ? MONO : FONT, fontSize: size, fill, fontWeight: bold ? '700' : '400' },
      resolution: TEXT_RESOLUTION,
    });
    t.anchor.set(anchorX, 0.5);
    t.position.set(x, y);
    this.labels.addChild(t);
    return t;
  }

  private updateRackTexts(sim: Simulation): void {
    for (const [slot, t] of this.rackTexts) {
      const used = sim.facility.powerUsed(slot);
      t.text = `${sim.facility.unitsUsed(slot)}/${RACK.units}U  ${compact(used)}/${compact(sim.rackPowerW)}W`;
      t.style.fill = used / sim.rackPowerW >= 0.9 ? COLORS.warn : COLORS.muted;
    }
  }

  // ---------------------------------------------------------------- 動く部分(毎フレーム)

  private drawDynamic(sim: Simulation): void {
    const g = this.dynamicG.clear();
    const f = sim.facility;
    const flow = sim.flow;

    // 止まっている機器: メンテナンスは黄、障害は赤で覆う
    for (const d of f.devices.values()) {
      const failed = d.failedUntil > sim.time;
      if (!d.down && !failed) continue;
      const r = deviceRect(d);
      g.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2)
        .fill({ color: COLORS.bg, alpha: 0.55 })
        .stroke({ width: 2, color: failed ? COLORS.bad : COLORS.warn });
    }

    // ラックの電力メーター
    for (const slot of f.racks.keys()) {
      const r = rackRect(slot);
      const ratio = f.powerUsed(slot) / sim.rackPowerW;
      g.rect(r.x, TOP - 82, r.w, 5).fill(COLORS.rail);
      g.rect(r.x, TOP - 82, r.w * Math.min(1, ratio), 5).fill(loadColor(ratio));
    }

    // 負荷のメーター: サーバは CPU と IO、スイッチは処理能力
    for (const d of f.devices.values()) {
      const load = flow.devices.get(d.id);
      if (!load) continue;
      const m = MODEL_BY_ID[d.model];
      const r = deviceRect(d);
      const bars =
        m.category === 'server'
          ? load.gpu > 0 || (d.parts?.gpus ?? 0) > 0
            ? [load.cpu, load.io, load.gpu]
            : [load.cpu, load.io]
          : m.category === 'switch'
            ? [load.fabric]
            : m.category === 'storage'
              ? [load.io]
              : m.category === 'lb'
                ? [load.cpu]
                : [];
      const w = 46;
      const h = 4;
      bars.forEach((v, i) => {
        const x = r.x + r.w - w - 8;
        const y = r.y + r.h / 2 - (bars.length * (h + 2)) / 2 + i * (h + 2);
        g.rect(x, y, w, h).fill(COLORS.bg);
        if (v > 0) g.rect(x, y, w * Math.min(1, v), h).fill(loadColor(v));
      });
    }
  }

  private drawOverlay(sim: Simulation, view: ViewState): void {
    const g = this.overlayG.clear();
    this.overlayText.text = '';
    const f = sim.facility;
    const sel = view.selected;
    const stroke = { width: Math.max(2, 2 / this.zoom), color: COLORS.select };

    // チュートリアルの目印: ゆっくり点滅する太い枠
    const hl = view.highlight;
    if (hl) {
      const alpha = 0.45 + 0.45 * Math.sin(performance.now() / 260);
      const glow = { width: Math.max(3, 4 / this.zoom), color: 0xffd166, alpha };
      for (const id of hl.devices ?? []) {
        const d = f.devices.get(id);
        if (d) g.rect(...rectArgs(deviceRect(d))).stroke(glow);
      }
      for (const u of hl.units ?? []) {
        const r = rackRect(u.slot);
        g.rect(r.x + RAIL, unitTop(u.u), RACK_W, U_H).stroke(glow);
      }
    }

    if (sel?.kind === 'device') {
      const d = f.devices.get(sel.id);
      if (d) g.rect(...rectArgs(deviceRect(d))).stroke(stroke);
    } else if (sel?.kind === 'unit' && f.isRented(sel.slot)) {
      const r = rackRect(sel.slot);
      g.rect(r.x + RAIL, unitTop(sel.u), RACK_W, U_H).stroke({ ...stroke, color: COLORS.accent });
    } else if (sel?.kind === 'slot') {
      g.rect(...rectArgs(rackRect(sel.slot))).stroke({ ...stroke, color: COLORS.accent });
    }

    const gesture = this.gesture;
    if (gesture?.kind === 'move') {
      const d = f.devices.get(gesture.id);
      const drop = this.dropTarget(gesture);
      if (d && drop) {
        const err = sim.placeError(d.model, drop.slot, drop.u, d.id);
        const r = deviceRect({ model: d.model, slot: drop.slot, u: drop.u });
        g.rect(...rectArgs(r))
          .fill({ color: err ? COLORS.bad : COLORS.ok, alpha: 0.15 })
          .stroke({ width: 2, color: err ? COLORS.bad : COLORS.ok });
        this.tooltip(err ?? `${drop.u}U へ移動`, r.x, r.y - 4, err ? COLORS.bad : COLORS.text);
      }
    }
  }

  private tooltip(text: string, x: number, y: number, fill: number): void {
    this.overlayText.text = text;
    this.overlayText.style.fill = fill;
    this.overlayText.scale.set(1 / Math.max(this.zoom, 0.6));
    this.overlayText.position.set(x, y);
  }
}

/** 列全体の幅(端の余白込み) */
const ROW_W_WITH_MARGIN = rackRect(ROW.maxRacks - 1).x + rackRect(0).w + 80;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function rectArgs(r: Rect): [number, number, number, number] {
  return [r.x, r.y, r.w, r.h];
}

function dashedRect(g: Graphics, r: Rect, color: number): void {
  const dash = 10;
  const side = (x1: number, y1: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    for (let t = 0; t < len; t += dash * 2) {
      const a = t / len;
      const b = Math.min(1, (t + dash) / len);
      g.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a).lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
    }
  };
  side(r.x, r.y, r.x + r.w, r.y);
  side(r.x + r.w, r.y, r.x + r.w, r.y + r.h);
  side(r.x + r.w, r.y + r.h, r.x, r.y + r.h);
  side(r.x, r.y + r.h, r.x, r.y);
  g.stroke({ width: 2, color });
}
