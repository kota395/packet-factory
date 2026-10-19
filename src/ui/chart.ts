import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { History } from '../sim/metrics';
import { compact } from './format';

/** ユーザー数とエラー率の推移を表示する小さなグラフ */
export class MetricsChart {
  private plot: uPlot | null = null;
  private lastLength = -1;

  constructor(private readonly host: HTMLElement) {}

  update(history: History, force = false): void {
    if (!force && history.t.length === this.lastLength) return;
    this.lastLength = history.t.length;
    const data: uPlot.AlignedData = [history.t, history.users, history.errorRate.map((r) => r * 100)];
    if (!this.plot) this.create(data);
    else this.plot.setData(data);
  }

  resize(): void {
    this.plot?.setSize(this.size());
  }

  reset(): void {
    this.plot?.destroy();
    this.plot = null;
    this.lastLength = -1;
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(200, this.host.clientWidth), height: 130 };
  }

  private create(data: uPlot.AlignedData): void {
    const axis = { stroke: '#8b98a5', grid: { stroke: '#1f2a36', width: 1 }, ticks: { stroke: '#1f2a36' } };
    this.plot = new uPlot(
      {
        ...this.size(),
        scales: {
          x: { time: false },
          users: { range: (_u, _min, max) => [0, Math.max(100, max * 1.1)] },
          pct: { range: (_u, _min, max) => [0, Math.max(5, max * 1.2)] },
        },
        series: [
          { label: '秒' },
          {
            label: 'ユーザー',
            scale: 'users',
            stroke: '#2ec4b6',
            width: 1.5,
            points: { show: false },
            value: (_u, v) => (v == null ? '-' : compact(v)),
          },
          {
            label: 'エラー率 (%)',
            scale: 'pct',
            stroke: '#ff4d4f',
            width: 1.5,
            points: { show: false },
            value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
          },
        ],
        axes: [
          { ...axis },
          { ...axis, scale: 'users', size: 48, values: (_u, vals) => vals.map((v) => compact(v)) },
          { ...axis, scale: 'pct', side: 1, size: 36, grid: { show: false } },
        ],
        cursor: { drag: { x: false, y: false } },
      },
      data,
      this.host,
    );
  }
}
