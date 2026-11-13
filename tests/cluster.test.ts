import { describe, expect, it } from 'vitest';
import { VIRT } from '../src/sim/config';
import { run, base } from './helpers';

describe('クラスタ(コンピュートの資源としてまとめて扱う)', () => {
  it('配線済みで役割のないサーバだけがホストやワーカーに加えられる', () => {
    const { s, server } = base({ unlocks: ['virtualization', 'kubernetes'] });
    const wired = server('big', 20, []);
    server('big', 16, [], 0, -1); // 配線していない
    server('small', 30, ['blog:web']); // 役割がある
    expect(s.spareServers.map((d) => d.id)).toEqual([wired]);
    s.setHv(wired, true);
    expect(s.spareServers).toEqual([]);
  });

  it('ホストを選ばずに作った VM は、メモリの空きが多いホストに順に置かれる', () => {
    const { s, server } = base({ pv: 20, unlocks: ['virtualization', 'kubernetes'] });
    server('db', 30, ['blog:db']);
    const h1 = server('big', 20, []);
    const h2 = server('big', 16, []);
    s.setHv(h1, true);
    s.setHv(h2, true);
    const a = s.createVmAuto('l', { roles: ['blog:web'] });
    const b = s.createVmAuto('l', { roles: ['blog:web'] });
    expect(a.ok && b.ok).toBe(true);
    expect(new Set([s.facility.vms.get(a.id!)!.host, s.facility.vms.get(b.id!)!.host])).toEqual(new Set([h1, h2]));
    expect(s.facility.vms.get(a.id!)!.roles).toEqual(['blog:web']);
    expect(s.hvCapacity.hosts).toBe(2);
    expect(s.hvCapacity.memGB).toBe(2 * VIRT.sizes.l.memGB);
    expect(run(s, 1000).success).toBe(1);
    // 載らなくなるまで作れる
    let made = 0;
    while (s.createVmAuto('l').ok) made++;
    expect(s.createVmAuto('l').message).toContain('ホストがありません');
    expect(made).toBeGreaterThan(0);
    // ワーカーにする VM も作れ、Pod が置かれる
    s.toggleDeployment('blog:web');
    for (const v of [...s.facility.vms.values()].filter((x) => !x.roles.length)) s.deleteVm(v.id);
    const w = s.createVmAuto('m', { k8s: true });
    expect(w.ok).toBe(true);
    expect(s.k8sCapacity.workers).toBe(1);
    expect(s.pods.some((p) => p.worker === -w.id!)).toBe(true);
  });
});
