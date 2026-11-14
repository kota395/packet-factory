/** Simulation の操作のうち、機器を置く・動かす・売る、サーバのパーツ、役割。Simulation のメソッドから呼ばれる */
import { CPU_OPTIONS, DRIVES, MEMORY_OPTIONS, MODEL_BY_ID, PRESET_BY_ID, isServerModel, partsError, partsRequires, specOf } from './catalog';
import { SERVICES, VIRT } from './config';
import { UNLOCK_BY_ID, ROLE_UNLOCK } from './economy';
import type { Device } from './facility';
import {
  SELL_REFUND_RATE,
  PART_REFUND_RATE,
  PRICE_SCALE,
  BACKPLANE_PRICE,
  cpuPrice,
  drivePrice,
  gpuPrice,
  memoryPrice,
  nicPrice,
  serverPrice,
} from './pricing';
import { DATA_ROLES, splitRole } from './types';
import type { DriveType, ModelId, RoleKey, ServerParts, UnlockId } from './types';
import type { ActionResult, PartChange, Simulation } from './simulation';

export function rentRack(sim: Simulation, slot: number): ActionResult {
  const err = sim.facility.rentError(slot);
  if (err) return { ok: false, message: err };
  const price = sim.rackPrice();
  if (sim.money < price) return { ok: false, message: `資金が足りません($${price} 必要)` };
  sim.money -= price;
  sim.facility.rent(slot);
  sim.refreshFlow();
  return { ok: true, message: `ラック ${slot + 1} を借りました` };
}

/** プリセットを指定せずにサーバを買ったときの構成 */
export function defaultParts(_sim: Simulation, model: 'srv-1u' | 'srv-2u'): ServerParts {
  return PRESET_BY_ID[model === 'srv-1u' ? '1u-web' : '2u-hdd'].parts;
}

export function isMainLine(sim: Simulation, id: number): boolean {
  let first: number | null = null;
  for (const d of sim.facility.devices.values()) if (d.model === 'handoff' && (first === null || d.id < first)) first = d.id;
  return first === id;
}

export function canBuyModel(sim: Simulation, model: ModelId, parts?: ServerParts): string | null {
  const m = MODEL_BY_ID[model];
  if (m.category === 'handoff' && !sim.unlocks.has('multihoming')) return `回線を増やすには投資の「${UNLOCK_BY_ID.multihoming.name}」が必要です`;
  if (m.requires && !sim.unlocks.has(m.requires)) return `投資の「${UNLOCK_BY_ID[m.requires].name}」が必要です`;
  if (parts) return partsUnlockError(sim, parts);
  return null;
}

export function partsUnlockError(sim: Simulation, parts: ServerParts): string | null {
  for (const u of partsRequires(parts)) if (!sim.unlocks.has(u)) return `投資の「${UNLOCK_BY_ID[u].name}」が必要です`;
  return null;
}

export function placeError(sim: Simulation, model: ModelId, slot: number, u: number, ignore?: number, parts?: ServerParts): string | null {
  const p = isServerModel(model) ? (parts ?? (ignore !== undefined ? undefined : defaultParts(sim, model))) : null;
  return sim.facility.placeError(model, slot, u, sim.rackPowerW, ignore, p);
}

export function buyDevice(sim: Simulation, model: ModelId, slot: number, u: number, config?: string | ServerParts): ActionResult {
  let parts: ServerParts | undefined;
  if (isServerModel(model)) {
    const preset = typeof config === 'string' ? PRESET_BY_ID[config] : undefined;
    if (typeof config === 'string' && (!preset || preset.model !== model)) return { ok: false, message: 'その構成はありません' };
    parts = preset?.parts ?? (config as ServerParts | undefined) ?? defaultParts(sim, model);
    const perr = partsError(model, parts);
    if (perr) return { ok: false, message: perr };
  }
  const err = sim.canBuyModel(model, parts) ?? sim.placeError(model, slot, u, undefined, parts);
  if (err) return { ok: false, message: err };
  const price = sim.devicePrice(model, parts);
  if (sim.money < price) return { ok: false, message: `資金が足りません($${price} 必要)` };
  sim.money -= price;
  const d = sim.facility.place(model, slot, u, price, { parts });
  sim.refreshFlow();
  return { ok: true, id: d.id, message: `${d.name}(${MODEL_BY_ID[model].name})を設置しました` };
}

export function buyServer(sim: Simulation, preset: string, slot: number, u: number): ActionResult {
  const p = PRESET_BY_ID[preset];
  if (!p) return { ok: false, message: 'その構成はありません' };
  return sim.buyDevice(p.model, slot, u, preset);
}

export function partChangeInfo(sim: Simulation, id: number, change: PartChange): { parts: ServerParts | null; cost: number; error: string | null } {
  const d = sim.facility.devices.get(id);
  if (!d || !d.parts || !isServerModel(d.model)) return { parts: null, cost: 0, error: 'サーバではありません' };
  const p = d.parts;
  let next: ServerParts;
  let cost = 0;
  const refund = (v: number) => Math.floor(v * PART_REFUND_RATE);
  const bpPrice = Math.round(BACKPLANE_PRICE * PRICE_SCALE);
  const step = <T>(list: readonly T[], cur: T, dir: number): T | null => {
    const i = list.indexOf(cur) + dir;
    return i >= 0 && i < list.length ? list[i] : null;
  };
  switch (change.kind) {
    case 'cpu': {
      const cores = step(
        CPU_OPTIONS.map((o) => o.cores),
        p.cpu,
        change.dir,
      );
      if (cores === null) return { parts: null, cost: 0, error: change.dir > 0 ? 'これより上の CPU はありません' : 'これより下の CPU はありません' };
      next = { ...p, cpu: cores };
      cost = cpuPrice(cores) - refund(cpuPrice(p.cpu));
      break;
    }
    case 'mem': {
      const gb = step(MEMORY_OPTIONS, p.memGB, change.dir);
      if (gb === null) return { parts: null, cost: 0, error: change.dir > 0 ? 'これ以上は載りません' : 'これより減らせません' };
      next = { ...p, memGB: gb };
      cost = memoryPrice(gb) - refund(memoryPrice(p.memGB));
      break;
    }
    case 'drive-add': {
      if (DRIVES[change.type].bay !== p.backplane) {
        return { parts: null, cost: 0, error: p.backplane === 'lff' ? '3.5 インチのベイには HDD だけ' : '2.5 インチのベイには SSD・NVMe だけ' };
      }
      next = { ...p, drives: [...p.drives, change.type, change.type] };
      cost = drivePrice(change.type) * 2;
      break;
    }
    case 'drive-remove': {
      if (p.drives.length < 2) return { parts: null, cost: 0, error: 'ドライブがありません' };
      const removed = p.drives.slice(-2);
      next = { ...p, drives: p.drives.slice(0, -2) };
      cost = -removed.reduce((s, t) => s + refund(drivePrice(t)), 0);
      break;
    }
    case 'backplane': {
      if (change.to === p.backplane) return { parts: null, cost: 0, error: 'すでにその構成です' };
      // バックプレーンを替えると、入っていたドライブは外れる(下取り)。データ用に一番安いドライブを 2 本入れる
      const first: DriveType = change.to === 'lff' ? 'hdd' : 'ssd';
      next = { ...p, backplane: change.to, drives: [first, first] };
      cost = bpPrice + drivePrice(first) * 2 - p.drives.reduce((s, t) => s + refund(drivePrice(t)), 0);
      break;
    }
    case 'gpu': {
      const now = p.gpus ?? 0;
      const n = now + change.dir;
      if (n < 0) return { parts: null, cost: 0, error: 'GPU は載っていません' };
      next = { ...p, gpus: n };
      cost = change.dir > 0 ? gpuPrice(1) : -refund(gpuPrice(1));
      break;
    }
    case 'nic': {
      if (change.to === p.nic) return { parts: null, cost: 0, error: 'すでにその NIC です' };
      next = { ...p, nic: change.to };
      cost = nicPrice(change.to) - refund(nicPrice(p.nic));
      break;
    }
  }
  const error =
    partsError(d.model, next) ??
    partsUnlockError(sim, next) ??
    partsFitError(sim, d, next) ??
    (cost > 0 && sim.money < cost ? `資金が足りません($${cost} 必要)` : null);
  return { parts: next, cost, error };
}

/** 替えたあとの構成で、ラックの電力・載っている VM が収まるか */
export function partsFitError(sim: Simulation, d: Device, next: ServerParts): string | null {
  const watts = sim.facility.powerUsed(d.slot, d.id) + specOf({ model: d.model, parts: next }).powerW;
  if (watts > sim.rackPowerW) return `電力が足りません(${watts}W / 上限 ${sim.rackPowerW}W)`;
  if (d.hv) {
    const used = sim.facility.hostUsage(d.id);
    const s = specOf({ model: d.model, parts: next });
    if (used.memGB > s.memGB - VIRT.hostMemGB) return '載っている VM のメモリが収まりません';
    if (used.vcpu > s.cores * VIRT.vcpuOvercommit) return '載っている VM の vCPU が収まりません';
  }
  return null;
}

export function changeParts(sim: Simulation, id: number, change: PartChange): ActionResult {
  const info = sim.partChangeInfo(id, change);
  if (info.error || !info.parts) return { ok: false, message: info.error ?? '替えられません' };
  const d = sim.facility.devices.get(id)!;
  sim.money -= info.cost;
  sim.facility.setParts(id, info.parts);
  d.paid = serverPrice(d.model as 'srv-1u' | 'srv-2u', info.parts);
  sim.schedule();
  sim.refreshFlow();
  const money = info.cost >= 0 ? `-$${info.cost}` : `+$${-info.cost}`;
  return { ok: true, message: `${d.name} の構成を替えました(${money})` };
}

export function moveDevice(sim: Simulation, id: number, slot: number, u: number): ActionResult {
  const d = sim.facility.devices.get(id);
  if (!d) return { ok: false, message: '機器が見つかりません' };
  if (sim.isMainLine(d.id)) return { ok: false, message: '最初の回線終端は動かせません' };
  if (d.slot === slot && d.u === u) return { ok: true };
  const err = sim.placeError(d.model, slot, u, id);
  if (err) return { ok: false, message: err };
  sim.facility.move(id, slot, u);
  sim.refreshFlow();
  return { ok: true };
}

export function sellValue(sim: Simulation, id: number): number {
  const d = sim.facility.devices.get(id);
  if (!d) return 0;
  const value = d.parts && isServerModel(d.model) ? serverPrice(d.model, d.parts) : d.paid;
  return Math.floor(value * SELL_REFUND_RATE);
}

export function sellDevice(sim: Simulation, id: number): ActionResult {
  const d = sim.facility.devices.get(id);
  if (!d) return { ok: false, message: '機器が見つかりません' };
  if (sim.isMainLine(d.id)) return { ok: false, message: '最初の回線終端は撤去できません' };
  const vms = sim.facility.vmsOn(id);
  if (vms.length) return { ok: false, message: `${d.name} には VM が ${vms.length} 台載っています。先に移すか消してください` };
  const refund = sim.sellValue(id);
  sim.facility.remove(id);
  sim.money += refund;
  sim.schedule();
  sim.refreshFlow();
  return { ok: true, message: `${d.name}を売却しました(+$${refund})` };
}

export function roleError(sim: Simulation, id: number, role: RoleKey): string | null {
  const d = sim.facility.devices.get(id);
  if (!d || MODEL_BY_ID[d.model].category !== 'server') return '役割はサーバにだけ割り当てられます';
  if (d.hv) return 'ハイパーバイザには役割を付けられません。VM に付けてください';
  if (d.k8s) return 'Kubernetes のワーカーには役割を付けられません(Pod が自動で置かれます)';
  return sim.roleUnlockError(role);
}

export function roleUnlockError(sim: Simulation, key: RoleKey): string | null {
  const [scope, role] = splitRole(key);
  // 分析基盤の役割(hadoop・ml)は、それぞれの解放だけ
  if (scope === 'data') {
    if (!DATA_ROLES.includes(role)) return `分析基盤には役割「${role}」はありません`;
    const unlock = ROLE_UNLOCK[role]!;
    return sim.unlocks.has(unlock) ? null : `投資の「${UNLOCK_BY_ID[unlock].name}」が必要です`;
  }
  const service = scope;
  if (DATA_ROLES.includes(role) || !SERVICES[service].roles.includes(role)) return `${SERVICES[service].name}には役割「${role}」はありません`;
  if (!sim.isServiceActive(service)) return `投資の「${UNLOCK_BY_ID[service as UnlockId].name}」が必要です`;
  const unlock = ROLE_UNLOCK[role];
  if (unlock && !sim.unlocks.has(unlock)) return `投資の「${UNLOCK_BY_ID[unlock].name}」が必要です`;
  return null;
}

export function toggleRole(sim: Simulation, id: number, role: RoleKey): ActionResult {
  const d = sim.facility.devices.get(id);
  const err = sim.roleError(id, role);
  if (!d || err) return { ok: false, message: err ?? '機器が見つかりません' };
  const roles = d.roles.includes(role) ? d.roles.filter((r) => r !== role) : [...d.roles, role];
  sim.facility.setRoles(id, roles);
  sim.refreshFlow();
  return { ok: true };
}
