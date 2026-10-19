import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { History } from '../sim/metrics';

/** p99 レイテンシとエラー率の推移を表示する小さなグラフ */
export class MetricsChart {
  private plot: uPlot | null = null;
  private lastLength = -1;

  constructor(private readonly host: HTMLElement) {}

  update(history: History, force = false): void {
    if (!force && history.t.length === this.lastLength) return;
    this.lastLength = history.t.length;
    const data: uPlot.AlignedData = [history.t, history.p99, history.errorRate.map((r) => r * 100)];
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
          ms: { range: (_u, _min, max) => [0, Math.max(200, max * 1.1)] },
          pct: { range: (_u, _min, max) => [0, Math.max(2, max * 1.2)] },
        },
        series: [
          { label: '秒' },
          { label: 'p99 (ms)', scale: 'ms', stroke: '#4aa3ff', width: 1.5, value: (_u, v) => (v == null ? '-' : `${v}`) },
          {
            label: 'エラー率 (%)',
            scale: 'pct',
            stroke: '#ff4d4f',
            width: 1.5,
            value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
          },
        ],
        axes: [
          { ...axis },
          { ...axis, scale: 'ms', size: 44 },
          { ...axis, scale: 'pct', side: 1, size: 36, grid: { show: false } },
        ],
        cursor: { drag: { x: false, y: false } },
      },
      data,
      this.host,
    );
  }
}
