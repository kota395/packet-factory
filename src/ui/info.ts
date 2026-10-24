/**
 * 右の詳細パネル。選んだもの(機器・U・区画・ポート・ケーブル・サービス全体)に合わせて中身を作る。
 * ボタンを含む部分は選択や構成が変わったときだけ組み直し、数値の部分だけを定期的に更新する
 * (ボタンを作り直すとタップを取りこぼすため)。
 */
import { BUYABLE_MODELS, MODEL_BY_ID, portsOf, type ModelDef } from '../sim/catalog';
import { CAMPAIGN, RACK, SERVICES, VIRT } from '../sim/config';
import type { Device, Vm } from '../sim/facility';
import { nodeName, type NodeLoad } from '../sim/flow';
import { SELL_REFUND_RATE, UPKEEP } from '../sim/pricing';
import type { Simulation } from '../sim/simulation';
import {
  ROLE_IDS,
  SERVICE_IDS,
  roleKey,
  splitRole,
  type DiskKind,
  type ModelId,
  type PortRef,
  type RoleId,
  type RoleKey,
  type ServiceId,
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
};

/** ノード(物理サーバか VM)の負荷の行 */
function nodeRows(sim: Simulation, roles: readonly RoleKey[], l: NodeLoad | undefined, cpuLabel: string): [string, string][] {
  const out: [string, string][] = [];
  if (!l) return out;
  out.push([cpuLabel, load(l.cpu)]);
  const disk = l.storage != null ? `共有(${sim.facility.devices.get(l.storage)?.name})` : l.storage === null ? '共有(届かない)' : 'ローカル';
  out.push(['ディスク', `${disk} ${load(l.io)}(${compact(l.ioOps, 1)} IO/秒)`]);
  // 付けた役割と、肩代わりしている仕事(media がないときの web など)
  const keys = [...new Set([...roles, ...(Object.keys(l.work) as RoleKey[])])];
  for (const k of keys) {
    const [s, r] = splitRole(k);
    if (!sim.isServiceActive(s) || !sim.availableRoles.has(r)) continue;
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
  return sim.activeServices
    .map((s) => {
      const buttons = SERVICES[s].roles
        .map((r) => {
          const k = roleKey(s, r);
          const on = roles.includes(k);
          const err = errorOf(k);
          return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="${act}" data-id="${id}" data-role="${k}" ${err && !on ? `disabled title="${err}"` : ''}>${ROLE_LABEL[r]}</button>`;
        })
        .join('');
      return `<div class="role-group"><div class="role-svc">${SERVICES[s].name}</div><div class="role-buttons">${buttons}</div></div>`;
    })
    .join('');
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

function specOf(m: ModelDef): string {
  const ports = m.ports.map((g) => `${g.label}×${g.count}`).join(' + ');
  if (m.category === 'server') return `${m.cores} コア(×${m.coreSpeed})・${m.memGB}GB・${m.diskIops} IOPS・${ports}`;
  if (m.category === 'switch') return `${ports}・処理 ${m.fabricGbps} Gbps`;
  if (m.category === 'storage') return `${m.diskIops!.toLocaleString('en-US')} IOPS・${ports}`;
  return ports;
}

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
  private serviceTab: ServiceId = 'blog';

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
      const err =
        sim.canBuyModel(model) ?? sim.placeError(model, Number(b.dataset.slot), Number(b.dataset.u));
      const price = sim.devicePrice(model);
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
  }

  private act(data: DOMStringMap): void {
    const sim = this.getSim();
    let r: { ok: boolean; message?: string; id?: number } | null = null;
    switch (data.act) {
      case 'close':
        this.actions.select(null);
        return;
      case 'buy':
        r = sim.buyDevice(data.model as ModelId, Number(data.slot), Number(data.u));
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
        this.serviceTab = data.svc as ServiceId;
        break;
      case 'campaign':
        r = sim.startCampaign();
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
    } else if (m.category === 'server') {
      fixed += section('役割', roleButtons(sim, d.roles, 'role', d.id, (r) => sim.roleError(d.id, r)));
      const hvErr = sim.hvError(d.id, true);
      fixed += `<div class="actions"><button type="button" data-act="hv" data-id="${d.id}" data-on="1" ${hvErr ? `disabled title="${hvErr}"` : ''}>ハイパーバイザにする</button></div>`;
    }
    if (m.category === 'server' && !d.hv && sim.unlocks.has('bgp')) {
      fixed += section(
        'BGP',
        `<div class="role-buttons"><button type="button" class="toggle ${d.bgp ? 'on' : ''}" data-act="bgp" data-id="${d.id}" data-on="${d.bgp ? '0' : '1'}">BGP を使う</button></div>`,
      );
    }
    if (m.category !== 'handoff') {
      fixed += `<div class="actions">
        <button type="button" data-act="maint" data-id="${d.id}" data-on="${d.down ? '0' : '1'}">${d.down ? 'メンテナンスから戻す' : 'メンテナンスで止める'}</button>
        <button type="button" class="danger" data-act="sell" data-id="${d.id}">売却する(+${money(Math.floor(d.paid * SELL_REFUND_RATE))})</button>
      </div>`;
    }

    const place: [string, string][] = [
      ['場所', `ラック ${d.slot + 1} / ${d.u}${m.u > 1 ? `〜${d.u + m.u - 1}` : ''}U`],
      ['スペック', specOf(m)],
      ['電力', `${m.powerW} W`],
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

    const loadRows: [string, string][] = [];
    if (l) {
      if (m.category === 'server' && d.hv) {
        const use = f.hostUsage(d.id);
        loadRows.push(['CPU(VM の合計)', load(l.cpu)]);
        loadRows.push(['ローカルディスク', load(l.io)]);
        loadRows.push(['割り当て', `vCPU ${use.vcpu} / ${m.cores! * VIRT.vcpuOvercommit}・メモリ ${use.memGB} / ${m.memGB! - VIRT.hostMemGB} GB`]);
      } else if (m.category === 'server') {
        loadRows.push(...nodeRows(sim, d.roles, sim.flow.nodeLoads.get(d.id), 'CPU'));
      } else if (m.category === 'storage') {
        loadRows.push(['IOPS', load(l.io)]);
      } else if (m.category === 'switch') {
        loadRows.push(['処理能力', load(l.fabric)]);
      }
      loadRows.push(['通信量', gbps(l.gbps)]);
    }

    const ports = portsOf(d.model);
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

  private vmContent(sim: Simulation, vm: Vm, base: string): Content {
    const f = sim.facility;
    const host = f.devices.get(vm.host);
    const size = VIRT.sizes[vm.size];
    let fixed = section('役割', roleButtons(sim, vm.roles, 'vmrole', vm.id, (r) => sim.vmRoleError(vm.id, r)));
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
      ) + section('負荷', rows(nodeRows(sim, vm.roles, sim.flow.nodeLoads.get(-vm.id), 'vCPU')));
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
    const items = BUYABLE_MODELS.map((m) => {
      const locked = sim.canBuyModel(m.id);
      return `
        <div class="cat-item ${locked ? 'locked' : ''}">
          <div class="cat-main">
            <div class="cat-title">${m.name}<span class="inv-tag">${m.u}U・${m.powerW}W</span></div>
            <div class="cat-spec">${specOf(m)}</div>
            <div class="cat-note"></div>
          </div>
          <button type="button" class="buy" data-act="buy" data-model="${m.id}" data-slot="${slot}" data-u="${u}">${money(sim.devicePrice(m.id))}</button>
        </div>`;
    }).join('');
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

  private serviceContent(sim: Simulation, base: string): Content {
    const flow = sim.flow;
    const f = sim.facility;
    const name = (id: number) => nodeName(f, id);
    const active = sim.activeServices;
    if (!active.includes(this.serviceTab)) this.serviceTab = 'blog';
    const id = this.serviceTab;
    const def = SERVICES[id];
    const sf = flow.services[id];
    const r = sim.metrics.rollingOf(id);
    const W = sim.workloadOf(id);

    // 見るサービスを切り替えるタブ(2 つ以上始めていれば)
    let fixed = '';
    if (active.length > 1) {
      fixed += `<div class="svc-tabs">${active
        .map((s) => `<button type="button" class="${s === id ? 'on' : ''}" data-act="svc" data-svc="${s}">${SERVICES[s].name}</button>`)
        .join('')}</div>`;
    }
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

    const inst = sf?.instances;
    const count = (role: RoleId) => inst?.[role].length ?? 0;
    const chain: string[] = [`回線 ${gbps(sim.uplinkGbps)}`];
    if (count('lb')) chain.push(`lb ×${count('lb')}`);
    chain.push(`web ×${count('web')}`);
    if (count('cache')) chain.push(`cache ×${count('cache')}`);
    if (W.search) chain.push(count('search') ? `search ×${count('search')}` : 'search(db が肩代わり)');
    chain.push(`db ×${count('db')}`);
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
      ['回線', rate(-u.uplink)],
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
