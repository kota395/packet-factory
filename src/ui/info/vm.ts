/** 詳細パネルの中身: VM の詳細 */
import { VIRT } from '../../sim/config';
import type { Vm } from '../../sim/facility';
import type { Simulation } from '../../sim/simulation';
import { nodeRows, roleButtons, podRows, load, rows, section } from './common';
import type { Content } from './common';

export function vmContent(sim: Simulation, vm: Vm, base: string): Content {
  const f = sim.facility;
  const host = f.devices.get(vm.host);
  const size = VIRT.sizes[vm.size];
  let fixed = vm.k8s
    ? section(
        'Kubernetes のワーカー',
        `<div class="desc small">役割は付けず、Deployment の Pod が自動で置かれます。</div><div class="actions"><button type="button" data-act="vmk8s" data-id="${vm.id}" data-on="0">ワーカーから外す</button></div>`,
      )
    : section(
        '役割',
        roleButtons(sim, vm.roles, 'vmrole', vm.id, (r) => sim.vmRoleError(vm.id, r)),
      ) +
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
  fixed += section('別のホストへ移す', `<div class="role-buttons">${moves || '<span class="muted small">ほかにハイパーバイザがありません</span>'}</div>`);
  fixed += `<div class="actions"><button type="button" data-act="device" data-id="${vm.host}">${host?.name ?? '?'} の詳細</button><button type="button" class="danger" data-act="deletevm" data-id="${vm.id}">VM を消す</button></div>`;

  const state = vm.downUntil > sim.time ? `<span class="warn">移行中(あと ${Math.ceil((vm.downUntil - sim.time) / 1000)} 秒)</span>` : '動いています';
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
    section('負荷', rows([...nodeRows(sim, vm.roles, sim.flow.nodeLoads.get(-vm.id), 'vCPU'), ...(vm.k8s ? podRows(sim, -vm.id, size.vcpu, size.memGB) : [])]));
  return {
    key: `vm${vm.id}@${base}`,
    title: vm.name,
    subtitle: '仮想マシン',
    desc: '同じホストの VM 同士の通信はネットワークを通りません。前面のホストには、サービスごとの VM の台数が出ます。',
    fixed,
    live,
  };
}
