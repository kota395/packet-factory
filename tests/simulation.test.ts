import { describe, expect, it } from 'vitest';
import { BASE_MARKET, DATA_SIZE_KB, INTERNET_POS, NODE_DEFS, OFFLINE } from '../src/sim/config';
import { NODE_PRICES, PRICE_SCALE, START_MONEY, UNLOCK_PRICES, UPGRADE_PRICES } from '../src/sim/pricing';
import { UPGRADE_BY_ID, unlockCost, upgradeCost } from '../src/sim/economy';
import { createSave, decodeSave, encodeSave, loadSave, newGame, offlineEarnings, parseSave } from '../src/sim/save';
import { Simulation, type SimOptions } from '../src/sim/simulation';

const constant = (rps: number) => () => rps;

/** 流量固定・全解放・資金たっぷりのテスト用シミュレーション */
function sim(opts: SimOptions = {}) {
  return new Simulation({
    seed: 42,
    startMoney: 1_000_000,
    unlocks: ['lb', 'writes'],
    dataShare: 0.25,
    ...opts,
  });
}

/** NET → LB → WEB×webs → DB×dbs の標準構成を作る */
function build(s: Simulation, webs: number, dbs: number) {
  const lb = s.addNode('lb', 2, 4).id!;
  expect(s.connect(s.internetId, lb).ok).toBe(true);
  const dbIds = Array.from({ length: dbs }, (_, i) => s.addNode('db', 8, 2 + i).id!);
  for (let i = 0; i < webs; i++) {
    const w = s.addNode('web', 5, 1 + i).id!;
    expect(s.connect(lb, w).ok).toBe(true);
    for (const d of dbIds) expect(s.connect(w, d).ok).toBe(true);
  }
}

describe('ルーティング', () => {
  it('接続先がなければ全リクエストが no-route で失敗する', () => {
    const s = sim({ traffic: constant(50) });
    s.step(5_000);
    expect(s.metrics.totalSuccess).toBe(0);
    expect(s.metrics.totalErrors).toBeGreaterThan(0);
    expect(s.metrics.errorsByReason['no-route']).toBe(s.metrics.totalErrors);
  });

  it('DB が無い、または未接続の WEB は転送せず、エラーにもならない', () => {
    const s = sim({ traffic: constant(20) });
    const web = s.addNode('web', 3, 4).id!;
    s.connect(s.internetId, web);
    s.addNode('db', 5, 5); // 置いただけで未接続
    s.step(10_000);
    expect(s.metrics.successByKind.static).toBeGreaterThan(0);
    expect(s.metrics.totalErrors).toBe(0);
    expect(s.nodes.get(web)!.out.length).toBe(0);
  });

  it('十分な構成なら可用性はほぼ 100% になる', () => {
    const s = sim({ traffic: constant(40) });
    build(s, 2, 1);
    s.step(30_000);
    expect(s.metrics.totalSuccess).toBeGreaterThan(1000);
    expect(s.metrics.availability).toBeGreaterThan(0.999);
    expect(s.metrics.successByKind.write).toBeGreaterThan(0);
  });

  it('処理能力を超えるとキューが溢れて drop が発生する', () => {
    const s = sim({ traffic: constant(200) });
    build(s, 1, 1);
    s.step(10_000);
    expect(s.metrics.errorsByReason.drop).toBeGreaterThan(0);
    expect(s.metrics.availability).toBeLessThan(0.9);
  });

  it('LB は処理能力が高く、テキストだけなら大量に流しても詰まらない', () => {
    const s = sim({ traffic: constant(700), dataShare: 0, upgrades: { webPerf: 6 } });
    build(s, 6, 0);
    s.step(15_000);
    const lb = [...s.nodes.values()].find((n) => n.kind === 'lb')!;
    expect(lb.errors).toBe(0);
    expect(s.cpuCapacityRpsOf(lb)).toBeCloseTo((64 * 1000) / 2, 0); // 32,000 rps
    // 50 MB/秒 ÷ 20 KB = 2,500 rps
    expect(s.bandwidthCapacityRpsOf(lb)).toBeCloseTo((50 * 1000) / 20, -1);
  });

  it('画像で重くなると LB の帯域で溢れ、回線増強で解消する', () => {
    const run = (lbBandwidth: number) => {
      const s = sim({
        traffic: constant(700),
        dataShare: 0,
        unlocks: ['lb', 'writes', 'images'],
        upgrades: { lbBandwidth, webPerf: 6 },
      });
      build(s, 6, 0);
      s.step(15_000);
      const lb = [...s.nodes.values()].find((n) => n.kind === 'lb')!;
      return { lbErrors: lb.errors, cap: s.capacityRpsOf(lb) };
    };
    const base = run(0);
    expect(base.cap).toBeCloseTo((50 * 1000) / 100, -1); // 画像込み 100KB → 500 rps
    expect(base.lbErrors).toBeGreaterThan(0);
    const tuned = run(2); // ×2.25 → 約 1,125 rps
    expect(tuned.cap).toBeGreaterThan(1000);
    expect(tuned.lbErrors).toBe(0);
  });
});

describe('接続ルール', () => {
  it('接続できない組み合わせを拒否する', () => {
    const s = sim();
    const lb = s.addNode('lb', 2, 4).id!;
    const web = s.addNode('web', 4, 4).id!;
    const db = s.addNode('db', 6, 4).id!;
    expect(s.connect(web, lb).ok).toBe(false); // WEB → LB
    expect(s.connect(db, web).ok).toBe(false); // DB からは出せない
    expect(s.connect(s.internetId, db).ok).toBe(false); // NET → DB
    expect(s.connect(lb, lb).ok).toBe(false); // 自己ループ
    expect(s.connect(lb, db).ok).toBe(false); // LB → DB
  });

  it('インターネットの接続先は 1 つだけ', () => {
    const s = sim();
    const a = s.addNode('web', 2, 3).id!;
    const b = s.addNode('web', 2, 5).id!;
    expect(s.connect(s.internetId, a).ok).toBe(true);
    expect(s.connect(s.internetId, b).ok).toBe(false);
  });

  it('toggleEdge で接続と解除を切り替える', () => {
    const s = sim();
    const web = s.addNode('web', 2, 4).id!;
    expect(s.toggleEdge(s.internetId, web).ok).toBe(true);
    expect(s.hasEdge(s.internetId, web)).toBe(true);
    expect(s.toggleEdge(s.internetId, web).ok).toBe(true);
    expect(s.hasEdge(s.internetId, web)).toBe(false);
  });
});

describe('ノードの移動と受信量', () => {
  it('空いているマスへ移動でき、接続は保たれる', () => {
    const s = sim();
    const web = s.addNode('web', 3, 4).id!;
    s.connect(s.internetId, web);
    expect(s.moveNode(web, 6, 2).ok).toBe(true);
    expect(s.nodeAt(6, 2)?.id).toBe(web);
    expect(s.nodeAt(3, 4)).toBeUndefined();
    expect(s.hasEdge(s.internetId, web)).toBe(true);
    expect(s.moveNode(s.internetId, 0, 0).ok).toBe(true); // インターネットも動かせる
  });

  it('使用中のマスや盤面の外には動かせない', () => {
    const s = sim();
    const a = s.addNode('web', 3, 4).id!;
    s.addNode('web', 4, 4);
    expect(s.moveNode(a, 4, 4).ok).toBe(false);
    expect(s.moveNode(a, -1, 0).ok).toBe(false);
    expect(s.moveNode(a, 99, 0).ok).toBe(false);
  });

  it('届いている量と処理上限を測れる', () => {
    const s = sim({ traffic: constant(30), dataShare: 0 });
    const web = s.addNode('web', 3, 4).id!;
    s.connect(s.internetId, web);
    s.step(10_000);
    const node = s.nodes.get(web)!;
    expect(s.inRpsOf(node)).toBeGreaterThan(22);
    expect(s.inRpsOf(node)).toBeLessThan(38);
    expect(s.inRpsOf(s.nodes.get(s.internetId)!)).toBeGreaterThan(22);
    // 4 並列 × 60ms → 約 66.7 rps
    expect(s.capacityRpsOf(node)).toBeCloseTo((4 * 1000) / 60, 0);
  });

  it('処理上限は届く種類の割合と強化を反映する', () => {
    const s = sim({ traffic: constant(40), dataShare: 0.5, upgrades: { webPerf: 2 } });
    build(s, 1, 1);
    s.step(10_000);
    const web = [...s.nodes.values()].find((n) => n.kind === 'web')!;
    const db = [...s.nodes.values()].find((n) => n.kind === 'db')!;
    // WEB は全リクエストを 60ms で処理し、スケールアップ 2 回で ×1.44 速くなる
    expect(s.capacityRpsOf(web)).toBeCloseTo((4 * 1000 * 1.44) / 60, 0);
    // DB(16 並列)は読み込み 60ms・書き込み 100ms が 8:2 → 平均 68ms 前後
    expect(s.capacityRpsOf(db)).toBeGreaterThan((16 * 1000) / 80);
    expect(s.capacityRpsOf(db)).toBeLessThan((16 * 1000) / 60);
  });
});

describe('データ層', () => {
  const ofKind = (s: Simulation, kind: string) => [...s.nodes.values()].filter((n) => n.kind === kind);

  /** NET → LB → WEB×2 → (キャッシュ) → DB (→ レプリカ) */
  function dataTier(s: Simulation, opts: { cache?: boolean; replicas?: number; feed?: boolean } = {}) {
    const lb = s.addNode('lb', 1, 4).id!;
    s.connect(s.internetId, lb);
    const db = s.addNode('db', 10, 4).id!;
    const replicas = Array.from({ length: opts.replicas ?? 0 }, (_, i) => s.addNode('replica', 12, 3 + i).id!);
    if (opts.feed !== false) for (const r of replicas) expect(s.connect(db, r).ok).toBe(true);
    const cache = opts.cache ? s.addNode('cache', 7, 4).id! : null;
    if (cache) {
      s.connect(cache, db);
      for (const r of replicas) s.connect(cache, r);
    }
    for (let i = 0; i < 2; i++) {
      const w = s.addNode('web', 4, 3 + i).id!;
      s.connect(lb, w);
      s.connect(w, db);
      if (cache) s.connect(w, cache);
      for (const r of replicas) s.connect(w, r);
    }
  }

  const all = { unlocks: ['lb', 'writes', 'cache', 'replica', 'sharding'] as const };

  it('キャッシュがあれば読み込みはキャッシュへ行き、当たらなかった分だけ DB に届く', () => {
    const s = sim({ traffic: constant(60), dataShare: undefined, unlocks: all.unlocks });
    dataTier(s, { cache: true });
    s.step(30_000);
    const [cache] = ofKind(s, 'cache');
    const [db] = ofKind(s, 'db');
    expect(cache.inRps.read).toBeGreaterThan(5);
    expect(cache.inRps.write).toBe(0);
    // 基本ヒット率 70% → 外れの 30% だけ DB へ
    expect(db.inRps.read / cache.inRps.read).toBeGreaterThan(0.18);
    expect(db.inRps.read / cache.inRps.read).toBeLessThan(0.42);
    expect(db.inRps.write).toBeGreaterThan(0);
    expect(s.metrics.totalErrors).toBe(0);
  });

  it('レプリカは DB から複製を受けていれば読み込みを肩代わりし、書き込みの反映も負担する', () => {
    const s = sim({ traffic: constant(60), dataShare: undefined, unlocks: all.unlocks });
    dataTier(s, { replicas: 2 });
    s.step(30_000);
    const [db] = ofKind(s, 'db');
    const replicas = ofKind(s, 'replica');
    // 読み込みは優先度の高いレプリカへ。DB は書き込みだけ
    expect(db.inRps.read).toBe(0);
    expect(db.inRps.write).toBeGreaterThan(0);
    for (const r of replicas) {
      expect(r.inRps.read).toBeGreaterThan(1);
      // 書き込みはすべて複製される
      expect(r.inRps.write / db.inRps.write).toBeGreaterThan(0.75);
      expect(r.inRps.write / db.inRps.write).toBeLessThan(1.33);
    }
    // 複製は利用者のリクエストではないので、売上やエラーに数えない
    expect(s.metrics.successByKind.write).toBeGreaterThan(0);
    expect(s.metrics.totalErrors).toBe(0);
  });

  it('複製元のないレプリカには読み込みが送られない', () => {
    const s = sim({ traffic: constant(60), dataShare: undefined, unlocks: all.unlocks });
    dataTier(s, { replicas: 1, feed: false });
    s.step(20_000);
    const [db] = ofKind(s, 'db');
    const [replica] = ofKind(s, 'replica');
    expect(s.isFed(replica)).toBe(false);
    expect(s.inRpsOf(replica)).toBe(0);
    expect(db.inRps.read).toBeGreaterThan(0);
    expect(s.metrics.totalErrors).toBe(0);
  });

  it('DB(プライマリ)は 1 台まで。シャード追加で増やせる', () => {
    const s = new Simulation({ seed: 1, startMoney: 10_000_000, unlocks: ['lb', 'writes', 'replica'] });
    expect(s.addNode('db', 5, 5).ok).toBe(true);
    expect(s.addNode('db', 5, 6).ok).toBe(false);
    expect(s.buyUpgrade('dbShards').ok).toBe(false); // シャーディングの解放が必要
    expect(s.unlock('sharding').ok).toBe(true);
    expect(s.buyUpgrade('dbShards').ok).toBe(true);
    expect(s.maxCountOf('db')).toBe(2);
    expect(s.addNode('db', 5, 6).ok).toBe(true);
    // レプリカは何台でも置ける
    for (let i = 0; i < 5; i++) expect(s.addNode('replica', 8, i).ok).toBe(true);
  });

  it('書き込みはシャード(複数のプライマリ)に分散する', () => {
    const s = sim({ traffic: constant(60), dataShare: undefined, unlocks: all.unlocks, upgrades: { dbShards: 1 } });
    const w = s.addNode('web', 3, 4).id!;
    s.connect(s.internetId, w);
    for (let i = 0; i < 2; i++) s.connect(w, s.addNode('db', 6, 3 + i).id!);
    s.step(30_000);
    const dbs = ofKind(s, 'db');
    expect(dbs).toHaveLength(2);
    const [a, b] = dbs.map((d) => d.processed);
    expect(a).toBeGreaterThan(50);
    expect(Math.abs(a - b) / (a + b)).toBeLessThan(0.15);
  });

  it('スケールアップはレプリカにも効き、キャッシュ容量拡張でヒット率が上がる', () => {
    const s = sim({ unlocks: all.unlocks });
    const cache = s.nodes.get(s.addNode('cache', 3, 3).id!)!;
    const replica = s.nodes.get(s.addNode('replica', 4, 4).id!)!;
    const base = s.cacheHitRateOf(cache);
    const before = s.serviceMs(replica, 'read');
    s.buyUpgrade('cacheMemory');
    s.buyUpgrade('dbPerf');
    expect(s.cacheHitRateOf(cache)).toBeGreaterThan(base);
    expect(s.serviceMs(replica, 'read')).toBeLessThan(before);
  });
});

describe('CDN', () => {
  /** NET → CDN → LB → WEB×webs の構成 */
  function withCdn(s: Simulation, webs: number) {
    const cdn = s.addNode('cdn', 1, 4).id!;
    const lb = s.addNode('lb', 3, 4).id!;
    expect(s.connect(s.internetId, cdn).ok).toBe(true);
    expect(s.connect(cdn, lb).ok).toBe(true);
    for (let i = 0; i < webs; i++) s.connect(lb, s.addNode('web', 6, 1 + i).id!);
    return { cdn: s.nodes.get(cdn)!, lb: s.nodes.get(lb)! };
  }

  it('導入するまで置けず、置けるのは 1 つだけ', () => {
    const s = new Simulation({ seed: 1, startMoney: 1_000_000, unlocks: ['lb'] });
    expect(s.addNode('cdn', 1, 4).ok).toBe(false);
    s.unlock('images');
    s.unlock('cdn');
    expect(s.addNode('cdn', 1, 4).ok).toBe(true);
    expect(s.addNode('cdn', 1, 5).ok).toBe(false);
  });

  it('静的リクエストの一部を CDN で返し、LB に届く量が減る', () => {
    const s = sim({ traffic: constant(300), dataShare: 0, unlocks: ['lb', 'writes', 'images', 'cdn'] });
    const { cdn, lb } = withCdn(s, 6);
    s.step(15_000);
    expect(s.metrics.availability).toBeGreaterThan(0.99);
    expect(s.cacheHitRateOf(cdn)).toBeCloseTo(0.6);
    // ヒット率 60% → LB にはおよそ 4 割しか届かない
    expect(s.inRpsOf(lb) / s.inRpsOf(cdn)).toBeGreaterThan(0.3);
    expect(s.inRpsOf(lb) / s.inRpsOf(cdn)).toBeLessThan(0.5);
    expect(cdn.hitRps).toBeGreaterThan(150);
    expect(s.edgeRpsOf(cdn.id, lb.id)).toBeCloseTo(s.inRpsOf(lb), -1);
  });

  it('画像で LB の帯域が足りなくても、CDN を挟めば捌ける', () => {
    const run = (useCdn: boolean) => {
      const s = sim({ traffic: constant(700), dataShare: 0, unlocks: ['lb', 'writes', 'images', 'cdn'], upgrades: { webPerf: 6 } });
      if (useCdn) withCdn(s, 6);
      else build(s, 6, 0);
      s.step(15_000);
      return s.metrics.availability;
    };
    expect(run(false)).toBeLessThan(0.9);
    expect(run(true)).toBeGreaterThan(0.99);
  });

  it('キャッシュ拡張でヒット率が上がり、回線増強で帯域が増える', () => {
    const s = sim({ unlocks: ['lb', 'writes', 'images', 'cdn'], upgrades: { cdnCache: 2, cdnBandwidth: 1 } });
    const cdn = s.nodes.get(s.addNode('cdn', 1, 4).id!)!;
    expect(s.cacheHitRateOf(cdn)).toBeCloseTo(1 - 0.4 * 0.75 ** 2);
    expect(s.bandwidthMBpsOf(cdn)).toBeCloseTo(NODE_DEFS.cdn.bandwidthMBps! * 1.5);
  });

  it('つなげる向きは NET → CDN → LB / WEB', () => {
    const s = sim({ unlocks: ['lb', 'writes', 'images', 'cdn'] });
    const cdn = s.addNode('cdn', 1, 4).id!;
    const web = s.addNode('web', 3, 4).id!;
    const db = s.addNode('db', 5, 4).id!;
    expect(s.connect(cdn, db).ok).toBe(false);
    expect(s.connect(web, cdn).ok).toBe(false);
    expect(s.connect(cdn, web).ok).toBe(true);
    expect(s.connect(s.internetId, cdn).ok).toBe(true);
  });
});

describe('ノードごとの統計', () => {
  it('失敗の内訳・待ち時間・接続ごとの流量を数える', () => {
    const s = sim({ traffic: constant(200), dataShare: 0 });
    build(s, 1, 0); // WEB 1 台(約 66 rps)に 200 rps
    s.step(10_000);
    const web = [...s.nodes.values()].find((n) => n.kind === 'web')!;
    const lb = [...s.nodes.values()].find((n) => n.kind === 'lb')!;
    expect(web.errorsBy.drop).toBeGreaterThan(0);
    expect(web.waitMs).toBeGreaterThan(50);
    expect(web.servedRps).toBeGreaterThan(50);
    expect(s.edgeRpsOf(lb.id, web.id)).toBeGreaterThan(150);
  });
});

describe('価格の設定', () => {
  it('初期資金・解放・強化の価格は pricing.ts の値(初回価格 × 倍率^回数 × 全体倍率)で決まる', () => {
    expect(new Simulation().money).toBe(START_MONEY);
    const s = new Simulation({ seed: 1, startMoney: 1e9 });
    const m = UPGRADE_PRICES.marketing;
    expect(s.upgradeCost('marketing')).toBe(Math.round(m.first * PRICE_SCALE));
    s.buyUpgrade('marketing');
    s.buyUpgrade('marketing');
    expect(s.upgradeCost('marketing')).toBe(Math.round(m.first * m.growth ** 2 * PRICE_SCALE));
    expect(unlockCost('cache')).toBe(Math.round(UNLOCK_PRICES.cache * PRICE_SCALE));
    expect(s.upkeepOf('cdn')).toBe(NODE_PRICES.cdn.upkeep);
  });
});

describe('ノードの購入', () => {
  it('同じ種類を買うたびに価格が上がり、撤去で払った額の半分が戻る', () => {
    const s = new Simulation({ seed: 1, startMoney: 1000 });
    const first = s.nodeCost('web');
    expect(first).toBe(NODE_PRICES.web.first);
    s.addNode('web', 2, 2);
    const second = s.nodeCost('web');
    expect(second).toBe(Math.round(NODE_PRICES.web.first * NODE_PRICES.web.growth));
    const id = s.addNode('web', 2, 3).id!;
    const before = s.money;
    s.removeNode(id);
    expect(s.money).toBe(before + Math.floor(second / 2));
  });

  it('資金が足りなければ配置できない', () => {
    const s = new Simulation({ seed: 1, startMoney: 10 });
    expect(s.addNode('web', 2, 2).ok).toBe(false);
  });

  it('LB はサービス 1 つにつき 1 台まで(復元は例外)', () => {
    const s = sim();
    expect(s.addNode('lb', 2, 2).ok).toBe(true);
    expect(s.isAtMaxCount('lb')).toBe(true);
    expect(s.addNode('lb', 2, 3).ok).toBe(false);
    expect(s.addNode('lb', 2, 3, { free: true }).ok).toBe(true); // 古いセーブの復元
    expect(s.addNode('web', 2, 5).ok).toBe(true); // WEB は無制限
  });

  it('解放前の LB / DB は配置できない', () => {
    const s = new Simulation({ seed: 1, startMoney: 10_000 });
    expect(s.addNode('lb', 2, 2).ok).toBe(false);
    expect(s.addNode('db', 3, 2).ok).toBe(false);
    expect(s.unlock('lb').ok).toBe(true);
    expect(s.addNode('lb', 2, 2).ok).toBe(true);
    expect(s.addNode('db', 3, 2).ok).toBe(false);
  });

  it('撤去したノードへの接続も消える', () => {
    const s = sim();
    const web = s.addNode('web', 2, 4).id!;
    s.connect(s.internetId, web);
    s.removeNode(web);
    expect(s.nodes.get(s.internetId)!.out).toEqual([]);
  });
});

describe('投資', () => {
  it('強化は買うたびに価格が上がり、効果が反映される', () => {
    const s = new Simulation({ seed: 1, startMoney: 10_000 });
    const def = UPGRADE_BY_ID.marketing;
    expect(s.marketSize).toBe(BASE_MARKET);
    const cost0 = s.upgradeCost('marketing');
    expect(s.buyUpgrade('marketing').ok).toBe(true);
    expect(s.money).toBe(10_000 - cost0);
    expect(s.marketSize).toBeCloseTo(def.effect(1));
    expect(s.upgradeCost('marketing')).toBe(upgradeCost(def, 1));
    expect(s.upgradeCost('marketing')).toBeGreaterThan(cost0);
  });

  it('前提の解放が無い強化は買えない', () => {
    const s = new Simulation({ seed: 1, startMoney: 1_000_000 });
    expect(s.buyUpgrade('dbPerf').ok).toBe(false);
    expect(s.unlock('writes').ok).toBe(false); // LB が先
    s.unlock('lb');
    s.unlock('writes');
    expect(s.buyUpgrade('dbPerf').ok).toBe(true);
  });

  it('WEB に届いたリクエストの約 1/5 が接続済みの DB に流れる', () => {
    const s = sim({ traffic: constant(60), dataShare: undefined });
    build(s, 2, 1);
    s.step(30_000);
    // 受信量(rps)は直近数秒の平滑値でぶれるので、累計の完了数で比べる
    const { static: st, read, write } = s.metrics.successByKind;
    expect((read + write) / (st + read + write)).toBeGreaterThan(0.17);
    expect((read + write) / (st + read + write)).toBeLessThan(0.23);
    // そのうち 8 割が読み込み
    expect(read / (read + write)).toBeGreaterThan(0.74);
    expect(read / (read + write)).toBeLessThan(0.86);
    expect(s.metrics.totalErrors).toBe(0);
  });

  it('WEB チューニングで 1 台あたりの処理能力が上がる', () => {
    const run = (level: number) => {
      const s = sim({ traffic: constant(110), dataShare: 0, upgrades: { webPerf: level } });
      const w = s.addNode('web', 2, 4).id!;
      s.connect(s.internetId, w);
      s.step(20_000);
      return s.metrics.availability;
    };
    expect(run(4)).toBeGreaterThan(run(0) + 0.2);
  });

  it('配信コンテンツで単価とデータ量が上がり、オフにすると戻る', () => {
    const s = new Simulation({ seed: 1, startMoney: 1_000_000 });
    const rev = s.revenueOf('static');
    const size = s.dataSizeKB('static');
    s.unlock('lb');
    expect(s.unlock('video').ok).toBe(false); // 画像が先
    expect(s.unlock('images').ok).toBe(true);
    expect(s.revenueOf('static')).toBeCloseTo(rev * 2);
    expect(s.dataSizeKB('static')).toBeCloseTo(size * 5);
    expect(s.dataSizeKB('write')).toBe(DATA_SIZE_KB.write); // 書き込みは変わらない
    s.unlock('video');
    expect(s.dataSizeKB('static')).toBeCloseTo(size * 40);
    expect(s.setFeatureEnabled('video', false).ok).toBe(true);
    expect(s.dataSizeKB('static')).toBeCloseTo(size * 5);
    expect(s.setFeatureEnabled('lb', false).ok).toBe(false); // 効果のない解放は切り替えられない
  });

  it('収益化の改善で 1 件あたりの収益が増える', () => {
    const s = new Simulation({ seed: 1, startMoney: 1000 });
    const base = s.revenueOf('static');
    s.buyUpgrade('monetize');
    expect(s.revenueOf('static')).toBeCloseTo(base * UPGRADE_BY_ID.monetize.effect(1));
  });
});

describe('ユーザー', () => {
  it('余裕のある構成ならユーザーは市場規模に向かって増える', () => {
    const s = newGame(3);
    const start = s.users;
    s.step(120_000);
    expect(s.users).toBeGreaterThan(start * 2);
    expect(s.users).toBeLessThanOrEqual(s.marketSize * 1.01);
    expect(s.money).toBeGreaterThan(0);
  });

  it('捌けないと離脱して減る', () => {
    const s = new Simulation({ seed: 3, startUsers: 5000 });
    s.step(30_000); // 接続先なし = 全部エラー
    expect(s.users).toBeLessThan(1000);
  });

  it('処理能力を超えるユーザーは定着しない', () => {
    // WEB 1 台(約 66 rps = 6,600 人)に対して市場規模を大きくしておく
    const s = new Simulation({ seed: 5, upgrades: { marketing: 8 } });
    const w = s.addNode('web', 2, 4, { free: true }).id!;
    s.connect(s.internetId, w);
    s.users = 3000;
    s.step(300_000);
    expect(s.marketSize).toBeGreaterThan(30_000);
    expect(s.users).toBeLessThan(12_000);
  });
});

describe('セーブ', () => {
  it('保存 → 文字列化 → 復元で同じ状態になる', () => {
    const a = sim({ traffic: undefined });
    build(a, 3, 1);
    a.buyUpgrade('marketing');
    a.unlock('images');
    a.setFeatureEnabled('images', false);
    a.step(5_000);
    const save = createSave(a, 1_000);
    const decoded = decodeSave(encodeSave(save));
    expect(decoded).toEqual(save);

    const b = loadSave(decoded!, 7);
    const again = createSave(b, 1_000);
    expect({ ...again, incomePerSec: 0 }).toEqual({ ...save, incomePerSec: 0 });
    expect(b.money).toBe(a.money); // 復元でお金は引かれない
  });

  it('16×9 時代のセーブは、インターネットとの位置関係を保ったままずらして読み込む', () => {
    const save = createSave(newGame(1), 1_000);
    const { layout: _, ...legacy } = save;
    const old = { ...legacy, nodes: [['web', 3, 4, 0]] as const };
    const parsed = parseSave(JSON.parse(JSON.stringify(old)))!;
    expect(parsed.layout).toBe(2);
    expect(parsed.nodes[0][1] - INTERNET_POS.x).toBe(3);
    expect(parsed.nodes[0][2] - INTERNET_POS.y).toBe(0);
  });

  it('難易度オプションがオフなら、流量は平均どおり一定に届く', () => {
    const s = sim({ traffic: constant(37) });
    s.step(10_000);
    const net = s.nodes.get(s.internetId)!;
    expect(Math.round(s.inRpsOf(net))).toBe(37);
  });

  it('localStorage 経由(JSON)でも検証して読み込める', () => {
    const save = createSave(newGame(1), 1_000);
    expect(parseSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });

  it('壊れたデータは null になる', () => {
    expect(decodeSave('not-base64!!')).toBeNull();
    const save = createSave(newGame(1), 1_000);
    expect(parseSave({ ...save, v: 1 })).toBeNull();
    expect(parseSave({ ...save, nodes: [['internet', 1, 1, 0]] })).toBeNull();
    expect(parseSave({ ...save, nodes: [['web', 99, 1, 0]] })).toBeNull();
    expect(parseSave({ ...save, unlocks: [42] })).toBeNull();
  });

  it('知らない解放は読み飛ばし、名前を変えた強化は引き継ぐ', () => {
    const save = createSave(newGame(1), 1_000);
    const old = { ...save, unlocks: ['lb', 'removed-feature'], upgrades: { marketing: 2, lbPerf: 3 } };
    delete (old as Partial<typeof old>).disabled; // 古いセーブには無い
    const parsed = parseSave(old)!;
    expect(parsed.unlocks).toEqual(['lb']);
    expect(parsed.disabled).toEqual([]);
    expect(parsed.upgrades.lbBandwidth).toBe(3);
    expect(parsed.upgrades.marketing).toBe(2);
  });

  it('放置収入は効率と上限を反映する', () => {
    const save = { ...createSave(newGame(1), 0), incomePerSec: 2 };
    expect(offlineEarnings(save, 10_000).gained).toBe(0); // 短すぎる
    expect(offlineEarnings(save, 100_000).gained).toBeCloseTo(2 * 100 * OFFLINE.efficiency);
    const capped = offlineEarnings(save, OFFLINE.maxMs * 3).gained;
    expect(capped).toBeCloseTo(2 * (OFFLINE.maxMs / 1000) * OFFLINE.efficiency);
    expect(offlineEarnings({ ...save, incomePerSec: -1 }, 100_000).gained).toBe(0);
  });
});

it('同じシードなら結果が再現する', () => {
  const run = () => {
    const s = newGame(9);
    s.step(60_000);
    return [s.metrics.totalSuccess, s.metrics.totalErrors, s.money, s.users];
  };
  expect(run()).toEqual(run());
});
