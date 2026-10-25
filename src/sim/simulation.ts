import {
  CPU_OPTIONS,
  DRIVES,
  MEMORY_OPTIONS,
  MODEL_BY_ID,
  PRESET_BY_ID,
  isServerModel,
  partsError,
  partsRequires,
  portsOf,
  specOf,
} from './catalog';
import {
  BLOG_FEATURES,
  CAMPAIGN,
  CDN,
  CHURN,
  DIFFICULTY,
  K8S,
  GROWTH_RATE,
  MIN_USERS,
  PV_PER_USER,
  METRICS,
  SERVICES,
  TICK_MS,
  VIRT,
  type Workload,
} from './config';
import { secondsUntil } from './forecast';
import {
  UNLOCKS,
  UNLOCK_BY_ID,
  UPGRADE_BY_ID,
  emptyUpgrades,
  unlockCost,
  upgradeCost,
} from './economy';
import { Facility, type Cable, type Device } from './facility';
import { POD_ID_BASE, computeFlow, type FlowResult, type PodGroup, type ServiceLoad } from './flow';
import { Metrics, type Snapshot } from './metrics';
import {
  RACK_PRICE,
  SELL_REFUND_RATE,
  PART_REFUND_RATE,
  PRICE_SCALE,
  START_MONEY,
  UPKEEP,
  BACKPLANE_PRICE,
  CDN_PRICE_PER_GB,
  cpuPrice,
  drivePrice,
  memoryPrice,
  nicPrice,
  serverPrice,
  cablePrice,
  campaignPrice,
  growingPrice,
  modelPrice,
} from './pricing';
import {
  SERVICE_IDS,
  splitRole,
  type Backplane,
  type DiskKind,
  type DriveType,
  type ModelId,
  type NicId,
  type PortRef,
  type RoleId,
  type RoleKey,
  type ServerParts,
  type ServiceId,
  type UnlockId,
  type UpgradeId,
  type VmSize,
} from './types';

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: number;
}

export interface SimOptions {
  startMoney?: number;
  /** ブログの最初のユーザー数(数値)か、サービスごとのユーザー数 */
  startUsers?: number | Partial<Record<ServiceId, number>>;
  /**
   * ページビュー/秒を固定の関数で与える(テスト用)。関数ならブログ、サービスごとに与えることもできる
   * (与えていないサービスは 0)。指定するとユーザーの増減を行わない
   */
  traffic?: ((tMs: number) => number) | Partial<Record<ServiceId, (tMs: number) => number>>;
  unlocks?: Iterable<UnlockId>;
  disabledFeatures?: Iterable<UnlockId>;
  upgrades?: Partial<Record<UpgradeId, number>>;
}

/** 役割を割り当てるのに必要な解放(web と db は最初から使える。search・media・worker はそれを使うサービスを始めれば使える) */
const ROLE_UNLOCK: Partial<Record<RoleId, UnlockId>> = { lb: 'slb', cache: 'cache', replica: 'replication' };

/** サーバのパーツの替え方(ワンクリックの強化・変更) */
export type PartChange =
  | { kind: 'cpu'; dir: 1 | -1 }
  | { kind: 'mem'; dir: 1 | -1 }
  | { kind: 'drive-add'; type: DriveType }
  | { kind: 'drive-remove' }
  | { kind: 'backplane'; to: Backplane }
  | { kind: 'nic'; to: NicId };

/** キャンペーンの状態(シミュレーション時刻 ms) */
export interface CampaignState {
  /** この時刻まで続く */
  until: number;
  /** この時刻まで次を打てない */
  cooldownUntil: number;
}

/**
 * ゲーム全体の状態。物理層(Facility)と、流量モデルによる計算、お金とユーザーを持つ。
 * 描画から独立していて、テストで直接動かせる。
 */
export class Simulation {
  time = 0;
  money: number;
  /** サービスごとのユーザー数(始めていないサービスも、始めたときの値を持っておく) */
  readonly serviceUsers: Record<ServiceId, number>;
  lifetimeEarned = 0;
  /** ショッピングのキャンペーン */
  campaign: CampaignState = { until: 0, cooldownUntil: 0 };
  /** Kubernetes: Deployment にした役割と、その Pod の数(オートスケールで変わる) */
  readonly deployments = new Map<RoleKey, number>();
  /** Pod の置き場所(スケジューラが決める) */
  pods: PodGroup[] = [];
  /** 置き場所が足りずに待っている Pod の数 */
  readonly podsPending = new Map<RoleKey, number>();
  /** Pod の置き場所が変わるたびに増える(描画の作り直しに使う) */
  podVersion = 0;
  private scaleAt = 0;
  /** 投資のたびに増える。UI の再構築判定に使う */
  purchaseVersion = 0;
  readonly facility = new Facility();
  readonly metrics = new Metrics();
  readonly unlocks: Set<UnlockId>;
  readonly upgrades: Record<UpgradeId, number>;
  readonly disabledFeatures: Set<UnlockId>;
  /** 直近の流量計算の結果 */
  flow: FlowResult;

  private readonly fixedTraffic: Partial<Record<ServiceId, (tMs: number) => number>> | null;
  private pendingMs = 0;

  constructor(opts: SimOptions = {}) {
    this.money = opts.startMoney ?? START_MONEY;
    this.serviceUsers = Object.fromEntries(SERVICE_IDS.map((id) => [id, SERVICES[id].startUsers])) as Record<ServiceId, number>;
    if (typeof opts.startUsers === 'number') this.serviceUsers.blog = opts.startUsers;
    else if (opts.startUsers) Object.assign(this.serviceUsers, opts.startUsers);
    this.fixedTraffic = typeof opts.traffic === 'function' ? { blog: opts.traffic } : (opts.traffic ?? null);
    this.unlocks = new Set(opts.unlocks ?? []);
    this.upgrades = { ...emptyUpgrades(), ...opts.upgrades };
    this.disabledFeatures = new Set(opts.disabledFeatures ?? []);
    this.flow = this.computeFlow();
  }

  get layoutVersion(): number {
    return this.facility.version;
  }

  // ---------------------------------------------------------------- 経済の参照

  /** そのサービスを始めているか(ブログは最初から) */
  isServiceActive(id: ServiceId): boolean {
    return id === 'blog' || this.unlocks.has(id);
  }

  /** 始めているサービス */
  get activeServices(): ServiceId[] {
    return SERVICE_IDS.filter((id) => this.isServiceActive(id));
  }

  /** 始めているサービスのユーザー数の合計 */
  get users(): number {
    return this.activeServices.reduce((s, id) => s + this.serviceUsers[id], 0);
  }

  set users(v: number) {
    this.serviceUsers.blog = v;
  }

  /** サービスの市場規模(潜在ユーザー数) */
  marketOf(id: ServiceId): number {
    return SERVICES[id].baseMarket * UPGRADE_BY_ID.marketing.effect(this.upgrades.marketing);
  }

  /** 始めているサービスの市場規模の合計 */
  get marketSize(): number {
    return this.activeServices.reduce((s, id) => s + this.marketOf(id), 0);
  }

  get uplinkGbps(): number {
    return UPGRADE_BY_ID.uplink.effect(this.upgrades.uplink);
  }

  get rackPowerW(): number {
    return UPGRADE_BY_ID.rackPower.effect(this.upgrades.rackPower);
  }

  /** サービスの 1 ページビューあたりの収益 */
  revenuePerPv(id: ServiceId = 'blog'): number {
    let m = UPGRADE_BY_ID.monetize.effect(this.upgrades.monetize);
    // 画像投稿・コメントはブログの機能
    if (id === 'blog') for (const u of UNLOCKS) if (u.effect && this.isFeatureActive(u.id)) m *= u.effect.revenue;
    if (id === 'shop' && this.campaignActive) m *= CAMPAIGN.revenueMul;
    return SERVICES[id].revenuePerPv * m;
  }

  /** サービスの 1 ページビューあたりの仕事量(機能のオン/オフを反映) */
  workloadOf(id: ServiceId): Workload {
    const w = SERVICES[id].work;
    // CDN があれば、画像・動画の多くはオリジンまで来ない
    const miss = this.unlocks.has('cdn') ? 1 - CDN.hitRate : 1;
    if (id !== 'blog') return w.media && miss < 1 ? { ...w, media: { ...w.media, perPv: w.media.perPv * miss } } : w;
    return {
      ...w,
      pageKB: w.pageKB + (this.isFeatureActive('images') ? BLOG_FEATURES.imageKB * miss : 0),
      dbWrites: w.dbWrites + (this.isFeatureActive('comments') ? BLOG_FEATURES.commentWrites : 0),
    };
  }

  /** 回線の本数(回線終端の数) */
  get lineCount(): number {
    let n = 0;
    for (const d of this.facility.devices.values()) if (d.model === 'handoff') n++;
    // 回線の契約は最初から 1 本ある
    return Math.max(1, n);
  }

  /** 維持費の内訳($/秒)。回線は本数ぶん、CDN は配った量に応じて */
  get upkeep(): { racks: number; uplink: number; power: number; cdn: number } {
    const racks = this.facility.racks.size * UPKEEP.rackByPowerLevel[this.upgrades.rackPower];
    const uplink = UPKEEP.uplinkByLevel[this.upgrades.uplink] * this.lineCount;
    let watts = 0;
    for (const d of this.facility.devices.values()) watts += specOf(d).powerW;
    const cdn = this.cdnGBps * CDN_PRICE_PER_GB;
    return { racks, uplink, power: (watts / 1000) * UPKEEP.perKw, cdn };
  }

  get upkeepPerSec(): number {
    const u = this.upkeep;
    return u.racks + u.uplink + u.power + u.cdn;
  }

  /** CDN が配っている量(GB/秒) */
  get cdnGBps(): number {
    if (!this.unlocks.has('cdn')) return 0;
    let kb = 0;
    for (const id of this.activeServices) kb += this.trafficOf(id, this.time) * this.cdnKBPerPv(id);
    return kb / 1e6;
  }

  /** CDN が 1 ページビューあたりに配る量(KB) */
  private cdnKBPerPv(id: ServiceId): number {
    const w = SERVICES[id].work;
    const images = id === 'blog' && this.isFeatureActive('images') ? BLOG_FEATURES.imageKB : 0;
    const media = w.media ? w.media.perPv * w.media.kb : 0;
    return (images + media) * CDN.hitRate;
  }

  get incomePerSec(): number {
    return this.metrics.rolling.revenuePerSec - this.upkeepPerSec;
  }

  /** 時刻 t のサービスのページビュー/秒(始めていなければ 0) */
  trafficOf(id: ServiceId, tMs: number): number {
    if (!this.isServiceActive(id)) return 0;
    if (this.fixedTraffic) return this.fixedTraffic[id]?.(tMs) ?? 0;
    const wave = 1 + DIFFICULTY.dayWave * Math.sin((2 * Math.PI * tMs) / DIFFICULTY.dayCycleMs);
    const boost = id === 'shop' && this.campaignActive ? CAMPAIGN.trafficMul : 1;
    return this.serviceUsers[id] * PV_PER_USER * wave * boost;
  }

  /** 時刻 t のページビュー/秒(すべてのサービスの合計) */
  trafficAt(tMs: number): number {
    return this.activeServices.reduce((s, id) => s + this.trafficOf(id, tMs), 0);
  }

  // ---------------------------------------------------------------- キャンペーン

  get campaignActive(): boolean {
    return this.campaign.until > this.time;
  }

  campaignPrice(): number {
    return campaignPrice(this.serviceUsers.shop);
  }

  campaignError(): string | null {
    if (!this.isServiceActive('shop')) return `投資の「${UNLOCK_BY_ID.shop.name}」が必要です`;
    if (this.campaignActive) return 'キャンペーン中です';
    if (this.campaign.cooldownUntil > this.time) {
      return `次に打てるまであと ${Math.ceil((this.campaign.cooldownUntil - this.time) / 1000)} 秒`;
    }
    if (this.money < this.campaignPrice()) return `資金が足りません($${this.campaignPrice()} 必要)`;
    return null;
  }

  /** キャンペーンを打つ。払った瞬間に始まり、終わるとクールタイム */
  startCampaign(): ActionResult {
    const err = this.campaignError();
    if (err) return { ok: false, message: err };
    this.money -= this.campaignPrice();
    this.campaign = {
      until: this.time + CAMPAIGN.durationSec * 1000,
      cooldownUntil: this.time + (CAMPAIGN.durationSec + CAMPAIGN.cooldownSec) * 1000,
    };
    this.purchaseVersion++;
    this.refreshFlow();
    return { ok: true, message: `キャンペーンを始めました(${CAMPAIGN.durationSec} 秒、訪問 ×${CAMPAIGN.trafficMul})` };
  }

  isFeatureActive(id: UnlockId): boolean {
    return this.unlocks.has(id) && !this.disabledFeatures.has(id);
  }

  /** 解放済みの役割の種類 */
  get availableRoles(): Set<RoleId> {
    const roles = new Set<RoleId>(['web', 'db']);
    for (const [role, unlock] of Object.entries(ROLE_UNLOCK) as [RoleId, UnlockId][]) {
      if (this.unlocks.has(unlock)) roles.add(role);
    }
    for (const id of this.activeServices) {
      for (const r of SERVICES[id].roles) if (!ROLE_UNLOCK[r]) roles.add(r);
    }
    return roles;
  }

  // ---------------------------------------------------------------- 価格

  rackPrice(): number {
    // 1 本目は最初から借りているので、2 本目が first
    return growingPrice(RACK_PRICE, Math.max(0, this.facility.racks.size - 1));
  }

  /** 機器の価格。サーバは構成(パーツ)ごと */
  devicePrice(model: ModelId, parts?: ServerParts): number {
    if (isServerModel(model)) return serverPrice(model, parts ?? this.defaultParts(model));
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

  /** プリセットを指定せずにサーバを買ったときの構成 */
  private defaultParts(model: 'srv-1u' | 'srv-2u'): ServerParts {
    return PRESET_BY_ID[model === 'srv-1u' ? '1u-web' : '2u-hdd'].parts;
  }

  /** 最初からある回線終端(動かせない・売れない・止められない) */
  isMainLine(id: number): boolean {
    let first: number | null = null;
    for (const d of this.facility.devices.values()) if (d.model === 'handoff' && (first === null || d.id < first)) first = d.id;
    return first === id;
  }

  canBuyModel(model: ModelId, parts?: ServerParts): string | null {
    const m = MODEL_BY_ID[model];
    if (m.category === 'handoff' && !this.unlocks.has('multihoming')) return `回線を増やすには投資の「${UNLOCK_BY_ID.multihoming.name}」が必要です`;
    if (m.requires && !this.unlocks.has(m.requires)) return `投資の「${UNLOCK_BY_ID[m.requires].name}」が必要です`;
    if (parts) return this.partsUnlockError(parts);
    return null;
  }

  private partsUnlockError(parts: ServerParts): string | null {
    for (const u of partsRequires(parts)) if (!this.unlocks.has(u)) return `投資の「${UNLOCK_BY_ID[u].name}」が必要です`;
    return null;
  }

  placeError(model: ModelId, slot: number, u: number, ignore?: number, parts?: ServerParts): string | null {
    const p = isServerModel(model) ? (parts ?? (ignore !== undefined ? undefined : this.defaultParts(model))) : null;
    return this.facility.placeError(model, slot, u, this.rackPowerW, ignore, p);
  }

  /** 機器を買って置く。サーバは構成(プリセット ID かパーツ)を指定できる */
  buyDevice(model: ModelId, slot: number, u: number, config?: string | ServerParts): ActionResult {
    let parts: ServerParts | undefined;
    if (isServerModel(model)) {
      const preset = typeof config === 'string' ? PRESET_BY_ID[config] : undefined;
      if (typeof config === 'string' && (!preset || preset.model !== model)) return { ok: false, message: 'その構成はありません' };
      parts = preset?.parts ?? (config as ServerParts | undefined) ?? this.defaultParts(model);
      const perr = partsError(model, parts);
      if (perr) return { ok: false, message: perr };
    }
    const err = this.canBuyModel(model, parts) ?? this.placeError(model, slot, u, undefined, parts);
    if (err) return { ok: false, message: err };
    const price = this.devicePrice(model, parts);
    if (this.money < price) return { ok: false, message: `資金が足りません($${price} 必要)` };
    this.money -= price;
    const d = this.facility.place(model, slot, u, price, { parts });
    this.refreshFlow();
    return { ok: true, id: d.id, message: `${d.name}(${MODEL_BY_ID[model].name})を設置しました` };
  }

  /** プリセットでサーバを買う */
  buyServer(preset: string, slot: number, u: number): ActionResult {
    const p = PRESET_BY_ID[preset];
    if (!p) return { ok: false, message: 'その構成はありません' };
    return this.buyDevice(p.model, slot, u, preset);
  }

  // ---------------------------------------------------------------- サーバのパーツ

  /** パーツを替えたあとの構成と、かかるお金(新しいパーツの価格 − 外したパーツの下取り。マイナスなら戻ってくる) */
  partChangeInfo(id: number, change: PartChange): { parts: ServerParts | null; cost: number; error: string | null } {
    const d = this.facility.devices.get(id);
    if (!d || !d.parts || !isServerModel(d.model)) return { parts: null, cost: 0, error: 'サーバではありません' };
    const p = d.parts;
    let next: ServerParts;
    let cost = 0;
    const refund = (v: number) => Math.floor(v * PART_REFUND_RATE);
    const bpPrice = Math.round(BACKPLANE_PRICE * PRICE_SCALE);
    const step = <T>(list: readonly T[], cur: T, dir: number): T | null => {
      const i = list.indexOf(cur) + dir;
      return i >= 0 && i < list.length ? list[i] : null;
    };
    switch (change.kind) {
      case 'cpu': {
        const cores = step(
          CPU_OPTIONS.map((o) => o.cores),
          p.cpu,
          change.dir,
        );
        if (cores === null) return { parts: null, cost: 0, error: change.dir > 0 ? 'これより上の CPU はありません' : 'これより下の CPU はありません' };
        next = { ...p, cpu: cores };
        cost = cpuPrice(cores) - refund(cpuPrice(p.cpu));
        break;
      }
      case 'mem': {
        const gb = step(MEMORY_OPTIONS, p.memGB, change.dir);
        if (gb === null) return { parts: null, cost: 0, error: change.dir > 0 ? 'これ以上は載りません' : 'これより減らせません' };
        next = { ...p, memGB: gb };
        cost = memoryPrice(gb) - refund(memoryPrice(p.memGB));
        break;
      }
      case 'drive-add': {
        if (DRIVES[change.type].bay !== p.backplane) {
          return { parts: null, cost: 0, error: p.backplane === 'lff' ? '3.5 インチのベイには HDD だけ' : '2.5 インチのベイには SSD・NVMe だけ' };
        }
        next = { ...p, drives: [...p.drives, change.type, change.type] };
        cost = drivePrice(change.type) * 2;
        break;
      }
      case 'drive-remove': {
        if (p.drives.length < 2) return { parts: null, cost: 0, error: 'ドライブがありません' };
        const removed = p.drives.slice(-2);
        next = { ...p, drives: p.drives.slice(0, -2) };
        cost = -removed.reduce((s, t) => s + refund(drivePrice(t)), 0);
        break;
      }
      case 'backplane': {
        if (change.to === p.backplane) return { parts: null, cost: 0, error: 'すでにその構成です' };
        // バックプレーンを替えると、入っていたドライブは外れる(下取り)。データ用に一番安いドライブを 2 本入れる
        const first: DriveType = change.to === 'lff' ? 'hdd' : 'ssd';
        next = { ...p, backplane: change.to, drives: [first, first] };
        cost = bpPrice + drivePrice(first) * 2 - p.drives.reduce((s, t) => s + refund(drivePrice(t)), 0);
        break;
      }
      case 'nic': {
        if (change.to === p.nic) return { parts: null, cost: 0, error: 'すでにその NIC です' };
        next = { ...p, nic: change.to };
        cost = nicPrice(change.to) - refund(nicPrice(p.nic));
        // 外す NIC のポートにケーブルが挿さっていたら外せない
        const before = portsOf(d).length;
        const after = portsOf({ model: d.model, parts: next }).length;
        for (let i = after; i < before; i++) {
          if (this.facility.cableAt({ device: id, port: i })) return { parts: null, cost: 0, error: '外す NIC にケーブルが挿さっています' };
        }
        break;
      }
    }
    const error =
      partsError(d.model, next) ??
      this.partsUnlockError(next) ??
      this.partsFitError(d, next) ??
      (cost > 0 && this.money < cost ? `資金が足りません($${cost} 必要)` : null);
    return { parts: next, cost, error };
  }

  /** 替えたあとの構成で、ラックの電力・載っている VM が収まるか */
  private partsFitError(d: Device, next: ServerParts): string | null {
    const watts = this.facility.powerUsed(d.slot, d.id) + specOf({ model: d.model, parts: next }).powerW;
    if (watts > this.rackPowerW) return `電力が足りません(${watts}W / 上限 ${this.rackPowerW}W)`;
    if (d.hv) {
      const used = this.facility.hostUsage(d.id);
      const s = specOf({ model: d.model, parts: next });
      if (used.memGB > s.memGB - VIRT.hostMemGB) return '載っている VM のメモリが収まりません';
      if (used.vcpu > s.cores * VIRT.vcpuOvercommit) return '載っている VM の vCPU が収まりません';
    }
    return null;
  }

  /** パーツを替える(ワンクリックの強化) */
  changeParts(id: number, change: PartChange): ActionResult {
    const info = this.partChangeInfo(id, change);
    if (info.error || !info.parts) return { ok: false, message: info.error ?? '替えられません' };
    const d = this.facility.devices.get(id)!;
    this.money -= info.cost;
    this.facility.setParts(id, info.parts);
    d.paid = serverPrice(d.model as 'srv-1u' | 'srv-2u', info.parts);
    this.schedule();
    this.refreshFlow();
    const money = info.cost >= 0 ? `-$${info.cost}` : `+$${-info.cost}`;
    return { ok: true, message: `${d.name} の構成を替えました(${money})` };
  }

  moveDevice(id: number, slot: number, u: number): ActionResult {
    const d = this.facility.devices.get(id);
    if (!d) return { ok: false, message: '機器が見つかりません' };
    if (this.isMainLine(d.id)) return { ok: false, message: '最初の回線終端は動かせません' };
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
    if (this.isMainLine(d.id)) return { ok: false, message: '最初の回線終端は撤去できません' };
    const vms = this.facility.vmsOn(id);
    if (vms.length) return { ok: false, message: `${d.name} には VM が ${vms.length} 台載っています。先に移すか消してください` };
    // サーバは今の構成の価格で引き取る
    const value = d.parts && isServerModel(d.model) ? serverPrice(d.model, d.parts) : d.paid;
    const refund = Math.floor(value * SELL_REFUND_RATE);
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

  roleError(id: number, role: RoleKey): string | null {
    const d = this.facility.devices.get(id);
    if (!d || MODEL_BY_ID[d.model].category !== 'server') return '役割はサーバにだけ割り当てられます';
    if (d.hv) return 'ハイパーバイザには役割を付けられません。VM に付けてください';
    if (d.k8s) return 'Kubernetes のワーカーには役割を付けられません(Pod が自動で置かれます)';
    return this.roleUnlockError(role);
  }

  private roleUnlockError(key: RoleKey): string | null {
    const [service, role] = splitRole(key);
    if (!SERVICES[service].roles.includes(role)) return `${SERVICES[service].name}には役割「${role}」はありません`;
    if (!this.isServiceActive(service)) return `投資の「${UNLOCK_BY_ID[service as UnlockId].name}」が必要です`;
    const unlock = ROLE_UNLOCK[role];
    if (unlock && !this.unlocks.has(unlock)) return `投資の「${UNLOCK_BY_ID[unlock].name}」が必要です`;
    return null;
  }

  /** 役割の割り当てを切り替える */
  toggleRole(id: number, role: RoleKey): ActionResult {
    const d = this.facility.devices.get(id);
    const err = this.roleError(id, role);
    if (!d || err) return { ok: false, message: err ?? '機器が見つかりません' };
    const roles = d.roles.includes(role) ? d.roles.filter((r) => r !== role) : [...d.roles, role];
    this.facility.setRoles(id, roles);
    this.refreshFlow();
    return { ok: true };
  }

  // ---------------------------------------------------------------- 冗長化と障害

  /** 止まっている機器(メンテナンスで止めたもの・障害中のもの) */
  get downDevices(): Set<number> {
    const set = new Set<number>();
    for (const d of this.facility.devices.values()) if (d.down || d.failedUntil > this.time) set.add(d.id);
    return set;
  }

  /** その機器が BGP で経路を交換しているか(物理サーバはオンにしたもの、ハイパーバイザは自動) */
  usesBgp(id: number): boolean {
    const d = this.facility.devices.get(id);
    return !!d && this.unlocks.has('bgp') && (d.bgp || d.hv);
  }

  bgpError(id: number): string | null {
    const d = this.facility.devices.get(id);
    if (!d || MODEL_BY_ID[d.model].category !== 'server') return 'BGP を使えるのはサーバだけです';
    if (!this.unlocks.has('bgp')) return `投資の「${UNLOCK_BY_ID.bgp.name}」が必要です`;
    if (d.hv) return 'ハイパーバイザは自動で BGP を使います';
    return null;
  }

  setBgp(id: number, on: boolean): ActionResult {
    const err = this.bgpError(id);
    if (err) return { ok: false, message: err };
    const d = this.facility.devices.get(id)!;
    this.facility.setBgp(id, on);
    this.refreshFlow();
    return { ok: true, message: `${d.name} の BGP を${on ? 'オン' : 'オフ'}にしました` };
  }

  /** メンテナンスで止める / 戻す。止めている間は通信も役割も止まる */
  setMaintenance(id: number, down: boolean): ActionResult {
    const d = this.facility.devices.get(id);
    if (!d) return { ok: false, message: '機器が見つかりません' };
    if (this.isMainLine(d.id)) return { ok: false, message: '最初の回線終端は止められません(増やした回線は止められる)' };
    this.facility.setDown(id, down);
    this.schedule();
    this.refreshFlow();
    return { ok: true, message: `${d.name} を${down ? 'メンテナンスで止めました' : '戻しました'}` };
  }

  /** 障害(難易度オプション): 機器がときどき壊れ、しばらくすると直る */
  private rollFailures(dt: number): void {
    const f = DIFFICULTY.failures;
    if (!f.enabled) return;
    for (const d of this.facility.devices.values()) {
      if (MODEL_BY_ID[d.model].category === 'handoff' || d.failedUntil > this.time) continue;
      if (this.random() < dt / f.mtbfSec) d.failedUntil = this.time + f.repairSec * 1000;
    }
  }

  private seed = 0x9e3779b9;
  /** 再現できる乱数(mulberry32) */
  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- Kubernetes

  /** ワーカーにできない理由(物理サーバは id、VM は vm を指定) */
  k8sWorkerError(target: { device?: number; vm?: number }, on: boolean): string | null {
    if (on && !this.unlocks.has('kubernetes')) return `投資の「${UNLOCK_BY_ID.kubernetes.name}」が必要です`;
    if (target.vm !== undefined) return this.facility.vms.has(target.vm) ? null : 'VM が見つかりません';
    const d = this.facility.devices.get(target.device ?? -1);
    if (!d || MODEL_BY_ID[d.model].category !== 'server') return 'ワーカーにできるのはサーバか VM だけです';
    if (d.hv) return 'ハイパーバイザはワーカーにできません。VM をワーカーにしてください';
    return null;
  }

  /** サーバか VM を Kubernetes のワーカーにする / やめる。する場合、付けていた役割は外れる */
  setK8sWorker(target: { device?: number; vm?: number }, on: boolean): ActionResult {
    const err = this.k8sWorkerError(target, on);
    if (err) return { ok: false, message: err };
    let label: string;
    if (target.vm !== undefined) {
      this.facility.setVmK8s(target.vm, on);
      label = this.facility.vms.get(target.vm)!.name;
    } else {
      this.facility.setK8s(target.device!, on);
      label = this.facility.devices.get(target.device!)!.name;
    }
    this.schedule();
    this.refreshFlow();
    return { ok: true, message: `${label} を${on ? 'Kubernetes のワーカーにしました' : 'ワーカーから外しました'}` };
  }

  deploymentError(key: RoleKey): string | null {
    if (!this.unlocks.has('kubernetes')) return `投資の「${UNLOCK_BY_ID.kubernetes.name}」が必要です`;
    const [, role] = splitRole(key);
    if (!K8S.roles.includes(role)) return `${role} は状態を持つので、Pod ではなくサーバか VM で動かします`;
    return this.roleUnlockError(key);
  }

  /** 役割を Deployment にする / やめる。最初は下限の数の Pod から始め、あとは自動で増減する */
  toggleDeployment(key: RoleKey): ActionResult {
    if (this.deployments.has(key)) {
      this.deployments.delete(key);
      this.podsPending.delete(key);
    } else {
      const err = this.deploymentError(key);
      if (err) return { ok: false, message: err };
      this.deployments.set(key, K8S.minPods);
    }
    this.schedule();
    this.purchaseVersion++;
    this.refreshFlow();
    const [s, r] = splitRole(key);
    return {
      ok: true,
      message: `${SERVICES[s].name}の ${r} を${this.deployments.has(key) ? 'Deployment にしました(Pod は自動で増減します)' : 'Deployment から外しました'}`,
    };
  }

  /** ワーカー(動いているもの)と、Pod に使える CPU・メモリ */
  private k8sWorkers(): { node: number; vcpu: number; memGB: number }[] {
    const down = this.downDevices;
    const out: { node: number; vcpu: number; memGB: number }[] = [];
    for (const d of [...this.facility.devices.values()].sort((a, b) => a.id - b.id)) {
      if (!d.k8s || d.hv || down.has(d.id)) continue;
      const m = specOf(d);
      out.push({ node: d.id, vcpu: m.cores, memGB: m.memGB - K8S.systemMemGB });
    }
    for (const v of [...this.facility.vms.values()].sort((a, b) => a.id - b.id)) {
      if (!v.k8s || v.downUntil > this.time || down.has(v.host)) continue;
      const z = VIRT.sizes[v.size];
      out.push({ node: -v.id, vcpu: z.vcpu, memGB: z.memGB - K8S.systemMemGB });
    }
    return out;
  }

  /**
   * スケジューラ: Deployment ごとの Pod を、空きの多いワーカーから順に置く(ワーカーに分散)。
   * 止まったワーカーの Pod は、ここで別のワーカーに置き直される
   */
  schedule(): void {
    const workers = this.k8sWorkers().map((w) => ({ ...w, freeCpu: w.vcpu, freeMem: w.memGB }));
    const placed = new Map<string, number>();
    this.podsPending.clear();
    for (const [key, count] of this.deployments) {
      if (this.deploymentError(key)) continue;
      for (let i = 0; i < count; i++) {
        let best: (typeof workers)[number] | null = null;
        for (const w of workers) {
          if (w.freeCpu < K8S.pod.vcpu || w.freeMem < K8S.pod.memGB) continue;
          if (!best || w.freeCpu > best.freeCpu) best = w;
        }
        if (!best) {
          this.podsPending.set(key, count - i);
          break;
        }
        best.freeCpu -= K8S.pod.vcpu;
        best.freeMem -= K8S.pod.memGB;
        const k = `${best.node}|${key}`;
        placed.set(k, (placed.get(k) ?? 0) + 1);
      }
    }
    let id = POD_ID_BASE;
    const pods: PodGroup[] = [];
    for (const [k, count] of placed) {
      const [worker, role] = k.split('|');
      pods.push({ id: id++, worker: Number(worker), role: role as RoleKey, count });
    }
    const sig = (list: PodGroup[]) => list.map((p) => `${p.worker}${p.role}${p.count}`).join();
    if (sig(pods) !== sig(this.pods)) this.podVersion++;
    this.pods = pods;
  }

  /** オートスケール(HPA): Deployment ごとに、Pod の CPU 使用率が目標になるよう数を変える */
  private autoscale(): void {
    for (const [key, current] of this.deployments) {
      let used = 0;
      let cores = 0;
      for (const n of this.flow.nodes.values()) {
        if (n.pods === undefined || !n.roles.includes(key)) continue;
        used += this.flow.nodeLoads.get(n.id)!.cpu * n.cores;
        cores += n.cores;
      }
      if (!cores) continue;
      const util = used / cores;
      let desired = Math.ceil((current * util) / K8S.targetCpu);
      if (desired < current) desired = Math.max(desired, current - Math.max(1, Math.floor(current * K8S.scaleDownRate)));
      this.deployments.set(key, Math.min(K8S.maxPods, Math.max(K8S.minPods, desired)));
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- 仮想化

  hvError(id: number, on: boolean): string | null {
    const d = this.facility.devices.get(id);
    if (!d || MODEL_BY_ID[d.model].category !== 'server') return 'ハイパーバイザにできるのはサーバだけです';
    if (on && !this.unlocks.has('virtualization')) return `投資の「${UNLOCK_BY_ID.virtualization.name}」が必要です`;
    if (on && d.k8s) return 'Kubernetes のワーカーはハイパーバイザにできません';
    if (!on && this.facility.vmsOn(id).length) return 'VM が載っている間はやめられません';
    return null;
  }

  /** サーバをハイパーバイザにする / やめる。する場合、付けていた役割は外れる */
  setHv(id: number, on: boolean): ActionResult {
    const err = this.hvError(id, on);
    if (err) return { ok: false, message: err };
    const d = this.facility.devices.get(id)!;
    const dropped = d.roles.length;
    this.facility.setHv(id, on);
    this.refreshFlow();
    const note = on && dropped ? '(役割は外れました。VM に付けてください)' : '';
    return { ok: true, message: `${d.name} を${on ? 'ハイパーバイザにしました' : '物理サーバに戻しました'}${note}` };
  }

  createVm(host: number, size: VmSize): ActionResult {
    const err = this.facility.vmPlaceError(host, size);
    if (err) return { ok: false, message: err };
    const vm = this.facility.createVm(host, size);
    this.refreshFlow();
    return { ok: true, id: vm.id, message: `${vm.name}(${VIRT.sizes[size].label})を作りました` };
  }

  deleteVm(id: number): ActionResult {
    const vm = this.facility.vms.get(id);
    if (!vm) return { ok: false, message: 'VM が見つかりません' };
    this.facility.removeVm(id);
    this.refreshFlow();
    return { ok: true, message: `${vm.name} を消しました` };
  }

  /** 別のホストへの移し方: 共有ストレージなら止めずに(ライブマイグレーション)、ローカルディスクならコピーの間止まる */
  vmMoveInfo(id: number, host: number): { error: string | null; downtimeMs: number } {
    const vm = this.facility.vms.get(id);
    if (!vm) return { error: 'VM が見つかりません', downtimeMs: 0 };
    if (vm.host === host) return { error: 'すでにそのホストにいます', downtimeMs: 0 };
    if (vm.downUntil > this.time) return { error: '移している途中です', downtimeMs: 0 };
    return {
      error: this.facility.vmPlaceError(host, vm.size, id),
      downtimeMs: vm.disk === 'shared' ? 0 : VIRT.migrateDowntimeMs,
    };
  }

  moveVm(id: number, host: number): ActionResult {
    const { error, downtimeMs } = this.vmMoveInfo(id, host);
    if (error) return { ok: false, message: error };
    const vm = this.facility.vms.get(id)!;
    this.facility.moveVm(id, host, this.time + downtimeMs);
    this.refreshFlow();
    const to = this.facility.devices.get(host)!.name;
    return {
      ok: true,
      message: downtimeMs
        ? `${vm.name} を ${to} へ移しています(ディスクのコピーで ${downtimeMs / 1000} 秒止まります)`
        : `${vm.name} を ${to} へライブマイグレーションしました`,
    };
  }

  vmRoleError(id: number, role: RoleKey): string | null {
    const vm = this.facility.vms.get(id);
    if (!vm) return 'VM が見つかりません';
    if (vm.k8s) return 'Kubernetes のワーカーには役割を付けられません(Pod が自動で置かれます)';
    return this.roleUnlockError(role);
  }

  toggleVmRole(id: number, role: RoleKey): ActionResult {
    const vm = this.facility.vms.get(id);
    const err = this.vmRoleError(id, role);
    if (!vm || err) return { ok: false, message: err ?? 'VM が見つかりません' };
    this.facility.setVmRoles(id, vm.roles.includes(role) ? vm.roles.filter((r) => r !== role) : [...vm.roles, role]);
    this.refreshFlow();
    return { ok: true };
  }

  setVmDisk(id: number, disk: DiskKind): ActionResult {
    const vm = this.facility.vms.get(id);
    if (!vm) return { ok: false, message: 'VM が見つかりません' };
    if (disk === 'shared' && !this.unlocks.has('storage')) {
      return { ok: false, message: `投資の「${UNLOCK_BY_ID.storage.name}」が必要です` };
    }
    this.facility.setVmDisk(id, disk);
    this.refreshFlow();
    return {
      ok: true,
      message: disk === 'shared' ? `${vm.name} のディスクを共有ストレージへ移しました` : `${vm.name} のディスクをローカルへ戻しました`,
    };
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

  // ---------------------------------------------------------------- キャパシティと需要予測

  /**
   * 今の構成で捌けるページビュー/秒の見積もり(成功率 METRICS.capacitySuccess を保てる最大)。
   *  - capacityPv: すべてのサービスの流量を同じ倍率で増やしたときの、合計の上限
   *  - capacityOf: そのサービスだけを増やしたとき(ほかは今の流量のまま)の、そのサービスの上限
   * 流量を変えて計算し直す二分探索なので、数秒ごとにだけ更新する
   */
  capacityPv = 0;
  readonly capacityBy: Partial<Record<ServiceId, number>> = {};
  private capacityAt = -Infinity;

  capacityOf(id: ServiceId): number {
    return this.capacityBy[id] ?? 0;
  }

  /** f(x) が成り立つ最大の x(start から倍々に広げてから二分探索) */
  private static searchMax(ok: (x: number) => boolean, start: number): number {
    if (!ok(start / 1000)) return 0;
    let lo = start / 1000;
    let hi = Math.max(start, lo * 2);
    while (ok(hi) && hi < 1e8) {
      lo = hi;
      hi *= 2;
    }
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  estimateCapacity(): number {
    const now = Object.fromEntries(this.activeServices.map((id) => [id, this.trafficOf(id, this.time)])) as Partial<
      Record<ServiceId, number>
    >;
    const success = (pv: Partial<Record<ServiceId, number>>) => this.computeFlow(pv);
    const target = METRICS.capacitySuccess;
    // 合計: 今の割合のまま全体を増やす(まだ流量がなければ均等に)
    const total = Object.values(now).reduce((a, b) => a + b!, 0);
    const ids = this.activeServices;
    const share = (id: ServiceId) => (total > 0 ? now[id]! / total : 1 / ids.length);
    this.capacityPv = Simulation.searchMax(
      (x) => success(Object.fromEntries(ids.map((id) => [id, x * share(id)]))).success >= target,
      Math.max(1, total) * 2,
    );
    for (const id of SERVICE_IDS) {
      if (!this.isServiceActive(id)) {
        delete this.capacityBy[id];
        continue;
      }
      this.capacityBy[id] = Simulation.searchMax(
        (x) => (success({ ...now, [id]: x }).services[id]?.success ?? 0) >= target,
        Math.max(1, now[id] ?? 0) * 2,
      );
    }
    // 見積もりの計算で共有の経路データを使い回すので、今の流量で計算し直しておく
    this.refreshFlow();
    this.capacityAt = this.time;
    return this.capacityPv;
  }

  /**
   * 需要がキャパシティに届くまでの秒数(広告で市場を広げない場合)。届かないなら null、もう超えていれば 0。
   * サービスを指定しなければ、いちばん早く届くサービス
   */
  secondsToSaturation(id?: ServiceId): number | null {
    if (!id) {
      const all = this.activeServices.map((s) => this.secondsToSaturation(s)).filter((x): x is number => x !== null);
      return all.length ? Math.min(...all) : null;
    }
    const boost = id === 'shop' && this.campaignActive ? CAMPAIGN.trafficMul : 1;
    return secondsUntil(this.serviceUsers[id], this.marketOf(id), GROWTH_RATE, this.capacityOf(id) / PV_PER_USER / boost);
  }

  /** 流量を計算する。pv を与えればそのページビュー/秒で(キャパシティの見積もり用) */
  private computeFlow(pv?: Partial<Record<ServiceId, number>>): FlowResult {
    const services: ServiceLoad[] = this.activeServices.map((id) => ({
      id,
      pv: pv ? (pv[id] ?? 0) : this.trafficOf(id, this.time),
      work: this.workloadOf(id),
    }));
    const flow = computeFlow(this.facility, {
      services,
      pods: this.pods,
      uplinkGbps: this.uplinkGbps,
      roles: this.availableRoles,
      now: this.time,
      bgp: this.unlocks.has('bgp'),
      dbSplit: this.unlocks.has('sharding') ? 'shard' : this.unlocks.has('partition') ? 'functional' : 'none',
      down: this.downDevices,
    });
    for (const [key, n] of this.podsPending) {
      const [s, r] = splitRole(key);
      flow.problems.push(`${SERVICES[s].name}の ${r} の Pod が ${n} 個、置き場所がなくて待っています(ワーカーを増やす)`);
    }
    if (this.deployments.size && !this.pods.length && !this.podsPending.size) {
      flow.problems.push('Kubernetes のワーカーがありません');
    }
    return flow;
  }

  private tick(): void {
    const dt = TICK_MS / 1000;
    this.time += TICK_MS;
    this.rollFailures(dt);
    const flow = this.computeFlow();
    this.flow = flow;
    const parts = [];
    let revenue = 0;
    let served = 0;
    for (const sf of Object.values(flow.services)) {
      const pv = sf.pv * dt;
      const ok = pv * sf.success;
      const rev = ok * this.revenuePerPv(sf.id);
      served += ok;
      revenue += rev;
      parts.push({ id: sf.id, dtMs: TICK_MS, pv, errors: Math.max(0, pv - ok), latencyMs: sf.latencyMs, p99Ms: sf.p99Ms, revenue: rev });
    }
    const pv = flow.pv * dt;
    this.money += revenue - this.upkeepPerSec * dt;
    this.lifetimeEarned += revenue;
    this.metrics.record(
      { dtMs: TICK_MS, pv, errors: Math.max(0, pv - served), latencyMs: flow.latencyMs, p99Ms: flow.p99Ms, revenue },
      parts,
    );
    if (!this.fixedTraffic) this.updateUsers(dt);
    if (this.deployments.size && this.time - this.scaleAt >= K8S.scaleEveryMs) {
      this.scaleAt = this.time;
      this.autoscale();
      this.refreshFlow();
    }
    if (this.time - this.capacityAt >= METRICS.capacityEveryMs) this.estimateCapacity();
    this.metrics.advance(this.time, () => this.snapshot());
  }

  /** 1 秒ごとの推移に残す値 */
  private snapshot(): Snapshot {
    const f = this.facility;
    const flow = this.flow;
    const resources: Snapshot['resources'] = [];
    const add = (key: string, label: string, rho: number) => {
      if (rho > 0.001) resources.push({ key, label, rho });
    };
    for (const d of f.devices.values()) {
      const l = flow.devices.get(d.id);
      if (!l) continue;
      const cat = MODEL_BY_ID[d.model].category;
      if (cat === 'server') {
        add(`cpu:${d.id}`, `${d.name} CPU`, l.cpu);
        add(`io:${d.id}`, `${d.name} ディスク`, l.io);
      } else if (cat === 'storage') add(`io:${d.id}`, `${d.name} IOPS`, l.io);
      else if (cat === 'lb') add(`lb:${d.id}`, `${d.name} 処理`, l.cpu);
      else if (cat === 'switch') add(`fab:${d.id}`, `${d.name} 処理`, l.fabric);
    }
    for (const n of flow.nodes.values()) if (n.vm) add(`vm:${n.id}`, `${n.name} vCPU`, flow.nodeLoads.get(n.id)!.cpu);
    for (const l of flow.links) {
      const rho = l.capacityGbps > 0 ? Math.max(l.ab, l.ba) / l.capacityGbps : 0;
      add(`link:${l.a}-${l.b}`, `${f.devices.get(l.a)?.name}⇄${f.devices.get(l.b)?.name}`, rho);
    }
    return {
      users: this.users,
      market: this.marketSize,
      money: this.money,
      upkeep: this.upkeepPerSec,
      capacity: this.capacityPv,
      resources,
      services: this.activeServices.map((id) => ({
        id,
        users: this.serviceUsers[id],
        market: this.marketOf(id),
        capacity: this.capacityOf(id),
      })),
    };
  }

  /** サービスごとに、ロジスティック成長 − 品質による離脱(+ キャンペーンで残るユーザー) */
  private updateUsers(dt: number): void {
    for (const id of this.activeServices) {
      const u = this.serviceUsers[id];
      const market = this.marketOf(id);
      let growth = GROWTH_RATE * u * (1 - u / market);
      if (id === 'shop' && this.campaignActive && u < market) growth += (CAMPAIGN.retainRate * market) / CAMPAIGN.durationSec;
      const r = this.metrics.rollingOf(id);
      let churn = 0;
      if (r.errorRate > CHURN.errorThreshold) churn += CHURN.errorFactor * (r.errorRate - CHURN.errorThreshold);
      if (r.p99Ms > CHURN.slowMs) churn += CHURN.slowRate;
      this.serviceUsers[id] = Math.max(MIN_USERS, u + (growth - churn * u) * dt);
    }
  }
}

export type { Cable, Device };
