import { UNLOCKS, UNLOCK_BY_ID, UPGRADES, UPGRADE_BY_ID, type UpgradeDef } from '../sim/economy';
import type { Simulation } from '../sim/simulation';
import type { UnlockId, UpgradeId } from '../sim/types';
import { compact, money } from './format';

type Item = { type: 'unlock'; id: UnlockId } | { type: 'upgrade'; id: UpgradeId };

const formatEffect = (def: UpgradeDef, v: number) => (def.unit === 'users' ? `${compact(v)} 人` : `×${v.toFixed(2)}`);

/** 投資(解放・強化)の一覧。購入があったときだけ組み直し、それ以外はボタンの状態だけ更新する */
export class InvestPanel {
  private builtFor: Simulation | null = null;
  private builtVersion = -1;

  constructor(
    private readonly root: HTMLElement,
    private readonly list: HTMLElement,
    private readonly moneyLabel: HTMLElement,
    private readonly getSim: () => Simulation,
    private readonly onResult: (message: string | undefined, ok: boolean) => void,
  ) {
    this.list.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-type]');
      if (!button || button.disabled) return;
      const sim = this.getSim();
      const r =
        button.dataset.type === 'unlock'
          ? sim.unlock(button.dataset.id as UnlockId)
          : sim.buyUpgrade(button.dataset.id as UpgradeId);
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
    if (sim !== this.builtFor || sim.purchaseVersion !== this.builtVersion) this.rebuild(sim);
    if (!this.isOpen) return;
    this.moneyLabel.textContent = money(sim.money);
    for (const button of this.list.querySelectorAll<HTMLButtonElement>('button[data-type]')) {
      const item = { type: button.dataset.type, id: button.dataset.id } as Item;
      const blocker = this.blocker(sim, item);
      button.disabled = blocker !== null;
      button.title = blocker ?? '';
    }
  }

  private items(sim: Simulation): Item[] {
    return [
      ...UNLOCKS.filter((u) => !sim.unlocks.has(u.id)).map((u) => ({ type: 'unlock' as const, id: u.id })),
      ...UPGRADES.map((u) => ({ type: 'upgrade' as const, id: u.id })),
    ];
  }

  private blocker(sim: Simulation, item: Item): string | null {
    return item.type === 'unlock' ? sim.canUnlock(item.id) : sim.canBuyUpgrade(item.id);
  }

  private rebuild(sim: Simulation): void {
    this.builtFor = sim;
    this.builtVersion = sim.purchaseVersion;

    const html = this.items(sim).map((item) => {
      if (item.type === 'unlock') {
        const def = UNLOCK_BY_ID[item.id];
        const needs = def.requires && !sim.unlocks.has(def.requires) ? `要: ${UNLOCK_BY_ID[def.requires].name}` : '';
        return row({
          tag: '解放',
          title: def.name,
          desc: def.description,
          effect: needs,
          cost: def.cost,
          type: 'unlock',
          id: def.id,
        });
      }
      const def = UPGRADE_BY_ID[item.id];
      const level = sim.upgrades[item.id];
      const locked = def.requires && !sim.unlocks.has(def.requires);
      return row({
        tag: `Lv ${level}`,
        title: def.name,
        desc: def.description,
        effect: locked
          ? `要: ${UNLOCK_BY_ID[def.requires!].name}`
          : `${formatEffect(def, def.effect(level))} → ${formatEffect(def, def.effect(level + 1))}`,
        cost: sim.upgradeCost(item.id),
        type: 'upgrade',
        id: def.id,
      });
    });
    this.list.innerHTML = html.join('');
  }
}

function row(p: { tag: string; title: string; desc: string; effect: string; cost: number; type: string; id: string }): string {
  return `
    <div class="inv-item">
      <div class="inv-main">
        <div class="inv-title">${p.title}<span class="inv-tag">${p.tag}</span></div>
        <div class="inv-desc">${p.desc}</div>
        ${p.effect ? `<div class="inv-effect">${p.effect}</div>` : ''}
      </div>
      <button type="button" class="buy" data-type="${p.type}" data-id="${p.id}">${money(p.cost)}</button>
    </div>`;
}
