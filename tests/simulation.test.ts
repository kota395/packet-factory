import { describe, expect, it } from 'vitest';
import { NODE_DEFS, START_MONEY } from '../src/sim/config';
import { applyLayout, decodeLayout, encodeLayout, exportLayout } from '../src/sim/layout';
import { Simulation, type SimOptions } from '../src/sim/simulation';

const constant = (rps: number) => () => rps;

function sim(opts: SimOptions = {}) {
  return new Simulation({ seed: 42, startMoney: 10_000, durationMs: 60_000, ...opts });
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

  it('LB 同士のループは MAX_HOPS で打ち切られる', () => {
    const s = sim({ traffic: constant(10) });
    const a = s.addNode('lb', 2, 2).id!;
    const b = s.addNode('lb', 3, 2).id!;
    s.connect(s.internetId, a);
    s.connect(a, b);
    s.connect(b, a);
    s.step(5_000);
    expect(s.metrics.totalSuccess).toBe(0);
    expect(s.metrics.errorsByReason['no-route']).toBeGreaterThan(0);
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

describe('経済', () => {
  it('配置で費用が引かれ、撤去で半額戻る', () => {
    const s = new Simulation({ seed: 1 });
    const id = s.addNode('db', 3, 3).id!;
    expect(s.money).toBe(START_MONEY - NODE_DEFS.db.cost);
    s.removeNode(id);
    expect(s.money).toBe(START_MONEY - NODE_DEFS.db.cost / 2);
  });

  it('予算が足りなければ配置できない', () => {
    const s = new Simulation({ seed: 1, startMoney: 50 });
    expect(s.addNode('web', 2, 2).ok).toBe(false);
  });

  it('撤去したノードへの接続も消える', () => {
    const s = sim();
    const web = s.addNode('web', 2, 4).id!;
    s.connect(s.internetId, web);
    s.removeNode(web);
    expect(s.nodes.get(s.internetId)!.out).toEqual([]);
  });

  it('予算が尽きると破産で終了する', () => {
    const s = new Simulation({ seed: 1, startMoney: 300, traffic: constant(0) });
    s.addNode('db', 3, 3);
    s.step(10_000);
    expect(s.status).toBe('bankrupt');
  });
});

describe('ステージ終了', () => {
  it('SLA を満たせばクリア、満たさなければ失敗', () => {
    const ok = sim({ traffic: constant(20), durationMs: 10_000 });
    build(ok, 1, 1);
    ok.step(11_000);
    expect(ok.status).toBe('cleared');

    const ng = sim({ traffic: constant(20), durationMs: 10_000 });
    ng.step(11_000);
    expect(ng.status).toBe('failed');
  });

  it('同じシードなら結果が再現する', () => {
    const run = () => {
      const s = sim({ traffic: constant(80) });
      build(s, 2, 1);
      s.step(20_000);
      return [s.metrics.totalSuccess, s.metrics.totalErrors, s.money];
    };
    expect(run()).toEqual(run());
  });
});

describe('構成の保存と共有', () => {
  it('エンコード → デコード → 適用で同じ構成になる', () => {
    const a = sim();
    build(a, 3, 2);
    const layout = exportLayout(a);
    const decoded = decodeLayout(encodeLayout(layout));
    expect(decoded).toEqual(layout);

    const b = sim();
    const r = applyLayout(b, decoded!);
    expect(r.skipped).toBe(0);
    expect(exportLayout(b)).toEqual(layout);
  });

  it('壊れたデータは null になる', () => {
    expect(decodeLayout('not-base64!!')).toBeNull();
    expect(decodeLayout(encodeLayout({ v: 1, nodes: [['internet' as never, 1, 1]], edges: [] }))).toBeNull();
    expect(decodeLayout(encodeLayout({ v: 1, nodes: [['web', 99, 1]], edges: [] }))).toBeNull();
  });
});
