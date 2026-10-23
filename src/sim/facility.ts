/**
 * 物理層: 列・ラック・機器・ポート・ケーブル。お金や電力契約は扱わず、置けるか・つなげるかだけを判断する。
 */
import { MODEL_BY_ID, portsOf, type PortDef } from './catalog';
import { CABLE, RACK, ROW } from './config';
import type { ModelId, PortRef, RoleId } from './types';

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
  /** 割り当てた役割(サーバのみ) */
  roles: RoleId[];
  /** 買ったときの値段(売却時の返金に使う) */
  readonly paid: number;
  readonly name: string;
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
  return m.category === 'switch' ? 'sw' : 'srv';
}

export class Facility {
  readonly racks = new Map<number, Rack>();
  readonly devices = new Map<number, Device>();
  readonly cables = new Map<number, Cable>();
  /** 配置・配線が変わるたびに増える。描画や経路の作り直しの判定に使う */
  version = 0;
  private readonly portToCable = new Map<string, number>();
  private nextDeviceId = 1;
  private nextCableId = 1;

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
    const device: Device = { id, model, slot, u, roles: [], paid, name: opts.name ?? this.newName(model) };
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

  setRoles(id: number, roles: RoleId[]): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.roles = roles;
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
