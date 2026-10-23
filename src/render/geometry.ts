/**
 * 列の立面図の座標(ワールド座標)。描画と当たり判定の両方で使う。
 * ラックは左から slot 0, 1, … と並び、U は下が 1。
 */
import { MODEL_BY_ID } from '../sim/catalog';
import { RACK, ROW } from '../sim/config';
import type { Cable, Device, Facility } from '../sim/facility';
import type { PortRef } from '../sim/types';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 1U の高さ */
export const U_H = 20;
/** ラックの内側の幅と、左右の柱(ケーブルを通す場所)の幅 */
export const RACK_W = 320;
export const RAIL = 16;
/** ラックとラックの間 */
export const GAP = 70;
/** ラックの上: 見出しとケーブルトレイの高さ */
export const TOP = 120;
/** ポートの大きさと間隔 */
export const PORT = 7;
export const PORT_GAP = 2;
/** 背面で、機器名を書くために左を空ける幅 */
export const PORT_LEFT = 60;

export const RACK_OUTER_W = RACK_W + RAIL * 2;
export const ROW_W = ROW.maxRacks * (RACK_OUTER_W + GAP) - GAP;
export const ROW_H = TOP + RACK.units * U_H + 40;

/** ラックの外枠 */
export function rackRect(slot: number): Rect {
  return { x: slot * (RACK_OUTER_W + GAP), y: TOP, w: RACK_OUTER_W, h: RACK.units * U_H };
}

/** U の上端の y */
export function unitTop(u: number): number {
  return TOP + (RACK.units - u) * U_H;
}

/** 機器の矩形(ラックの内側) */
export function deviceRect(d: Pick<Device, 'model' | 'slot' | 'u'>): Rect {
  const h = MODEL_BY_ID[d.model].u;
  const r = rackRect(d.slot);
  return { x: r.x + RAIL, y: unitTop(d.u + h - 1), w: RACK_W, h: h * U_H };
}

/** x にあるラック(柱を含む)。ラックの間なら null */
export function slotAt(x: number): number | null {
  const pitch = RACK_OUTER_W + GAP;
  const slot = Math.floor(x / pitch);
  if (slot < 0 || slot >= ROW.maxRacks) return null;
  return x - slot * pitch <= RACK_OUTER_W ? slot : null;
}

/** y にある U(1〜42)。ラックの外なら null */
export function unitAt(y: number): number | null {
  const u = RACK.units - Math.floor((y - TOP) / U_H);
  return u >= 1 && u <= RACK.units ? u : null;
}

/**
 * 機器の背面のポートの中心。グループ(1G と 10G SFP+ など)の間は少し空け、
 * 収まる段数で左から右へ並べる
 */
export function portCenters(d: Pick<Device, 'model' | 'slot' | 'u'>): Point[] {
  const r = deviceRect(d);
  const pitch = PORT + PORT_GAP;
  const rows = Math.max(1, Math.floor((r.h - 2) / pitch));
  const groups = MODEL_BY_ID[d.model].ports;
  const out: Point[] = [];
  let col = 0;
  let i = 0;
  for (const g of groups) {
    const perCol = Math.min(rows, g.count);
    for (let k = 0; k < g.count; k++, i++) {
      const c = col + Math.floor(k / perCol);
      const row = k % perCol;
      out.push({
        x: r.x + PORT_LEFT + c * pitch + PORT / 2,
        y: r.y + (r.h - perCol * pitch + PORT_GAP) / 2 + row * pitch + PORT / 2,
      });
    }
    col += Math.ceil(g.count / perCol) + 1;
  }
  return out;
}

/** ポートの中心 */
export function portCenter(f: Facility, ref: PortRef): Point | null {
  const d = f.devices.get(ref.device);
  return d ? (portCenters(d)[ref.port] ?? null) : null;
}

/** 点の近くのポート */
export function portAt(f: Facility, p: Point, radius = PORT): PortRef | null {
  const slot = slotAt(p.x);
  if (slot === null) return null;
  let best: PortRef | null = null;
  let bestD = radius;
  for (const d of f.devices.values()) {
    if (d.slot !== slot) continue;
    const r = deviceRect(d);
    if (p.y < r.y - radius || p.y > r.y + r.h + radius) continue;
    portCenters(d).forEach((c, i) => {
      const dist = Math.hypot(c.x - p.x, c.y - p.y);
      if (dist < bestD) {
        bestD = dist;
        best = { device: d.id, port: i };
      }
    });
  }
  return best;
}

/**
 * ケーブルの通り道(折れ線)。同じラックなら右の柱を通り、
 * ラック間はお互いに近い側の柱を上がってケーブルトレイを渡る。
 * lane はケーブルごとに少しずらして重なりを減らす
 */
export function cableRoute(f: Facility, cable: Pick<Cable, 'id' | 'a' | 'b'>): Point[] | null {
  const a = portCenter(f, cable.a);
  const b = portCenter(f, cable.b);
  const da = f.devices.get(cable.a.device);
  const db = f.devices.get(cable.b.device);
  if (!a || !b || !da || !db) return null;
  return routeBetween(a, da.slot, b, db.slot, cable.id);
}

export function routeBetween(a: Point, slotA: number, b: Point, slotB: number, lane: number): Point[] {
  const off = (lane % 5) * 3;
  if (slotA === slotB) {
    const side = rackRect(slotA).x + RAIL + RACK_W + 4 + off;
    return [a, { x: side, y: a.y }, { x: side, y: b.y }, b];
  }
  const ra = rackRect(slotA);
  const rb = rackRect(slotB);
  const right = slotB > slotA;
  const sideA = right ? ra.x + RAIL + RACK_W + 4 + off : ra.x + RAIL - 4 - off;
  const sideB = right ? rb.x + RAIL - 4 - off : rb.x + RAIL + RACK_W + 4 + off;
  const tray = TOP - 24 - (lane % 7) * 4;
  return [a, { x: sideA, y: a.y }, { x: sideA, y: tray }, { x: sideB, y: tray }, { x: sideB, y: b.y }, b];
}

/** 折れ線までの距離 */
export function distanceToRoute(route: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i + 1 < route.length; i++) best = Math.min(best, segDist(route[i], route[i + 1], p));
  return best;
}

/** 折れ線の長さと、先頭から t(0〜1)の位置 */
export function pointAlong(route: Point[], t: number): Point {
  let total = 0;
  for (let i = 0; i + 1 < route.length; i++) total += dist(route[i], route[i + 1]);
  let target = total * t;
  for (let i = 0; i + 1 < route.length; i++) {
    const len = dist(route[i], route[i + 1]);
    if (target <= len) {
      const k = len ? target / len : 0;
      return { x: route[i].x + (route[i + 1].x - route[i].x) * k, y: route[i].y + (route[i + 1].y - route[i].y) * k };
    }
    target -= len;
  }
  return route[route.length - 1];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function segDist(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

