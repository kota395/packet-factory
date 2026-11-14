import { describe, expect, it } from 'vitest';
import { PRESET_BY_ID, specOf } from '../src/sim/catalog';
import { RACK, WIRING } from '../src/sim/config';
import { lbGroups } from '../src/sim/flow';
import { serverPrice } from '../src/sim/pricing';
import { Simulation } from '../src/sim/simulation';
import { constant, RICH, run, base, buy, SERVERS } from './helpers';

describe('物理層', () => {
  it('U が重なる場所やラックの外には置けない', () => {
    const { s } = base();
    expect(buy(s, 'small', 0, 40).ok).toBe(false); // スイッチがいる
    expect(buy(s, 'db', 0, 42).ok).toBe(false); // 43U にはみ出す
    expect(buy(s, 'small', 1, 10).ok).toBe(false); // 借りていないラック
    expect(buy(s, 'db', 0, 10).ok).toBe(true);
    expect(buy(s, 'small', 0, 11).ok).toBe(false); // 2U の上側
  });

  it('ラックの電力の上限を超えては置けない', () => {
    const s = new Simulation({ startMoney: RICH });
    s.facility.rent(0);
    // 2000W に収まる台数までは置ける
    const w = specOf({ model: 'srv-2u', parts: PRESET_BY_ID['2u-ssd'].parts }).powerW;
    const fits = Math.floor(RACK.powerLevelsW[0] / w);
    for (let i = 0; i < fits; i++) expect(s.buyServer('2u-ssd', 0, 1 + i * 2).ok).toBe(true);
    const r = s.buyServer('2u-ssd', 0, 1 + fits * 2);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('電力');
    // 電力契約を上げれば置ける
    expect(s.buyUpgrade('rackPower').ok).toBe(true);
    expect(s.buyServer('2u-ssd', 0, 1 + fits * 2).ok).toBe(true);
  });

  it('自動配線: 置くだけで同じラックのスイッチにつながり、ポートが埋まるとつながらない', () => {
    const s = new Simulation({ startMoney: RICH, traffic: constant(10), upgrades: { rackPower: 3 } });
    const f = s.facility;
    f.rent(0);
    const isp = f.place('handoff', 0, RACK.units, 0).id;
    const sw = s.buyDevice('sw-24', 0, 40).id!;
    const peers = (id: number) => f.cablesOf(id).map((c) => f.otherEnd(c, id).device);
    expect(peers(isp)).toEqual([sw]);
    const a = s.buyServer('1u-small', 0, 30).id!;
    s.toggleRole(a, 'blog:web');
    s.toggleRole(a, 'blog:db');
    // サーバは 2 本(束ねて 1 本のリンク)
    expect(peers(a)).toEqual([sw, sw]);
    expect(run(s, 1000).success).toBe(1);
    // 24 ポート: 回線 1 + サーバ 2 本ずつ。12 台目は 1 本、13 台目はつながらない
    const ids: number[] = [a];
    for (let u = 1; u <= 12; u++) ids.push(s.buyServer('1u-small', 0, u).id!);
    expect(peers(ids[11])).toHaveLength(1);
    expect(peers(ids[12])).toHaveLength(0);
    expect(f.unwired.has(ids[12])).toBe(true);
    expect(run(s, 1000).problems.join()).toContain('つながっていません');
    // 売るとポートが空いて、つながる
    s.sellDevice(ids[1]);
    expect(peers(ids[12]).length).toBeGreaterThan(0);
  });

  it('自動配線: 10G の LB は別のラックのコアにつながり、ToR のアップリンクはどのコアにも同じ本数', () => {
    const s = new Simulation({ startMoney: RICH, traffic: constant(10), unlocks: ['tenGig', 'agg', 'lb'], upgrades: { rackPower: 3, uplink: 2 } });
    const f = s.facility;
    f.rent(0);
    f.rent(1);
    f.place('handoff', 0, RACK.units, 0);
    const peers = (id: number) =>
      f
        .cablesOf(id)
        .map((c) => f.otherEnd(c, id).device)
        .sort((x, y) => x - y);
    const speeds = (id: number) =>
      f
        .cablesOf(id)
        .filter((c) => f.portDef(c.a)!.label !== 'HA')
        .map((c) => Math.min(f.portDef(c.a)!.speedGbps, f.portDef(c.b)!.speedGbps));
    const agg1 = s.buyDevice('agg-10g', 0, 38).id!;
    const tor = s.buyDevice('sw-48', 1, 40).id!;
    // ラック 2 の ToR の 10G のポートは 2 本しか残っていないが、LB はラック 1 の集約スイッチにも届くので 4 本とも 10G
    const lb = s.buyDevice('lb-10g', 1, 30).id!;
    expect(peers(lb)).toContain(agg1);
    expect(speeds(lb)).toEqual([10, 10, 10, 10]);
    // 1G の LB は、同じラックの ToR の 1G のポートへ(10G のポートを潰さない)
    const old = s.buyDevice('lb-1u', 1, 28).id!;
    expect(
      peers(old)
        .filter((x) => x !== lb)
        .every((x) => x === tor),
    ).toBe(true);
    // 集約スイッチ 3 台: sw-48 の 10G は 4 ポートなので、1 本ずつ(2・1・1 にはしない)
    const agg2 = s.buyDevice('agg-10g', 0, 36).id!;
    const agg3 = s.buyDevice('agg-10g', 0, 34).id!;
    for (const a of [agg1, agg2, agg3]) expect(peers(tor).filter((x) => x === a)).toHaveLength(1);
    expect(speeds(tor).filter((g) => g === 10).length).toBeGreaterThanOrEqual(3);
  });

  it('自動配線: ToR はコアへ、サーバは同じラックの ToR へ。ToR が 2 台なら分けてつなぎ、LB は 2 台で HA', () => {
    const s = new Simulation({ startMoney: RICH, traffic: constant(10), unlocks: ['tenGig', 'agg', 'lb', 'bgp'], upgrades: { rackPower: 3, uplink: 2 } });
    const f = s.facility;
    f.rent(0);
    f.rent(1);
    const isp = f.place('handoff', 0, RACK.units, 0).id;
    const sw1 = s.buyDevice('sw-24', 0, 40).id!;
    const peers = (id: number) =>
      f
        .cablesOf(id)
        .map((c) => f.otherEnd(c, id).device)
        .sort((x, y) => x - y);
    // 10G のポートを持つスイッチを置くと、それがコアになる: 回線は 10G で受け、ほかのスイッチは決まった本数ずつつなぐ
    const t1 = s.buyDevice('sw-48', 1, 40).id!;
    const t2 = s.buyDevice('sw-48', 1, 39).id!;
    expect(peers(isp)).toEqual([t1]);
    expect(f.portDef(f.otherEnd(f.cablesOf(isp)[0], isp))!.speedGbps).toBe(10);
    expect(peers(sw1)).toEqual(Array.from({ length: WIRING.uplinksPerCore }, () => t1));
    expect(peers(t2).filter((x) => x === t1).length).toBeGreaterThan(0);
    const srv = s.buyServer('2u-ssd', 1, 20).id!;
    expect(peers(srv)).toEqual([t1, t2]);
    // 集約スイッチを置くと、コアが替わる: 回線も ToR も集約スイッチへ(10G のポートで)
    const agg = s.buyDevice('agg-10g', 0, 38).id!;
    expect(peers(isp)).toEqual([agg]);
    expect(peers(t1).filter((x) => x === agg)).toHaveLength(WIRING.uplinksPerCore);
    expect(peers(sw1).filter((x) => x === agg)).toHaveLength(WIRING.uplinksPerCore);
    const up = f.cablesOf(t1).find((c) => f.otherEnd(c, t1).device === agg)!;
    expect(f.portDef(up.a)!.speedGbps).toBe(10);
    expect(f.portDef(up.b)!.speedGbps).toBe(10);
    // BGP を使うサーバは 2 台の ToR に分かれて流れ、片方を止めても続く
    s.toggleRole(srv, 'blog:web');
    s.toggleRole(srv, 'blog:db');
    s.setBgp(srv, true);
    expect(run(s, 1000).success).toBe(1);
    s.setMaintenance(t1, true);
    expect(run(s, 1000).success).toBe(1);
    // LB は置いた順に 2 台ずつ HA
    const l1 = s.buyDevice('lb-1u', 1, 30).id!;
    expect(lbGroups(f, new Set())[0].members).toEqual([l1]);
    const l2 = s.buyDevice('lb-1u', 1, 31).id!;
    expect(lbGroups(f, new Set())[0].members).toEqual([l1, l2]);
  });

  it('機器を売ると半額が戻り、つながっていたケーブルも外れる', () => {
    const { s, f, server } = base();
    const id = server('small', 30, ['blog:web']);
    const before = s.money;
    const r = s.sellDevice(id);
    expect(r.ok).toBe(true);
    expect(s.money).toBe(before + Math.floor(serverPrice('srv-1u', SERVERS.small.parts) / 2));
    expect([...f.cables.values()].some((c) => c.a.device === id || c.b.device === id)).toBe(false);
  });

  it('解放していない機種や役割は使えない', () => {
    const { s, server } = base();
    expect(s.buyDevice('agg-10g', 0, 20).ok).toBe(false);
    const id = server('small', 30, ['blog:web']);
    expect(s.toggleRole(id, 'blog:cache').ok).toBe(false);
    expect(s.toggleRole(s.facility.devices.values().next().value!.id, 'blog:web').ok).toBe(false); // 回線終端
  });
});
