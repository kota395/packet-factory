/**
 * 右の詳細パネル。選んだもの(機器・VM・U・区画・サービス全体)に合わせて中身を作る。
 * ボタンを含む部分は選択や構成が変わったときだけ組み直し、数値の部分だけを定期的に更新する
 * (ボタンを作り直すとタップを取りこぼすため)。
 */
import { PRESET_BY_ID } from '../sim/catalog';
import type { Simulation } from '../sim/simulation';
import type { DiskKind, ModelId, RoleKey, Scope, VmSize } from '../sim/types';
import type { Target } from '../render/row';
import { money } from './format';
import { decodeChange, costText } from './info/common';
import type { Content } from './info/common';
import { deviceContent } from './info/device';
import { unitContent, slotContent } from './info/rack';
import { serviceContent, serviceScopes } from './info/service';
import { vmContent } from './info/vm';

export type Selection = Target | { kind: 'service' };

export interface InfoActions {
  toast(message: string): void;
  select(target: Selection | null): void;
  changed(): void;
}

export class InfoPanel {
  private shownKey = '';
  /** サービスの詳細で見ているサービス */
  private serviceTab: Scope = 'blog';

  constructor(
    private readonly root: HTMLElement,
    private readonly getSim: () => Simulation,
    private readonly actions: InfoActions,
  ) {
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b || b.disabled) return;
      this.act(b.dataset);
    });
  }

  update(sel: Selection | null): void {
    const sim = this.getSim();
    const c = sel ? this.content(sim, sel) : null;
    if (!c) {
      this.root.hidden = true;
      this.shownKey = '';
      return;
    }
    if (c.key !== this.shownKey) {
      this.shownKey = c.key;
      this.root.innerHTML = `
        <header>
          <h3>${c.title}<small>${c.subtitle}</small></h3>
          <button type="button" data-act="close" aria-label="閉じる">✕</button>
        </header>
        ${c.desc ? `<div class="desc">${c.desc}</div>` : ''}
        <div class="info-fixed">${c.fixed}</div>
        <div class="info-body">${c.live}</div>`;
    } else {
      this.root.querySelector('.info-body')!.innerHTML = c.live;
    }
    this.refreshButtons(sim);
    this.root.hidden = false;
  }

  /** お金が貯まったら押せるようになる、などのボタンの状態だけ更新する */
  private refreshButtons(sim: Simulation): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-act="buy"]')) {
      const model = b.dataset.model as ModelId;
      const parts = b.dataset.preset ? PRESET_BY_ID[b.dataset.preset].parts : undefined;
      const err =
        sim.canBuyModel(model, parts) ?? sim.placeError(model, Number(b.dataset.slot), Number(b.dataset.u), undefined, parts);
      const price = sim.devicePrice(model, parts);
      b.disabled = !!err || sim.money < price;
      b.title = err ?? (sim.money < price ? '資金が足りません' : '');
      const note = b.closest('.cat-item')?.querySelector<HTMLElement>('.cat-note');
      if (note) note.textContent = err ?? '';
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-act="rent"]')) {
      b.disabled = sim.money < sim.rackPrice();
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-act="campaign"]')) {
      const err = sim.campaignError();
      b.disabled = !!err;
      b.title = err ?? '';
      b.textContent = `キャンペーンを打つ(${money(sim.campaignPrice())})`;
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-act="part"]')) {
      const change = decodeChange(b.dataset.change ?? '');
      if (!change) continue;
      const info = sim.partChangeInfo(Number(b.dataset.id), change);
      b.disabled = !!info.error;
      b.title = info.error ?? '';
      const cost = b.querySelector<HTMLElement>('.cost');
      if (cost) cost.textContent = info.parts ? costText(info.cost) : '';
    }
  }

  private act(data: DOMStringMap): void {
    const sim = this.getSim();
    let r: { ok: boolean; message?: string; id?: number } | null = null;
    switch (data.act) {
      case 'close':
        this.actions.select(null);
        return;
      case 'buy':
        r = sim.buyDevice(data.model as ModelId, Number(data.slot), Number(data.u), data.preset);
        if (r.ok && r.id !== undefined) this.actions.select({ kind: 'device', id: r.id });
        break;
      case 'rent':
        r = sim.rentRack(Number(data.slot));
        break;
      case 'sell':
        r = sim.sellDevice(Number(data.id));
        if (r.ok) this.actions.select(null);
        break;
      case 'role':
        r = sim.toggleRole(Number(data.id), data.role as RoleKey);
        break;
      case 'device':
        this.actions.select({ kind: 'device', id: Number(data.id) });
        return;
      case 'vm':
        this.actions.select({ kind: 'vm', id: Number(data.id) });
        return;
      case 'bgp':
        r = sim.setBgp(Number(data.id), data.on === '1');
        break;
      case 'maint':
        r = sim.setMaintenance(Number(data.id), data.on === '1');
        break;
      case 'hv':
        r = sim.setHv(Number(data.id), data.on === '1');
        break;
      case 'createvm':
        r = sim.createVm(Number(data.id), data.size as VmSize);
        if (r.ok && r.id !== undefined) this.actions.select({ kind: 'vm', id: r.id });
        break;
      case 'vmrole':
        r = sim.toggleVmRole(Number(data.id), data.role as RoleKey);
        break;
      case 'vmdisk':
        r = sim.setVmDisk(Number(data.id), data.disk as DiskKind);
        break;
      case 'movevm':
        r = sim.moveVm(Number(data.id), Number(data.host));
        break;
      case 'svc':
        this.serviceTab = data.svc as Scope;
        break;
      case 'campaign':
        r = sim.startCampaign();
        break;
      case 'part': {
        const change = decodeChange(data.change ?? '');
        if (change) r = sim.changeParts(Number(data.id), change);
        break;
      }
      case 'k8s':
        r = sim.setK8sWorker({ device: Number(data.id) }, data.on === '1');
        break;
      case 'vmk8s':
        r = sim.setK8sWorker({ vm: Number(data.id) }, data.on === '1');
        break;
      case 'deploy':
        r = sim.toggleDeployment(data.role as RoleKey);
        break;
      case 'deletevm':
        r = sim.deleteVm(Number(data.id));
        if (r.ok) this.actions.select(null);
        break;
    }
    if (r?.message) this.actions.toast(r.message);
    this.shownKey = '';
    this.actions.changed();
  }

  // ---------------------------------------------------------------- 中身

  private content(sim: Simulation, sel: Selection): Content | null {
    const base = `${sim.layoutVersion}@${sim.purchaseVersion}`;
    switch (sel.kind) {
      case 'device': {
        const d = sim.facility.devices.get(sel.id);
        return d ? deviceContent(sim, d, base) : null;
      }
      case 'vm': {
        const vm = sim.facility.vms.get(sel.id);
        return vm ? vmContent(sim, vm, base) : null;
      }
      case 'unit':
        return unitContent(sim, sel.slot, sel.u, base);
      case 'slot':
        return slotContent(sim, sel.slot, base);
      case 'service':
        if (!serviceScopes(sim).includes(this.serviceTab)) this.serviceTab = 'blog';
        return serviceContent(sim, base, this.serviceTab);
      default:
        return null;
    }
  }
}
