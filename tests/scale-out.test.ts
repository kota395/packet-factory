import { describe, expect, it } from 'vitest';
import { BLOG_FEATURES, CDN, DB_SPLIT, SERVICES } from '../src/sim/config';
import { CDN_PRICE_PER_GB, UPKEEP } from '../src/sim/pricing';
import { wire, run, base } from './helpers';

describe('DB の分割・回線の多重化・CDN', () => {
  it('db は分割しないと 1 台。機能分割で書き込みは 2 台目へ、シャーディングで等分される', () => {
    const { s, server } = base({ pv: 200, unlocks: ['comments', 'replication'] });
    server('big', 30, ['blog:web']);
    const d1 = server('db', 20, ['blog:db']);
    const d2 = server('db', 16, ['blog:db']);
    let flow = run(s, 1000);
    expect(flow.problems.join()).toContain('機能分割');
    expect(flow.nodeLoads.get(d2)!.work['blog:db'] ?? 0).toBe(0);
    const writes = 200 * BLOG_FEATURES.commentWrites;
    const missOne = flow.nodeLoads.get(d1)!.miss['blog:db']!;

    s.unlock('partition');
    flow = run(s, 1000);
    // 書き込みはすべて 2 台目、読み込みは 7:3
    const reads = 200 * SERVICES.blog.work.dbReads;
    expect(flow.nodeLoads.get(d1)!.work['blog:db']).toBeCloseTo(reads * (1 - DB_SPLIT.functionalReadShare), 1);
    expect(flow.nodeLoads.get(d2)!.work['blog:db']).toBeCloseTo(reads * DB_SPLIT.functionalReadShare + writes, 1);
    // データが分かれたぶんメモリに乗りやすい
    expect(flow.nodeLoads.get(d1)!.miss['blog:db']!).toBeLessThan(missOne);

    s.unlock('sharding');
    const d3 = server('db', 12, ['blog:db']);
    const r1 = server('db', 8, ['blog:replica']);
    flow = run(s, 1000);
    for (const d of [d2, d3]) expect(flow.nodeLoads.get(d)!.work['blog:db']).toBeCloseTo(reads / 3 + writes / 3, 1);
    // レプリカは 1 台目の db の複製: その分の読み込みと、1 台目の書き込みの反映だけ
    expect(flow.nodeLoads.get(d1)!.work['blog:db']).toBeCloseTo(writes / 3, 1);
    expect(flow.nodeLoads.get(r1)!.work['blog:replica']).toBeCloseTo(reads / 3, 1);
    expect(flow.success).toBe(1);
  });

  it('回線を増やすと流れが分かれ、1 本止めても続く', () => {
    const { s, sw, server } = base({ pv: 50, unlocks: ['bgp'] });
    server('db', 20, ['blog:web', 'blog:db']);
    expect(s.buyDevice('handoff', 0, 38).ok).toBe(false);
    s.unlock('multihoming');
    const line2 = s.buyDevice('handoff', 0, 38).id!;
    expect(wire(s, { device: line2, port: 0 }, { device: sw, port: 20 }).ok).toBe(true);
    const flow = run(s, 1000);
    const lines = [...s.facility.devices.values()].filter((d) => d.model === 'handoff');
    const [l1, l2] = lines.map((h) => flow.links.find((l) => l.a === h.id || l.b === h.id)!);
    expect(l1.ab + l1.ba).toBeCloseTo(l2.ab + l2.ba, 6);
    expect(s.upkeep.uplink).toBeCloseTo(UPKEEP.uplinkByLevel[2] * 2);
    expect(s.setMaintenance(line2, true).ok).toBe(true);
    expect(run(s, 1000).success).toBe(1);
    expect(s.setMaintenance(lines.find((d) => d.id !== line2)!.id, true).ok).toBe(false);
  });

  it('CDN があると画像はオリジンを通らず、配った量だけ課金される', () => {
    const { s, isp, server } = base({ pv: 100, unlocks: ['images'] });
    server('db', 20, ['blog:web', 'blog:db']);
    const uplink = (f: ReturnType<typeof run>) => f.links.find((l) => l.a === isp || l.b === isp)!;
    const before = uplink(run(s, 1000));
    const outBefore = Math.max(before.ab, before.ba);
    expect(s.upkeep.cdn).toBe(0);
    s.unlock('cdn');
    const after = uplink(run(s, 1000));
    const page = SERVICES.blog.work.pageKB;
    const img = BLOG_FEATURES.imageKB;
    expect(Math.max(after.ab, after.ba) / outBefore).toBeCloseTo((page + img * (1 - CDN.hitRate)) / (page + img), 1);
    expect(s.upkeep.cdn).toBeCloseTo((100 * img * CDN.hitRate * CDN_PRICE_PER_GB) / 1e6, 6);
  });
});
