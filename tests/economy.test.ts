import { describe, expect, it } from 'vitest';
import { PRESET_BY_ID } from '../src/sim/catalog';
import { RACK } from '../src/sim/config';
import { upgradeCost } from '../src/sim/economy';
import { CHASSIS_PRICES, CPU_PRICES, DRIVE_PRICES, MARKETING_REVENUE, MEMORY_PRICE_PER_GB, MODEL_PRICES, PRICE_SCALE, START_MONEY, UNLOCK_PRICES } from '../src/sim/pricing';
import { newGame } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { constant, RICH, run, base } from './helpers';

describe('経済', () => {
  it('広告は、売上が大きいほど高くなる(最初の数レベルは定価のまま)', () => {
    const { s, server } = base({ pv: 200 });
    server('small', 30, ['blog:web']);
    server('db', 20, ['blog:db']);
    run(s, 20_000);
    const revenue = s.metrics.rolling.revenuePerSec;
    expect(revenue).toBeGreaterThan(0);
    // 定価だけ
    expect(s.upgradeCost('marketing')).toBe(upgradeCost('marketing', 0));
    // レベルが上がると、売上 × 秒数 ×(次のレベル − freeLevels)が定価を上回る
    const level = MARKETING_REVENUE.freeLevels + 2;
    const t = new Simulation({ startMoney: RICH, traffic: constant(200), upgrades: { marketing: level, monetize: 10, uplink: 2, rackPower: 3 } });
    t.facility.rent(0);
    t.facility.place('handoff', 0, RACK.units, 0);
    t.buyDevice('sw-24', 0, 40);
    const web = t.buyServer('1u-web', 0, 30).id!;
    const db = t.buyServer('2u-ssd', 0, 20).id!;
    t.toggleRole(web, 'blog:web');
    t.toggleRole(db, 'blog:db');
    run(t, 20_000);
    const want = Math.round(t.metrics.rolling.revenuePerSec * MARKETING_REVENUE.secPerLevel * 3);
    expect(want).toBeGreaterThan(upgradeCost('marketing', level));
    expect(t.upgradeCost('marketing')).toBe(want);
  });

  it('最初の資金と、解放・機器の価格は pricing.ts の値で決まる', () => {
    expect(new Simulation().money).toBe(START_MONEY);
    const s = new Simulation({ startMoney: RICH });
    s.facility.rent(0);
    const before = s.money;
    s.buyDevice('sw-48', 0, 1);
    expect(s.money).toBe(before); // 10G 機器を解放していない
    s.buyDevice('sw-24', 0, 1);
    expect(before - s.money).toBe(MODEL_PRICES['sw-24'].first * PRICE_SCALE);
    const b2 = s.money;
    s.buyServer('1u-web', 0, 2);
    const p = PRESET_BY_ID['1u-web'].parts;
    expect(b2 - s.money).toBe(
      (CHASSIS_PRICES['srv-1u'] + CPU_PRICES[p.cpu] + p.memGB * MEMORY_PRICE_PER_GB + 2 * DRIVE_PRICES.ssd) * PRICE_SCALE,
    );
    const m = s.money;
    s.unlock('lb');
    expect(m - s.money).toBe(UNLOCK_PRICES.lb * PRICE_SCALE);
  });

  it('回線契約・電力契約は上限まで上げられ、維持費も上がる', () => {
    const s = new Simulation({ startMoney: RICH });
    s.facility.rent(0);
    const u0 = s.upkeepPerSec;
    expect(s.uplinkGbps).toBe(0.1);
    s.buyUpgrade('uplink');
    s.buyUpgrade('uplink');
    expect(s.uplinkGbps).toBe(10);
    expect(s.buyUpgrade('uplink').ok).toBe(false);
    expect(s.upkeepPerSec).toBeGreaterThan(u0);
    expect(s.rackPowerW).toBe(RACK.powerLevelsW[0]);
  });

  it('ユーザーは市場規模に向かって増え、エラーが多いと減る', () => {
    const s = newGame();
    const u0 = s.users;
    s.step(30_000);
    expect(s.users).toBeGreaterThan(u0);
    // スイッチを止めると全部エラーになり、離脱する
    s.setMaintenance([...s.facility.devices.values()].find((d) => d.model === 'sw-24')!.id, true);
    const u1 = s.users;
    s.step(30_000);
    expect(s.users).toBeLessThan(u1);
  });
});
