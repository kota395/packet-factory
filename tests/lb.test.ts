import { describe, expect, it } from 'vitest';
import { RACK } from '../src/sim/config';
import { lbGroups } from '../src/sim/flow';
import { Simulation } from '../src/sim/simulation';
import { constant, RICH } from './helpers';

describe('LB 10G', () => {
  it('10G の LB は 10G のポートを持つスイッチに 10G でつながり、帯域の上限が上がる', () => {
    const s = new Simulation({ startMoney: RICH, traffic: constant(10), unlocks: ['lb', 'tenGig'], upgrades: { rackPower: 3, uplink: 2 } });
    const f = s.facility;
    f.rent(0);
    f.place('handoff', 0, RACK.units, 0);
    const sw = s.buyDevice('sw-48', 0, 40).id!;
    const lb1 = s.buyDevice('lb-1u', 0, 30).id!;
    const lb10 = s.buyDevice('lb-10g', 0, 28).id!;
    const cap = (id: number) =>
      f
        .cablesOf(id)
        .filter((c) => f.otherEnd(c, id).device === sw)
        .reduce((sum, c) => sum + Math.min(f.portDef(c.a)!.speedGbps, f.portDef(c.b)!.speedGbps), 0);
    expect(cap(lb1)).toBe(4);
    // sw-48 の 10G は 4 ポート。回線が 1 本使うので、LB には 3 本
    expect(cap(lb10)).toBeGreaterThanOrEqual(30);
  });

  it('自動配線の HA ペアは同じ機種の LB どうしで組まれる', () => {
    const s = new Simulation({ startMoney: RICH, traffic: constant(10), unlocks: ['lb', 'tenGig'], upgrades: { rackPower: 3, uplink: 2 } });
    const f = s.facility;
    f.rent(0);
    f.place('handoff', 0, RACK.units, 0);
    s.buyDevice('sw-48', 0, 40);
    const g1a = s.buyDevice('lb-1u', 0, 30).id!;
    const g10a = s.buyDevice('lb-10g', 0, 28).id!;
    // 機種が違う 2 台はペアにならず、両方アクティブのまま
    expect(lbGroups(f, new Set())).toEqual([
      { members: [g1a], active: g1a },
      { members: [g10a], active: g10a },
    ]);
    // 同じ機種を足すと、それぞれ同機種どうしで HA ペアになる
    const g1b = s.buyDevice('lb-1u', 0, 26).id!;
    const g10b = s.buyDevice('lb-10g', 0, 24).id!;
    expect(lbGroups(f, new Set())).toEqual([
      { members: [g1a, g1b], active: g1a },
      { members: [g10a, g10b], active: g10a },
    ]);
  });
});
