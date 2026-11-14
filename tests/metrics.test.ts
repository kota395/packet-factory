import { describe, expect, it } from 'vitest';
import { specOf } from '../src/sim/catalog';
import { METRICS } from '../src/sim/config';
import { forecastSeries, logistic, secondsUntil } from '../src/sim/forecast';
import { createSave, loadSave, newGame, parseSave } from '../src/sim/save';

describe('メトリクスと需要予測', () => {
  it('キャパシティは今の構成で捌けるページビュー/秒(最初は db の HDD のディスク IO で決まる)', () => {
    const s = newGame();
    const cap = s.estimateCapacity();
    // HDD 2 本(ミラー)の IOPS ÷(3 回の読み込みのうちメモリに乗らない分)
    const db = [...s.facility.devices.values()].find((d) => d.model === 'srv-2u')!;
    const miss = s.flow.nodeLoads.get(db.id)!.miss['blog:db']!;
    const expected = specOf(db).diskIops / (3 * miss);
    expect(cap).toBeGreaterThan(expected * 0.95);
    expect(cap).toBeLessThan(expected * 1.05);
    // 見積もりのあとも、今の流量の計算は元のまま
    expect(s.flow.pv).toBeCloseTo(s.trafficAt(s.time), 6);
  });

  it('ロジスティック成長の予測と、ある量に届くまでの時間', () => {
    expect(logistic(100, 1000, 0.03, 0)).toBeCloseTo(100);
    expect(logistic(100, 1000, 0.03, 10_000)).toBeCloseTo(1000, 0);
    const t = secondsUntil(100, 1000, 0.03, 500)!;
    expect(logistic(100, 1000, 0.03, t)).toBeCloseTo(500, 3);
    expect(secondsUntil(100, 1000, 0.03, 1000)).toBeNull();
    expect(secondsUntil(600, 1000, 0.03, 500)).toBe(0);
    const [ts, us] = forecastSeries(100, 1000, 0.03, 60, 10);
    expect(ts).toHaveLength(7);
    expect(us[6]).toBeGreaterThan(us[0]);
  });

  it('推移には 1 秒ごとの値と、資源ごとの使用率が残る', () => {
    const s = newGame();
    s.step(10_000);
    const h = s.metrics.history;
    expect(h.t.length).toBe(10);
    expect(h.capacity.at(-1)).toBeGreaterThan(0);
    const io = [...s.metrics.resources.values()].find((r) => r.label === 'srv02 ディスク');
    expect(io?.rho.length).toBe(10);
    // 市場規模(1,500 人 = 15 PV/秒)ではキャパシティに届かない。広告で市場を広げると届く
    expect(s.secondsToSaturation()).toBeNull();
    s.upgrades.marketing = 8;
    expect(s.secondsToSaturation()).toBeGreaterThan(0);
  });
});

describe('メトリクスの保存', () => {
  it('推移を間引いて保存し、読み込むと過去の分として続きに記録される', () => {
    const a = newGame('peace');
    a.step(125_000);
    const saved = JSON.parse(JSON.stringify(a.metrics.exportHistory()));
    expect(saved.total.t.length).toBe(Math.ceil(125 / METRICS.saveEverySec));
    expect(saved.total.t.at(-1)).toBe(0);
    const b = loadSave(parseSave(JSON.parse(JSON.stringify(createSave(a, 0))))!);
    expect(b.metrics.importHistory(saved)).toBe(true);
    expect(b.metrics.history.users.at(-1)).toBeCloseTo(a.metrics.history.users.at(-1)!, -1);
    b.step(3000);
    const t = b.metrics.history.t;
    expect(t.at(-1)).toBe(3);
    expect(t[0]).toBeLessThan(-100);
    expect(b.metrics.services.get('blog')!.pv.length).toBe(t.length);
    // 壊れたデータは無視する
    expect(newGame().metrics.importHistory({ total: { t: [0, 1], pv: [1] } })).toBe(false);
    expect(newGame().metrics.importHistory(null)).toBe(false);
  });
});
