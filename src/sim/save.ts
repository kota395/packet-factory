import { MODEL_BY_ID, portsOf } from './catalog';
import { OFFLINE, RACK, ROW } from './config';
import { UNLOCK_BY_ID, UPGRADE_BY_ID, emptyUpgrades } from './economy';
import { Simulation } from './simulation';
import { ROLE_IDS, type DiskKind, type ModelId, type RoleId, type UnlockId, type UpgradeId, type VmSize } from './types';

/**
 * セーブデータ。構成(ラック・機器・ケーブル)・お金・ユーザー数・投資状況を残す。
 * v3 = ラックと配線の版。それより前(ノード図の版)は読み込めない
 */
export interface SaveData {
  v: 3;
  savedAt: number;
  money: number;
  users: number;
  lifetimeEarned: number;
  /** 保存時点の収支/秒。放置収入の計算に使う */
  incomePerSec: number;
  unlocks: UnlockId[];
  disabled: UnlockId[];
  upgrades: Record<UpgradeId, number>;
  /** 借りているラックの位置 */
  racks: number[];
  /** [ID, 機種, ラック, U, 役割, 購入額, 名前, ハイパーバイザか] */
  devices: [number, ModelId, number, number, RoleId[], number, string, boolean][];
  /** [ID, 名前, ホスト, 大きさ, 役割, ディスク] */
  vms: [number, string, number, VmSize, RoleId[], DiskKind][];
  /** [ID, 機器 A, ポート A, 機器 B, ポート B, 購入額] */
  cables: [number, number, number, number, number, number][];
}

/** 新しいゲーム: ラック 1 本に、回線終端・スイッチ・web と db を同居させたサーバ 1 台 */
export function newGame(): Simulation {
  const sim = new Simulation();
  const f = sim.facility;
  f.rent(0);
  const isp = f.place('handoff', 0, RACK.units, 0);
  const sw = f.place('sw-24', 0, RACK.units - 2, 0);
  const srv = f.place('srv-1u-e', 0, RACK.units - 4, 0);
  f.setRoles(srv.id, ['web', 'db']);
  f.connect({ device: isp.id, port: 0 }, { device: sw.id, port: 0 }, 0);
  f.connect({ device: sw.id, port: 1 }, { device: srv.id, port: 0 }, 0);
  sim.refreshFlow();
  return sim;
}

export function createSave(sim: Simulation, now = Date.now()): SaveData {
  const f = sim.facility;
  return {
    v: 3,
    savedAt: now,
    money: sim.money,
    users: sim.users,
    lifetimeEarned: sim.lifetimeEarned,
    incomePerSec: sim.incomePerSec,
    unlocks: [...sim.unlocks],
    disabled: [...sim.disabledFeatures],
    upgrades: { ...sim.upgrades },
    racks: [...f.racks.keys()],
    devices: [...f.devices.values()].map((d) => [d.id, d.model, d.slot, d.u, [...d.roles], d.paid, d.name, d.hv]),
    vms: [...f.vms.values()].map((v) => [v.id, v.name, v.host, v.size, [...v.roles], v.disk]),
    cables: [...f.cables.values()].map((c) => [c.id, c.a.device, c.a.port, c.b.device, c.b.port, c.paid]),
  };
}

export function loadSave(save: SaveData): Simulation {
  const sim = new Simulation({
    startMoney: save.money,
    startUsers: save.users,
    unlocks: save.unlocks,
    disabledFeatures: save.disabled,
    upgrades: save.upgrades,
  });
  sim.lifetimeEarned = save.lifetimeEarned;
  const f = sim.facility;
  for (const slot of save.racks) f.rent(slot);
  for (const [id, model, slot, u, roles, paid, name, hv] of save.devices) {
    // 壊れた配置(重なり・ラック外)は読み飛ばす。電力は昔の上限で置いたものもそのまま戻す
    if (f.placeError(model, slot, u, Infinity) !== null) continue;
    const d = f.place(model, slot, u, paid, { id, name });
    if (hv) f.setHv(d.id, true);
    f.setRoles(d.id, roles);
  }
  for (const [id, name, host, size, roles, disk] of save.vms) {
    if (!f.devices.get(host)?.hv) continue;
    f.createVm(host, size, { id, name, roles, disk });
  }
  for (const [id, da, pa, db, pb, paid] of save.cables) {
    const a = { device: da, port: pa };
    const b = { device: db, port: pb };
    if (f.connectError(a, b) === null) f.connect(a, b, paid, id);
  }
  sim.refreshFlow();
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
  const bytes = new TextEncoder().encode(JSON.stringify(save));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSave(text: string): SaveData | null {
  try {
    const bin = atob(text.trim().replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return parseSave(JSON.parse(new TextDecoder().decode(bytes)));
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

  if (d.v !== 3) return null;
  if (!isNum(d.savedAt) || !isNum(d.money) || !isNum(d.users) || d.users < 0) return null;
  if (!isNum(d.lifetimeEarned) || !isNum(d.incomePerSec)) return null;
  if (![d.unlocks, d.disabled, d.racks, d.devices, d.cables].every(Array.isArray)) return null;
  if (!d.upgrades || typeof d.upgrades !== 'object') return null;

  const ids = (list: unknown[]): UnlockId[] | null => {
    const out: UnlockId[] = [];
    for (const u of list) {
      if (typeof u !== 'string') return null;
      if (u in UNLOCK_BY_ID) out.push(u as UnlockId);
    }
    return out;
  };
  const unlocks = ids(d.unlocks as unknown[]);
  const disabled = ids(d.disabled as unknown[]);
  if (!unlocks || !disabled) return null;

  const upgrades = emptyUpgrades();
  for (const [key, v] of Object.entries(d.upgrades as Record<string, unknown>)) {
    if (!isInt(v) || v < 0 || v > 1000) return null;
    if (key in UPGRADE_BY_ID) upgrades[key as UpgradeId] = v;
  }

  const racks: number[] = [];
  for (const s of d.racks as unknown[]) {
    if (!isInt(s) || s < 0 || s >= ROW.maxRacks) return null;
    racks.push(s);
  }

  const devices: SaveData['devices'] = [];
  const okRoles = (roles: unknown[]) => roles.filter((r): r is RoleId => ROLE_IDS.includes(r as RoleId));
  for (const item of d.devices as unknown[]) {
    // 仮想化の前のセーブは 7 要素(ハイパーバイザの印がない)
    if (!Array.isArray(item) || (item.length !== 7 && item.length !== 8)) return null;
    const [id, model, slot, u, roles, paid, name, hv] = item;
    if (!isInt(id) || id < 0 || typeof model !== 'string' || !(model in MODEL_BY_ID)) return null;
    if (!isInt(slot) || !isInt(u) || !Array.isArray(roles) || !isNum(paid) || typeof name !== 'string') return null;
    devices.push([id, model as ModelId, slot, u, okRoles(roles), paid, name.slice(0, 32), hv === true]);
  }

  const vms: SaveData['vms'] = [];
  for (const item of (Array.isArray(d.vms) ? d.vms : []) as unknown[]) {
    if (!Array.isArray(item) || item.length !== 6) return null;
    const [id, name, host, size, roles, disk] = item;
    if (!isInt(id) || id < 1 || typeof name !== 'string' || !isInt(host) || !Array.isArray(roles)) return null;
    if (size !== 's' && size !== 'm' && size !== 'l') return null;
    if (disk !== 'local' && disk !== 'shared') return null;
    vms.push([id, name.slice(0, 32), host, size, okRoles(roles), disk]);
  }

  const cables: SaveData['cables'] = [];
  for (const item of d.cables as unknown[]) {
    if (!Array.isArray(item) || item.length !== 6 || !item.every(isNum)) return null;
    const [id, da, pa, db, pb, paid] = item as number[];
    const ok = (dev: number, port: number) => {
      const dv = devices.find((x) => x[0] === dev);
      return dv !== undefined && isInt(port) && port >= 0 && port < portsOf(dv[1]).length;
    };
    if (!ok(da, pa) || !ok(db, pb)) return null;
    cables.push([id, da, pa, db, pb, paid]);
  }

  return {
    v: 3,
    savedAt: d.savedAt,
    money: d.money,
    users: d.users,
    lifetimeEarned: d.lifetimeEarned,
    incomePerSec: d.incomePerSec,
    unlocks,
    disabled,
    upgrades,
    racks,
    devices,
    vms,
    cables,
  };
}
