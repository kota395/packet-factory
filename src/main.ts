import './style.css';
import { RowRenderer, type Face } from './render/row';
import { OFFLINE } from './sim/config';
import {
  createSave,
  decodeSave,
  encodeSave,
  loadSave,
  newGame,
  offlineEarnings,
  parseSave,
  tutorialGame,
  type SaveData,
} from './sim/save';
import type { Simulation } from './sim/simulation';
import { Dashboard } from './ui/dashboard';
import { compact, duration, money, rate } from './ui/format';
import { InfoPanel, type Selection } from './ui/info';
import { InvestPanel } from './ui/invest';
import { ClusterPanel } from './ui/cluster';
import { Tutorial } from './ui/tutorial';
import type { ViewState } from './render/row';

// iOS Safari は touch-action を無視してページごとピンチ拡大することがあるので止める(ラックの拡大・縮小はキャンバスで行う)
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

/** v3 = ラックと配線の版。ノード図の版(v2)のセーブは引き継がない */
const SAVE_KEY = 'packet-factory:save:v3';
const AUTOSAVE_MS = 5000;
const SPEED_KEY = 'packet-factory:speed';
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
  modal: el('modal'),
  modalCard: el('modal-card'),
};

const state = {
  sim: newGame(),
  face: 'front' as Face,
  selected: null as Selection | null,
  speed: 1,
  lastChurnWarn: 0,
  /** 市場規模に届いたことを知らせたか */
  cappedNotified: false,
  /** チュートリアルで光らせる機器・U */
  highlight: null as ViewState['highlight'],
};

const renderer = new RowRenderer();
const dashboard = new Dashboard(el('dash'), () => state.sim);
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
const cluster = new ClusterPanel(el('cluster'), () => state.sim, {
  toast,
  select: (t) => select(t),
  changed: () => {
    saveGame();
    updateHud();
  },
});
const info = new InfoPanel(ui.info, () => state.sim, {
  toast,
  select: (t) => select(t),
  changed: () => {
    saveGame();
    updateHud();
  },
});

const tutorial = new Tutorial(ui.board, (skipped) => {
  // スキップしたら、チュートリアルで作るものが最初からある状態にする
  if (skipped) {
    switchTo(newGame());
    toast('サーバと配線が済んだ状態から始めます');
  }
  state.highlight = null;
  select(null);
  setFace('front');
  setSpeed(1);
  saveGame();
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
setSpeed(savedSpeed());
if (restored && Tutorial.pending()) startTutorial(true);
updateHud();
if (!restored) showWelcome();

let hudTimer = 0;
let saveTimer = 0;
renderer.app.ticker.add((ticker) => {
  const sim = state.sim;
  // チュートリアルの間は時間を止めておく
  if (state.speed > 0 && !tutorial.active) sim.step(Math.min(ticker.deltaMS, 100) * state.speed);
  const sel = state.selected;
  renderer.draw(sim, { face: state.face, selected: sel && sel.kind !== 'service' ? sel : null, highlight: state.highlight });

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

window.addEventListener('resize', () => dashboard.resize());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveGame();
});
window.addEventListener('pagehide', saveGame);

// ------------------------------------------------------------------ 選択

function select(t: Selection | null): void {
  state.selected = t;
  if (t && invest.isOpen) invest.toggle(false);
  if (t && cluster.isOpen) cluster.toggle(false);
  info.update(t);
  updateToolbar();
  refreshTutorial();
}

function refreshTutorial(): void {
  state.highlight = tutorial.update({ sim: state.sim, selected: state.selected, face: state.face });
}

/** チュートリアルを始める(resume なら前回の続きから) */
function startTutorial(resume = false): void {
  if (!resume) switchTo(tutorialGame());
  tutorial.start(resume);
  setFace('front');
  setSpeed(0);
  saveGame();
  refreshTutorial();
}

// ------------------------------------------------------------------ ツールバー

type ToolId = Face | 'service' | 'cluster' | 'invest';

function buildToolbar(): void {
  const items: { id: ToolId; html: string }[] = [
    { id: 'front', html: '<span>前面</span><small>設置・移動</small>' },
    { id: 'back', html: '<span>背面</span><small>配線</small>' },
    { id: 'service', html: '<span>サービス</span><small>流れ・負荷</small>' },
    { id: 'cluster', html: '<span>クラスタ</span><small>VM・k8s</small>' },
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
  if (id === 'cluster') {
    invest.toggle(false);
    cluster.toggle();
    if (cluster.isOpen) select(null);
  } else if (id === 'invest') {
    cluster.toggle(false);
    invest.toggle();
    if (invest.isOpen) select(null);
  } else if (id === 'service') {
    invest.toggle(false);
    cluster.toggle(false);
    select(state.selected?.kind === 'service' ? null : { kind: 'service' });
  } else {
    invest.toggle(false);
    cluster.toggle(false);
    setFace(id);
  }
  updateToolbar();
}

function setFace(face: Face): void {
  state.face = face;
  // チュートリアルの配線では、詳細パネルがポートを隠さないよう閉じておく
  if (tutorial.active && face === 'back' && state.selected?.kind === 'device') state.selected = null;
  // 面が変わると、ポートやケーブルの選択は意味がなくなる
  if (state.selected && (state.selected.kind === 'port' || state.selected.kind === 'cable') && face === 'front') select(null);
  updateHint();
  updateToolbar();
  refreshTutorial();
}

function updateToolbar(): void {
  for (const b of ui.toolbar.querySelectorAll<HTMLButtonElement>('button')) {
    const t = b.dataset.tool as ToolId;
    const active =
      t === 'invest'
        ? invest.isOpen
        : t === 'cluster'
          ? cluster.isOpen
          : t === 'service'
            ? state.selected?.kind === 'service'
            : t === state.face;
    b.classList.toggle('active', active);
    // クラスタは仮想化か Kubernetes を解放してから
    if (t === 'cluster') b.hidden = !cluster.available(state.sim);
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
  el('btn-chart').addEventListener('click', () => {
    dashboard.toggle();
    el('btn-chart').classList.toggle('active', dashboard.isOpen);
  });
  el('dash').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.dash-close')) el('btn-chart').classList.remove('active');
  });
  el('btn-save').addEventListener('click', showSaveMenu);
  el('invest-close').addEventListener('click', () => {
    invest.toggle(false);
    updateToolbar();
  });
}

/** 前回の速度(読み直しても 1 倍に戻らないように) */
function savedSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    // 一時停止のまま読み直すと「増えない」ように見えるので、止めていたときは 1 倍で始める
    return [1, 2, 4].includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

function setSpeed(speed: number): void {
  state.speed = speed;
  // チュートリアル中に止めたのは覚えない
  if (!tutorial.active) {
    try {
      localStorage.setItem(SPEED_KEY, String(speed));
    } catch {
      // 覚えておけない環境では毎回 1 倍
    }
  }
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
  // 市場規模(潜在ユーザー数)に届くと、それ以上は増えない。広告で広げる
  const capped = sim.users >= sim.marketSize * 0.97;
  ui.users.className = `v ${capped ? 'warn' : ''}`;
  ui.users.title = capped ? '市場規模に届いていて、これ以上は増えません。投資の「広告」で市場を広げると、また増えます' : '';
  if (capped && !state.cappedNotified) {
    state.cappedNotified = true;
    toast('ユーザーが市場規模に届きました。投資の「広告」で市場を広げると、また増えます');
  }
  if (!capped && sim.users < sim.marketSize * 0.9) state.cappedNotified = false;
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

  dashboard.update();
  invest.update();
  cluster.update();
  // 選んでいた機器が売却などで消えたら閉じる
  const sel = state.selected;
  if (sel?.kind === 'device' && !sim.facility.devices.has(sel.id)) state.selected = null;
  if (sel?.kind === 'cable' && !sim.facility.cables.has(sel.id)) state.selected = null;
  if (sel?.kind === 'vm' && !sim.facility.vms.has(sel.id)) state.selected = null;
  info.update(state.selected);
  updateToolbar();
  refreshTutorial();
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
  dashboard.update(true);
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
      <button type="button" id="sv-tutorial">チュートリアルを最初から(進行状況は消えます)</button>
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
  el('sv-tutorial').addEventListener('click', () => {
    if (!confirm('進行状況を消して、チュートリアルを最初からやりますか?')) return;
    closeModal();
    startTutorial();
  });
  el('sv-reset').addEventListener('click', () => {
    if (!confirm('すべての進行状況を消して最初からやり直しますか?')) return;
    switchTo(newGame());
    saveGame();
    closeModal();
  });
}

function showWelcome(): void {
  showModal(`
    <h2>packet-factory</h2>
    <p class="note">コロケーションの 1 ラックから、ブログサービスのインフラを育てるゲームです。サーバを置き、役割を付け、配線し、詰まった所に手を打って、増えていくユーザーを捌きます。</p>
    <ul class="howto">
      <li><b>チュートリアル</b>: サーバを 2 台置いて、役割を付け、強化して、配線するまでを実際に操作しながら覚えます(数分)</li>
      <li><b>スキップ</b>: チュートリアルで作るもの(web と db のサーバ、配線)が最初からある状態で始めます</li>
    </ul>
    <div class="actions">
      <button type="button" id="wel-skip">スキップ</button>
      <button type="button" class="primary" id="wel-tutorial">チュートリアル</button>
    </div>`);
  el('wel-tutorial').addEventListener('click', () => {
    closeModal();
    startTutorial();
  });
  el('wel-skip').addEventListener('click', () => {
    closeModal();
    saveGame();
  });
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
