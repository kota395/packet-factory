import { describe, expect, it } from 'vitest';
import { K8S, SERVICES } from '../src/sim/config';
import { POD_ID_BASE, computeFlow } from '../src/sim/flow';
import { createSave, decodeSave, encodeSave, loadSave } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import type { UnlockId } from '../src/sim/types';
import { run, base } from './helpers';

describe('Kubernetes', () => {
  /** db はサーバ、web は Pod。ワーカーを 2 台 */
  function cluster(pv: number, unlocks: UnlockId[] = []) {
    const b = base({ pv, unlocks: ['kubernetes', ...unlocks] });
    b.server('db', 10, ['blog:db']);
    const w1 = b.server('web', 20, []);
    const w2 = b.server('web', 22, []);
    expect(b.s.setK8sWorker({ device: w1 }, true).ok).toBe(true);
    expect(b.s.setK8sWorker({ device: w2 }, true).ok).toBe(true);
    return { ...b, w1, w2 };
  }
  const webPods = (s: Simulation) => s.pods.filter((p) => p.role === 'blog:web').reduce((n, p) => n + p.count, 0);

  it('ワーカーには役割を付けられず、状態を持つ役割は Deployment にできない', () => {
    const { s, server } = base();
    const srv = server('web', 20, ['blog:web']);
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
    const { s, lb, w1, w2 } = cluster(300, ['lb']);
    lb(30);
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

  it('ワーカーに載りきらないときは、動いている Pod の数を基準にして増やしすぎない', () => {
    const { s, lb } = cluster(1500, ['lb']);
    lb(30);
    s.toggleDeployment('blog:web');
    run(s, 60_000);
    expect(s.podsPending.size).toBeGreaterThan(0);
    const settled = s.deployments.get('blog:web')!;
    run(s, 30_000);
    // 待ちの Pod まで掛けると 5 秒ごとに倍々になり上限まで行く。動いている数が同じなら、目標も同じところで止まる
    expect(s.deployments.get('blog:web')).toBe(settled);
    expect(settled).toBeLessThan(K8S.maxPods);
  });

  it('キャパシティは、Pod がオートスケールでワーカーを使い切った前提で見積もる', () => {
    const { s, lb } = cluster(50, ['lb']);
    lb(30);
    s.toggleDeployment('blog:web');
    expect(webPods(s)).toBe(K8S.minPods);
    const cap = s.estimateCapacity();
    // 今の 2 Pod で捌ける量(1 Pod = 1 vCPU、web 12ms → 約 83 PV/秒)よりずっと多い
    const twoPods = (K8S.minPods * 1000) / SERVICES.blog.work.webCpuMs;
    expect(cap).toBeGreaterThan(twoPods * 2);
    // 見積もりで Pod の数は変わらない
    expect(webPods(s)).toBe(K8S.minPods);
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
    const { s, lb, w1, w2 } = cluster(100, ['lb']);
    lb(30);
    s.toggleDeployment('blog:web');
    run(s, 20_000);
    s.setMaintenance(w1, true);
    expect(s.pods.every((p) => p.worker === w2)).toBe(true);
    run(s, 20_000);
    expect(s.flow.success).toBe(1);
  });

  it('VM もワーカーにでき、セーブで Deployment とワーカーが残る', () => {
    const { s, server } = base({ pv: 30, unlocks: ['kubernetes', 'virtualization'] });
    server('db', 10, ['blog:db']);
    const h = server('big', 20, []);
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

  it('search Pod のキャッシュメモリは Pod 1 つあたりで計算され、1 台に集めても外れ率が変わらない', () => {
    const { s, server } = base({ traffic: { blog: 0, shop: 20 }, unlocks: ['kubernetes', 'shop'] });
    server('db', 10, ['shop:web', 'shop:db']);
    const workers = [server('big', 14, []), server('big', 18, []), server('big', 22, []), server('big', 26, [])];
    for (const w of workers) expect(s.setK8sWorker({ device: w }, true).ok).toBe(true);
    const input = (pods: { id: number; worker: number; role: 'shop:search'; count: number }[]) => ({
      services: [{ id: 'shop' as const, pv: 20, work: SERVICES.shop.work }],
      pods,
      uplinkGbps: 10,
      roles: s.availableRoles,
      now: 0,
      bgp: false,
      down: new Set<number>(),
    });
    const packed = computeFlow(s.facility, input([{ id: POD_ID_BASE, worker: workers[0], role: 'shop:search', count: 4 }]));
    const spread = computeFlow(s.facility, input(workers.map((w, i) => ({ id: POD_ID_BASE + i, worker: w, role: 'shop:search' as const, count: 1 }))));
    expect(packed.nodeLoads.get(POD_ID_BASE)!.miss['shop:search']).toBeCloseTo(spread.nodeLoads.get(POD_ID_BASE)!.miss['shop:search']!, 6);
    const packedIo = packed.nodeLoads.get(POD_ID_BASE)!.ioOps;
    const spreadIo = workers.reduce((sum, _, i) => sum + spread.nodeLoads.get(POD_ID_BASE + i)!.ioOps, 0);
    expect(packedIo).toBeCloseTo(spreadIo, 6);
  });

  it('LB なし + MetalLB で media を web Pod が肩代わりするとき、画像・動画も全 Pod グループに分散する', () => {
    const { s, server } = base({ traffic: { blog: 0, photo: 20 }, unlocks: ['kubernetes', 'bgp', 'shop', 'photo'] });
    server('db', 10, ['photo:db']);
    const w1 = server('web', 20, []);
    const w2 = server('web', 22, []);
    expect(s.setK8sWorker({ device: w1 }, true).ok).toBe(true);
    expect(s.setK8sWorker({ device: w2 }, true).ok).toBe(true);
    expect(s.setBgp(w1, true).ok).toBe(true);
    expect(s.setBgp(w2, true).ok).toBe(true);
    expect(s.toggleDeployment('photo:web').ok).toBe(true);
    const flow = run(s, 1000);
    const entries = flow.services.photo!.entries;
    expect(entries).toHaveLength(2);
    // HTML も画像・動画の配信も 2 つの Pod グループに半分ずつ流れる
    expect(flow.nodeLoads.get(entries[0])!.ioOps).toBeGreaterThan(0);
    expect(flow.nodeLoads.get(entries[1])!.ioOps).toBeCloseTo(flow.nodeLoads.get(entries[0])!.ioOps, 6);
    expect(flow.nodeLoads.get(entries[1])!.work['photo:web']).toBeCloseTo(flow.nodeLoads.get(entries[0])!.work['photo:web']!, 6);
  });
});
