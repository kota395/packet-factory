import { MODEL_BY_ID, PRESET_BY_ID, START_PARTS, isServerModel, partsError, portsOf } from './catalog';
import { OFFLINE, RACK, ROW } from './config';
import { UNLOCK_BY_ID, UPGRADE_BY_ID, emptyUpgrades } from './economy';
import { PART_REFUND_RATE, cablePrice, memoryPrice, serverPrice } from './pricing';
import { Simulation } from './simulation';
import {
  ROLE_IDS,
  SERVICE_IDS,
  isRoleKey,
  roleKey,
  type DiskKind,
  type ModelId,
  type RoleId,
  type RoleKey,
  type ServerParts,
  type ServiceId,
  type UnlockId,
  type UpgradeId,
  type VmSize,
} from './types';

/**
 * セーブデータ。構成(ラック・機器・ケーブル)・お金・ユーザー数・投資状況を残す。
 * v5 = サーバがシャーシとパーツの構成になった版。
 * v4(複数のサービス、サーバは機種固定)・v3(ブログだけ)は読み込むときに移す。それより前(ノード図の版)は読み込めない
 */
export interface SaveData {
  v: 5;
  savedAt: number;
  money: number;
  /** サービスごとのユーザー数 */
  users: Partial<Record<ServiceId, number>>;
  /** キャンペーンの残り時間とクールタイムの残り(ms) */
  campaign: [number, number];
  lifetimeEarned: number;
  /** 保存時点の収支/秒。放置収入の計算に使う */
  incomePerSec: number;
  unlocks: UnlockId[];
  disabled: UnlockId[];
  upgrades: Record<UpgradeId, number>;
  /** 借りているラックの位置 */
  racks: number[];
  /** [ID, 機種, ラック, U, 役割, 購入額, 名前, ハイパーバイザか, BGP を使うか, メンテナンス中か, Kubernetes のワーカーか, サーバの構成] */
  devices: [number, ModelId, number, number, RoleKey[], number, string, boolean, boolean, boolean, boolean, ServerParts | null][];
  /** [ID, 名前, ホスト, 大きさ, 役割, ディスク, Kubernetes のワーカーか] */
  vms: [number, string, number, VmSize, RoleKey[], DiskKind, boolean][];
  /** Kubernetes の Deployment と、その時点の Pod の数 */
  deployments: [RoleKey, number][];
  /** [ID, 機器 A, ポート A, 機器 B, ポート B, 購入額] */
  cables: [number, number, number, number, number, number][];
}

/** 新しいゲーム: ラック 1 本に、回線終端・スイッチ・リクエストを受ける 1U サーバ・db 用の 2U サーバ(HDD) */
export function newGame(): Simulation {
  const sim = new Simulation();
  const f = sim.facility;
  f.rent(0);
  const isp = f.place('handoff', 0, RACK.units, 0);
  const sw = f.place('sw-24', 0, RACK.units - 2, 0);
  const web = f.place('srv-1u', 0, RACK.units - 4, 0, { parts: START_PARTS.web });
  const db = f.place('srv-2u', 0, RACK.units - 7, 0, { parts: START_PARTS.db });
  f.setRoles(web.id, ['blog:web']);
  f.setRoles(db.id, ['blog:db']);
  f.connect({ device: isp.id, port: 0 }, { device: sw.id, port: 0 }, 0);
  f.connect({ device: sw.id, port: 1 }, { device: web.id, port: 0 }, 0);
  f.connect({ device: sw.id, port: 2 }, { device: db.id, port: 0 }, 0);
  sim.refreshFlow();
  return sim;
}

/** チュートリアルの始まり: 回線終端とスイッチだけ(つないである)。チュートリアルで買う分のお金を足しておく */
export function tutorialGame(): Simulation {
  const sim = new Simulation();
  const f = sim.facility;
  f.rent(0);
  const isp = f.place('handoff', 0, RACK.units, 0);
  const sw = f.place('sw-24', 0, RACK.units - 2, 0);
  f.connect({ device: isp.id, port: 0 }, { device: sw.id, port: 0 }, 0);
  sim.money += tutorialGrant();
  sim.refreshFlow();
  return sim;
}

/** チュートリアルで使うお金: サーバ 2 台、db のメモリ 1 段、ケーブル 2 本(ラック内の長め) */
export function tutorialGrant(): number {
  const db = PRESET_BY_ID['2u-hdd-small'].parts;
  return (
    serverPrice('srv-1u', PRESET_BY_ID['1u-small'].parts) +
    serverPrice('srv-2u', db) +
    memoryPrice(START_PARTS.db.memGB) -
    Math.floor(memoryPrice(db.memGB) * PART_REFUND_RATE) +
    2 * cablePrice(false, 3)
  );
}

export function createSave(sim: Simulation, now = Date.now()): SaveData {
  const f = sim.facility;
  return {
    v: 5,
    savedAt: now,
    money: sim.money,
    users: { ...sim.serviceUsers },
    campaign: [Math.max(0, sim.campaign.until - sim.time), Math.max(0, sim.campaign.cooldownUntil - sim.time)],
    lifetimeEarned: sim.lifetimeEarned,
    incomePerSec: sim.incomePerSec,
    unlocks: [...sim.unlocks],
    disabled: [...sim.disabledFeatures],
    upgrades: { ...sim.upgrades },
    racks: [...f.racks.keys()],
    devices: [...f.devices.values()].map((d) => [d.id, d.model, d.slot, d.u, [...d.roles], d.paid, d.name, d.hv, d.bgp, d.down, d.k8s, d.parts]),
    vms: [...f.vms.values()].map((v) => [v.id, v.name, v.host, v.size, [...v.roles], v.disk, v.k8s]),
    deployments: [...sim.deployments],
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
  sim.campaign = { until: sim.time + save.campaign[0], cooldownUntil: sim.time + save.campaign[1] };
  const f = sim.facility;
  for (const slot of save.racks) f.rent(slot);
  for (const [id, model, slot, u, roles, paid, name, hv, bgp, down, k8s, parts] of save.devices) {
    // 壊れた配置(重なり・ラック外)は読み飛ばす。電力は昔の上限で置いたものもそのまま戻す
    if (f.placeError(model, slot, u, Infinity, undefined, parts) !== null) continue;
    const d = f.place(model, slot, u, paid, { id, name, parts: parts ?? undefined });
    if (hv) f.setHv(d.id, true);
    if (bgp) f.setBgp(d.id, true);
    if (down) f.setDown(d.id, true);
    if (k8s && !hv) f.setK8s(d.id, true);
    f.setRoles(d.id, roles);
  }
  for (const [id, name, host, size, roles, disk, k8s] of save.vms) {
    if (!f.devices.get(host)?.hv) continue;
    f.createVm(host, size, { id, name, roles: k8s ? [] : roles, disk, k8s });
  }
  for (const [id, da, pa, db, pb, paid] of save.cables) {
    const a = { device: da, port: pa };
    const b = { device: db, port: pb };
    if (f.connectError(a, b) === null) f.connect(a, b, paid, id);
  }
  for (const [key, count] of save.deployments) sim.deployments.set(key, count);
  sim.schedule();
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

  if (d.v !== 3 && d.v !== 4 && d.v !== 5) return null;
  if (!isNum(d.savedAt) || !isNum(d.money)) return null;
  // ユーザー数: v3 はブログだけの数値
  const users: Partial<Record<ServiceId, number>> = {};
  if (d.v === 3) {
    if (!isNum(d.users) || d.users < 0) return null;
    users.blog = d.users;
  } else {
    if (!d.users || typeof d.users !== 'object') return null;
    for (const [k, v] of Object.entries(d.users as Record<string, unknown>)) {
      if (!SERVICE_IDS.includes(k as ServiceId)) continue;
      if (!isNum(v) || v < 0) return null;
      users[k as ServiceId] = v;
    }
  }
  const campaign: [number, number] = [0, 0];
  if (Array.isArray(d.campaign) && d.campaign.length === 2 && d.campaign.every((x) => isNum(x) && x >= 0)) {
    campaign[0] = d.campaign[0] as number;
    campaign[1] = d.campaign[1] as number;
  }
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
  /** v4 はサービスつきの役割、v3 は役割の名前だけ(ブログの役割として読む) */
  const okRoles = (roles: unknown[]): RoleKey[] =>
    d.v === 3
      ? roles.filter((r): r is RoleId => ROLE_IDS.includes(r as RoleId)).map((r) => roleKey('blog', r))
      : roles.filter(isRoleKey);
  for (const item of d.devices as unknown[]) {
    // 古いセーブは 7 要素(仮想化の前)・8 要素(BGP の前)・10 要素(Kubernetes の前)・11 要素(パーツの前)
    if (!Array.isArray(item) || ![7, 8, 10, 11, 12].includes(item.length)) return null;
    const [id, rawModel, slot, u, roles, paid, name, hv, bgp, down, k8s, rawParts] = item;
    if (!isInt(id) || id < 0 || typeof rawModel !== 'string') return null;
    // 機種固定だったころのサーバは、近い構成のシャーシに移す
    const legacy = LEGACY_SERVERS[rawModel];
    const model = legacy ? legacy.model : rawModel;
    if (!(model in MODEL_BY_ID)) return null;
    if (!isInt(slot) || !isInt(u) || !Array.isArray(roles) || !isNum(paid) || typeof name !== 'string') return null;
    let parts: ServerParts | null = null;
    if (isServerModel(model as ModelId)) {
      parts = legacy?.parts ?? parseParts(rawParts) ?? null;
      if (!parts || partsError(model as 'srv-1u' | 'srv-2u', parts)) parts = model === 'srv-1u' ? START_PARTS.web : START_PARTS.db;
    }
    devices.push([
      id,
      model as ModelId,
      slot,
      u,
      okRoles(roles),
      paid,
      name.slice(0, 32),
      hv === true,
      bgp === true,
      down === true,
      k8s === true,
      parts,
    ]);
  }

  const vms: SaveData['vms'] = [];
  for (const item of (Array.isArray(d.vms) ? d.vms : []) as unknown[]) {
    if (!Array.isArray(item) || (item.length !== 6 && item.length !== 7)) return null;
    const [id, name, host, size, roles, disk, k8s] = item;
    if (!isInt(id) || id < 1 || typeof name !== 'string' || !isInt(host) || !Array.isArray(roles)) return null;
    if (size !== 's' && size !== 'm' && size !== 'l') return null;
    if (disk !== 'local' && disk !== 'shared') return null;
    vms.push([id, name.slice(0, 32), host, size, okRoles(roles), disk, k8s === true]);
  }

  const deployments: SaveData['deployments'] = [];
  for (const item of (Array.isArray(d.deployments) ? d.deployments : []) as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2 || !isRoleKey(item[0]) || !isInt(item[1]) || item[1] < 0) return null;
    deployments.push([item[0], Math.min(item[1], 1000)]);
  }

  const cables: SaveData['cables'] = [];
  for (const item of d.cables as unknown[]) {
    if (!Array.isArray(item) || item.length !== 6 || !item.every(isNum)) return null;
    const [id, da, pa, db, pb, paid] = item as number[];
    const ok = (dev: number, port: number) => {
      const dv = devices.find((x) => x[0] === dev);
      return dv !== undefined && isInt(port) && port >= 0 && port < portsOf({ model: dv[1], parts: dv[11] }).length;
    };
    if (!ok(da, pa) || !ok(db, pb)) return null;
    cables.push([id, da, pa, db, pb, paid]);
  }

  return {
    v: 5,
    savedAt: d.savedAt,
    money: d.money,
    users,
    campaign,
    lifetimeEarned: d.lifetimeEarned,
    incomePerSec: d.incomePerSec,
    unlocks,
    disabled,
    upgrades,
    racks,
    devices,
    vms,
    cables,
    deployments,
  };
}

/** 機種固定だったころ(v4 まで)のサーバと、移す先の構成。ポートの並び(1GbE×2、仮想化ホストは 10G×2 も)は同じ */
export const LEGACY_SERVERS: Record<string, { model: 'srv-1u' | 'srv-2u'; parts: ServerParts }> = {
  'srv-1u-e': { model: 'srv-1u', parts: PRESET_BY_ID['1u-small'].parts },
  'srv-1u-d': { model: 'srv-1u', parts: PRESET_BY_ID['1u-web'].parts },
  'srv-2u-db': { model: 'srv-2u', parts: { cpu: 8, memGB: 64, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'none' } },
  'srv-2u-hv': { model: 'srv-2u', parts: { cpu: 24, memGB: 256, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'sfp10' } },
};

function parseParts(x: unknown): ServerParts | null {
  if (!x || typeof x !== 'object') return null;
  const p = x as Record<string, unknown>;
  if (typeof p.cpu !== 'number' || typeof p.memGB !== 'number') return null;
  if (p.backplane !== 'sff' && p.backplane !== 'lff') return null;
  if (p.nic !== 'none' && p.nic !== 'sfp10') return null;
  if (!Array.isArray(p.drives) || p.drives.length > 64) return null;
  if (!p.drives.every((t) => t === 'hdd' || t === 'ssd' || t === 'nvme')) return null;
  return { cpu: p.cpu, memGB: p.memGB, backplane: p.backplane, drives: [...p.drives], nic: p.nic };
}
