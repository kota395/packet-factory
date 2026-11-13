/** 詳細パネルの中身: 機器(サーバ・スイッチ・LB など)の詳細と、サーバのパーツの変更 */
import { CHASSIS, DRIVES, MODEL_BY_ID, NICS, isServerModel, partsSummary, portsOf, specOf } from '../../sim/catalog';
import { VIRT } from '../../sim/config';
import type { Device } from '../../sim/facility';
import { lbGroups } from '../../sim/flow';
import type { PartChange, Simulation } from '../../sim/simulation';
import type { ServerParts } from '../../sim/types';
import { money, rolesText } from '../format';
import { nodeRows, roleButtons, podRows, load, gbps, rows, section, specText, encodeChange, costText } from './common';
import type { Content } from './common';

export function deviceContent(sim: Simulation, d: Device, base: string): Content {
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
  if (d.parts && isServerModel(d.model)) fixed += partsSection(sim, d);
  if (m.category === 'server' && !d.hv && sim.unlocks.has('bgp')) {
    fixed += section(
      'BGP',
      `<div class="role-buttons"><button type="button" class="toggle ${d.bgp ? 'on' : ''}" data-act="bgp" data-id="${d.id}" data-on="${d.bgp ? '0' : '1'}">BGP を使う</button></div>`,
    );
  }
  if (!sim.isMainLine(d.id)) {
    fixed += `<div class="actions">
      <button type="button" data-act="maint" data-id="${d.id}" data-on="${d.down ? '0' : '1'}">${d.down ? 'メンテナンスから戻す' : 'メンテナンスで止める'}</button>
      <button type="button" class="danger" data-act="sell" data-id="${d.id}">売却する(+${money(sim.sellValue(d.id))})</button>
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
        ? '<span class="muted">なし(LB をもう 1 台置くと、自動で HA のペアになる)</span>'
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

  // ネットワーク: 自動配線でつながった先ごとに、束ねた速度と使用率
  const links: [string, string][] = [];
  for (const l of sim.flow.links) {
    if (l.a !== d.id && l.b !== d.id) continue;
    const other = f.devices.get(l.a === d.id ? l.b : l.a);
    const n = l.cables.length;
    const rho = l.capacityGbps > 0 ? Math.max(l.ab, l.ba) / l.capacityGbps : 0;
    links.push([`→ ${other?.name ?? '?'}`, `${gbps(l.capacityGbps / n)}${n > 1 ? `×${n}` : ''} ${load(rho)}`]);
  }
  const why = f.unwired.get(d.id);
  if (why) links.push(['<span class="bad">未接続</span>', why]);
  const ports = portsOf(d).filter((p) => p.label !== 'HA');
  const usedPorts = ports.filter((p) => f.cableAt({ device: d.id, port: p.index })).length;
  links.push(['ポート', `${usedPorts} / ${ports.length} 使用`]);

  return {
    key: `dev${d.id}@${base}`,
    title: d.name,
    subtitle: m.name,
    desc: m.description,
    fixed,
    live:
      section('機器', rows(place)) +
      section('負荷', rows(loadRows)) +
      section('ネットワーク(自動配線)', rows(links.slice(0, 20)) + (links.length > 20 ? `<div class="muted small">ほか ${links.length - 20} 件</div>` : '')),
  };
}

/** サーバの構成: ワンクリックでパーツを替えるボタン */
function partsSection(sim: Simulation, d: Device): string {
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
