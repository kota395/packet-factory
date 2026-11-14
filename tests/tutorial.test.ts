import { describe, expect, it } from 'vitest';
import { START_MONEY } from '../src/sim/pricing';
import { newGame, tutorialGame } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { run } from './helpers';

describe('チュートリアル', () => {
  it('チュートリアルで作る構成は、スキップしたときの最初の構成と同じになる', () => {
    const s = tutorialGame();
    const f = s.facility;
    const web = s.buyServer('1u-small', 0, 38).id!;
    expect(s.toggleRole(web, 'blog:web').ok).toBe(true);
    const db = s.buyServer('2u-hdd-small', 0, 35).id!;
    expect(s.toggleRole(db, 'blog:db').ok).toBe(true);
    expect(s.changeParts(db, { kind: 'mem', dir: 1 }).ok).toBe(true);
    // 配線は自動
    expect(f.cablesOf(web).length && f.cablesOf(db).length).toBeTruthy();
    const skip = newGame();
    const servers = (x: Simulation) =>
      [...x.facility.devices.values()].filter((d) => d.parts).map((d) => [d.model, d.parts, d.roles]);
    expect(servers(s)).toEqual(servers(skip));
    // チュートリアルで渡したお金は、使い切るとほぼ最初の資金に戻る
    expect(s.money).toBeGreaterThanOrEqual(START_MONEY);
    expect(s.money).toBeLessThan(START_MONEY + 10);
    expect(run(s, 1000).success).toBe(1);
  });
});
