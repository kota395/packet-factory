/**
 * 物理層: 列・ラック・機器・ポート・ケーブル。お金や電力契約は扱わず、置けるか・つなげるかだけを判断する。
 */
import { MODEL_BY_ID, portsOf, type PortDef } from './catalog';
import { CABLE, RACK, ROW, VIRT } from './config';
import type { DiskKind, ModelId, PortRef, RoleKey, VmSize } from './types';

export interface Rack {
  /** 列の中の位置(0 始まり) */
  readonly slot: number;
}

export interface Device {
  readonly id: number;
  readonly model: ModelId;
  /** 置いているラックの位置 */
  slot: number;
  /** 一番下の U(1 始まり)。2U の機器は u と u+1 を使う */
  u: number;
  /** 割り当てた役割(サーバのみ。ハイパーバイザにしたサーバは役割を持たず、VM が持つ) */
  roles: RoleKey[];
  /** ハイパーバイザ(VM を載せるホスト)にしているか */
  hv: boolean;
  /** BGP で経路を交換するか(物理サーバ。ハイパーバイザは BGP を解放すれば自動で使う) */
  bgp: boolean;
  /** Kubernetes のワーカーにしているか(役割は持たず、Pod が自動で置かれる) */
  k8s: boolean;
  /** メンテナンスで止めているか */
  down: boolean;
  /** 障害で止まっている。この時刻(シミュレーション時間)まで */
  failedUntil: number;
  /** 買ったときの値段(売却時の返金に使う) */
  readonly paid: number;
  readonly name: string;
}

/** 仮想マシン。ハイパーバイザにしたサーバの上で動き、役割を持つ */
export interface Vm {
  readonly id: number;
  readonly name: string;
  /** 載っているホスト(機器 ID) */
  host: number;
  readonly size: VmSize;
  roles: RoleKey[];
  disk: DiskKind;
  /** Kubernetes のワーカーにしているか */
  k8s: boolean;
  /** 別のホストへ移している間は止まる。この時刻(シミュレーション時間)まで */
  downUntil: number;
}

export interface Cable {
  readonly id: number;
  readonly a: PortRef;
  readonly b: PortRef;
  /** 長さ(m)。機器を動かすと引き直した長さになる */
  meters: number;
  /** 光ファイバ(片方でも SFP ならファイバ扱い) */
  readonly fiber: boolean;
  readonly paid: number;
}

const portKey = (r: PortRef) => `${r.device}:${r.port}`;

/** 名前の頭。同じ頭の中で 01, 02… と番号を振る */
function namePrefix(model: ModelId): string {
  const m = MODEL_BY_ID[model];
  if (m.category === 'handoff') return 'isp';
  if (model === 'agg-10g') return 'agg';
  if (m.category === 'storage') return 'nas';
  return m.category === 'switch' ? 'sw' : 'srv';
}

export class Facility {
  readonly racks = new Map<number, Rack>();
  readonly devices = new Map<number, Device>();
  readonly cables = new Map<number, Cable>();
  readonly vms = new Map<number, Vm>();
  /** 配置・配線が変わるたびに増える。描画や経路の作り直しの判定に使う */
  version = 0;
  private readonly portToCable = new Map<string, number>();
  private nextDeviceId = 1;
  private nextCableId = 1;
  private nextVmId = 1;

  // ---------------------------------------------------------------- ラック

  isRented(slot: number): boolean {
    return this.racks.has(slot);
  }

  rentError(slot: number): string | null {
    if (!Number.isInteger(slot) || slot < 0 || slot >= ROW.maxRacks) return '列の外です';
    if (this.racks.has(slot)) return 'すでに借りています';
    return null;
  }

  rent(slot: number): void {
    this.racks.set(slot, { slot });
    this.version++;
  }

  /** そのラックで使っている電力(W) */
  powerUsed(slot: number, ignore?: number): number {
    let w = 0;
    for (const d of this.devices.values()) if (d.slot === slot && d.id !== ignore) w += MODEL_BY_ID[d.model].powerW;
    return w;
  }

  /** そのラックで使っている U 数 */
  unitsUsed(slot: number): number {
    let n = 0;
    for (const d of this.devices.values()) if (d.slot === slot) n += MODEL_BY_ID[d.model].u;
    return n;
  }

  // ---------------------------------------------------------------- 機器

  /** その U を占めている機器 */
  deviceAt(slot: number, u: number): Device | undefined {
    for (const d of this.devices.values()) {
      if (d.slot === slot && u >= d.u && u < d.u + MODEL_BY_ID[d.model].u) return d;
    }
    return undefined;
  }

  /**
   * model を slot の u(一番下の U)に置けない理由。置けるなら null。
   * powerLimitW はラックの電力の上限、ignore は動かそうとしている機器自身
   */
  placeError(model: ModelId, slot: number, u: number, powerLimitW: number, ignore?: number): string | null {
    const m = MODEL_BY_ID[model];
    if (!this.racks.has(slot)) return 'まだ借りていないラックです';
    if (!Number.isInteger(u) || u < 1 || u + m.u - 1 > RACK.units) return 'ラックに収まりません';
    for (let i = u; i < u + m.u; i++) {
      const other = this.deviceAt(slot, i);
      if (other && other.id !== ignore) return `${i}U は ${other.name} が使っています`;
    }
    const power = this.powerUsed(slot, ignore) + m.powerW;
    if (power > powerLimitW) {
      return `電力が足りません(${power}W / 上限 ${powerLimitW}W)。投資の「電力契約」か、別のラックへ`;
    }
    return null;
  }

  place(model: ModelId, slot: number, u: number, paid: number, opts: { id?: number; name?: string } = {}): Device {
    const id = opts.id ?? this.nextDeviceId;
    this.nextDeviceId = Math.max(this.nextDeviceId, id + 1);
    const device: Device = { id, model, slot, u, roles: [], hv: false, bgp: false, k8s: false, down: false, failedUntil: 0, paid, name: opts.name ?? this.newName(model) };
    this.devices.set(id, device);
    this.version++;
    return device;
  }

  move(id: number, slot: number, u: number): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.slot = slot;
    d.u = u;
    // つながっているケーブルは引き直した長さにする
    for (const c of this.cablesOf(id)) c.meters = this.cableLength(c.a, c.b);
    this.version++;
  }

  /** 機器を外す。つながっていたケーブルも外し、外したケーブルを返す */
  remove(id: number): Cable[] {
    const removed = this.cablesOf(id);
    for (const c of removed) this.disconnect(c.id);
    this.devices.delete(id);
    this.version++;
    return removed;
  }

  setRoles(id: number, roles: RoleKey[]): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.roles = roles;
    this.version++;
  }

  setHv(id: number, on: boolean): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.hv = on;
    if (on) d.roles = [];
    this.version++;
  }

  setK8s(id: number, on: boolean): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.k8s = on;
    if (on) d.roles = [];
    this.version++;
  }

  setVmK8s(id: number, on: boolean): void {
    const v = this.vms.get(id);
    if (!v) return;
    v.k8s = on;
    if (on) v.roles = [];
    this.version++;
  }

  setBgp(id: number, on: boolean): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.bgp = on;
    this.version++;
  }

  setDown(id: number, down: boolean): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.down = down;
    this.version++;
  }

  // ---------------------------------------------------------------- 仮想マシン

  vmsOn(host: number): Vm[] {
    return [...this.vms.values()].filter((v) => v.host === host);
  }

  /** ホストで VM に割り当て済みのメモリ(GB)と vCPU */
  hostUsage(host: number, ignore?: number): { memGB: number; vcpu: number } {
    let memGB = 0;
    let vcpu = 0;
    for (const v of this.vms.values()) {
      if (v.host !== host || v.id === ignore) continue;
      memGB += VIRT.sizes[v.size].memGB;
      vcpu += VIRT.sizes[v.size].vcpu;
    }
    return { memGB, vcpu };
  }

  /** そのホストに size の VM を載せられない理由 */
  vmPlaceError(host: number, size: VmSize, ignore?: number): string | null {
    const d = this.devices.get(host);
    if (!d || MODEL_BY_ID[d.model].category !== 'server') return 'VM を載せられるのはサーバだけです';
    if (!d.hv) return `${d.name} はハイパーバイザになっていません`;
    const m = MODEL_BY_ID[d.model];
    const used = this.hostUsage(host, ignore);
    const s = VIRT.sizes[size];
    const memFree = m.memGB! - VIRT.hostMemGB - used.memGB;
    if (s.memGB > memFree) return `${d.name} のメモリが足りません(空き ${Math.max(0, memFree)}GB)`;
    const vcpuMax = m.cores! * VIRT.vcpuOvercommit;
    if (used.vcpu + s.vcpu > vcpuMax) return `${d.name} の vCPU が足りません(上限 ${vcpuMax})`;
    return null;
  }

  createVm(
    host: number,
    size: VmSize,
    opts: { id?: number; name?: string; roles?: RoleKey[]; disk?: DiskKind; k8s?: boolean } = {},
  ): Vm {
    const id = opts.id ?? this.nextVmId;
    this.nextVmId = Math.max(this.nextVmId, id + 1);
    const used = new Set([...this.vms.values()].map((v) => v.name));
    let name = opts.name;
    for (let n = 1; !name; n++) {
      const candidate = `vm${String(n).padStart(2, '0')}`;
      if (!used.has(candidate)) name = candidate;
    }
    const vm: Vm = { id, name, host, size, roles: opts.roles ?? [], disk: opts.disk ?? 'local', k8s: opts.k8s ?? false, downUntil: 0 };
    this.vms.set(id, vm);
    this.version++;
    return vm;
  }

  moveVm(id: number, host: number, downUntil: number): void {
    const v = this.vms.get(id);
    if (!v) return;
    v.host = host;
    v.downUntil = downUntil;
    this.version++;
  }

  removeVm(id: number): void {
    this.vms.delete(id);
    this.version++;
  }

  setVmRoles(id: number, roles: RoleKey[]): void {
    const v = this.vms.get(id);
    if (!v) return;
    v.roles = roles;
    this.version++;
  }

  setVmDisk(id: number, disk: DiskKind): void {
    const v = this.vms.get(id);
    if (!v) return;
    v.disk = disk;
    this.version++;
  }

  private newName(model: ModelId): string {
    const prefix = namePrefix(model);
    const used = new Set([...this.devices.values()].map((d) => d.name));
    for (let n = 1; ; n++) {
      const name = `${prefix}${String(n).padStart(2, '0')}`;
      if (!used.has(name)) return name;
    }
  }

  // ---------------------------------------------------------------- ポートとケーブル

  portDef(ref: PortRef): PortDef | undefined {
    const d = this.devices.get(ref.device);
    return d ? portsOf(d.model)[ref.port] : undefined;
  }

  cableAt(ref: PortRef): Cable | undefined {
    const id = this.portToCable.get(portKey(ref));
    return id === undefined ? undefined : this.cables.get(id);
  }

  cablesOf(deviceId: number): Cable[] {
    return [...this.cables.values()].filter((c) => c.a.device === deviceId || c.b.device === deviceId);
  }

  /** ケーブルの反対側 */
  otherEnd(cable: Cable, device: number): PortRef {
    return cable.a.device === device ? cable.b : cable.a;
  }

  connectError(a: PortRef, b: PortRef): string | null {
    const pa = this.portDef(a);
    const pb = this.portDef(b);
    if (!pa || !pb) return 'ポートが見つかりません';
    if (a.device === b.device) return '同じ機器のポート同士はつなげません';
    if (this.cableAt(a)) return `${this.portName(a)} はもう使われています`;
    if (this.cableAt(b)) return `${this.portName(b)} はもう使われています`;
    return null;
  }

  connect(a: PortRef, b: PortRef, paid: number, id?: number): Cable {
    const cid = id ?? this.nextCableId;
    this.nextCableId = Math.max(this.nextCableId, cid + 1);
    const cable: Cable = { id: cid, a, b, meters: this.cableLength(a, b), fiber: this.isFiber(a, b), paid };
    this.cables.set(cid, cable);
    this.portToCable.set(portKey(a), cid);
    this.portToCable.set(portKey(b), cid);
    this.version++;
    return cable;
  }

  disconnect(id: number): Cable | undefined {
    const c = this.cables.get(id);
    if (!c) return undefined;
    this.cables.delete(id);
    this.portToCable.delete(portKey(c.a));
    this.portToCable.delete(portKey(c.b));
    this.version++;
    return c;
  }

  /** 片方でも SFP なら光ファイバ(トランシーバ込み) */
  isFiber(a: PortRef, b: PortRef): boolean {
    return this.portDef(a)?.media === 'sfp' || this.portDef(b)?.media === 'sfp';
  }

  /** ポート間に引くケーブルの長さ(m)。ラック間はケーブルトレイを通る */
  cableLength(a: PortRef, b: PortRef): number {
    const da = this.devices.get(a.device);
    const db = this.devices.get(b.device);
    if (!da || !db) return 0;
    if (da.slot === db.slot) return round1(CABLE.sameRackBaseM + Math.abs(da.u - db.u) * CABLE.perUnitM);
    // ラックの上まで上がる分と下りる分も入れる
    const up = (RACK.units - da.u + RACK.units - db.u) * CABLE.perUnitM;
    return round1(CABLE.crossRackBaseM + up + Math.abs(da.slot - db.slot) * CABLE.perRackM);
  }

  /** 「sw01 ポート 3」のような呼び名 */
  portName(ref: PortRef): string {
    const d = this.devices.get(ref.device);
    const p = this.portDef(ref);
    if (!d || !p) return '?';
    const groups = MODEL_BY_ID[d.model].ports.length;
    return groups > 1 ? `${d.name} ${p.label} ${p.number}` : `${d.name} ポート ${p.number}`;
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;
