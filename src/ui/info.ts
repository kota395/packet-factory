/**
 * 右の詳細パネル。選んだもの(機器・U・区画・ポート・ケーブル・サービス全体)に合わせて中身を作る。
 * ボタンを含む部分は選択や構成が変わったときだけ組み直し、数値の部分だけを定期的に更新する
 * (ボタンを作り直すとタップを取りこぼすため)。
 */
import { BUYABLE_MODELS, MODEL_BY_ID, portsOf, type ModelDef } from '../sim/catalog';
import { BLOG, RACK } from '../sim/config';
import type { Device } from '../sim/facility';
import { SELL_REFUND_RATE, UPKEEP } from '../sim/pricing';
import type { Simulation } from '../sim/simulation';
import { ROLE_IDS, type ModelId, type PortRef, type RoleId } from '../sim/types';
import type { Target } from '../render/row';
import { compact, money, rate } from './format';

export type Selection = Target | { kind: 'service' };

export interface InfoActions {
  toast(message: string): void;
  select(target: Selection | null): void;
  changed(): void;
}

const ROLE_LABEL: Record<RoleId, string> = { lb: 'lb(LVS)', web: 'web', cache: 'cache(memcached)', db: 'db(MySQL)' };

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
        r = sim.toggleRole(Number(data.id), data.role as RoleId);
        break;
      case 'unplug':
        r = sim.disconnect(Number(data.id));
        if (r.ok) this.actions.select(null);
        break;
      case 'device':
        this.actions.select({ kind: 'device', id: Number(data.id) });
        return;
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
    const roles = sim.availableRoles;

    let fixed = '';
    if (m.category === 'server') {
      const buttons = ROLE_IDS.map((r) => {
        const on = d.roles.includes(r);
        const err = sim.roleError(d.id, r);
        return `<button type="button" class="toggle ${on ? 'on' : ''}" data-act="role" data-id="${d.id}" data-role="${r}" ${err && !on ? `disabled title="${err}"` : ''}>${ROLE_LABEL[r]}</button>`;
      }).join('');
      fixed += section('役割', `<div class="role-buttons">${buttons}</div>`);
    }
    if (m.category !== 'handoff') {
      fixed += `<div class="actions"><button type="button" class="danger" data-act="sell" data-id="${d.id}">売却する(+${money(Math.floor(d.paid * SELL_REFUND_RATE))})</button></div>`;
    }

    const place: [string, string][] = [
      ['場所', `ラック ${d.slot + 1} / ${d.u}${m.u > 1 ? `〜${d.u + m.u - 1}` : ''}U`],
      ['スペック', specOf(m)],
      ['電力', `${m.powerW} W`],
    ];
    if (m.category === 'handoff') place.push(['回線契約', gbps(sim.uplinkGbps)]);

    const loadRows: [string, string][] = [];
    if (l) {
      if (m.category === 'server') {
        loadRows.push(['CPU', load(l.cpu)]);
        loadRows.push(['ディスク IO', load(l.io) + (l.dbMiss !== undefined ? `(読み込みの ${pct(l.dbMiss)} がディスクへ)` : '')]);
        for (const r of d.roles) {
          if (!roles.has(r)) continue;
          const w = l.work[r] ?? 0;
          const unit = r === 'db' || r === 'cache' ? '回/秒' : 'PV/秒';
          loadRows.push([`${r} の仕事`, w > 0 ? `${compact(w, 1)} ${unit}` : '<span class="muted">なし(流れてきていない)</span>']);
        }
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
    const name = (id: number) => f.devices.get(id)?.name ?? '?';
    const r = sim.metrics.rolling;

    const chain: string[] = [`回線 ${gbps(sim.uplinkGbps)}`];
    if (flow.instances.lb.length && sim.availableRoles.has('lb')) chain.push(`lb ×${flow.instances.lb.length}`);
    chain.push(`web ×${flow.instances.web.length}`);
    if (flow.instances.cache.length) chain.push(`cache ×${flow.instances.cache.length}`);
    chain.push(`db ×${flow.instances.db.length}`);

    const roleRows: [string, string][] = [];
    for (const role of ROLE_IDS) {
      for (const id of flow.instances[role]) {
        const l = flow.devices.get(id);
        if (!l) continue;
        const io = role === 'db' ? ` / IO ${load(l.io)}` : '';
        roleRows.push([`${role}: ${name(id)}`, `CPU ${load(l.cpu)}${io}`]);
      }
    }

    const respKB = BLOG.pageKB + (sim.isFeatureActive('images') ? BLOG.imageKB : 0);
    const work: [string, string][] = [
      ['ページビュー', `${compact(r.pv, 1)} /秒`],
      ['1 ページで返すデータ', `${respKB} KB`],
      ['db の読み込み', `${BLOG.dbReads} 回/ページ`],
      ['db の書き込み', sim.isFeatureActive('comments') ? `${BLOG.dbWrites} 回/ページ(コメント)` : 'なし'],
      ['成功率', `<span class="${r.errorRate > 0.05 ? 'bad' : r.errorRate > 0.01 ? 'warn' : 'ok'}">${(100 - r.errorRate * 100).toFixed(1)}%</span>`],
      ['応答(平均 / p99 見積もり)', `${Math.round(r.latencyMs)} / ${Math.round(r.p99Ms)} ms`],
    ];
    const u = sim.upkeep;
    const money_: [string, string][] = [
      ['売上', rate(r.revenuePerSec)],
      ['ラック賃料', rate(-u.racks)],
      ['回線', rate(-u.uplink)],
      ['電気代', rate(-u.power)],
    ];
    const b = flow.bottleneck;
    const problems = flow.problems.map((p) => `<li>${p}</li>`).join('');
    return {
      key: `service@${base}`,
      title: 'サービス',
      subtitle: 'ブログ',
      desc: '',
      fixed: '',
      live:
        section('流れ', `<div class="chain">${chain.join(' → ')}</div>`) +
        (problems ? section('警告', `<ul class="problems">${problems}</ul>`) : '') +
        section('一番詰まっている所', b ? rows([[b.label, load(b.rho)]]) : '<div class="muted small">なし</div>') +
        section('役割ごとのサーバ', rows(roleRows)) +
        section('仕事量', rows(work)) +
        section('収支', rows(money_)) +
        `<div class="muted small">ラックの電力上限 ${sim.rackPowerW}W・高さ ${RACK.units}U</div>`,
    };
  }
}
