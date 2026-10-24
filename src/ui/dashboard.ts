/**
 * Grafana 風のメトリクス画面。数値のタイルと、時系列のパネル(uPlot)を並べる。
 * 需要とキャパシティのパネルには、ロジスティック成長による需要予測(このまま / 広告をもう 1 回)を重ねる。
 */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { CAMPAIGN, GROWTH_RATE, METRICS, PV_PER_USER, SERVICES } from '../sim/config';
import { UPGRADE_BY_ID } from '../sim/economy';
import { logistic } from '../sim/forecast';
import type { Simulation } from '../sim/simulation';
import type { ServiceId } from '../sim/types';
import { compact, duration, money, rate } from './format';

/** 系列の色(暗い背景向けに検証済みの順番。系列は必ずこの順に割り当てる) */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
const MUTED = '#8b98a5';
const GRID = '#1f2a36';

const RANGES = [
  { id: '5', label: '5 分', sec: 300 },
  { id: '15', label: '15 分', sec: 900 },
  { id: '60', label: '1 時間', sec: 3600 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const RANGE_KEY = 'packet-factory:dash-range';
/** 予測の点の間隔(秒) */
const FORECAST_STEP = 15;
/** 資源の使用率パネルに出す数 */
const TOP_RESOURCES = 5;

interface Panel {
  id: string;
  title: string;
  host: HTMLElement;
  plot: uPlot | null;
  /** 系列の数が変わったら作り直す */
  signature: string;
}

const fmtMin = (sec: number) => {
  const m = sec / 60;
  if (Math.abs(m) < 0.01) return '今';
  return `${m > 0 ? '+' : ''}${m.toFixed(1)}分`;
};

/** 見る範囲: すべてのサービスの合計か、サービス 1 つ */
type Scope = 'all' | ServiceId;

export class Dashboard {
  private range: RangeId = '15';
  private scope: Scope = 'all';
  private scopeSignature = '';
  private readonly scopeBox: HTMLElement;
  private readonly panels = new Map<string, Panel>();
  private lastLength = -1;
  private lastSim: Simulation | null = null;
  /** 資源 → 色の番号。色は資源についていく(順位が変わっても塗り替えない) */
  private readonly resourceSlots = new Map<string, number>();
  private readonly tiles: HTMLElement;
  private readonly grid: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly getSim: () => Simulation,
  ) {
    try {
      const saved = localStorage.getItem(RANGE_KEY);
      if (saved && RANGES.some((r) => r.id === saved)) this.range = saved as RangeId;
    } catch {
      // 覚えておけない環境では既定の 15 分
    }
    root.innerHTML = `
      <header class="dash-head">
        <h2>メトリクス</h2>
        <div class="dash-scope" role="group" aria-label="サービス"></div>
        <div class="dash-range" role="group" aria-label="表示する期間">
          ${RANGES.map((r) => `<button type="button" data-range="${r.id}">${r.label}</button>`).join('')}
        </div>
        <button type="button" class="dash-close" aria-label="閉じる">✕</button>
      </header>
      <div class="dash-body">
        <div class="dash-tiles"></div>
        <div class="dash-grid"></div>
        <p class="dash-note">予測はユーザーが市場規模に向かって伸びる前提(ロジスティック成長)。エラーや遅さでの離脱は入れていません。キャパシティは、今の構成で成功率 ${METRICS.capacitySuccess * 100}% を保てるページビュー/秒の見積もりです。</p>
      </div>`;
    this.tiles = root.querySelector('.dash-tiles')!;
    this.scopeBox = root.querySelector('.dash-scope')!;
    this.scopeBox.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-scope]');
      if (!b) return;
      this.scope = b.dataset.scope as Scope;
      this.scopeSignature = '';
      this.update(true);
    });
    this.grid = root.querySelector('.dash-grid')!;
    root.querySelector('.dash-close')!.addEventListener('click', () => this.toggle(false));
    root.querySelector('.dash-range')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-range]');
      if (!b) return;
      this.range = b.dataset.range as RangeId;
      try {
        localStorage.setItem(RANGE_KEY, this.range);
      } catch {
        // 切り替え自体はできる
      }
      this.update(true);
    });
    for (const [id, title] of [
      ['demand', '需要とキャパシティ(PV/秒)'],
      ['users', 'ユーザー数と市場規模'],
      ['resources', `資源の使用率(上位 ${TOP_RESOURCES}、%)`],
      ['errors', 'エラー率(%)'],
      ['latency', '応答 p99(ms)'],
      ['money', '収支(全体、$/秒)'],
    ] as const) {
      const box = document.createElement('section');
      box.className = `dash-panel ${id === 'demand' ? 'wide' : ''}`;
      box.innerHTML = `<h3>${title}</h3><div class="dash-plot"></div>`;
      this.grid.appendChild(box);
      this.panels.set(id, { id, title, host: box.querySelector('.dash-plot')!, plot: null, signature: '' });
    }
    new ResizeObserver(() => this.resize()).observe(this.grid);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(open = !this.isOpen): void {
    this.root.hidden = !open;
    if (open) this.update(true);
  }

  /** 推移が 1 秒進んだとき(か、強制)に描き直す */
  update(force = false): void {
    if (!this.isOpen) return;
    const sim = this.getSim();
    const h = sim.metrics.history;
    if (sim !== this.lastSim) {
      for (const p of this.panels.values()) {
        p.plot?.destroy();
        p.plot = null;
        p.signature = '';
      }
      this.resourceSlots.clear();
      this.lastSim = sim;
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-range]')) {
      b.classList.toggle('active', b.dataset.range === this.range);
    }
    this.renderScope(sim);
    this.renderTiles(sim);
    if (!force && h.t.length === this.lastLength) return;
    this.lastLength = h.t.length;

    const span = RANGES.find((r) => r.id === this.range)!.sec;
    const now = h.t.at(-1) ?? 0;
    let start = 0;
    while (start < h.t.length && h.t[start] < now - span) start++;
    const x = h.t.slice(start).map((t) => t - now);
    const pick = (arr: (number | null)[], f = (v: number) => v) => arr.slice(start).map((v) => (v === null ? null : f(v)));
    const src = this.source(sim);

    // 需要とキャパシティ: 過去の実績に、未来の予測を続ける
    const future: number[] = [];
    for (let s = FORECAST_STEP; s <= METRICS.forecastSec; s += FORECAST_STEP) future.push(s);
    const lv = sim.upgrades.marketing;
    const adRatio = UPGRADE_BY_ID.marketing.effect(lv + 1) / UPGRADE_BY_ID.marketing.effect(lv);
    const ids = this.scope === 'all' ? sim.activeServices : [this.scope];
    /** s 秒後のページビュー/秒(市場規模を ratio 倍にしたとき) */
    const campaignLeft = sim.campaignActive ? (sim.campaign.until - sim.time) / 1000 : 0;
    const pvAt = (ratio: number, s: number) =>
      ids.reduce((sum, id) => {
        // キャンペーン中のショッピングは、終わるまで訪問が増えたまま
        const boost = id === 'shop' && s < campaignLeft ? CAMPAIGN.trafficMul : 1;
        return sum + logistic(sim.serviceUsers[id], sim.marketOf(id) * ratio, GROWTH_RATE, s) * PV_PER_USER * boost;
      }, 0);
    const pastNull = x.map(() => null);
    const futNull = future.map(() => null);
    const demandX = [...x, ...future];
    const cap = this.scope === 'all' ? sim.capacityPv : sim.capacityOf(this.scope);
    // 「今」の点で予測と実績をつなぐ
    const lastPv = src.pv.at(-1) ?? 0;
    const joinAt = (v: number) => [...pastNull.slice(0, -1), v];
    this.plot(
      'demand',
      [
        { label: '実績', color: SERIES[0] },
        { label: 'キャパシティ', color: SERIES[1] },
        { label: '予測(このまま)', color: SERIES[0], dash: [6, 4] },
        { label: '予測(広告 +1)', color: SERIES[2], dash: [3, 4] },
      ],
      [
        demandX,
        [...pick(src.pv), ...futNull],
        [...pick(src.capacity), ...future.map(() => cap)],
        [...(x.length ? joinAt(lastPv ?? 0) : []), ...future.map((s) => pvAt(1, s))],
        [...(x.length ? joinAt(lastPv ?? 0) : []), ...future.map((s) => pvAt(adRatio, s))],
      ],
      (v) => compact(v, 1),
      undefined,
      x.length - 1,
    );
    this.plot(
      'users',
      [
        { label: 'ユーザー', color: SERIES[0] },
        { label: '市場規模', color: SERIES[1] },
      ],
      [x, pick(src.users), pick(src.market)],
      (v) => compact(v),
    );
    // 値が 0 のままでも目盛りが潰れないよう、縦軸の上限に下限を設ける
    this.plot('errors', [{ label: 'エラー率', color: SERIES[0] }], [x, pick(src.errorRate, (v) => v * 100)], (v) => v.toFixed(1), {
      min: 0,
      max: 5,
    });
    this.plot('latency', [{ label: 'p99', color: SERIES[0] }], [x, pick(src.p99)], (v) => compact(v), { min: 0, max: 500 });
    this.plot(
      'money',
      [
        { label: '売上', color: SERIES[0] },
        { label: '維持費', color: SERIES[1] },
        { label: '収支', color: SERIES[2] },
      ],
      [x, pick(h.revenue), pick(h.upkeep), h.revenue.slice(start).map((r, i) => r - h.upkeep[start + i])],
      (v) => compact(v, 1),
    );
    this.plotResources(sim, start, x);
  }

  /** 見ている範囲の推移 */
  private source(sim: Simulation): {
    pv: (number | null)[];
    capacity: (number | null)[];
    users: (number | null)[];
    market: (number | null)[];
    errorRate: (number | null)[];
    p99: (number | null)[];
  } {
    const h = sim.metrics.history;
    if (this.scope === 'all') return h;
    const sh = sim.metrics.services.get(this.scope);
    if (!sh) {
      const nulls = h.t.map(() => null);
      return { pv: nulls, capacity: nulls, users: nulls, market: nulls, errorRate: nulls, p99: nulls };
    }
    return sh;
  }

  /** サービスの切り替え。2 つ以上始めていれば出す */
  private renderScope(sim: Simulation): void {
    const active = sim.activeServices;
    if (this.scope !== 'all' && !active.includes(this.scope)) this.scope = 'all';
    const signature = `${active.join(',')}|${this.scope}`;
    if (signature === this.scopeSignature) return;
    this.scopeSignature = signature;
    this.scopeBox.hidden = active.length < 2;
    const scopes: Scope[] = ['all', ...active];
    this.scopeBox.innerHTML = scopes
      .map(
        (s) =>
          `<button type="button" data-scope="${s}" class="${s === this.scope ? 'active' : ''}">${s === 'all' ? '全体' : SERVICES[s].name}</button>`,
      )
      .join('');
  }

  resize(): void {
    for (const p of this.panels.values()) p.plot?.setSize(this.sizeOf(p));
  }

  private sizeOf(p: Panel): { width: number; height: number } {
    return { width: Math.max(220, p.host.clientWidth), height: p.id === 'demand' ? 220 : 170 };
  }

  /** 期間内の最大値が大きい資源を上位から出す */
  private plotResources(sim: Simulation, start: number, x: number[]): void {
    const ranked = [...sim.metrics.resources.entries()]
      .map(([key, s]) => {
        const vals = s.rho.slice(start);
        let max = 0;
        for (const v of vals) if (v !== null && v > max) max = v;
        return { key, label: s.label, vals, max };
      })
      .filter((r) => r.max > 0.01)
      .sort((a, b) => b.max - a.max)
      .slice(0, TOP_RESOURCES);
    // 色は資源についていく: 上位から外れた資源の色だけを空け、新しく入った資源に渡す
    const keep = new Set(ranked.map((r) => r.key));
    for (const key of [...this.resourceSlots.keys()]) if (!keep.has(key)) this.resourceSlots.delete(key);
    for (const r of ranked) {
      if (this.resourceSlots.has(r.key)) continue;
      const used = new Set(this.resourceSlots.values());
      const free = SERIES.findIndex((_, i) => !used.has(i));
      this.resourceSlots.set(r.key, free);
    }
    // 凡例の並びも色の番号順にして、色と名前の対応を変えない
    ranked.sort((a, b) => this.resourceSlots.get(a.key)! - this.resourceSlots.get(b.key)!);
    this.plot(
      'resources',
      ranked.map((r) => ({ label: r.label, color: SERIES[this.resourceSlots.get(r.key)!] })),
      [x, ...ranked.map((r) => r.vals.map((v) => (v === null ? null : v * 100)))],
      (v) => v.toFixed(0),
      { min: 0, max: 100 },
    );
  }

  private plot(
    id: string,
    series: { label: string; color: string; dash?: number[] }[],
    data: (number | null)[][],
    fmt: (v: number) => string,
    yRange?: { min: number; max: number },
    /** 指していないときに凡例に出す点(既定は最後。需要のパネルは「今」) */
    legendIdx = (data[0]?.length ?? 1) - 1,
  ): void {
    // 目盛りは丸めて短く、凡例の値は細かく
    const tick = (v: number) => (Math.abs(v) >= 1000 ? compact(v) : fmt(v).replace(/\.0+$/, ''));
    const p = this.panels.get(id)!;
    const signature = series.map((s) => `${s.label}|${s.color}`).join(',');
    if (!p.plot || p.signature !== signature) {
      p.plot?.destroy();
      p.signature = signature;
      p.host.innerHTML = series.length ? '' : '<div class="dash-empty">まだデータがありません</div>';
      if (!series.length) {
        p.plot = null;
        return;
      }
      const axis = {
        stroke: MUTED,
        grid: { stroke: GRID, width: 1 },
        ticks: { stroke: GRID },
        font: '11px system-ui, sans-serif',
      };
      p.plot = new uPlot(
        {
          ...this.sizeOf(p),
          scales: {
            x: { time: false },
            y: {
              range: (_u, _min, max) =>
                yRange ? [yRange.min, Math.max(yRange.max, (max ?? 0) * 1.05)] : [0, Math.max(1e-6, (max ?? 0) * 1.15)],
            },
          },
          series: [
            { label: '時刻', value: (_u, v) => (v == null ? '-' : fmtMin(v)) },
            ...series.map((s) => ({
              label: s.label,
              stroke: s.color,
              width: 2,
              dash: s.dash,
              points: { show: false },
              value: (_u: uPlot, v: number | null) => (v == null ? '-' : fmt(v)),
            })),
          ],
          axes: [
            { ...axis, values: (_u, vals) => vals.map((v) => fmtMin(v)) },
            { ...axis, size: 52, values: (_u, vals) => vals.map((v) => tick(v)) },
          ],
          cursor: { drag: { x: false, y: false } },
          legend: { live: true },
        },
        data as uPlot.AlignedData,
        p.host,
      );
    } else {
      p.plot.setData(data as uPlot.AlignedData);
    }
    // Grafana のように、カーソルを当てていない間は最新の値を凡例に出しておく
    const c = p.plot.cursor;
    if (c.left == null || c.left < 0) p.plot.setLegend({ idx: Math.max(0, legendIdx) });
  }

  private renderTiles(sim: Simulation): void {
    const all = this.scope === 'all';
    const r = all ? sim.metrics.rolling : sim.metrics.rollingOf(this.scope as ServiceId);
    const cap = all ? sim.capacityPv : sim.capacityOf(this.scope as ServiceId);
    const market = all ? sim.marketSize : sim.marketOf(this.scope as ServiceId);
    const headroom = cap > 0 ? 1 - r.pv / cap : 0;
    const sat = all ? sim.secondsToSaturation() : sim.secondsToSaturation(this.scope as ServiceId);
    const satText = sat === null ? '届かない' : sat === 0 ? '超えている' : `あと ${duration(sat * 1000) === '0 分' ? `${Math.round(sat)} 秒` : duration(sat * 1000)}`;
    const satClass = sat === 0 ? 'bad' : sat !== null && sat < 300 ? 'warn' : '';
    const satNote =
      sat === null ? `市場規模 ${compact(market)} 人で頭打ち` : all && sim.activeServices.length > 1 ? 'いちばん早いサービス・広告なし' : '広告を買わない場合';
    const tiles: [string, string, string?, string?][] = [
      ['ページビュー', `${compact(r.pv, 1)}/秒`],
      ['キャパシティ', `${compact(cap, 1)}/秒`],
      ['余裕', `${Math.round(headroom * 100)}%`, headroom < 0.1 ? 'bad' : headroom < 0.3 ? 'warn' : ''],
      ['需要がキャパシティに届くまで', satText, satClass, satNote],
      ['成功率', `${(100 - r.errorRate * 100).toFixed(1)}%`, r.errorRate > 0.05 ? 'bad' : r.errorRate > 0.01 ? 'warn' : ''],
      ['応答 p99', `${Math.round(r.p99Ms)} ms`, r.p99Ms > 1500 ? 'bad' : r.p99Ms > 800 ? 'warn' : ''],
      all ? ['収支', rate(sim.incomePerSec), sim.incomePerSec < 0 ? 'bad' : ''] : ['売上', rate(r.revenuePerSec)],
      ['資金', money(sim.money)],
    ];
    this.tiles.innerHTML = tiles
      .map(
        ([k, v, cls, note]) =>
          `<div class="dash-tile"><div class="k">${k}</div><div class="v ${cls ?? ''}">${v}</div>${note ? `<div class="n">${note}</div>` : ''}</div>`,
      )
      .join('');
  }
}
