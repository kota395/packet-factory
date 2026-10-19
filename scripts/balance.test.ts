/**
 * バランス確認用のボット。貪欲に投資しながら遊び、進行の速さをログに出す。
 *   npm run balance               # 60 分ぶん
 *   BOT_MIN=20 npm run balance    # 時間を指定
 * 調整値(src/sim/config.ts, economy.ts)を変えたら、ログの節目の時刻を見比べる。
 */
import { it } from 'vitest';
import { UNLOCK_BY_ID } from '../src/sim/economy';
import { newGame } from '../src/sim/save';
import type { NodeRuntime, Simulation } from '../src/sim/simulation';

// Node の型定義を入れずに環境変数だけ読む
declare const process: { env: Record<string, string | undefined> };

const MINUTES = Number(process.env.BOT_MIN ?? 60);
const SEED = Number(process.env.BOT_SEED ?? 11);

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
  for (let x = col; x < 16; x++) for (const y of [4, 3, 5, 2, 6, 1, 7, 0, 8]) if (!s.nodeAt(x, y)) return [x, y];
  return null;
}

it(`balance bot (${MINUTES} min)`, () => {
  const s = newGame(SEED);
  const log: string[] = [];
  const event = (m: string) => log.push(`${(s.time / 60000).toFixed(1).padStart(5)}m  ${m}`);
  let lb: number | null = null;

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
        const id = s.addNode('lb', 2, 4).id;
        if (id === undefined) return false;
        lb = id;
        for (const o of [...s.nodes.get(s.internetId)!.out]) s.disconnect(s.internetId, o);
        s.connect(s.internetId, lb);
        for (const w of webs) s.connect(lb, w.id);
        event('LB 経由に配線');
        return true;
      }
      const p = freeCell(s, 4);
      if (p && s.money >= s.nodeCost('web')) {
        const id = s.addNode('web', p[0], p[1]).id!;
        s.connect(lb, id);
        for (const d of dbs) s.connect(id, d.id);
        return true;
      }
    }

    // CDN: 導入したら NET と LB の間に挟む。詰まったら回線増強
    const cdns = ofKind(s, 'cdn');
    if (s.unlocks.has('cdn') && !cdns.length && lb !== null && s.money >= s.nodeCost('cdn')) {
      const id = s.addNode('cdn', 1, 4).id!;
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

    // 3. 書き込みを解放済みで DB が足りなければ増設
    if (s.unlocks.has('writes') && (dbs.length === 0 || load(s, dbs) > 0.7) && s.money >= s.nodeCost('db')) {
      const p = freeCell(s, 9);
      if (p) {
        const id = s.addNode('db', p[0], p[1]).id!;
        for (const w of webs) s.connect(w.id, id);
        if (dbs.length === 0) event('DB 設置(書き込み開始)');
        return true;
      }
    }

    // 4. それ以外は一番安い投資を買う
    const options: [string, number, () => boolean][] = [];
    if (s.users > 0.7 * s.marketSize) options.push(['広告', s.upgradeCost('marketing'), () => s.buyUpgrade('marketing').ok]);
    options.push(['収益化', s.upgradeCost('monetize'), () => s.buyUpgrade('monetize').ok]);
    if (webs.length >= 3) options.push(['WEB 強化', s.upgradeCost('webPerf'), () => s.buyUpgrade('webPerf').ok]);
    if (dbs.length >= 2) options.push(['DB 強化', s.upgradeCost('dbPerf'), () => s.buyUpgrade('dbPerf').ok]);
    if (cdns.length) options.push(['CDN キャッシュ', s.upgradeCost('cdnCache'), () => s.buyUpgrade('cdnCache').ok]);
    if (s.unlocks.has('lb') && !s.unlocks.has('writes')) {
      options.push(['会員機能', UNLOCK_BY_ID.writes.cost, () => s.unlock('writes').ok]);
    }
    // 配信コンテンツは LB の帯域に余裕があるときだけ増やす
    if (lbs.length && load(s, lbs) < 0.4) {
      for (const id of ['images', 'cdn', 'video'] as const) {
        if (!s.unlocks.has(id) && s.canUnlock(id) !== '「' + UNLOCK_BY_ID[UNLOCK_BY_ID[id].requires!]?.name + '」が必要です') {
          options.push([UNLOCK_BY_ID[id].name, UNLOCK_BY_ID[id].cost, () => s.unlock(id).ok]);
        }
      }
    }
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
          `err ${(r.errorRate * 100).toFixed(1)}%  p99 ${r.p99}ms  WEB ${ofKind(s, 'web').length} DB ${ofKind(s, 'db').length}  ` +
          `LB回線 ${s.upgrades.lbBandwidth}  コンテンツ ${[...s.unlocks].filter((u) => u === 'images' || u === 'video').join(',') || '-'}`,
      );
    }
    s.step(1000);
    for (let i = 0; i < 20 && act(); i++);
  }
  console.log(log.join('\n'));
});
