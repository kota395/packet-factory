import { describe, expect, it } from 'vitest';
import { BASE_MARKET, NODE_COST_GROWTH, NODE_DEFS, OFFLINE } from '../src/sim/config';
import { UPGRADE_BY_ID, upgradeCost } from '../src/sim/economy';
import { createSave, decodeSave, encodeSave, loadSave, newGame, offlineEarnings, parseSave } from '../src/sim/save';
import { Simulation, type SimOptions } from '../src/sim/simulation';

const constant = (rps: number) => () => rps;

/** 流量固定・全解放・資金たっぷりのテスト用シミュレーション */
function sim(opts: SimOptions = {}) {
  return new Simulation({
    seed: 42,
    startMoney: 1_000_000,
    unlocks: ['lb', 'writes'],
    writeShare: 0.25,
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

  it('DB が無いと静的は成功し、書き込みだけ失敗する', () => {
    const s = sim({ traffic: constant(20) });
    const web = s.addNode('web', 3, 4).id!;
    s.connect(s.internetId, web);
    s.step(10_000);
    expect(s.metrics.successByKind.static).toBeGreaterThan(0);
    expect(s.metrics.successByKind.write).toBe(0);
    expect(s.metrics.errorsByReason['no-route']).toBeGreaterThan(0);
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

  it('LB の処理上限を超えると LB で溢れ、LB チューニングで解消する', () => {
    const run = (lbPerf: number) => {
      const s = sim({ traffic: constant(700), writeShare: 0, upgrades: { lbPerf, webPerf: 6 } });
      build(s, 6, 0);
      s.step(15_000);
      const lb = [...s.nodes.values()].find((n) => n.kind === 'lb')!;
      return { lbErrors: lb.errors, cap: s.capacityRpsOf(lb) };
    };
    const base = run(0);
    expect(base.cap).toBeCloseTo((8 * 1000) / 20, 0); // 400 rps
    expect(base.lbErrors).toBeGreaterThan(0);
    const tuned = run(4);
    expect(tuned.cap).toBeGreaterThan(900);
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
    const s = sim({ traffic: constant(30), writeShare: 0 });
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
    const s = sim({ traffic: constant(40), writeShare: 0.5, upgrades: { webPerf: 2 } });
    build(s, 1, 1);
    s.step(10_000);
    const web = [...s.nodes.values()].find((n) => n.kind === 'web')!;
    const db = [...s.nodes.values()].find((n) => n.kind === 'db')!;
    // 静的 60ms と書き込み 30ms が半々 → 平均 45ms、×1.44 で速くなる
    expect(s.capacityRpsOf(web)).toBeGreaterThan(110);
    expect(s.capacityRpsOf(web)).toBeLessThan(145);
    expect(s.capacityRpsOf(db)).toBeCloseTo((4 * 1000) / 80, 0);
  });
});

describe('ノードの購入', () => {
  it('同じ種類を買うたびに価格が上がり、撤去で払った額の半分が戻る', () => {
    const s = new Simulation({ seed: 1, startMoney: 1000 });
    const first = s.nodeCost('web');
    expect(first).toBe(NODE_DEFS.web.cost);
    s.addNode('web', 2, 2);
    const second = s.nodeCost('web');
    expect(second).toBe(Math.round(NODE_DEFS.web.cost * NODE_COST_GROWTH));
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

  it('書き込みは会員機能を解放して DB を置くまで流れない', () => {
    const s = new Simulation({ seed: 1, startMoney: 1_000_000 });
    expect(s.writeShare).toBe(0);
    s.unlock('lb');
    s.unlock('writes');
    expect(s.writeShare).toBe(0); // DB を置くまでは流れない
    s.addNode('db', 5, 5);
    expect(s.writeShare).toBeGreaterThan(0);
  });

  it('WEB チューニングで 1 台あたりの処理能力が上がる', () => {
    const run = (level: number) => {
      const s = sim({ traffic: constant(110), writeShare: 0, upgrades: { webPerf: level } });
      const w = s.addNode('web', 2, 4).id!;
      s.connect(s.internetId, w);
      s.step(20_000);
      return s.metrics.availability;
    };
    expect(run(4)).toBeGreaterThan(run(0) + 0.2);
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
    build(a, 3, 2);
    a.buyUpgrade('marketing');
    a.step(5_000);
    const save = createSave(a, 1_000);
    const decoded = decodeSave(encodeSave(save));
    expect(decoded).toEqual(save);

    const b = loadSave(decoded!, 7);
    const again = createSave(b, 1_000);
    expect({ ...again, incomePerSec: 0 }).toEqual({ ...save, incomePerSec: 0 });
    expect(b.money).toBe(a.money); // 復元でお金は引かれない
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
    expect(parseSave({ ...save, unlocks: ['cheat'] })).toBeNull();
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
