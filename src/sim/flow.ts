/**
 * 流量モデル。ページビュー/秒と、機器・配線・役割から、各資源の使用率と成功率・応答時間を求める。
 * パケットを 1 個ずつ流す代わりに、流量の合計で計算するので機器が増えても軽い。
 *
 * 1 ページビューの流れ: 回線 → (LB) → web → (cache) → db
 * 通信はケーブルとスイッチを通り、通った資源の使用率が 1 を超えるとその分が溢れてエラーになる。
 */
import { MODEL_BY_ID, portsOf } from './catalog';
import { BLOG, MAX_QUEUE_RHO, NET, P99_FACTOR, ROLE_MEM_GB } from './config';
import type { Device, Facility } from './facility';
import type { RoleId } from './types';

export interface FlowInput {
  readonly pv: number;
  readonly uplinkGbps: number;
  readonly images: boolean;
  readonly comments: boolean;
  /** 解放済みの役割 */
  readonly roles: ReadonlySet<RoleId>;
}

export interface DeviceLoad {
  /** CPU・ディスク IO・スイッチの処理能力の使用率(0〜、1 超えは溢れ) */
  cpu: number;
  io: number;
  fabric: number;
  /** この機器を通る(出入りする)通信量(Gbps) */
  gbps: number;
  /** 実際に働いている役割と、その役割で受けている量(/秒) */
  work: Partial<Record<RoleId, number>>;
  /** db の読み込みがディスクに行く割合 */
  dbMiss?: number;
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
  /** 役割ごとに実際に使われているサーバ */
  readonly instances: Record<RoleId, number[]>;
  /** インターネットから最初に受けるサーバ */
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

// ---------------------------------------------------------------- 本体

export function computeFlow(facility: Facility, input: FlowInput): FlowResult {
  const g = graphOf(facility, input.uplinkGbps);
  const devices = new Map<number, DeviceLoad>();
  for (const d of facility.devices.values()) devices.set(d.id, { cpu: 0, io: 0, fabric: 0, gbps: 0, work: {} });
  const problems: string[] = [];

  // ---- 役割ごとのサーバ
  const servers = [...facility.devices.values()]
    .filter((d) => MODEL_BY_ID[d.model].category === 'server')
    .sort((a, b) => a.id - b.id);
  const instances: Record<RoleId, number[]> = { lb: [], web: [], cache: [], db: [] };
  for (const s of servers) for (const r of s.roles) if (input.roles.has(r)) instances[r].push(s.id);
  if (instances.db.length > 1) {
    problems.push(`db は 1 台だけ使われます(${nameOf(facility, instances.db[0])})。レプリケーションは今後`);
    instances.db = instances.db.slice(0, 1);
  }
  const handoff = [...facility.devices.values()].find((d) => MODEL_BY_ID[d.model].category === 'handoff');
  let entries: number[];
  const useLb = instances.lb.length > 0;
  if (useLb) entries = instances.lb;
  else {
    entries = instances.web.slice(0, 1);
    if (instances.web.length > 1) {
      problems.push(
        `LB がないので、インターネットから届くのは ${nameOf(facility, instances.web[0])} だけです(web を並べるには LB が要る)`,
      );
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
  const db = instances.db[0];
  const webs = useLb ? instances.web : entries;

  /** 通信を経路に積む。届かなければ false */
  const send = (src: number, dst: number, fwdGbps: number, backGbps: number): number[] | null => {
    const path = pathOf(facility, g, src, dst);
    if (!path) return null;
    for (let i = 0; i + 1 < path.length; i++) {
      const u = path[i];
      const v = path[i + 1];
      const link = g.adj.get(u)!.get(v)!;
      if (link.a === u) {
        link.ab += fwdGbps;
        link.ba += backGbps;
      } else {
        link.ba += fwdGbps;
        link.ab += backGbps;
      }
    }
    for (const id of path) devices.get(id)!.gbps += fwdGbps + backGbps;
    for (let i = 1; i + 1 < path.length; i++) devices.get(path[i])!.fabric += fwdGbps + backGbps;
    return path;
  };
  const addWork = (id: number, role: RoleId, perSec: number, cpuMs: number) => {
    const d = facility.devices.get(id)!;
    const load = devices.get(id)!;
    load.work[role] = (load.work[role] ?? 0) + perSec;
    const m = MODEL_BY_ID[d.model];
    load.cpu += (perSec * cpuMs) / (m.coreSpeed! * m.cores! * 1000);
  };

  // 経路は後で成功率と遅延を出すのに使う
  const entryPath = new Map<number, number[] | null>();
  const lbToWeb = new Map<string, number[] | null>();
  const webToDb = new Map<number, number[] | null>();
  const webToCache = new Map<number, { id: number; path: number[] }[]>();

  const perEntry = entries.length ? pv / entries.length : 0;
  for (const e of entries) {
    entryPath.set(e, handoff ? send(handoff.id, e, perEntry * BLOG.requestKB * GB_PER_KB, perEntry * respKB * GB_PER_KB) : null);
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

  let dbReads = 0;
  let dbWrites = 0;
  for (const w of webs) {
    const wpv = pvOf.get(w) ?? 0;
    addWork(w, 'web', wpv, BLOG.webCpuMs);
    const reads = wpv * BLOG.dbReads;
    // 届く memcached に読み込みを振り分け、外れた分は db へ
    const reachable: { id: number; path: number[] }[] = [];
    for (const c of caches) {
      const path = pathOf(facility, g, w, c);
      if (path) reachable.push({ id: c, path });
    }
    webToCache.set(w, reachable);
    for (const { id, path } of reachable) {
      const gets = reads / reachable.length;
      send(path[0], id, gets * BLOG.queryKB * GB_PER_KB, gets * BLOG.dbReadKB * GB_PER_KB);
      addWork(id, 'cache', gets, BLOG.cacheCpuMs);
    }
    const toDb = reachable.length ? reads * (1 - BLOG.cacheHitRate) : reads;
    const wr = wpv * writes;
    if (db !== undefined) {
      webToDb.set(
        w,
        send(w, db, (toDb * BLOG.queryKB + wr * BLOG.queryKB * 2) * GB_PER_KB, toDb * BLOG.dbReadKB * GB_PER_KB),
      );
    }
    dbReads += toDb;
    dbWrites += wr;
  }

  // ---- db: CPU と、メモリに乗らなかった読み込みと書き込みのディスク IO
  let dbMiss = 1;
  if (db !== undefined) {
    const d = facility.devices.get(db)!;
    const m = MODEL_BY_ID[d.model];
    const others = d.roles.filter((r) => r !== 'db' && input.roles.has(r)).reduce((s, r) => s + ROLE_MEM_GB[r], 0);
    const mem = Math.max(0.5, m.memGB! - others - ROLE_MEM_GB.db);
    dbMiss = Math.min(1, Math.max(BLOG.dbMissMin, BLOG.dbMissPerGB / mem));
    const load = devices.get(db)!;
    load.dbMiss = dbMiss;
    load.work.db = dbReads + dbWrites;
    load.cpu += (dbReads * BLOG.dbReadCpuMs + dbWrites * BLOG.dbWriteCpuMs) / (m.coreSpeed! * m.cores! * 1000);
    load.io += (dbReads * dbMiss + dbWrites * BLOG.dbWriteIo) / m.diskIops!;
  }

  // ---- スイッチの処理能力
  for (const d of facility.devices.values()) {
    const m = MODEL_BY_ID[d.model];
    if (m.fabricGbps) devices.get(d.id)!.fabric /= m.fabricGbps;
    else devices.get(d.id)!.fabric = 0;
  }

  // ---- 使用率から、溢れずに通る割合と遅延
  const linkRho = (l: LinkLoad) => (l.capacityGbps > 0 ? Math.max(l.ab, l.ba) / l.capacityGbps : Infinity);
  const serverRho = (id: number) => {
    const l = devices.get(id)!;
    return Math.max(l.cpu, l.io);
  };
  /** 経路を通って溢れない割合と、通るのにかかる時間(ms) */
  const along = (path: number[] | null | undefined): [number, number] => {
    if (!path) return [0, 0];
    let ok = 1;
    let ms = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const rho = linkRho(g.adj.get(path[i])!.get(path[i + 1])!);
      ok *= pass(rho);
      ms += NET.hopMs * q(rho);
    }
    for (let i = 1; i + 1 < path.length; i++) {
      const rho = devices.get(path[i])!.fabric;
      ok *= pass(rho);
      ms += NET.hopMs * q(rho);
    }
    return [ok, ms];
  };
  const cpuMsOn = (id: number, ms: number) => {
    const m = MODEL_BY_ID[facility.devices.get(id)!.model];
    return (ms / m.coreSpeed!) * q(devices.get(id)!.cpu);
  };

  // db の部分(web ごと)
  const dataPart = (w: number): [number, number] => {
    if (db === undefined) return [0, 0];
    const [netOk, netMs] = along(webToDb.get(w));
    const dbLoad = devices.get(db)!;
    const ok = netOk * pass(serverRho(db));
    const readMs = cpuMsOn(db, BLOG.dbReadCpuMs) + dbMiss * BLOG.diskMs * q(dbLoad.io) + netMs;
    const writeMs = cpuMsOn(db, BLOG.dbWriteCpuMs) + BLOG.dbWriteIo * BLOG.diskMs * q(dbLoad.io) + netMs;
    const reachable = webToCache.get(w) ?? [];
    let readTotal = readMs;
    let cacheOk = 1;
    if (reachable.length) {
      let cacheMs = 0;
      cacheOk = 0;
      for (const { id, path } of reachable) {
        const [pOk, pMs] = along(path);
        cacheOk += (pOk * pass(serverRho(id))) / reachable.length;
        cacheMs += (pMs + cpuMsOn(id, BLOG.cacheCpuMs)) / reachable.length;
      }
      readTotal = cacheMs + (1 - BLOG.cacheHitRate) * readMs;
    }
    return [ok * cacheOk, BLOG.dbReads * readTotal + writes * writeMs];
  };

  const webPart = (w: number): [number, number] => {
    const [dOk, dMs] = dataPart(w);
    return [pass(serverRho(w)) * dOk, cpuMsOn(w, BLOG.webCpuMs) + dMs];
  };

  let success = 0;
  let latency = 0;
  const handoffLink = handoff ? [...(g.adj.get(handoff.id)?.values() ?? [])] : [];
  const uplinkRho = handoffLink.length ? Math.max(...handoffLink.map(linkRho)) : 0;
  const transferMs = (respKB * 8) / (input.uplinkGbps * 1000) * q(uplinkRho);
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
      ok *= pass(serverRho(e));
      ms += cpuMsOn(e, BLOG.lbCpuMs);
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
    consider(`${d.name} の CPU`, l.cpu);
    consider(`${d.name} のディスク IO`, l.io);
    consider(`${d.name} の処理能力`, l.fabric);
  }
  for (const l of g.links) consider(`${nameOf(facility, l.a)} ⇄ ${nameOf(facility, l.b)} の帯域`, linkRho(l));

  // ---- 届かない所の警告
  for (const e of entries) {
    if (handoff && g.adj.has(handoff.id) && !entryPath.get(e)) {
      problems.push(`回線から ${nameOf(facility, e)} への経路がありません`);
    }
  }
  for (const [key, path] of lbToWeb) {
    if (!path) {
      const [a, b] = key.split('>').map(Number);
      problems.push(`${nameOf(facility, a)}(lb)から ${nameOf(facility, b)}(web)への経路がありません`);
    }
  }
  if (db !== undefined) {
    for (const w of webs) {
      if (!webToDb.get(w)) problems.push(`${nameOf(facility, w)}(web)から ${nameOf(facility, db)}(db)への経路がありません`);
    }
  }
  for (const w of webs) {
    if (caches.length && !(webToCache.get(w) ?? []).length) {
      problems.push(`${nameOf(facility, w)}(web)から cache に届かないので、読み込みがすべて db に行きます`);
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
    instances,
    entries,
    problems,
    bottleneck,
  };
}

function nameOf(f: Facility, id: number): string {
  return (f.devices.get(id) as Device | undefined)?.name ?? '?';
}
