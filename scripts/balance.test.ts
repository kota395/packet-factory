/**
 * バランス確認用のボット。貪欲に投資しながら遊び、進行の速さをログに出す。
 *   npm run balance               # 60 分ぶん
 *   BOT_MIN=20 npm run balance    # 時間を指定
 * 調整値(src/sim/config.ts, pricing.ts, economy.ts)を変えたら、ログの節目の時刻を見比べる。
 */
import { it } from 'vitest';
import { GRID_H, GRID_W, INTERNET_POS } from '../src/sim/config';
import { UNLOCK_BY_ID, unlockCost } from '../src/sim/economy';
import { newGame } from '../src/sim/save';
import type { NodeRuntime, Simulation } from '../src/sim/simulation';
import type { UpgradeId } from '../src/sim/types';

// Node の型定義を入れずに環境変数だけ読む
declare const process: { env: Record<string, string | undefined> };

const MINUTES = Number(process.env.BOT_MIN ?? 60);
const SEED = Number(process.env.BOT_SEED ?? 11);

/** ログ上の名前 → 強化 ID(上限チェック用) */
const UPGRADE_IDS: Record<string, UpgradeId | undefined> = {
  広告: 'marketing',
  収益化: 'monetize',
  'WEB 強化': 'webPerf',
  'DB 強化': 'dbPerf',
  キャッシュ容量: 'cacheMemory',
  'CDN キャッシュ': 'cdnCache',
};

const ofKind = (s: Simulation, kind: string) => [...s.nodes.values()].filter((n) => n.kind === kind);

/** ノード群の負荷率(届いている量の合計 / 捌ける上限の合計)。プレイヤーがノードの数字から読むのと同じ値 */
function load(s: Simulation, ns: NodeRuntime[]): number {
  let inRps = 0;
  let cap = 0;
  for (const n of ns) {
    inRps += s.inRpsOf(n);
    cap += s.capacityRpsOf(n);
  }
  return cap > 0 ? inRps / cap : 0;
}

/** col 列目以降で空いているマス(中央の行から優先) */
function freeCell(s: Simulation, col: number): [number, number] | null {
  // インターネットから col 列右以降で、インターネットの行に近いマスから埋める
  const rows = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8].map((d) => INTERNET_POS.y + d);
  for (let x = INTERNET_POS.x + col; x < GRID_W; x++) {
    for (const y of rows) if (y >= 0 && y < GRID_H && !s.nodeAt(x, y)) return [x, y];
  }
  return null;
}

it(`balance bot (${MINUTES} min)`, () => {
  const s = newGame(SEED);
  const log: string[] = [];
  const event = (m: string) => log.push(`${(s.time / 60000).toFixed(1).padStart(5)}m  ${m}`);
  let lb: number | null = null;

  /** WEB をデータ層(キャッシュ・DB・レプリカ)へつなぐ。接続数の上限までは全部につなぐ */
  const wireWeb = (web: number) => {
    for (const kind of ['cache', 'db', 'replica']) for (const n of ofKind(s, kind)) s.connect(web, n.id);
  };
  /** データ層のノードを 1 つ置き、必要な線を引く */
  const placeData = (kind: 'cache' | 'db' | 'replica', col: number): boolean => {
    const p = freeCell(s, col);
    if (!p || s.money < s.nodeCost(kind)) return false;
    const r = s.addNode(kind, p[0], p[1]);
    if (!r.ok) return false;
    const id = r.id!;
    for (const w of ofKind(s, 'web')) s.connect(w.id, id);
    if (kind === 'cache') for (const d of [...ofKind(s, 'db'), ...ofKind(s, 'replica')]) s.connect(id, d.id);
    if (kind === 'replica') {
      for (const d of ofKind(s, 'db')) s.connect(d.id, id);
      for (const c of ofKind(s, 'cache')) s.connect(c.id, id);
    }
    if (kind === 'db') {
      for (const r of ofKind(s, 'replica')) s.connect(id, r.id);
      for (const c of ofKind(s, 'cache')) s.connect(c.id, id);
    }
    event(`${kind} 設置`);
    return true;
  };

  /** 1 回投資できたら true */
  const act = (): boolean => {
    const webs = ofKind(s, 'web');
    const dbs = ofKind(s, 'db');
    const lbs = ofKind(s, 'lb');

    // 1. LB が詰まっていたら回線増強を最優先(買えるまで他に使わない)
    if (lbs.length && load(s, lbs) > 0.7) {
      const cost = s.upgradeCost('lbBandwidth');
      if (s.buyUpgrade('lbBandwidth').ok) {
        event(`LB 回線増強 ($${cost})`);
        return true;
      }
      return false;
    }

    // 2. WEB が詰まっていたら増設(2 台目以降は LB が必要)
    if (load(s, webs) > 0.7) {
      if (!s.unlocks.has('lb')) {
        if (s.unlock('lb').ok) event('解放: LB');
        return false;
      }
      if (lb === null) {
        const id = s.addNode('lb', INTERNET_POS.x + 2, INTERNET_POS.y).id;
        if (id === undefined) return false;
        lb = id;
        for (const o of [...s.nodes.get(s.internetId)!.out]) s.disconnect(s.internetId, o);
        s.connect(s.internetId, lb);
        for (const w of webs) s.connect(lb, w.id);
        event('LB 経由に配線');
        return true;
      }
      const p = freeCell(s, 4);
      if (p && webs.length < 64 && s.money >= s.nodeCost('web')) {
        const id = s.addNode('web', p[0], p[1]).id!;
        s.connect(lb, id);
        wireWeb(id);
        return true;
      }
    }

    // CDN: 導入したら NET と LB の間に挟む。詰まったら回線増強
    const cdns = ofKind(s, 'cdn');
    if (s.unlocks.has('cdn') && !cdns.length && lb !== null && s.money >= s.nodeCost('cdn')) {
      const id = s.addNode('cdn', INTERNET_POS.x + 1, INTERNET_POS.y).id!;
      s.disconnect(s.internetId, lb);
      s.connect(s.internetId, id);
      s.connect(id, lb);
      event('CDN 設置');
      return true;
    }
    if (cdns.length && load(s, cdns) > 0.7) {
      const cost = s.upgradeCost('cdnBandwidth');
      if (s.buyUpgrade('cdnBandwidth').ok) {
        event(`CDN 回線増強 ($${cost})`);
        return true;
      }
      return false;
    }

    // 3. データ層。DB が詰まったら キャッシュ → レプリカ → スケールアップ / シャーディング の順で手を打つ
    if (s.unlocks.has('writes')) {
      if (!dbs.length) return placeData('db', 11);
      const caches = ofKind(s, 'cache');
      const replicas = ofKind(s, 'replica');
      if (caches.length && load(s, caches) > 0.7) return placeData('cache', 8);
      const dbBusy = load(s, dbs) > 0.7;
      const readBusy = replicas.length ? load(s, replicas) > 0.7 : dbBusy;
      if (dbBusy || readBusy) {
        if (!caches.length) {
          if (!s.unlocks.has('cache')) return s.unlock('cache').ok && (event('解放: キャッシュ'), true);
          return placeData('cache', 8);
        }
        if (readBusy) {
          if (!s.unlocks.has('replica')) return s.unlock('replica').ok && (event('解放: レプリカ'), true);
          if (placeData('replica', 13)) return true;
        }
        // 読み込みを逃がしても DB が詰まる = 書き込みが多い → シャード
        if (dbBusy && replicas.length >= 1 && !readBusy) {
          if (s.isAtMaxCount('db')) {
            if (!s.unlocks.has('sharding')) {
              const cost = unlockCost('sharding');
              if (s.unlock('sharding').ok) event(`解放: シャーディング ($${cost})`);
              return false;
            }
            const cost = s.upgradeCost('dbShards');
            if (s.buyUpgrade('dbShards').ok) event(`シャード追加 ($${cost})`);
            return false;
          }
          return placeData('db', 11);
        }
      }
    }
    // LB の接続先の上限(64)を超えた WEB は使われないので、それ以上は増やさない

    // 4. それ以外は一番安い投資を買う
    const options: [string, number, () => boolean][] = [];
    if (s.users > 0.7 * s.marketSize) options.push(['広告', s.upgradeCost('marketing'), () => s.buyUpgrade('marketing').ok]);
    options.push(['収益化', s.upgradeCost('monetize'), () => s.buyUpgrade('monetize').ok]);
    if (webs.length >= 3) options.push(['WEB 強化', s.upgradeCost('webPerf'), () => s.buyUpgrade('webPerf').ok]);
    if (dbs.length && load(s, [...dbs, ...ofKind(s, 'replica')]) > 0.5) {
      options.push(['DB 強化', s.upgradeCost('dbPerf'), () => s.buyUpgrade('dbPerf').ok]);
    }
    if (ofKind(s, 'cache').length) options.push(['キャッシュ容量', s.upgradeCost('cacheMemory'), () => s.buyUpgrade('cacheMemory').ok]);
    if (cdns.length) options.push(['CDN キャッシュ', s.upgradeCost('cdnCache'), () => s.buyUpgrade('cdnCache').ok]);
    if (s.unlocks.has('lb') && !s.unlocks.has('writes')) {
      options.push(['会員機能', unlockCost('writes'), () => s.unlock('writes').ok]);
    }
    // 配信コンテンツは LB の帯域に余裕があるときだけ増やす
    if (lbs.length && load(s, lbs) < 0.6) {
      for (const id of ['images', 'cdn', 'video'] as const) {
        if (!s.unlocks.has(id) && s.canUnlock(id) !== '「' + UNLOCK_BY_ID[UNLOCK_BY_ID[id].requires!]?.name + '」が必要です') {
          options.push([UNLOCK_BY_ID[id].name, unlockCost(id), () => s.unlock(id).ok]);
        }
      }
    }
    // 上限に達した強化などは候補から外す
    const buyable = (name: string) => {
      const id = UPGRADE_IDS[name];
      if (!id) return true;
      const err = s.canBuyUpgrade(id);
      return err === null || err === '資金が足りません';
    };
    for (let i = options.length - 1; i >= 0; i--) if (!buyable(options[i][0])) options.splice(i, 1);
    options.sort((a, b) => a[1] - b[1]);
    const [name, cost, buy] = options[0] ?? [];
    if (name && s.money >= cost! && buy!()) {
      event(`${name} ($${cost})`);
      return true;
    }
    return false;
  };

  for (let sec = 0; sec <= MINUTES * 60; sec++) {
    if (sec % 300 === 0) {
      const r = s.metrics.rolling;
      log.push(
        `== ${String(sec / 60).padStart(3)}m  $${Math.round(s.money)}  収支 ${s.incomePerSec.toFixed(1)}/s  ` +
          `ユーザー ${Math.round(s.users)}/${Math.round(s.marketSize)}  ${Math.round(r.rps)} rps  ` +
          `err ${(r.errorRate * 100).toFixed(1)}%  p99 ${r.p99}ms  WEB ${ofKind(s, 'web').length} ` +
          `CACHE ${ofKind(s, 'cache').length} DB ${ofKind(s, 'db').length} REP ${ofKind(s, 'replica').length}  ` +
          `LB回線 ${s.upgrades.lbBandwidth}  コンテンツ ${[...s.unlocks].filter((u) => u === 'images' || u === 'video').join(',') || '-'}`,
      );
    }
    s.step(1000);
    for (let i = 0; i < 20 && act(); i++);
  }
  console.log(log.join('\n'));
});
