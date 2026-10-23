import { describe, expect, it } from 'vitest';
import { MODEL_BY_ID } from '../src/sim/catalog';
import { BLOG, RACK } from '../src/sim/config';
import { createSave, decodeSave, encodeSave, loadSave, newGame, offlineEarnings, parseSave } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { MODEL_PRICES, PRICE_SCALE, START_MONEY, UNLOCK_PRICES, cablePrice } from '../src/sim/pricing';
import type { ModelId, RoleId, UnlockId } from '../src/sim/types';

const constant = (pv: number) => () => pv;
const RICH = 1_000_000;

/** 回線終端と ToR スイッチだけのラック 1 本 */
function base(opts: { pv?: number; unlocks?: UnlockId[]; uplink?: number } = {}) {
  const s = new Simulation({
    startMoney: RICH,
    traffic: constant(opts.pv ?? 10),
    unlocks: opts.unlocks,
    upgrades: { uplink: opts.uplink ?? 2, rackPower: 3 },
  });
  const f = s.facility;
  f.rent(0);
  const isp = f.place('handoff', 0, RACK.units, 0);
  const sw = s.buyDevice('sw-24', 0, 40).id!;
  expect(s.connect({ device: isp.id, port: 0 }, { device: sw, port: 0 }).ok).toBe(true);
  let nextPort = 1;
  /** サーバを買って役割を付け、ToR につなぐ */
  const server = (model: ModelId, u: number, roles: RoleId[], slot = 0, toSw = sw) => {
    const r = s.buyDevice(model, slot, u);
    expect(r.ok, r.message).toBe(true);
    for (const role of roles) expect(s.toggleRole(r.id!, role).ok).toBe(true);
    if (toSw === sw) expect(s.connect({ device: r.id!, port: 0 }, { device: sw, port: nextPort++ }).ok).toBe(true);
    return r.id!;
  };
  return { s, f, isp: isp.id, sw, server };
}

const run = (s: Simulation, ms = 5000) => {
  s.step(ms);
  return s.flow;
};

describe('物理層', () => {
  it('U が重なる場所やラックの外には置けない', () => {
    const { s } = base();
    expect(s.buyDevice('srv-1u-e', 0, 40).ok).toBe(false); // スイッチがいる
    expect(s.buyDevice('srv-2u-db', 0, 42).ok).toBe(false); // 43U にはみ出す
    expect(s.buyDevice('srv-1u-e', 1, 10).ok).toBe(false); // 借りていないラック
    expect(s.buyDevice('srv-2u-db', 0, 10).ok).toBe(true);
    expect(s.buyDevice('srv-1u-e', 0, 11).ok).toBe(false); // 2U の上側
  });

  it('ラックの電力の上限を超えては置けない', () => {
    const s = new Simulation({ startMoney: RICH });
    s.facility.rent(0);
    // 2000W に 450W の 2U を 4 台(1800W)までは置ける
    for (let i = 0; i < 4; i++) expect(s.buyDevice('srv-2u-db', 0, 1 + i * 2).ok).toBe(true);
    const r = s.buyDevice('srv-2u-db', 0, 20);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('電力');
    // 電力契約を上げれば置ける
    expect(s.buyUpgrade('rackPower').ok).toBe(true);
    expect(s.buyDevice('srv-2u-db', 0, 20).ok).toBe(true);
  });

  it('ポートには 1 本だけ。同じラック内は銅線、SFP が絡むと光ファイバで、ラック間は長くて高い', () => {
    const { s, f, sw } = base({ unlocks: ['tenGig', 'agg'] });
    const a = s.buyDevice('srv-1u-e', 0, 30).id!;
    expect(s.connect({ device: a, port: 0 }, { device: sw, port: 0 }).ok).toBe(false); // 回線が使用中
    const near = s.cableQuote({ device: a, port: 0 }, { device: sw, port: 5 });
    expect(near.fiber).toBe(false);
    s.facility.rent(3);
    const agg = s.buyDevice('agg-10g', 3, 40).id!;
    const far = s.cableQuote({ device: a, port: 1 }, { device: agg, port: 0 });
    expect(far.fiber).toBe(true);
    expect(far.meters).toBeGreaterThan(near.meters);
    expect(far.price).toBe(cablePrice(true, far.meters));
    expect(f.connectError({ device: a, port: 0 }, { device: a, port: 1 })).not.toBeNull();
  });

  it('機器を売ると半額が戻り、つながっていたケーブルも外れる', () => {
    const { s, f, server } = base();
    const id = server('srv-1u-e', 30, ['web']);
    const before = s.money;
    const r = s.sellDevice(id);
    expect(r.ok).toBe(true);
    expect(s.money).toBe(before + Math.floor((MODEL_PRICES['srv-1u-e'].first * PRICE_SCALE) / 2));
    expect([...f.cables.values()].some((c) => c.a.device === id || c.b.device === id)).toBe(false);
  });

  it('解放していない機種や役割は使えない', () => {
    const { s, server } = base();
    expect(s.buyDevice('agg-10g', 0, 20).ok).toBe(false);
    const id = server('srv-1u-e', 30, ['web']);
    expect(s.toggleRole(id, 'cache').ok).toBe(false);
    expect(s.toggleRole(s.facility.devices.values().next().value!.id, 'web').ok).toBe(false); // 回線終端
  });
});

describe('流量モデル', () => {
  it('最初の構成(web+db 同居 1 台)で、軽い流量ならすべて成功する', () => {
    const s = newGame();
    s.step(3000);
    expect(s.flow.success).toBe(1);
    expect(s.flow.problems).toEqual([]);
    expect(s.metrics.rolling.revenuePerSec).toBeGreaterThan(0);
  });

  it('db がない・回線から届かないとエラーになり、警告が出る', () => {
    const { s, server } = base();
    server('srv-1u-e', 30, ['web']);
    let flow = run(s);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain('db');
    // 別のスイッチにつながった web は回線から届かない
    const { s: s2, server: server2 } = base();
    const lonely = server2('srv-1u-e', 30, ['web', 'db'], 0, -1);
    flow = run(s2);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain(s2.facility.devices.get(lonely)!.name);
  });

  it('エントリー機の db はディスク IO で先に詰まり、メモリの多い DB 向け機種に移すと捌ける', () => {
    const pv = 80;
    const { s, server } = base({ pv });
    const small = server('srv-1u-e', 30, ['web', 'db']);
    let flow = run(s);
    expect(flow.devices.get(small)!.io).toBeGreaterThan(1);
    expect(flow.bottleneck!.label).toContain('ディスク IO');
    expect(flow.success).toBeLessThan(0.9);
    const big = server('srv-2u-db', 20, ['db']);
    s.toggleRole(small, 'db');
    flow = run(s);
    expect(flow.devices.get(big)!.io).toBeLessThan(0.5);
    expect(flow.success).toBeGreaterThan(0.99);
  });

  it('LB がないとインターネットから届くのは web 1 台だけ。LB を置くと並べた web に分散する', () => {
    const { s, server } = base({ pv: 150, unlocks: ['lb'] });
    server('srv-2u-db', 20, ['db']);
    const w1 = server('srv-1u-e', 30, ['web']);
    const w2 = server('srv-1u-e', 31, ['web']);
    let flow = run(s);
    expect(flow.nodeLoads.get(w2)!.work.web ?? 0).toBe(0);
    expect(flow.problems.join()).toContain('LB');
    server('srv-1u-e', 32, ['lb']);
    flow = run(s);
    expect(flow.nodeLoads.get(w1)!.work.web).toBeCloseTo(75, 0);
    expect(flow.nodeLoads.get(w2)!.work.web).toBeCloseTo(75, 0);
  });

  it('memcached があると db に行く読み込みが減る', () => {
    const { s, server } = base({ pv: 50, unlocks: ['cache'] });
    const db = server('srv-2u-db', 20, ['db']);
    server('srv-1u-d', 30, ['web']);
    const before = run(s).nodeLoads.get(db)!.work.db!;
    server('srv-1u-e', 31, ['cache']);
    const after = run(s).nodeLoads.get(db)!.work.db!;
    expect(after / before).toBeCloseTo(1 - BLOG.cacheHitRate, 1);
  });

  it('回線契約の速度を超えると溢れる。画像を載せると回線が先に詰まる', () => {
    const { s, server } = base({ pv: 100, uplink: 0 });
    server('srv-2u-db', 20, ['db']);
    server('srv-1u-d', 30, ['web']);
    const plain = run(s);
    expect(plain.success).toBeGreaterThan(0.99);
    // 100 PV/秒 × 180KB = 144 Mbps > 100 Mbps
    s.unlock('images');
    const heavy = run(s);
    expect(heavy.success).toBeLessThan(0.8);
    expect(heavy.bottleneck!.label).toContain('帯域');
  });

  it('ラック間の通信は ToR のアップリンクを通る。1G 1 本だと詰まり、2 本束ねると広がる', () => {
    // web はラック 0、db はラック 1。web→db の読み込み応答を大きくして帯域で詰まらせる
    const { s, sw, server } = base({ pv: 400, unlocks: ['images'] });
    s.facility.rent(1);
    const sw2 = s.buyDevice('sw-24', 1, 40).id!;
    const db = server('srv-2u-db', 20, ['db'], 1, -1);
    s.connect({ device: db, port: 0 }, { device: sw2, port: 1 });
    for (let i = 0; i < 3; i++) server('srv-1u-d', 30 + i, ['web']);
    s.connect({ device: sw, port: 20 }, { device: sw2, port: 20 });
    const one = run(s);
    const uplink = one.links.find((l) => (l.a === sw && l.b === sw2) || (l.a === sw2 && l.b === sw))!;
    expect(uplink.capacityGbps).toBe(1);
    s.connect({ device: sw, port: 21 }, { device: sw2, port: 21 });
    const two = run(s);
    const lag = two.links.find((l) => (l.a === sw && l.b === sw2) || (l.a === sw2 && l.b === sw))!;
    expect(lag.capacityGbps).toBe(2);
    expect(lag.cables).toHaveLength(2);
  });

  it('サーバはスイッチの代わりに通信を中継しない', () => {
    const { s, isp, sw } = base();
    // 回線 → スイッチ → サーバ A → サーバ B と数珠つなぎにしても B には届かない
    const a = s.buyDevice('srv-1u-e', 0, 30).id!;
    const b = s.buyDevice('srv-1u-e', 0, 31).id!;
    s.toggleRole(b, 'web');
    s.toggleRole(b, 'db');
    s.connect({ device: a, port: 0 }, { device: sw, port: 1 });
    s.connect({ device: a, port: 1 }, { device: b, port: 0 });
    expect(isp).toBeGreaterThan(0);
    expect(run(s).success).toBe(0);
  });
});

describe('レプリカ・仮想化・共有ストレージ', () => {
  it('レプリカは db から複製を受けて読み込みを肩代わりし、書き込みの反映も負担する', () => {
    const { s, server } = base({ pv: 200, unlocks: ['replication', 'comments'] });
    const db = server('srv-2u-db', 20, ['db']);
    for (let i = 0; i < 2; i++) server('srv-1u-d', 30 + i, ['web']);
    const before = run(s);
    const r1 = server('srv-2u-db', 10, ['replica']);
    const r2 = server('srv-2u-db', 12, ['replica']);
    const after = run(s);
    const reads = 200 * BLOG.dbReads;
    // LB がないので web は 1 台だけ。読み込みは 2 台のレプリカに半分ずつ
    expect(before.nodeLoads.get(db)!.work.db!).toBeGreaterThan(reads * 0.9);
    expect(after.nodeLoads.get(r1)!.work.replica!).toBeCloseTo(reads / 2, 0);
    expect(after.nodeLoads.get(r2)!.work.replica!).toBeCloseTo(reads / 2, 0);
    // プライマリには書き込みだけが残る
    expect(after.nodeLoads.get(db)!.work.db!).toBeCloseTo(200 * BLOG.dbWrites, 1);
    // 複製の分、レプリカのディスク IO は読み込みだけのときより多い
    expect(after.nodeLoads.get(r1)!.ioOps).toBeGreaterThan(200 * BLOG.dbWrites * BLOG.dbWriteIo);
  });

  it('db から届かないレプリカは使われない', () => {
    const { s, server } = base({ pv: 20, unlocks: ['replication'] });
    server('srv-2u-db', 20, ['db']);
    server('srv-1u-d', 30, ['web']);
    const lonely = server('srv-2u-db', 10, ['replica'], 0, -1);
    const flow = run(s);
    expect(flow.nodeLoads.get(lonely)!.work.replica ?? 0).toBe(0);
    expect(flow.problems.join()).toContain('複製できず');
    expect(flow.success).toBe(1);
  });

  it('ハイパーバイザに VM を載せ、役割は VM に付ける。メモリが足りなければ載らない', () => {
    const { s, server } = base({ pv: 30, unlocks: ['virtualization'] });
    const host = server('srv-2u-hv', 20, []);
    expect(s.createVm(host, 'm').ok).toBe(false); // まだハイパーバイザではない
    expect(s.setHv(host, true).ok).toBe(true);
    expect(s.toggleRole(host, 'web').ok).toBe(false);
    const web = s.createVm(host, 'm').id!;
    const db = s.createVm(host, 'l').id!;
    s.toggleVmRole(web, 'web');
    s.toggleVmRole(db, 'db');
    const flow = run(s);
    expect(flow.success).toBe(1);
    expect(flow.nodeLoads.get(-web)!.work.web).toBeCloseTo(30, 0);
    // 同じホストの VM 同士の通信はネットワークを通らない
    expect(flow.devices.get(host)!.gbps).toBeLessThan(0.01);
    // 256GB - 8GB(ハイパーバイザ)に 48GB の L は 4 台(と M 1 台)まで
    let made = 0;
    while (s.createVm(host, 'l').ok) made++;
    expect(made).toBe(3);
    expect(s.sellDevice(host).ok).toBe(false); // VM が載っている
  });

  it('ローカルディスクの VM は移すと止まり、共有ストレージなら止まらない', () => {
    const { s, sw, server } = base({ pv: 20, unlocks: ['virtualization', 'storage', 'tenGig'] });
    const h1 = server('srv-2u-hv', 20, []);
    const h2 = server('srv-2u-hv', 22, []);
    s.setHv(h1, true);
    s.setHv(h2, true);
    const vm = s.createVm(h1, 'm').id!;
    s.toggleVmRole(vm, 'web');
    s.toggleVmRole(vm, 'db');
    expect(run(s).success).toBe(1);
    expect(s.vmMoveInfo(vm, h2).downtimeMs).toBeGreaterThan(0);
    expect(s.moveVm(vm, h2).ok).toBe(true);
    expect(run(s, 1000).success).toBe(0); // 止まっている
    s.step(30_000);
    expect(s.flow.success).toBe(1);
    // 共有ストレージにディスクを置くと、止めずに移せる。IO はストレージへ
    const nas = s.buyDevice('nas-2u', 0, 10).id!;
    s.connect({ device: nas, port: 0 }, { device: sw, port: 10 });
    expect(s.setVmDisk(vm, 'shared').ok).toBe(true);
    expect(s.vmMoveInfo(vm, h1).downtimeMs).toBe(0);
    s.moveVm(vm, h1);
    const flow = run(s, 1000);
    expect(flow.success).toBe(1);
    expect(flow.nodeLoads.get(-vm)!.storage).toBe(nas);
    expect(flow.devices.get(nas)!.io).toBeGreaterThan(0);
  });

  it('ストレージ用のスイッチとホストの 2 本目の NIC で、ストレージの IO をサービスの経路から分けられる', () => {
    const { s, sw, server } = base({ pv: 50, unlocks: ['virtualization', 'storage', 'tenGig'] });
    const h = server('srv-2u-hv', 20, []);
    s.setHv(h, true);
    const vm = s.createVm(h, 'l').id!;
    s.toggleVmRole(vm, 'web');
    s.toggleVmRole(vm, 'db');
    const serviceOnly = run(s).devices.get(sw)!.gbps;
    s.setVmDisk(vm, 'shared');
    // ストレージ専用の 10G スイッチに、NAS とホストの 10G NIC(ポート 2)をつなぐ
    const ssw = s.buyDevice('sw-48', 0, 15).id!;
    const nas = s.buyDevice('nas-2u', 0, 10).id!;
    s.connect({ device: nas, port: 0 }, { device: ssw, port: 48 });
    s.connect({ device: h, port: 2 }, { device: ssw, port: 49 });
    const flow = run(s);
    expect(flow.success).toBe(1);
    // サービス側の ToR の通信量は変わらず、ストレージの IO はストレージ用スイッチだけを通る
    expect(flow.devices.get(sw)!.gbps).toBeCloseTo(serviceOnly, 6);
    expect(flow.devices.get(ssw)!.gbps).toBeGreaterThan(0);
    expect(flow.devices.get(nas)!.io).toBeGreaterThan(0);
  });

  it('共有ストレージに届かない VM はディスクが使えず失敗する', () => {
    const { s, server } = base({ pv: 20, unlocks: ['virtualization', 'storage'] });
    const h = server('srv-2u-hv', 20, []);
    s.setHv(h, true);
    const vm = s.createVm(h, 'm').id!;
    s.toggleVmRole(vm, 'web');
    s.toggleVmRole(vm, 'db');
    s.setVmDisk(vm, 'shared');
    const flow = run(s);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain('ストレージに届きません');
  });

  it('VM と仮想化の設定もセーブから戻る', () => {
    const { s, server } = base({ unlocks: ['virtualization'] });
    const h = server('srv-2u-hv', 20, []);
    s.setHv(h, true);
    const vm = s.createVm(h, 's').id!;
    s.toggleVmRole(vm, 'web');
    const save = createSave(s, 1000);
    const b = loadSave(parseSave(JSON.parse(JSON.stringify(save)))!);
    expect(b.facility.devices.get(h)!.hv).toBe(true);
    expect(b.facility.vms.get(vm)!.roles).toEqual(['web']);
  });
});

describe('経済', () => {
  it('最初の資金と、解放・機器の価格は pricing.ts の値で決まる', () => {
    expect(new Simulation().money).toBe(START_MONEY);
    const s = new Simulation({ startMoney: RICH });
    s.facility.rent(0);
    const before = s.money;
    s.buyDevice('srv-1u-d', 0, 1);
    expect(before - s.money).toBe(MODEL_PRICES['srv-1u-d'].first * PRICE_SCALE);
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
    // ケーブルを抜くと全部エラーになり、離脱する
    for (const c of [...s.facility.cables.values()]) s.disconnect(c.id);
    const u1 = s.users;
    s.step(30_000);
    expect(s.users).toBeLessThan(u1);
  });
});

describe('セーブ', () => {
  it('保存 → 文字列化 → 復元で同じ構成になる', () => {
    const { s, server } = base({ unlocks: ['lb'] });
    server('srv-2u-db', 20, ['db']);
    server('srv-1u-e', 30, ['web', 'lb']);
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
    expect(parseSave({ ...save, cables: [[1, 1, 99, 2, 0, 0]] })).toBeNull();
    expect(decodeSave('not-base64!!')).toBeNull();
    expect(parseSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });

  it('放置収入は直前の収支の一定割合', () => {
    const save = { ...createSave(newGame(), 0), incomePerSec: 2 };
    expect(offlineEarnings(save, 10_000).gained).toBe(0);
    expect(offlineEarnings(save, 100_000).gained).toBeCloseTo(2 * 100 * 0.5);
  });

  it('機種のデータが揃っている', () => {
    for (const m of Object.values(MODEL_BY_ID)) {
      expect(m.u).toBeGreaterThan(0);
      if (m.category === 'server') expect(m.cores && m.memGB && m.diskIops && m.coreSpeed).toBeTruthy();
      if (m.category === 'switch') expect(m.fabricGbps).toBeGreaterThan(0);
    }
  });
});
