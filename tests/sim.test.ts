import { describe, expect, it } from 'vitest';
import { MODEL_BY_ID, PRESETS, PRESET_BY_ID, START_PARTS, isServerModel, partsError, partsRequires, specOf } from '../src/sim/catalog';
import { BLOG_FEATURES, CAMPAIGN, K8S, RACK, SERVICES, WORK } from '../src/sim/config';
import { LEGACY_SERVERS, createSave, decodeSave, encodeSave, loadSave, newGame, offlineEarnings, parseSave } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { forecastSeries, logistic, secondsUntil } from '../src/sim/forecast';
import {
  CHASSIS_PRICES,
  CPU_PRICES,
  DRIVE_PRICES,
  MEMORY_PRICE_PER_GB,
  MODEL_PRICES,
  PRICE_SCALE,
  START_MONEY,
  UNLOCK_PRICES,
  cablePrice,
  serverPrice,
} from '../src/sim/pricing';
import type { RoleKey, ServiceId, UnlockId } from '../src/sim/types';

const constant = (pv: number) => () => pv;

/** 機種固定だったころのサーバ名で、同じくらいの構成のサーバを買う */
type Legacy = 'srv-1u-e' | 'srv-1u-d' | 'srv-2u-db' | 'srv-2u-hv';
const buy = (s: Simulation, legacy: Legacy, slot: number, u: number) => {
  const l = LEGACY_SERVERS[legacy];
  // 10G NIC などの解放はテストでは済ませておく
  for (const id of partsRequires(l.parts)) s.unlocks.add(id);
  return s.buyDevice(l.model, slot, u, l.parts);
};
const RICH = 1_000_000;

/** 回線終端と ToR スイッチだけのラック 1 本 */
function base(opts: { pv?: number; traffic?: Partial<Record<ServiceId, number>>; unlocks?: UnlockId[]; uplink?: number } = {}) {
  const s = new Simulation({
    startMoney: RICH,
    traffic: opts.traffic
      ? Object.fromEntries(Object.entries(opts.traffic).map(([k, v]) => [k, constant(v)]))
      : constant(opts.pv ?? 10),
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
  const server = (model: Legacy, u: number, roles: RoleKey[], slot = 0, toSw = sw) => {
    const r = buy(s, model, slot, u);
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
    expect(buy(s, 'srv-1u-e', 0, 40).ok).toBe(false); // スイッチがいる
    expect(buy(s, 'srv-2u-db', 0, 42).ok).toBe(false); // 43U にはみ出す
    expect(buy(s, 'srv-1u-e', 1, 10).ok).toBe(false); // 借りていないラック
    expect(buy(s, 'srv-2u-db', 0, 10).ok).toBe(true);
    expect(buy(s, 'srv-1u-e', 0, 11).ok).toBe(false); // 2U の上側
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

  it('ポートには 1 本だけ。同じラック内は銅線、SFP が絡むと光ファイバで、ラック間は長くて高い', () => {
    const { s, f, sw } = base({ unlocks: ['tenGig', 'agg'] });
    const a = buy(s, 'srv-1u-e', 0, 30).id!;
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
    const id = server('srv-1u-e', 30, ['blog:web']);
    const before = s.money;
    const r = s.sellDevice(id);
    expect(r.ok).toBe(true);
    expect(s.money).toBe(before + Math.floor(serverPrice('srv-1u', LEGACY_SERVERS['srv-1u-e'].parts) / 2));
    expect([...f.cables.values()].some((c) => c.a.device === id || c.b.device === id)).toBe(false);
  });

  it('解放していない機種や役割は使えない', () => {
    const { s, server } = base();
    expect(s.buyDevice('agg-10g', 0, 20).ok).toBe(false);
    const id = server('srv-1u-e', 30, ['blog:web']);
    expect(s.toggleRole(id, 'blog:cache').ok).toBe(false);
    expect(s.toggleRole(s.facility.devices.values().next().value!.id, 'blog:web').ok).toBe(false); // 回線終端
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
    server('srv-1u-e', 30, ['blog:web']);
    let flow = run(s);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain('db');
    // 別のスイッチにつながった web は回線から届かない
    const { s: s2, server: server2 } = base();
    const lonely = server2('srv-1u-e', 30, ['blog:web', 'blog:db'], 0, -1);
    flow = run(s2);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain(s2.facility.devices.get(lonely)!.name);
  });

  it('HDD の db はディスク IO で先に詰まり、パーツを替える(SSD・メモリ)と捌ける', () => {
    const { s } = base({ pv: 150 });
    const web = s.buyDevice('srv-1u', 0, 30, START_PARTS.web).id!;
    const db = s.buyDevice('srv-2u', 0, 20, START_PARTS.db).id!;
    s.toggleRole(web, 'blog:web');
    s.toggleRole(db, 'blog:db');
    const sw = [...s.facility.devices.values()].find((d) => d.model === 'sw-24')!.id;
    s.connect({ device: web, port: 0 }, { device: sw, port: 1 });
    s.connect({ device: db, port: 0 }, { device: sw, port: 2 });
    let flow = run(s);
    expect(flow.devices.get(db)!.io).toBeGreaterThan(1);
    expect(flow.bottleneck!.label).toContain('ディスク IO');
    expect(flow.success).toBeLessThan(0.9);
    // HDD を足すと IO は増えるが、2 本で 75 IOPS ずつ
    const iops0 = specOf(s.facility.devices.get(db)!).diskIops;
    expect(s.changeParts(db, { kind: 'drive-add', type: 'hdd' }).ok).toBe(true);
    expect(specOf(s.facility.devices.get(db)!).diskIops).toBe(iops0 * 2);
    // SSD は 2.5 インチのベイなので、前面を替えてから
    expect(s.changeParts(db, { kind: 'drive-add', type: 'ssd' }).ok).toBe(false);
    // 前面を 2.5 インチに替えると、HDD は下取りに出て SSD 2 本が入る
    expect(s.changeParts(db, { kind: 'backplane', to: 'sff' }).ok).toBe(true);
    expect(s.facility.devices.get(db)!.parts!.drives).toEqual(['ssd', 'ssd']);
    // データ用のミラー 1 組は外せない
    expect(s.changeParts(db, { kind: 'drive-remove' }).ok).toBe(false);
    expect(s.changeParts(db, { kind: 'mem', dir: 1 }).ok).toBe(true);
    flow = run(s);
    expect(flow.devices.get(db)!.io).toBeLessThan(0.5);
    expect(flow.success).toBeGreaterThan(0.99);
  });

  it('パーツの強化はラックの電力と解放の範囲で、NVMe は解放してから', () => {
    const { s } = base();
    const id = s.buyServer('1u-small', 0, 30).id!;
    expect(s.changeParts(id, { kind: 'drive-add', type: 'nvme' }).ok).toBe(false);
    s.unlock('nvme');
    expect(s.changeParts(id, { kind: 'drive-add', type: 'nvme' }).ok).toBe(true);
    // CPU を上げ続けると最後は「これより上はない」
    let r = s.changeParts(id, { kind: 'cpu', dir: 1 });
    while (r.ok) r = s.changeParts(id, { kind: 'cpu', dir: 1 });
    expect(r.message).toContain('上の CPU');
    expect(s.facility.devices.get(id)!.parts!.cpu).toBe(64);
    // 1U の最後の 2 本(OS)は外せない
    expect(s.changeParts(id, { kind: 'drive-remove' }).ok).toBe(true);
    expect(s.changeParts(id, { kind: 'drive-remove' }).ok).toBe(false);
  });

  it('LB がないとインターネットから届くのは web 1 台だけ。LB を置くと並べた web に分散する', () => {
    const { s, server } = base({ pv: 150, unlocks: ['lb'] });
    server('srv-2u-db', 20, ['blog:db']);
    const w1 = server('srv-1u-e', 30, ['blog:web']);
    const w2 = server('srv-1u-e', 31, ['blog:web']);
    let flow = run(s);
    expect(flow.nodeLoads.get(w2)!.work['blog:web'] ?? 0).toBe(0);
    expect(flow.problems.join()).toContain('LB');
    server('srv-1u-e', 32, ['blog:lb']);
    flow = run(s);
    expect(flow.nodeLoads.get(w1)!.work['blog:web']).toBeCloseTo(75, 0);
    expect(flow.nodeLoads.get(w2)!.work['blog:web']).toBeCloseTo(75, 0);
  });

  it('memcached があると db に行く読み込みが減る', () => {
    const { s, server } = base({ pv: 50, unlocks: ['cache'] });
    const db = server('srv-2u-db', 20, ['blog:db']);
    server('srv-1u-d', 30, ['blog:web']);
    const before = run(s).nodeLoads.get(db)!.work['blog:db']!;
    server('srv-1u-e', 31, ['blog:cache']);
    const after = run(s).nodeLoads.get(db)!.work['blog:db']!;
    expect(after / before).toBeCloseTo(1 - WORK.cacheHitRate, 1);
  });

  it('回線契約の速度を超えると溢れる。画像を載せると回線が先に詰まる', () => {
    const { s, server } = base({ pv: 100, uplink: 0 });
    server('srv-2u-db', 20, ['blog:db']);
    server('srv-1u-d', 30, ['blog:web']);
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
    const db = server('srv-2u-db', 20, ['blog:db'], 1, -1);
    s.connect({ device: db, port: 0 }, { device: sw2, port: 1 });
    for (let i = 0; i < 3; i++) server('srv-1u-d', 30 + i, ['blog:web']);
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
    const a = buy(s, 'srv-1u-e', 0, 30).id!;
    const b = buy(s, 'srv-1u-e', 0, 31).id!;
    s.toggleRole(b, 'blog:web');
    s.toggleRole(b, 'blog:db');
    s.connect({ device: a, port: 0 }, { device: sw, port: 1 });
    s.connect({ device: a, port: 1 }, { device: b, port: 0 });
    expect(isp).toBeGreaterThan(0);
    expect(run(s).success).toBe(0);
  });
});

describe('レプリカ・仮想化・共有ストレージ', () => {
  it('レプリカは db から複製を受けて読み込みを肩代わりし、書き込みの反映も負担する', () => {
    const { s, server } = base({ pv: 200, unlocks: ['replication', 'comments'] });
    const db = server('srv-2u-db', 20, ['blog:db']);
    for (let i = 0; i < 2; i++) server('srv-1u-d', 30 + i, ['blog:web']);
    const before = run(s);
    const r1 = server('srv-2u-db', 10, ['blog:replica']);
    const r2 = server('srv-2u-db', 12, ['blog:replica']);
    const after = run(s);
    const reads = 200 * SERVICES.blog.work.dbReads;
    // LB がないので web は 1 台だけ。読み込みは 2 台のレプリカに半分ずつ
    expect(before.nodeLoads.get(db)!.work['blog:db']!).toBeGreaterThan(reads * 0.9);
    expect(after.nodeLoads.get(r1)!.work['blog:replica']!).toBeCloseTo(reads / 2, 0);
    expect(after.nodeLoads.get(r2)!.work['blog:replica']!).toBeCloseTo(reads / 2, 0);
    // プライマリには書き込みだけが残る
    expect(after.nodeLoads.get(db)!.work['blog:db']!).toBeCloseTo(200 * BLOG_FEATURES.commentWrites, 1);
    // 複製の分、レプリカのディスク IO は読み込みだけのときより多い
    expect(after.nodeLoads.get(r1)!.ioOps).toBeGreaterThan(200 * BLOG_FEATURES.commentWrites * WORK.dbWriteIo);
  });

  it('db から届かないレプリカは使われない', () => {
    const { s, server } = base({ pv: 20, unlocks: ['replication'] });
    server('srv-2u-db', 20, ['blog:db']);
    server('srv-1u-d', 30, ['blog:web']);
    const lonely = server('srv-2u-db', 10, ['blog:replica'], 0, -1);
    const flow = run(s);
    expect(flow.nodeLoads.get(lonely)!.work['blog:replica'] ?? 0).toBe(0);
    expect(flow.problems.join()).toContain('複製できず');
    expect(flow.success).toBe(1);
  });

  it('ハイパーバイザに VM を載せ、役割は VM に付ける。メモリが足りなければ載らない', () => {
    const { s, server } = base({ pv: 30, unlocks: ['virtualization'] });
    const host = server('srv-2u-hv', 20, []);
    expect(s.createVm(host, 'm').ok).toBe(false); // まだハイパーバイザではない
    expect(s.setHv(host, true).ok).toBe(true);
    expect(s.toggleRole(host, 'blog:web').ok).toBe(false);
    const web = s.createVm(host, 'm').id!;
    const db = s.createVm(host, 'l').id!;
    s.toggleVmRole(web, 'blog:web');
    s.toggleVmRole(db, 'blog:db');
    const flow = run(s);
    expect(flow.success).toBe(1);
    expect(flow.nodeLoads.get(-web)!.work['blog:web']).toBeCloseTo(30, 0);
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
    s.toggleVmRole(vm, 'blog:web');
    s.toggleVmRole(vm, 'blog:db');
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
    s.toggleVmRole(vm, 'blog:web');
    s.toggleVmRole(vm, 'blog:db');
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
    s.toggleVmRole(vm, 'blog:web');
    s.toggleVmRole(vm, 'blog:db');
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
    s.toggleVmRole(vm, 'blog:web');
    const save = createSave(s, 1000);
    const b = loadSave(parseSave(JSON.parse(JSON.stringify(save)))!);
    expect(b.facility.devices.get(h)!.hv).toBe(true);
    expect(b.facility.vms.get(vm)!.roles).toEqual(['blog:web']);
  });
});

describe('BGP による冗長化', () => {
  /** 回線 → コア → ToR 2 台 → サーバ 1 台(両方の ToR につなぐ) */
  function dual(unlocks: UnlockId[] = []) {
    const s = new Simulation({ startMoney: RICH, traffic: constant(50), unlocks, upgrades: { uplink: 2, rackPower: 3 } });
    const f = s.facility;
    f.rent(0);
    const isp = f.place('handoff', 0, RACK.units, 0).id;
    const core = s.buyDevice('sw-24', 0, 40).id!;
    const t1 = s.buyDevice('sw-24', 0, 38).id!;
    const t2 = s.buyDevice('sw-24', 0, 37).id!;
    s.connect({ device: isp, port: 0 }, { device: core, port: 0 });
    s.connect({ device: core, port: 1 }, { device: t1, port: 0 });
    s.connect({ device: core, port: 2 }, { device: t2, port: 0 });
    const srv = buy(s, 'srv-2u-db', 0, 20).id!;
    s.toggleRole(srv, 'blog:web');
    s.toggleRole(srv, 'blog:db');
    s.connect({ device: srv, port: 0 }, { device: t1, port: 1 });
    s.connect({ device: srv, port: 1 }, { device: t2, port: 1 });
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

  it('障害は難易度オプションで、既定ではオフ', () => {
    const s = newGame();
    s.step(60_000);
    expect(s.downDevices.size).toBe(0);
  });
});

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
    // 市場規模(1,500 人 = 15 PV/秒)ではキャパシティ(約 50)に届かない。広告で市場を広げると届く
    expect(s.secondsToSaturation()).toBeNull();
    s.upgrades.marketing = 4;
    expect(s.secondsToSaturation()).toBeGreaterThan(0);
  });
});

describe('複数のサービス', () => {
  it('サービスの役割は、そのサービスを始めるまで付けられない', () => {
    const { s, server } = base();
    const srv = server('srv-1u-e', 30, []);
    expect(s.toggleRole(srv, 'shop:web').ok).toBe(false);
    expect(s.toggleRole(srv, 'blog:search').ok).toBe(false); // ブログに検索はない
    s.unlock('shop');
    expect(s.toggleRole(srv, 'shop:web').ok).toBe(true);
    expect(s.toggleRole(srv, 'shop:search').ok).toBe(true);
    expect(s.toggleRole(srv, 'photo:media').ok).toBe(false);
  });

  it('同じサーバに相乗りさせると負荷が合算され、分ければ別々になる', () => {
    const { s, server } = base({ traffic: { blog: 20, shop: 20 }, unlocks: ['shop'] });
    const a = server('srv-2u-db', 10, ['blog:web', 'blog:db', 'shop:web', 'shop:db']);
    const shared = run(s);
    expect(shared.services.blog!.success).toBe(1);
    expect(shared.services.shop!.success).toBe(1);
    const both = shared.devices.get(a)!.cpu;
    // ショッピングを別のサーバへ
    const b = server('srv-2u-db', 20, ['shop:web', 'shop:db']);
    s.toggleRole(a, 'shop:web');
    s.toggleRole(a, 'shop:db');
    const split = run(s);
    expect(split.devices.get(a)!.cpu).toBeLessThan(both);
    expect(split.devices.get(b)!.cpu).toBeGreaterThan(0);
    expect(split.services.shop!.instances.web).toEqual([b]);
  });

  it('検索サーバがなければ db が検索を肩代わりし、search を置くと db が軽くなる', () => {
    const { s, server } = base({ traffic: { blog: 0, shop: 30 }, unlocks: ['shop'] });
    server('srv-1u-e', 30, ['shop:web']);
    const db = server('srv-2u-db', 20, ['shop:db']);
    const before = run(s);
    expect(before.problems.join()).toContain('search');
    const dbCpu = before.devices.get(db)!.cpu;
    const search = server('srv-1u-d', 28, ['shop:search']);
    const after = run(s);
    expect(after.devices.get(db)!.cpu).toBeLessThan(dbCpu * 0.5);
    expect(after.nodeLoads.get(search)!.work['shop:search']).toBeCloseTo(30 * SERVICES.shop.work.search!.perPv, 1);
  });

  it('写真共有: media・worker がなければ web が肩代わりし、置けばそちらへ流れる', () => {
    const { s, server } = base({ traffic: { blog: 0, photo: 10 }, unlocks: ['shop', 'photo'] });
    const web = server('srv-2u-db', 10, ['photo:web', 'photo:db']);
    const before = run(s);
    expect(before.services.photo!.success).toBe(1);
    expect(before.nodeLoads.get(web)!.work['photo:web']).toBeGreaterThan(10);
    const media = server('srv-2u-db', 20, ['photo:media']);
    const worker = server('srv-1u-d', 30, ['photo:worker']);
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
    server('srv-2u-db', 10, ['blog:web', 'blog:db']);
    server('srv-1u-e', 20, ['shop:web', 'shop:db']);
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
});

describe('Kubernetes', () => {
  /** db はサーバ、web は Pod。ワーカーを 2 台 */
  function cluster(pv: number, unlocks: UnlockId[] = []) {
    const b = base({ pv, unlocks: ['kubernetes', ...unlocks] });
    b.server('srv-2u-db', 10, ['blog:db']);
    const w1 = b.server('srv-1u-d', 20, []);
    const w2 = b.server('srv-1u-d', 22, []);
    expect(b.s.setK8sWorker({ device: w1 }, true).ok).toBe(true);
    expect(b.s.setK8sWorker({ device: w2 }, true).ok).toBe(true);
    return { ...b, w1, w2 };
  }
  const webPods = (s: Simulation) => s.pods.filter((p) => p.role === 'blog:web').reduce((n, p) => n + p.count, 0);

  it('ワーカーには役割を付けられず、状態を持つ役割は Deployment にできない', () => {
    const { s, server } = base();
    const srv = server('srv-1u-d', 20, ['blog:web']);
    expect(s.setK8sWorker({ device: srv }, true).ok).toBe(false); // 未解放
    s.unlock('kubernetes');
    expect(s.setK8sWorker({ device: srv }, true).ok).toBe(true);
    expect(s.facility.devices.get(srv)!.roles).toEqual([]);
    expect(s.toggleRole(srv, 'blog:web').ok).toBe(false);
    expect(s.toggleDeployment('blog:db').ok).toBe(false);
    expect(s.toggleDeployment('blog:web').ok).toBe(true);
    expect(webPods(s)).toBe(K8S.minPods);
  });

  it('Pod はワーカーに分散して置かれ、負荷に合わせて自動で増える', () => {
    const { s, server, w1, w2 } = cluster(300, ['lb']);
    server('srv-1u-d', 30, ['blog:lb']);
    s.toggleDeployment('blog:web');
    expect(new Set(s.pods.map((p) => p.worker))).toEqual(new Set([w1, w2]));
    const before = run(s, 1000);
    expect(before.success).toBeLessThan(0.9);
    run(s, 30_000);
    expect(webPods(s)).toBeGreaterThan(K8S.minPods);
    expect(s.flow.success).toBe(1);
    // 負荷が下がると減っていく
    const many = webPods(s);
    (s as unknown as { fixedTraffic: Record<string, () => number> }).fixedTraffic.blog = () => 20;
    run(s, 60_000);
    expect(webPods(s)).toBeLessThan(many);
  });

  it('LB も BGP もなければ届くのは Pod 1 つ。BGP を使うワーカーの Pod は LB なしで受けられる', () => {
    const { s, w1, w2 } = cluster(50, ['bgp']);
    s.toggleDeployment('blog:web');
    const one = run(s, 1000);
    expect(one.services.blog!.entries).toHaveLength(1);
    expect(one.problems.join()).toContain('LB がない');
    s.setBgp(w1, true);
    s.setBgp(w2, true);
    const direct = run(s, 1000);
    expect(direct.services.blog!.entries.length).toBe(2);
    expect(direct.success).toBe(1);
  });

  it('ワーカーが止まると、Pod は残りのワーカーに置き直される', () => {
    const { s, server, w1, w2 } = cluster(100, ['lb']);
    server('srv-1u-d', 30, ['blog:lb']);
    s.toggleDeployment('blog:web');
    run(s, 20_000);
    s.setMaintenance(w1, true);
    expect(s.pods.every((p) => p.worker === w2)).toBe(true);
    run(s, 20_000);
    expect(s.flow.success).toBe(1);
  });

  it('VM もワーカーにでき、セーブで Deployment とワーカーが残る', () => {
    const { s, server } = base({ pv: 30, unlocks: ['kubernetes', 'virtualization'] });
    server('srv-2u-db', 10, ['blog:db']);
    const h = server('srv-2u-hv', 20, []);
    s.setHv(h, true);
    const vm = s.createVm(h, 'l').id!;
    expect(s.setK8sWorker({ vm }, true).ok).toBe(true);
    s.toggleDeployment('blog:web');
    expect(run(s, 5000).success).toBe(1);
    const b = loadSave(decodeSave(encodeSave(createSave(s)))!);
    expect(b.facility.vms.get(vm)!.k8s).toBe(true);
    expect(b.deployments.get('blog:web')).toBe(s.deployments.get('blog:web'));
    expect(b.flow.success).toBe(1);
  });
});

describe('経済', () => {
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
    server('srv-2u-db', 20, ['blog:db']);
    server('srv-1u-e', 30, ['blog:web', 'blog:lb']);
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
    for (const p of PRESETS) expect(partsError(p.model, p.parts), p.id).toBeNull();
    for (const m of Object.values(MODEL_BY_ID)) {
      expect(m.u).toBeGreaterThan(0);
      if (m.category === 'server') expect(isServerModel(m.id)).toBe(true);
      if (m.category === 'switch') expect(m.fabricGbps).toBeGreaterThan(0);
    }
  });
});
