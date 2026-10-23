import { NODE_DEFS } from '../sim/config';
import {
  STAGES,
  UNLOCKS,
  UNLOCK_BY_ID,
  UPGRADES,
  UPGRADE_BY_ID,
  unlockCost,
  type FeatureEffect,
  type StageDef,
  type UpgradeDef,
} from '../sim/economy';
import type { Simulation } from '../sim/simulation';
import type { ReqKind, UnlockId, UpgradeId } from '../sim/types';
import { bandwidth, compact, money } from './format';

type Item = { type: 'unlock'; id: UnlockId } | { type: 'upgrade'; id: UpgradeId };

const KIND_LABEL: Record<ReqKind, string> = { static: '静的', read: '読み込み', write: '書き込み' };

/** 強化のレベルごとの効果を、対象の能力に合わせた単位で表示する */
export function formatUpgradeEffect(def: UpgradeDef, level: number): string {
  const v = def.effect(level);
  if (def.id === 'marketing') return `${compact(v)} 人`;
  const t = def.target;
  if (!t) return `×${v.toFixed(2)}`;
  const node = NODE_DEFS[t.nodes[0]];
  switch (t.stat) {
    case 'speed':
      return `×${v.toFixed(2)}`;
    case 'bandwidth':
      return bandwidth((node.bandwidthMBps ?? 0) * v);
    case 'hitRate':
      return `${((1 - (1 - (node.cache?.hitRate ?? 0)) * v) * 100).toFixed(1)}%`;
    case 'maxCount':
      return `${(node.maxCount ?? 0) + v} 台`;
  }
}

/** いまの段階 = 解放を 1 つでも買った段階のうち一番先(何も買っていなければ段階 1) */
export function currentStage(sim: Simulation): StageDef {
  let current = STAGES.find((s) => s.id === 1)!;
  for (const s of STAGES) if (s.unlocks.some((u) => sim.unlocks.has(u))) current = s;
  return current;
}

/** 「静的: 単価 ×2・データ量 ×5」のような説明 */
function describeFeature(effect: FeatureEffect): string {
  const kinds = new Set<ReqKind>([
    ...(Object.keys(effect.revenue ?? {}) as ReqKind[]),
    ...(Object.keys(effect.dataSize ?? {}) as ReqKind[]),
  ]);
  return [...kinds]
    .map((k) => {
      const parts: string[] = [];
      if (effect.revenue?.[k]) parts.push(`単価 ×${effect.revenue[k]}`);
      if (effect.dataSize?.[k]) parts.push(`データ量 ×${effect.dataSize[k]}`);
      return `${KIND_LABEL[k]}: ${parts.join('・')}`;
    })
    .join(' / ');
}

/**
 * 投資(解放・強化)の一覧と、導入済みの配信コンテンツのオン/オフ。
 * 購入や切り替えがあったときだけ組み直し、それ以外はボタンの状態だけ更新する。
 */
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
      const id = button.dataset.id!;
      const r =
        button.dataset.type === 'unlock'
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
    if (sim !== this.builtFor || sim.purchaseVersion !== this.builtVersion) this.rebuild(sim);
    if (!this.isOpen) return;
    this.moneyLabel.textContent = money(sim.money);
    for (const button of this.list.querySelectorAll<HTMLButtonElement>('button.buy')) {
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
    const html: string[] = [];

    // 導入済みの配信コンテンツ(オン/オフ)
    const features = UNLOCKS.filter((u) => u.effect && sim.unlocks.has(u.id));
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
    }

    const now = currentStage(sim);
    for (const stage of STAGES) {
      const items: Item[] = [
        ...stage.unlocks.filter((id) => !sim.unlocks.has(id)).map((id) => ({ type: 'unlock' as const, id })),
        ...stage.upgrades.map((id) => ({ type: 'upgrade' as const, id })),
      ];
      if (!items.length) continue;
      const title = stage.id === 0 ? stage.name : `段階 ${stage.id}: ${stage.name}`;
      const badge = stage.id === now.id ? '<span class="inv-now">いま</span>' : '';
      html.push(`
        <div class="inv-section">${title}${badge}</div>
        <div class="inv-stage-note">${stage.summary}</div>`);
      for (const item of items) html.push(this.itemHtml(sim, item));
    }
    this.list.innerHTML = html.join('');
  }

  private itemHtml(sim: Simulation, item: Item): string {
    if (item.type === 'unlock') {
      const def = UNLOCK_BY_ID[item.id];
      const needs = def.requires && !sim.unlocks.has(def.requires) ? `要: ${UNLOCK_BY_ID[def.requires].name}` : '';
      const effect = def.effect ? describeFeature(def.effect) : '';
      return row({
        tag: def.effect ? 'コンテンツ' : '解放',
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
      tag: maxed ? `Lv ${level}(最大)` : def.maxLevel !== undefined ? `Lv ${level} / ${def.maxLevel}` : `Lv ${level}`,
      title: def.name,
      desc: def.description,
      effect: locked
        ? `要: ${UNLOCK_BY_ID[def.requires!].name}`
        : maxed
          ? `${formatUpgradeEffect(def, level)}(これ以上の機種はない)`
          : `${formatUpgradeEffect(def, level)} → ${formatUpgradeEffect(def, level + 1)}`,
      cost: sim.upgradeCost(item.id),
      type: 'upgrade',
      id: def.id,
    });
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
