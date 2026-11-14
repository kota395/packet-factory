/** Simulation の操作のうち、Kubernetes: ワーカー、Deployment、Pod の置き場所とオートスケール。Simulation のメソッドから呼ばれる */
import { MODEL_BY_ID, specOf } from './catalog';
import { K8S, scopeName, VIRT } from './config';
import { UNLOCK_BY_ID } from './economy';
import { POD_ID_BASE } from './flow';
import type { PodGroup } from './flow';
import { splitRole } from './types';
import type { RoleKey } from './types';
import type { ActionResult, Simulation } from './simulation';

export function k8sWorkerError(sim: Simulation, target: { device?: number; vm?: number }, on: boolean): string | null {
  if (on && !sim.unlocks.has('kubernetes')) return `投資の「${UNLOCK_BY_ID.kubernetes.name}」が必要です`;
  if (target.vm !== undefined) return sim.facility.vms.has(target.vm) ? null : 'VM が見つかりません';
  const d = sim.facility.devices.get(target.device ?? -1);
  if (!d || MODEL_BY_ID[d.model].category !== 'server') return 'ワーカーにできるのはサーバか VM だけです';
  if (d.hv) return 'ハイパーバイザはワーカーにできません。VM をワーカーにしてください';
  return null;
}

export function setK8sWorker(sim: Simulation, target: { device?: number; vm?: number }, on: boolean): ActionResult {
  const err = sim.k8sWorkerError(target, on);
  if (err) return { ok: false, message: err };
  let label: string;
  if (target.vm !== undefined) {
    sim.facility.setVmK8s(target.vm, on);
    label = sim.facility.vms.get(target.vm)!.name;
  } else {
    sim.facility.setK8s(target.device!, on);
    label = sim.facility.devices.get(target.device!)!.name;
  }
  sim.schedule();
  sim.refreshFlow();
  return { ok: true, message: `${label} を${on ? 'Kubernetes のワーカーにしました' : 'ワーカーから外しました'}` };
}

export function deploymentError(sim: Simulation, key: RoleKey): string | null {
  if (!sim.unlocks.has('kubernetes')) return `投資の「${UNLOCK_BY_ID.kubernetes.name}」が必要です`;
  const [, role] = splitRole(key);
  if (!K8S.roles.includes(role)) return `${role} は状態を持つので、Pod ではなくサーバか VM で動かします`;
  return sim.roleUnlockError(key);
}

export function toggleDeployment(sim: Simulation, key: RoleKey): ActionResult {
  if (sim.deployments.has(key)) {
    sim.deployments.delete(key);
    sim.podsPending.delete(key);
  } else {
    const err = sim.deploymentError(key);
    if (err) return { ok: false, message: err };
    sim.deployments.set(key, K8S.minPods);
  }
  sim.schedule();
  sim.purchaseVersion++;
  sim.refreshFlow();
  const [s, r] = splitRole(key);
  return {
    ok: true,
    message: `${scopeName(s)}の ${r} を${sim.deployments.has(key) ? 'Deployment にしました(Pod は自動で増減します)' : 'Deployment から外しました'}`,
  };
}

export function k8sCapacity(sim: Simulation): { workers: number; vcpu: number; pods: number; pending: number } {
  const w = k8sWorkers(sim);
  return {
    workers: w.length,
    vcpu: w.reduce((s, x) => s + x.vcpu, 0),
    pods: sim.pods.reduce((s, p) => s + p.count, 0),
    pending: [...sim.podsPending.values()].reduce((s, n) => s + n, 0),
  };
}

/** ワーカー(動いているもの)と、Pod に使える CPU・メモリ */
export function k8sWorkers(sim: Simulation): { node: number; vcpu: number; memGB: number }[] {
  const down = sim.downDevices;
  const out: { node: number; vcpu: number; memGB: number }[] = [];
  for (const d of [...sim.facility.devices.values()].sort((a, b) => a.id - b.id)) {
    if (!d.k8s || d.hv || down.has(d.id)) continue;
    const m = specOf(d);
    out.push({ node: d.id, vcpu: m.cores, memGB: m.memGB - K8S.systemMemGB });
  }
  for (const v of [...sim.facility.vms.values()].sort((a, b) => a.id - b.id)) {
    if (!v.k8s || v.downUntil > sim.time || down.has(v.host)) continue;
    const z = VIRT.sizes[v.size];
    out.push({ node: -v.id, vcpu: z.vcpu, memGB: z.memGB - K8S.systemMemGB });
  }
  return out;
}

export function schedule(sim: Simulation): void {
  const { pods, pending } = placePods(sim, sim.deployments);
  sim.podsPending.clear();
  for (const [key, n] of pending) sim.podsPending.set(key, n);
  const sig = (list: PodGroup[]) => list.map((p) => `${p.worker}${p.role}${p.count}`).join();
  if (sig(pods) !== sig(sim.pods)) sim.podVersion++;
  sim.pods = pods;
}

/** Deployment ごとの Pod の数から、置き場所を決める(状態は変えない) */
export function placePods(sim: Simulation, counts: ReadonlyMap<RoleKey, number>): { pods: PodGroup[]; pending: Map<RoleKey, number> } {
  const workers = k8sWorkers(sim).map((w) => ({ ...w, freeCpu: w.vcpu, freeMem: w.memGB }));
  const placed = new Map<string, number>();
  const pending = new Map<RoleKey, number>();
  for (const [key, count] of counts) {
    if (sim.deploymentError(key)) continue;
    for (let i = 0; i < count; i++) {
      let best: (typeof workers)[number] | null = null;
      for (const w of workers) {
        if (w.freeCpu < K8S.pod.vcpu || w.freeMem < K8S.pod.memGB) continue;
        if (!best || w.freeCpu > best.freeCpu) best = w;
      }
      if (!best) {
        pending.set(key, count - i);
        break;
      }
      best.freeCpu -= K8S.pod.vcpu;
      best.freeMem -= K8S.pod.memGB;
      const k = `${best.node}|${key}`;
      placed.set(k, (placed.get(k) ?? 0) + 1);
    }
  }
  let id = POD_ID_BASE;
  const pods: PodGroup[] = [];
  for (const [k, count] of placed) {
    const [worker, role] = k.split('|');
    pods.push({ id: id++, worker: Number(worker), role: role as RoleKey, count });
  }
  return { pods, pending };
}

/**
 * オートスケールでワーカーを使い切ったときの Pod の置き方(キャパシティの見積もり用)。
 * いまの Pod の数の比のまま、ワーカーに載るだけ増やす
 */
export function podsAtFullScale(sim: Simulation): PodGroup[] {
  const counts = [...sim.deployments].filter(([key]) => !sim.deploymentError(key));
  const total = counts.reduce((n, [, c]) => n + c, 0);
  if (!total) return sim.pods;
  const slots = k8sWorkers(sim).reduce((n, w) => n + Math.max(0, Math.min(Math.floor(w.vcpu / K8S.pod.vcpu), Math.floor(w.memGB / K8S.pod.memGB))), 0);
  const factor = Math.max(1, slots / total);
  return placePods(sim, new Map(counts.map(([key, c]) => [key, Math.min(K8S.maxPods, Math.floor(c * factor))]))).pods;
}

/** オートスケール(HPA): Deployment ごとに、Pod の CPU 使用率が目標になるよう数を変える */
export function autoscale(sim: Simulation): void {
  for (const [key, current] of sim.deployments) {
    let used = 0;
    let cores = 0;
    for (const n of sim.flow.nodes.values()) {
      if (n.pods === undefined || !n.roles.includes(key)) continue;
      used += sim.flow.nodeLoads.get(n.id)!.cpu * n.cores;
      cores += n.cores;
    }
    if (!cores) continue;
    const util = used / cores;
    let desired = Math.ceil((current * util) / K8S.targetCpu);
    if (desired < current) desired = Math.max(desired, current - Math.max(1, Math.floor(current * K8S.scaleDownRate)));
    sim.deployments.set(key, Math.min(K8S.maxPods, Math.max(K8S.minPods, desired)));
  }
  sim.schedule();
}
