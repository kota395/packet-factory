/**
 * 自動配線。機器を置く・動かす・外す・NIC を替えるたびに、決まったルールでケーブルを引き直す。
 * プレイヤーは配線をしない。考えるのは「どのラックにどのスイッチを置くか」と「ポートが足りるか」だけ。
 *
 * ルール:
 *  1. コア: 集約スイッチがあれば集約スイッチ(すべて)、なければ一番速いポートを持つスイッチ(同じなら先に置いた方)
 *  2. 回線終端は、コアに順番に 1 本ずつ
 *  3. コア以外のスイッチ(ToR)は、コアそれぞれに WIRING.uplinksPerCore 本ずつ(速いポートから)
 *  4. サーバ・LB・ストレージは、同じラックのスイッチへ(なければ一番近いラックのスイッチへ)。
 *     スイッチが複数あれば別々のスイッチに分けてつなぐ(BGP で冗長化できる)
 *  5. LB アプライアンスは、置いた順に 2 台ずつ HA ポートを直結する
 * つなぐ先のポートが空いていなければつながらず、unwired に理由が残る。
 */
import { MODEL_BY_ID, portsOf } from './catalog';
import { WIRING } from './config';
import type { Device, Facility } from './facility';

interface FreePort {
  port: number;
  speed: number;
}

export function autoWire(f: Facility): Map<number, string> {
  f.clearCables();
  const unwired = new Map<number, string>();
  const devices = [...f.devices.values()].sort((a, b) => a.id - b.id);
  const cat = (d: Device) => MODEL_BY_ID[d.model].category;
  const switches = devices.filter((d) => cat(d) === 'switch');
  const aggs = switches.filter((d) => d.model === 'agg-10g');
  // 集約スイッチがなければ、一番速いポートを持つスイッチ(同じなら先に置いた方)がコア
  const top = (d: Device) => Math.max(...portsOf(d).map((p) => p.speedGbps));
  const fastest = switches.reduce<Device | null>((best, d) => (!best || top(d) > top(best) ? d : best), null);
  const cores = aggs.length ? aggs : fastest ? [fastest] : [];
  const tors = switches.filter((d) => !cores.includes(d));

  /** 空いているデータ用のポート(HA ポートは除く) */
  const free = (d: Device): FreePort[] =>
    portsOf(d)
      .filter((p) => p.label !== 'HA' && !f.cableAt({ device: d.id, port: p.index }))
      .map((p) => ({ port: p.index, speed: p.speedGbps }));

  /** a と b を 1 本つなぐ。リンクが一番速くなる組み合わせで、余分に速いポートは残す */
  const link = (a: Device, b: Device): boolean => {
    let best: { pa: FreePort; pb: FreePort; speed: number; waste: number } | null = null;
    for (const pa of free(a)) {
      for (const pb of free(b)) {
        const speed = Math.min(pa.speed, pb.speed);
        const waste = pa.speed + pb.speed - speed * 2;
        if (!best || speed > best.speed || (speed === best.speed && waste < best.waste)) best = { pa, pb, speed, waste };
      }
    }
    if (!best) return false;
    f.connect({ device: a.id, port: best.pa.port }, { device: b.id, port: best.pb.port });
    return true;
  };

  // 2. 回線終端 → コア
  devices
    .filter((d) => cat(d) === 'handoff')
    .forEach((h, i) => {
      if (!cores.length) unwired.set(h.id, 'スイッチがありません');
      else if (!link(h, cores[i % cores.length]) && !cores.some((c) => link(h, c))) unwired.set(h.id, 'コアのスイッチのポートが空いていません');
    });

  // 3. ToR → コア
  for (const t of tors) {
    let n = 0;
    for (const c of cores) for (let i = 0; i < WIRING.uplinksPerCore; i++) if (link(t, c)) n++;
    if (!n) unwired.set(t.id, `${cores.map((c) => c.name).join('・')} のポートが空いていません`);
  }

  // 4. サーバ・LB・ストレージ → 同じラック(なければ近いラック)のスイッチ
  const edge = tors.length || !aggs.length ? [...(aggs.length ? [] : cores), ...tors] : aggs;
  const linksOf = { server: WIRING.serverLinks, lb: WIRING.lbLinks, storage: WIRING.storageLinks } as const;
  for (const d of devices) {
    const c = cat(d);
    if (c !== 'server' && c !== 'lb' && c !== 'storage') continue;
    if (!edge.length) {
      unwired.set(d.id, 'スイッチがありません');
      continue;
    }
    const dist = Math.min(...edge.map((s) => Math.abs(s.slot - d.slot)));
    const near = edge.filter((s) => Math.abs(s.slot - d.slot) === dist);
    const slot = Math.min(...near.map((s) => s.slot));
    const targets = near.filter((s) => s.slot === slot);
    let n = 0;
    for (let i = 0; i < linksOf[c]; i++) {
      // 順番にスイッチを替えながら。そのスイッチが埋まっていれば、ほかのスイッチへ
      const order = targets.map((_, k) => targets[(i + k) % targets.length]);
      if (order.some((s) => link(d, s))) n++;
    }
    if (!n) unwired.set(d.id, `${targets.map((s) => s.name).join('・')} のポートが空いていません(スイッチを足す)`);
  }

  // 5. LB アプライアンスの HA: 置いた順に 2 台ずつ
  const lbs = devices.filter((d) => cat(d) === 'lb');
  for (let i = 0; i + 1 < lbs.length; i += 2) {
    const ha = (d: Device) => portsOf(d).find((p) => p.label === 'HA')!.index;
    f.connect({ device: lbs[i].id, port: ha(lbs[i]) }, { device: lbs[i + 1].id, port: ha(lbs[i + 1]) });
  }
  return unwired;
}
