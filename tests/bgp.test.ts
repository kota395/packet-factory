import { describe, expect, it } from 'vitest';
import { DIFFICULTY, RACK } from '../src/sim/config';
import { createSave, loadSave, newGame, parseSave } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import type { UnlockId } from '../src/sim/types';
import { constant, wire, RICH, run, buy } from './helpers';

describe('BGP による冗長化', () => {
  /** 回線 → コア → ToR 2 台 → サーバ 1 台(両方の ToR につなぐ) */
  function dual(unlocks: UnlockId[] = []) {
    const s = new Simulation({ startMoney: RICH, manualWiring: true, traffic: constant(50), unlocks, upgrades: { uplink: 2, rackPower: 3 } });
    const f = s.facility;
    f.rent(0);
    const isp = f.place('handoff', 0, RACK.units, 0).id;
    const core = s.buyDevice('sw-24', 0, 40).id!;
    const t1 = s.buyDevice('sw-24', 0, 38).id!;
    const t2 = s.buyDevice('sw-24', 0, 37).id!;
    wire(s, { device: isp, port: 0 }, { device: core, port: 0 });
    wire(s, { device: core, port: 1 }, { device: t1, port: 0 });
    wire(s, { device: core, port: 2 }, { device: t2, port: 0 });
    const srv = buy(s, 'db', 0, 20).id!;
    s.toggleRole(srv, 'blog:web');
    s.toggleRole(srv, 'blog:db');
    wire(s, { device: srv, port: 0 }, { device: t1, port: 1 });
    wire(s, { device: srv, port: 1 }, { device: t2, port: 1 });
    return { s, f, core, t1, t2, srv };
  }

  it('BGP なしのサーバは一番若いポートの 1 本だけ使い、その ToR が止まると届かなくなる', () => {
    const { s, t1, t2 } = dual();
    let flow = run(s);
    expect(flow.success).toBe(1);
    expect(flow.devices.get(t1)!.gbps).toBeGreaterThan(0);
    expect(flow.devices.get(t2)!.gbps).toBe(0);
    s.setMaintenance(t1, true);
    flow = run(s);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain('止まっています');
  });

  it('BGP を使うと 2 台の ToR に ECMP で半分ずつ流れ、片方が止まっても続く', () => {
    const { s, srv, t1, t2 } = dual(['bgp']);
    expect(s.setBgp(srv, true).ok).toBe(true);
    let flow = run(s);
    const a = flow.devices.get(t1)!.gbps;
    const b = flow.devices.get(t2)!.gbps;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeCloseTo(b, 6);
    s.setMaintenance(t1, true);
    flow = run(s);
    expect(flow.success).toBe(1);
    expect(flow.devices.get(t2)!.gbps).toBeCloseTo(a * 2, 6);
  });

  it('BGP は解放が必要で、ハイパーバイザは自動で使う', () => {
    const { s, srv } = dual();
    expect(s.setBgp(srv, true).ok).toBe(false);
    s.unlock('bgp');
    s.unlock('virtualization');
    expect(s.usesBgp(srv)).toBe(false);
    s.setHv(srv, true);
    expect(s.usesBgp(srv)).toBe(true);
  });

  it('障害は難易度で決まる: 機器が少ないうちは壊れず、増えると壊れてしばらくで直る。「平和」では壊れない', () => {
    // 標準: 最初の 4 台では壊れない
    const s = newGame();
    expect(s.difficulty).toBe('normal');
    s.step(120_000);
    expect(s.lastFailure).toBeNull();
    // 過酷: 5 台を超えると壊れ始め、直る
    const h = newGame('hard');
    h.money = RICH;
    for (let u = 1; u <= 6; u++) h.buyServer('1u-small', 0, u);
    h.step(600_000);
    expect(h.lastFailure).not.toBeNull();
    const repair = DIFFICULTY.levels.hard.failures!.repairSec * 1000;
    expect(h.facility.devices.get(h.lastFailure!.id)!.failedUntil).toBe(h.lastFailure!.at + repair);
    // 回線終端は壊れない
    expect([...h.facility.devices.values()].find((d) => d.model === 'handoff')!.failedUntil).toBe(0);
    // 平和に変えると、もう壊れない
    h.difficulty = 'peace';
    h.lastFailure = null;
    h.step(600_000);
    expect(h.lastFailure).toBeNull();
    // セーブに残る。難易度のない古いセーブは「平和」
    const save = createSave(newGame('hard'), 0);
    expect(loadSave(parseSave(JSON.parse(JSON.stringify(save)))!).difficulty).toBe('hard');
    const { difficulty: _d, ...old } = save;
    expect(parseSave(old)!.difficulty).toBe('peace');
  });
});
