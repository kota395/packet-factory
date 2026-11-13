/**
 * バランス確認用のボット。一番詰まっている所と警告を見て、プレイヤーがしそうな手を打ちながら遊び、進行の速さをログに出す。
 *   npm run balance               # 60 分ぶん
 *   BOT_MIN=20 npm run balance    # 時間を指定
 *   BOT_SAVE=1 npm run balance    # 最後の状態をセーブとして出す(画面確認用)
 * 調整値(src/sim/config.ts, pricing.ts, catalog.ts, economy.ts)を変えたら、ログの節目の時刻を見比べる。
 *
 * 打つ手(物理サーバだけで組む。仮想化と Kubernetes は使わない):
 *  - 詰まった資源に合わせて、パーツの強化 → 台数を足す → 解放(cache・レプリカ・分割・10G・集約・CDN・回線の追加)
 *  - 余裕があれば、広告・収益化・ブログの機能・新しいサービス・分析基盤
 *  - 新しいサービスは web と db を 1 台ずつから。「肩代わり」の警告が出たら search・media・worker を専用のサーバへ
 * 難易度は「平和」(故障なし)。乱数に左右されず、調整値の差だけを見るため。
 */
import { it } from 'vitest';
import { MODEL_BY_ID, PRESET_BY_ID, portsOf } from '../src/sim/catalog';
import { RACK, SERVICES } from '../src/sim/config';
import { GOALS, unlockCost } from '../src/sim/economy';
import type { Device } from '../src/sim/facility';
import { createSave, newGame } from '../src/sim/save';
import type { PartChange } from '../src/sim/simulation';
import { roleKey, splitRole, type ModelId, type RoleId, type RoleKey, type ServiceId, type UnlockId } from '../src/sim/types';

declare const process: { env: Record<string, string | undefined> };

const MINUTES = Number(process.env.BOT_MIN ?? 60);
/** これを超えたら手を打つ */
const BUSY = 0.75;
/** 役割ごとに、足すときの構成 */
const PRESET_FOR: Partial<Record<RoleId, string>> = {
  web: '1u-web',
  cache: '1u-small',
  search: '1u-web',
  worker: '1u-compute',
  media: '2u-ssd',
  db: '2u-ssd',
  replica: '2u-ssd',
  hadoop: '2u-hdd',
  ml: '2u-gpu',
};

it(`balance bot (${MINUTES} min)`, () => {
  const s = newGame('peace');
  const f = s.facility;
  const log: string[] = [];
  const event = (m: string) => log.push(`${(s.time / 60000).toFixed(1).padStart(5)}m  ${m}`);

  const all = () => [...f.devices.values()];
  const cat = (d: Device) => MODEL_BY_ID[d.model].category;
  const byName = (name: string) => all().find((d) => d.name === name);
  const has = (model: ModelId) => all().some((d) => d.model === model);

  // ---------------------------------------------------------------- 買う

  const tryUnlock = (id: UnlockId): boolean => {
    if (s.unlocks.has(id) || s.canUnlock(id) !== null) return false;
    const ok = s.unlock(id).ok;
    if (ok) event(`解放: ${id} ($${unlockCost(id)})`);
    return ok;
  };
  /** 手が打てなかった理由(最後のもの) */
  let stuck = '';
  const no = (why: string): false => {
    stuck = why;
    return false;
  };
  const tryUpgrade = (id: 'uplink' | 'rackPower' | 'marketing' | 'monetize', label: string): boolean => {
    if (s.canBuyUpgrade(id) !== null) return false;
    s.buyUpgrade(id);
    event(label);
    return true;
  };
  /** そのラックのスイッチの空きポート */
  const freePorts = (slot: number) =>
    all()
      .filter((d) => cat(d) === 'switch' && d.slot === slot && d.model !== 'agg-10g')
      .reduce((n, d) => n + portsOf(d).filter((p) => !f.cableAt({ device: d.id, port: p.index })).length, 0);
  /** 置ける U(上から) */
  const findU = (model: ModelId, slot: number, preset?: string): number | null => {
    const parts = preset ? PRESET_BY_ID[preset].parts : undefined;
    for (let u = RACK.units - MODEL_BY_ID[model].u + 1; u >= 1; u--) if (!s.placeError(model, slot, u, undefined, parts)) return u;
    return null;
  };
  /** 集約スイッチを足す(2 台目からは ToR のアップリンクが増える) */
  const addAgg = (why: string): boolean => {
    if (!s.unlocks.has('agg')) return tryUnlock('agg');
    if (all().filter((d) => d.model === 'agg-10g').length >= 4) return no(`集約スイッチはもう 4 台ある(${why})`);
    for (const slot of f.racks.keys()) {
      const u = findU('agg-10g', slot);
      if (u !== null && s.buyDevice('agg-10g', slot, u).ok) {
        event(`集約スイッチを追加(${why})`);
        return true;
      }
    }
    return tryUpgrade('rackPower', `電力契約 → レベル ${s.upgrades.rackPower + 1}`);
  };
  /** 新しいラックを借りて ToR を置く */
  const expand = (): boolean => {
    // つながっていないスイッチがあるうちは増やさない(コアのポートが足りない: 集約スイッチを足す)
    if (all().some((d) => cat(d) === 'switch' && f.unwired.has(d.id))) return addAgg('コアのポート不足');
    if (f.racks.size >= 20) return no('ラックをこれ以上借りられない');
    const slot = f.racks.size;
    const tor: ModelId = s.unlocks.has('tenGig') ? 'sw-48' : 'sw-24';
    if (s.money < s.rackPrice() + s.devicePrice(tor)) return no('ラックを借りるお金がない');
    const rent = s.rentRack(slot);
    if (!rent.ok) return no(`ラックを借りられない: ${rent.message}`);
    s.buyDevice(tor, slot, RACK.units - 1);
    event(`ラック ${slot + 1} を借りて ${tor} を設置`);
    return true;
  };
  /** 置き場所(U・電力・スイッチのポート)がなければ、電力契約 → スイッチ → ラック */
  const makeRoom = (model: ModelId, preset?: string): boolean => {
    const slots = [...f.racks.keys()];
    if (slots.some((slot) => findU(model, slot, preset) !== null && freePorts(slot) > 0)) return no(`${model} を置く場所はあるのに買えない`);
    // U と電力はあるがポートがない: スイッチを足す
    const full = slots.find((slot) => findU(model, slot, preset) !== null && freePorts(slot) === 0);
    if (full !== undefined) {
      const tor: ModelId = s.unlocks.has('tenGig') ? 'sw-48' : 'sw-24';
      const u = findU(tor, full);
      if (u !== null && s.buyDevice(tor, full, u).ok) {
        event(`ラック ${full + 1} に ${tor} を追加(ポート不足)`);
        return true;
      }
    }
    return tryUpgrade('rackPower', `電力契約 → レベル ${s.upgrades.rackPower + 1}`) || expand();
  };
  /** 機器を、スイッチのポートが空いているラックに置く */
  const buy = (model: ModelId, preset?: string): number | null => {
    // LB は別のラックのコアにもつながるので、スイッチの空きポートは見ない
    const anywhere = model === 'lb-10g' && has('agg-10g');
    for (const slot of [...f.racks.keys()].sort((a, b) => a - b)) {
      if (!anywhere && freePorts(slot) === 0) continue;
      const u = findU(model, slot, preset);
      if (u === null) continue;
      const r = preset ? s.buyServer(preset, slot, u) : s.buyDevice(model, slot, u);
      if (r.ok) return r.id!;
    }
    return null;
  };
  /** 役割を付けたサーバを足す。置けなければ場所を作る */
  const addServer = (key: RoleKey): boolean => {
    const preset = PRESET_FOR[splitRole(key)[1]] ?? '1u-web';
    const { model } = PRESET_BY_ID[preset];
    for (const u of PRESET_BY_ID[preset].parts.gpus ? (['gpu', 'tenGig'] as const) : PRESET_BY_ID[preset].parts.nic !== 'none' ? (['tenGig'] as const) : []) {
      if (!s.unlocks.has(u)) return tryUnlock(u);
    }
    const id = buy(model, preset);
    if (id === null) return makeRoom(model, preset);
    s.toggleRole(id, key);
    event(`${preset} 設置(${key})`);
    return true;
  };
  /** LB: なければ 1 台。帯域か処理能力が詰まったら 10G の機種に替える */
  const ensureLb = (): boolean => {
    if (all().some((d) => cat(d) === 'lb')) return false;
    if (!s.unlocks.has('lb')) return tryUnlock('lb');
    const id = buy('lb-1u');
    if (id === null) return makeRoom('lb-1u');
    event('LB アプライアンス設置');
    return true;
  };
  const lbTo10G = (): boolean => {
    if (has('lb-10g')) {
      // 10G の LB でも詰まる: CDN で配信を逃がす → 集約スイッチ(10G のポートを増やす)→ LB をもう 1 組
      if (!s.unlocks.has('cdn')) return tryUnlock('cdn');
      if (!has('agg-10g')) return coreUp();
      if (all().filter((d) => cat(d) === 'lb').length >= 8) return addAgg('LB の先の帯域');
      if (s.money < s.devicePrice('lb-10g') * 2) return no('LB を買うお金がない');
      // 集約スイッチのポートが 1 組ぶん(4 本 × 2 台)空いていなければ、1G のポートにつながってしまうので買わない
      const room = all().filter((d) => d.model === 'agg-10g').reduce((n, d) => n + portsOf(d).filter((p) => !f.cableAt({ device: d.id, port: p.index })).length, 0);
      if (room < 8) return addAgg('LB をつなぐポート');
      const a = buy('lb-10g');
      const b = a === null ? null : buy('lb-10g');
      if (a === null) return makeRoom('lb-10g');
      event(`LB をもう 1 組追加(${b === null ? '1 台だけ' : 'HA'})`);
      return true;
    }
    if (!s.unlocks.has('tenGig')) return tryUnlock('tenGig');
    if (!has('sw-48') && !has('agg-10g')) return coreUp();
    if (s.money < s.devicePrice('lb-10g')) return false;
    const id = buy('lb-10g');
    if (id === null) return makeRoom('lb-10g');
    // 古い 1G の機種は売る(残すと HA のペアで 1G の方がアクティブになる)
    for (const d of all()) if (d.model === 'lb-1u') s.sellDevice(d.id);
    event('LB を 10G の機種に替える');
    return true;
  };
  /** コアを速くする: 10G のスイッチ → 集約スイッチ */
  const coreUp = (): boolean => {
    if (!s.unlocks.has('tenGig')) return tryUnlock('tenGig');
    if (!has('sw-48')) {
      const u = findU('sw-48', 0);
      if (u === null) return makeRoom('sw-48');
      if (!s.buyDevice('sw-48', 0, u).ok) return false;
      event('sw-48 を入れて回線を 10G で受ける(コアが替わる)');
      return true;
    }
    // 集約スイッチ。2 台目を足すと、ToR のアップリンクが倍になる
    if (all().filter((d) => d.model === 'agg-10g').length >= 2) return false;
    return addAgg('スイッチ間の帯域');
  };
  /** 回線が詰まった: つなぎ先を 10G に → 契約を上げる → CDN → 回線を増やす */
  const moreUplink = (): boolean => {
    const link = s.flow.links.find((l) => f.devices.get(l.a)?.model === 'handoff' || f.devices.get(l.b)?.model === 'handoff');
    if (link && link.capacityGbps / link.cables.length < s.uplinkGbps) return coreUp();
    if (tryUpgrade('uplink', `回線契約 → レベル ${s.upgrades.uplink + 1}`)) return true;
    if (!s.unlocks.has('cdn')) return tryUnlock('cdn');
    if (!s.unlocks.has('bgp')) return tryUnlock('bgp');
    if (!s.unlocks.has('multihoming')) return tryUnlock('multihoming');
    if (s.money < s.devicePrice('handoff')) return false;
    const id = buy('handoff');
    if (id !== null) event('回線を追加');
    return id !== null;
  };

  // ---------------------------------------------------------------- 詰まりに手を打つ

  const upgrade = (dev: Device, change: PartChange): boolean => {
    const r = s.changeParts(dev.id, change);
    if (r.ok) event(`${dev.name} 強化: ${change.kind}${'type' in change ? ` ${change.type}` : ''}${'to' in change ? ` ${change.to}` : ''}`);
    return r.ok;
  };
  /** その役割を横に増やす(db は cache → レプリカ → 分割) */
  const scaleOut = (key: RoleKey): boolean => {
    const [svc, role] = splitRole(key);
    if (svc === 'data') return addServer(key);
    const inst = s.flow.services[svc]?.instances;
    if (role === 'db') {
      if (!s.unlocks.has('cache')) return tryUnlock('cache');
      if (!inst?.cache.length) return addServer(roleKey(svc, 'cache'));
      if (!s.unlocks.has('replication')) return tryUnlock('replication');
      if ((inst?.replica.length ?? 0) < 2) return addServer(roleKey(svc, 'replica'));
      // 書き込みが詰まっている: 機能分割 → シャーディング
      if (!s.unlocks.has('partition')) return tryUnlock('partition');
      if ((inst?.db.length ?? 0) < 2) return addServer(key);
      if (!s.unlocks.has('sharding')) return tryUnlock('sharding');
      return addServer(key);
    }
    if (role === 'replica' || role === 'cache') return addServer(key);
    // web・media を並べるには LB が要る
    if ((role === 'web' || role === 'media') && ensureLb()) return true;
    return addServer(key);
  };
  const fixServer = (dev: Device, label: string): boolean => {
    const p = dev.parts!;
    const key = dev.roles[0];
    if (label.includes('GPU')) return upgrade(dev, { kind: 'gpu', dir: 1 }) || (key ? scaleOut(key) : false);
    if (label.includes('ディスク IO')) {
      if (p.memGB < 256 && s.partChangeInfo(dev.id, { kind: 'mem', dir: 1 }).cost < s.money / 2 && upgrade(dev, { kind: 'mem', dir: 1 })) return true;
      if (p.backplane === 'lff' && upgrade(dev, { kind: 'backplane', to: 'sff' })) return true;
      const drive = s.unlocks.has('nvme') ? 'nvme' : 'ssd';
      if (p.backplane === 'sff' && p.drives.length < 8 && upgrade(dev, { kind: 'drive-add', type: drive })) return true;
      if (!s.unlocks.has('nvme') && s.money > unlockCost('nvme') * 3) return tryUnlock('nvme');
      return key ? scaleOut(key) : false;
    }
    // CPU: 16 コアまでは CPU を替える(db は 64 まで)。そのあとは台数を足す
    const maxCpu = key && ['db', 'replica'].includes(splitRole(key)[1]) ? 64 : 16;
    if (p.cpu < maxCpu && upgrade(dev, { kind: 'cpu', dir: 1 })) return true;
    return key ? scaleOut(key) : false;
  };
  const fixLink = (x: Device, y: Device): boolean => {
    if (cat(x) === 'handoff' || cat(y) === 'handoff') return moreUplink();
    if (cat(x) === 'lb' || cat(y) === 'lb') return lbTo10G();
    const server = [x, y].find((d) => cat(d) === 'server');
    if (server) {
      // 10G のポートがあるスイッチの下なら NIC を 10G に。なければ台数を足す
      const sw = server === x ? y : x;
      if (s.unlocks.has('tenGig') && server.parts!.nic === 'none' && portsOf(sw).some((p) => p.speedGbps >= 10) && upgrade(server, { kind: 'nic', to: 'sfp10' })) return true;
      return server.roles[0] ? scaleOut(server.roles[0]) : false;
    }
    // スイッチ同士: 1G だけのスイッチ(sw-24)のアップリンクなら、10G のアップリンクを持つ sw-48 に入れ替える
    const old = [x, y].find((d) => d.model === 'sw-24');
    if (old && s.unlocks.has('tenGig')) {
      // 同じラックにほかのスイッチがあって、ポートが足りるなら売るだけ
      const used = portsOf(old).filter((p) => f.cableAt({ device: old.id, port: p.index })).length;
      const others = all().filter((d) => cat(d) === 'switch' && d.slot === old.slot && d.id !== old.id && d.model !== 'agg-10g');
      const spare = others.reduce((n, d) => n + portsOf(d).filter((p) => !f.cableAt({ device: d.id, port: p.index })).length, 0);
      if (!others.length || spare < used) {
        // sw-24 を売った U に sw-48 を置く(電力は 1 台ぶん空く)
        const { slot, u } = old;
        s.sellDevice(old.id);
        if (!s.buyDevice('sw-48', slot, u).ok) return false;
      } else s.sellDevice(old.id);
      event(`${old.name}(sw-24)を sw-48 に入れ替える`);
      return true;
    }
    return coreUp();
  };
  const fix = (): boolean => {
    // つながっていない機器: そのラックにスイッチを足す
    for (const id of f.unwired.keys()) {
      const d = f.devices.get(id)!;
      // スイッチがつながらないのはコアのポート不足
      if (cat(d) === 'switch') return addAgg(`${d.name} が未接続`);
      if (all().filter((x) => cat(x) === 'switch' && x.slot === d.slot).length >= 3) continue;
      const tor: ModelId = s.unlocks.has('tenGig') ? 'sw-48' : 'sw-24';
      const u = findU(tor, d.slot);
      if (u !== null && s.buyDevice(tor, d.slot, u).ok) {
        event(`ラック ${d.slot + 1} に ${tor} を追加(${d.name} が未接続)`);
        return true;
      }
    }
    // 「肩代わり」の警告: 専用のサーバを置く
    for (const svc of s.activeServices) {
      for (const p of s.flow.services[svc]?.problems ?? []) {
        const m = /役割「(search|media|worker)」がない/.exec(p);
        if (m && s.money > 3000) return addServer(roleKey(svc, m[1] as RoleId));
      }
    }
    const b = s.flow.bottleneck;
    if (!b || b.rho <= BUSY) return false;
    const label = b.label;
    if (label.includes('⇄')) {
      const [x, y] = label.split(' の')[0].split(' ⇄ ').map((n) => byName(n));
      return x && y ? fixLink(x, y) : false;
    }
    const dev = byName(label.split(' ')[0]);
    if (!dev) return false;
    if (cat(dev) === 'server') return fixServer(dev, label);
    if (cat(dev) === 'lb') return lbTo10G();
    if (cat(dev) === 'switch') return coreUp();
    return false;
  };

  // ---------------------------------------------------------------- 余裕があれば投資

  const SERVICE_ORDER = ['shop', 'photo', 'video'] as const;
  const invest = (): boolean => {
    const b = s.flow.bottleneck;
    const calm = (!b || b.rho < BUSY) && s.metrics.rolling.errorRate < 0.01;
    // 始めたばかりのサービスに web と db を置く
    for (const svc of s.activeServices) {
      const inst = s.flow.services[svc]?.instances;
      if (inst && !inst.db.length) return addServer(roleKey(svc, 'db'));
      if (inst && !inst.web.length) return addServer(roleKey(svc, 'web'));
    }
    const options: [string, number, () => boolean][] = [];
    if (s.users > 0.7 * s.marketSize) options.push(['広告', s.upgradeCost('marketing'), () => s.buyUpgrade('marketing').ok]);
    options.push(['収益化', s.upgradeCost('monetize'), () => s.buyUpgrade('monetize').ok]);
    if (calm) {
      for (const id of ['images', 'comments'] as const) if (!s.unlocks.has(id)) options.push([id, unlockCost(id), () => s.unlock(id).ok]);
      // 新しいサービスは、サーバを買うお金も残して
      const next = SERVICE_ORDER.find((id) => !s.unlocks.has(id));
      if (next && s.canUnlock(next) === null) options.push([`${SERVICES[next as ServiceId].name}を始める`, unlockCost(next) * 1.5, () => s.unlock(next).ok]);
      if (!s.unlocks.has('hadoop')) options.push(['分析基盤', unlockCost('hadoop') * 2, () => s.unlock('hadoop').ok]);
      else if (!s.unlocks.has('ml')) options.push(['機械学習', unlockCost('ml') * 2, () => s.unlock('ml').ok]);
    }
    // 分析基盤のサーバ
    if (s.unlocks.has('hadoop') && !s.flow.analytics.hadoop.length && s.money > 5000) return addServer('data:hadoop');
    if (s.unlocks.has('ml') && !s.flow.analytics.ml.length && s.money > 30_000) return addServer('data:ml');
    options.sort((x, y) => x[1] - y[1]);
    const [name, cost, go] = options[0] ?? [];
    if (name && s.money >= cost! && go!()) {
      event(`${name} ($${Math.round(cost!)})`);
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- 回す

  const goals: string[] = [];
  let goalsSeen = 0;
  // BOT_WALL=秒: 実時間がこれを超えたら、そこまでの結果を出して終わる(終盤は計算に時間がかかる)
  const deadline = Date.now() + Number(process.env.BOT_WALL ?? 1e9) * 1000;
  for (let sec = 0; sec <= MINUTES * 60; sec++) {
    if (Date.now() > deadline) {
      event('時間切れ(BOT_WALL)');
      break;
    }
    if (sec % 300 === 0) {
      const r = s.metrics.rolling;
      const servers = all().filter((d) => cat(d) === 'server').length;
      const users = s.activeServices.map((id) => `${id} ${Math.round(s.serviceUsers[id])}`).join(' / ');
      log.push(
        `== ${String(sec / 60).padStart(3)}m  $${Math.round(s.money)}  収支 ${s.incomePerSec.toFixed(1)}/s  ` +
          `${r.pv.toFixed(0)} PV/s  err ${(r.errorRate * 100).toFixed(1)}%  p99 ${Math.round(r.p99Ms)}ms  ` +
          `サーバ ${servers}  ラック ${f.racks.size}  目標 ${s.goalsDone}/${GOALS.length}  ` +
          `詰まり ${s.flow.bottleneck ? `${s.flow.bottleneck.label} ${(s.flow.bottleneck.rho * 100).toFixed(0)}%` : '-'}\n` +
          `          ユーザー ${users}(市場 ${Math.round(s.marketSize)})  単価 ×${s.flow.analytics.boost.toFixed(2)}`,
      );
    }
    s.step(1000);
    if (s.goalsDone > goalsSeen) {
      goalsSeen = s.goalsDone;
      goals.push(`目標 ${goalsSeen}: ${(s.time / 60000).toFixed(1)} 分`);
      event(`目標 ${goalsSeen} 達成`);
    }
    for (let i = 0; i < 10 && (fix() || invest()); i++);
  }
  console.log(log.join('\n'));
  console.log(`\n目標の達成時刻: ${goals.join('、') || 'なし'}`);
  console.log('最後に手が止まった理由', stuck, '/ 詰まり', s.flow.bottleneck?.label);
  console.log('最後の警告', JSON.stringify(s.flow.problems));
  console.log('最後の構成', JSON.stringify(all().map((d) => [d.name, d.model, d.roles.join('+'), d.slot])));
  if (process.env.BOT_SAVE) console.log(`SAVE ${JSON.stringify(createSave(s))}`);
});
