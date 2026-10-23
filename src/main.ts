import './style.css';
import { RowRenderer, type Face } from './render/row';
import { MODEL_BY_ID } from './sim/catalog';
import { OFFLINE } from './sim/config';
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
import { MetricsChart } from './ui/chart';
import { compact, duration, money, rate } from './ui/format';
import { InfoPanel, type Selection } from './ui/info';
import { InvestPanel } from './ui/invest';

/** v3 = ラックと配線の版。ノード図の版(v2)のセーブは引き継がない */
const SAVE_KEY = 'packet-factory:save:v3';
const AUTOSAVE_MS = 5000;
const CHURN_WARN_INTERVAL_MS = 20_000;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  money: el('s-money'),
  income: el('s-income'),
  users: el('s-users'),
  pv: el('s-rps'),
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
  sim: newGame(),
  face: 'front' as Face,
  selected: null as Selection | null,
  speed: 1,
  lastChurnWarn: 0,
};

const renderer = new RowRenderer();
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
const info = new InfoPanel(ui.info, () => state.sim, {
  toast,
  select: (t) => select(t),
  changed: () => {
    saveGame();
    updateHud();
  },
});

// ------------------------------------------------------------------ 起動

buildToolbar();
await renderer.init(ui.board);
renderer.onTap = (t) => select(t.kind === 'none' ? null : t);
renderer.onDeviceMove = (id, slot, u) => {
  const r = state.sim.moveDevice(id, slot, u);
  if (!r.ok && r.message) toast(r.message);
  select({ kind: 'device', id });
};
renderer.onConnect = (a, b) => {
  const r = state.sim.connect(a, b);
  if (r.message) toast(r.message);
  if (r.ok && r.id !== undefined) select({ kind: 'cable', id: r.id });
  saveGame();
};
el('btn-zoom-in').addEventListener('click', () => renderer.zoomBy(1.25));
el('btn-zoom-out').addEventListener('click', () => renderer.zoomBy(0.8));
el('btn-fit').addEventListener('click', () => renderer.fit());
bindControls();
const restored = restoreGame();
setFace('front');
setSpeed(1);
updateHud();
if (!restored) showWelcome();

let hudTimer = 0;
let saveTimer = 0;
renderer.app.ticker.add((ticker) => {
  const sim = state.sim;
  if (state.speed > 0) sim.step(Math.min(ticker.deltaMS, 100) * state.speed);
  const sel = state.selected;
  renderer.draw(sim, { face: state.face, selected: sel && sel.kind !== 'service' ? sel : null });

  hudTimer += ticker.deltaMS;
  if (hudTimer >= 250) {
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

// ------------------------------------------------------------------ 選択

function select(t: Selection | null): void {
  state.selected = t;
  if (t && invest.isOpen) invest.toggle(false);
  info.update(t);
  updateToolbar();
}

// ------------------------------------------------------------------ ツールバー

type ToolId = Face | 'service' | 'invest';

function buildToolbar(): void {
  const items: { id: ToolId; html: string }[] = [
    { id: 'front', html: '<span>前面</span><small>設置・移動</small>' },
    { id: 'back', html: '<span>背面</span><small>配線</small>' },
    { id: 'service', html: '<span>サービス</span><small>流れ・負荷</small>' },
    { id: 'invest', html: '投資<span class="badge" hidden></span>' },
  ];
  ui.toolbar.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tool = item.id;
    b.innerHTML = item.html;
    if (item.id === 'invest') b.classList.add('invest');
    b.addEventListener('click', () => onTool(item.id));
    ui.toolbar.appendChild(b);
  }
}

function onTool(id: ToolId): void {
  if (id === 'invest') {
    invest.toggle();
    if (invest.isOpen) select(null);
  } else if (id === 'service') {
    invest.toggle(false);
    select(state.selected?.kind === 'service' ? null : { kind: 'service' });
  } else {
    invest.toggle(false);
    setFace(id);
  }
  updateToolbar();
}

function setFace(face: Face): void {
  state.face = face;
  // 面が変わると、ポートやケーブルの選択は意味がなくなる
  if (state.selected && (state.selected.kind === 'port' || state.selected.kind === 'cable') && face === 'front') select(null);
  updateHint();
  updateToolbar();
}

function updateToolbar(): void {
  for (const b of ui.toolbar.querySelectorAll<HTMLButtonElement>('button')) {
    const t = b.dataset.tool as ToolId;
    const active =
      t === 'invest' ? invest.isOpen : t === 'service' ? state.selected?.kind === 'service' : t === state.face;
    b.classList.toggle('active', active);
  }
  const badge = ui.toolbar.querySelector<HTMLElement>('.badge');
  if (badge) badge.hidden = !invest.anyAffordable(state.sim);
}

function updateHint(): void {
  ui.hint.textContent =
    state.face === 'front'
      ? '前面: 空いている U をタップして機器を設置、機器はドラッグで移動。点線の区画をタップしてラックを借りる。'
      : '背面: ポートから別のポートへドラッグして配線。ケーブルやポートをタップすると詳細と「抜く」。';
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
  ui.pv.textContent = compact(r.pv, 1);
  ui.err.textContent = `${(r.errorRate * 100).toFixed(1)}%`;
  ui.err.className = `v ${r.errorRate > 0.05 ? 'bad' : r.errorRate > 0.01 ? 'warn' : ''}`;
  ui.p99.textContent = r.pv > 0 ? `${Math.round(r.p99Ms)}ms` : '-';
  ui.p99.className = `v ${r.p99Ms > 1500 ? 'bad' : r.p99Ms > 800 ? 'warn' : ''}`;

  if (r.errorRate > 0.05 && performance.now() - state.lastChurnWarn > CHURN_WARN_INTERVAL_MS) {
    state.lastChurnWarn = performance.now();
    const b = sim.flow.bottleneck;
    toast(b && b.rho > 1 ? `エラーで離脱が出ています: ${b.label}が溢れています` : 'エラーが多く、ユーザーが離脱しています');
  }

  if (!ui.chartPanel.hidden) chart.update(sim.metrics.history);
  invest.update();
  // 選んでいた機器が売却などで消えたら閉じる
  const sel = state.selected;
  if (sel?.kind === 'device' && !sim.facility.devices.has(sel.id)) state.selected = null;
  if (sel?.kind === 'cable' && !sim.facility.cables.has(sel.id)) state.selected = null;
  info.update(state.selected);
  updateToolbar();
}

// ------------------------------------------------------------------ セーブ

function saveGame(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(createSave(state.sim)));
  } catch {
    // 保存できない環境(プライベートブラウズなど)では何もしない
  }
}

function restoreGame(): boolean {
  let save: SaveData | null = null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) save = parseSave(JSON.parse(raw));
  } catch {
    save = null;
  }
  if (!save) return false;
  switchTo(loadSave(save));
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
  state.selected = null;
  chart.reset();
  if (!ui.chartPanel.hidden) chart.update(sim.metrics.history, true);
  updateHud();
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
    switchTo(loadSave(save));
    saveGame();
    closeModal();
    toast('セーブを読み込みました');
  });
  el('sv-reset').addEventListener('click', () => {
    if (!confirm('すべての進行状況を消して最初からやり直しますか?')) return;
    switchTo(newGame());
    saveGame();
    closeModal();
  });
}

function showWelcome(): void {
  const srv = MODEL_BY_ID['srv-1u-e'];
  showModal(`
    <h2>packet-factory</h2>
    <p class="note">コロケーションの 1 ラックから、ブログサービスのインフラを育てましょう。</p>
    <ul class="howto">
      <li>ラックには回線終端・スイッチ・サーバ 1 台(${srv.short}、web と db を同居)が入っています</li>
      <li>ユーザーが増えるとページビューが増え、捌けた分だけ収入になります。溢れるとエラーになり、ユーザーが離れます</li>
      <li><b>前面</b>: 空いている U をタップして機器を買って設置。サーバには役割(web / db など)を割り当てる</li>
      <li><b>背面</b>: ポートから別のポートへドラッグして配線。ケーブルの色は使用率</li>
      <li>ラックには電力の上限があります。サーバのスペックは上げられないので、上位機種を買って役割を移します</li>
      <li><b>サービス</b>ボタンで、流れと一番詰まっている所を確認できます</li>
    </ul>
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
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 2600);
}
