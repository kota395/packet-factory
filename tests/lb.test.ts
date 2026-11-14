import { describe, expect, it } from 'vitest';
import { RACK } from '../src/sim/config';
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
});
