import './style.css';
import { BoardRenderer } from './render/board';
import { NODE_DEFS, PLACEABLE_KINDS, REVENUE, SELL_REFUND_RATE, SLA_TARGET } from './sim/config';
import { applyLayout, decodeLayout, encodeLayout, exportLayout, parseLayout, type SavedLayout } from './sim/layout';
import { Simulation } from './sim/simulation';
import type { NodeKind } from './sim/types';
import { MetricsChart } from './ui/chart';

type Tool = 'select' | NodeKind | 'connect' | 'delete';

const fmt = new Intl.NumberFormat('ja-JP');
const STORAGE_KEY = 'packet-factory:layout:v1';
const HASH_PREFIX = '#l=';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  money: el('s-money'),
  clock: el('s-clock'),
  rps: el('s-rps'),
  p99: el('s-p99'),
  avail: el('s-avail'),
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
  sim: new Simulation({ seed: newSeed() }),
  tool: 'web' as Tool,
  selectedId: null as number | null,
  connectFrom: null as number | null,
  speed: 0,
  started: false,
  ended: false,
  savedVersion: -1,
};

const renderer = new BoardRenderer();
const chart = new MetricsChart(ui.chart);

// ------------------------------------------------------------------ 起動

await renderer.init(ui.board);
renderer.onCellTap = handleCellTap;
buildToolbar();
bindControls();
restoreInitialLayout();
setTool('web');
setSpeed(0);
updateHud();

let hudTimer = 0;
renderer.app.ticker.add((ticker) => {
  const sim = state.sim;
  if (state.speed > 0 && sim.status === 'running') sim.step(Math.min(ticker.deltaMS, 100) * state.speed);

  renderer.draw(sim, { selectedId: state.selectedId, connectFrom: state.connectFrom });

  if (sim.layoutVersion !== state.savedVersion) persistLayout();

  hudTimer += ticker.deltaMS;
  if (hudTimer >= 200) {
    hudTimer = 0;
    updateHud();
  }

  if (sim.status !== 'running' && !state.ended) {
    state.ended = true;
    setSpeed(0);
    updateHud();
    showResult();
  }
});

window.addEventListener('resize', () => chart.resize());

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
}

// ------------------------------------------------------------------ ツールバー

function buildToolbar(): void {
  const items: { tool: Tool; html: string }[] = [
    { tool: 'select', html: '選択' },
    ...PLACEABLE_KINDS.map((k) => {
      const d = NODE_DEFS[k];
      const hex = `#${d.color.toString(16).padStart(6, '0')}`;
      return {
        tool: k as Tool,
        html: `<span><span class="swatch" style="background:${hex}"></span>${d.label}</span><small>$${d.cost}</small>`,
      };
    }),
    { tool: 'connect', html: '接続' },
    { tool: 'delete', html: '撤去' },
  ];
  ui.toolbar.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tool = item.tool;
    b.innerHTML = item.html;
    b.addEventListener('click', () => setTool(item.tool));
    ui.toolbar.appendChild(b);
  }
}

function setTool(tool: Tool): void {
  state.tool = tool;
  state.connectFrom = null;
  for (const b of ui.toolbar.querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  updateHint();
}

function updateHint(): void {
  let text: string;
  switch (state.tool) {
    case 'select':
      text = 'ノードをタップすると状態を確認できます。';
      break;
    case 'connect':
      text =
        state.connectFrom === null
          ? '接続元のノードをタップ。'
          : '接続先をタップ(続けて複数つなげます)。同じ線をもう一度つなぐと解除、空きマスで終了。';
      break;
    case 'delete':
      text = `撤去するノードをタップ(費用の ${SELL_REFUND_RATE * 100}% を返金)。`;
      break;
    default: {
      const d = NODE_DEFS[state.tool];
      text = `空きマスをタップして${d.name}を配置($${d.cost}、維持費 $${d.upkeepPerSec}/秒)。${d.description}`;
    }
  }
  if (!state.started) text = `▶ で開始。${text}`;
  ui.hint.textContent = text;
}

// ------------------------------------------------------------------ HUD・操作ボタン

function bindControls(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.addEventListener('click', () => {
      if (state.ended) return;
      setSpeed(Number(b.dataset.speed));
    });
  }

  el('btn-chart').addEventListener('click', (e) => {
    const show = ui.chartPanel.hidden !== false;
    ui.chartPanel.hidden = !show;
    (e.currentTarget as HTMLElement).classList.toggle('active', show);
    if (show) chart.update(state.sim.metrics.history, true);
    chart.resize();
  });

  el('btn-share').addEventListener('click', shareLayout);

  el('btn-reset').addEventListener('click', () => {
    if (confirm('構成を消して最初からやり直しますか?')) newGame(null);
  });
}

function setSpeed(speed: number): void {
  state.speed = speed;
  if (speed > 0) state.started = true;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.classList.toggle('active', Number(b.dataset.speed) === speed);
  }
  updateHint();
}

function updateHud(): void {
  const sim = state.sim;
  const r = sim.metrics.rolling;
  const avail = sim.metrics.availability;
  const hasTraffic = sim.metrics.totalSuccess + sim.metrics.totalErrors > 0;

  ui.money.textContent = `$${fmt.format(Math.floor(sim.money))}`;
  ui.money.className = `v ${sim.money < 100 ? 'bad' : ''}`;
  ui.clock.textContent = formatClock(sim.time, sim.durationMs);
  ui.rps.textContent = `${Math.round(r.rps)}`;
  ui.p99.textContent = hasTraffic ? `${r.p99}ms` : '-';
  ui.p99.className = `v ${r.p99 > 800 ? 'bad' : r.p99 > 400 ? 'warn' : ''}`;
  ui.avail.textContent = hasTraffic ? `${(avail * 100).toFixed(2)}%` : '-';
  ui.avail.className = `v ${!hasTraffic ? '' : avail >= SLA_TARGET ? 'ok' : 'bad'}`;

  if (!ui.chartPanel.hidden) chart.update(sim.metrics.history);
  updateInfo();
}

function updateInfo(): void {
  const node = state.selectedId === null ? undefined : state.sim.nodes.get(state.selectedId);
  if (!node) {
    ui.info.hidden = true;
    delete ui.info.dataset.key;
    return;
  }
  const d = node.def;
  const rows: [string, string][] = [];
  if (node.kind !== 'internet') {
    rows.push(['処理中', `${node.busy.length} / ${d.workers}`]);
    rows.push(['キュー', `${node.queue.length} / ${d.queueMax}`]);
    rows.push(['処理数', fmt.format(node.processed)]);
    rows.push(['維持費', `$${d.upkeepPerSec}/秒`]);
  }
  rows.push(['エラー', fmt.format(node.errors)]);
  const outs = node.out.map((id) => state.sim.nodes.get(id)?.def.label ?? '?');
  rows.push(['接続先', outs.length ? summarize(outs) : 'なし']);

  const rowsHtml = rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');

  // ボタンを作り直すとタップを取りこぼすので、選択が変わったときだけ全体を組み立てる
  const key = `${node.id}@${state.sim.layoutVersion}`;
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
      ${node.kind === 'internet' ? '' : `<button type="button" id="info-remove">撤去 +$${Math.floor(d.cost * SELL_REFUND_RATE)}</button>`}
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

// ------------------------------------------------------------------ ゲーム進行

function newGame(layout: SavedLayout | null): void {
  state.sim = new Simulation({ seed: newSeed() });
  state.selectedId = null;
  state.connectFrom = null;
  state.ended = false;
  state.started = false;
  if (layout) {
    const r = applyLayout(state.sim, layout);
    if (r.skipped) toast(`予算不足などで ${r.skipped} 個のノードを復元できませんでした`);
  }
  chart.reset();
  if (!ui.chartPanel.hidden) chart.update(state.sim.metrics.history, true);
  ui.modal.hidden = true;
  setSpeed(0);
  updateHud();
}

function showResult(): void {
  const sim = state.sim;
  const m = sim.metrics;
  const avail = m.availability;
  const p99 = m.overall.percentile(0.99);
  const profit = sim.money - sim.startMoney;

  let title: string;
  let rank: string;
  let color: string;
  if (sim.status === 'bankrupt') {
    title = '予算が尽きました';
    rank = '破産';
    color = 'var(--bad)';
  } else if (sim.status === 'failed') {
    title = `SLA ${SLA_TARGET * 100}% 未達`;
    rank = 'C';
    color = 'var(--bad)';
  } else {
    title = 'ステージクリア';
    rank = avail >= 0.999 && p99 <= 400 ? 'S' : avail >= 0.995 ? 'A' : 'B';
    color = rank === 'S' ? 'var(--warn)' : 'var(--ok)';
  }

  ui.modalCard.innerHTML = `
    <h2>${title}</h2>
    <div class="rank" style="color:${color}">${rank}</div>
    <div class="rows">
      <div><span>可用性</span><span>${(avail * 100).toFixed(3)}%</span></div>
      <div><span>p99 レイテンシ</span><span>${p99}ms</span></div>
      <div><span>成功</span><span>${fmt.format(m.totalSuccess)}</span></div>
      <div><span>失敗(溢れ / 時間切れ / 行き先なし)</span><span>${m.errorsByReason.drop} / ${m.errorsByReason.timeout} / ${m.errorsByReason['no-route']}</span></div>
      <div><span>収支</span><span>${profit >= 0 ? '+' : ''}$${fmt.format(Math.round(profit))}</span></div>
    </div>
    <div class="actions">
      <button type="button" class="primary" id="m-retry">同じ構成で再挑戦</button>
      <button type="button" id="m-new">最初から</button>
    </div>`;
  ui.modal.hidden = false;
  el('m-retry').addEventListener('click', () => newGame(exportLayout(sim)));
  el('m-new').addEventListener('click', () => newGame(null));
}

// ------------------------------------------------------------------ 保存・共有

function restoreInitialLayout(): void {
  let layout: SavedLayout | null = null;
  if (location.hash.startsWith(HASH_PREFIX)) {
    layout = decodeLayout(location.hash.slice(HASH_PREFIX.length));
    if (!layout) toast('共有リンクの構成を読み込めませんでした');
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) layout = parseLayout(JSON.parse(raw));
    } catch {
      layout = null;
    }
  }
  if (layout) newGame(layout);
  showWelcome(layout !== null);
}

function persistLayout(): void {
  state.savedVersion = state.sim.layoutVersion;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exportLayout(state.sim)));
  } catch {
    // 保存できない環境(プライベートブラウズなど)では何もしない
  }
}

async function shareLayout(): Promise<void> {
  const url = `${location.origin}${location.pathname}${HASH_PREFIX}${encodeLayout(exportLayout(state.sim))}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('構成の共有リンクをコピーしました');
  } catch {
    prompt('この URL で構成を共有できます', url);
  }
}

function showWelcome(restored: boolean): void {
  if (restored) return;
  ui.modalCard.innerHTML = `
    <h2>packet-factory</h2>
    <p style="color:var(--muted);font-size:13px;line-height:1.7;text-align:left">
      インターネットから流れ込むリクエストを捌くインフラを組み立てましょう。
      ゲーム内の 24 時間、可用性 ${SLA_TARGET * 100}% 以上を保てばクリアです。
    </p>
    <div class="legend">
      <span><span class="dot" style="background:var(--accent)"></span>静的(WEB で完了, $${REVENUE.static})</span>
      <span><span class="dot" style="background:var(--write)"></span>書き込み(DB まで, $${REVENUE.write})</span>
    </div>
    <p style="color:var(--muted);font-size:12px;line-height:1.7;text-align:left">
      例: NET → LB → WEB → DB とつなぐ。流量は時間とともに増えるので、
      詰まり始めたら WEB や DB を増設してください。
    </p>
    <div class="actions"><button type="button" class="primary" id="m-start">はじめる</button></div>`;
  ui.modal.hidden = false;
  el('m-start').addEventListener('click', () => {
    ui.modal.hidden = true;
  });
}

// ------------------------------------------------------------------ ユーティリティ

let toastTimer = 0;
function toast(message: string): void {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 2200);
}

function formatClock(timeMs: number, durationMs: number): string {
  const minutes = Math.min(24 * 60, Math.floor((timeMs / durationMs) * 24 * 60));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function summarize(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l}×${n}` : l)).join(', ');
}

function newSeed(): number {
  return (Math.random() * 2 ** 32) >>> 0;
}
