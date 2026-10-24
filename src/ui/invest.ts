import {
  LINES,
  STAGES,
  UNLOCKS,
  UNLOCK_BY_ID,
  UPGRADES,
  UPGRADE_BY_ID,
  unlockCost,
  type FeatureEffect,
  type LineDef,
  type StageDef,
  type UpgradeDef,
} from '../sim/economy';
import { CAMPAIGN } from '../sim/config';
import type { Simulation } from '../sim/simulation';
import type { UnlockId, UpgradeId } from '../sim/types';
import { money } from './format';

type Item = { type: 'unlock'; id: UnlockId } | { type: 'upgrade'; id: UpgradeId } | { type: 'campaign'; id: 'shopSale' };

export function formatUpgradeEffect(def: UpgradeDef, level: number): string {
  return def.format(def.effect(level));
}

/** いまの段階 = 目印の解放を 1 つでも買った段階のうち一番先(何も買っていなければ段階 1) */
export function currentStage(sim: Simulation): StageDef {
  let current = STAGES[0];
  for (const s of STAGES) if (s.unlocks.some((u) => sim.unlocks.has(u))) current = s;
  return current;
}

/** 解放が目印になっている段階 */
function stageOfUnlock(id: UnlockId): StageDef | null {
  return STAGES.find((s) => s.unlocks.includes(id)) ?? null;
}

function describeFeature(effect: FeatureEffect): string {
  return `ブログの単価 ×${effect.revenue}`;
}

const TAB_KEY = 'packet-factory:invest-tab';

/** タブ(系統)の中身。段階の順に、まだ買っていない解放と強化を並べる */
function lineItems(sim: Simulation, line: LineDef): Item[] {
  return [
    // ショッピングを始めていれば、事業のタブの先頭にキャンペーン
    ...(line.id === 'business' && sim.isServiceActive('shop') ? [{ type: 'campaign' as const, id: 'shopSale' as const }] : []),
    ...line.upgrades.map((id) => ({ type: 'upgrade' as const, id })),
    ...line.unlocks.filter((id) => !sim.unlocks.has(id)).map((id) => ({ type: 'unlock' as const, id })),
  ];
}

/**
 * 投資(解放・強化)の一覧と、導入済みの配信コンテンツのオン/オフ。
 * 系統(事業 / WEB / 回線 / データ)ごとのタブに分け、上にはいまの段階を出す。
 * 購入や切り替えがあったときだけ組み直し、それ以外はボタンの状態だけ更新する。
 */
export class InvestPanel {
  private builtFor: Simulation | null = null;
  private builtVersion = -1;
  private builtTab = '';
  private tab: string;
  private readonly stageBox: HTMLElement;
  private readonly tabs: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly list: HTMLElement,
    private readonly moneyLabel: HTMLElement,
    private readonly getSim: () => Simulation,
    private readonly onResult: (message: string | undefined, ok: boolean) => void,
  ) {
    this.stageBox = root.querySelector<HTMLElement>('#invest-stage')!;
    this.tabs = root.querySelector<HTMLElement>('#invest-tabs')!;
    this.tab = LINES[0].id;
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (saved && LINES.some((l) => l.id === saved)) this.tab = saved;
    } catch {
      // 保存できない環境では毎回最初のタブ
    }
    this.tabs.innerHTML = LINES.map(
      (l) => `<button type="button" role="tab" data-tab="${l.id}">${l.name}<span class="badge" hidden></span></button>`,
    ).join('');
    this.tabs.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
      if (!button) return;
      this.tab = button.dataset.tab!;
      try {
        localStorage.setItem(TAB_KEY, this.tab);
      } catch {
        // 覚えておけなくても切り替えはできる
      }
      this.list.scrollTop = 0;
      this.update();
    });
    this.list.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-type]');
      if (!button || button.disabled) return;
      const sim = this.getSim();
      const id = button.dataset.id!;
      const r =
        button.dataset.type === 'campaign'
          ? sim.startCampaign()
          : button.dataset.type === 'unlock'
          ? sim.unlock(id as UnlockId)
          : button.dataset.type === 'feature'
            ? sim.setFeatureEnabled(id as UnlockId, !sim.isFeatureActive(id as UnlockId))
            : sim.buyUpgrade(id as UpgradeId);
      this.onResult(r.message, r.ok);
      this.update();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(open = !this.isOpen): void {
    this.root.hidden = !open;
    if (open) this.update();
  }

  /** 今買えるものがあるか(ツールバーのバッジ用) */
  anyAffordable(sim: Simulation): boolean {
    return this.items(sim).some((item) => this.blocker(sim, item) === null);
  }

  update(): void {
    const sim = this.getSim();
    if (sim !== this.builtFor || sim.purchaseVersion !== this.builtVersion || this.tab !== this.builtTab) {
      this.rebuild(sim);
    }
    if (!this.isOpen) return;
    this.moneyLabel.textContent = money(sim.money);
    for (const button of this.list.querySelectorAll<HTMLButtonElement>('button.buy')) {
      const item = { type: button.dataset.type, id: button.dataset.id } as Item;
      const blocker = this.blocker(sim, item);
      button.disabled = blocker !== null;
      button.title = blocker ?? '';
      if (item.type === 'campaign') {
        button.textContent = money(sim.campaignPrice());
        const note = button.closest('.inv-item')?.querySelector<HTMLElement>('.inv-effect');
        if (note) note.textContent = blocker && blocker.startsWith('資金') ? '打てます' : (blocker ?? '打てます');
      }
    }
    // タブの印: そのタブに今買えるものがある
    for (const line of LINES) {
      const badge = this.tabs.querySelector<HTMLElement>(`button[data-tab="${line.id}"] .badge`);
      if (badge) badge.hidden = !lineItems(sim, line).some((item) => item.type !== 'campaign' && this.blocker(sim, item) === null);
    }
  }

  private items(sim: Simulation): Item[] {
    return [
      ...UNLOCKS.filter((u) => !sim.unlocks.has(u.id)).map((u) => ({ type: 'unlock' as const, id: u.id })),
      ...UPGRADES.map((u) => ({ type: 'upgrade' as const, id: u.id })),
    ];
  }

  private blocker(sim: Simulation, item: Item): string | null {
    if (item.type === 'campaign') return sim.campaignError();
    return item.type === 'unlock' ? sim.canUnlock(item.id) : sim.canBuyUpgrade(item.id);
  }

  private rebuild(sim: Simulation): void {
    this.builtFor = sim;
    this.builtVersion = sim.purchaseVersion;
    this.builtTab = this.tab;

    const now = currentStage(sim);
    const next = STAGES.find((s) => s.id === now.id + 1);
    this.stageBox.innerHTML = `
      <div class="inv-stage-now">段階 ${now.id} / ${STAGES.length}: ${now.name}</div>
      <div class="inv-stage-note">${now.summary}${next ? ` 次は「${next.name}」。` : ''}</div>`;
    for (const b of this.tabs.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      const on = b.dataset.tab === this.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }

    const line = LINES.find((l) => l.id === this.tab) ?? LINES[0];
    const html: string[] = [`<div class="inv-line-note">${line.summary}</div>`];

    // 導入済みの配信コンテンツ(オン/オフ)は、そのコンテンツを解放したタブに出す
    const features = UNLOCKS.filter((u) => u.effect && sim.unlocks.has(u.id) && line.unlocks.includes(u.id));
    if (features.length) {
      html.push('<div class="inv-section">配信コンテンツ</div>');
      for (const def of features) {
        const on = sim.isFeatureActive(def.id);
        html.push(`
          <div class="inv-item">
            <div class="inv-main">
              <div class="inv-title">${def.name}</div>
              <div class="inv-effect">${describeFeature(def.effect!)}</div>
            </div>
            <button type="button" class="toggle ${on ? 'on' : ''}" data-type="feature" data-id="${def.id}" aria-pressed="${on}">${on ? 'オン' : 'オフ'}</button>
          </div>`);
      }
      html.push('<div class="inv-section">投資</div>');
    }

    for (const item of lineItems(sim, line)) html.push(this.itemHtml(sim, item));
    this.list.innerHTML = html.join('');
  }

  private itemHtml(sim: Simulation, item: Item): string {
    if (item.type === 'campaign') {
      return row({
        stage: null,
        tag: '施策',
        title: 'キャンペーン(ショッピング)',
        desc: `払うとすぐ始まり、${CAMPAIGN.durationSec} 秒間 訪問が ×${CAMPAIGN.trafficMul}、注文の単価が ×${CAMPAIGN.revenueMul}。終わると ${CAMPAIGN.cooldownSec} 秒は打てない。急に増える流量に耐えられるよう、先に余裕を作っておく。`,
        effect: '打てます',
        cost: sim.campaignPrice(),
        type: 'campaign',
        id: 'shopSale',
      });
    }
    if (item.type === 'unlock') {
      const def = UNLOCK_BY_ID[item.id];
      const needs = def.requires && !sim.unlocks.has(def.requires) ? `要: ${UNLOCK_BY_ID[def.requires].name}` : '';
      const effect = def.effect ? describeFeature(def.effect) : '';
      return row({
        stage: stageOfUnlock(def.id),
        tag: def.service ? 'サービス' : def.effect ? 'コンテンツ' : '解放',
        title: def.name,
        desc: def.description,
        effect: [effect, needs].filter(Boolean).join(' ・ '),
        cost: unlockCost(def.id),
        type: 'unlock',
        id: def.id,
      });
    }
    const def = UPGRADE_BY_ID[item.id];
    const level = sim.upgrades[item.id];
    const locked = def.requires && !sim.unlocks.has(def.requires);
    const maxed = def.maxLevel !== undefined && level >= def.maxLevel;
    return row({
      stage: null,
      tag: maxed ? `Lv ${level}(最大)` : def.maxLevel !== undefined ? `Lv ${level} / ${def.maxLevel}` : `Lv ${level}`,
      title: def.name,
      desc: def.description,
      effect: locked
        ? `要: ${UNLOCK_BY_ID[def.requires!].name}`
        : maxed
          ? `${formatUpgradeEffect(def, level)}(最大)`
          : `${formatUpgradeEffect(def, level)} → ${formatUpgradeEffect(def, level + 1)}`,
      cost: sim.upgradeCost(item.id),
      type: 'upgrade',
      id: def.id,
    });
  }
}

function row(p: {
  stage: StageDef | null;
  tag: string;
  title: string;
  desc: string;
  effect: string;
  cost: number;
  type: string;
  id: string;
}): string {
  const stage = !p.stage ? '' : `<span class="inv-stage" title="${p.stage.name}">段階 ${p.stage.id}</span>`;
  return `
    <div class="inv-item">
      <div class="inv-main">
        <div class="inv-title">${p.title}<span class="inv-tag">${p.tag}</span>${stage}</div>
        <div class="inv-desc">${p.desc}</div>
        ${p.effect ? `<div class="inv-effect">${p.effect}</div>` : ''}
      </div>
      <button type="button" class="buy" data-type="${p.type}" data-id="${p.id}">${money(p.cost)}</button>
    </div>`;
}
