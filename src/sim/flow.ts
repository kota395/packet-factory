/**
 * 流量モデル。ページビュー/秒と、機器・配線・役割から、各資源の使用率と成功率・応答時間を求める。
 * パケットを 1 個ずつ流す代わりに、流量の合計で計算するので機器が増えても軽い。
 *
 * サービス(ブログ・ショッピング・写真共有・動画配信)ごとに流れを積み、同じ機器やリンクを使えば負荷は合算される。
 * 1 ページビューの流れ: 回線 → (LB) → web → (cache) → db / レプリカ(ショッピングは検索も)
 * 写真・動画は、ページとは別に media から画像・動画を取得し、投稿は web → worker(加工)→ media(保存)へ流れる。
 * 通信はケーブルとスイッチを通り、通った資源の使用率が 1 を超えるとその分が溢れてエラーになる。
 *
 * 役割を動かす単位(ノード)は物理サーバか VM。VM はホストの CPU を分け合い、通信はホストの NIC から出入りする。
 * VM のディスクは、ホストのローカルディスクか共有ストレージ(ネットワーク越しの IO)に置く。
 */
import { MODEL_BY_ID, portsOf, specOf } from './catalog';
import { ANALYTICS, DB_SPLIT, GPU, K8S, MAX_QUEUE_RHO, NET, P99_FACTOR, REPLICATION, ROLE_MEM_GB, SERVICES, VIRT, WORK, type Workload } from './config';
import type { Facility } from './facility';
import { ROLE_IDS, roleKey, splitRole, type DiskKind, type RoleId, type RoleKey, type ServiceId } from './types';

/** 動いているサービスの流量と、1 ページビューあたりの仕事量(機能のオン/オフを反映したもの) */
export interface ServiceLoad {
  readonly id: ServiceId;
  readonly pv: number;
  readonly work: Workload;
}

/** 同じワーカーに置いた、同じ役割の Pod のまとまり */
export interface PodGroup {
  /** ノードの ID(機器・VM と重ならない大きな数) */
  readonly id: number;
  /** 置いたワーカー(物理サーバは機器 ID、VM は −VM ID) */
  readonly worker: number;
  readonly role: RoleKey;
  readonly count: number;
}

/** Pod のまとまりのノード ID はこの数から */
export const POD_ID_BASE = 1_000_000;

export interface FlowInput {
  readonly services: readonly ServiceLoad[];
  /** Kubernetes の Pod(なければ空) */
  readonly pods?: readonly PodGroup[];
  readonly uplinkGbps: number;
  /** 解放済みの役割の種類 */
  readonly roles: ReadonlySet<RoleId>;
  /** シミュレーション時刻(移行中の VM を除くのに使う) */
  readonly now: number;
  /** BGP を解放しているか */
  readonly bgp: boolean;
  /** 分析基盤: Hadoop・機械学習を解放しているか */
  readonly analytics?: { readonly hadoop: boolean; readonly ml: boolean };
  /** db(プライマリ)を分けられるか: 1 台だけ / 機能分割(2 台)/ シャーディング(何台でも) */
  readonly dbSplit?: 'none' | 'functional' | 'shard';
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
  readonly roles: readonly RoleKey[];
  readonly vm: boolean;
  readonly disk: DiskKind;
  /** Pod のまとまりなら、置いたワーカーのノード(ワーカーの CPU も使う) */
  readonly parent?: number;
  /** Pod のまとまりなら、その Pod の数 */
  readonly pods?: number;
  /** BGP で外へ広報している(LB なしでインターネットから直接受けられる) */
  readonly advertised?: boolean;
  /** LB アプライアンスなら、1 秒あたりに振り分けられるリクエスト数 */
  readonly lbRps?: number;
  /** GPU の枚数(物理サーバだけ) */
  readonly gpus?: number;
}

export interface NodeLoad {
  /** CPU(VM なら割り当てた vCPU)の使用率 */
  cpu: number;
  /** ディスク(ローカルならホストのディスク、共有ならストレージ)の使用率 */
  io: number;
  /** このノードが出しているディスク IO(回/秒) */
  ioOps: number;
  /** GPU の使用率(GPU があるノードだけ) */
  gpu?: number;
  /** 役割ごとの処理量(/秒) */
  work: Partial<Record<RoleKey, number>>;
  /** 役割ごとの、読み込みがメモリに乗らずディスクに行く割合(db・レプリカ・search・media) */
  miss: Partial<Record<RoleKey, number>>;
  /** 共有ディスクに使っているストレージ(機器 ID)。届かなければ null */
  storage?: number | null;
}

export interface DeviceLoad {
  /** CPU・ディスク IO(ストレージは IOPS)・スイッチの処理能力の使用率(0〜、1 超えは溢れ)。VM のホストは VM の合計 */
  cpu: number;
  io: number;
  fabric: number;
  /** GPU の使用率(GPU を載せたサーバだけ) */
  gpu: number;
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

/** サービスごとの結果 */
export interface ServiceFlow {
  readonly id: ServiceId;
  readonly pv: number;
  /** 成功する割合(0〜1) */
  readonly success: number;
  readonly latencyMs: number;
  readonly p99Ms: number;
  /** 役割ごとに実際に使われているノード */
  readonly instances: Record<RoleId, number[]>;
  /** インターネットから最初に受けるノード */
  readonly entries: number[];
  /** このサービスの警告 */
  readonly problems: string[];
}

/** 分析基盤の結果 */
export interface AnalyticsFlow {
  /** 全サービスのログ(MB/秒) */
  readonly logMBps: number;
  /** 処理しきれた割合(Hadoop の集計と、機械学習) */
  readonly coverage: number;
  readonly mlCoverage: number;
  /** 1 ページビューあたりの収益の倍率 */
  readonly boost: number;
  readonly hadoop: number[];
  readonly ml: number[];
}

export interface FlowResult {
  /** すべてのサービスの合計 */
  readonly pv: number;
  /** 成功する割合(0〜1)と応答。サービスのページビューで重み付けした平均 */
  readonly success: number;
  readonly latencyMs: number;
  readonly p99Ms: number;
  readonly services: Partial<Record<ServiceId, ServiceFlow>>;
  readonly analytics: AnalyticsFlow;
  readonly devices: Map<number, DeviceLoad>;
  readonly links: LinkLoad[];
  /** ケーブルごとの使用率 */
  readonly cableRho: Map<number, number>;
  /** 役割を動かしているノード(物理サーバと VM)と、その負荷 */
  readonly nodes: Map<number, ComputeNode>;
  readonly nodeLoads: Map<number, NodeLoad>;
  /** 未接続・役割の不足などの警告(複数のサービスが動いていればサービス名つき) */
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

// ---------------------------------------------------------------- ノード

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
  const servers = [...facility.devices.values()]
    .filter((d) => MODEL_BY_ID[d.model].category === 'server')
    .sort((a, b) => a.id - b.id);
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
  return nodes;
}

/** ノード(機器 ID か −VM ID)の名前 */
export function nodeName(f: Facility, id: number): string {
  if (id < 0) return f.vms.get(-id)?.name ?? '?';
  return f.devices.get(id)?.name ?? '?';
}


// ---------------------------------------------------------------- 本体

/** サーバのメモリの残りをキャッシュに使う役割(同じノードに複数あれば分け合う) */
const CACHE_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(['db', 'replica', 'search', 'media']);

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function computeFlow(facility: Facility, input: FlowInput): FlowResult {
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

  // ---------------------------------------------------------------- サービスごとに負荷を積む

  const planService = (svc: ServiceLoad) => {
    const W = svc.work;
    const key = (r: RoleId) => roleKey(svc.id, r);
    const sp: string[] = [];
    const inst = Object.fromEntries(ROLE_IDS.map((r) => [r, [] as number[]])) as Record<RoleId, number[]>;
    for (const n of nodeList) {
      for (const k of n.roles) {
        const [s, r] = splitRole(k);
        if (s === svc.id && isActive(k)) inst[r].push(n.id);
      }
    }
    // ---- db(プライマリ)の分け方
    //  1 台: 読み書きすべて / 機能分割: 1 台目が主なデータ(読み込みの多く)、2 台目が書き込みの多いデータ(コメント・注文など)
    //  シャーディング: 読み書きとデータを台数で等分
    const split = input.dbSplit ?? 'none';
    const maxDb = split === 'shard' ? Infinity : split === 'functional' ? 2 : 1;
    if (inst.db.length > maxDb) {
      sp.push(
        split === 'functional'
          ? `機能分割で使う db は 2 台までです(${name(inst.db[0])} と ${name(inst.db[1])})。もっと分けるならシャーディング`
          : `db(プライマリ)は 1 台だけ使われます(${name(inst.db[0])})。読み込みを分けるならレプリカ、書き込みを分けるなら機能分割かシャーディング`,
      );
      inst.db = inst.db.slice(0, maxDb);
    }
    const shards: { primary: number; read: number; write: number; data: number; replicas: number[] }[] =
      inst.db.length === 2 && split === 'functional'
        ? [
            { primary: inst.db[0], read: 1 - DB_SPLIT.functionalReadShare, write: 0, data: 1 - DB_SPLIT.functionalReadShare, replicas: [] },
            { primary: inst.db[1], read: DB_SPLIT.functionalReadShare, write: 1, data: DB_SPLIT.functionalReadShare, replicas: [] },
          ]
        : inst.db.map((id) => ({ primary: id, read: 1 / inst.db.length, write: 1 / inst.db.length, data: 1 / inst.db.length, replicas: [] }));
    // LB: アプライアンス(HA ペアならアクティブの 1 台)と、SLB の役割を付けたノード。
    // すべて止まっている LB(ペアの両方が止まっているなど)にも DNS でリクエストが来て、その分は失敗する
    const lbNodes = [...activeLbs, ...inst.lb];
    const useLb = lbNodes.length + deadLbs > 0;
    const lbShare = useLb ? lbNodes.length / (lbNodes.length + deadLbs) : 1;
    // LB がなければ、BGP で広報している Pod(MetalLB)がそれぞれ受ける。それもなければ web 1 台だけ
    const advertised = inst.web.filter((n) => nodes.get(n)!.advertised);
    const entries = useLb ? lbNodes : advertised.length ? advertised : inst.web.slice(0, 1);
    if (!useLb && inst.web.length > entries.length) {
      sp.push(
        advertised.length
          ? 'LB がないので、インターネットから届くのは BGP で広報している web の Pod だけです'
          : `LB がないので、インターネットから届くのは ${name(inst.web[0])} だけです(web を並べるには LB か、BGP で広報する Pod が要る)`,
      );
    }
    if (!inst.web.length) sp.push('役割「web」のサーバがありません');
    if (!inst.db.length) sp.push('役割「db」のサーバがありません(db がないとページを表示できない)');
    const webs = useLb ? inst.web : entries;
    /** 検索の肩代わりなどに使う、最初の db */
    const primary: number | undefined = inst.db[0];
    const caches = inst.cache;
    const pv = svc.pv;
    const lbKey = key('lb');

    // media・worker がなければ web が肩代わりする
    const ownMedia = inst.media.length > 0;
    const media = W.media || W.upload ? (ownMedia ? inst.media : webs) : [];
    const mediaKey = ownMedia ? key('media') : key('web');
    const workers = W.upload ? (inst.worker.length ? inst.worker : webs) : [];
    const workerKey = inst.worker.length ? key('worker') : key('web');
    const mediaEntries = !W.media ? [] : useLb ? entries : media.slice(0, 1);
    if (W.media && !useLb && inst.media.length > 1) {
      sp.push(`LB がないので、画像・動画を配るのは ${name(inst.media[0])} だけです`);
    }
    if (W.media && !ownMedia && inst.web.length) sp.push('役割「media」がないので、web が画像・動画を配っています');
    if (W.upload && !inst.worker.length && inst.web.length) sp.push('役割「worker」がないので、web が投稿を加工しています');
    if (W.search && !inst.search.length && primary !== undefined) {
      sp.push('役割「search」がないので、db が検索を肩代わりしています(LIKE 検索は重い)');
    }

    // ---- レプリカ: db を分けていれば、順番にそれぞれの db の複製にする(複製元から届くものだけ使う)
    inst.replica.forEach((r, i) => {
      if (!shards.length) return;
      const sh = shards[i % shards.length];
      if (path(sh.primary, r)) sh.replicas.push(r);
      else sp.push(`${name(r)}(レプリカ)に ${name(sh.primary)}(db)から届かないので複製できず、使われません`);
    });
    if (inst.replica.length && primary === undefined) sp.push('レプリカの複製元(db)がありません');

    // ---- 入口: ページと投稿
    const uploads = W.upload ? pv * W.upload.perPv : 0;
    const perEntry = entries.length ? (pv * lbShare) / entries.length : 0;
    const upPerEntry = entries.length ? (uploads * lbShare) / entries.length : 0;
    const upKB = W.upload?.kb ?? 0;
    for (const e of entries) {
      fromNet(e, (perEntry * WORK.requestKB + upPerEntry * upKB) * GB_PER_KB, perEntry * W.pageKB * GB_PER_KB);
    }
    const pvOf = new Map<number, number>();
    const upOf = new Map<number, number>();
    if (useLb) {
      for (const e of entries) {
        addWork(e, lbKey, perEntry + upPerEntry, lbMs(e));
        for (const w of webs) {
          const p = perEntry / webs.length;
          const u = upPerEntry / webs.length;
          send(e, w, (p * WORK.requestKB + u * upKB) * GB_PER_KB, p * W.pageKB * GB_PER_KB);
          pvOf.set(w, (pvOf.get(w) ?? 0) + p);
          upOf.set(w, (upOf.get(w) ?? 0) + u);
        }
      }
    } else {
      for (const w of webs) {
        pvOf.set(w, perEntry);
        upOf.set(w, upPerEntry);
      }
    }

    // ---- web から先
    const readsOn = new Map<number, number>();
    const searchOn = new Map<number, number>();
    const jobsOn = new Map<number, number>();
    let dbSearches = 0;
    let totalWrites = 0;
    /** db(プライマリ)ごとの書き込み */
    const writesOn = new Map<number, number>();
    for (const w of webs) {
      const wpv = pvOf.get(w) ?? 0;
      const up = upOf.get(w) ?? 0;
      addWork(w, key('web'), wpv + up, W.webCpuMs);
      const reads = wpv * W.dbReads;
      // 届く memcached に読み込みを振り分け、外れた分は db 層へ
      const cacheReach = caches.filter((c) => path(w, c));
      for (const c of cacheReach) {
        const gets = reads / cacheReach.length;
        send(w, c, gets * WORK.queryKB * GB_PER_KB, gets * WORK.dbReadKB * GB_PER_KB);
        addWork(c, key('cache'), gets, WORK.cacheCpuMs);
      }
      const toDb = cacheReach.length ? reads * (1 - WORK.cacheHitRate) : reads;
      // 書き込み: ページの書き込み(注文・コメント)と、投稿の登録
      const wr = wpv * W.dbWrites + up;
      totalWrites += wr;
      for (const sh of shards) {
        const rd = toDb * sh.read;
        const wrs = wr * sh.write;
        writesOn.set(sh.primary, (writesOn.get(sh.primary) ?? 0) + wrs);
        // 読み込みはその db のレプリカ(届くもの)に分け、なければプライマリ
        const repReach = sh.replicas.filter((r) => path(w, r));
        for (const r of repReach) {
          const n = rd / repReach.length;
          send(w, r, n * WORK.queryKB * GB_PER_KB, n * WORK.dbReadKB * GB_PER_KB);
          readsOn.set(r, (readsOn.get(r) ?? 0) + n);
        }
        const toPrimary = repReach.length ? 0 : rd;
        send(w, sh.primary, (toPrimary * WORK.queryKB + wrs * WORK.queryKB * 2) * GB_PER_KB, toPrimary * WORK.dbReadKB * GB_PER_KB);
        readsOn.set(sh.primary, (readsOn.get(sh.primary) ?? 0) + toPrimary);
      }
      // 検索: 届く search に分け、なければ db(プライマリ)が肩代わり
      if (W.search) {
        const qs = wpv * W.search.perPv;
        const reach = inst.search.filter((x) => path(w, x));
        if (reach.length) {
          for (const x of reach) {
            const n = qs / reach.length;
            send(w, x, n * WORK.queryKB * GB_PER_KB, n * W.search.resultKB * GB_PER_KB);
            searchOn.set(x, (searchOn.get(x) ?? 0) + n);
          }
        } else if (primary !== undefined) {
          send(w, primary, qs * WORK.queryKB * GB_PER_KB, qs * W.search.resultKB * GB_PER_KB);
          dbSearches += qs;
        }
      }
      // 投稿: 届く worker に元のデータを渡す
      if (W.upload && up) {
        const reach = workers.filter((k) => path(w, k));
        for (const k of reach) {
          const n = up / reach.length;
          send(w, k, n * W.upload.kb * GB_PER_KB, 0);
          jobsOn.set(k, (jobsOn.get(k) ?? 0) + n);
        }
      }
    }

    // ---- db とレプリカ: CPU と、メモリに乗らなかった読み込み・書き込みのディスク IO
    // データを分けると 1 台あたりのデータが減り、メモリに乗りやすくなる
    for (const sh of shards) {
      const p = sh.primary;
      const reads = readsOn.get(p) ?? 0;
      const writes = writesOn.get(p) ?? 0;
      const miss = missOf(p, key('db'), WORK.dbMissPerGB * sh.data);
      addWork(p, key('db'), reads, WORK.dbReadCpuMs);
      if (writes) addWork(p, key('db'), writes, WORK.dbWriteCpuMs);
      let io = reads * miss + writes * WORK.dbWriteIo;
      if (W.search && dbSearches && p === primary) {
        addWork(p, key('db'), dbSearches, W.search.dbCpuMs);
        io += dbSearches * W.search.dbIo * miss;
      }
      addIo(p, io);
      for (const r of sh.replicas) {
        const rr = readsOn.get(r) ?? 0;
        const rmiss = missOf(r, key('replica'), WORK.dbMissPerGB * sh.data);
        addWork(r, key('replica'), rr, WORK.dbReadCpuMs);
        // その db の書き込みはすべてのレプリカに複製され、反映にも CPU と IO を使う
        if (writes) {
          addCpu(r, writes, WORK.dbWriteCpuMs * REPLICATION.applyCpu);
          send(p, r, writes * WORK.queryKB * 2 * GB_PER_KB, 0);
        }
        addIo(r, rr * rmiss + writes * WORK.dbWriteIo * REPLICATION.applyIo);
      }
    }
    // ---- 検索サーバ: 索引がメモリに乗らなければディスクへ
    if (W.search) {
      for (const [x, qs] of searchOn) {
        addWork(x, key('search'), qs, W.search.cpuMs);
        addIo(x, qs * missOf(x, key('search'), W.search.missPerGB));
      }
    }
    // ---- 加工(worker)して media に保存する
    const storeOn = new Map<number, number>();
    if (W.upload) {
      for (const [k, jobs] of jobsOn) {
        // エンコードなど GPU でできる加工は、GPU があれば GPU で
        if (W.upload.workerGpuMs && hasGpu(k)) addGpuWork(k, workerKey, jobs, W.upload.workerGpuMs);
        else addWork(k, workerKey, jobs, W.upload.workerCpuMs);
        const reach = media.filter((m) => path(k, m));
        for (const m of reach) {
          const n = jobs / reach.length;
          send(k, m, n * W.upload.storedKB * GB_PER_KB, 0);
          addIo(m, n * W.upload.storeIo);
          storeOn.set(m, (storeOn.get(m) ?? 0) + n);
        }
      }
    }
    // ---- 画像・動画の配信: ページとは別のリクエストとして入口から media へ
    if (W.media) {
      const fetches = pv * W.media.perPv;
      const fetchOn = new Map<number, number>();
      const perE = mediaEntries.length ? (fetches * lbShare) / mediaEntries.length : 0;
      for (const e of mediaEntries) {
        fromNet(e, perE * WORK.requestKB * GB_PER_KB, perE * W.media.kb * GB_PER_KB);
        if (useLb) {
          addWork(e, lbKey, perE, lbMs(e));
          for (const m of media) {
            const n = perE / media.length;
            send(e, m, n * WORK.requestKB * GB_PER_KB, n * W.media.kb * GB_PER_KB);
            fetchOn.set(m, (fetchOn.get(m) ?? 0) + n);
          }
        } else fetchOn.set(e, (fetchOn.get(e) ?? 0) + perE);
      }
      for (const [m, f] of fetchOn) {
        addWork(m, mediaKey, f, W.media.cpuMs);
        addIo(m, f * W.media.io * missOf(m, mediaKey, W.media.missPerGB));
      }
    }

    // ---------------------------------------------------------------- 成功率と応答
    const evaluate = (): { success: number; latencyMs: number } => {
      const nodeOk = (id: number) => nodePass(id);
      /** db・レプリカで 1 回読む時間 */
      const readOn = (id: number, k: RoleKey) => cpuMs(id, WORK.dbReadCpuMs) + (loads.get(id)!.miss[k] ?? 1) * ioMs(id);

      const dataPart = (w: number): [number, number] => {
        if (!shards.length) return [0, 0];
        // db ごとに、読み込み(レプリカに届けばレプリカ、なければプライマリ)と書き込み(プライマリ)を見て、割合で合わせる
        let readOk = 0;
        let readMs = 0;
        let writeOk = 0;
        let writeMs = 0;
        let primaryOk = 0;
        let primaryMs = 0;
        for (const sh of shards) {
          const [netOk, netMs] = along(path(w, sh.primary));
          const pOk = netOk * nodeOk(sh.primary);
          if (sh.primary === primary) {
            primaryOk = pOk;
            primaryMs = netMs;
          }
          const reps = sh.replicas.filter((r) => path(w, r));
          if (reps.length) {
            readOk += sh.read * avg(reps.map((r) => along(path(w, r))[0] * nodeOk(r)));
            readMs += sh.read * avg(reps.map((r) => along(path(w, r))[1] + readOn(r, key('replica'))));
          } else {
            readOk += sh.read * pOk;
            readMs += sh.read * (netMs + readOn(sh.primary, key('db')));
          }
          writeOk += sh.write * pOk;
          writeMs += sh.write * (netMs + cpuMs(sh.primary, WORK.dbWriteCpuMs) + WORK.dbWriteIo * ioMs(sh.primary));
        }
        const cacheReach = caches.filter((c) => path(w, c));
        if (cacheReach.length) {
          readOk *= avg(cacheReach.map((c) => along(path(w, c))[0] * nodeOk(c)));
          const cacheMs = avg(cacheReach.map((c) => along(path(w, c))[1] + cpuMs(c, WORK.cacheCpuMs)));
          readMs = cacheMs + (1 - WORK.cacheHitRate) * readMs;
        }
        // 書き込みはプライマリだけ。書き込むページの分だけ、プライマリが溢れると失敗する
        const writeShare = Math.min(1, W.dbWrites);
        let ok = readOk * (1 - writeShare * (1 - writeOk));
        let ms = W.dbReads * readMs + W.dbWrites * writeMs;
        // 検索
        if (W.search) {
          const reach = inst.search.filter((x) => path(w, x));
          let sOk = 0;
          let sMs = 0;
          if (reach.length) {
            sOk = avg(reach.map((x) => along(path(w, x))[0] * nodeOk(x)));
            sMs = avg(
              reach.map((x) => along(path(w, x))[1] + cpuMs(x, W.search!.cpuMs) + (loads.get(x)!.miss[key('search')] ?? 1) * ioMs(x)),
            );
          } else if (primary !== undefined) {
            sOk = primaryOk;
            sMs = primaryMs + cpuMs(primary, W.search.dbCpuMs) + W.search.dbIo * (loads.get(primary)!.miss[key('db')] ?? 1) * ioMs(primary);
          }
          ok *= 1 - Math.min(1, W.search.perPv) * (1 - sOk);
          ms += W.search.perPv * sMs;
        }
        return [ok, ms];
      };
      const webPart = (w: number): [number, number] => {
        const [dOk, dMs] = dataPart(w);
        return [nodeOk(w) * dOk, cpuMs(w, W.webCpuMs) + dMs];
      };

      // ページ
      let pageOk = 0;
      let pageMs = 0;
      for (const e of entries) {
        const [inOk, inMs] = fromNetAlong(e);
        let ok = 0;
        let ms = 0;
        if (useLb) {
          for (const w of webs) {
            const [pOk, pMs] = along(path(e, w));
            const [wOk, wMs] = webPart(w);
            ok += (pOk * wOk) / webs.length;
            ms += (pMs + wMs) / webs.length;
          }
          ok *= nodeOk(e);
          ms += cpuMs(e, lbMs(e));
        } else {
          [ok, ms] = webPart(e);
        }
        pageOk += (inOk * ok) / entries.length;
        pageMs += (inMs + ms) / entries.length;
      }
      let success = pageOk;
      let latency = transferMs(W.pageKB) + pageMs;

      // 画像・動画: 取得がすべて成功してはじめて 1 ページを見られる
      if (W.media) {
        const mw = W.media;
        const fetchOk = (m: number) => nodeOk(m);
        const fetchMs = (m: number) => cpuMs(m, mw.cpuMs) + mw.io * (loads.get(m)!.miss[mediaKey] ?? 1) * ioMs(m);
        let mOk = 0;
        let mMs = 0;
        for (const e of mediaEntries) {
          const [inOk, inMs] = fromNetAlong(e);
          let ok: number;
          let ms: number;
          if (useLb) {
            ok = avg(media.map((m) => along(path(e, m))[0] * fetchOk(m))) * nodeOk(e);
            ms = avg(media.map((m) => along(path(e, m))[1] + fetchMs(m))) + cpuMs(e, lbMs(e));
          } else {
            ok = fetchOk(e);
            ms = fetchMs(e);
          }
          mOk += (inOk * ok) / mediaEntries.length;
          mMs += (inMs + ms) / mediaEntries.length;
        }
        success *= mOk;
        latency += mMs + transferMs(mw.kb);
      }

      // 投稿: 入口 → web → worker → media がすべて通れば成功(応答には含めない。裏で加工する)
      if (W.upload) {
        const storeOk = (k: number) => {
          const reach = media.filter((m) => path(k, m));
          return reach.length ? avg(reach.map((m) => along(path(k, m))[0] * nodeOk(m))) : 0;
        };
        const workOk = (w: number) => {
          const reach = workers.filter((k) => path(w, k));
          return nodeOk(w) * (reach.length ? avg(reach.map((k) => along(path(w, k))[0] * nodeOk(k) * storeOk(k))) : 0);
        };
        let upOk = 0;
        for (const e of entries) {
          const [inOk] = fromNetAlong(e);
          const ok = useLb ? nodeOk(e) * avg(webs.map((w) => along(path(e, w))[0] * workOk(w))) : workOk(e);
          upOk += (inOk * ok) / entries.length;
        }
        success *= 1 - Math.min(1, W.upload.perPv) * (1 - upOk);
      }
      // 止まっている LB に来た分は失敗
      return {
        success: entries.length ? Math.max(0, Math.min(1, success * lbShare)) : pv > 0 ? 0 : 1,
        latencyMs: NET.internetRttMs + latency,
      };
    };

    // ---- 届かない所の警告
    const warnRoutes = () => {
      for (const e of entries) {
        if (handoffs.length && !linesTo(e).length) sp.push(`回線から ${name(e)} への経路がありません`);
      }
      if (useLb) {
        for (const e of entries) for (const w of webs) if (!path(e, w)) sp.push(`${name(e)}(lb)から ${name(w)}(web)への経路がありません`);
      }
      for (const sh of shards) {
        for (const w of webs) if (!path(w, sh.primary)) sp.push(`${name(w)}(web)から ${name(sh.primary)}(db)への経路がありません`);
      }
      for (const w of webs) {
        if (caches.length && !caches.some((c) => path(w, c))) {
          sp.push(`${name(w)}(web)から cache に届かないので、読み込みがすべて db 層に行きます`);
        }
        if (W.upload && !workers.some((k) => path(w, k))) sp.push(`${name(w)}(web)から投稿を加工する所に届きません`);
      }
      if (W.upload) for (const k of workers) if (!media.some((m) => path(k, m))) sp.push(`${name(k)} から加工したデータを保存する media に届きません`);
      if (useLb && W.media) {
        for (const e of entries) for (const m of media) if (!path(e, m)) sp.push(`${name(e)}(lb)から ${name(m)}(media)への経路がありません`);
      }
    };

    return { svc, inst, entries, webs, sp, evaluate, warnRoutes };
  };

  const plans = input.services.map(planService);

  // ---- 分析基盤: 各サービスの web からログを Hadoop に集め、機械学習のノードへ渡す
  const dataNodes = (role: RoleId) => nodeList.filter((n) => n.roles.includes(roleKey('data', role)) && isActive(roleKey('data', role))).map((n) => n.id);
  const hadoops = input.analytics?.hadoop ? dataNodes('hadoop') : [];
  const mls = input.analytics?.ml ? dataNodes('ml') : [];
  let logMBps = 0;
  let deliveredMBps = 0;
  for (const p of plans) {
    const mb = (p.svc.pv * ANALYTICS.logKB) / 1000;
    logMBps += mb;
    if (!hadoops.length) continue;
    const per = p.webs.length ? mb / p.webs.length : 0;
    for (const w of p.webs) {
      const reach = hadoops.filter((h) => path(w, h));
      for (const h of reach) send(w, h, ((per / reach.length) * 8) / 1000, 0);
      if (reach.length) deliveredMBps += per;
    }
  }
  const mbPerHadoop = hadoops.length ? deliveredMBps / hadoops.length : 0;
  for (const h of hadoops) {
    addWork(h, roleKey('data', 'hadoop'), mbPerHadoop, ANALYTICS.hadoopCpuMsPerMB);
    addIo(h, mbPerHadoop * ANALYTICS.hadoopIoPerMB);
  }
  // 学習は集めたログ全体を使う。Hadoop から学習のノードへ渡す
  const mbPerMl = mls.length && hadoops.length ? deliveredMBps / mls.length : 0;
  for (const m of mls) {
    for (const h of hadoops) if (path(h, m)) send(h, m, ((mbPerMl / hadoops.length) * 8) / 1000, 0);
    if (hasGpu(m)) addGpuWork(m, roleKey('data', 'ml'), mbPerMl, ANALYTICS.mlGpuMsPerMB);
    else addWork(m, roleKey('data', 'ml'), mbPerMl, ANALYTICS.mlGpuMsPerMB * ANALYTICS.mlCpuSlowdown);
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
  function along(p: Route | null | undefined): [number, number] {
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
  }
  /** ノードが溢れずに処理できる割合(自分の CPU・ホストの CPU・ディスク、共有ディスクならストレージへの経路も) */
  function nodePass(id: number): number {
    const n = nodes.get(id)!;
    const l = loads.get(id)!;
    let ok = pass(Math.max(cpuRho(id), l.io, l.gpu ?? 0));
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
  const handoffLinks = handoffs.flatMap((h) => [...(g.adj.get(h.id)?.values() ?? [])]);
  const uplinkRho = handoffLinks.length ? Math.max(...handoffLinks.map(linkRho)) : 0;
  /** 回線を通って利用者に届くまでの時間 */
  function transferMs(kb: number): number {
    return ((kb * 8) / (input.uplinkGbps * 1000)) * q(uplinkRho);
  }

  // ---- サービスごとの結果
  // 分析: 届いたログのうち、溢れずに処理できた割合
  const coverage = logMBps > 0 && hadoops.length ? (deliveredMBps / logMBps) * avg(hadoops.map(nodePass)) : 0;
  const mlCoverage = coverage > 0 && mls.length ? coverage * avg(mls.map(nodePass)) : 0;
  const analytics: AnalyticsFlow = {
    logMBps,
    coverage,
    mlCoverage,
    boost: 1 + ANALYTICS.hadoopBoost * coverage + ANALYTICS.mlBoost * mlCoverage,
    hadoop: hadoops,
    ml: mls,
  };
  if (input.analytics?.hadoop && !hadoops.length) problems.push('分析基盤: 役割「hadoop」のサーバがありません(ログを集められない)');
  if (hadoops.length && deliveredMBps < logMBps - 1e-9) problems.push('分析基盤: web から hadoop に届かないログがあります');
  if (input.analytics?.ml && hadoops.length && !mls.length) problems.push('分析基盤: 役割「ml」のサーバがありません');
  for (const m of mls) if (!hasGpu(m)) problems.push(`分析基盤: ${name(m)} に GPU がないので、機械学習を CPU で動かしています(遅い)`);

  const services: Partial<Record<ServiceId, ServiceFlow>> = {};
  let totalPv = 0;
  let okPv = 0;
  let latPv = 0;
  const many = plans.length > 1;
  for (const p of plans) {
    const { success, latencyMs } = p.evaluate();
    p.warnRoutes();
    const pv = p.svc.pv;
    services[p.svc.id] = {
      id: p.svc.id,
      pv,
      success,
      latencyMs,
      p99Ms: latencyMs * P99_FACTOR,
      instances: p.inst,
      entries: p.entries,
      problems: p.sp,
    };
    totalPv += pv;
    okPv += pv * success;
    latPv += pv * latencyMs;
    for (const msg of p.sp) problems.push(many ? `${SERVICES[p.svc.id].name}: ${msg}` : msg);
  }
  const success = totalPv > 0 ? okPv / totalPv : avg(plans.map((p) => services[p.svc.id]!.success));
  const latencyMs = totalPv > 0 ? latPv / totalPv : avg(plans.map((p) => services[p.svc.id]!.latencyMs));

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
    consider(MODEL_BY_ID[d.model].category === 'lb' ? `${d.name} の処理能力` : `${d.name} の CPU`, l.cpu);
    consider(storage ? `${d.name} の IOPS` : `${d.name} のディスク IO`, l.io);
    consider(`${d.name} の処理能力`, l.fabric);
  }
  for (const n of nodeList) if (n.vm) consider(`${n.name} の vCPU`, loads.get(n.id)!.cpu);
  for (const d of facility.devices.values()) consider(`${d.name} の GPU`, devices.get(d.id)!.gpu);
  for (const l of g.links) consider(`${name(l.a)} ⇄ ${name(l.b)} の帯域`, linkRho(l));

  return {
    pv: totalPv,
    success: plans.length ? success : 1,
    latencyMs: plans.length ? latencyMs : NET.internetRttMs,
    p99Ms: (plans.length ? latencyMs : NET.internetRttMs) * P99_FACTOR,
    services,
    analytics,
    devices,
    links: g.links,
    cableRho,
    nodes,
    nodeLoads: loads,
    problems,
    bottleneck,
  };
}
