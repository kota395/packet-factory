/**
 * 列の立面図の座標(ワールド座標)。描画と当たり判定の両方で使う。
 * ラックは左から slot 0, 1, … と並び、U は下が 1。
 */
import { MODEL_BY_ID } from '../sim/catalog';
import { RACK, ROW } from '../sim/config';
import type { Device } from '../sim/facility';

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
/** ラックの内側の幅と、左右の柱の幅 */
export const RACK_W = 320;
export const RAIL = 16;
/** ラックとラックの間 */
export const GAP = 70;
/** ラックの上: 見出しの高さ */
export const TOP = 120;
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
