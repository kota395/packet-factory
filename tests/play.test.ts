/** ゲームと同じ操作(買う・役割を付ける。配線は自動)だけで組んだ構成が動くことを確かめる */
import { describe, expect, it } from 'vitest';
import { RACK } from '../src/sim/config';
import { lbGroups } from '../src/sim/flow';
import { Simulation } from '../src/sim/simulation';
import type { RoleKey, UnlockId } from '../src/sim/types';
import { RICH, constant, run } from './helpers';

/** 回線終端とスイッチだけのラック。あとは買うだけ */
function rack(pv: number, unlocks: UnlockId[] = []) {
  const s = new Simulation({ startMoney: RICH, traffic: constant(pv), unlocks, upgrades: { uplink: 2, rackPower: 3 } });
  s.facility.rent(0);
  s.facility.place('handoff', 0, RACK.units, 0);
  let u = RACK.units - 1;
  const put = (preset: string, ...roles: RoleKey[]) => {
    const r = s.buyServer(preset, 0, (u -= 2));
    expect(r.ok, r.message).toBe(true);
    for (const role of roles) expect(s.toggleRole(r.id!, role).ok).toBe(true);
    return r.id!;
  };
  const device = (model: Parameters<Simulation['buyDevice']>[0]) => {
    const r = s.buyDevice(model, 0, (u -= 2));
    expect(r.ok, r.message).toBe(true);
    return r.id!;
  };
  return { s, put, device };
}

describe('置くだけで動く(自動配線)', () => {
  it('web と db を置いて役割を付けると、ブログが動く', () => {
    const { s, put, device } = rack(100);
    device('sw-24');
    put('1u-small', 'blog:web');
    put('2u-ssd', 'blog:db');
    const flow = run(s);
    expect(flow.success).toBe(1);
    expect(flow.problems).toEqual([]);
    expect(s.facility.unwired.size).toBe(0);
  });

  it('LB を置くと web 2 台に振り分けられ、LB 2 台は HA になって片方を止めても続く', () => {
    const { s, put, device } = rack(400, ['lb']);
    device('sw-24');
    const a = put('1u-web', 'blog:web');
    put('2u-ssd', 'blog:db');
    const l1 = device('lb-1u');
    const b = put('1u-web', 'blog:web');
    let flow = run(s);
    expect(flow.success).toBe(1);
    const work = (id: number) => flow.nodeLoads.get(id)!.work['blog:web'] ?? 0;
    expect(work(a)).toBeGreaterThan(0);
    expect(work(b)).toBeCloseTo(work(a), 5);
    const l2 = device('lb-1u');
    expect(lbGroups(s.facility, new Set())[0].members).toEqual([l1, l2]);
    s.setMaintenance(l1, true);
    flow = run(s);
    expect(flow.success).toBe(1);
  });

  it('ラックを足しても、ToR を置けばコアにつながって届く', () => {
    const { s, put, device } = rack(100, ['tenGig']);
    device('sw-48');
    put('1u-small', 'blog:web');
    expect(s.rentRack(1).ok).toBe(true);
    expect(s.buyDevice('sw-48', 1, 40).ok).toBe(true);
    const db = s.buyServer('2u-ssd', 1, 20).id!;
    s.toggleRole(db, 'blog:db');
    const flow = run(s);
    expect(flow.success).toBe(1);
    expect(s.facility.unwired.size).toBe(0);
  });
});
