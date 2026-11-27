import { describe, expect, it } from 'vitest';
import { BLOG_FEATURES, SERVICES, WORK } from '../src/sim/config';
import { createSave, loadSave, parseSave } from '../src/sim/save';
import { wire, run, base } from './helpers';

describe('レプリカ・仮想化・共有ストレージ', () => {
  it('レプリカは db から複製を受けて読み込みを肩代わりし、書き込みの反映も負担する', () => {
    const { s, server } = base({ pv: 200, unlocks: ['replication', 'comments'] });
    const db = server('db', 20, ['blog:db']);
    for (let i = 0; i < 2; i++) server('web', 30 + i, ['blog:web']);
    const before = run(s);
    const r1 = server('db', 10, ['blog:replica']);
    const r2 = server('db', 12, ['blog:replica']);
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
    server('db', 20, ['blog:db']);
    server('web', 30, ['blog:web']);
    const lonely = server('db', 10, ['blog:replica'], 0, -1);
    const flow = run(s);
    expect(flow.nodeLoads.get(lonely)!.work['blog:replica'] ?? 0).toBe(0);
    expect(flow.problems.join()).toContain('複製できず');
    expect(flow.success).toBe(1);
  });

  it('ハイパーバイザに VM を載せ、役割は VM に付ける。メモリが足りなければ載らない', () => {
    const { s, server } = base({ pv: 30, unlocks: ['virtualization'] });
    const host = server('big', 20, []);
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
    const h1 = server('big', 20, []);
    const h2 = server('big', 22, []);
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
    wire(s, { device: nas, port: 0 }, { device: sw, port: 10 });
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
    const h = server('big', 20, []);
    s.setHv(h, true);
    const vm = s.createVm(h, 'l').id!;
    s.toggleVmRole(vm, 'blog:web');
    s.toggleVmRole(vm, 'blog:db');
    const serviceOnly = run(s).devices.get(sw)!.gbps;
    s.setVmDisk(vm, 'shared');
    // ストレージ専用の 10G スイッチに、NAS とホストの 10G NIC(ポート 2)をつなぐ
    const ssw = s.buyDevice('sw-48', 0, 15).id!;
    const nas = s.buyDevice('nas-2u', 0, 10).id!;
    wire(s, { device: nas, port: 0 }, { device: ssw, port: 48 });
    wire(s, { device: h, port: 2 }, { device: ssw, port: 49 });
    const flow = run(s);
    expect(flow.success).toBe(1);
    // サービス側の ToR の通信量は変わらず、ストレージの IO はストレージ用スイッチだけを通る
    expect(flow.devices.get(sw)!.gbps).toBeCloseTo(serviceOnly, 6);
    expect(flow.devices.get(ssw)!.gbps).toBeGreaterThan(0);
    expect(flow.devices.get(nas)!.io).toBeGreaterThan(0);
  });

  it('共有ストレージが複数あれば、VM のディスクは振り分けられる', () => {
    const { s, sw, server } = base({ pv: 20, unlocks: ['virtualization', 'storage', 'tenGig'] });
    const h = server('big', 20, []);
    s.setHv(h, true);
    const a = s.buyDevice('nas-2u', 0, 10).id!;
    const b = s.buyDevice('nas-2u', 0, 6).id!;
    wire(s, { device: a, port: 0 }, { device: sw, port: 10 });
    wire(s, { device: b, port: 0 }, { device: sw, port: 11 });
    const vms = [s.createVm(h, 's').id!, s.createVm(h, 's').id!];
    s.toggleVmRole(vms[0], 'blog:web');
    s.toggleVmRole(vms[1], 'blog:db');
    for (const vm of vms) s.setVmDisk(vm, 'shared');
    const flow = run(s, 1000);
    expect(new Set(vms.map((vm) => flow.nodeLoads.get(-vm)!.storage))).toEqual(new Set([a, b]));
  });

  it('共有ストレージに届かない VM はディスクが使えず失敗する', () => {
    const { s, server } = base({ pv: 20, unlocks: ['virtualization', 'storage'] });
    const h = server('big', 20, []);
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
    const h = server('big', 20, []);
    s.setHv(h, true);
    const vm = s.createVm(h, 's').id!;
    s.toggleVmRole(vm, 'blog:web');
    const save = createSave(s, 1000);
    const b = loadSave(parseSave(JSON.parse(JSON.stringify(save)))!);
    expect(b.facility.devices.get(h)!.hv).toBe(true);
    expect(b.facility.vms.get(vm)!.roles).toEqual(['blog:web']);
  });

  it('ディスク IO を出さない VM は、同じホストや NAS のディスクが溢れても巻き添えにならない', () => {
    const { s, sw, server } = base({
      traffic: { blog: 500, shop: 10 },
      unlocks: ['virtualization', 'storage', 'tenGig', 'shop', 'comments'],
    });
    // ホストのローカルディスクを HDD 2 本(150 IOPS)にして blog:db で溢れさせる
    const hv = s.buyDevice('srv-2u', 0, 20, { cpu: 24, memGB: 256, backplane: 'lff', drives: ['hdd', 'hdd'], nic: 'sfp10' }).id!;
    wire(s, { device: hv, port: 0 }, { device: sw, port: 20 });
    expect(s.setHv(hv, true).ok).toBe(true);
    const blogWeb = s.createVm(hv, 'l').id!;
    const blogDb = s.createVm(hv, 's').id!;
    const shopWeb = s.createVm(hv, 'm').id!;
    s.toggleVmRole(blogWeb, 'blog:web');
    s.toggleVmRole(blogDb, 'blog:db');
    s.toggleVmRole(shopWeb, 'shop:web');
    server('db', 10, ['shop:db', 'shop:search']);
    let flow = run(s);
    expect(flow.devices.get(hv)!.io).toBeGreaterThan(1);
    expect(flow.nodeLoads.get(-shopWeb)!.ioOps).toBe(0);
    expect(flow.services.blog!.success).toBeLessThan(1);
    expect(flow.services.shop!.success).toBe(1);

    // 共有ストレージでも同じ: NAS が溢れても IO を出さない VM は落ちない
    const { s: s2, isp: isp2 } = base({
      traffic: { blog: 20_000, shop: 10 },
      unlocks: ['virtualization', 'storage', 'tenGig', 'agg', 'shop'],
    });
    // 回線から 10G で捌けるよう agg-10g につなぎ替える
    s2.facility.clearCables();
    const agg = s2.buyDevice('agg-10g', 0, 38).id!;
    wire(s2, { device: isp2, port: 0 }, { device: agg, port: 0 });
    const hvShop = s2.buyDevice('srv-2u', 0, 20, { cpu: 24, memGB: 256, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'sfp10' }).id!;
    const hvBlog = s2.buyDevice('srv-2u', 0, 16, { cpu: 24, memGB: 256, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'sfp10' }).id!;
    const shopDb = s2.buyDevice('srv-2u', 0, 12, { cpu: 8, memGB: 64, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'sfp10' }).id!;
    const blogWebSrv = s2.buyDevice('srv-2u', 0, 8, { cpu: 24, memGB: 256, backplane: 'sff', drives: ['ssd', 'ssd'], nic: 'sfp10' }).id!;
    const nas = s2.buyDevice('nas-2u', 0, 4).id!;
    wire(s2, { device: hvShop, port: 2 }, { device: agg, port: 1 });
    wire(s2, { device: hvBlog, port: 2 }, { device: agg, port: 2 });
    wire(s2, { device: shopDb, port: 2 }, { device: agg, port: 3 });
    wire(s2, { device: blogWebSrv, port: 2 }, { device: agg, port: 4 });
    wire(s2, { device: nas, port: 0 }, { device: agg, port: 5 });
    s2.setHv(hvShop, true);
    s2.setHv(hvBlog, true);
    const shopVm = s2.createVm(hvShop, 'm').id!;
    const dbVm = s2.createVm(hvBlog, 's').id!;
    s2.toggleVmRole(shopVm, 'shop:web');
    s2.toggleVmRole(dbVm, 'blog:db');
    s2.setVmDisk(shopVm, 'shared');
    s2.setVmDisk(dbVm, 'shared');
    s2.toggleRole(shopDb, 'shop:db');
    s2.toggleRole(shopDb, 'shop:search');
    s2.toggleRole(blogWebSrv, 'blog:web');
    flow = run(s2);
    expect(flow.devices.get(nas)!.io).toBeGreaterThan(1);
    expect(flow.nodeLoads.get(-shopVm)!.ioOps).toBe(0);
    expect(flow.services.shop!.success).toBe(1);
  });

  it('止まっているホストには VM を作れず、移す先にも選べない', () => {
    const { s, server } = base({ pv: 20, unlocks: ['virtualization'] });
    const h1 = server('big', 20, []);
    const h2 = server('big', 22, []);
    s.setHv(h1, true);
    s.setHv(h2, true);
    const vm = s.createVm(h1, 's').id!;
    s.setMaintenance(h2, true);
    expect(s.createVm(h2, 's').ok).toBe(false);
    expect(s.vmMoveInfo(vm, h2).error).not.toBeNull();
    expect(s.moveVm(vm, h2).ok).toBe(false);
  });
});
