import { describe, expect, it } from 'vitest';
import { MODEL_BY_ID, PRESETS, isServerModel, partsError } from '../src/sim/catalog';
import { PV_PER_USER } from '../src/sim/config';
import { UPGRADE_BY_ID } from '../src/sim/economy';
import { UPKEEP } from '../src/sim/pricing';
import { applyAbsence, createSave, decodeSave, encodeSave, loadSave, newGame, parseSave } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { base } from './helpers';

describe('セーブ', () => {
  it('保存 → 文字列化 → 復元で同じ構成になる', () => {
    const { s, server } = base({ unlocks: ['lb', 'slb'] });
    server('db', 20, ['blog:db']);
    server('small', 30, ['blog:web', 'blog:lb']);
    s.step(2000);
    const save = createSave(s, 1000);
    const decoded = decodeSave(encodeSave(save));
    expect(decoded).toEqual(save);
    const b = loadSave(decoded!);
    expect(createSave(b, 1000)).toEqual({ ...save, incomePerSec: createSave(b, 1000).incomePerSec });
    expect(b.flow.success).toBe(s.flow.success);
  });

  it('壊れたデータや古い版は null になる', () => {
    const save = createSave(newGame(), 1000);
    expect(parseSave({ ...save, v: 2 })).toBeNull();
    expect(parseSave({ ...save, devices: [[1, 'nope', 0, 1, [], 0, 'x']] })).toBeNull();
    // 昔のセーブにあるケーブルは読み飛ばす(自動配線で引き直す)
    expect(parseSave({ ...save, cables: [[1, 1, 99, 2, 0, 0]] })).toEqual(save);
    expect(decodeSave('not-base64!!')).toBeNull();
    expect(parseSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });

  it('セーブの機器名・VM 名に HTML が紛れていれば捨てて付け直す', () => {
    const baseSim = newGame();
    baseSim.unlocks.add('virtualization');
    const srv = [...baseSim.facility.devices.values()].find((d) => d.model === 'srv-2u')!;
    baseSim.facility.setRoles(srv.id, []);
    baseSim.facility.setHv(srv.id, true);
    baseSim.facility.createVm(srv.id, 's');
    const save = createSave(baseSim, 1000);
    const bad = '<img src=x onerror=alert(1)>';
    const tampered = {
      ...save,
      devices: save.devices.map((d) => (d[1] === 'srv-1u' ? [d[0], d[1], d[2], d[3], d[4], d[5], bad, d[7], d[8], d[9], d[10], d[11]] : d)),
      vms: save.vms.map((v) => [v[0], bad, v[2], v[3], v[4], v[5], v[6]]),
    };
    const parsed = parseSave(tampered)!;
    expect(parsed).not.toBeNull();
    expect(parsed.devices.every((d) => !d[6].includes('<'))).toBe(true);
    expect(parsed.vms.every((v) => !v[1].includes('<'))).toBe(true);
    const loaded = loadSave(parsed);
    const loadedSrv = [...loaded.facility.devices.values()].find((d) => d.model === 'srv-1u')!;
    const loadedVm = [...loaded.facility.vms.values()][0]!;
    expect(loadedSrv.name).toMatch(/^srv\d+$/);
    expect(loadedVm.name).toMatch(/^vm\d+$/);
  });

  it('強化レベルが上限を超えていても最大レベルに収まり、維持費や資金が NaN にならない', () => {
    const save = createSave(newGame(), 1000);
    const parsed = parseSave({ ...save, upgrades: { ...save.upgrades, uplink: 99, rackPower: 99 } })!;
    expect(parsed).not.toBeNull();
    expect(parsed.upgrades.uplink).toBe(UPGRADE_BY_ID.uplink.maxLevel);
    expect(parsed.upgrades.rackPower).toBe(UPGRADE_BY_ID.rackPower.maxLevel);
    const direct = new Simulation({ upgrades: { uplink: 99, rackPower: 99 } });
    direct.facility.rent(0);
    expect(direct.upkeep.racks).toBe(UPKEEP.rackByPowerLevel.at(-1));
    expect(direct.upkeep.uplink).toBe(UPKEEP.uplinkByLevel.at(-1));
    direct.step(1000);
    expect(Number.isFinite(direct.money)).toBe(true);
  });

  it('離れていた間: 直前の収支の一定割合が入り、ユーザーは市場規模と捌ける量まで増える', () => {
    const s = newGame();
    expect(applyAbsence(s, 10_000, 2)).toEqual({ elapsedMs: 10_000, gained: 0, users: 0 });
    const money = s.money;
    const users = s.users;
    const a = applyAbsence(s, 100_000, 2);
    expect(a.gained).toBeCloseTo(2 * 100 * 0.5);
    expect(s.money).toBeCloseTo(money + a.gained);
    expect(s.users).toBeCloseTo(users + a.users);
    expect(a.users).toBeGreaterThan(0);
    // 長く離れても市場規模まで
    applyAbsence(s, 8 * 3600_000, 0);
    expect(s.users).toBeLessThanOrEqual(s.marketSize + 1e-6);
    expect(s.users).toBeGreaterThan(s.marketSize * 0.99);
    // 捌ける量(キャパシティ)より先へは増えない
    s.upgrades.marketing = 12;
    applyAbsence(s, 8 * 3600_000, 0);
    expect(s.users * PV_PER_USER).toBeLessThanOrEqual(s.capacityOf('blog') * 1.01);
    expect(s.users).toBeLessThan(s.marketSize / 2);
  });

  it('機種のデータが揃っている', () => {
    for (const p of PRESETS) expect(partsError(p.model, p.parts), p.id).toBeNull();
    for (const m of Object.values(MODEL_BY_ID)) {
      expect(m.u).toBeGreaterThan(0);
      if (m.category === 'server') expect(isServerModel(m.id)).toBe(true);
      if (m.category === 'switch') expect(m.fabricGbps).toBeGreaterThan(0);
    }
  });
});
