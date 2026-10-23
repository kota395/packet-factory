import { MODEL_BY_ID } from './catalog';
import {
  CHURN,
  DIFFICULTY,
  GROWTH_RATE,
  MIN_USERS,
  PV_PER_USER,
  REVENUE_PER_PV,
  START_USERS,
  TICK_MS,
} from './config';
import {
  UNLOCKS,
  UNLOCK_BY_ID,
  UPGRADE_BY_ID,
  emptyUpgrades,
  unlockCost,
  upgradeCost,
} from './economy';
import { Facility, type Cable, type Device } from './facility';
import { computeFlow, type FlowResult } from './flow';
import { Metrics } from './metrics';
import {
  RACK_PRICE,
  SELL_REFUND_RATE,
  START_MONEY,
  UPKEEP,
  cablePrice,
  growingPrice,
  modelPrice,
} from './pricing';
import type { ModelId, PortRef, RoleId, UnlockId, UpgradeId } from './types';

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: number;
}

export interface SimOptions {
  startMoney?: number;
  startUsers?: number;
  /** ページビュー/秒を固定の関数で与える(テスト用)。指定するとユーザーの増減を行わない */
  traffic?: (tMs: number) => number;
  unlocks?: Iterable<UnlockId>;
  disabledFeatures?: Iterable<UnlockId>;
  upgrades?: Partial<Record<UpgradeId, number>>;
}

/** 役割を割り当てるのに必要な解放(web と db は最初から使える) */
const ROLE_UNLOCK: Partial<Record<RoleId, UnlockId>> = { lb: 'lb', cache: 'cache' };

/**
 * ゲーム全体の状態。物理層(Facility)と、流量モデルによる計算、お金とユーザーを持つ。
 * 描画から独立していて、テストで直接動かせる。
 */
export class Simulation {
  time = 0;
  money: number;
  users: number;
  lifetimeEarned = 0;
  /** 投資のたびに増える。UI の再構築判定に使う */
  purchaseVersion = 0;
  readonly facility = new Facility();
  readonly metrics = new Metrics();
  readonly unlocks: Set<UnlockId>;
  readonly upgrades: Record<UpgradeId, number>;
  readonly disabledFeatures: Set<UnlockId>;
  /** 直近の流量計算の結果 */
  flow: FlowResult;

  private readonly fixedTraffic: ((tMs: number) => number) | null;
  private pendingMs = 0;

  constructor(opts: SimOptions = {}) {
    this.money = opts.startMoney ?? START_MONEY;
    this.users = opts.startUsers ?? START_USERS;
    this.fixedTraffic = opts.traffic ?? null;
    this.unlocks = new Set(opts.unlocks ?? []);
    this.upgrades = { ...emptyUpgrades(), ...opts.upgrades };
    this.disabledFeatures = new Set(opts.disabledFeatures ?? []);
    this.flow = this.computeFlow();
  }

  get layoutVersion(): number {
    return this.facility.version;
  }

  // ---------------------------------------------------------------- 経済の参照

  get marketSize(): number {
    return UPGRADE_BY_ID.marketing.effect(this.upgrades.marketing);
  }

  get uplinkGbps(): number {
    return UPGRADE_BY_ID.uplink.effect(this.upgrades.uplink);
  }

  get rackPowerW(): number {
    return UPGRADE_BY_ID.rackPower.effect(this.upgrades.rackPower);
  }

  /** 1 ページビューあたりの収益 */
  get revenuePerPv(): number {
    let m = UPGRADE_BY_ID.monetize.effect(this.upgrades.monetize);
    for (const u of UNLOCKS) if (u.effect && this.isFeatureActive(u.id)) m *= u.effect.revenue;
    return REVENUE_PER_PV * m;
  }

  /** 維持費の内訳($/秒) */
  get upkeep(): { racks: number; uplink: number; power: number } {
    const racks = this.facility.racks.size * UPKEEP.rackByPowerLevel[this.upgrades.rackPower];
    const uplink = UPKEEP.uplinkByLevel[this.upgrades.uplink];
    let watts = 0;
    for (const d of this.facility.devices.values()) watts += MODEL_BY_ID[d.model].powerW;
    return { racks, uplink, power: (watts / 1000) * UPKEEP.perKw };
  }

  get upkeepPerSec(): number {
    const u = this.upkeep;
    return u.racks + u.uplink + u.power;
  }

  get incomePerSec(): number {
    return this.metrics.rolling.revenuePerSec - this.upkeepPerSec;
  }

  /** 時刻 t のページビュー/秒 */
  trafficAt(tMs: number): number {
    if (this.fixedTraffic) return this.fixedTraffic(tMs);
    const wave = 1 + DIFFICULTY.dayWave * Math.sin((2 * Math.PI * tMs) / DIFFICULTY.dayCycleMs);
    return this.users * PV_PER_USER * wave;
  }

  isFeatureActive(id: UnlockId): boolean {
    return this.unlocks.has(id) && !this.disabledFeatures.has(id);
  }

  /** 割り当てられる役割 */
  get availableRoles(): Set<RoleId> {
    const roles = new Set<RoleId>(['web', 'db']);
    for (const [role, unlock] of Object.entries(ROLE_UNLOCK) as [RoleId, UnlockId][]) {
      if (this.unlocks.has(unlock)) roles.add(role);
    }
    return roles;
  }

  // ---------------------------------------------------------------- 価格

  rackPrice(): number {
    // 1 本目は最初から借りているので、2 本目が first
    return growingPrice(RACK_PRICE, Math.max(0, this.facility.racks.size - 1));
  }

  devicePrice(model: ModelId): number {
    let owned = 0;
    for (const d of this.facility.devices.values()) if (d.model === model) owned++;
    return modelPrice(model, owned);
  }

  /** ポート間にケーブルを引いたときの長さ・種類・値段 */
  cableQuote(a: PortRef, b: PortRef): { meters: number; fiber: boolean; price: number } {
    const meters = this.facility.cableLength(a, b);
    const fiber = this.facility.isFiber(a, b);
    return { meters, fiber, price: cablePrice(fiber, meters) };
  }

  upgradeCost(id: UpgradeId): number {
    return upgradeCost(id, this.upgrades[id]);
  }

  // ---------------------------------------------------------------- 物理層の操作

  rentRack(slot: number): ActionResult {
    const err = this.facility.rentError(slot);
    if (err) return { ok: false, message: err };
    const price = this.rackPrice();
    if (this.money < price) return { ok: false, message: `資金が足りません($${price} 必要)` };
    this.money -= price;
    this.facility.rent(slot);
    this.refreshFlow();
    return { ok: true, message: `ラック ${slot + 1} を借りました` };
  }

  canBuyModel(model: ModelId): string | null {
    const m = MODEL_BY_ID[model];
    if (m.category === 'handoff') return '回線終端は買えません';
    if (m.requires && !this.unlocks.has(m.requires)) return `投資の「${UNLOCK_BY_ID[m.requires].name}」が必要です`;
    return null;
  }

  placeError(model: ModelId, slot: number, u: number, ignore?: number): string | null {
    return this.facility.placeError(model, slot, u, this.rackPowerW, ignore);
  }

  buyDevice(model: ModelId, slot: number, u: number): ActionResult {
    const err = this.canBuyModel(model) ?? this.placeError(model, slot, u);
    if (err) return { ok: false, message: err };
    const price = this.devicePrice(model);
    if (this.money < price) return { ok: false, message: `資金が足りません($${price} 必要)` };
    this.money -= price;
    const d = this.facility.place(model, slot, u, price);
    this.refreshFlow();
    return { ok: true, id: d.id, message: `${d.name}(${MODEL_BY_ID[model].name})を設置しました` };
  }

  moveDevice(id: number, slot: number, u: number): ActionResult {
    const d = this.facility.devices.get(id);
    if (!d) return { ok: false, message: '機器が見つかりません' };
    if (MODEL_BY_ID[d.model].category === 'handoff') return { ok: false, message: '回線終端は動かせません' };
    if (d.slot === slot && d.u === u) return { ok: true };
    const err = this.placeError(d.model, slot, u, id);
    if (err) return { ok: false, message: err };
    this.facility.move(id, slot, u);
    this.refreshFlow();
    return { ok: true };
  }

  sellDevice(id: number): ActionResult {
    const d = this.facility.devices.get(id);
    if (!d) return { ok: false, message: '機器が見つかりません' };
    if (MODEL_BY_ID[d.model].category === 'handoff') return { ok: false, message: '回線終端は撤去できません' };
    const refund = Math.floor(d.paid * SELL_REFUND_RATE);
    const cables = this.facility.remove(id);
    this.money += refund;
    this.refreshFlow();
    const note = cables.length ? `、ケーブル ${cables.length} 本を外しました` : '';
    return { ok: true, message: `${d.name}を売却しました(+$${refund})${note}` };
  }

  connect(a: PortRef, b: PortRef): ActionResult {
    const err = this.facility.connectError(a, b);
    if (err) return { ok: false, message: err };
    const { price, meters, fiber } = this.cableQuote(a, b);
    if (this.money < price) return { ok: false, message: `資金が足りません($${price} 必要)` };
    this.money -= price;
    const c = this.facility.connect(a, b, price);
    this.refreshFlow();
    const kind = fiber ? '光ファイバ' : 'LAN ケーブル';
    return {
      ok: true,
      id: c.id,
      message: `${this.facility.portName(a)} ⇄ ${this.facility.portName(b)}(${kind} ${meters}m、$${price})`,
    };
  }

  disconnect(cableId: number): ActionResult {
    const c = this.facility.disconnect(cableId);
    if (!c) return { ok: false, message: 'ケーブルが見つかりません' };
    this.refreshFlow();
    return { ok: true, message: `${this.facility.portName(c.a)} ⇄ ${this.facility.portName(c.b)} のケーブルを抜きました` };
  }

  roleError(id: number, role: RoleId): string | null {
    const d = this.facility.devices.get(id);
    if (!d || MODEL_BY_ID[d.model].category !== 'server') return '役割はサーバにだけ割り当てられます';
    const unlock = ROLE_UNLOCK[role];
    if (unlock && !this.unlocks.has(unlock)) return `投資の「${UNLOCK_BY_ID[unlock].name}」が必要です`;
    return null;
  }

  /** 役割の割り当てを切り替える */
  toggleRole(id: number, role: RoleId): ActionResult {
    const d = this.facility.devices.get(id);
    const err = this.roleError(id, role);
    if (!d || err) return { ok: false, message: err ?? '機器が見つかりません' };
    const roles = d.roles.includes(role) ? d.roles.filter((r) => r !== role) : [...d.roles, role];
    this.facility.setRoles(id, roles);
    this.refreshFlow();
    return { ok: true };
  }

  // ---------------------------------------------------------------- 投資

  canBuyUpgrade(id: UpgradeId): string | null {
    const def = UPGRADE_BY_ID[id];
    if (def.requires && !this.unlocks.has(def.requires)) return `「${UNLOCK_BY_ID[def.requires].name}」が必要です`;
    if (def.maxLevel !== undefined && this.upgrades[id] >= def.maxLevel) return '最大レベルです';
    if (this.money < this.upgradeCost(id)) return '資金が足りません';
    return null;
  }

  buyUpgrade(id: UpgradeId): ActionResult {
    const err = this.canBuyUpgrade(id);
    if (err) return { ok: false, message: err };
    this.money -= this.upgradeCost(id);
    this.upgrades[id]++;
    this.purchaseVersion++;
    this.refreshFlow();
    return { ok: true, message: `${UPGRADE_BY_ID[id].name} Lv${this.upgrades[id]}` };
  }

  canUnlock(id: UnlockId): string | null {
    const def = UNLOCK_BY_ID[id];
    if (this.unlocks.has(id)) return '導入済みです';
    if (def.requires && !this.unlocks.has(def.requires)) return `「${UNLOCK_BY_ID[def.requires].name}」が必要です`;
    if (this.money < unlockCost(id)) return '資金が足りません';
    return null;
  }

  unlock(id: UnlockId): ActionResult {
    const err = this.canUnlock(id);
    if (err) return { ok: false, message: err };
    this.money -= unlockCost(id);
    this.unlocks.add(id);
    this.purchaseVersion++;
    this.refreshFlow();
    return { ok: true, message: `${UNLOCK_BY_ID[id].name}を導入しました` };
  }

  setFeatureEnabled(id: UnlockId, enabled: boolean): ActionResult {
    const def = UNLOCK_BY_ID[id];
    if (!def.effect) return { ok: false, message: `${def.name}は切り替えられません` };
    if (!this.unlocks.has(id)) return { ok: false, message: `${def.name}はまだ導入していません` };
    if (enabled) this.disabledFeatures.delete(id);
    else this.disabledFeatures.add(id);
    this.purchaseVersion++;
    this.refreshFlow();
    return { ok: true, message: `${def.name}を${enabled ? 'オン' : 'オフ'}にしました` };
  }

  // ---------------------------------------------------------------- 時間進行

  step(ms: number): void {
    this.pendingMs += ms;
    while (this.pendingMs >= TICK_MS) {
      this.pendingMs -= TICK_MS;
      this.tick();
    }
  }

  /** 配置や契約が変わったときに、すぐ流量を計算し直す(画面の反映を待たせない) */
  refreshFlow(): void {
    this.flow = this.computeFlow();
  }

  private computeFlow(): FlowResult {
    return computeFlow(this.facility, {
      pv: this.trafficAt(this.time),
      uplinkGbps: this.uplinkGbps,
      images: this.isFeatureActive('images'),
      comments: this.isFeatureActive('comments'),
      roles: this.availableRoles,
    });
  }

  private tick(): void {
    const dt = TICK_MS / 1000;
    this.time += TICK_MS;
    const flow = this.computeFlow();
    this.flow = flow;
    const pv = flow.pv * dt;
    const served = pv * flow.success;
    const revenue = served * this.revenuePerPv;
    this.money += revenue - this.upkeepPerSec * dt;
    this.lifetimeEarned += revenue;
    this.metrics.record(TICK_MS, pv, pv - served, flow.latencyMs, flow.p99Ms, revenue);
    if (!this.fixedTraffic) this.updateUsers(dt);
    this.metrics.advance(this.time, this.users);
  }

  /** ロジスティック成長 − 品質による離脱 */
  private updateUsers(dt: number): void {
    const u = this.users;
    const growth = GROWTH_RATE * u * (1 - u / this.marketSize);
    const r = this.metrics.rolling;
    let churn = 0;
    if (r.errorRate > CHURN.errorThreshold) churn += CHURN.errorFactor * (r.errorRate - CHURN.errorThreshold);
    if (r.p99Ms > CHURN.slowMs) churn += CHURN.slowRate;
    this.users = Math.max(MIN_USERS, u + (growth - churn * u) * dt);
  }
}

export type { Cable, Device };
