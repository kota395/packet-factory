/** テストで共通に使う部品(サーバの構成、決めた配線の土台) */
import { expect } from 'vitest';
import { PRESET_BY_ID, partsRequires } from '../src/sim/catalog';
import { RACK } from '../src/sim/config';
import { Simulation } from '../src/sim/simulation';
import type { PortRef, RoleKey, ServerParts, ServiceId, UnlockId } from '../src/sim/types';

export const constant = (pv: number) => () => pv;

/** 手で配線する(流量モデルを、決めた配線で確かめるテスト用。ゲームでは自動配線) */
export const wire = (s: Simulation, a: PortRef, b: PortRef) => {
  const err = s.facility.connectError(a, b);
  if (!err) {
    s.facility.connect(a, b);
    s.refreshFlow();
  }
  return { ok: !err, message: err ?? '' };
};

/**
 * テストで使うサーバの構成(名前で呼ぶ)。数値の期待値はこの構成に合わせてあるので、
 * ゲームのプリセットを調整してもテストは変わらない
 */
export const SERVERS = {
  /** 1U の最小構成(最初の web) */
  small: { model: 'srv-1u', parts: PRESET_BY_ID['1u-small'].parts },
  /** 1U の web 向け */
  web: { model: 'srv-1u', parts: PRESET_BY_ID['1u-web'].parts },
  /** 2U の db 向け(8 コア・64GB・SSD) */
  db: { model: 'srv-2u', parts: { cpu: 8, memGB: 64, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'none' } },
  /** 2U の大きい構成(24 コア・256GB・10G NIC。ハイパーバイザやワーカー向け) */
  big: { model: 'srv-2u', parts: { cpu: 24, memGB: 256, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'sfp10' } },
} as const satisfies Record<string, { model: 'srv-1u' | 'srv-2u'; parts: ServerParts }>;
export type ServerKind = keyof typeof SERVERS;

/** SERVERS の構成のサーバを買う */
export const buy = (s: Simulation, kind: ServerKind, slot: number, u: number) => {
  const l = SERVERS[kind];
  // 10G NIC などの解放はテストでは済ませておく
  for (const id of partsRequires(l.parts)) s.unlocks.add(id);
  return s.buyDevice(l.model, slot, u, l.parts);
};
export const RICH = 1_000_000;

/** 回線終端と ToR スイッチだけのラック 1 本 */
export function base(opts: { pv?: number; traffic?: Partial<Record<ServiceId, number>>; unlocks?: UnlockId[]; uplink?: number } = {}) {
  const s = new Simulation({
    startMoney: RICH,
    manualWiring: true,
    traffic: opts.traffic
      ? Object.fromEntries(Object.entries(opts.traffic).map(([k, v]) => [k, constant(v)]))
      : constant(opts.pv ?? 10),
    unlocks: opts.unlocks,
    upgrades: { uplink: opts.uplink ?? 2, rackPower: 3 },
  });
  const f = s.facility;
  f.rent(0);
  const isp = f.place('handoff', 0, RACK.units, 0);
  const sw = s.buyDevice('sw-24', 0, 40).id!;
  expect(wire(s, { device: isp.id, port: 0 }, { device: sw, port: 0 }).ok).toBe(true);
  let nextPort = 1;
  /** サーバを買って役割を付け、ToR につなぐ */
  const server = (model: ServerKind, u: number, roles: RoleKey[], slot = 0, toSw = sw) => {
    const r = buy(s, model, slot, u);
    expect(r.ok, r.message).toBe(true);
    for (const role of roles) expect(s.toggleRole(r.id!, role).ok).toBe(true);
    if (toSw === sw) expect(wire(s, { device: r.id!, port: 0 }, { device: sw, port: nextPort++ }).ok).toBe(true);
    return r.id!;
  };
  /** LB アプライアンスを買って ToR につなぐ */
  const lb = (u: number) => {
    const r = s.buyDevice('lb-1u', 0, u);
    expect(r.ok, r.message).toBe(true);
    expect(wire(s, { device: r.id!, port: 0 }, { device: sw, port: nextPort++ }).ok).toBe(true);
    return r.id!;
  };
  return { s, f, isp: isp.id, sw, server, lb };
}

export const run = (s: Simulation, ms = 5000) => {
  s.step(ms);
  return s.flow;
};
