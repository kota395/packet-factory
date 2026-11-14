import { describe, expect, it } from 'vitest';
import { ANALYTICS, SERVICES } from '../src/sim/config';
import { wire, run, base } from './helpers';

describe('分析基盤と GPU', () => {
  it('GPU は解放してから載せられ、動画のエンコードは GPU があれば GPU で処理する', () => {
    const { s, server } = base({ traffic: { blog: 0, video: 100 }, unlocks: ['shop', 'photo', 'video'] });
    server('db', 20, ['video:web', 'video:db', 'video:media']);
    const w = s.buyServer('1u-compute', 0, 30).id!;
    s.toggleRole(w, 'video:worker');
    const sw = [...s.facility.devices.values()].find((d) => d.model === 'sw-24')!.id;
    wire(s, { device: w, port: 0 }, { device: sw, port: 10 });
    const cpuOnly = run(s, 1000);
    const cpuBefore = cpuOnly.nodeLoads.get(w)!.cpu;
    expect(cpuOnly.nodeLoads.get(w)!.gpu).toBeUndefined();
    expect(s.changeParts(w, { kind: 'gpu', dir: 1 }).ok).toBe(false);
    s.unlock('gpu');
    expect(s.changeParts(w, { kind: 'gpu', dir: 1 }).ok).toBe(true);
    const flow = run(s, 1000);
    const l = flow.nodeLoads.get(w)!;
    const jobs = 100 * SERVICES.video.work.upload!.perPv;
    expect(l.work['video:worker']).toBeCloseTo(jobs, 6);
    expect(l.gpu).toBeCloseTo((jobs * SERVICES.video.work.upload!.workerGpuMs!) / 1000, 6);
    expect(l.cpu).toBeLessThan(cpuBefore / 10);
  });

  it('VM と Pod も、載っているサーバの GPU を使える(同じサーバの中で分け合う)', () => {
    const { s, server } = base({ traffic: { blog: 0, video: 100 }, unlocks: ['shop', 'photo', 'video', 'gpu', 'virtualization', 'kubernetes'] });
    server('db', 20, ['video:web', 'video:db', 'video:media']);
    const h = server('big', 10, []);
    s.changeParts(h, { kind: 'gpu', dir: 1 });
    s.setHv(h, true);
    const vm = s.createVm(h, 'l').id!;
    s.toggleVmRole(vm, 'video:worker');
    let flow = run(s, 1000);
    const jobs = 100 * SERVICES.video.work.upload!.perPv;
    const gpu = (jobs * SERVICES.video.work.upload!.workerGpuMs!) / 1000;
    expect(flow.nodeLoads.get(-vm)!.gpu).toBeCloseTo(gpu, 6);
    expect(flow.devices.get(h)!.gpu).toBeCloseTo(gpu, 6);
    // 同じホストの VM をワーカーにして、Pod でエンコードする
    s.toggleVmRole(vm, 'video:worker');
    expect(s.setK8sWorker({ vm }, true).ok).toBe(true);
    s.toggleDeployment('video:worker');
    flow = run(s, 1000);
    const pods = [...flow.nodes.values()].filter((n) => n.pods && n.roles.includes('video:worker'));
    expect(pods.length).toBeGreaterThan(0);
    expect(flow.devices.get(h)!.gpu).toBeCloseTo(gpu, 6);
  });

  it('Hadoop にログを集めると単価が上がり、処理しきれないと上がり方が減る。機械学習は GPU で', () => {
    const { s, server } = base({ pv: 100, unlocks: ['hadoop', 'ml', 'gpu'] });
    server('db', 20, ['blog:web', 'blog:db']);
    const base0 = s.revenuePerPv('blog');
    let flow = run(s, 1000);
    expect(flow.problems.join()).toContain('hadoop');
    const h = server('small', 16, ['data:hadoop']);
    flow = run(s, 1000);
    expect(flow.analytics.logMBps).toBeCloseTo((100 * ANALYTICS.logKB) / 1000, 6);
    expect(flow.analytics.coverage).toBeCloseTo(1, 6);
    expect(flow.nodeLoads.get(h)!.work['data:hadoop']).toBeCloseTo(flow.analytics.logMBps, 6);
    expect(s.revenuePerPv('blog')).toBeCloseTo(base0 * (1 + ANALYTICS.hadoopBoost), 6);
    // 機械学習: GPU なしだと遅い(警告)。GPU を載せると捌ける
    const m = server('db', 30, ['data:ml']);
    flow = run(s, 1000);
    expect(flow.problems.join()).toContain('GPU がない');
    const cpuMl = flow.nodeLoads.get(m)!.cpu;
    s.changeParts(m, { kind: 'gpu', dir: 1 });
    flow = run(s, 1000);
    expect(flow.nodeLoads.get(m)!.cpu).toBeLessThan(cpuMl);
    expect(flow.analytics.mlCoverage).toBeCloseTo(1, 6);
    expect(flow.analytics.boost).toBeCloseTo(1 + ANALYTICS.hadoopBoost + ANALYTICS.mlBoost, 6);
    // ログが増えて Hadoop が溢れると、上がり方が減る
    (s as unknown as { fixedTraffic: Record<string, () => number> }).fixedTraffic.blog = () => 600;
    flow = run(s, 1000);
    expect(flow.analytics.coverage).toBeLessThan(1);
  });
});
