/** 役割を動かすノード(物理サーバ・VM・Pod のまとまり・LB アプライアンス)の一覧を作る */
import { MODEL_BY_ID, specOf } from '../catalog';
import { K8S, VIRT } from '../config';
import { splitRole } from '../types';
import type { Facility } from '../facility';
import type { ComputeNode, PodGroup } from './types';

/**
 * 役割を動かすノードの一覧。ハイパーバイザにしたサーバは自分では役割を持たず、載っている VM がノードになる。
 * Kubernetes のワーカー(サーバか VM)は役割を持たないノードとして残り、その上の Pod のまとまりがノードになる
 */
export function computeNodes(
  facility: Facility,
  now: number,
  down: ReadonlySet<number> = new Set(),
  pods: readonly PodGroup[] = [],
  bgp = false,
): ComputeNode[] {
  const nodes: ComputeNode[] = [];
  const servers = [...facility.devices.values()].filter((d) => MODEL_BY_ID[d.model].category === 'server').sort((a, b) => a.id - b.id);
  for (const d of servers) {
    if (d.hv || down.has(d.id)) continue;
    const m = specOf(d);
    nodes.push({
      id: d.id,
      name: d.name,
      host: d.id,
      cores: m.cores,
      coreSpeed: m.coreSpeed,
      memGB: m.memGB,
      roles: d.roles,
      vm: false,
      disk: 'local',
      gpus: m.gpus,
    });
  }
  for (const v of [...facility.vms.values()].sort((a, b) => a.id - b.id)) {
    const host = facility.devices.get(v.host);
    if (!host?.hv || v.downUntil > now || down.has(host.id)) continue;
    const size = VIRT.sizes[v.size];
    nodes.push({
      id: -v.id,
      name: v.name,
      host: host.id,
      cores: size.vcpu,
      coreSpeed: specOf(host).coreSpeed,
      memGB: size.memGB,
      roles: v.roles,
      vm: true,
      disk: v.disk,
    });
  }
  // LB アプライアンス(動いているもの)。処理能力を 1 コアとして、1 リクエストの重さを lbRps から決める
  for (const d of [...facility.devices.values()].sort((a, b) => a.id - b.id)) {
    const m = MODEL_BY_ID[d.model];
    if (m.category !== 'lb' || down.has(d.id)) continue;
    nodes.push({ id: d.id, name: d.name, host: d.id, cores: 1, coreSpeed: 1, memGB: 0, roles: [], vm: false, disk: 'local', lbRps: m.lbRps });
  }
  // Pod: ワーカーが動いていれば、ワーカーのノードの上に置く
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const p of pods) {
    const w = byId.get(p.worker);
    if (!w || p.count <= 0) continue;
    const hostDev = facility.devices.get(w.host)!;
    const [, role] = splitRole(p.role);
    nodes.push({
      id: p.id,
      name: `${w.name} の ${role} Pod×${p.count}`,
      host: w.host,
      cores: p.count * K8S.pod.vcpu,
      coreSpeed: w.coreSpeed,
      memGB: p.count * K8S.pod.memGB,
      roles: [p.role],
      vm: false,
      disk: w.disk,
      parent: w.id,
      pods: p.count,
      // MetalLB: BGP を使うワーカー(ハイパーバイザの上の VM は自動)の Pod は、外へ広報できる
      advertised: bgp && (hostDev.bgp || hostDev.hv),
    });
  }
  // VM と Pod は、載っているサーバの GPU を使える
  return nodes.map((n) => (n.gpus !== undefined ? n : { ...n, gpus: specOf(facility.devices.get(n.host)!).gpus }));
}

/** ノード(機器 ID か −VM ID)の名前 */
export function nodeName(f: Facility, id: number): string {
  if (id < 0) return f.vms.get(-id)?.name ?? '?';
  return f.devices.get(id)?.name ?? '?';
}
