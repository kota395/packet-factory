/** ネットワーク: 機器とケーブルからリンクのグラフを作り、2 台の間の経路(ECMP)を求める。LB の HA ペアもここ */
import { MODEL_BY_ID, portsOf } from '../catalog';
import type { Facility } from '../facility';
import type { FlowInput, LinkLoad, Route } from './types';

export interface Graph {
  readonly key: string;
  readonly adj: Map<number, Map<number, LinkLoad>>;
  readonly links: LinkLoad[];
  readonly routes: Map<string, Route | null>;
}

let cachedGraph: { facility: Facility; graph: Graph } | null = null;

/** 機器とケーブルからリンクのグラフを作る(止まっている機器は除く)。配線・回線契約・止まっている機器が変わらない間は使い回す */
export function graphOf(facility: Facility, input: FlowInput): Graph {
  const key = `${facility.version}@${input.uplinkGbps}@${input.bgp}@${[...input.down].sort((a, b) => a - b).join(',')}`;
  if (cachedGraph?.facility === facility && cachedGraph.graph.key === key) return resetGraph(cachedGraph.graph);
  const adj = new Map<number, Map<number, LinkLoad>>();
  const links: LinkLoad[] = [];
  const speedOf = (device: number, port: number) => {
    const d = facility.devices.get(device)!;
    const p = portsOf(d)[port];
    return MODEL_BY_ID[d.model].category === 'handoff' ? input.uplinkGbps : p.speedGbps;
  };
  for (const c of facility.cables.values()) {
    if (input.down.has(c.a.device) || input.down.has(c.b.device)) continue;
    // HA ポートのケーブルは LB 同士の死活監視だけで、データは流れない
    if (isHaPort(facility, c.a) || isHaPort(facility, c.b)) continue;
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

/** LB アプライアンスの HA ポートか */
export function isHaPort(facility: Facility, ref: { device: number; port: number }): boolean {
  const d = facility.devices.get(ref.device);
  return !!d && MODEL_BY_ID[d.model].category === 'lb' && portsOf(d)[ref.port]?.label === 'HA';
}

/**
 * LB アプライアンスのまとまり。HA ポート同士を直結した 2 台はペア(アクティブ/スタンバイ)、それ以外は 1 台ずつ。
 * アクティブは若い番号の、動いている方
 */
export function lbGroups(facility: Facility, down: ReadonlySet<number>): { members: number[]; active: number | null }[] {
  const lbs = [...facility.devices.values()].filter((d) => MODEL_BY_ID[d.model].category === 'lb').sort((a, b) => a.id - b.id);
  const peer = new Map<number, number>();
  for (const c of facility.cables.values()) {
    if (!isHaPort(facility, c.a) || !isHaPort(facility, c.b) || c.a.device === c.b.device) continue;
    peer.set(c.a.device, c.b.device);
    peer.set(c.b.device, c.a.device);
  }
  const seen = new Set<number>();
  const groups: { members: number[]; active: number | null }[] = [];
  for (const d of lbs) {
    if (seen.has(d.id)) continue;
    const members = [d.id, ...(peer.has(d.id) ? [peer.get(d.id)!] : [])].sort((a, b) => a - b);
    for (const m of members) seen.add(m);
    groups.push({ members, active: members.find((m) => !down.has(m)) ?? null });
  }
  return groups;
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
export function routeOf(facility: Facility, g: Graph, input: FlowInput, src: number, dst: number): Route | null {
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
    // LB アプライアンスは BGP を解放していれば、つないだリンクすべてを使う
    if (cat === 'lb' && input.bgp) return live;
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
