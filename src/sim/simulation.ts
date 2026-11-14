import { MODEL_BY_ID, isServerModel, specOf } from './catalog';
import { BLOG_FEATURES, CAMPAIGN, CDN, CHURN, DIFFICULTY, K8S, GROWTH_RATE, MIN_USERS, PV_PER_USER, METRICS, SERVICES, TICK_MS, scopeName } from './config';
import type { DifficultyId, Workload } from './config';
import { logistic, secondsUntil } from './forecast';
import { GOAL, GOALS, UNLOCKS, UNLOCK_BY_ID, UPGRADE_BY_ID, emptyUpgrades, unlockCost, upgradeCost, ROLE_UNLOCK } from './economy';
import type { GoalDef } from './economy';
import { Facility } from './facility';
import type { Cable, Device } from './facility';
import { computeFlow } from './flow';
import type { FlowResult, PodGroup, ServiceLoad } from './flow';
import { Metrics } from './metrics';
import type { Snapshot } from './metrics';
import { RACK_PRICE, START_MONEY, UPKEEP, MARKETING_REVENUE, CDN_PRICE_PER_GB, serverPrice, campaignPrice, growingPrice, modelPrice } from './pricing';
import { SERVICE_IDS, splitRole } from './types';
import type { Backplane, DiskKind, DriveType, ModelId, NicId, RoleId, RoleKey, Scope, ServerParts, ServiceId, UnlockId, UpgradeId, VmSize } from './types';
import * as hardware from './sim-hardware';
import * as k8s from './sim-k8s';
import * as virt from './sim-virt';

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: number;
}

export interface SimOptions {
  startMoney?: number;
  /** 難易度。指定しなければ「平和」(障害なし) */
  difficulty?: DifficultyId;
  /** 自動配線をやめて、facility.connect で手で組む(流量モデルのテスト用) */
  manualWiring?: boolean;
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

/** サーバのパーツの替え方(ワンクリックの強化・変更) */
export type PartChange =
  | { kind: 'cpu'; dir: 1 | -1 }
  | { kind: 'mem'; dir: 1 | -1 }
  | { kind: 'drive-add'; type: DriveType }
  | { kind: 'drive-remove' }
  | { kind: 'backplane'; to: Backplane }
  | { kind: 'nic'; to: NicId }
  | { kind: 'gpu'; dir: 1 | -1 };

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
  /** 達成した目標の数(GOALS の先頭から)と、いまの目標の条件を満たし続けている時間(ms) */
  goalsDone = 0;
  goalHeldMs = 0;
  /** 最後に達成した目標(画面で知らせるのに使う) */
  lastGoal: { index: number; reward: number; at: number } | null = null;
  /** 難易度(障害の起き方)。いつでも変えられる */
  difficulty: DifficultyId;
  /** 最後に起きた障害(画面で知らせるのに使う) */
  lastFailure: { id: number; name: string; at: number; repairSec: number } | null = null;
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
    this.facility.autoWire = !opts.manualWiring;
    this.difficulty = opts.difficulty ?? 'peace';
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
  /** 役割の持ち主(サービスか分析基盤)が動いているか */
  isScopeActive(scope: Scope): boolean {
    return scope === 'data' ? this.unlocks.has('hadoop') : this.isServiceActive(scope);
  }

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
    // 分析基盤(広告のターゲティング・おすすめ)
    m *= this.flow?.analytics.boost ?? 1;
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
    if (isServerModel(model)) return serverPrice(model, parts ?? hardware.defaultParts(this, model));
    let owned = 0;
    for (const d of this.facility.devices.values()) if (d.model === model) owned++;
    return modelPrice(model, owned);
  }

  upgradeCost(id: UpgradeId): number {
    const base = upgradeCost(id, this.upgrades[id]);
    if (id !== 'marketing') return base;
    // 広告は売上に比例して高くなる(後半にユーザーが一気に増えすぎないように)
    const levels = Math.max(0, this.upgrades.marketing + 1 - MARKETING_REVENUE.freeLevels);
    const byRevenue = this.metrics.rolling.revenuePerSec * MARKETING_REVENUE.secPerLevel * levels;
    return Math.max(base, Math.round(byRevenue));
  }

  // ---------------------------------------------------------------- 物理層の操作

  rentRack(slot: number): ActionResult {
    return hardware.rentRack(this, slot);
  }

  /** 最初からある回線終端(動かせない・売れない・止められない) */
  isMainLine(id: number): boolean {
    return hardware.isMainLine(this, id);
  }

  canBuyModel(model: ModelId, parts?: ServerParts): string | null {
    return hardware.canBuyModel(this, model, parts);
  }

  placeError(model: ModelId, slot: number, u: number, ignore?: number, parts?: ServerParts): string | null {
    return hardware.placeError(this, model, slot, u, ignore, parts);
  }

  /** 機器を買って置く。サーバは構成(プリセット ID かパーツ)を指定できる */
  buyDevice(model: ModelId, slot: number, u: number, config?: string | ServerParts): ActionResult {
    return hardware.buyDevice(this, model, slot, u, config);
  }

  /** プリセットでサーバを買う */
  buyServer(preset: string, slot: number, u: number): ActionResult {
    return hardware.buyServer(this, preset, slot, u);
  }

  // ---------------------------------------------------------------- サーバのパーツ

  /** パーツを替えたあとの構成と、かかるお金(新しいパーツの価格 − 外したパーツの下取り。マイナスなら戻ってくる) */
  partChangeInfo(id: number, change: PartChange): { parts: ServerParts | null; cost: number; error: string | null } {
    return hardware.partChangeInfo(this, id, change);
  }

  /** パーツを替える(ワンクリックの強化) */
  changeParts(id: number, change: PartChange): ActionResult {
    return hardware.changeParts(this, id, change);
  }

  moveDevice(id: number, slot: number, u: number): ActionResult {
    return hardware.moveDevice(this, id, slot, u);
  }

  /** 売ったときに戻る額。サーバは今の構成の価格で引き取る */
  sellValue(id: number): number {
    return hardware.sellValue(this, id);
  }

  sellDevice(id: number): ActionResult {
    return hardware.sellDevice(this, id);
  }

  roleError(id: number, role: RoleKey): string | null {
    return hardware.roleError(this, id, role);
  }

  /** その役割を今使えない理由(サービスを始めていない・解放していない) */
  roleUnlockError(key: RoleKey): string | null {
    return hardware.roleUnlockError(this, key);
  }

  /** 役割の割り当てを切り替える */
  toggleRole(id: number, role: RoleKey): ActionResult {
    return hardware.toggleRole(this, id, role);
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
  /**
   * 離れていた間のユーザーの増加を反映する。サービスごとに、市場規模と今の構成で捌ける量のどちらか小さい方へ
   * 向かって増える(減りはしない)。増えた人数の合計を返す
   */
  growWhileAway(seconds: number): number {
    if (this.fixedTraffic || seconds <= 0) return 0;
    this.estimateCapacity();
    let gained = 0;
    for (const id of this.activeServices) {
      const u = this.serviceUsers[id];
      const limit = Math.min(this.marketOf(id), this.capacityOf(id) / PV_PER_USER);
      if (limit <= u) continue;
      const next = Math.min(limit, logistic(u, this.marketOf(id), GROWTH_RATE, seconds));
      gained += next - u;
      this.serviceUsers[id] = next;
    }
    this.refreshFlow();
    return gained;
  }

  /** いまの目標(すべて達成していれば null) */
  get goal(): GoalDef | null {
    return GOALS[this.goalsDone] ?? null;
  }

  /** いまの目標の条件を満たしているか(捌けているページビュー・エラー率・サービスの数・分析の効果) */
  goalMet(): boolean {
    const g = this.goal;
    if (!g) return false;
    const r = this.metrics.rolling;
    return (
      r.errorRate < GOAL.maxErrorRate &&
      r.pv * (1 - r.errorRate) >= g.pv &&
      this.activeServices.length >= (g.services ?? 1) &&
      this.flow.analytics.boost >= (g.boost ?? 1)
    );
  }

  /** 目標: 条件を続けて満たしたら達成して報酬。流量を固定している(テスト用)ときは動かさない */
  private updateGoal(dtMs: number): void {
    const g = this.goal;
    if (!g || this.fixedTraffic) return;
    this.goalHeldMs = this.goalMet() ? this.goalHeldMs + dtMs : 0;
    if (this.goalHeldMs < GOAL.holdSec * 1000) return;
    this.money += g.reward;
    this.lastGoal = { index: this.goalsDone, reward: g.reward, at: this.time };
    this.goalsDone++;
    this.goalHeldMs = 0;
    this.purchaseVersion++;
  }

  private rollFailures(dt: number): void {
    const f = DIFFICULTY.levels[this.difficulty].failures;
    if (!f || this.facility.devices.size < f.fromDevices) return;
    let failed = false;
    for (const d of this.facility.devices.values()) {
      if (MODEL_BY_ID[d.model].category === 'handoff' || d.failedUntil > this.time) continue;
      if (this.random() < dt / f.mtbfSec) {
        d.failedUntil = this.time + f.repairSec * 1000;
        this.lastFailure = { id: d.id, name: d.name, at: this.time, repairSec: f.repairSec };
        failed = true;
      }
    }
    // 止まったワーカーの Pod はすぐ置き直す
    if (failed) this.schedule();
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
    return k8s.k8sWorkerError(this, target, on);
  }

  /** サーバか VM を Kubernetes のワーカーにする / やめる。する場合、付けていた役割は外れる */
  setK8sWorker(target: { device?: number; vm?: number }, on: boolean): ActionResult {
    return k8s.setK8sWorker(this, target, on);
  }

  deploymentError(key: RoleKey): string | null {
    return k8s.deploymentError(this, key);
  }

  /** 役割を Deployment にする / やめる。最初は下限の数の Pod から始め、あとは自動で増減する */
  toggleDeployment(key: RoleKey): ActionResult {
    return k8s.toggleDeployment(this, key);
  }

  /** Kubernetes 全体: ワーカーの数、Pod に使える vCPU、置いた Pod と待っている Pod */
  get k8sCapacity(): { workers: number; vcpu: number; pods: number; pending: number } {
    return k8s.k8sCapacity(this);
  }

  /**
   * スケジューラ: Deployment ごとの Pod を、空きの多いワーカーから順に置く(ワーカーに分散)。
   * 止まったワーカーの Pod は、ここで別のワーカーに置き直される
   */
  schedule(): void {
    return k8s.schedule(this);
  }

  // ---------------------------------------------------------------- 仮想化

  hvError(id: number, on: boolean): string | null {
    return virt.hvError(this, id, on);
  }

  /** サーバをハイパーバイザにする / やめる。する場合、付けていた役割は外れる */
  setHv(id: number, on: boolean): ActionResult {
    return virt.setHv(this, id, on);
  }

  // ---------------------------------------------------------------- クラスタ(コンピュートの資源としてまとめて扱う)

  /** サーバがスイッチにつながっているか(配線が済んでいるか) */
  isWired(id: number): boolean {
    return virt.isWired(this, id);
  }

  /** ハイパーバイザかワーカーに加えられる空きサーバ(配線済みで、役割もなく、ほかの用途にしていない) */
  get spareServers(): Device[] {
    return virt.spareServers(this);
  }

  /** ハイパーバイザ全体の割り当て(vCPU とメモリ) */
  get hvCapacity(): { hosts: number; vcpu: number; vcpuMax: number; memGB: number; memMax: number } {
    return virt.hvCapacity(this);
  }

  /** VM を置くホストを選ぶ: 載せられるホストのうち、メモリの空きが一番多いもの(止まっているホストは除く) */
  pickHost(size: VmSize): number | null {
    return virt.pickHost(this, size);
  }

  /**
   * ホストを選ばずに VM を作る(クラスタの画面から)。役割・ディスク・Kubernetes のワーカーにするかも一緒に決められる
   */
  createVmAuto(size: VmSize, opts: { roles?: RoleKey[]; disk?: DiskKind; k8s?: boolean } = {}): ActionResult {
    return virt.createVmAuto(this, size, opts);
  }

  createVm(host: number, size: VmSize): ActionResult {
    return virt.createVm(this, host, size);
  }

  deleteVm(id: number): ActionResult {
    return virt.deleteVm(this, id);
  }

  /** 別のホストへの移し方: 共有ストレージなら止めずに(ライブマイグレーション)、ローカルディスクならコピーの間止まる */
  vmMoveInfo(id: number, host: number): { error: string | null; downtimeMs: number } {
    return virt.vmMoveInfo(this, id, host);
  }

  moveVm(id: number, host: number): ActionResult {
    return virt.moveVm(this, id, host);
  }

  vmRoleError(id: number, role: RoleKey): string | null {
    return virt.vmRoleError(this, id, role);
  }

  toggleVmRole(id: number, role: RoleKey): ActionResult {
    return virt.toggleVmRole(this, id, role);
  }

  setVmDisk(id: number, disk: DiskKind): ActionResult {
    return virt.setVmDisk(this, id, disk);
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
   * Kubernetes の Pod は、オートスケールでワーカーを使い切るまで増えた前提で見積もる。
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
    const now = Object.fromEntries(this.activeServices.map((id) => [id, this.trafficOf(id, this.time)])) as Partial<Record<ServiceId, number>>;
    // Pod はオートスケールで増えるので、ワーカーを使い切った置き方で見積もる
    const full = k8s.podsAtFullScale(this);
    const success = (pv: Partial<Record<ServiceId, number>>) => this.computeFlow(pv, full);
    const target = METRICS.capacitySuccess;
    // 合計: 今の割合のまま全体を増やす(まだ流量がなければ均等に)
    const total = Object.values(now).reduce((a, b) => a + b!, 0);
    const ids = this.activeServices;
    const share = (id: ServiceId) => (total > 0 ? now[id]! / total : 1 / ids.length);
    this.capacityPv = Simulation.searchMax((x) => success(Object.fromEntries(ids.map((id) => [id, x * share(id)]))).success >= target, Math.max(1, total) * 2);
    for (const id of SERVICE_IDS) {
      if (!this.isServiceActive(id)) {
        delete this.capacityBy[id];
        continue;
      }
      this.capacityBy[id] = Simulation.searchMax((x) => (success({ ...now, [id]: x }).services[id]?.success ?? 0) >= target, Math.max(1, now[id] ?? 0) * 2);
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
  private computeFlow(pv?: Partial<Record<ServiceId, number>>, pods: PodGroup[] = this.pods): FlowResult {
    const services: ServiceLoad[] = this.activeServices.map((id) => ({
      id,
      pv: pv ? (pv[id] ?? 0) : this.trafficOf(id, this.time),
      work: this.workloadOf(id),
    }));
    const flow = computeFlow(this.facility, {
      services,
      pods,
      uplinkGbps: this.uplinkGbps,
      roles: this.availableRoles,
      now: this.time,
      bgp: this.unlocks.has('bgp'),
      analytics: { hadoop: this.unlocks.has('hadoop'), ml: this.unlocks.has('ml') },
      dbSplit: this.unlocks.has('sharding') ? 'shard' : this.unlocks.has('partition') ? 'functional' : 'none',
      down: this.downDevices,
    });
    for (const [id, why] of this.facility.unwired) {
      const d = this.facility.devices.get(id);
      if (d) flow.problems.push(`${d.name} はネットワークにつながっていません: ${why}`);
    }
    for (const [key, n] of this.podsPending) {
      const [s, r] = splitRole(key);
      flow.problems.push(`${scopeName(s)}の ${r} の Pod が ${n} 個、置き場所がなくて待っています(ワーカーを増やす)`);
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
    this.metrics.record({ dtMs: TICK_MS, pv, errors: Math.max(0, pv - served), latencyMs: flow.latencyMs, p99Ms: flow.p99Ms, revenue }, parts);
    if (!this.fixedTraffic) this.updateUsers(dt);
    this.updateGoal(TICK_MS);
    if (this.deployments.size && this.time - this.scaleAt >= K8S.scaleEveryMs) {
      this.scaleAt = this.time;
      k8s.autoscale(this);
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
        if (l.gpu > 0) add(`gpu:${d.id}`, `${d.name} GPU`, l.gpu);
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
