/**
 * バランス確認用のボット。一番詰まっている所を見て、プレイヤーがしそうな手を打ちながら遊び、進行の速さをログに出す。
 *   npm run balance               # 60 分ぶん
 *   BOT_MIN=20 npm run balance    # 時間を指定
 * 調整値(src/sim/config.ts, pricing.ts, catalog.ts, economy.ts)を変えたら、ログの節目の時刻を見比べる。
 */
import { it } from 'vitest';
import { MODEL_BY_ID, PRESET_BY_ID, portsOf } from '../src/sim/catalog';
import type { PartChange } from '../src/sim/simulation';
import { RACK } from '../src/sim/config';
import { unlockCost } from '../src/sim/economy';
import { createSave, newGame } from '../src/sim/save';
import type { ModelId, PortRef, RoleKey, UnlockId } from '../src/sim/types';

declare const process: { env: Record<string, string | undefined> };

const MINUTES = Number(process.env.BOT_MIN ?? 60);

it(`balance bot (${MINUTES} min)`, () => {
  const s = newGame();
  const f = s.facility;
  const log: string[] = [];
  const event = (m: string) => log.push(`${(s.time / 60000).toFixed(1).padStart(5)}m  ${m}`);

  const devices = (pred: (d: { model: ModelId; roles: RoleKey[] }) => boolean) => [...f.devices.values()].filter(pred);
  const isSwitch = (m: ModelId) => MODEL_BY_ID[m].category === 'switch';
  const freePort = (id: number): PortRef | null => {
    const d = f.devices.get(id)!;
    for (let i = 0; i < portsOf(d).length; i++) if (!f.cableAt({ device: id, port: i })) return { device: id, port: i };
    return null;
  };
  /** そのラックで、上から空いている U を探す(電力も見る) */
  const findU = (model: ModelId, slot: number): number | null => {
    for (let u = RACK.units - MODEL_BY_ID[model].u + 1; u >= 1; u--) if (!s.placeError(model, slot, u)) return u;
    return null;
  };
  /** サーバ(プリセット)を買って、同じラックの ToR(なければ最初のスイッチ)につなぐ */
  const buyServer = (preset: string, roles: RoleKey[]): number | null => {
    const { model, parts } = PRESET_BY_ID[preset];
    // ケーブル代も残しておく
    if (s.money < s.devicePrice(model, parts) + 30) return null;
    for (const slot of [...f.racks.keys()].sort((a, b) => a - b)) {
      const tor = devices((d) => isSwitch(d.model)).find((d) => (d as { slot: number }).slot === slot && freePort(d.id) !== null);
      let u: number | null = null;
      for (let x = RACK.units - MODEL_BY_ID[model].u + 1; x >= 1 && u === null; x--) if (!s.placeError(model, slot, x, undefined, parts)) u = x;
      if (u === null || !tor) continue;
      const r = s.buyServer(preset, slot, u);
      if (!r.ok) continue;
      s.connect({ device: r.id!, port: 0 }, freePort(tor.id)!);
      for (const role of roles) s.toggleRole(r.id!, role);
      event(`${preset} 設置(${roles.join('+') || '役割なし'})`);
      return r.id!;
    }
    return null;
  };
  /** LB アプライアンスを買って ToR につなぐ */
  const buyLb = (): boolean => {
    if (s.money < s.devicePrice('lb-1u') + 30) return false;
    for (const slot of [...f.racks.keys()]) {
      const tor = devices((d) => isSwitch(d.model)).find((d) => (d as { slot: number }).slot === slot && freePort(d.id) !== null);
      const u = findU('lb-1u', slot);
      if (u === null || !tor) continue;
      const r = s.buyDevice('lb-1u', slot, u);
      if (!r.ok) continue;
      s.connect({ device: r.id!, port: 0 }, freePort(tor.id)!);
      event('LB アプライアンス設置');
      return true;
    }
    return false;
  };
  const tryUnlock = (id: UnlockId) => {
    if (s.unlocks.has(id) || s.money < unlockCost(id)) return false;
    const ok = s.unlock(id).ok;
    if (ok) event(`解放: ${id} ($${unlockCost(id)})`);
    return ok;
  };
  /** 2 本目以降のラック: ToR を置き、1 本目の ToR へ 2 本束ねてつなぐ */
  const expand = (): boolean => {
    const slot = [...f.racks.keys()].length;
    if (s.money < s.rackPrice() + 400) return false;
    if (!s.rentRack(slot).ok) return false;
    const r = s.buyDevice('sw-24', slot, RACK.units - 1);
    const core = devices((d) => d.model === 'sw-24')[0];
    for (let i = 0; i < 2; i++) {
      const a = freePort(core.id);
      const b = freePort(r.id!);
      if (a && b) s.connect(a, b);
    }
    event(`ラック ${slot + 1} を借りて ToR を設置`);
    return true;
  };

  const act = (): boolean => fix() || invest();

  /** 回線終端を 10G のスイッチ(sw-48 の SFP+)に付け替える */
  const coreTo10G = (): boolean => {
    if (!s.unlocks.has('tenGig')) return tryUnlock('tenGig');
    if (devices((d) => d.model === 'sw-48').length) return false;
    const u = findU('sw-48', 0);
    if (u === null || s.money < s.devicePrice('sw-48') + 300) return false;
    const core = s.buyDevice('sw-48', 0, u).id!;
    const isp = devices((d) => d.model === 'handoff')[0];
    const old = f.cablesOf(isp.id)[0];
    const tor = devices((d) => d.model === 'sw-24')[0];
    if (old) s.disconnect(old.id);
    s.connect({ device: isp.id, port: 0 }, { device: core, port: 48 });
    for (let i = 0; i < 4; i++) {
      const a = freePort(tor.id);
      if (a) s.connect({ device: core, port: i }, a);
    }
    event('sw-48 を入れて回線を 10G で受け、sw01 へ 4 本束ねる');
    return true;
  };

  const fix = (): boolean => {
    const flow = s.flow;
    const b = flow.bottleneck;
    if (b && b.rho > 0.75) {
      const label = b.label;
      // 回線が詰まっていれば契約を上げる
      if (label.startsWith('isp01')) {
        const link = flow.links.find((l) => f.devices.get(l.a)?.model === 'handoff' || f.devices.get(l.b)?.model === 'handoff');
        if (link && link.capacityGbps < s.uplinkGbps) return coreTo10G();
        if (s.canBuyUpgrade('uplink') === null) {
          s.buyUpgrade('uplink');
          event(`回線契約 → ${s.uplinkGbps} Gbps`);
          return true;
        }
        return false;
      }
      const name = label.split(' ')[0];
      const dev = [...f.devices.values()].find((d) => d.name === name);
      if (dev && MODEL_BY_ID[dev.model].category === 'server') {
        /** パーツを替えてみる(お金と電力が足りれば) */
        const upgrade = (change: PartChange) => {
          const r = s.changeParts(dev.id, change);
          if (r.ok) event(`${dev.name} 強化: ${change.kind}${'type' in change ? ` ${change.type}` : ''}${'to' in change ? ` ${change.to}` : ''}`);
          return r.ok;
        };
        const p = dev.parts!;
        // ディスク IO: メモリ → SSD に替える → ドライブを足す → (db なら)キャッシュ・レプリカ
        if (label.includes('ディスク IO')) {
          if (p.memGB < 64 && s.partChangeInfo(dev.id, { kind: 'mem', dir: 1 }).cost < s.money / 2) return upgrade({ kind: 'mem', dir: 1 });
          if (p.backplane === 'lff' && s.money > 1500) return upgrade({ kind: 'backplane', to: 'sff' });
          if (p.backplane === 'sff' && p.drives.length < 8 && upgrade({ kind: 'drive-add', type: 'ssd' })) return true;
          if (dev.roles.includes('blog:db')) {
            if (!s.unlocks.has('cache')) return tryUnlock('cache');
            if (!flow.services.blog!.instances.cache.length) return buyServer('1u-small', ['blog:cache']) !== null;
            if (!s.unlocks.has('replication')) return tryUnlock('replication');
          }
          return buyServer('2u-ssd', ['blog:replica']) !== null || powerOrRack('2u-ssd');
        }
        // CPU: 16 コアまでは CPU を替える。そのあとは台数を足す
        if (p.cpu < 16 && upgrade({ kind: 'cpu', dir: 1 })) return true;
        if (dev.roles.includes('blog:db') || dev.roles.includes('blog:replica')) {
          if (p.cpu < 64 && upgrade({ kind: 'cpu', dir: 1 })) return true;
          return buyServer('2u-ssd', ['blog:replica']) !== null || powerOrRack('2u-ssd');
        }
        // web が詰まっている: LB の後ろに web を足す
        if (dev.roles.includes('blog:web') || dev.roles.includes('blog:lb')) {
          if (!s.unlocks.has('lb')) return tryUnlock('lb');
          // LB アプライアンスを 1 台置く(あれば web を足す)
          if (![...f.devices.values()].some((d) => d.model === 'lb-1u')) return buyLb();
          const id = buyServer('1u-web', ['blog:web']);
          return id !== null || powerOrRack('1u-web');
        }
      }
      // リンクの帯域: 空きポートがあれば束ね、サーバの NIC が埋まっていれば同じ役割のサーバを足す
      if (label.includes('⇄')) {
        const [x, y] = label.split(' の')[0].split(' ⇄ ').map((n) => [...f.devices.values()].find((d) => d.name === n)!);
        const a = freePort(x.id);
        const c = freePort(y.id);
        if (a && c && s.connect(a, c).ok) {
          event(`${x.name} ⇄ ${y.name} を 1 本追加`);
          return true;
        }
        const server = [x, y].find((d) => MODEL_BY_ID[d.model].category === 'server');
        if (server && server.roles.length) {
          const role = server.roles[0];
          return buyServer('1u-web', [role]) !== null || powerOrRack('1u-web');
        }
      }
    }
    return false;
  };

  /** 詰まりに手を打てないときは、一番安い事業投資 */
  const invest = (): boolean => {
    const b = s.flow.bottleneck;
    const options: [string, number, () => boolean][] = [];
    if (s.users > 0.7 * s.marketSize) options.push(['広告', s.upgradeCost('marketing'), () => s.buyUpgrade('marketing').ok]);
    options.push(['収益化', s.upgradeCost('monetize'), () => s.buyUpgrade('monetize').ok]);
    for (const id of ['images', 'comments'] as const) {
      if (!s.unlocks.has(id) && (!b || b.rho < 0.75)) options.push([id, unlockCost(id), () => s.unlock(id).ok]);
    }
    options.sort((x, y) => x[1] - y[1]);
    const [name, cost, buy] = options[0] ?? [];
    if (name && s.money >= cost! && buy!()) {
      event(`${name} ($${cost})`);
      return true;
    }
    return false;
  };

  /** 電力が足りずに置けないとき: 電力契約 → ラック追加 */
  /** 置き場所(U と電力)がなければ、電力契約かラックを増やす */
  const powerOrRack = (preset: string): boolean => {
    const { model, parts } = PRESET_BY_ID[preset];
    const anywhere = [...f.racks.keys()].some((slot) => {
      for (let u = 1; u <= RACK.units; u++) if (!s.placeError(model, slot, u, undefined, parts)) return true;
      return false;
    });
    if (anywhere) return false;
    if (s.canBuyUpgrade('rackPower') === null) {
      s.buyUpgrade('rackPower');
      event(`電力契約 → ${s.rackPowerW}W`);
      return true;
    }
    return expand();
  };

  for (let sec = 0; sec <= MINUTES * 60; sec++) {
    if (sec % 300 === 0) {
      const r = s.metrics.rolling;
      const servers = devices((d) => MODEL_BY_ID[d.model].category === 'server').length;
      log.push(
        `== ${String(sec / 60).padStart(3)}m  $${Math.round(s.money)}  収支 ${s.incomePerSec.toFixed(1)}/s  ` +
          `ユーザー ${Math.round(s.users)}/${Math.round(s.marketSize)}  ${r.pv.toFixed(0)} PV/s  ` +
          `err ${(r.errorRate * 100).toFixed(1)}%  p99 ${Math.round(r.p99Ms)}ms  サーバ ${servers}  ラック ${f.racks.size}  ` +
          `詰まり ${s.flow.bottleneck ? `${s.flow.bottleneck.label} ${(s.flow.bottleneck.rho * 100).toFixed(0)}%` : '-'}`,
      );
    }
    s.step(1000);
    for (let i = 0; i < 10 && act(); i++);
  }
  console.log(log.join("\n"));
  // BOT_SAVE=1 なら最後の状態をセーブとして出す(画面確認用)
  if (process.env.BOT_SAVE) console.log(`SAVE ${JSON.stringify(createSave(s))}`);
  console.log("最後の構成", JSON.stringify(s.flow.problems), JSON.stringify([...f.devices.values()].map((d) => [d.name, d.roles, d.slot, d.u])), JSON.stringify([...f.cables.values()].map((c) => [c.a, c.b])));
});
