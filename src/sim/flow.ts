/**
 * 流量モデル。ページビュー/秒と、機器・配線・役割から、各資源の使用率と成功率・応答時間を求める。
 * パケットを 1 個ずつ流す代わりに、流量の合計で計算するので機器が増えても軽い。
 *
 * 1 ページビューの流れ: 回線 → (LB) → web → (cache) → db / レプリカ
 * 通信はケーブルとスイッチを通り、通った資源の使用率が 1 を超えるとその分が溢れてエラーになる。
 *
 * 役割を動かす単位(ノード)は物理サーバか VM。VM はホストの CPU を分け合い、通信はホストの NIC から出入りする。
 * VM のディスクは、ホストのローカルディスクか共有ストレージ(ネットワーク越しの IO)に置く。
 */
import { MODEL_BY_ID, portsOf } from './catalog';
import { BLOG, MAX_QUEUE_RHO, NET, P99_FACTOR, REPLICATION, ROLE_MEM_GB, VIRT } from './config';
import type { Facility } from './facility';
import type { DiskKind, RoleId } from './types';

export interface FlowInput {
  readonly pv: number;
  readonly uplinkGbps: number;
  readonly images: boolean;
  readonly comments: boolean;
  /** 解放済みの役割 */
  readonly roles: ReadonlySet<RoleId>;
  /** シミュレーション時刻(移行中の VM を除くのに使う) */
  readonly now: number;
}

/** 役割を動かす単位。物理サーバは機器 ID(正の数)、VM は −VM ID(負の数) */
export interface ComputeNode {
  readonly id: number;
  readonly name: string;
  /** 通信の出入りに使う物理機器(VM ならホスト) */
  readonly host: number;
  readonly cores: number;
  readonly coreSpeed: number;
  readonly memGB: number;
  readonly roles: readonly RoleId[];
  readonly vm: boolean;
  readonly disk: DiskKind;
}

export interface NodeLoad {
  /** CPU(VM なら割り当てた vCPU)の使用率 */
  cpu: number;
  /** ディスク(ローカルならホストのディスク、共有ならストレージ)の使用率 */
  io: number;
  /** このノードが出しているディスク IO(回/秒) */
  ioOps: number;
  work: Partial<Record<RoleId, number>>;
  /** db・レプリカの読み込みがディスクに行く割合 */
  dbMiss?: number;
  /** 共有ディスクに使っているストレージ(機器 ID)。届かなければ null */
  storage?: number | null;
}

export interface DeviceLoad {
  /** CPU・ディスク IO(ストレージは IOPS)・スイッチの処理能力の使用率(0〜、1 超えは溢れ)。VM のホストは VM の合計 */
  cpu: number;
  io: number;
  fabric: number;
  /** この機器を通る(出入りする)通信量(Gbps) */
  gbps: number;
}

/** 2 台の機器の間のリンク(複数のケーブルはまとめて 1 本として扱う) */
export interface LinkLoad {
  readonly a: number;
  readonly b: number;
  readonly capacityGbps: number;
  readonly cables: number[];
  /** a → b と b → a の流量(Gbps) */
  ab: number;
  ba: number;
}

export interface Bottleneck {
  readonly label: string;
  readonly rho: number;
}

export interface FlowResult {
  readonly pv: number;
  /** 成功する割合(0〜1) */
  readonly success: number;
  readonly latencyMs: number;
  readonly p99Ms: number;
  readonly devices: Map<number, DeviceLoad>;
  readonly links: LinkLoad[];
  /** ケーブルごとの使用率 */
  readonly cableRho: Map<number, number>;
  /** 役割を動かしているノード(物理サーバと VM)と、その負荷 */
  readonly nodes: Map<number, ComputeNode>;
  readonly nodeLoads: Map<number, NodeLoad>;
  /** 役割ごとに実際に使われているノード */
  readonly instances: Record<RoleId, number[]>;
  /** インターネットから最初に受けるノード */
  readonly entries: number[];
  /** 未接続・役割の不足などの警告 */
  readonly problems: string[];
  /** 一番使用率の高い資源 */
  readonly bottleneck: Bottleneck | null;
}

const GB_PER_KB = 8e-6;
const q = (rho: number) => 1 / (1 - Math.min(rho, MAX_QUEUE_RHO));
/** 使用率 rho の資源を通って溢れずに済む割合 */
const pass = (rho: number) => (rho <= 1 ? 1 : 1 / rho);

// ---------------------------------------------------------------- ネットワーク

interface Graph {
  readonly key: string;
  readonly adj: Map<number, Map<number, LinkLoad>>;
  readonly links: LinkLoad[];
  readonly paths: Map<string, number[] | null>;
}

let cachedGraph: { facility: Facility; graph: Graph } | null = null;

/** 機器とケーブルからリンクのグラフを作る。配線と回線契約が変わらない間は使い回す */
function graphOf(facility: Facility, uplinkGbps: number): Graph {
  const key = `${facility.version}@${uplinkGbps}`;
  if (cachedGraph?.facility === facility && cachedGraph.graph.key === key) return resetGraph(cachedGraph.graph);
  const adj = new Map<number, Map<number, LinkLoad>>();
  const links: LinkLoad[] = [];
  const speedOf = (device: number, port: number) => {
    const d = facility.devices.get(device)!;
    const p = portsOf(d.model)[port];
    return MODEL_BY_ID[d.model].category === 'handoff' ? uplinkGbps : p.speedGbps;
  };
  for (const c of facility.cables.values()) {
    const [a, b] = c.a.device < c.b.device ? [c.a, c.b] : [c.b, c.a];
    const speed = Math.min(speedOf(a.device, a.port), speedOf(b.device, b.port));
    let link = adj.get(a.device)?.get(b.device);
    if (!link) {
      link = { a: a.device, b: b.device, capacityGbps: 0, cables: [], ab: 0, ba: 0 };
      links.push(link);
      if (!adj.has(a.device)) adj.set(a.device, new Map());
      if (!adj.has(b.device)) adj.set(b.device, new Map());
      adj.get(a.device)!.set(b.device, link);
      adj.get(b.device)!.set(a.device, link);
    }
    (link as { capacityGbps: number }).capacityGbps += speed;
    link.cables.push(c.id);
  }
  const graph: Graph = { key, adj, links, paths: new Map() };
  cachedGraph = { facility, graph };
  return graph;
}

function resetGraph(g: Graph): Graph {
  for (const l of g.links) {
    l.ab = 0;
    l.ba = 0;
  }
  return g;
}

/**
 * src から dst への経路(機器 ID の列)。スイッチだけが中継できる。
 * ホップ数が最短のもののうち、一番細いリンクが一番太いものを選ぶ。つながっていなければ null
 */
function pathOf(facility: Facility, g: Graph, src: number, dst: number): number[] | null {
  if (src === dst) return [src];
  const key = `${src}>${dst}`;
  const cached = g.paths.get(key);
  if (cached !== undefined) return cached;
  const dist = new Map<number, number>([[src, 0]]);
  const best = new Map<number, number>([[src, Infinity]]);
  const prev = new Map<number, number>();
  let frontier = [src];
  while (frontier.length && !dist.has(dst)) {
    const next: number[] = [];
    for (const u of frontier) {
      // 送り元以外で中継できるのはスイッチだけ
      if (u !== src && MODEL_BY_ID[facility.devices.get(u)!.model].category !== 'switch') continue;
      for (const [v, link] of g.adj.get(u) ?? []) {
        const d = dist.get(u)! + 1;
        const width = Math.min(best.get(u)!, link.capacityGbps);
        if (!dist.has(v)) {
          dist.set(v, d);
          best.set(v, width);
          prev.set(v, u);
          next.push(v);
        } else if (dist.get(v) === d && width > best.get(v)!) {
          best.set(v, width);
          prev.set(v, u);
        }
      }
    }
    frontier = next;
  }
  let path: number[] | null = null;
  if (dist.has(dst)) {
    path = [dst];
    while (path[0] !== src) path.unshift(prev.get(path[0])!);
  }
  g.paths.set(key, path);
  return path;
}

// ---------------------------------------------------------------- ノード

/** 役割を動かすノードの一覧。ハイパーバイザにしたサーバは自分では役割を持たず、載っている VM がノードになる */
export function computeNodes(facility: Facility, now: number): ComputeNode[] {
  const nodes: ComputeNode[] = [];
  const servers = [...facility.devices.values()]
    .filter((d) => MODEL_BY_ID[d.model].category === 'server')
    .sort((a, b) => a.id - b.id);
  for (const d of servers) {
    if (d.hv) continue;
    const m = MODEL_BY_ID[d.model];
    nodes.push({
      id: d.id,
      name: d.name,
      host: d.id,
      cores: m.cores!,
      coreSpeed: m.coreSpeed!,
      memGB: m.memGB!,
      roles: d.roles,
      vm: false,
      disk: 'local',
    });
  }
  for (const v of [...facility.vms.values()].sort((a, b) => a.id - b.id)) {
    const host = facility.devices.get(v.host);
    if (!host?.hv || v.downUntil > now) continue;
    const size = VIRT.sizes[v.size];
    nodes.push({
      id: -v.id,
      name: v.name,
      host: host.id,
      cores: size.vcpu,
      coreSpeed: MODEL_BY_ID[host.model].coreSpeed!,
      memGB: size.memGB,
      roles: v.roles,
      vm: true,
      disk: v.disk,
    });
  }
  return nodes;
}

/** ノード(機器 ID か −VM ID)の名前 */
export function nodeName(f: Facility, id: number): string {
  if (id < 0) return f.vms.get(-id)?.name ?? '?';
  return f.devices.get(id)?.name ?? '?';
}

// ---------------------------------------------------------------- 本体

export function computeFlow(facility: Facility, input: FlowInput): FlowResult {
  const g = graphOf(facility, input.uplinkGbps);
  const devices = new Map<number, DeviceLoad>();
  for (const d of facility.devices.values()) devices.set(d.id, { cpu: 0, io: 0, fabric: 0, gbps: 0 });
  const problems: string[] = [];
  const name = (id: number) => nodeName(facility, id);

  // ---- ノードと役割
  const nodeList = computeNodes(facility, input.now);
  const nodes = new Map(nodeList.map((n) => [n.id, n]));
  const loads = new Map<number, NodeLoad>(nodeList.map((n) => [n.id, { cpu: 0, io: 0, ioOps: 0, work: {} }]));
  const instances: Record<RoleId, number[]> = { lb: [], web: [], cache: [], db: [], replica: [] };
  for (const n of nodeList) for (const r of n.roles) if (input.roles.has(r)) instances[r].push(n.id);
  for (const v of facility.vms.values()) {
    if (v.downUntil > input.now) problems.push(`${v.name} は別のホストへ移している途中で止まっています`);
  }
  if (instances.db.length > 1) {
    problems.push(`db(プライマリ)は 1 台だけ使われます(${name(instances.db[0])})。読み込みを分けるならレプリカを使う`);
    instances.db = instances.db.slice(0, 1);
  }
  const handoff = [...facility.devices.values()].find((d) => MODEL_BY_ID[d.model].category === 'handoff');
  let entries: number[];
  const useLb = instances.lb.length > 0;
  if (useLb) entries = instances.lb;
  else {
    entries = instances.web.slice(0, 1);
    if (instances.web.length > 1) {
      problems.push(`LB がないので、インターネットから届くのは ${name(instances.web[0])} だけです(web を並べるには LB が要る)`);
    }
  }
  if (!handoff || !g.adj.has(handoff.id)) problems.push('回線終端にケーブルがつながっていません');
  if (!instances.web.length) problems.push('役割「web」のサーバがありません');
  if (!instances.db.length) problems.push('役割「db」のサーバがありません(ブログは db がないと表示できない)');

  // ---- 仕事量
  const pv = input.pv;
  const respKB = BLOG.pageKB + (input.images ? BLOG.imageKB : 0);
  const writes = input.comments ? BLOG.dbWrites : 0;
  const caches = instances.cache;
  const primary = instances.db[0];
  const webs = useLb ? instances.web : entries;
  const hostOf = (id: number) => nodes.get(id)!.host;
  const path = (a: number, b: number) => pathOf(facility, g, hostOf(a), hostOf(b));

  /** 機器の間の通信を経路に積む。届かなければ null */
  const sendDev = (src: number, dst: number, fwdGbps: number, backGbps: number): number[] | null => {
    const p = pathOf(facility, g, src, dst);
    if (!p) return null;
    for (let i = 0; i + 1 < p.length; i++) {
      const link = g.adj.get(p[i])!.get(p[i + 1])!;
      if (link.a === p[i]) {
        link.ab += fwdGbps;
        link.ba += backGbps;
      } else {
        link.ba += fwdGbps;
        link.ab += backGbps;
      }
    }
    if (p.length > 1) for (const id of p) devices.get(id)!.gbps += fwdGbps + backGbps;
    for (let i = 1; i + 1 < p.length; i++) devices.get(p[i])!.fabric += fwdGbps + backGbps;
    return p;
  };
  /** ノードの間の通信(同じホストの VM 同士ならネットワークを通らない) */
  const send = (a: number, b: number, fwdGbps: number, backGbps: number) => sendDev(hostOf(a), hostOf(b), fwdGbps, backGbps);

  const addWork = (id: number, role: RoleId, perSec: number, cpuMs: number) => {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    l.work[role] = (l.work[role] ?? 0) + perSec;
    l.cpu += (perSec * cpuMs) / (n.coreSpeed * n.cores * 1000);
    const host = MODEL_BY_ID[facility.devices.get(n.host)!.model];
    devices.get(n.host)!.cpu += (perSec * cpuMs * (n.vm ? VIRT.cpuOverhead : 1)) / (host.coreSpeed! * host.cores! * 1000);
  };

  // 共有ディスクの VM は、届くストレージに IO を出す
  const storages = [...facility.devices.values()].filter((d) => MODEL_BY_ID[d.model].category === 'storage');
  for (const n of nodeList) {
    if (n.disk !== 'shared') continue;
    const s = storages.find((st) => pathOf(facility, g, n.host, st.id));
    loads.get(n.id)!.storage = s?.id ?? null;
    if (!s) problems.push(`${n.name} のディスクは共有ストレージにありますが、ストレージに届きません`);
  }
  const addIo = (id: number, ops: number) => {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    l.ioOps += ops;
    if (n.disk === 'local') {
      devices.get(n.host)!.io += ops / MODEL_BY_ID[facility.devices.get(n.host)!.model].diskIops!;
    } else if (l.storage != null) {
      devices.get(l.storage)!.io += ops / MODEL_BY_ID[facility.devices.get(l.storage)!.model].diskIops!;
      const gb = ops * VIRT.storageIoKB * GB_PER_KB * 0.5;
      sendDev(n.host, l.storage, gb, gb);
    }
  };
  /** メモリに乗らずディスクに行く読み込みの割合 */
  const missOf = (id: number, role: RoleId) => {
    const n = nodes.get(id)!;
    const others = n.roles.filter((r) => r !== role && input.roles.has(r)).reduce((s, r) => s + ROLE_MEM_GB[r], 0);
    const mem = Math.max(0.5, n.memGB - others - ROLE_MEM_GB[role]);
    return Math.min(1, Math.max(BLOG.dbMissMin, BLOG.dbMissPerGB / mem));
  };

  // 経路は後で成功率と遅延を出すのに使う
  const entryPath = new Map<number, number[] | null>();
  const lbToWeb = new Map<string, number[] | null>();
  const webToDb = new Map<number, number[] | null>();
  const webToCache = new Map<number, { id: number; path: number[] }[]>();
  const webToReplica = new Map<number, { id: number; path: number[] }[]>();

  // ---- レプリカ: プライマリから届くものだけ使う
  const replicas = instances.replica.filter((r) => {
    if (primary === undefined) return false;
    if (path(primary, r)) return true;
    problems.push(`${name(r)}(レプリカ)に db から届かないので複製できず、使われません`);
    return false;
  });
  if (instances.replica.length && primary === undefined) problems.push('レプリカの複製元(db)がありません');

  const perEntry = entries.length ? pv / entries.length : 0;
  for (const e of entries) {
    entryPath.set(
      e,
      handoff ? sendDev(handoff.id, hostOf(e), perEntry * BLOG.requestKB * GB_PER_KB, perEntry * respKB * GB_PER_KB) : null,
    );
  }
  /** web ごとのページビュー/秒 */
  const pvOf = new Map<number, number>();
  if (useLb) {
    const perPair = webs.length ? perEntry / webs.length : 0;
    for (const e of entries) {
      addWork(e, 'lb', perEntry, BLOG.lbCpuMs);
      for (const w of webs) {
        lbToWeb.set(`${e}>${w}`, send(e, w, perPair * BLOG.requestKB * GB_PER_KB, perPair * respKB * GB_PER_KB));
        pvOf.set(w, (pvOf.get(w) ?? 0) + perPair);
      }
    }
  } else {
    for (const w of webs) pvOf.set(w, perEntry);
  }

  /** db 層への読み込み(ノードごと)と書き込みの合計 */
  const readsOn = new Map<number, number>();
  let totalWrites = 0;
  for (const w of webs) {
    const wpv = pvOf.get(w) ?? 0;
    addWork(w, 'web', wpv, BLOG.webCpuMs);
    const reads = wpv * BLOG.dbReads;
    // 届く memcached に読み込みを振り分け、外れた分は db 層へ
    const cacheReach: { id: number; path: number[] }[] = [];
    for (const c of caches) {
      const p = path(w, c);
      if (p) cacheReach.push({ id: c, path: p });
    }
    webToCache.set(w, cacheReach);
    for (const { id } of cacheReach) {
      const gets = reads / cacheReach.length;
      send(w, id, gets * BLOG.queryKB * GB_PER_KB, gets * BLOG.dbReadKB * GB_PER_KB);
      addWork(id, 'cache', gets, BLOG.cacheCpuMs);
    }
    const toDb = cacheReach.length ? reads * (1 - BLOG.cacheHitRate) : reads;
    const wr = wpv * writes;
    totalWrites += wr;
    // 読み込みはレプリカ(届くもの)に分け、なければプライマリ
    const repReach: { id: number; path: number[] }[] = [];
    for (const r of replicas) {
      const p = path(w, r);
      if (p) repReach.push({ id: r, path: p });
    }
    webToReplica.set(w, repReach);
    for (const { id } of repReach) {
      const n = toDb / repReach.length;
      send(w, id, n * BLOG.queryKB * GB_PER_KB, n * BLOG.dbReadKB * GB_PER_KB);
      readsOn.set(id, (readsOn.get(id) ?? 0) + n);
    }
    if (primary !== undefined) {
      const toPrimary = repReach.length ? 0 : toDb;
      webToDb.set(
        w,
        send(w, primary, (toPrimary * BLOG.queryKB + wr * BLOG.queryKB * 2) * GB_PER_KB, toPrimary * BLOG.dbReadKB * GB_PER_KB),
      );
      readsOn.set(primary, (readsOn.get(primary) ?? 0) + toPrimary);
    }
  }

  // ---- db とレプリカ: CPU と、メモリに乗らなかった読み込み・書き込みのディスク IO
  if (primary !== undefined) {
    const reads = readsOn.get(primary) ?? 0;
    const miss = missOf(primary, 'db');
    loads.get(primary)!.dbMiss = miss;
    addWork(primary, 'db', reads, BLOG.dbReadCpuMs);
    if (totalWrites) addWork(primary, 'db', totalWrites, BLOG.dbWriteCpuMs);
    addIo(primary, reads * miss + totalWrites * BLOG.dbWriteIo);
  }
  for (const r of replicas) {
    const reads = readsOn.get(r) ?? 0;
    const miss = missOf(r, 'replica');
    loads.get(r)!.dbMiss = miss;
    addWork(r, 'replica', reads, BLOG.dbReadCpuMs);
    // 書き込みはすべてのレプリカに複製され、反映にも CPU と IO を使う
    if (totalWrites) {
      const n = nodes.get(r)!;
      loads.get(r)!.cpu += (totalWrites * BLOG.dbWriteCpuMs * REPLICATION.applyCpu) / (n.coreSpeed * n.cores * 1000);
      const host = MODEL_BY_ID[facility.devices.get(n.host)!.model];
      devices.get(n.host)!.cpu +=
        (totalWrites * BLOG.dbWriteCpuMs * REPLICATION.applyCpu * (n.vm ? VIRT.cpuOverhead : 1)) /
        (host.coreSpeed! * host.cores! * 1000);
      send(primary!, r, totalWrites * BLOG.queryKB * 2 * GB_PER_KB, 0);
    }
    addIo(r, reads * miss + totalWrites * BLOG.dbWriteIo * REPLICATION.applyIo);
  }

  // ---- スイッチの処理能力と、ディスクの使用率
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

  // ---- 使用率から、溢れずに通る割合と遅延
  const linkRho = (l: LinkLoad) => (l.capacityGbps > 0 ? Math.max(l.ab, l.ba) / l.capacityGbps : Infinity);
  /** 経路を通って溢れない割合と、通るのにかかる時間(ms) */
  const along = (p: number[] | null | undefined): [number, number] => {
    if (!p) return [0, 0];
    let ok = 1;
    let ms = 0;
    for (let i = 0; i + 1 < p.length; i++) {
      const rho = linkRho(g.adj.get(p[i])!.get(p[i + 1])!);
      ok *= pass(rho);
      ms += NET.hopMs * q(rho);
    }
    for (let i = 1; i + 1 < p.length; i++) {
      const rho = devices.get(p[i])!.fabric;
      ok *= pass(rho);
      ms += NET.hopMs * q(rho);
    }
    return [ok, ms];
  };
  /** ノードが溢れずに処理できる割合(自分の CPU・ホストの CPU・ディスク、共有ディスクならストレージへの経路も) */
  const nodePass = (id: number) => {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    let ok = pass(Math.max(l.cpu, devices.get(n.host)!.cpu, l.io));
    if (n.disk === 'shared') ok *= l.storage != null ? along(pathOf(facility, g, n.host, l.storage))[0] : 0;
    return ok;
  };
  const cpuMs = (id: number, ms: number) => {
    const n = nodes.get(id)!;
    const cpu = Math.max(loads.get(id)!.cpu, devices.get(n.host)!.cpu);
    return (ms / n.coreSpeed) * q(cpu);
  };
  /** ディスク IO 1 回の待ち時間 */
  const ioMs = (id: number) => {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    if (n.disk === 'local') return BLOG.diskMs * q(l.io);
    if (l.storage == null) return 0;
    return VIRT.storageMs * q(l.io) + along(pathOf(facility, g, n.host, l.storage))[1];
  };
  const readOn = (id: number): number => cpuMs(id, BLOG.dbReadCpuMs) + (loads.get(id)!.dbMiss ?? 1) * ioMs(id);

  // db の部分(web ごと)
  const dataPart = (w: number): [number, number] => {
    if (primary === undefined && !replicas.length) return [0, 0];
    let primaryOk = 0;
    let primaryMs = 0;
    if (primary !== undefined) {
      const [netOk, netMs] = along(webToDb.get(w));
      primaryOk = netOk * nodePass(primary);
      primaryMs = netMs;
    }
    // 読み込み: レプリカに届けばレプリカ、なければプライマリ
    const reps = webToReplica.get(w) ?? [];
    let readOk = primaryOk;
    let readMs = primary !== undefined ? primaryMs + readOn(primary) : 0;
    if (reps.length) {
      readOk = 0;
      readMs = 0;
      for (const { id, path: p } of reps) {
        const [pOk, pMs] = along(p);
        readOk += (pOk * nodePass(id)) / reps.length;
        readMs += (pMs + readOn(id)) / reps.length;
      }
    }
    const cacheReach = webToCache.get(w) ?? [];
    if (cacheReach.length) {
      let cacheOk = 0;
      let cacheMs = 0;
      for (const { id, path: p } of cacheReach) {
        const [pOk, pMs] = along(p);
        cacheOk += (pOk * nodePass(id)) / cacheReach.length;
        cacheMs += (pMs + cpuMs(id, BLOG.cacheCpuMs)) / cacheReach.length;
      }
      readOk *= cacheOk;
      readMs = cacheMs + (1 - BLOG.cacheHitRate) * readMs;
    }
    // 書き込みはプライマリだけ。書き込むページの分だけ、プライマリが溢れると失敗する
    const writeShare = Math.min(1, writes);
    const ok = readOk * (1 - writeShare * (1 - primaryOk));
    const writeMs =
      primary !== undefined ? primaryMs + cpuMs(primary, BLOG.dbWriteCpuMs) + BLOG.dbWriteIo * ioMs(primary) : 0;
    return [ok, BLOG.dbReads * readMs + writes * writeMs];
  };

  const webPart = (w: number): [number, number] => {
    const [dOk, dMs] = dataPart(w);
    return [nodePass(w) * dOk, cpuMs(w, BLOG.webCpuMs) + dMs];
  };

  let success = 0;
  let latency = 0;
  const handoffLinks = handoff ? [...(g.adj.get(handoff.id)?.values() ?? [])] : [];
  const uplinkRho = handoffLinks.length ? Math.max(...handoffLinks.map(linkRho)) : 0;
  const transferMs = ((respKB * 8) / (input.uplinkGbps * 1000)) * q(uplinkRho);
  for (const e of entries) {
    const [inOk, inMs] = along(entryPath.get(e));
    let ok = 0;
    let ms = 0;
    if (useLb) {
      for (const w of webs) {
        const [pOk, pMs] = along(lbToWeb.get(`${e}>${w}`));
        const [wOk, wMs] = webPart(w);
        ok += (pOk * wOk) / webs.length;
        ms += (pMs + wMs) / webs.length;
      }
      ok *= nodePass(e);
      ms += cpuMs(e, BLOG.lbCpuMs);
    } else {
      [ok, ms] = webPart(e);
    }
    success += (inOk * ok) / entries.length;
    latency += (inMs + ms) / entries.length;
  }
  const latencyMs = NET.internetRttMs + transferMs + latency;

  // ---- 表示用: ケーブルごとの使用率と、一番詰まっている所
  const cableRho = new Map<number, number>();
  for (const l of g.links) for (const c of l.cables) cableRho.set(c, linkRho(l));
  let bottleneck: Bottleneck | null = null;
  const consider = (label: string, rho: number) => {
    if (rho > 0 && (!bottleneck || rho > bottleneck.rho)) bottleneck = { label, rho };
  };
  for (const d of facility.devices.values()) {
    const l = devices.get(d.id)!;
    const storage = MODEL_BY_ID[d.model].category === 'storage';
    consider(`${d.name} の CPU`, l.cpu);
    consider(storage ? `${d.name} の IOPS` : `${d.name} のディスク IO`, l.io);
    consider(`${d.name} の処理能力`, l.fabric);
  }
  for (const n of nodeList) if (n.vm) consider(`${n.name} の vCPU`, loads.get(n.id)!.cpu);
  for (const l of g.links) consider(`${name(l.a)} ⇄ ${name(l.b)} の帯域`, linkRho(l));

  // ---- 届かない所の警告
  for (const e of entries) {
    if (handoff && g.adj.has(handoff.id) && !entryPath.get(e)) problems.push(`回線から ${name(e)} への経路がありません`);
  }
  for (const [key, p] of lbToWeb) {
    if (!p) {
      const [a, b] = key.split('>').map(Number);
      problems.push(`${name(a)}(lb)から ${name(b)}(web)への経路がありません`);
    }
  }
  if (primary !== undefined) {
    for (const w of webs) if (!webToDb.get(w)) problems.push(`${name(w)}(web)から ${name(primary)}(db)への経路がありません`);
  }
  for (const w of webs) {
    if (caches.length && !(webToCache.get(w) ?? []).length) {
      problems.push(`${name(w)}(web)から cache に届かないので、読み込みがすべて db 層に行きます`);
    }
  }

  const rate = pv > 0 ? Math.max(0, Math.min(1, success)) : 1;
  return {
    pv,
    success: entries.length ? rate : pv > 0 ? 0 : 1,
    latencyMs,
    p99Ms: latencyMs * P99_FACTOR,
    devices,
    links: g.links,
    cableRho,
    nodes,
    nodeLoads: loads,
    instances,
    entries,
    problems,
    bottleneck,
  };
}
