/**
 * 自動配線。機器を置く・動かす・外す・NIC を替えるたびに、決まったルールでケーブルを引き直す。
 * プレイヤーは配線をしない。考えるのは「どのラックにどのスイッチを置くか」と「ポートが足りるか」だけ。
 *
 * ルール:
 *  1. コア: 集約スイッチがあれば集約スイッチ(すべて)、なければ一番速いポートを持つスイッチ(同じなら先に置いた方)
 *  2. 回線終端は、コアに順番に 1 本ずつ
 *  3. コア以外のスイッチ(ToR)は、コアそれぞれに WIRING.uplinksPerCore 本ずつ(速いポートから、コアに 1 本ずつ順に。
 *     速いポートを使い切ったら、遅いポートでは足さない)
 *  4. LB・ストレージ・サーバの順に(速いポートを LB に先に回す)、同じラックのスイッチへ(なければ一番近いラックのスイッチへ)。
 *     スイッチが複数あれば、一番速くつながるスイッチへ(速すぎるポートは残す)。同じなら別々のスイッチに分けてつなぐ(BGP で冗長化できる)。
 *     集約スイッチも、同じラックにあればつなぐ先になる。LB だけは、別のラックのコアにもつなげる
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

  /** a と b をつなぐときの一番よいポートの組: リンクが一番速く、余分に速いポートは残す */
  const pair = (a: Device, b: Device) => {
    let best: { pa: FreePort; pb: FreePort; speed: number; waste: number } | null = null;
    for (const pa of free(a)) {
      for (const pb of free(b)) {
        const speed = Math.min(pa.speed, pb.speed);
        const waste = pa.speed + pb.speed - speed * 2;
        if (!best || speed > best.speed || (speed === best.speed && waste < best.waste)) best = { pa, pb, speed, waste };
      }
    }
    return best;
  };
  const link = (a: Device, b: Device): boolean => {
    const best = pair(a, b);
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
    // コアに 1 本ずつ順に配る。2 周目は全部のコアに配れるときだけ(偏らせない)。最初の 1 本より遅いリンクは足さない
    // (遅いリンクが混ざると、均等に分ける ECMP でそこだけ詰まる)
    let n = 0;
    let speed = 0;
    for (let i = 0; i < WIRING.uplinksPerCore; i++) {
      // 2 周目からは、すべてのコアに同じ速さで配れるときだけ(コアごとの太さをそろえる)
      const ok = cores.filter((c) => (pair(t, c)?.speed ?? 0) >= Math.max(speed, 1e-9));
      if (i > 0 && (ok.length < cores.length || free(t).filter((p) => p.speed >= speed).length < cores.length)) break;
      for (const c of ok) {
        const best = pair(t, c);
        if (!best || best.speed < speed) continue;
        speed = best.speed;
        if (link(t, c)) n++;
      }
    }
    if (!n) unwired.set(t.id, `${cores.map((c) => c.name).join('・')} のポートが空いていません`);
  }

  // 4. サーバ・LB・ストレージ → 同じラック(なければ近いラック)のスイッチ
  // 集約スイッチも、同じラックにあればつなぐ先になる(ToR の速いポートが足りないときの 10G の LB など)
  const edge = switches;
  const linksOf = { server: WIRING.serverLinks, lb: WIRING.lbLinks, storage: WIRING.storageLinks } as const;
  // 数の少ない速いポートは、全体の流量が通る LB、次にストレージに先に回す。そのあとサーバを置いた順に
  const order = { lb: 0, storage: 1, server: 2 } as const;
  const endpoints = devices
    .filter((d) => cat(d) in order)
    .sort((a, b) => order[cat(a) as keyof typeof order] - order[cat(b) as keyof typeof order] || a.id - b.id);
  for (const d of endpoints) {
    const c = cat(d) as keyof typeof order;
    if (!edge.length) {
      unwired.set(d.id, 'スイッチがありません');
      continue;
    }
    const dist = Math.min(...edge.map((s) => Math.abs(s.slot - d.slot)));
    const near = edge.filter((s) => Math.abs(s.slot - d.slot) === dist);
    const slot = Math.min(...near.map((s) => s.slot));
    // LB はすべての通信が通るので、ラックが違ってもコアのスイッチにつなげる(ポートが速い方を選ぶ)
    const local = near.filter((s) => s.slot === slot);
    const targets = c === 'lb' ? [...new Set([...local, ...cores])] : local;
    let n = 0;
    for (let i = 0; i < linksOf[c]; i++) {
      // 一番速くつながるスイッチへ(10G の機器を 1G のスイッチにつながない。1G の機器で 10G のポートを潰さない)。
      // 同じなら順番にスイッチを替えて分ける。埋まっているスイッチは選ばれない
      const order = targets.map((_, k) => targets[(i + k) % targets.length]);
      const options = order.map((sw) => ({ sw, p: pair(d, sw) })).filter((o) => o.p);
      if (!options.length) break;
      const speed = Math.max(...options.map((o) => o.p!.speed));
      const waste = Math.min(...options.filter((o) => o.p!.speed === speed).map((o) => o.p!.waste));
      const pick = options.find((o) => o.p!.speed === speed && o.p!.waste === waste)!;
      if (link(d, pick.sw)) n++;
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
