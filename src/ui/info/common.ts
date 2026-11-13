/** 詳細パネルの各部品で共通に使う表示の部品(役割の行、ボタン、表、パーツの変更の符号化) */
import { specOf } from '../../sim/catalog';
import type { ModelDef } from '../../sim/catalog';
import { K8S, SERVICES, scopeName } from '../../sim/config';
import type { NodeLoad } from '../../sim/flow';
import type { PartChange, Simulation } from '../../sim/simulation';
import { DATA_ROLES, roleKey, splitRole } from '../../sim/types';
import type { RoleId, RoleKey, Scope, ServerParts } from '../../sim/types';
import { SERVICE_SHORT, compact, money, rolesText } from '../format';

export const ROLE_LABEL: Record<RoleId, string> = {
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
export const ROLE_UNIT: Record<RoleId, string> = {
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
export function nodeRows(sim: Simulation, roles: readonly RoleKey[], l: NodeLoad | undefined, cpuLabel: string): [string, string][] {
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
export function roleButtons(
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
export function podRows(sim: Simulation, worker: number, vcpu: number, memGB: number): [string, string][] {
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

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const load = (v: number) => `<span class="${v >= 0.9 ? 'bad' : v >= 0.7 ? 'warn' : 'ok'}">${pct(v)}</span>`;
export const gbps = (v: number) => (v >= 1 ? `${v.toFixed(v >= 10 ? 0 : 1)} Gbps` : `${Math.round(v * 1000)} Mbps`);

export function rows(list: [string, string][]): string {
  return `<div class="rows-box">${list.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
}

export function section(title: string, body: string): string {
  return body ? `<section class="info-sec"><h4>${title}</h4>${body}</section>` : '';
}

/** 性能の 1 行(サーバは構成から) */
export function specText(m: ModelDef, parts?: ServerParts | null): string {
  const sp = specOf({ model: m.id, parts });
  const ports = sp.ports.map((g) => `${g.label}×${g.count}`).join(' + ');
  if (m.category === 'server') return `${sp.cores} コア・${sp.memGB}GB・${compact(sp.diskIops)} IOPS${sp.gpus ? `・GPU×${sp.gpus}` : ''}・${ports}`;
  if (m.category === 'switch') return `${ports}・処理 ${m.fabricGbps} Gbps`;
  if (m.category === 'storage') return `${m.diskIops!.toLocaleString('en-US')} IOPS・${ports}`;
  if (m.category === 'lb') return `${ports}・振り分け ${compact(m.lbRps!)} リクエスト/秒`;
  return ports;
}

/** パーツの変更を data 属性に書く形 */
export function encodeChange(c: PartChange): string {
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

export function decodeChange(s: string): PartChange | null {
  const [k, v] = s.split(':');
  if (k === 'cpu' || k === 'mem' || k === 'gpu') return { kind: k, dir: v === '1' ? 1 : -1 };
  if (k === 'add' && (v === 'hdd' || v === 'ssd' || v === 'nvme')) return { kind: 'drive-add', type: v };
  if (k === 'remove') return { kind: 'drive-remove' };
  if (k === 'bp' && (v === 'sff' || v === 'lff')) return { kind: 'backplane', to: v };
  if (k === 'nic' && (v === 'none' || v === 'sfp10')) return { kind: 'nic', to: v };
  return null;
}

/** パーツを替えるボタンの値段の表示(マイナスなら戻ってくる) */
export const costText = (cost: number) => (cost >= 0 ? money(cost) : `+${money(-cost)} 戻る`);

export interface Content {
  key: string;
  title: string;
  subtitle: string;
  desc: string;
  /** ボタンを含む部分(選択や構成が変わったときだけ組み直す) */
  fixed: string;
  /** 数値の部分(毎回更新) */
  live: string;
}
