/** Simulation の操作のうち、仮想化とクラスタ: ハイパーバイザ、VM の作成・移動・役割・ディスク。Simulation のメソッドから呼ばれる */
import { MODEL_BY_ID, specOf } from './catalog';
import { VIRT } from './config';
import { UNLOCK_BY_ID } from './economy';
import type { Device } from './facility';
import type { DiskKind, RoleKey, VmSize } from './types';
import type { ActionResult, Simulation } from './simulation';

export function hvError(sim: Simulation, id: number, on: boolean): string | null {
  const d = sim.facility.devices.get(id);
  if (!d || MODEL_BY_ID[d.model].category !== 'server') return 'ハイパーバイザにできるのはサーバだけです';
  if (on && !sim.unlocks.has('virtualization')) return `投資の「${UNLOCK_BY_ID.virtualization.name}」が必要です`;
  if (on && d.k8s) return 'Kubernetes のワーカーはハイパーバイザにできません';
  if (!on && sim.facility.vmsOn(id).length) return 'VM が載っている間はやめられません';
  return null;
}

export function setHv(sim: Simulation, id: number, on: boolean): ActionResult {
  const err = sim.hvError(id, on);
  if (err) return { ok: false, message: err };
  const d = sim.facility.devices.get(id)!;
  const dropped = d.roles.length;
  sim.facility.setHv(id, on);
  sim.refreshFlow();
  const note = on && dropped ? '(役割は外れました。VM に付けてください)' : '';
  return { ok: true, message: `${d.name} を${on ? 'ハイパーバイザにしました' : '物理サーバに戻しました'}${note}` };
}

export function isWired(sim: Simulation, id: number): boolean {
  const f = sim.facility;
  return f.cablesOf(id).some((c) => {
    const other = f.devices.get(c.a.device === id ? c.b.device : c.a.device);
    return !!other && MODEL_BY_ID[other.model].category === 'switch';
  });
}

export function spareServers(sim: Simulation): Device[] {
  return [...sim.facility.devices.values()]
    .filter((d) => MODEL_BY_ID[d.model].category === 'server' && !d.hv && !d.k8s && !d.roles.length && sim.isWired(d.id))
    .sort((a, b) => a.id - b.id);
}

export function hvCapacity(sim: Simulation): { hosts: number; vcpu: number; vcpuMax: number; memGB: number; memMax: number } {
  let hosts = 0;
  let vcpu = 0;
  let vcpuMax = 0;
  let memGB = 0;
  let memMax = 0;
  for (const d of sim.facility.devices.values()) {
    if (!d.hv) continue;
    const sp = specOf(d);
    const use = sim.facility.hostUsage(d.id);
    hosts++;
    vcpu += use.vcpu;
    vcpuMax += sp.cores * VIRT.vcpuOvercommit;
    memGB += use.memGB;
    memMax += sp.memGB - VIRT.hostMemGB;
  }
  return { hosts, vcpu, vcpuMax, memGB, memMax };
}

export function pickHost(sim: Simulation, size: VmSize): number | null {
  const down = sim.downDevices;
  let best: { id: number; free: number } | null = null;
  for (const d of sim.facility.devices.values()) {
    if (!d.hv || down.has(d.id) || sim.facility.vmPlaceError(d.id, size)) continue;
    const free = specOf(d).memGB - sim.facility.hostUsage(d.id).memGB;
    if (!best || free > best.free) best = { id: d.id, free };
  }
  return best?.id ?? null;
}

export function createVmAuto(sim: Simulation, size: VmSize, opts: { roles?: RoleKey[]; disk?: DiskKind; k8s?: boolean } = {}): ActionResult {
  if (!sim.unlocks.has('virtualization')) return { ok: false, message: `投資の「${UNLOCK_BY_ID.virtualization.name}」が必要です` };
  const host = sim.pickHost(size);
  if (host === null) return { ok: false, message: `${VIRT.sizes[size].label} の VM を載せられるホストがありません(ホストを増やすか、小さくする)` };
  for (const r of opts.roles ?? []) {
    const err = sim.roleUnlockError(r);
    if (err) return { ok: false, message: err };
  }
  if (opts.disk === 'shared' && !sim.unlocks.has('storage')) return { ok: false, message: `投資の「${UNLOCK_BY_ID.storage.name}」が必要です` };
  if (opts.k8s && !sim.unlocks.has('kubernetes')) return { ok: false, message: `投資の「${UNLOCK_BY_ID.kubernetes.name}」が必要です` };
  const vm = sim.facility.createVm(host, size, { roles: opts.k8s ? [] : opts.roles, disk: opts.disk, k8s: opts.k8s });
  if (opts.k8s) sim.schedule();
  sim.refreshFlow();
  const where = sim.facility.devices.get(host)!.name;
  return { ok: true, id: vm.id, message: `${vm.name}(${VIRT.sizes[size].label})を ${where} に作りました${opts.k8s ? '(Kubernetes のワーカー)' : ''}` };
}

export function createVm(sim: Simulation, host: number, size: VmSize): ActionResult {
  const err = sim.facility.vmPlaceError(host, size);
  if (err) return { ok: false, message: err };
  const vm = sim.facility.createVm(host, size);
  sim.refreshFlow();
  return { ok: true, id: vm.id, message: `${vm.name}(${VIRT.sizes[size].label})を作りました` };
}

export function deleteVm(sim: Simulation, id: number): ActionResult {
  const vm = sim.facility.vms.get(id);
  if (!vm) return { ok: false, message: 'VM が見つかりません' };
  sim.facility.removeVm(id);
  if (vm.k8s) sim.schedule();
  sim.refreshFlow();
  return { ok: true, message: `${vm.name} を消しました` };
}

export function vmMoveInfo(sim: Simulation, id: number, host: number): { error: string | null; downtimeMs: number } {
  const vm = sim.facility.vms.get(id);
  if (!vm) return { error: 'VM が見つかりません', downtimeMs: 0 };
  if (vm.host === host) return { error: 'すでにそのホストにいます', downtimeMs: 0 };
  if (vm.downUntil > sim.time) return { error: '移している途中です', downtimeMs: 0 };
  return {
    error: sim.facility.vmPlaceError(host, vm.size, id),
    downtimeMs: vm.disk === 'shared' ? 0 : VIRT.migrateDowntimeMs,
  };
}

export function moveVm(sim: Simulation, id: number, host: number): ActionResult {
  const { error, downtimeMs } = sim.vmMoveInfo(id, host);
  if (error) return { ok: false, message: error };
  const vm = sim.facility.vms.get(id)!;
  sim.facility.moveVm(id, host, sim.time + downtimeMs);
  sim.refreshFlow();
  const to = sim.facility.devices.get(host)!.name;
  return {
    ok: true,
    message: downtimeMs
      ? `${vm.name} を ${to} へ移しています(ディスクのコピーで ${downtimeMs / 1000} 秒止まります)`
      : `${vm.name} を ${to} へライブマイグレーションしました`,
  };
}

export function vmRoleError(sim: Simulation, id: number, role: RoleKey): string | null {
  const vm = sim.facility.vms.get(id);
  if (!vm) return 'VM が見つかりません';
  if (vm.k8s) return 'Kubernetes のワーカーには役割を付けられません(Pod が自動で置かれます)';
  return sim.roleUnlockError(role);
}

export function toggleVmRole(sim: Simulation, id: number, role: RoleKey): ActionResult {
  const vm = sim.facility.vms.get(id);
  const err = sim.vmRoleError(id, role);
  if (!vm || err) return { ok: false, message: err ?? 'VM が見つかりません' };
  sim.facility.setVmRoles(id, vm.roles.includes(role) ? vm.roles.filter((r) => r !== role) : [...vm.roles, role]);
  sim.refreshFlow();
  return { ok: true };
}

export function setVmDisk(sim: Simulation, id: number, disk: DiskKind): ActionResult {
  const vm = sim.facility.vms.get(id);
  if (!vm) return { ok: false, message: 'VM が見つかりません' };
  if (disk === 'shared' && !sim.unlocks.has('storage')) {
    return { ok: false, message: `投資の「${UNLOCK_BY_ID.storage.name}」が必要です` };
  }
  sim.facility.setVmDisk(id, disk);
  sim.refreshFlow();
  return {
    ok: true,
    message: disk === 'shared' ? `${vm.name} のディスクを共有ストレージへ移しました` : `${vm.name} のディスクをローカルへ戻しました`,
  };
}
