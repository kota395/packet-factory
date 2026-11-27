import { describe, expect, it } from 'vitest';
import { MODEL_BY_ID, START_PARTS, portsOf, specOf } from '../src/sim/catalog';
import { SERVICES, WORK } from '../src/sim/config';
import { computeFlow } from '../src/sim/flow';
import { newGame } from '../src/sim/save';
import { wire, run, base, buy } from './helpers';

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
    server('small', 30, ['blog:web']);
    let flow = run(s);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain('db');
    // 別のスイッチにつながった web は回線から届かない
    const { s: s2, server: server2 } = base();
    const lonely = server2('small', 30, ['blog:web', 'blog:db'], 0, -1);
    flow = run(s2);
    expect(flow.success).toBe(0);
    expect(flow.problems.join()).toContain(s2.facility.devices.get(lonely)!.name);
  });

  it('HDD の db はディスク IO で先に詰まり、パーツを替える(SSD・メモリ)と捌ける', () => {
    const { s } = base({ pv: 250 });
    const web = s.buyDevice('srv-1u', 0, 30, START_PARTS.web).id!;
    const db = s.buyDevice('srv-2u', 0, 20, START_PARTS.db).id!;
    s.toggleRole(web, 'blog:web');
    s.toggleRole(db, 'blog:db');
    const sw = [...s.facility.devices.values()].find((d) => d.model === 'sw-24')!.id;
    wire(s, { device: web, port: 0 }, { device: sw, port: 1 });
    wire(s, { device: db, port: 0 }, { device: sw, port: 2 });
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
    const { s, server, lb } = base({ pv: 150, unlocks: ['lb'] });
    server('db', 20, ['blog:db']);
    const w1 = server('small', 30, ['blog:web']);
    const w2 = server('small', 31, ['blog:web']);
    let flow = run(s);
    expect(flow.nodeLoads.get(w2)!.work['blog:web'] ?? 0).toBe(0);
    expect(flow.problems.join()).toContain('LB');
    const l1 = lb(32);
    flow = run(s);
    expect(flow.services.blog!.entries).toEqual([l1]);
    expect(flow.nodeLoads.get(w1)!.work['blog:web']).toBeCloseTo(75, 0);
    expect(flow.nodeLoads.get(w2)!.work['blog:web']).toBeCloseTo(75, 0);
    // アプライアンスの使用率 = 振り分けたリクエスト ÷ 処理能力
    expect(flow.devices.get(l1)!.cpu).toBeCloseTo(150 / MODEL_BY_ID['lb-1u'].lbRps!, 6);
    // サーバに役割「lb」を付けるのは SLB を解放してから
    const srv = server('small', 28, []);
    expect(s.toggleRole(srv, 'blog:lb').ok).toBe(false);
    s.unlock('slb');
    expect(s.toggleRole(srv, 'blog:lb').ok).toBe(true);
    expect(run(s).services.blog!.entries).toEqual([l1, srv]);
  });

  it('LB を 2 台にして HA ポートで直結すると、片方が止まってももう片方が引き継ぐ', () => {
    const { s, server, lb } = base({ pv: 100, unlocks: ['lb'] });
    server('db', 20, ['blog:web', 'blog:db']);
    const l1 = lb(32);
    const l2 = lb(31);
    // HA でつないでいない 2 台は別々の VIP。片方を止めると、そこに来た半分が失敗する
    expect(run(s, 1000).services.blog!.entries).toEqual([l1, l2]);
    s.setMaintenance(l1, true);
    expect(run(s, 1000).success).toBeCloseTo(0.5, 6);
    s.setMaintenance(l1, false);
    const ha = portsOf(s.facility.devices.get(l1)!).findIndex((p) => p.label === 'HA');
    expect(wire(s, { device: l1, port: ha }, { device: l2, port: ha }).ok).toBe(true);
    // ペアはアクティブの 1 台だけが受ける
    let flow = run(s, 1000);
    expect(flow.services.blog!.entries).toEqual([l1]);
    expect(flow.success).toBe(1);
    s.setMaintenance(l1, true);
    flow = run(s, 1000);
    expect(flow.services.blog!.entries).toEqual([l2]);
    expect(flow.success).toBe(1);
    expect(flow.problems.join()).toContain('引き継いで');
    s.setMaintenance(l2, true);
    expect(run(s, 1000).success).toBe(0);
  });

  it('memcached があると db に行く読み込みが減る', () => {
    const { s, server } = base({ pv: 50, unlocks: ['cache'] });
    const db = server('db', 20, ['blog:db']);
    server('web', 30, ['blog:web']);
    const before = run(s).nodeLoads.get(db)!.work['blog:db']!;
    server('small', 31, ['blog:cache']);
    const after = run(s).nodeLoads.get(db)!.work['blog:db']!;
    expect(after / before).toBeCloseTo(1 - WORK.cacheHitRate, 1);
  });

  it('回線契約の速度を超えると溢れる。画像を載せると回線が先に詰まる', () => {
    const { s, server } = base({ pv: 100, uplink: 0 });
    server('db', 20, ['blog:db']);
    server('web', 30, ['blog:web']);
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
    const db = server('db', 20, ['blog:db'], 1, -1);
    wire(s, { device: db, port: 0 }, { device: sw2, port: 1 });
    for (let i = 0; i < 3; i++) server('web', 30 + i, ['blog:web']);
    wire(s, { device: sw, port: 20 }, { device: sw2, port: 20 });
    const one = run(s);
    const uplink = one.links.find((l) => (l.a === sw && l.b === sw2) || (l.a === sw2 && l.b === sw))!;
    expect(uplink.capacityGbps).toBe(1);
    wire(s, { device: sw, port: 21 }, { device: sw2, port: 21 });
    const two = run(s);
    const lag = two.links.find((l) => (l.a === sw && l.b === sw2) || (l.a === sw2 && l.b === sw))!;
    expect(lag.capacityGbps).toBe(2);
    expect(lag.cables).toHaveLength(2);
  });

  it('サーバはスイッチの代わりに通信を中継しない', () => {
    const { s, isp, sw } = base();
    // 回線 → スイッチ → サーバ A → サーバ B と数珠つなぎにしても B には届かない
    const a = buy(s, 'small', 0, 30).id!;
    const b = buy(s, 'small', 0, 31).id!;
    s.toggleRole(b, 'blog:web');
    s.toggleRole(b, 'blog:db');
    wire(s, { device: a, port: 0 }, { device: sw, port: 1 });
    wire(s, { device: a, port: 1 }, { device: b, port: 0 });
    expect(isp).toBeGreaterThan(0);
    expect(run(s).success).toBe(0);
  });

  it('複数の LB と web・worker・media がある構成でも成功率と応答時間を正しく計算する', () => {
    const { s, server, lb } = base({ traffic: { blog: 0, photo: 80 }, unlocks: ['lb', 'shop', 'photo'] });
    const l1 = lb(38);
    const l2 = lb(37);
    const w1 = server('web', 30, ['photo:web']);
    const w2 = server('small', 31, ['photo:web']);
    server('db', 20, ['photo:db']);
    server('web', 28, ['photo:worker']);
    server('small', 29, ['photo:worker']);
    server('db', 16, ['photo:media']);
    server('small', 27, ['photo:media']);
    const flow = run(s);
    const photo = flow.services.photo!;
    expect(photo.entries).toEqual([l1, l2]);
    // 2 台の LB に等分され、さらに 2 台の web に等分される
    expect(flow.nodeLoads.get(w1)!.work['photo:web']).toBeCloseTo(40 * (1 + 0.02), 3);
    expect(flow.nodeLoads.get(w2)!.work['photo:web']).toBeCloseTo(40 * (1 + 0.02), 3);
    expect(photo.success).toBeGreaterThan(0);
    expect(photo.success).toBeLessThanOrEqual(1);
    expect(photo.latencyMs).toBeGreaterThan(40);
  });

  it('同じトポロジで computeFlow を続けて呼んでも前の FlowResult.links が書き換わらない', () => {
    const { s, server } = base();
    server('db', 20, ['blog:web', 'blog:db']);
    const input = (pv: number) => ({
      services: [{ id: 'blog' as const, pv, work: SERVICES.blog.work }],
      uplinkGbps: 10,
      roles: s.availableRoles,
      now: 0,
      bgp: false,
      down: new Set<number>(),
    });
    const first = computeFlow(s.facility, input(10));
    const snapshot = first.links.map((l) => ({ a: l.a, b: l.b, ab: l.ab, ba: l.ba }));
    const second = computeFlow(s.facility, input(100));
    expect(first.links.map((l) => ({ a: l.a, b: l.b, ab: l.ab, ba: l.ba }))).toEqual(snapshot);
    expect(second.links[0].ab + second.links[0].ba).toBeCloseTo((snapshot[0].ab + snapshot[0].ba) * 10, 6);
  });

  it('回線や LB から届かない入口・web・media には負荷が積まれず、下流にも流れない', () => {
    // 1. 回線から孤立した web+db には負荷がかからない
    const { s: s1, server: server1 } = base({ pv: 100 });
    const iso = server1('db', 20, ['blog:web', 'blog:db'], 0, -1);
    const f1 = run(s1);
    expect(f1.success).toBe(0);
    expect(f1.devices.get(iso)!.cpu).toBe(0);
    expect(f1.nodeLoads.get(iso)!.ioOps).toBe(0);

    // 2. LB から届かない web・media と、web から届かない db には負荷が積まれない
    const { s: s2, server: server2, lb } = base({ traffic: { blog: 0, photo: 100 }, unlocks: ['lb', 'shop', 'photo', 'cache'] });
    lb(38);
    const wOk = server2('web', 30, ['photo:web']);
    const wIso = server2('web', 31, ['photo:web'], 0, -1);
    const db = server2('db', 20, ['photo:db']);
    const cache = server2('small', 32, ['photo:cache']);
    const worker = server2('web', 33, ['photo:worker']);
    const mOk = server2('db', 16, ['photo:media']);
    const mIso = server2('db', 12, ['photo:media'], 0, -1);
    const f2 = run(s2);
    expect(f2.nodeLoads.get(wOk)!.work['photo:web']).toBeCloseTo(50 * (1 + 0.02), 3);
    expect(f2.nodeLoads.get(wIso)!.cpu).toBe(0);
    expect(f2.nodeLoads.get(mOk)!.work['photo:media']).toBeCloseTo(50 * SERVICES.photo.work.media!.perPv, 3);
    expect(f2.nodeLoads.get(mIso)!.cpu).toBe(0);
    expect(f2.nodeLoads.get(mIso)!.ioOps).toBe(0);
    // cache・worker・db にも wOk の半分ぶんしか流れない
    expect(f2.nodeLoads.get(cache)!.work['photo:cache']).toBeCloseTo(50 * SERVICES.photo.work.dbReads, 3);
    expect(f2.nodeLoads.get(worker)!.work['photo:worker']).toBeCloseTo(50 * SERVICES.photo.work.upload!.perPv, 3);
    expect(f2.nodeLoads.get(db)!.work['photo:db']).toBeCloseTo(
      50 * SERVICES.photo.work.dbReads * (1 - WORK.cacheHitRate) + 50 * (SERVICES.photo.work.dbWrites + SERVICES.photo.work.upload!.perPv),
      3,
    );

    // 3. 回線から届かない LB にも負荷が積まれず、下流にも流れない
    const { s: s3, server: server3 } = base({ pv: 100, unlocks: ['lb'] });
    const isoSw = s3.buyDevice('sw-24', 0, 35).id!;
    const isoLb = s3.buyDevice('lb-1u', 0, 34).id!;
    const isoWeb = server3('web', 30, ['blog:web'], 0, -1);
    const isoDb = server3('db', 20, ['blog:db'], 0, -1);
    wire(s3, { device: isoLb, port: 0 }, { device: isoSw, port: 0 });
    wire(s3, { device: isoWeb, port: 0 }, { device: isoSw, port: 1 });
    wire(s3, { device: isoDb, port: 0 }, { device: isoSw, port: 2 });
    const f3 = run(s3);
    expect(f3.success).toBe(0);
    expect(f3.devices.get(isoLb)!.cpu).toBe(0);
    expect(f3.devices.get(isoWeb)!.cpu).toBe(0);
    expect(f3.devices.get(isoDb)!.cpu).toBe(0);
  });
});
