/**
 * 右の詳細パネル。選んだもの(機器・U・区画・ポート・ケーブル・サービス全体)に合わせて中身を作る。
 * ボタンを含む部分は選択や構成が変わったときだけ組み直し、数値の部分だけを定期的に更新する
 * (ボタンを作り直すとタップを取りこぼすため)。
 */
import {
  BUYABLE_MODELS,
  CHASSIS,
  DRIVES,
  MODEL_BY_ID,
  NICS,
  PRESETS,
  PRESET_BY_ID,
  isServerModel,
  partsSummary,
  portsOf,
  specOf,
  type ModelDef,
} from '../sim/catalog';
import { ANALYTICS, CAMPAIGN, K8S, RACK, SERVICES, VIRT, scopeName } from '../sim/config';
import type { Device, Vm } from '../sim/facility';
import { lbGroups, nodeName, type NodeLoad } from '../sim/flow';
import { SELL_REFUND_RATE, UPKEEP } from '../sim/pricing';
import type { PartChange, Simulation } from '../sim/simulation';
import {
  DATA_ROLES,
  ROLE_IDS,
  SERVICE_IDS,
  roleKey,
  splitRole,
  type DiskKind,
  type ModelId,
  type PortRef,
  type RoleId,
  type RoleKey,
  type Scope,
  type ServerParts,
  type VmSize,
} from '../sim/types';
import type { Target } from '../render/row';
import { SERVICE_SHORT, compact, dataSize, money, rate, rolesText } from './format';

export type Selection = Target | { kind: 'service' };

export interface InfoActions {
  toast(message: string): void;
  select(target: Selection | null): void;
  changed(): void;
}

const ROLE_LABEL: Record<RoleId, string> = {
  lb: 'lb(LVS)',
  web: 'web',
  cache: 'cache(memcached)',
  db: 'db(MySQL)',
  replica: 'replica(読み込み)',
  search: 'search(検索)',
  media: 'media(画像・動画の配信)',
  worker: 'worker(加工)',
  hadoop: 'hadoop(ログの集計)',
  ml: 'ml(機械学習)',
};
const ROLE_UNIT: Record<RoleId, string> = {
  lb: 'リクエスト/秒',
  web: 'リクエスト/秒',
  cache: '回/秒',
  db: '回/秒',
  replica: '回/秒',
  search: '回/秒',
  media: '回/秒',
  worker: '件/秒',
  hadoop: 'MB/秒',
  ml: 'MB/秒',
};

/** ノード(物理サーバか VM)の負荷の行 */
function nodeRows(sim: Simulation, roles: readonly RoleKey[], l: NodeLoad | undefined, cpuLabel: string): [string, string][] {
  const out: [string, string][] = [];
  if (!l) return out;
  out.push([cpuLabel, load(l.cpu)]);
  const disk = l.storage != null ? `共有(${sim.facility.devices.get(l.storage)?.name})` : l.storage === null ? '共有(届かない)' : 'ローカル';
  out.push(['ディスク', `${disk} ${load(l.io)}(${compact(l.ioOps, 1)} IO/秒)`]);
  if (l.gpu !== undefined) out.push(['GPU', load(l.gpu)]);
  // 付けた役割と、肩代わりしている仕事(media がないときの web など)
  const keys = [...new Set([...roles, ...(Object.keys(l.work) as RoleKey[])])];
  for (const k of keys) {
    const [s, r] = splitRole(k);
    if (!sim.isScopeActive(s) || !sim.availableRoles.has(r)) continue;
    const w = l.work[k] ?? 0;
    const miss = l.miss[k] !== undefined ? `(${pct(l.miss[k]!)} がディスクへ)` : '';
    out.push([
      `${SERVICE_SHORT[s]} ${r}`,
      w > 0 ? `${compact(w, 1)} ${ROLE_UNIT[r]}${miss}` : '<span class="muted">なし(流れてきていない)</span>',
    ]);
  }
  return out;
}

/** 役割のボタン。始めているサービスごとに並べる */
function roleButtons(
  sim: Simulation,
  roles: readonly RoleKey[],
  act: string,
  id: number,
  errorOf: (r: RoleKey) => string | null,
): string {
  // サービスごと、分析基盤を解放していれば分析基盤も
  const groups: [Scope, readonly RoleId[]][] = sim.activeServices.map((s) => [s, SERVICES[s].roles]);
  if (sim.isScopeActive('data')) groups.push(['data', DATA_ROLES]);
  return groups
    .map(([s, list]) => {
      const buttons = list
        .map((r) => {
          const k = roleKey(s, r);
          const on = roles.includes(k);
          const err = errorOf(k);
          return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="${act}" data-id="${id}" data-role="${k}" ${err && !on ? `disabled title="${err}"` : ''}>${ROLE_LABEL[r]}</button>`;
        })
        .join('');
      return `<div class="role-group"><div class="role-svc">${scopeName(s)}</div><div class="role-buttons">${buttons}</div></div>`;
    })
    .join('');
}

/** ワーカーに置かれた Pod の行 */
function podRows(sim: Simulation, worker: number, vcpu: number, memGB: number): [string, string][] {
  const groups = sim.pods.filter((p) => p.worker === worker);
  const total = groups.reduce((n, p) => n + p.count, 0);
  const out: [string, string][] = [
    ['Pod', `${total} 個(CPU ${total * K8S.pod.vcpu} / ${vcpu}・メモリ ${total * K8S.pod.memGB} / ${memGB - K8S.systemMemGB} GB)`],
  ];
  for (const p of groups) {
    const l = sim.flow.nodeLoads.get(p.id);
    out.push([`  ${rolesText([p.role])} ×${p.count}`, l ? `CPU ${load(l.cpu)}` : '-']);
  }
  return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const load = (v: number) => `<span class="${v >= 0.9 ? 'bad' : v >= 0.7 ? 'warn' : 'ok'}">${pct(v)}</span>`;
const gbps = (v: number) => (v >= 1 ? `${v.toFixed(v >= 10 ? 0 : 1)} Gbps` : `${Math.round(v * 1000)} Mbps`);

function rows(list: [string, string][]): string {
  return `<div class="rows-box">${list.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
}

function section(title: string, body: string): string {
  return body ? `<section class="info-sec"><h4>${title}</h4>${body}</section>` : '';
}

/** 性能の 1 行(サーバは構成から) */
function specText(m: ModelDef, parts?: ServerParts | null): string {
  const sp = specOf({ model: m.id, parts });
  const ports = sp.ports.map((g) => `${g.label}×${g.count}`).join(' + ');
  if (m.category === 'server') return `${sp.cores} コア・${sp.memGB}GB・${compact(sp.diskIops)} IOPS${sp.gpus ? `・GPU×${sp.gpus}` : ''}・${ports}`;
  if (m.category === 'switch') return `${ports}・処理 ${m.fabricGbps} Gbps`;
  if (m.category === 'storage') return `${m.diskIops!.toLocaleString('en-US')} IOPS・${ports}`;
  if (m.category === 'lb') return `${ports}・振り分け ${compact(m.lbRps!)} リクエスト/秒`;
  return ports;
}

/** パーツの変更を data 属性に書く形 */
function encodeChange(c: PartChange): string {
  switch (c.kind) {
    case 'cpu':
    case 'mem':
      return `${c.kind}:${c.dir}`;
    case 'drive-add':
      return `add:${c.type}`;
    case 'drive-remove':
      return 'remove';
    case 'backplane':
      return `bp:${c.to}`;
    case 'nic':
      return `nic:${c.to}`;
    case 'gpu':
      return `gpu:${c.dir}`;
  }
}

function decodeChange(s: string): PartChange | null {
  const [k, v] = s.split(':');
  if (k === 'cpu' || k === 'mem' || k === 'gpu') return { kind: k, dir: v === '1' ? 1 : -1 };
  if (k === 'add' && (v === 'hdd' || v === 'ssd' || v === 'nvme')) return { kind: 'drive-add', type: v };
  if (k === 'remove') return { kind: 'drive-remove' };
  if (k === 'bp' && (v === 'sff' || v === 'lff')) return { kind: 'backplane', to: v };
  if (k === 'nic' && (v === 'none' || v === 'sfp10')) return { kind: 'nic', to: v };
  return null;
}

/** パーツを替えるボタンの値段の表示(マイナスなら戻ってくる) */
const costText = (cost: number) => (cost >= 0 ? money(cost) : `+${money(-cost)} 戻る`);

interface Content {
  key: string;
  title: string;
  subtitle: string;
  desc: string;
  /** ボタンを含む部分(選択や構成が変わったときだけ組み直す) */
  fixed: string;
  /** 数値の部分(毎回更新) */
  live: string;
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
      case 'unplug':
        r = sim.disconnect(Number(data.id));
        if (r.ok) this.actions.select(null);
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
        return d ? this.deviceContent(sim, d, base) : null;
      }
      case 'vm': {
        const vm = sim.facility.vms.get(sel.id);
        return vm ? this.vmContent(sim, vm, base) : null;
      }
      case 'unit':
        return this.unitContent(sim, sel.slot, sel.u, base);
      case 'slot':
        return this.slotContent(sim, sel.slot, base);
      case 'port':
        return this.portContent(sim, sel.ref, base);
      case 'cable': {
        const c = sim.facility.cables.get(sel.id);
        return c ? this.portContent(sim, c.a, base, true) : null;
      }
      case 'service':
        return this.serviceContent(sim, base);
      default:
        return null;
    }
  }

  private deviceContent(sim: Simulation, d: Device, base: string): Content {
    const f = sim.facility;
    const m = MODEL_BY_ID[d.model];
    const l = sim.flow.devices.get(d.id);

    let fixed = '';
    if (m.category === 'server' && d.hv) {
      // ハイパーバイザ: VM の一覧と、VM を作るボタン
      const vms = f.vmsOn(d.id).sort((a, b) => a.id - b.id);
      const list = vms
        .map((v) => `<button type="button" data-act="vm" data-id="${v.id}">${v.name}(${VIRT.sizes[v.size].label})${v.roles.length ? ` ${rolesText(v.roles)}` : ''}</button>`)
        .join('');
      const create = (['s', 'm', 'l'] as const)
        .map((size) => {
          const z = VIRT.sizes[size];
          const err = f.vmPlaceError(d.id, size);
          return `<button type="button" data-act="createvm" data-id="${d.id}" data-size="${size}" ${err ? `disabled title="${err}"` : ''}>+ ${z.label}(${z.vcpu} vCPU・${z.memGB}GB)</button>`;
        })
        .join('');
      const back = `<button type="button" data-act="hv" data-id="${d.id}" data-on="0" ${vms.length ? 'disabled title="VM が載っている間はやめられません"' : ''}>物理サーバに戻す</button>`;
      fixed += section('VM', `<div class="role-buttons">${list || '<span class="muted small">まだありません</span>'}</div>`);
      fixed += section('VM を作る', `<div class="role-buttons">${create}</div><div class="actions">${back}</div>`);
    } else if (m.category === 'server' && d.k8s) {
      fixed += section(
        'Kubernetes のワーカー',
        `<div class="desc small">役割は付けず、Deployment の Pod が自動で置かれます(Deployment はサービスの詳細で)。</div><div class="actions"><button type="button" data-act="k8s" data-id="${d.id}" data-on="0">ワーカーから外す</button></div>`,
      );
    } else if (m.category === 'server') {
      fixed += section('役割', roleButtons(sim, d.roles, 'role', d.id, (r) => sim.roleError(d.id, r)));
      const hvErr = sim.hvError(d.id, true);
      const k8sErr = sim.k8sWorkerError({ device: d.id }, true);
      fixed += `<div class="actions"><button type="button" data-act="hv" data-id="${d.id}" data-on="1" ${hvErr ? `disabled title="${hvErr}"` : ''}>ハイパーバイザにする</button>${
        sim.unlocks.has('kubernetes')
          ? `<button type="button" data-act="k8s" data-id="${d.id}" data-on="1" ${k8sErr ? `disabled title="${k8sErr}"` : ''}>Kubernetes のワーカーにする</button>`
          : ''
      }</div>`;
    }
    if (d.parts && isServerModel(d.model)) fixed += this.partsSection(sim, d);
    if (m.category === 'server' && !d.hv && sim.unlocks.has('bgp')) {
      fixed += section(
        'BGP',
        `<div class="role-buttons"><button type="button" class="toggle ${d.bgp ? 'on' : ''}" data-act="bgp" data-id="${d.id}" data-on="${d.bgp ? '0' : '1'}">BGP を使う</button></div>`,
      );
    }
    if (!sim.isMainLine(d.id)) {
      fixed += `<div class="actions">
        <button type="button" data-act="maint" data-id="${d.id}" data-on="${d.down ? '0' : '1'}">${d.down ? 'メンテナンスから戻す' : 'メンテナンスで止める'}</button>
        <button type="button" class="danger" data-act="sell" data-id="${d.id}">売却する(+${money(Math.floor(d.paid * SELL_REFUND_RATE))})</button>
      </div>`;
    }

    const place: [string, string][] = [
      ['場所', `ラック ${d.slot + 1} / ${d.u}${m.u > 1 ? `〜${d.u + m.u - 1}` : ''}U`],
      ['スペック', specText(m, d.parts)],
      ...(d.parts ? ([['構成', partsSummary(d.parts)]] as [string, string][]) : []),
      ['電力', `${specOf(d).powerW} W`],
    ];
    const failed = d.failedUntil > sim.time;
    place.unshift([
      '状態',
      d.down
        ? '<span class="warn">メンテナンス中</span>'
        : failed
          ? `<span class="bad">障害(あと ${Math.ceil((d.failedUntil - sim.time) / 1000)} 秒で復旧)</span>`
          : '稼働中',
    ]);
    if (m.category === 'server') {
      place.push(['BGP', sim.usesBgp(d.id) ? (d.hv ? '使う(ハイパーバイザは自動)' : '使う(ECMP)') : '使わない(一番若いポートの 1 本だけ)']);
    }
    if (m.category === 'handoff') place.push(['回線契約', gbps(sim.uplinkGbps)]);
    if (m.category === 'lb') {
      const gr = lbGroups(f, sim.downDevices).find((x) => x.members.includes(d.id));
      const peer = gr?.members.find((x) => x !== d.id);
      place.push([
        '冗長化(HA)',
        peer === undefined
          ? '<span class="muted">なし(HA ポートを別の LB の HA ポートと直結すると冗長化)</span>'
          : `${f.devices.get(peer)?.name} とペア・${gr!.active === d.id ? '<span class="ok">アクティブ</span>' : gr!.active === null ? '<span class="bad">両方停止</span>' : 'スタンバイ'}`,
      ]);
    }

    const loadRows: [string, string][] = [];
    if (l) {
      if (m.category === 'server' && d.hv) {
        const use = f.hostUsage(d.id);
        loadRows.push(['CPU(VM の合計)', load(l.cpu)]);
        loadRows.push(['ローカルディスク', load(l.io)]);
        const sp = specOf(d);
        loadRows.push(['割り当て', `vCPU ${use.vcpu} / ${sp.cores * VIRT.vcpuOvercommit}・メモリ ${use.memGB} / ${sp.memGB - VIRT.hostMemGB} GB`]);
      } else if (m.category === 'server') {
        loadRows.push(...nodeRows(sim, d.roles, sim.flow.nodeLoads.get(d.id), 'CPU'));
        if (d.k8s) loadRows.push(...podRows(sim, d.id, specOf(d).cores, specOf(d).memGB));
      } else if (m.category === 'storage') {
        loadRows.push(['IOPS', load(l.io)]);
      } else if (m.category === 'switch') {
        loadRows.push(['処理能力', load(l.fabric)]);
      } else if (m.category === 'lb') {
        loadRows.push(['処理能力', load(l.cpu)]);
      }
      loadRows.push(['通信量', gbps(l.gbps)]);
    }

    const ports = portsOf(d);
    const links: [string, string][] = [];
    ports.forEach((p, i) => {
      const c = f.cableAt({ device: d.id, port: i });
      if (!c) return;
      const other = f.otherEnd(c, d.id);
      const rho = sim.flow.cableRho.get(c.id) ?? 0;
      links.push([`${p.label} ${p.number}`, `→ ${f.portName(other)}(${load(rho)})`]);
    });
    const used = links.length;
    const portSummary: [string, string][] = [['使用中', `${used} / ${ports.length}`]];

    return {
      key: `dev${d.id}@${base}`,
      title: d.name,
      subtitle: m.name,
      desc: m.description,
      fixed,
      live:
        section('機器', rows(place)) +
        section('負荷', rows(loadRows)) +
        section('ポート', rows([...portSummary, ...links.slice(0, 16)]) + (links.length > 16 ? `<div class="muted small">ほか ${links.length - 16} 本</div>` : '')),
    };
  }

  /** サーバの構成: ワンクリックでパーツを替えるボタン */
  private partsSection(sim: Simulation, d: Device): string {
    const p = d.parts!;
    const model = d.model as 'srv-1u' | 'srv-2u';
    const button = (change: PartChange, label: string) => {
      const info = sim.partChangeInfo(d.id, change);
      return `<button type="button" class="part" data-act="part" data-id="${d.id}" data-change="${encodeChange(change)}" ${info.error ? `disabled title="${info.error}"` : ''}>${label}<span class="cost">${info.parts ? costText(info.cost) : ''}</span></button>`;
    };
    /** 1 段上げる / 下げるボタン(行き先を書く。端なら出さない) */
    const step = (kind: 'cpu' | 'mem' | 'gpu', dir: 1 | -1, text: (x: ServerParts) => string) => {
      const info = sim.partChangeInfo(d.id, { kind, dir });
      return info.parts ? button({ kind, dir }, `${dir > 0 ? '▲' : '▼'} ${text(info.parts)} `) : '';
    };
    const line = (label: string, value: string, buttons: string) =>
      `<div class="part-row"><div class="part-head"><span>${label}</span><b>${value}</b></div><div class="role-buttons">${buttons}</div></div>`;
    const drivesHere = (Object.values(DRIVES) as (typeof DRIVES)[keyof typeof DRIVES][]).filter((t) => t.bay === p.backplane);
    const bays = CHASSIS[model].bays[p.backplane];
    const counts = drivesHere.map((t) => [t, p.drives.filter((x) => x === t.id).length] as const).filter(([, n]) => n);
    const driveText = `${counts.map(([t, n]) => `${t.name}×${n}`).join(' + ') || 'なし'}(${p.drives.length} / ${bays} 本)`;
    let html =
      line('CPU', `${p.cpu} コア`, step('cpu', -1, (x) => `${x.cpu} コア`) + step('cpu', 1, (x) => `${x.cpu} コア`)) +
      line('メモリ', `${p.memGB} GB`, step('mem', -1, (x) => `${x.memGB}GB`) + step('mem', 1, (x) => `${x.memGB}GB`)) +
      line(
        p.backplane === 'lff' ? '前面(3.5 インチ)' : '前面(2.5 インチ)',
        driveText,
        drivesHere.map((t) => button({ kind: 'drive-add', type: t.id }, `+ ${t.name}×2 `)).join('') +
          button({ kind: 'drive-remove' }, '− 2 本 '),
      );
    if (CHASSIS[model].bays.lff && CHASSIS[model].bays.sff) {
      const to = p.backplane === 'lff' ? 'sff' : 'lff';
      html += `<div class="role-buttons">${button({ kind: 'backplane', to }, to === 'sff' ? '前面を 2.5 インチ 24 本に替える(SSD×2 から) ' : '前面を 3.5 インチ 12 本に替える(HDD×2 から) ')}</div>`;
    }
    if (CHASSIS[model].gpuSlots && sim.unlocks.has('gpu')) {
      const gpus = p.gpus ?? 0;
      html += line(
        'GPU',
        `${gpus} / ${CHASSIS[model].gpuSlots} 枚`,
        step('gpu', -1, (x) => `${x.gpus ?? 0} 枚`) + step('gpu', 1, (x) => `${x.gpus ?? 0} 枚`),
      );
    }
    const nicTo = p.nic === 'none' ? 'sfp10' : 'none';
    html += line('増設 NIC', NICS[p.nic].name, button({ kind: 'nic', to: nicTo }, nicTo === 'none' ? 'NIC を外す ' : '10G NIC を付ける '));
    const rear = CHASSIS[model].rearSsd ? `背面に OS 用の SSD ${CHASSIS[model].rearSsd} 本(ミラー)。` : '';
    return section(
      '構成',
      `<div class="desc small">ドライブは 2 本ずつのミラー。${rear}外したパーツは半額で下取り。</div>${html}`,
    );
  }

  private vmContent(sim: Simulation, vm: Vm, base: string): Content {
    const f = sim.facility;
    const host = f.devices.get(vm.host);
    const size = VIRT.sizes[vm.size];
    let fixed = vm.k8s
      ? section(
          'Kubernetes のワーカー',
          `<div class="desc small">役割は付けず、Deployment の Pod が自動で置かれます。</div><div class="actions"><button type="button" data-act="vmk8s" data-id="${vm.id}" data-on="0">ワーカーから外す</button></div>`,
        )
      : section('役割', roleButtons(sim, vm.roles, 'vmrole', vm.id, (r) => sim.vmRoleError(vm.id, r))) +
        (sim.unlocks.has('kubernetes')
          ? `<div class="actions"><button type="button" data-act="vmk8s" data-id="${vm.id}" data-on="1">Kubernetes のワーカーにする</button></div>`
          : '');
    const storageErr = sim.unlocks.has('storage') ? null : '投資の「共有ストレージ」が必要です';
    const diskButtons = (['local', 'shared'] as const)
      .map((k) => {
        const on = vm.disk === k;
        const err = k === 'shared' ? storageErr : null;
        return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="vmdisk" data-id="${vm.id}" data-disk="${k}" ${err && !on ? `disabled title="${err}"` : ''}>${k === 'local' ? 'ローカル' : '共有ストレージ'}</button>`;
      })
      .join('');
    fixed += section('ディスク', `<div class="role-buttons">${diskButtons}</div>`);
    const hosts = [...f.devices.values()].filter((d) => d.hv && d.id !== vm.host);
    const moves = hosts
      .map((h) => {
        const info = sim.vmMoveInfo(vm.id, h.id);
        const note = info.error ?? (info.downtimeMs ? `${info.downtimeMs / 1000} 秒止まる` : 'ライブ');
        return `<button type="button" data-act="movevm" data-id="${vm.id}" data-host="${h.id}" ${info.error ? `disabled title="${info.error}"` : ''}>→ ${h.name}(${note})</button>`;
      })
      .join('');
    fixed += section(
      '別のホストへ移す',
      `<div class="role-buttons">${moves || '<span class="muted small">ほかにハイパーバイザがありません</span>'}</div>`,
    );
    fixed += `<div class="actions"><button type="button" data-act="device" data-id="${vm.host}">${host?.name ?? '?'} の詳細</button><button type="button" class="danger" data-act="deletevm" data-id="${vm.id}">VM を消す</button></div>`;

    const state =
      vm.downUntil > sim.time ? `<span class="warn">移行中(あと ${Math.ceil((vm.downUntil - sim.time) / 1000)} 秒)</span>` : '動いています';
    const hostLoad = sim.flow.devices.get(vm.host);
    const live =
      section(
        'VM',
        rows([
          ['ホスト', `${host?.name ?? '?'}(ラック ${(host?.slot ?? 0) + 1})`],
          ['大きさ', `${size.vcpu} vCPU・${size.memGB} GB`],
          ['状態', state],
          ['ホストの CPU', hostLoad ? load(hostLoad.cpu) : '-'],
        ]),
      ) +
      section(
        '負荷',
        rows([
          ...nodeRows(sim, vm.roles, sim.flow.nodeLoads.get(-vm.id), 'vCPU'),
          ...(vm.k8s ? podRows(sim, -vm.id, size.vcpu, size.memGB) : []),
        ]),
      );
    return {
      key: `vm${vm.id}@${base}`,
      title: vm.name,
      subtitle: '仮想マシン',
      desc: '同じホストの VM 同士の通信はネットワークを通りません。前面のホストには、サービスごとの VM の台数が出ます。',
      fixed,
      live,
    };
  }

  private unitContent(sim: Simulation, slot: number, u: number, base: string): Content {
    // サーバは構成(プリセット)ごと、それ以外は機種ごとに並べる
    const item = (m: ModelDef, title: string, desc: string, preset?: string) => {
      const parts = preset ? PRESET_BY_ID[preset].parts : undefined;
      const locked = sim.canBuyModel(m.id, parts);
      return `
        <div class="cat-item ${locked ? 'locked' : ''}">
          <div class="cat-main">
            <div class="cat-title">${title}<span class="inv-tag">${m.u}U・${specOf({ model: m.id, parts }).powerW}W</span></div>
            <div class="cat-spec">${specText(m, parts)}</div>
            ${desc ? `<div class="cat-spec muted">${desc}</div>` : ''}
            <div class="cat-note"></div>
          </div>
          <button type="button" class="buy" data-act="buy" data-model="${m.id}" ${preset ? `data-preset="${preset}"` : ''} data-slot="${slot}" data-u="${u}">${money(sim.devicePrice(m.id, parts))}</button>
        </div>`;
    };
    const items = [
      ...PRESETS.map((p) => {
        const drives = partsSummary(p.parts).split('・').filter((x) => /×/.test(x)).join('・');
        return item(MODEL_BY_ID[p.model], p.name, `${drives}(ミラー)。${p.description}`, p.id);
      }),
      ...BUYABLE_MODELS.filter((m) => !isServerModel(m.id)).map((m) => item(m, m.name, '')),
      // 回線を増やす(回線の多重化を解放したら)
      item(MODEL_BY_ID.handoff, '回線を追加(回線終端)', `回線契約(${gbps(sim.uplinkGbps)})が 1 本ぶん増え、月額も 1 本ぶんかかる。BGP で回線に分けて流す。`),
    ].join('');
    const power = sim.facility.powerUsed(slot);
    return {
      key: `unit${slot}:${u}@${base}`,
      title: `ラック ${slot + 1} の ${u}U`,
      subtitle: '機器を設置',
      desc: `この U を一番下にして設置します。2U の機器は ${u + 1}U まで使います。電力 ${power} / ${sim.rackPowerW} W。`,
      fixed: `<div class="catalog">${items}</div>`,
      live: '',
    };
  }

  private slotContent(sim: Simulation, slot: number, base: string): Content {
    const rented = sim.facility.isRented(slot);
    const rent = UPKEEP.rackByPowerLevel[sim.upgrades.rackPower];
    return {
      key: `slot${slot}@${base}`,
      title: `区画 ${slot + 1}`,
      subtitle: rented ? '借りています' : '空き区画',
      desc: rented
        ? ''
        : `データセンターの区画を借りてラックを置きます。42U・電力 ${sim.rackPowerW}W。ラック間はケーブルトレイを通して配線します(長くなるぶん高い)。`,
      fixed: rented
        ? ''
        : `<div class="actions"><button type="button" class="primary" data-act="rent" data-slot="${slot}">借りる(${money(sim.rackPrice())}、賃料 ${rate(rent)})</button></div>`,
      live: '',
    };
  }

  private portContent(sim: Simulation, ref: PortRef, base: string, fromCable = false): Content | null {
    const f = sim.facility;
    const d = f.devices.get(ref.device);
    const p = f.portDef(ref);
    if (!d || !p) return null;
    const c = f.cableAt(ref);
    const info: [string, string][] = [['ポート', `${p.label}(${p.media === 'sfp' ? 'SFP' : 'RJ45'})`]];
    let fixed = `<div class="actions"><button type="button" data-act="device" data-id="${d.id}">${d.name} の詳細</button>`;
    if (c) {
      const other = f.otherEnd(c, ref.device);
      const po = f.portDef(other)!;
      const speed = Math.min(p.speedGbps, po.speedGbps);
      const link = sim.flow.links.find((l) => l.cables.includes(c.id));
      const rho = sim.flow.cableRho.get(c.id) ?? 0;
      info.push(['つながっている先', f.portName(other)]);
      info.push(['ケーブル', `${c.fiber ? '光ファイバ' : 'LAN ケーブル'} ${c.meters}m(${money(c.paid)})`]);
      info.push(['リンク速度', gbps(speed) + (link && link.cables.length > 1 ? `(${link.cables.length} 本束ねて ${gbps(link.capacityGbps)})` : '')]);
      if (link) {
        const [ab, ba] = link.a === ref.device ? [link.ab, link.ba] : [link.ba, link.ab];
        info.push(['使用率', `${load(rho)}(送信 ${gbps(ab / link.cables.length)} / 受信 ${gbps(ba / link.cables.length)})`]);
      }
      fixed += `<button type="button" class="danger" data-act="unplug" data-id="${c.id}">ケーブルを抜く</button>`;
    }
    fixed += '</div>';
    return {
      key: `port${ref.device}:${ref.port}@${base}`,
      title: fromCable && c ? 'ケーブル' : f.portName(ref),
      subtitle: fromCable && c ? `${f.portName(c.a)} ⇄ ${f.portName(c.b)}` : MODEL_BY_ID[d.model].name,
      desc: c ? '' : '空いています。背面でここから別のポートへドラッグすると配線できます。',
      fixed,
      live: rows(info),
    };
  }

  /** 分析基盤: ログの量、処理しきれた割合、単価の上がり方、役割ごとのサーバ */
  private analyticsContent(sim: Simulation, base: string, tabs: string): Content {
    const a = sim.flow.analytics;
    const f = sim.facility;
    const name = (id: number) => sim.flow.nodes.get(id)?.name ?? nodeName(f, id);
    const nodeRow = (id: number): [string, string] => {
      const l = sim.flow.nodeLoads.get(id);
      const gpu = l?.gpu !== undefined ? ` / GPU ${load(l.gpu)}` : '';
      return [name(id), l ? `CPU ${load(l.cpu)} / IO ${load(l.io)}${gpu}` : '-'];
    };
    const cov = (v: number) => `<span class="${v >= 0.99 ? 'ok' : v >= 0.7 ? 'warn' : 'bad'}">${pct(v)}</span>`;
    const summary: [string, string][] = [
      ['ログ', `${a.logMBps.toFixed(2)} MB/秒(1 ページビュー ${ANALYTICS.logKB} KB)`],
      ['集計(Hadoop)', `${cov(a.coverage)} 処理 → 単価 +${Math.round(ANALYTICS.hadoopBoost * a.coverage * 100)}%`],
    ];
    if (sim.unlocks.has('ml')) {
      summary.push(['機械学習', `${cov(a.mlCoverage)} 処理 → 単価 +${Math.round(ANALYTICS.mlBoost * a.mlCoverage * 100)}%`]);
    }
    summary.push(['すべてのサービスの単価', `<b>×${a.boost.toFixed(2)}</b>`]);
    const problems = sim.flow.problems.filter((p) => p.startsWith('分析基盤')).map((p) => `<li>${p.replace('分析基盤: ', '')}</li>`);
    return {
      key: `service:data@${base}`,
      title: 'サービス',
      subtitle: '分析基盤',
      desc: 'すべてのサービスの web からアクセスログを hadoop に集めて集計し、ml(機械学習)で広告とおすすめを当てる。処理しきれた割合に応じて単価が上がる。',
      fixed: tabs,
      live:
        section('効果', rows(summary)) +
        (problems.length ? section('警告', `<ul class="problems">${problems.join('')}</ul>`) : '') +
        section('hadoop', a.hadoop.length ? rows(a.hadoop.map(nodeRow)) : '<div class="muted small">まだありません(サーバか VM に役割「hadoop」を付ける)</div>') +
        (sim.unlocks.has('ml')
          ? section('ml', a.ml.length ? rows(a.ml.map(nodeRow)) : '<div class="muted small">まだありません(GPU を載せたサーバに役割「ml」を付ける)</div>')
          : ''),
    };
  }

  private serviceContent(sim: Simulation, base: string): Content {
    const flow = sim.flow;
    const f = sim.facility;
    const name = (id: number) => flow.nodes.get(id)?.name ?? nodeName(f, id);
    const active = sim.activeServices;
    // サービスのタブ(2 つ以上始めているか、分析基盤があれば)
    const scopes: Scope[] = [...active, ...(sim.isScopeActive('data') ? (['data'] as Scope[]) : [])];
    if (!scopes.includes(this.serviceTab)) this.serviceTab = 'blog';
    const tabs =
      scopes.length > 1
        ? `<div class="svc-tabs">${scopes
            .map((s) => `<button type="button" class="${s === this.serviceTab ? 'on' : ''}" data-act="svc" data-svc="${s}">${scopeName(s)}</button>`)
            .join('')}</div>`
        : '';
    if (this.serviceTab === 'data') return this.analyticsContent(sim, base, tabs);
    const id = this.serviceTab;
    const def = SERVICES[id];
    const sf = flow.services[id];
    const r = sim.metrics.rollingOf(id);
    const W = sim.workloadOf(id);

    let fixed = tabs;
    // キャンペーン(ショッピング)
    let campaign = '';
    if (id === 'shop') {
      const err = sim.campaignError();
      const state = sim.campaignActive
        ? `<span class="ok">実施中(あと ${Math.ceil((sim.campaign.until - sim.time) / 1000)} 秒)</span>`
        : sim.campaign.cooldownUntil > sim.time
          ? `<span class="muted">次まであと ${Math.ceil((sim.campaign.cooldownUntil - sim.time) / 1000)} 秒</span>`
          : '打てます';
      fixed += section(
        'キャンペーン',
        `<div class="desc small">払うとすぐ始まり、${CAMPAIGN.durationSec} 秒間 訪問が ×${CAMPAIGN.trafficMul}、注文の単価が ×${CAMPAIGN.revenueMul}。終わると ${CAMPAIGN.cooldownSec} 秒は打てない。</div>` +
          `<div class="actions"><button type="button" class="primary" data-act="campaign" ${err ? `disabled title="${err}"` : ''}>キャンペーンを打つ(${money(sim.campaignPrice())})</button></div>`,
      );
      campaign = section('キャンペーンの状態', rows([['状態', state]]));
    }
    // Kubernetes: 役割を Deployment にすると、Pod が自動で置かれて増減する
    let k8s = '';
    if (sim.unlocks.has('kubernetes')) {
      const deployable = def.roles.filter((role) => K8S.roles.includes(role));
      const buttons = deployable
        .map((role) => {
          const key = roleKey(id, role);
          const on = sim.deployments.has(key);
          const err = sim.deploymentError(key);
          return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="deploy" data-role="${key}" ${err && !on ? `disabled title="${err}"` : ''}>${ROLE_LABEL[role]}</button>`;
        })
        .join('');
      fixed += section(
        'Kubernetes(Deployment にする役割)',
        `<div class="desc small">Pod は CPU ${Math.round(K8S.targetCpu * 100)}% を目標に ${K8S.minPods}〜${K8S.maxPods} 個で自動で増減します。BGP を使うワーカーの Pod は LB なしで受けられます。</div><div class="role-buttons">${buttons}</div>`,
      );
      const podList: [string, string][] = [];
      for (const role of deployable) {
        const key = roleKey(id, role);
        if (!sim.deployments.has(key)) continue;
        const placed = sim.pods.filter((p) => p.role === key).reduce((n, p) => n + p.count, 0);
        const pending = sim.podsPending.get(key) ?? 0;
        podList.push([
          role,
          `Pod ${placed}${pending ? ` <span class="bad">(待ち ${pending})</span>` : ''} / 目標 ${sim.deployments.get(key)}`,
        ]);
      }
      if (podList.length) k8s = section('Pod', rows(podList));
    }

    const inst = sf?.instances;
    const count = (role: RoleId) => inst?.[role].length ?? 0;
    const chain: string[] = [`回線 ${gbps(sim.uplinkGbps)}`];
    // LB: アプライアンス(HA ペアはアクティブの 1 台)と SLB
    const lbEntries = (sf?.entries ?? []).filter((n) => {
      const dev = f.devices.get(n);
      return n > 0 && dev && MODEL_BY_ID[dev.model].category === 'lb';
    }).length;
    if (lbEntries) chain.push(`LB ×${lbEntries}`);
    if (count('lb')) chain.push(`SLB ×${count('lb')}`);
    chain.push(`web ×${count('web')}`);
    if (count('cache')) chain.push(`cache ×${count('cache')}`);
    if (W.search) chain.push(count('search') ? `search ×${count('search')}` : 'search(db が肩代わり)');
    const dbMode =
      count('db') > 1 ? (sim.unlocks.has('sharding') ? '(シャーディング)' : sim.unlocks.has('partition') ? '(機能分割)' : '') : '';
    chain.push(`db ×${count('db')}${dbMode}`);
    if (count('replica')) chain.push(`replica ×${count('replica')}`);
    const side: string[] = [];
    if (W.media) side.push(count('media') ? `media ×${count('media')}` : 'media(web が肩代わり)');
    if (W.upload) side.push(count('worker') ? `worker ×${count('worker')}` : 'worker(web が肩代わり)');

    const roleRows: [string, string][] = [];
    if (inst) {
      for (const role of ROLE_IDS) {
        for (const n of inst[role]) {
          const l = flow.nodeLoads.get(n);
          if (!l) continue;
          const io = ['db', 'replica', 'search', 'media'].includes(role) ? ` / IO ${load(l.io)}` : '';
          roleRows.push([`${role}: ${name(n)}`, `CPU ${load(l.cpu)}${io}`]);
        }
      }
    }

    const work: [string, string][] = [
      ['ユーザー', `${compact(sim.serviceUsers[id])} / 市場 ${compact(sim.marketOf(id))} 人`],
      ['ページビュー', `${compact(r.pv, 1)} /秒(キャパシティ ${compact(sim.capacityOf(id), 1)})`],
      ['1 ページで返すデータ', dataSize(W.pageKB)],
      ['db の読み込み / 書き込み', `${W.dbReads} / ${W.dbWrites || 'なし'} 回/ページ`],
    ];
    if (W.search) work.push(['検索', `${W.search.perPv} 回/ページ`]);
    if (W.media) work.push(['画像・動画の取得', `${W.media.perPv} 回 × ${dataSize(W.media.kb)}/ページ`]);
    if (W.upload) work.push(['投稿', `${W.upload.perPv} 件 × ${dataSize(W.upload.kb)}/ページ(加工 ${W.upload.workerCpuMs / 1000} 秒)`]);
    work.push(
      ['成功率', `<span class="${r.errorRate > 0.05 ? 'bad' : r.errorRate > 0.01 ? 'warn' : 'ok'}">${(100 - r.errorRate * 100).toFixed(1)}%</span>`],
      ['応答(平均 / p99 見積もり)', `${Math.round(r.latencyMs)} / ${Math.round(r.p99Ms)} ms`],
    );
    const u = sim.upkeep;
    const money_: [string, string][] = [
      ...active.map((s): [string, string] => [`売上(${SERVICES[s].name})`, rate(sim.metrics.rollingOf(s).revenuePerSec)]),
      ['ラック賃料', rate(-u.racks)],
      [`回線(${sim.lineCount} 本)`, rate(-u.uplink)],
      ...(sim.unlocks.has('cdn') ? ([[`CDN(${(sim.cdnGBps * 8).toFixed(2)} Gbps)`, rate(-u.cdn)]] as [string, string][]) : []),
      ['電気代', rate(-u.power)],
    ];
    const b = flow.bottleneck;
    // 複数のサービスが動いていれば、このサービスの警告と、機器など全体の警告だけ
    const list =
      active.length > 1
        ? [...(sf?.problems ?? []), ...flow.problems.filter((p) => !SERVICE_IDS.some((s) => p.startsWith(`${SERVICES[s].name}: `)))]
        : flow.problems;
    const problems = list.map((p) => `<li>${p}</li>`).join('');
    return {
      key: `service:${id}@${base}@${active.length}`,
      title: 'サービス',
      subtitle: def.name,
      desc: '',
      fixed,
      live:
        campaign +
        k8s +
        section(
          '流れ',
          `<div class="chain">${chain.join(' → ')}</div>` + (side.length ? `<div class="chain">${side.join('・')}</div>` : ''),
        ) +
        (problems ? section('警告', `<ul class="problems">${problems}</ul>`) : '') +
        section('一番詰まっている所(全体)', b ? rows([[b.label, load(b.rho)]]) : '<div class="muted small">なし</div>') +
        section('役割ごとのサーバ', rows(roleRows)) +
        section('仕事量', rows(work)) +
        section('収支', rows(money_)) +
        `<div class="muted small">ラックの電力上限 ${sim.rackPowerW}W・高さ ${RACK.units}U</div>`,
    };
  }
}
