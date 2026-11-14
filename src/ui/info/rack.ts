/** 詳細パネルの中身: 空いている U(買える機器の一覧)と、ラックの区画の詳細 */
import { BUYABLE_MODELS, MODEL_BY_ID, PRESETS, PRESET_BY_ID, isServerModel, partsSummary, specOf } from '../../sim/catalog';
import type { ModelDef } from '../../sim/catalog';
import { UPKEEP } from '../../sim/pricing';
import type { Simulation } from '../../sim/simulation';
import { money, rate } from '../format';
import { gbps, specText } from './common';
import type { Content } from './common';

export function unitContent(sim: Simulation, slot: number, u: number, base: string): Content {
  // サーバは構成(プリセット)ごと、それ以外は機種ごとに並べる
  const item = (m: ModelDef, title: string, desc: string, preset?: string) => {
    const parts = preset ? PRESET_BY_ID[preset].parts : undefined;
    const locked = sim.canBuyModel(m.id, parts);
    return `
      <div class="cat-item ${locked ? 'locked' : ''}">
        <div class="cat-main">
          <div class="cat-title">${title}<span class="inv-tag">${m.u}U・${specOf({ model: m.id, parts }).powerW}W</span></div>
          <div class="cat-spec">${specText(m, parts)}</div>
          ${desc ? `<div class="cat-spec muted">${desc}</div>` : ''}
          <div class="cat-note"></div>
        </div>
        <button type="button" class="buy" data-act="buy" data-model="${m.id}" ${preset ? `data-preset="${preset}"` : ''} data-slot="${slot}" data-u="${u}">${money(sim.devicePrice(m.id, parts))}</button>
      </div>`;
  };
  const items = [
    ...PRESETS.map((p) => {
      const drives = partsSummary(p.parts).split('・').filter((x) => /×/.test(x)).join('・');
      return item(MODEL_BY_ID[p.model], p.name, `${drives}(ミラー)。${p.description}`, p.id);
    }),
    ...BUYABLE_MODELS.filter((m) => !isServerModel(m.id)).map((m) => item(m, m.name, '')),
    // 回線を増やす(回線の多重化を解放したら)
    item(MODEL_BY_ID.handoff, '回線を追加(回線終端)', `回線契約(${gbps(sim.uplinkGbps)})が 1 本ぶん増え、月額も 1 本ぶんかかる。BGP で回線に分けて流す。`),
  ].join('');
  const power = sim.facility.powerUsed(slot);
  return {
    key: `unit${slot}:${u}@${base}`,
    title: `ラック ${slot + 1} の ${u}U`,
    subtitle: '機器を設置',
    desc: `この U を一番下にして設置します。2U の機器は ${u + 1}U まで使います。電力 ${power} / ${sim.rackPowerW} W。`,
    fixed: `<div class="catalog">${items}</div>`,
    live: '',
  };
}

export function slotContent(sim: Simulation, slot: number, base: string): Content {
  const rented = sim.facility.isRented(slot);
  const rent = UPKEEP.rackByPowerLevel[sim.upgrades.rackPower];
  return {
    key: `slot${slot}@${base}`,
    title: `区画 ${slot + 1}`,
    subtitle: rented ? '借りています' : '空き区画',
    desc: rented
      ? ''
      : `データセンターの区画を借りてラックを置きます。42U・電力 ${sim.rackPowerW}W。置いたサーバは同じラックのスイッチに自動でつながるので、新しいラックにはまずスイッチ(ToR)を置きます。`,
    fixed: rented
      ? ''
      : `<div class="actions"><button type="button" class="primary" data-act="rent" data-slot="${slot}">借りる(${money(sim.rackPrice())}、賃料 ${rate(rent)})</button></div>`,
    live: '',
  };
}
