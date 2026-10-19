import { GRID_H, GRID_W, NODE_DEFS } from './config';
import type { Simulation } from './simulation';
import type { NodeKind } from './types';

/**
 * 保存・共有用の構成データ。
 * nodes は [種類, x, y]、edges は [接続元の添字, 接続先の添字](-1 はインターネット)。
 */
export interface SavedLayout {
  v: 1;
  nodes: [NodeKind, number, number][];
  edges: [number, number][];
}

export function exportLayout(sim: Simulation): SavedLayout {
  const nodes: SavedLayout['nodes'] = [];
  const index = new Map<number, number>([[sim.internetId, -1]]);
  for (const n of sim.nodes.values()) {
    if (n.kind === 'internet') continue;
    index.set(n.id, nodes.length);
    nodes.push([n.kind, n.x, n.y]);
  }
  const edges: SavedLayout['edges'] = [];
  for (const n of sim.nodes.values()) {
    for (const to of n.out) edges.push([index.get(n.id)!, index.get(to)!]);
  }
  return { v: 1, nodes, edges };
}

/** 構成を配置する。費用は通常どおり予算から引かれ、足りない分は飛ばす */
export function applyLayout(sim: Simulation, layout: SavedLayout): { placed: number; skipped: number } {
  const ids = new Map<number, number>([[-1, sim.internetId]]);
  let placed = 0;
  let skipped = 0;
  layout.nodes.forEach(([kind, x, y], i) => {
    const r = sim.addNode(kind, x, y);
    if (r.ok && r.id !== undefined) {
      ids.set(i, r.id);
      placed++;
    } else {
      skipped++;
    }
  });
  for (const [from, to] of layout.edges) {
    const a = ids.get(from);
    const b = ids.get(to);
    if (a !== undefined && b !== undefined) sim.connect(a, b);
  }
  return { placed, skipped };
}

export function encodeLayout(layout: SavedLayout): string {
  const bin = btoa(JSON.stringify(layout));
  return bin.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeLayout(text: string): SavedLayout | null {
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    return parseLayout(JSON.parse(atob(b64)));
  } catch {
    return null;
  }
}

/** 外部から来たデータ(URL・localStorage)を検証して SavedLayout にする */
export function parseLayout(data: unknown): SavedLayout | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
  if (d.nodes.length > GRID_W * GRID_H) return null;

  const isInt = (n: unknown): n is number => Number.isInteger(n);
  const nodes: SavedLayout['nodes'] = [];
  for (const item of d.nodes) {
    if (!Array.isArray(item) || item.length !== 3) return null;
    const [kind, x, y] = item;
    if (typeof kind !== 'string' || !(kind in NODE_DEFS) || !NODE_DEFS[kind as NodeKind].placeable) return null;
    if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return null;
    nodes.push([kind as NodeKind, x, y]);
  }
  const edges: SavedLayout['edges'] = [];
  for (const item of d.edges) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [a, b] = item;
    if (!isInt(a) || !isInt(b) || a < -1 || b < -1 || a >= nodes.length || b >= nodes.length) return null;
    edges.push([a, b]);
  }
  return { v: 1, nodes, edges };
}
