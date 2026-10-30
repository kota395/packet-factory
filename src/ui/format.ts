import { SCOPES, splitRole, type RoleKey, type Scope } from '../sim/types';

const UNITS = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi'];

/** 1234 → 1.23k, 5600000 → 5.60M */
export function compact(n: number, smallDigits = 0): string {
  const sign = n < 0 ? '-' : '';
  let v = Math.abs(n);
  if (v < 1000) return sign + v.toFixed(smallDigits);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${sign}${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${UNITS[i]}`;
}

export function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  return `${sign}$${v < 1000 ? Math.floor(v) : compact(v)}`;
}

/** 収支/秒。小さい値は小数 2 桁まで出す */
export function rate(n: number): string {
  const sign = n < 0 ? '-' : '+';
  const v = Math.abs(n);
  return `${sign}$${v < 100 ? v.toFixed(2) : compact(v)}/s`;
}

export function duration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} 分`;
  return m ? `${h} 時間 ${m} 分` : `${h} 時間`;
}

/** 帯域の表示。引数は MB/秒(= 8 Mbps) */
export function bandwidth(mbPerSec: number): string {
  const mbps = mbPerSec * 8;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps >= 10_000 ? 0 : 1)} Gbps`;
  return `${mbps.toFixed(mbps >= 10 ? 0 : 1)} Mbps`;
}

/** データ量の表示。引数は KB */
export function dataSize(kb: number): string {
  if (kb >= 1000) return `${(kb / 1000).toFixed(kb >= 10_000 ? 0 : 1)} MB`;
  return `${Math.round(kb)} KB`;
}

/** サービスの短い名前(機器のラベルなど狭い所に出す) */
export const SERVICE_SHORT: Readonly<Record<Scope, string>> = {
  blog: 'ブログ',
  shop: 'ショップ',
  photo: '写真',
  video: '動画',
  data: '分析',
};

/** 役割の並びを、サービスごとにまとめて書く(例: 「ブログ web・db / ショップ search」) */
export function rolesText(keys: readonly RoleKey[]): string {
  const by = new Map<Scope, string[]>();
  for (const k of keys) {
    const [s, r] = splitRole(k);
    if (!by.has(s)) by.set(s, []);
    by.get(s)!.push(r);
  }
  return SCOPES.filter((s) => by.has(s))
    .map((s) => `${SERVICE_SHORT[s]} ${by.get(s)!.join('・')}`)
    .join(' / ');
}
