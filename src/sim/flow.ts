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
  /** BGP を解放しているか */
  readonly bgp: boolean;
  /** 止まっている機器(メンテナンス・障害) */
  readonly down: ReadonlySet<number>;
}

/**
 * 経路。ECMP で複数の経路に分かれることがあるので、リンクごとに流れる割合(frac)を持つ。
 * 同じ機器の中(同じホストの VM 同士など)なら edges は空
 */
export interface Route {
  readonly edges: { link: LinkLoad; forward: boolean; frac: number }[];
  /** 中継するスイッチと、そこを通る割合 */
  readonly transit: { id: number; frac: number }[];
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
  readonly routes: Map<string, Route | null>;
}

let cachedGraph: { facility: Facility; graph: Graph } | null = null;

/** 機器とケーブルからリンクのグラフを作る(止まっている機器は除く)。配線・回線契約・止まっている機器が変わらない間は使い回す */
function graphOf(facility: Facility, input: FlowInput): Graph {
  const key = `${facility.version}@${input.uplinkGbps}@${input.bgp}@${[...input.down].sort((a, b) => a - b).join(',')}`;
  if (cachedGraph?.facility === facility && cachedGraph.graph.key === key) return resetGraph(cachedGraph.graph);
  const adj = new Map<number, Map<number, LinkLoad>>();
  const links: LinkLoad[] = [];
  const speedOf = (device: number, port: number) => {
    const d = facility.devices.get(device)!;
    const p = portsOf(d.model)[port];
    return MODEL_BY_ID[d.model].category === 'handoff' ? input.uplinkGbps : p.speedGbps;
  };
  for (const c of facility.cables.values()) {
    if (input.down.has(c.a.device) || input.down.has(c.b.device)) continue;
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
  const graph: Graph = { key, adj, links, routes: new Map() };
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

/** 止まっている機器も含めた、配線どおりのグラフ(BGP なしの機器が使う「設定どおりの経路」を決めるのに使う) */
let cachedFull: { facility: Facility; key: string; adj: Map<number, Map<number, number>>; dist: Map<number, Map<number, number>> } | null = null;

function fullGraph(facility: Facility) {
  const key = `${facility.version}`;
  if (cachedFull?.facility === facility && cachedFull.key === key) return cachedFull;
  // 相手 → 自分側の一番若いポート
  const adj = new Map<number, Map<number, number>>();
  const add = (me: number, port: number, peer: number) => {
    if (!adj.has(me)) adj.set(me, new Map());
    const m = adj.get(me)!;
    m.set(peer, Math.min(m.get(peer) ?? Infinity, port));
  };
  for (const c of facility.cables.values()) {
    add(c.a.device, c.a.port, c.b.device);
    add(c.b.device, c.b.port, c.a.device);
  }
  cachedFull = { facility, key, adj, dist: new Map() };
  return cachedFull;
}

/**
 * BGP を使わない端の機器が、相手 dst へ送るときに使う隣(1 台)。
 * 配線どおり(止まっている機器も含めて)の最短経路のうち、一番若いポートの隣に決まっていて、
 * その隣が止まっても切り替わらない(静的な設定と同じ)
 */
function staticHop(facility: Facility, u: number, dst: number): number | null {
  const full = fullGraph(facility);
  const isSwitch = (id: number) => MODEL_BY_ID[facility.devices.get(id)!.model].category === 'switch';
  let dist = full.dist.get(dst);
  if (!dist) {
    dist = new Map([[dst, 0]]);
    let frontier = [dst];
    while (frontier.length) {
      const next: number[] = [];
      for (const x of frontier) {
        if (x !== dst && !isSwitch(x)) continue;
        for (const v of full.adj.get(x)?.keys() ?? []) {
          if (dist.has(v)) continue;
          dist.set(v, dist.get(x)! + 1);
          next.push(v);
        }
      }
      frontier = next;
    }
    full.dist.set(dst, dist);
  }
  const du = dist.get(u);
  if (du === undefined) return null;
  let best: { peer: number; port: number } | null = null;
  for (const [peer, port] of full.adj.get(u) ?? []) {
    if (dist.get(peer) !== du - 1 || (peer !== dst && !isSwitch(peer))) continue;
    if (!best || port < best.port) best = { peer, port };
  }
  return best?.peer ?? null;
}

/**
 * src から dst への経路。スイッチだけが中継でき、ホップ数が最短の経路が複数あれば均等に分ける(ECMP)。
 * 端の機器は uplinksOf のリンクしか使えない。つながっていなければ null
 */
function routeOf(facility: Facility, g: Graph, input: FlowInput, src: number, dst: number): Route | null {
  if (src === dst) return { edges: [], transit: [] };
  const key = `${src}>${dst}`;
  const cached = g.routes.get(key);
  if (cached !== undefined) return cached;
  const isSwitch = (id: number) => MODEL_BY_ID[facility.devices.get(id)!.model].category === 'switch';
  /**
   * 端の機器(src と dst)が使える隣。BGP を使っていれば生きている隣すべて(ECMP)、
   * 使っていなければ設定どおりの 1 台だけ(止まっていれば使えない)
   */
  const endpointHops = (id: number, other: number): number[] => {
    const d = facility.devices.get(id)!;
    const cat = MODEL_BY_ID[d.model].category;
    const live = [...(g.adj.get(id)?.keys() ?? [])];
    if (cat === 'switch' || cat === 'handoff') return live;
    if (input.bgp && (d.bgp || d.hv)) return live;
    const hop = staticHop(facility, id, other);
    return hop !== null && live.includes(hop) ? [hop] : [];
  };
  const srcHops = endpointHops(src, dst);
  const dstHops = endpointHops(dst, src);
  /** u から v へ進めるか(端の機器は自分の使える隣だけ) */
  const canStep = (u: number, v: number) => {
    if (u === src && !srcHops.includes(v)) return false;
    if (v === dst && !dstHops.includes(u)) return false;
    return u === src || isSwitch(u);
  };
  // dst からの距離(逆向きに広げる)
  const dist = new Map<number, number>([[dst, 0]]);
  let frontier = [dst];
  while (frontier.length) {
    const next: number[] = [];
    for (const u of frontier) {
      if (u !== dst && !isSwitch(u)) continue;
      for (const v of g.adj.get(u)?.keys() ?? []) {
        if (dist.has(v) || !canStep(v, u)) continue;
        dist.set(v, dist.get(u)! + 1);
        next.push(v);
      }
    }
    frontier = next;
  }
  if (!dist.has(src)) {
    g.routes.set(key, null);
    return null;
  }
  // src から、距離が 1 ずつ縮む相手へ均等に分けて流す
  const frac = new Map<number, number>([[src, 1]]);
  const edges: Route['edges'] = [];
  const transit: Route['transit'] = [];
  let level = [src];
  while (level.length) {
    const next = new Set<number>();
    for (const u of level) {
      if (u === dst) continue;
      const f = frac.get(u)!;
      if (u !== src) transit.push({ id: u, frac: f });
      const hops = [...(g.adj.get(u)?.keys() ?? [])].filter(
        (v) => dist.get(v) === dist.get(u)! - 1 && (v === dst || isSwitch(v)) && canStep(u, v),
      );
      for (const v of hops) {
        const link = g.adj.get(u)!.get(v)!;
        edges.push({ link, forward: link.a === u, frac: f / hops.length });
        frac.set(v, (frac.get(v) ?? 0) + f / hops.length);
        next.add(v);
      }
    }
    level = [...next];
  }
  const route = { edges, transit };
  g.routes.set(key, route);
  return route;
}

// ---------------------------------------------------------------- ノード

/** 役割を動かすノードの一覧。ハイパーバイザにしたサーバは自分では役割を持たず、載っている VM がノードになる */
export function computeNodes(facility: Facility, now: number, down: ReadonlySet<number> = new Set()): ComputeNode[] {
  const nodes: ComputeNode[] = [];
  const servers = [...facility.devices.values()]
    .filter((d) => MODEL_BY_ID[d.model].category === 'server')
    .sort((a, b) => a.id - b.id);
  for (const d of servers) {
    if (d.hv || down.has(d.id)) continue;
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
    if (!host?.hv || v.downUntil > now || down.has(host.id)) continue;
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
  const g = graphOf(facility, input);
  const devices = new Map<number, DeviceLoad>();
  for (const d of facility.devices.values()) devices.set(d.id, { cpu: 0, io: 0, fabric: 0, gbps: 0 });
  const problems: string[] = [];
  const name = (id: number) => nodeName(facility, id);

  // ---- ノードと役割
  const nodeList = computeNodes(facility, input.now, input.down);
  for (const d of facility.devices.values()) {
    if (input.down.has(d.id)) problems.push(`${d.name} は止まっています`);
  }
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
  const route = (a: number, b: number) => routeOf(facility, g, input, a, b);
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
    const s = storages.find((st) => !input.down.has(st.id) && route(n.host, st.id));
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
  const entryPath = new Map<number, Route | null>();
  const lbToWeb = new Map<string, Route | null>();
  const webToDb = new Map<number, Route | null>();
  const webToCache = new Map<number, { id: number; path: Route }[]>();
  const webToReplica = new Map<number, { id: number; path: Route }[]>();

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
    const cacheReach: { id: number; path: Route }[] = [];
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
    const repReach: { id: number; path: Route }[] = [];
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
  const along = (p: Route | null | undefined): [number, number] => {
    if (!p) return [0, 0];
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
    return [ok, ms];
  };
  /** ノードが溢れずに処理できる割合(自分の CPU・ホストの CPU・ディスク、共有ディスクならストレージへの経路も) */
  const nodePass = (id: number) => {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    let ok = pass(Math.max(l.cpu, devices.get(n.host)!.cpu, l.io));
    if (n.disk === 'shared') ok *= l.storage != null ? along(route(n.host, l.storage))[0] : 0;
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
    return VIRT.storageMs * q(l.io) + along(route(n.host, l.storage))[1];
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
