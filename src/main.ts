import './style.css';
import { BoardRenderer } from './render/board';
import { BASE_REVENUE, NODE_DEFS, OFFLINE, PLACEABLE_KINDS, SELL_REFUND_RATE } from './sim/config';
import { UNLOCK_BY_ID } from './sim/economy';
import {
  createSave,
  decodeSave,
  encodeSave,
  loadSave,
  newGame,
  offlineEarnings,
  parseSave,
  type SaveData,
} from './sim/save';
import type { Simulation } from './sim/simulation';
import type { NodeKind } from './sim/types';
import { MetricsChart } from './ui/chart';
import { bandwidth, compact, dataSize, duration, money, rate } from './ui/format';
import { InvestPanel } from './ui/invest';

type Tool = 'select' | NodeKind | 'connect' | 'delete';

const SAVE_KEY = 'packet-factory:save:v2';
const AUTOSAVE_MS = 5000;
const CHURN_WARN_INTERVAL_MS = 20_000;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  money: el('s-money'),
  income: el('s-income'),
  users: el('s-users'),
  rps: el('s-rps'),
  err: el('s-err'),
  p99: el('s-p99'),
  board: el('board'),
  info: el('info'),
  toast: el('toast'),
  hint: el('hint'),
  toolbar: el('toolbar'),
  chartPanel: el('chart-panel'),
  chart: el('chart'),
  modal: el('modal'),
  modalCard: el('modal-card'),
};

const state = {
  sim: newGame(newSeed()),
  tool: 'select' as Tool,
  selectedId: null as number | null,
  connectFrom: null as number | null,
  speed: 1,
  lastChurnWarn: 0,
};

const renderer = new BoardRenderer();
const chart = new MetricsChart(ui.chart);
const invest = new InvestPanel(
  el('invest'),
  el('invest-list'),
  el('invest-money'),
  () => state.sim,
  (message, ok) => {
    if (message) toast(message);
    if (ok) {
      saveGame();
      updateHud();
    }
  },
);

// ------------------------------------------------------------------ 起動

buildToolbar();
await renderer.init(ui.board);
renderer.onCellTap = handleCellTap;
renderer.onNodeMove = (id, x, y) => {
  const r = state.sim.moveNode(id, x, y);
  if (!r.ok && r.message) toast(r.message);
  state.selectedId = id;
  updateInfo();
};
bindControls();
const restored = restoreGame();
setTool('select');
setSpeed(1);
updateHud();
if (!restored) showWelcome();

let hudTimer = 0;
let saveTimer = 0;
renderer.app.ticker.add((ticker) => {
  const sim = state.sim;
  if (state.speed > 0) sim.step(Math.min(ticker.deltaMS, 100) * state.speed);

  renderer.draw(sim, { selectedId: state.selectedId, connectFrom: state.connectFrom });

  hudTimer += ticker.deltaMS;
  if (hudTimer >= 200) {
    hudTimer = 0;
    updateHud();
  }
  saveTimer += ticker.deltaMS;
  if (saveTimer >= AUTOSAVE_MS) {
    saveTimer = 0;
    saveGame();
  }
});

window.addEventListener('resize', () => chart.resize());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveGame();
});
window.addEventListener('pagehide', saveGame);

// ------------------------------------------------------------------ 盤面操作

function handleCellTap(x: number, y: number): void {
  const sim = state.sim;
  const node = sim.nodeAt(x, y);

  switch (state.tool) {
    case 'select':
      state.selectedId = node?.id ?? null;
      break;

    case 'connect':
      if (!node) {
        state.connectFrom = null;
      } else if (state.connectFrom === null) {
        if (node.def.maxOut === 0) toast(`${node.def.name}から先へは接続できません`);
        else state.connectFrom = node.id;
      } else if (state.connectFrom === node.id) {
        state.connectFrom = null;
      } else {
        const r = sim.toggleEdge(state.connectFrom, node.id);
        if (r.message) toast(r.message);
        // 接続元は選択したままにして、続けて複数の接続先へつなげるようにする
      }
      break;

    case 'delete':
      if (node) {
        const r = sim.removeNode(node.id);
        if (r.message) toast(r.message);
        if (state.selectedId === node.id) state.selectedId = null;
      }
      break;

    default: {
      // 配置ツール
      if (node) {
        state.selectedId = node.id;
        break;
      }
      const r = sim.addNode(state.tool, x, y);
      if (!r.ok) toast(r.message ?? '配置できません');
      else state.selectedId = r.id ?? null;
    }
  }
  updateInfo();
  updateHint();
  updateToolbar();
}

// ------------------------------------------------------------------ ツールバー

function buildToolbar(): void {
  const items: { tool: Tool | 'invest'; html: string }[] = [
    { tool: 'select', html: '選択' },
    ...PLACEABLE_KINDS.map((k) => {
      const d = NODE_DEFS[k];
      const hex = `#${d.color.toString(16).padStart(6, '0')}`;
      return {
        tool: k as Tool,
        html: `<span><span class="swatch" style="background:${hex}"></span>${d.label}</span><small data-cost="${k}"></small>`,
      };
    }),
    { tool: 'connect', html: '接続' },
    { tool: 'delete', html: '撤去' },
    { tool: 'invest', html: '投資<span class="badge" hidden></span>' },
  ];
  ui.toolbar.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tool = item.tool;
    b.innerHTML = item.html;
    if (item.tool === 'invest') {
      b.classList.add('invest');
      b.addEventListener('click', () => {
        invest.toggle();
        updateToolbar();
      });
    } else {
      b.addEventListener('click', () => setTool(item.tool as Tool));
    }
    ui.toolbar.appendChild(b);
  }
}

function setTool(tool: Tool): void {
  state.tool = tool;
  state.connectFrom = null;
  if (invest.isOpen) invest.toggle(false);
  updateToolbar();
  updateHint();
}

function updateToolbar(): void {
  const sim = state.sim;
  for (const b of ui.toolbar.querySelectorAll<HTMLButtonElement>('button')) {
    const t = b.dataset.tool!;
    b.classList.toggle('active', t === 'invest' ? invest.isOpen : t === state.tool && !invest.isOpen);
  }
  for (const k of PLACEABLE_KINDS) {
    const label = ui.toolbar.querySelector<HTMLElement>(`[data-cost="${k}"]`);
    if (!label) continue;
    const unlocked = sim.isKindUnlocked(k);
    const maxed = unlocked && sim.isAtMaxCount(k);
    label.textContent = !unlocked ? '🔒' : maxed ? '設置済' : money(sim.nodeCost(k));
    label.classList.toggle('short', unlocked && !maxed && sim.money < sim.nodeCost(k));
  }
  const badge = ui.toolbar.querySelector<HTMLElement>('.badge');
  if (badge) badge.hidden = !invest.anyAffordable(sim);
}

function updateHint(): void {
  const sim = state.sim;
  let text: string;
  switch (state.tool) {
    case 'select':
      text = 'ノードをタップで状態を確認、ドラッグで移動。数字は「届いている量/捌ける上限」(rps)です。';
      break;
    case 'connect':
      text =
        state.connectFrom === null
          ? '接続元のノードをタップ。'
          : '接続先をタップ(続けて複数つなげます)。同じ線をもう一度つなぐと解除、空きマスで終了。';
      break;
    case 'delete':
      text = `撤去するノードをタップ(購入額の ${SELL_REFUND_RATE * 100}% を返金)。`;
      break;
    default: {
      const d = NODE_DEFS[state.tool];
      if (sim.isKindUnlocked(state.tool) && sim.isAtMaxCount(state.tool)) {
        text = `${d.name}はサービス 1 つにつき ${d.maxCount} 台までです。帯域は投資の「LB 回線増強」で増やせます。`;
      } else if (!sim.isKindUnlocked(state.tool)) {
        text = `🔒 ${d.name}は投資メニューの「${UNLOCK_BY_ID[d.requires!].name}」で解放できます。`;
      } else {
        text = `空きマスをタップして${d.name}を配置(${money(sim.nodeCost(state.tool))}、維持費 $${d.upkeepPerSec}/秒)。${d.description}`;
      }
    }
  }
  ui.hint.textContent = text;
}

// ------------------------------------------------------------------ HUD・操作ボタン

function bindControls(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  }

  el('btn-chart').addEventListener('click', (e) => {
    const show = ui.chartPanel.hidden !== false;
    ui.chartPanel.hidden = !show;
    (e.currentTarget as HTMLElement).classList.toggle('active', show);
    if (show) chart.update(state.sim.metrics.history, true);
    chart.resize();
  });

  el('btn-save').addEventListener('click', showSaveMenu);
  el('invest-close').addEventListener('click', () => {
    invest.toggle(false);
    updateToolbar();
  });
}

function setSpeed(speed: number): void {
  state.speed = speed;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.classList.toggle('active', Number(b.dataset.speed) === speed);
  }
}

function updateHud(): void {
  const sim = state.sim;
  const r = sim.metrics.rolling;
  const income = sim.incomePerSec;

  ui.money.textContent = money(sim.money);
  ui.money.className = `v ${sim.money < 0 ? 'bad' : ''}`;
  ui.income.textContent = rate(income);
  ui.income.className = `v ${income < 0 ? 'bad' : 'ok'}`;
  ui.users.textContent = `${compact(sim.users)} / ${compact(sim.marketSize)}`;
  ui.rps.textContent = compact(r.rps);
  ui.err.textContent = `${(r.errorRate * 100).toFixed(1)}%`;
  ui.err.className = `v ${r.errorRate > 0.05 ? 'bad' : r.errorRate > 0.01 ? 'warn' : ''}`;
  ui.p99.textContent = r.rps > 0 ? `${r.p99}ms` : '-';
  ui.p99.className = `v ${r.p99 > 1000 ? 'bad' : r.p99 > 500 ? 'warn' : ''}`;

  if (r.errorRate > 0.05 && performance.now() - state.lastChurnWarn > CHURN_WARN_INTERVAL_MS) {
    state.lastChurnWarn = performance.now();
    toast('エラーが多く、ユーザーが離脱しています');
  }

  if (!ui.chartPanel.hidden) chart.update(sim.metrics.history);
  invest.update();
  updateToolbar();
  updateInfo();
}

function updateInfo(): void {
  const node = state.selectedId === null ? undefined : state.sim.nodes.get(state.selectedId);
  if (!node) {
    ui.info.hidden = true;
    delete ui.info.dataset.key;
    return;
  }
  const sim = state.sim;
  const d = node.def;
  const rows: [string, string][] = [];
  const inRps = sim.inRpsOf(node);
  const cap = sim.capacityRpsOf(node);
  const loadSpan = (ratio: number) =>
    `<span class="${ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok'}">${Math.round(ratio * 100)}%</span>`;
  if (node.kind === 'internet') {
    rows.push(['送出', `${compact(inRps, 1)} rps`]);
    rows.push(['データ量', `${bandwidth(node.inKBps / 1000)}(平均 ${dataSize(inRps > 0 ? node.inKBps / inRps : 0)}/件)`]);
  } else {
    rows.push(['受信', `${compact(inRps, 1)} rps`]);
    if (Number.isFinite(cap)) {
      rows.push(['上限', `${compact(cap, 1)} rps`]);
      rows.push(['負荷', `${loadSpan(inRps / cap)}(余裕 ${compact(Math.max(0, cap - inRps), 1)} rps)`]);
    }
    const bw = sim.bandwidthMBpsOf(node);
    if (Number.isFinite(bw)) {
      // 帯域を持つノードは、処理と帯域のどちらで詰まっているかを分けて出す
      const usedMB = node.inKBps / 1000;
      rows.push(['帯域', `${loadSpan(usedMB / bw)} ${bandwidth(usedMB)} / ${bandwidth(bw)}`]);
      rows.push(['処理', `${loadSpan(inRps / sim.cpuCapacityRpsOf(node))} 上限 ${compact(sim.cpuCapacityRpsOf(node))} rps`]);
    }
    rows.push(['処理中', `${node.busy.length} / ${d.workers}`]);
    rows.push(['キュー', `${node.queue.length} / ${d.queueMax}`]);
    rows.push(['維持費', `$${d.upkeepPerSec}/秒`]);
  }
  rows.push(['エラー', compact(node.errors)]);
  const outs = node.out.map((id) => sim.nodes.get(id)?.def.label ?? '?');
  rows.push(['接続先', outs.length ? summarize(outs) : 'なし']);
  const rowsHtml = rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');

  // ボタンを作り直すとタップを取りこぼすので、選択が変わったときだけ全体を組み立てる
  const key = `${node.id}@${sim.layoutVersion}`;
  if (ui.info.dataset.key === key) {
    ui.info.querySelector('.rows-box')!.innerHTML = rowsHtml;
    return;
  }
  ui.info.dataset.key = key;
  ui.info.innerHTML = `
    <h3>${d.name}</h3>
    <div class="desc">${d.description}</div>
    <div class="rows-box">${rowsHtml}</div>
    <div class="actions">
      ${node.kind === 'internet' ? '' : `<button type="button" id="info-remove">撤去 +${money(Math.floor(node.paid * SELL_REFUND_RATE))}</button>`}
      <button type="button" id="info-close">閉じる</button>
    </div>`;
  ui.info.hidden = false;

  ui.info.querySelector('#info-remove')?.addEventListener('click', () => {
    const r = state.sim.removeNode(node.id);
    if (r.message) toast(r.message);
    state.selectedId = null;
    updateInfo();
  });
  ui.info.querySelector('#info-close')?.addEventListener('click', () => {
    state.selectedId = null;
    updateInfo();
  });
}

// ------------------------------------------------------------------ セーブ

function saveGame(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(createSave(state.sim)));
  } catch {
    // 保存できない環境(プライベートブラウズなど)では何もしない
  }
}

/** 保存データがあれば復元し、放置収入を加える。復元できたら true */
function restoreGame(): boolean {
  let save: SaveData | null = null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) save = parseSave(JSON.parse(raw));
  } catch {
    save = null;
  }
  if (!save) return false;
  switchTo(loadSave(save, newSeed()));
  const { elapsedMs, gained } = offlineEarnings(save, Date.now());
  if (gained > 0) {
    state.sim.money += gained;
    showModal(`
      <h2>おかえりなさい</h2>
      <p class="lead">離れていた ${duration(elapsedMs)} の間に</p>
      <div class="big">+${money(gained)}</div>
      <p class="note">放置中は直前の収支の ${OFFLINE.efficiency * 100}% を、最大 ${OFFLINE.maxMs / 3_600_000} 時間分まで受け取れます。</p>
      <div class="actions"><button type="button" class="primary" data-close>受け取る</button></div>`);
  }
  return true;
}

function switchTo(sim: Simulation): void {
  state.sim = sim;
  state.selectedId = null;
  state.connectFrom = null;
  chart.reset();
  if (!ui.chartPanel.hidden) chart.update(sim.metrics.history, true);
  updateHud();
  updateHint();
}

function showSaveMenu(): void {
  showModal(`
    <h2>セーブ</h2>
    <p class="note">進行状況はこのブラウザに自動保存されています。別の端末へ移すときは、セーブコードをコピーして移動先で読み込んでください。</p>
    <div class="stack">
      <button type="button" id="sv-export">セーブコードをコピー</button>
      <textarea id="sv-code" rows="3" placeholder="ここにセーブコードを貼り付け"></textarea>
      <button type="button" id="sv-import">貼り付けたコードを読み込む</button>
      <button type="button" id="sv-reset" class="danger">最初からやり直す</button>
    </div>
    <div class="actions"><button type="button" data-close>閉じる</button></div>`);

  el('sv-export').addEventListener('click', async () => {
    const code = encodeSave(createSave(state.sim));
    try {
      await navigator.clipboard.writeText(code);
      toast('セーブコードをコピーしました');
    } catch {
      el<HTMLTextAreaElement>('sv-code').value = code;
      toast('コードを下の欄に表示しました。手動でコピーしてください');
    }
  });
  el('sv-import').addEventListener('click', () => {
    const save = decodeSave(el<HTMLTextAreaElement>('sv-code').value);
    if (!save) {
      toast('セーブコードを読み込めませんでした');
      return;
    }
    if (!confirm('今の進行状況を上書きして読み込みますか?')) return;
    switchTo(loadSave(save, newSeed()));
    saveGame();
    closeModal();
    toast('セーブを読み込みました');
  });
  el('sv-reset').addEventListener('click', () => {
    if (!confirm('すべての進行状況を消して最初からやり直しますか?')) return;
    switchTo(newGame(newSeed()));
    saveGame();
    closeModal();
  });
}

function showWelcome(): void {
  showModal(`
    <h2>packet-factory</h2>
    <p class="note">小さな Web サービスを運営して、データセンターを育てましょう。</p>
    <ul class="howto">
      <li>ユーザーが増えるほどリクエストが増え、捌いた分だけ収入になります</li>
      <li>稼いだお金を<b>投資</b>して、広告で市場を広げたり、単価や性能を上げたりできます</li>
      <li>捌ききれずエラーが増えると、ユーザーが離れていきます。詰まったら WEB を増設しましょう</li>
      <li>閉じている間も収入の一部が貯まります</li>
    </ul>
    <div class="legend">
      <span><span class="dot" style="background:var(--accent)"></span>静的 $${BASE_REVENUE.static}</span>
      <span><span class="dot" style="background:var(--write)"></span>書き込み $${BASE_REVENUE.write}(会員機能で解放)</span>
    </div>
    <div class="actions"><button type="button" class="primary" data-close>はじめる</button></div>`);
}

// ------------------------------------------------------------------ ユーティリティ

function showModal(html: string): void {
  ui.modalCard.innerHTML = html;
  ui.modal.hidden = false;
  for (const b of ui.modalCard.querySelectorAll('[data-close]')) b.addEventListener('click', closeModal);
}

function closeModal(): void {
  ui.modal.hidden = true;
  ui.modalCard.innerHTML = '';
}

let toastTimer = 0;
function toast(message: string): void {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 2200);
}

function summarize(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l}×${n}` : l)).join(', ');
}

function newSeed(): number {
  return (Math.random() * 2 ** 32) >>> 0;
}
