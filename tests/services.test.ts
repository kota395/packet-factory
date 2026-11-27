import { describe, expect, it } from 'vitest';
import { PRESET_BY_ID } from '../src/sim/catalog';
import { CAMPAIGN, SERVICES, WORK } from '../src/sim/config';
import { computeFlow } from '../src/sim/flow';
import { createSave, loadSave, newGame, parseSave } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { RICH, run, base, wire } from './helpers';

describe('複数のサービス', () => {
  it('サービスの役割は、そのサービスを始めるまで付けられない', () => {
    const { s, server } = base();
    const srv = server('small', 30, []);
    expect(s.toggleRole(srv, 'shop:web').ok).toBe(false);
    expect(s.toggleRole(srv, 'blog:search').ok).toBe(false); // ブログに検索はない
    s.unlock('shop');
    expect(s.toggleRole(srv, 'shop:web').ok).toBe(true);
    expect(s.toggleRole(srv, 'shop:search').ok).toBe(true);
    expect(s.toggleRole(srv, 'photo:media').ok).toBe(false);
  });

  it('同じサーバに相乗りさせると負荷が合算され、分ければ別々になる', () => {
    const { s, server } = base({ traffic: { blog: 20, shop: 20 }, unlocks: ['shop'] });
    const a = server('db', 10, ['blog:web', 'blog:db', 'shop:web', 'shop:db']);
    const shared = run(s);
    expect(shared.services.blog!.success).toBe(1);
    expect(shared.services.shop!.success).toBe(1);
    const both = shared.devices.get(a)!.cpu;
    // ショッピングを別のサーバへ
    const b = server('db', 20, ['shop:web', 'shop:db']);
    s.toggleRole(a, 'shop:web');
    s.toggleRole(a, 'shop:db');
    const split = run(s);
    expect(split.devices.get(a)!.cpu).toBeLessThan(both);
    expect(split.devices.get(b)!.cpu).toBeGreaterThan(0);
    expect(split.services.shop!.instances.web).toEqual([b]);
  });

  it('検索サーバがなければ db が検索を肩代わりし、search を置くと db が軽くなる', () => {
    const { s, server } = base({ traffic: { blog: 0, shop: 30 }, unlocks: ['shop'] });
    server('small', 30, ['shop:web']);
    const db = server('db', 20, ['shop:db']);
    const before = run(s);
    expect(before.problems.join()).toContain('search');
    const dbCpu = before.devices.get(db)!.cpu;
    const search = server('web', 28, ['shop:search']);
    const after = run(s);
    expect(after.devices.get(db)!.cpu).toBeLessThan(dbCpu * 0.5);
    expect(after.nodeLoads.get(search)!.work['shop:search']).toBeCloseTo(30 * SERVICES.shop.work.search!.perPv, 1);
  });

  it('写真共有: media・worker がなければ web が肩代わりし、置けばそちらへ流れる', () => {
    const { s, server } = base({ traffic: { blog: 0, photo: 10 }, unlocks: ['shop', 'photo'] });
    const web = server('db', 10, ['photo:web', 'photo:db']);
    const before = run(s);
    expect(before.services.photo!.success).toBe(1);
    expect(before.nodeLoads.get(web)!.work['photo:web']).toBeGreaterThan(10);
    const media = server('db', 20, ['photo:media']);
    const worker = server('web', 30, ['photo:worker']);
    const after = run(s);
    const w = SERVICES.photo.work;
    expect(after.nodeLoads.get(worker)!.work['photo:worker']).toBeCloseTo(10 * w.upload!.perPv, 3);
    expect(after.nodeLoads.get(media)!.work['photo:media']).toBeCloseTo(10 * w.media!.perPv, 1);
    expect(after.nodeLoads.get(media)!.ioOps).toBeGreaterThan(0);
    expect(after.problems.join()).not.toContain('肩代わり');
  });

  it('キャンペーン: 払うとすぐ訪問が増え、終わるとクールタイム', () => {
    const s = new Simulation({ startMoney: RICH, unlocks: ['shop'], startUsers: { shop: 1000 } });
    const pv0 = s.trafficOf('shop', s.time);
    const money = s.money;
    expect(s.startCampaign().ok).toBe(true);
    expect(money - s.money).toBe(s.campaignPrice());
    expect(s.trafficOf('shop', s.time)).toBeCloseTo(pv0 * CAMPAIGN.trafficMul, 6);
    expect(s.startCampaign().ok).toBe(false);
    s.step(CAMPAIGN.durationSec * 1000 + 200);
    expect(s.campaignActive).toBe(false);
    expect(s.campaignError()).toContain('あと');
    s.step(CAMPAIGN.cooldownSec * 1000);
    expect(s.campaignError()).toBeNull();
  });

  it('キャパシティはサービスごとにも見積もる', () => {
    const { s, server } = base({ traffic: { blog: 10, shop: 10 }, unlocks: ['shop'] });
    server('db', 10, ['blog:web', 'blog:db']);
    server('small', 20, ['shop:web', 'shop:db']);
    s.estimateCapacity();
    expect(s.capacityOf('blog')).toBeGreaterThan(s.capacityOf('shop'));
    expect(s.capacityOf('photo')).toBe(0);
    expect(s.capacityPv).toBeGreaterThan(20);
  });

  it('機種固定だったころ(v4)のサーバは、近い構成のシャーシに移して読み込む', () => {
    const v5 = createSave(newGame(), 1000);
    const v4 = {
      ...v5,
      v: 4,
      devices: v5.devices.map((d) => {
        const old = d.slice(0, 11);
        if (d[1] === 'srv-1u') old[1] = 'srv-1u-e';
        if (d[1] === 'srv-2u') old[1] = 'srv-2u-hv';
        return old;
      }),
    };
    const parsed = parseSave(v4)!;
    expect(parsed.devices.map((d) => d[1])).toEqual(['handoff', 'sw-24', 'srv-1u', 'srv-2u']);
    expect(parsed.devices[2][11]).toEqual(PRESET_BY_ID['1u-small'].parts);
    expect(parsed.devices[3][11]!.nic).toBe('sfp10');
    expect(loadSave(parsed).flow.services.blog!.success).toBe(1);
  });

  it('v3(ブログだけの版)のセーブは、役割をブログのものとして読み込む', () => {
    const v4 = createSave(newGame(), 1000);
    const v3 = {
      ...v4,
      v: 3,
      users: 500,
      devices: v4.devices.map((d) => [...d.slice(0, 4), d[4].map((r) => r.split(':')[1]), ...d.slice(5)]),
    };
    const parsed = parseSave(v3)!;
    expect(parsed.v).toBe(5);
    expect(parsed.users.blog).toBe(500);
    expect(parsed.devices.flatMap((d) => d[4])).toEqual(['blog:web', 'blog:db']);
    expect(loadSave(parsed).flow.services.blog!.success).toBe(1);
  });

  it('投稿の DB 書き込みが失敗率と応答時間に反映される', () => {
    const { s, sw, server } = base({
      traffic: { blog: 0, photo: 200 },
      unlocks: ['shop', 'photo', 'replication', 'tenGig', 'agg'],
    });
    // 回線・スイッチを 10G にしてネットワーク詰まりを避ける
    s.facility.clearCables();
    const agg = s.buyDevice('agg-10g', 0, 38).id!;
    const isp = [...s.facility.devices.values()].find((d) => d.model === 'handoff')!.id;
    wire(s, { device: isp, port: 0 }, { device: agg, port: 0 });
    const web = server('big', 30, ['photo:web'], 0, -1);
    const worker = server('big', 26, ['photo:worker'], 0, -1);
    const media = server('big', 22, ['photo:media'], 0, -1);
    const replica = server('big', 18, ['photo:replica'], 0, -1);
    // プライマリだけ HDD 2 本(150 IOPS)にして書き込みで溢れさせる
    const db = s.buyDevice('srv-2u', 0, 14, { cpu: 8, memGB: 64, backplane: 'lff', drives: ['hdd', 'hdd'], nic: 'sfp10' }).id!;
    s.toggleRole(db, 'photo:db');
    for (const [i, id] of [web, worker, media, replica, db].entries()) {
      wire(s, { device: id, port: 2 }, { device: agg, port: i + 1 });
    }
    expect(sw).toBeGreaterThan(0);

    // 読み込みはすべてレプリカが捌き、プライマリは投稿の書き込みだけで溢れる構成(worker は余裕あり)
    const uploadOnlyWork = { ...SERVICES.photo.work, dbWrites: 0, upload: { ...SERVICES.photo.work.upload!, perPv: 0.4, workerCpuMs: 10 } };
    const noUploadWork = { ...SERVICES.photo.work, dbWrites: 0, upload: undefined };
    const flowWithUpload = computeFlow(s.facility, {
      services: [{ id: 'photo', pv: 200, work: uploadOnlyWork }],
      uplinkGbps: 10,
      roles: s.availableRoles,
      now: 0,
      bgp: false,
      down: new Set(),
    });
    const dbIo = flowWithUpload.devices.get(db)!.io;
    expect(dbIo).toBeGreaterThan(1);
    expect(flowWithUpload.devices.get(worker)!.cpu).toBeLessThan(1);
    const writeOk = 1 / dbIo;
    // 投稿の 40% がプライマリ書き込み失敗の影響を受ける
    expect(flowWithUpload.services.photo!.success).toBeCloseTo(1 - 0.4 * (1 - writeOk), 4);

    // 軽い負荷でも投稿の DB 書き込み分だけ応答時間が増える
    const lowUpload = computeFlow(s.facility, {
      services: [{ id: 'photo', pv: 1, work: uploadOnlyWork }],
      uplinkGbps: 10,
      roles: s.availableRoles,
      now: 0,
      bgp: false,
      down: new Set(),
    });
    const lowNoUpload = computeFlow(s.facility, {
      services: [{ id: 'photo', pv: 1, work: noUploadWork }],
      uplinkGbps: 10,
      roles: s.availableRoles,
      now: 0,
      bgp: false,
      down: new Set(),
    });
    expect(lowUpload.services.photo!.latencyMs).toBeGreaterThan(lowNoUpload.services.photo!.latencyMs + 1);
  });

  it('media を web が肩代わりするとき、同居する db とキャッシュメモリを分け合う', () => {
    const { s, server } = base({ traffic: { blog: 0, photo: 10 }, unlocks: ['shop', 'photo'] });
    // 64GB のサーバに photo:web(1GB) と photo:db(1GB) → 残り 62GB を 2 つで分け合って 31GB ずつ
    const srv = server('db', 10, ['photo:web', 'photo:db']);
    const shared = run(s);
    expect(shared.nodeLoads.get(srv)!.miss['photo:db']).toBeCloseTo(WORK.dbMissPerGB / 31, 6);
    expect(shared.nodeLoads.get(srv)!.miss['photo:web']).toBeCloseTo(SERVICES.photo.work.media!.missPerGB / 31, 6);
    // 専用の media を置くと web は肩代わりしなくなり、db が 62GB すべて使える
    server('db', 20, ['photo:media']);
    const dedicated = run(s);
    expect(dedicated.nodeLoads.get(srv)!.miss['photo:db']).toBeCloseTo(WORK.dbMissPerGB / 62, 6);
  });
});
