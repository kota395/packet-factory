/**
 * チュートリアル。回線終端とスイッチだけのラックから、web と db のサーバを置いて役割を付け、
 * db を強化して配線するところまでを、実際に操作してもらいながら進める。
 * スキップすると、チュートリアルで作るもの(newGame の構成)が最初からある状態で始まる。
 *
 * 各ステップは「終わったか」をゲームの状態から判定するので、どの順に操作しても先へ進む。
 */
import type { Face, ViewState } from '../render/row';
import type { Device } from '../sim/facility';
import type { Simulation } from '../sim/simulation';
import type { Selection } from './info';

export interface TutorialContext {
  readonly sim: Simulation;
  readonly selected: Selection | null;
  readonly face: Face;
}

interface Step {
  readonly title: string;
  readonly body: (ctx: TutorialContext) => string;
  /** 終わったか。なければ「次へ」で進む */
  readonly done?: (ctx: TutorialContext) => boolean;
  /** 光らせる画面の部品(CSS セレクタ) */
  readonly glow?: (ctx: TutorialContext) => string[];
  /** 光らせる機器・U */
  readonly highlight?: (ctx: TutorialContext) => ViewState['highlight'];
  /** 「次へ」ボタンの文字 */
  readonly next?: string;
}

const STORAGE_KEY = 'packet-factory:tutorial';

const servers = (sim: Simulation, model: 'srv-1u' | 'srv-2u'): Device[] =>
  [...sim.facility.devices.values()].filter((d) => d.model === model).sort((a, b) => a.id - b.id);
const web = (sim: Simulation) => servers(sim, 'srv-1u')[0];
const db = (sim: Simulation) => servers(sim, 'srv-2u')[0];
const switchOf = (sim: Simulation) => [...sim.facility.devices.values()].find((d) => d.model === 'sw-24');
/** サーバがスイッチにつながっているか */
const wired = (sim: Simulation, d: Device | undefined) =>
  !!d &&
  sim.facility.cablesOf(d.id).some((c) => {
    const other = sim.facility.devices.get(c.a.device === d.id ? c.b.device : c.a.device);
    return other?.model === 'sw-24';
  });
/** 空いている U の目印(スイッチの下あたり) */
const freeUnit = (sim: Simulation, height: number) => {
  for (let u = 38; u >= 1; u--) {
    let ok = true;
    for (let i = 0; i < height; i++) if (sim.facility.deviceAt(0, u + i)) ok = false;
    if (ok && u + height - 1 <= 40) return [{ slot: 0, u }];
  }
  return [];
};
const selectedIs = (ctx: TutorialContext, d: Device | undefined) =>
  !!d && ctx.selected?.kind === 'device' && ctx.selected.id === d.id;

const STEPS: readonly Step[] = [
  {
    title: 'ようこそ',
    body: () =>
      'あなたはブログサービスのインフラ担当です。借りたラックには、インターネットにつながる<b>回線終端(isp01)</b>と<b>スイッチ(sw01)</b>だけが入っています。サーバを置いて、ブログが動くところまで一緒にやってみましょう。チュートリアルの間は時間が止まっています。',
    next: 'はじめる',
  },
  {
    title: 'web サーバを置く',
    body: () =>
      'ラックの<b>空いている U(光っている所)</b>をタップすると、買える機器の一覧が出ます。<b>「1U 小型」</b>を買ってください。',
    done: (c) => !!web(c.sim),
    glow: () => ['button[data-preset="1u-small"]'],
    highlight: (c) => (c.selected?.kind === 'unit' ? null : { units: freeUnit(c.sim, 1) }),
  },
  {
    title: '役割「web」を付ける',
    body: (c) =>
      `${selectedIs(c, web(c.sim)) ? '' : `<b>${web(c.sim)?.name}</b> をタップして詳細を開き、`}役割の<b>「web」</b>を押してください。web はユーザーのリクエストを受けて、ページを組み立てて返す役割です。`,
    done: (c) => !!web(c.sim)?.roles.includes('blog:web'),
    glow: () => ['button[data-act="role"][data-role="blog:web"]'],
    highlight: (c) => (selectedIs(c, web(c.sim)) ? null : { devices: [web(c.sim)!.id] }),
  },
  {
    title: 'db サーバを置く',
    body: () =>
      'もう一度空いている U をタップし、<b>「2U HDD 小型」</b>を買ってください。2U の機器は、タップした U から上に 2U ぶん使います。',
    done: (c) => !!db(c.sim),
    glow: () => ['button[data-preset="2u-hdd-small"]'],
    highlight: (c) => (c.selected?.kind === 'unit' ? null : { units: freeUnit(c.sim, 2) }),
  },
  {
    title: '役割「db」を付ける',
    body: (c) =>
      `${selectedIs(c, db(c.sim)) ? '' : `<b>${db(c.sim)?.name}</b> をタップして、`}役割の<b>「db」</b>を押してください。db は記事を保存するデータベース(MySQL)です。web は 1 ページごとに db へ読み込みに行きます。`,
    done: (c) => !!db(c.sim)?.roles.includes('blog:db'),
    glow: () => ['button[data-act="role"][data-role="blog:db"]'],
    highlight: (c) => (selectedIs(c, db(c.sim)) ? null : { devices: [db(c.sim)!.id] }),
  },
  {
    title: 'db を強化する',
    body: (c) =>
      `db はメモリが多いほど読み込みがメモリに乗り、遅い HDD に行かなくなります。${selectedIs(c, db(c.sim)) ? '' : `<b>${db(c.sim)?.name}</b> をタップして、`}詳細の「構成」で、メモリの<b>「▲ 16GB」</b>を押してください。CPU・メモリ・ドライブは、いつでもワンクリックで替えられます。`,
    done: (c) => (db(c.sim)?.parts?.memGB ?? 0) >= 16,
    glow: () => ['button[data-act="part"][data-change="mem:1"]'],
    highlight: (c) => (selectedIs(c, db(c.sim)) ? null : { devices: [db(c.sim)!.id] }),
  },
  {
    title: '背面に切り替える',
    body: () => 'サーバはまだネットワークにつながっていません。配線はラックの背面で行います。下の<b>「背面」</b>を押してください。',
    done: (c) => c.face === 'back',
    glow: () => ['#toolbar [data-tool="back"]'],
  },
  {
    title: '配線する',
    body: (c) => {
      const left = [web(c.sim), db(c.sim)].filter((d) => d && !wired(c.sim, d)).map((d) => d!.name);
      return `サーバの<b>ポート(左の小さな四角)</b>から、スイッチ <b>sw01</b> の空いているポートまでドラッグしてください。線が指(マウス)についてきて、離すとケーブルが引かれます。${left.length ? `残り: <b>${left.join('・')}</b>` : ''}`;
    },
    done: (c) => wired(c.sim, web(c.sim)) && wired(c.sim, db(c.sim)),
    highlight: (c) => {
      const sw = switchOf(c.sim);
      const left = [web(c.sim), db(c.sim)].filter((d) => d && !wired(c.sim, d)).map((d) => d!.id);
      return { devices: [...left, ...(sw ? [sw.id] : [])] };
    },
  },
  {
    title: 'ブログが動きました',
    body: (c) => {
      const ok = c.sim.flow.success >= 0.99;
      return ok
        ? '回線 → スイッチ → web → db の経路ができ、アクセスを捌けるようになりました。上の HUD で、ユーザー数・ページビュー・エラー率・応答時間が見られます。ケーブルの色は使用率です。'
        : `まだうまく流れていません: ${c.sim.flow.problems[0] ?? '配線と役割を確かめてください'}`;
    },
    glow: () => ['#hud .stats'],
  },
  {
    title: 'サービスの様子を見る',
    body: () => '下の<b>「サービス」</b>を押すと、リクエストの流れと、<b>一番詰まっている所</b>が見られます。困ったらまずここを見ます。',
    done: (c) => c.selected?.kind === 'service',
    glow: () => ['#toolbar [data-tool="service"]'],
  },
  {
    title: 'メトリクスと投資',
    body: () =>
      '上の<b>「メトリクス」</b>では、需要とキャパシティの推移と、この先の需要の予測が見られます。お金が貯まったら、下の<b>「投資」</b>で広告や新しいソフトウェア・機器を解放します。',
    glow: () => ['#btn-chart', '#toolbar [data-tool="invest"]'],
  },
  {
    title: 'あとは任せました',
    body: () =>
      'ユーザーが増えると、まず db の HDD のディスク IO が詰まります。詰まったら、サーバの詳細でメモリを増やす・SSD に替える、web を増やす、などで手を打ちましょう。時間を進めて始めます。',
    next: '時間を進める',
  },
];

export class Tutorial {
  private step = -1;
  private readonly card: HTMLElement;
  private shown = '';

  constructor(
    host: HTMLElement,
    /** 終わったとき(skipped: スキップしたか) */
    private readonly onEnd: (skipped: boolean) => void,
  ) {
    this.card = document.createElement('section');
    this.card.id = 'tutorial';
    this.card.hidden = true;
    this.card.setAttribute('aria-live', 'polite');
    host.appendChild(this.card);
    this.card.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tut]');
      if (!b) return;
      if (b.dataset.tut === 'skip') this.end(true);
      else this.advance();
    });
  }

  get active(): boolean {
    return this.step >= 0;
  }

  /** 前回の途中から(なければ最初から) */
  start(resume = false): void {
    let at = 0;
    if (resume) {
      try {
        at = Math.max(0, Math.min(STEPS.length - 1, Number(localStorage.getItem(STORAGE_KEY) ?? 0) || 0));
      } catch {
        at = 0;
      }
    }
    this.step = at;
    this.shown = '';
    this.persist();
  }

  /** 途中のチュートリアルがあるか */
  static pending(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  /** 状態を見て、終わったステップを進め、カードと目印を描き直す */
  update(ctx: TutorialContext): ViewState['highlight'] {
    if (!this.active) {
      this.clearGlow();
      return null;
    }
    // 終わったステップは飛ばす(順番どおりでなくても進む)
    while (this.step < STEPS.length && STEPS[this.step].done?.(ctx)) this.step++;
    if (this.step >= STEPS.length) {
      this.end(false);
      return null;
    }
    this.persist();
    const s = STEPS[this.step];
    const html = `
      <div class="tut-head"><span>チュートリアル ${this.step + 1} / ${STEPS.length}</span>
        <button type="button" class="tut-skip" data-tut="skip">スキップ</button></div>
      <h3>${s.title}</h3>
      <p>${s.body(ctx)}</p>
      ${s.done ? '' : `<div class="tut-actions"><button type="button" class="primary" data-tut="next">${s.next ?? '次へ'}</button></div>`}`;
    if (html !== this.shown) {
      this.shown = html;
      this.card.innerHTML = html;
    }
    this.card.hidden = false;
    this.clearGlow();
    for (const sel of s.glow?.(ctx) ?? []) {
      for (const el of document.querySelectorAll(sel)) el.classList.add('tut-glow');
    }
    return s.highlight?.(ctx) ?? null;
  }

  private advance(): void {
    this.step++;
    this.shown = '';
    if (this.step >= STEPS.length) this.end(false);
  }

  private end(skipped: boolean): void {
    this.step = -1;
    this.card.hidden = true;
    this.clearGlow();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 覚えておけなくても終わる
    }
    this.onEnd(skipped);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, String(this.step));
    } catch {
      // 途中からの再開ができないだけ
    }
  }

  private clearGlow(): void {
    for (const el of document.querySelectorAll('.tut-glow')) el.classList.remove('tut-glow');
  }
}
