/**
 * 台帳: 1 回の流量計算のあいだ、ノード・機器・リンクに負荷を積んでいく。
 * 積み終えて settle() を呼ぶと、使用率から「溢れずに通る割合」と「かかる時間」を引ける。
 */
import { MODEL_BY_ID, specOf } from '../catalog';
import { GPU, NET, ROLE_MEM_GB, SERVICES, VIRT, WORK } from '../config';
import { splitRole } from '../types';
import type { Facility } from '../facility';
import type { RoleId, RoleKey } from '../types';
import type { DeviceLoad, FlowInput, LinkLoad, NodeLoad, Route } from './types';
import { graphOf, lbGroups, routeOf } from './network';
import { computeNodes, nodeName } from './nodes';
import { GB_PER_KB, avg, pass, q } from './math';

/** サーバのメモリの残りをキャッシュに使う役割(同じノードに複数あれば分け合う) */
const CACHE_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(['db', 'replica', 'search', 'media']);

export type Ledger = ReturnType<typeof createLedger>;

export function createLedger(facility: Facility, input: FlowInput) {
  const g = graphOf(facility, input);
  const devices = new Map<number, DeviceLoad>();
  for (const d of facility.devices.values()) devices.set(d.id, { cpu: 0, io: 0, fabric: 0, gpu: 0, gbps: 0 });
  const problems: string[] = [];
  // ---- ノード
  const nodeList = computeNodes(facility, input.now, input.down, input.pods ?? [], input.bgp);
  const nodes = new Map(nodeList.map((n) => [n.id, n]));
  const name = (id: number) => nodes.get(id)?.name ?? nodeName(facility, id);
  for (const d of facility.devices.values()) {
    if (input.down.has(d.id)) problems.push(`${d.name} は止まっています`);
  }
  for (const v of facility.vms.values()) {
    if (v.downUntil > input.now) problems.push(`${v.name} は別のホストへ移している途中で止まっています`);
  }
  const loads = new Map<number, NodeLoad>(nodeList.map((n) => [n.id, { cpu: 0, io: 0, ioOps: 0, work: {}, miss: {} }]));
  // 回線終端(回線を増やしていれば複数。BGP で、届く回線に均等に分かれる)
  const handoffs = [...facility.devices.values()]
    .filter((d) => MODEL_BY_ID[d.model].category === 'handoff' && !input.down.has(d.id) && g.adj.has(d.id))
    .sort((a, b) => a.id - b.id);
  if (!handoffs.length) problems.push('回線終端にケーブルがつながっていません');
  const activeServices = new Set(input.services.map((s) => s.id));
  /** その役割が今動いているか(サービスが始まっていて、役割が解放済み) */
  const isActive = (k: RoleKey) => {
    const [s, r] = splitRole(k);
    if (s === 'data') return !!input.analytics?.hadoop && input.roles.has(r);
    return activeServices.has(s) && SERVICES[s].roles.includes(r) && input.roles.has(r);
  };

  const hostOf = (id: number) => nodes.get(id)!.host;
  // 同じ 2 台の経路は 1 回の計算の中で何度も引くので、数値のキーで覚えておく(文字列のキーを作り直さない)
  const routeMemo = new Map<number, Route | null>();
  const route = (a: number, b: number) => {
    const k = a * 0x100000 + b;
    let r = routeMemo.get(k);
    if (r === undefined) {
      r = routeOf(facility, g, input, a, b);
      routeMemo.set(k, r);
    }
    return r;
  };
  const path = (a: number, b: number) => route(hostOf(a), hostOf(b));

  /** 機器の間の通信を経路に積む。届かなければ null */
  const sendDev = (src: number, dst: number, fwdGbps: number, backGbps: number): Route | null => {
    const r = route(src, dst);
    if (!r) return null;
    for (const e of r.edges) {
      if (e.forward) {
        e.link.ab += fwdGbps * e.frac;
        e.link.ba += backGbps * e.frac;
      } else {
        e.link.ba += fwdGbps * e.frac;
        e.link.ab += backGbps * e.frac;
      }
    }
    if (r.edges.length) {
      devices.get(src)!.gbps += fwdGbps + backGbps;
      devices.get(dst)!.gbps += fwdGbps + backGbps;
    }
    for (const t of r.transit) {
      devices.get(t.id)!.gbps += (fwdGbps + backGbps) * t.frac;
      devices.get(t.id)!.fabric += (fwdGbps + backGbps) * t.frac;
    }
    return r;
  };
  /** ノードの間の通信(同じホストの VM 同士ならネットワークを通らない) */
  const send = (a: number, b: number, fwdGbps: number, backGbps: number) => sendDev(hostOf(a), hostOf(b), fwdGbps, backGbps);
  /** そのノードに届く回線 */
  const linesTo = (id: number) => handoffs.filter((h) => route(h.id, hostOf(id)));
  /** 回線から(へ)の通信。届く回線に均等に分ける */
  const fromNet = (id: number, inGbps: number, outGbps: number) => {
    const lines = linesTo(id);
    for (const h of lines) sendDev(h.id, hostOf(id), inGbps / lines.length, outGbps / lines.length);
  };
  /** 回線からノードまでを通って溢れない割合と時間(届く回線の平均) */
  const fromNetAlong = (id: number): [number, number] => {
    const lines = linesTo(id);
    if (!lines.length) return [0, 0];
    const parts = lines.map((h) => along(route(h.id, hostOf(id))));
    return [avg(parts.map((x) => x[0])), avg(parts.map((x) => x[1]))];
  };

  /** CPU の仕事を積む。Pod ならワーカーにも、VM(か VM の上の Pod)ならホストの CPU にも(仮想化のオーバーヘッド込みで) */
  const addCpu = (id: number, perSec: number, cpuMs: number) => {
    const n = nodes.get(id)!;
    loads.get(id)!.cpu += (perSec * cpuMs) / (n.coreSpeed * n.cores * 1000);
    const parent = n.parent !== undefined ? nodes.get(n.parent)! : null;
    if (parent) loads.get(parent.id)!.cpu += (perSec * cpuMs) / (parent.coreSpeed * parent.cores * 1000);
    const virtual = n.vm || !!parent?.vm;
    const host = specOf(facility.devices.get(n.host)!);
    devices.get(n.host)!.cpu += (perSec * cpuMs * (virtual ? VIRT.cpuOverhead : 1)) / (host.coreSpeed * host.cores * 1000);
  };
  /** ノードの CPU の使用率(Pod ならワーカー、VM ならホストも含めて一番高いもの) */
  const cpuRho = (id: number) => {
    const n = nodes.get(id)!;
    let rho = Math.max(loads.get(id)!.cpu, devices.get(n.host)!.cpu);
    if (n.parent !== undefined) rho = Math.max(rho, loads.get(n.parent)!.cpu);
    return rho;
  };
  const addWork = (id: number, key: RoleKey, perSec: number, cpuMs: number) => {
    const l = loads.get(id)!;
    l.work[key] = (l.work[key] ?? 0) + perSec;
    addCpu(id, perSec, cpuMs);
  };
  /** GPU の仕事を積む(受け渡しの CPU も少し) */
  const addGpuWork = (id: number, key: RoleKey, perSec: number, gpuMs: number) => {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    l.work[key] = (l.work[key] ?? 0) + perSec;
    const rho = (perSec * gpuMs) / (n.gpus! * 1000);
    l.gpu = (l.gpu ?? 0) + rho;
    devices.get(n.host)!.gpu += rho;
    addCpu(id, perSec, gpuMs * GPU.cpuShare);
  };
  const hasGpu = (id: number) => (nodes.get(id)!.gpus ?? 0) > 0;

  // 共有ディスクの VM は、届くストレージに IO を出す
  const storages = [...facility.devices.values()].filter((d) => MODEL_BY_ID[d.model].category === 'storage');
  for (const n of nodeList) {
    if (n.disk !== 'shared') continue;
    const s = storages.find((st) => !input.down.has(st.id) && route(n.host, st.id));
    loads.get(n.id)!.storage = s?.id ?? null;
    if (!s) problems.push(`${n.name} のディスクは共有ストレージにありますが、ストレージに届きません`);
  }
  const addIo = (id: number, ops: number) => {
    if (!ops) return;
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    l.ioOps += ops;
    if (n.disk === 'local') {
      devices.get(n.host)!.io += ops / specOf(facility.devices.get(n.host)!).diskIops;
    } else if (l.storage != null) {
      devices.get(l.storage)!.io += ops / specOf(facility.devices.get(l.storage)!).diskIops;
      const gb = ops * VIRT.storageIoKB * GB_PER_KB * 0.5;
      sendDev(n.host, l.storage, gb, gb);
    }
  };
  /** メモリに乗らずディスクに行く読み込みの割合。キャッシュに使える残りのメモリは、同じノードの db・search・media などで分け合う */
  const missOf = (id: number, key: RoleKey, perGB: number) => {
    const n = nodes.get(id)!;
    const act = n.roles.filter(isActive);
    if (!act.includes(key)) act.push(key);
    const used = act.reduce((s, k) => s + ROLE_MEM_GB[splitRole(k)[1]], 0);
    const sharers = Math.max(1, act.filter((k) => CACHE_ROLES.has(splitRole(k)[1])).length);
    const mem = Math.max(0.5, (n.memGB - used) / sharers);
    const miss = Math.min(1, Math.max(WORK.dbMissMin, perGB / mem));
    loads.get(id)!.miss[key] = miss;
    return miss;
  };

  // ---- LB アプライアンス: HA ペアはアクティブの 1 台だけが受ける
  const groups = lbGroups(facility, input.down);
  const activeLbs = groups.filter((gr) => gr.active !== null && nodes.has(gr.active)).map((gr) => gr.active!);
  const deadLbs = groups.filter((gr) => gr.active === null).length;
  for (const gr of groups) {
    const names = gr.members.map(name).join('・');
    if (gr.active === null) problems.push(`LB(${names})が止まっていて、そこに来たリクエストが失敗しています`);
    else if (gr.members.length > 1 && gr.active !== gr.members[0]) problems.push(`${name(gr.members[0])} が止まり、HA で ${name(gr.active)} が引き継いでいます`);
  }
  /** LB で 1 リクエストを振り分ける重さ(アプライアンスは処理能力から) */
  const lbMs = (id: number) => {
    const rps = nodes.get(id)?.lbRps;
    return rps ? 1000 / rps : WORK.lbCpuMs;
  };

  // ---- 使用率から、溢れずに通る割合と遅延
  const linkRho = (l: LinkLoad) => (l.capacityGbps > 0 ? Math.max(l.ab, l.ba) / l.capacityGbps : Infinity);
  /** 経路を通って溢れない割合と、通るのにかかる時間(ms) */
  // 経路ごとの結果は、負荷が決まったあとは変わらないので覚えておく(web × db の組み合わせで何度も通る)
  const alongMemo = new Map<Route, [number, number]>();
  function along(p: Route | null | undefined): [number, number] {
    if (!p) return [0, 0];
    const memo = alongMemo.get(p);
    if (memo) return memo;
    let ok = 1;
    let ms = 0;
    // ECMP で分かれた経路は、通る割合で重みを付ける
    for (const e of p.edges) {
      const rho = linkRho(e.link);
      ok *= pass(rho) ** e.frac;
      ms += NET.hopMs * q(rho) * e.frac;
    }
    for (const t of p.transit) {
      const rho = devices.get(t.id)!.fabric;
      ok *= pass(rho) ** t.frac;
      ms += NET.hopMs * q(rho) * t.frac;
    }
    const out: [number, number] = [ok, ms];
    alongMemo.set(p, out);
    return out;
  }
  /** ノードが溢れずに処理できる割合(自分の CPU・ホストの CPU・ディスク、共有ディスクならストレージへの経路も) */
  function nodePass(id: number): number {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    // GPU は同じサーバの VM・Pod で分け合うので、サーバ全体の使用率で見る
    let ok = pass(Math.max(cpuRho(id), l.io, l.gpu !== undefined ? devices.get(n.host)!.gpu : 0));
    if (n.disk === 'shared') ok *= l.storage != null ? along(route(n.host, l.storage))[0] : 0;
    return ok;
  }
  function cpuMs(id: number, ms: number): number {
    const n = nodes.get(id)!;
    return (ms / n.coreSpeed) * q(cpuRho(id));
  }
  /** ディスク IO 1 回の待ち時間 */
  function ioMs(id: number): number {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    if (n.disk === 'local') return WORK.diskMs * q(l.io);
    if (l.storage == null) return 0;
    return VIRT.storageMs * q(l.io) + along(route(n.host, l.storage))[1];
  }
  /** 回線を通って利用者に届くまでの時間 */
  function transferMs(kb: number): number {
    return ((kb * 8) / (input.uplinkGbps * 1000)) * q(uplinkRho);
  }

  /** 負荷を積み終えたら呼ぶ: スイッチの処理能力とディスクの使用率を確定する(このあと along・nodePass などが使える) */
  let uplinkRho = 0;
  const settle = () => {
    for (const d of facility.devices.values()) {
      const m = MODEL_BY_ID[d.model];
      const l = devices.get(d.id)!;
      l.fabric = m.fabricGbps ? l.fabric / m.fabricGbps : 0;
    }
    for (const n of nodeList) {
      const l = loads.get(n.id)!;
      if (n.disk === 'local') l.io = devices.get(n.host)!.io;
      else l.io = l.storage != null ? devices.get(l.storage)!.io : 0;
    }
    const handoffLinks = handoffs.flatMap((h) => [...(g.adj.get(h.id)?.values() ?? [])]);
    uplinkRho = handoffLinks.length ? Math.max(...handoffLinks.map(linkRho)) : 0;
  };

  return {
    facility,
    input,
    g,
    devices,
    problems,
    nodeList,
    nodes,
    name,
    loads,
    handoffs,
    isActive,
    hostOf,
    route,
    path,
    sendDev,
    send,
    linesTo,
    fromNet,
    fromNetAlong,
    addCpu,
    cpuRho,
    addWork,
    addGpuWork,
    hasGpu,
    addIo,
    missOf,
    activeLbs,
    deadLbs,
    lbMs,
    settle,
    linkRho,
    along,
    nodePass,
    cpuMs,
    ioMs,
    transferMs,
  };
}
