import { describe, expect, it } from 'vitest';
import { K8S, SERVICES } from '../src/sim/config';
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
});
