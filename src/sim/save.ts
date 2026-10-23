import { GRID_H, GRID_W, LEGACY_LAYOUT_OFFSET, NODE_DEFS, OFFLINE, STARTER_WEB_POS } from './config';
import { UNLOCK_BY_ID, UPGRADE_BY_ID, emptyUpgrades } from './economy';
import { Simulation } from './simulation';
import type { NodeKind, UnlockId, UpgradeId } from './types';

/**
 * セーブデータ。ノードの待ち行列などの一時的な状態は保存せず、
 * 構成・お金・ユーザー数・投資状況だけを残す。
 */
export interface SaveData {
  v: 2;
  /** 保存時刻(Date.now()) */
  savedAt: number;
  money: number;
  users: number;
  lifetimeEarned: number;
  /** 保存時点の収支/秒。放置収入の計算に使う */
  incomePerSec: number;
  unlocks: UnlockId[];
  /** 解放済みだがオフにしている配信コンテンツ */
  disabled: UnlockId[];
  upgrades: Record<UpgradeId, number>;
  /** [種類, x, y, 購入額] */
  nodes: [NodeKind, number, number, number][];
  /** [接続元の添字, 接続先の添字](-1 はインターネット) */
  edges: [number, number][];
  /** 盤面の版。2 = 広い盤面(48×27)。ないものは 16×9 時代のセーブで、読み込み時に位置をずらす */
  layout: 2;
}

/** 新しいゲーム。最初からインターネットにつながった WEB が 1 台ある */
export function newGame(seed: number): Simulation {
  const sim = new Simulation({ seed });
  const web = sim.addNode('web', STARTER_WEB_POS.x, STARTER_WEB_POS.y, { free: true, paid: 0 });
  sim.connect(sim.internetId, web.id!);
  return sim;
}

export function createSave(sim: Simulation, now = Date.now()): SaveData {
  const nodes: SaveData['nodes'] = [];
  const index = new Map<number, number>([[sim.internetId, -1]]);
  for (const n of sim.nodes.values()) {
    if (n.kind === 'internet') continue;
    index.set(n.id, nodes.length);
    nodes.push([n.kind, n.x, n.y, n.paid]);
  }
  const edges: SaveData['edges'] = [];
  for (const n of sim.nodes.values()) {
    for (const to of n.out) edges.push([index.get(n.id)!, index.get(to)!]);
  }
  return {
    v: 2,
    savedAt: now,
    money: sim.money,
    users: sim.users,
    lifetimeEarned: sim.lifetimeEarned,
    incomePerSec: sim.incomePerSec,
    unlocks: [...sim.unlocks],
    disabled: [...sim.disabledFeatures],
    upgrades: { ...sim.upgrades },
    nodes,
    edges,
    layout: 2,
  };
}

export function loadSave(save: SaveData, seed: number): Simulation {
  const sim = new Simulation({
    seed,
    startMoney: save.money,
    startUsers: save.users,
    unlocks: save.unlocks,
    disabledFeatures: save.disabled,
    upgrades: save.upgrades,
  });
  sim.lifetimeEarned = save.lifetimeEarned;
  const ids = new Map<number, number>([[-1, sim.internetId]]);
  save.nodes.forEach(([kind, x, y, paid], i) => {
    const r = sim.addNode(kind, x, y, { free: true, paid });
    if (r.ok && r.id !== undefined) ids.set(i, r.id);
  });
  for (const [from, to] of save.edges) {
    const a = ids.get(from);
    const b = ids.get(to);
    if (a !== undefined && b !== undefined) sim.connect(a, b);
  }
  return sim;
}

/** 不在だった時間と、その間の収入。短すぎる不在や赤字のときは 0 */
export function offlineEarnings(save: SaveData, now: number): { elapsedMs: number; gained: number } {
  const elapsedMs = Math.max(0, now - save.savedAt);
  if (elapsedMs < OFFLINE.minMs || save.incomePerSec <= 0) return { elapsedMs, gained: 0 };
  const counted = Math.min(elapsedMs, OFFLINE.maxMs);
  return { elapsedMs, gained: save.incomePerSec * (counted / 1000) * OFFLINE.efficiency };
}

// ---------------------------------------------------------------- 文字列化

/** 端末間の引っ越し用に、セーブを 1 行の文字列にする */
export function encodeSave(save: SaveData): string {
  return btoa(JSON.stringify(save)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSave(text: string): SaveData | null {
  try {
    const b64 = text.trim().replace(/-/g, '+').replace(/_/g, '/');
    return parseSave(JSON.parse(atob(b64)));
  } catch {
    return null;
  }
}

/** 外部から来たデータ(localStorage・貼り付け)を検証して SaveData にする */
export function parseSave(data: unknown): SaveData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const isInt = (n: unknown): n is number => Number.isInteger(n);

  if (d.v !== 2) return null;
  if (!isNum(d.savedAt) || !isNum(d.money) || !isNum(d.users) || d.users < 0) return null;
  if (!isNum(d.lifetimeEarned) || !isNum(d.incomePerSec)) return null;
  if (!Array.isArray(d.unlocks) || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
  if (!d.upgrades || typeof d.upgrades !== 'object') return null;

  // 知らない解放・強化(名前が変わった・無くなったもの)は読み飛ばし、他の進行は残す
  const unlockIds = (list: unknown[]): UnlockId[] | null => {
    const ids: UnlockId[] = [];
    for (const u of list) {
      if (typeof u !== 'string') return null;
      if (u in UNLOCK_BY_ID) ids.push(u as UnlockId);
    }
    return ids;
  };
  const unlocks = unlockIds(d.unlocks);
  const disabled = Array.isArray(d.disabled) ? unlockIds(d.disabled) : [];
  if (!unlocks || !disabled) return null;

  const upgrades = emptyUpgrades();
  for (const [key, v] of Object.entries(d.upgrades as Record<string, unknown>)) {
    if (!isInt(v) || v < 0 || v > 1000) return null;
    const k = UPGRADE_RENAMES[key] ?? key;
    if (k in UPGRADE_BY_ID) upgrades[k as UpgradeId] = v;
  }

  if (d.nodes.length > GRID_W * GRID_H) return null;
  // 16×9 時代のセーブは、インターネットとの位置関係が変わらないようにずらす
  const shift = d.layout === 2 ? { x: 0, y: 0 } : LEGACY_LAYOUT_OFFSET;
  const nodes: SaveData['nodes'] = [];
  for (const item of d.nodes) {
    if (!Array.isArray(item) || item.length !== 4) return null;
    const [kind, rawX, rawY, paid] = item;
    const x = isInt(rawX) ? rawX + shift.x : rawX;
    const y = isInt(rawY) ? rawY + shift.y : rawY;
    if (typeof kind !== 'string' || !(kind in NODE_DEFS) || !NODE_DEFS[kind as NodeKind].placeable) return null;
    if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return null;
    if (!isNum(paid) || paid < 0) return null;
    nodes.push([kind as NodeKind, x, y, paid]);
  }

  const edges: SaveData['edges'] = [];
  for (const item of d.edges) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [a, b] = item;
    if (!isInt(a) || !isInt(b) || a < -1 || b < -1 || a >= nodes.length || b >= nodes.length) return null;
    edges.push([a, b]);
  }

  return {
    v: 2,
    savedAt: d.savedAt,
    money: d.money,
    users: d.users,
    lifetimeEarned: d.lifetimeEarned,
    incomePerSec: d.incomePerSec,
    unlocks,
    disabled,
    upgrades,
    nodes,
    edges,
    layout: 2,
  };
}

/** 名前を変えた強化の、古い名前 → 新しい名前 */
const UPGRADE_RENAMES: Record<string, UpgradeId> = {
  // LB の強化は「処理速度」から「帯域」に変わった
  lbPerf: 'lbBandwidth',
};
