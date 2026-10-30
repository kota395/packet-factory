/**
 * クラスタの画面。配線を済ませたサーバを、ハイパーバイザや Kubernetes のワーカーという
 * 「コンピュートの資源」としてまとめて扱う。
 *  - 仮想化: ホストの追加・取り外し、VM をホストを選ばずに作る(空きの多いホストに自動で置く)・消す
 *  - Kubernetes: ワーカーの追加(空きサーバ、または VM を作って)・取り外し、Deployment のオン/オフと Pod の数
 * 構成が変わったときだけ組み直し、数値は毎回書き換える。
 */
import { K8S, SERVICES, VIRT } from '../sim/config';
import type { Simulation } from '../sim/simulation';
import { DATA_ROLES, roleKey, splitRole, type DiskKind, type RoleKey, type VmSize } from '../sim/types';
import { rolesText } from './format';
import type { Selection } from './info';

type Tab = 'hv' | 'k8s';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const load = (v: number) => `<span class="${v >= 0.9 ? 'bad' : v >= 0.7 ? 'warn' : 'ok'}">${pct(v)}</span>`;
const SIZES: readonly VmSize[] = ['s', 'm', 'l'];

export class ClusterPanel {
  private tab: Tab = 'hv';
  private builtKey = '';
  /** VM を作るときの選択(組み直しても残す) */
  private form = { size: 'm' as VmSize, role: '' as RoleKey | '', disk: 'local' as DiskKind, count: 1 };

  constructor(
    private readonly root: HTMLElement,
    private readonly getSim: () => Simulation,
    private readonly actions: { toast(m: string): void; select(t: Selection | null): void; changed(): void },
  ) {
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b || b.disabled) return;
      this.act(b.dataset);
    });
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.name === 'size') this.form.size = t.value as VmSize;
      if (t.name === 'role') this.form.role = t.value as RoleKey | '';
      if (t.name === 'disk') this.form.disk = t.value as DiskKind;
      if (t.name === 'count') this.form.count = Number(t.value);
    });
  }

  /** 仮想化か Kubernetes を解放していれば使える */
  available(sim: Simulation): boolean {
    return sim.unlocks.has('virtualization') || sim.unlocks.has('kubernetes');
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(open = !this.isOpen): void {
    this.root.hidden = !open;
    this.builtKey = '';
    if (open) this.update();
  }

  update(): void {
    if (!this.isOpen) return;
    const sim = this.getSim();
    if (this.tab === 'hv' && !sim.unlocks.has('virtualization')) this.tab = 'k8s';
    if (this.tab === 'k8s' && !sim.unlocks.has('kubernetes')) this.tab = 'hv';
    const key = `${this.tab}@${sim.layoutVersion}@${sim.purchaseVersion}@${sim.podVersion}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.root.innerHTML = this.render(sim);
    }
    // 数値だけ書き換える
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-live]')) {
      const [kind, id] = el.dataset.live!.split(':');
      const l = sim.flow.nodeLoads.get(Number(id));
      const dl = sim.flow.devices.get(Number(id));
      el.innerHTML = kind === 'node' ? (l ? load(l.cpu) : '-') : dl ? load(dl.cpu) : '-';
    }
  }

  // ---------------------------------------------------------------- 操作

  private act(data: DOMStringMap): void {
    const sim = this.getSim();
    let r: { ok: boolean; message?: string } | null = null;
    switch (data.act) {
      case 'close':
        this.toggle(false);
        this.actions.changed();
        return;
      case 'tab':
        this.tab = data.tab as Tab;
        this.builtKey = '';
        this.update();
        return;
      case 'create': {
        // まとめて作る。載せる所がなくなったらそこで止める
        let made = 0;
        let last: { ok: boolean; message?: string } | null = null;
        for (let i = 0; i < this.form.count; i++) {
          last = sim.createVmAuto(this.form.size, {
            roles: this.form.role ? [this.form.role] : [],
            disk: this.form.disk,
          });
          if (!last.ok) break;
          made++;
        }
        r = made > 1 ? { ok: true, message: `VM を ${made} 台作りました` } : last;
        if (made && last && !last.ok) r = { ok: true, message: `VM を ${made} 台作りました(${last.message})` };
        break;
      }
      case 'k8svm':
        r = sim.createVmAuto(data.size as VmSize, { k8s: true });
        break;
      case 'deletevm':
        r = sim.deleteVm(Number(data.id));
        break;
      case 'vm':
        this.actions.select({ kind: 'vm', id: Number(data.id) });
        return;
      case 'device':
        this.actions.select({ kind: 'device', id: Number(data.id) });
        return;
      case 'hv':
        r = sim.setHv(Number(data.id), data.on === '1');
        break;
      case 'worker':
        r = sim.setK8sWorker({ device: Number(data.id) }, data.on === '1');
        break;
      case 'vmworker':
        r = sim.setK8sWorker({ vm: Number(data.id) }, data.on === '1');
        break;
      case 'deploy':
        r = sim.toggleDeployment(data.role as RoleKey);
        break;
    }
    if (r?.message) this.actions.toast(r.message);
    this.builtKey = '';
    this.actions.changed();
    this.update();
  }

  // ---------------------------------------------------------------- 中身

  private render(sim: Simulation): string {
    const tabs: [Tab, string][] = [];
    if (sim.unlocks.has('virtualization')) tabs.push(['hv', '仮想化']);
    if (sim.unlocks.has('kubernetes')) tabs.push(['k8s', 'Kubernetes']);
    return `
      <header>
        <h2>クラスタ</h2>
        <span class="sheet-note">配線済みのサーバを、コンピュートの資源としてまとめて扱う</span>
        <button type="button" class="sheet-close" data-act="close" aria-label="閉じる">✕</button>
      </header>
      <div class="sheet-tabs" role="tablist">${tabs
        .map(([id, name]) => `<button type="button" role="tab" class="${id === this.tab ? 'active' : ''}" data-act="tab" data-tab="${id}">${name}</button>`)
        .join('')}</div>
      <div class="sheet-body">${this.tab === 'hv' ? this.hvTab(sim) : this.k8sTab(sim)}</div>`;
  }

  /** 空きサーバ(配線済み・役割なし)を加えるボタン */
  private spare(sim: Simulation, act: string, label: string): string {
    const list = sim.spareServers;
    if (!list.length) {
      return '<div class="muted small">加えられる空きサーバがありません。前面でサーバを置いて背面でスイッチにつなぐと(役割は付けずに)、ここに出ます。</div>';
    }
    return `<div class="role-buttons">${list
      .map((d) => `<button type="button" data-act="${act}" data-id="${d.id}" data-on="1">+ ${d.name}(${d.parts?.cpu ?? '-'} コア・${d.parts?.memGB ?? '-'}GB)を${label}</button>`)
      .join('')}</div>`;
  }

  private hvTab(sim: Simulation): string {
    const f = sim.facility;
    const cap = sim.hvCapacity;
    const hosts = [...f.devices.values()].filter((d) => d.hv).sort((a, b) => a.id - b.id);
    const vms = [...f.vms.values()].sort((a, b) => a.id - b.id);

    // VM を作る: 大きさ・役割・ディスク・台数を選び、置くホストは自動
    const roleOptions = [
      ...sim.activeServices.flatMap((s) => SERVICES[s].roles.map((r) => roleKey(s, r))),
      ...DATA_ROLES.map((r) => roleKey('data', r)),
    ].filter((k) => sim.roleUnlockError(k) === null);
    const opt = (v: string, label: string, cur: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const form = `
      <div class="cl-form">
        <label>大きさ<select name="size">${SIZES.map((z) => opt(z, `${VIRT.sizes[z].label}(${VIRT.sizes[z].vcpu} vCPU・${VIRT.sizes[z].memGB}GB)`, this.form.size)).join('')}</select></label>
        <label>役割<select name="role">${opt('', 'あとで付ける', this.form.role)}${roleOptions.map((k) => opt(k, rolesText([k]), this.form.role)).join('')}</select></label>
        <label>ディスク<select name="disk">${opt('local', 'ローカル', this.form.disk)}${sim.unlocks.has('storage') ? opt('shared', '共有ストレージ', this.form.disk) : ''}</select></label>
        <label>台数<select name="count">${[1, 2, 4, 8].map((n) => opt(String(n), `${n} 台`, String(this.form.count))).join('')}</select></label>
        <button type="button" class="primary" data-act="create" ${hosts.length ? '' : 'disabled title="ホストがありません"'}>VM を作る</button>
      </div>
      <div class="muted small">置くホストは、メモリの空きが一番多いホストが自動で選ばれます。</div>`;

    const vmRows = vms
      .map((v) => {
        const host = f.devices.get(v.host);
        const roles = v.k8s ? 'k8s ワーカー' : v.roles.length ? rolesText(v.roles) : '<span class="muted">役割なし</span>';
        const moving = v.downUntil > sim.time ? ' <span class="warn">移行中</span>' : '';
        return `<div class="cl-row">
          <div class="cl-main"><b>${v.name}</b> ${VIRT.sizes[v.size].label}・${host?.name ?? '?'}${v.disk === 'shared' ? '・共有' : ''}${moving}<div class="small">${roles}</div></div>
          <span class="cl-load" data-live="node:${-v.id}"></span>
          <button type="button" data-act="vm" data-id="${v.id}">詳細</button>
          <button type="button" class="danger" data-act="deletevm" data-id="${v.id}">消す</button>
        </div>`;
      })
      .join('');

    const hostRows = hosts
      .map((d) => {
        const use = f.hostUsage(d.id);
        const sp = d.parts ? `${d.parts.cpu * VIRT.vcpuOvercommit} vCPU・${d.parts.memGB - VIRT.hostMemGB}GB` : '';
        const n = f.vmsOn(d.id).length;
        return `<div class="cl-row">
          <div class="cl-main"><b>${d.name}</b> ラック ${d.slot + 1}・VM ${n} 台<div class="small">割り当て vCPU ${use.vcpu}・メモリ ${use.memGB}GB(上限 ${sp})</div></div>
          <span class="cl-load" data-live="dev:${d.id}"></span>
          <button type="button" data-act="device" data-id="${d.id}">詳細</button>
          <button type="button" data-act="hv" data-id="${d.id}" data-on="0" ${n ? 'disabled title="VM が載っている間は外せません"' : ''}>外す</button>
        </div>`;
      })
      .join('');

    return `
      <div class="cl-summary">ホスト <b>${cap.hosts}</b> 台・vCPU <b>${cap.vcpu} / ${cap.vcpuMax}</b>・メモリ <b>${cap.memGB} / ${cap.memMax}GB</b>・VM <b>${vms.length}</b> 台</div>
      <section class="info-sec"><h4>VM を作る</h4>${form}</section>
      <section class="info-sec"><h4>VM</h4>${vmRows || '<div class="muted small">まだありません</div>'}</section>
      <section class="info-sec"><h4>ホスト</h4>${hostRows || '<div class="muted small">まだありません</div>'}</section>
      <section class="info-sec"><h4>ホストを加える</h4>${this.spare(sim, 'hv', 'ホストにする')}</section>`;
  }

  private k8sTab(sim: Simulation): string {
    const f = sim.facility;
    const cap = sim.k8sCapacity;
    const podsOn = (worker: number) =>
      sim.pods
        .filter((p) => p.worker === worker)
        .map((p) => `${rolesText([p.role])}×${p.count}`)
        .join('・') || 'Pod なし';
    const workers = [
      ...[...f.devices.values()].filter((d) => d.k8s).map((d) => ({ id: d.id, name: d.name, kind: 'サーバ', act: 'worker', ref: d.id, live: `dev:${d.id}` })),
      ...[...f.vms.values()].filter((v) => v.k8s).map((v) => ({ id: -v.id, name: v.name, kind: `VM ${VIRT.sizes[v.size].label}`, act: 'vmworker', ref: v.id, live: `node:${-v.id}` })),
    ];
    const workerRows = workers
      .map(
        (w) => `<div class="cl-row">
          <div class="cl-main"><b>${w.name}</b> ${w.kind}<div class="small">${podsOn(w.id)}</div></div>
          <span class="cl-load" data-live="${w.live}"></span>
          <button type="button" data-act="${w.act}" data-id="${w.ref}" data-on="0">外す</button>
          ${w.act === 'vmworker' ? `<button type="button" class="danger" data-act="deletevm" data-id="${w.ref}">消す</button>` : ''}
        </div>`,
      )
      .join('');

    const addVm = sim.unlocks.has('virtualization')
      ? `<div class="role-buttons">${SIZES.map(
          (z) =>
            `<button type="button" data-act="k8svm" data-size="${z}" ${sim.pickHost(z) === null ? 'disabled title="載せられるホストがありません"' : ''}>+ VM ${VIRT.sizes[z].label}(${VIRT.sizes[z].vcpu} vCPU)をワーカーに</button>`,
        ).join('')}</div>`
      : '';

    const deploys = sim.activeServices
      .map((s) => {
        const buttons = SERVICES[s].roles
          .filter((r) => K8S.roles.includes(r))
          .map((r) => {
            const k = roleKey(s, r);
            const on = sim.deployments.has(k);
            const err = sim.deploymentError(k);
            const placed = sim.pods.filter((p) => p.role === k).reduce((n, p) => n + p.count, 0);
            const pending = sim.podsPending.get(k) ?? 0;
            const count = on ? ` ${placed}${pending ? `(待ち ${pending})` : ''}` : '';
            return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="deploy" data-role="${k}" ${err && !on ? `disabled title="${err}"` : ''}>${splitRole(k)[1]}${count}</button>`;
          })
          .join('');
        return `<div class="role-group"><div class="role-svc">${SERVICES[s].name}</div><div class="role-buttons">${buttons}</div></div>`;
      })
      .join('');

    return `
      <div class="cl-summary">ワーカー <b>${cap.workers}</b> 台・vCPU <b>${cap.vcpu}</b>・Pod <b>${cap.pods}</b>${cap.pending ? `・<span class="bad">待ち ${cap.pending}</span>` : ''}(1 個 ${K8S.pod.vcpu} vCPU・${K8S.pod.memGB}GB)</div>
      <section class="info-sec"><h4>Deployment(Pod の数は CPU ${Math.round(K8S.targetCpu * 100)}% を目標に自動で増減)</h4>${deploys}</section>
      <section class="info-sec"><h4>ワーカー</h4>${workerRows || '<div class="muted small">まだありません</div>'}</section>
      <section class="info-sec"><h4>ワーカーを加える</h4>${addVm}${this.spare(sim, 'worker', 'ワーカーにする')}</section>`;
  }
}
