import { describe, expect, it } from 'vitest';
import { GOAL, GOALS } from '../src/sim/economy';
import { createSave, loadSave, newGame, parseSave } from '../src/sim/save';

describe('目標', () => {
  it('条件を 30 秒続けて満たすと達成して報酬が入り、次の目標へ進む。セーブに残る', () => {
    const s = newGame('peace');
    expect(s.goal).toBe(GOALS[0]);
    // 30 PV/秒に届かないうちは進まない
    s.step(40_000);
    expect(s.goalsDone).toBe(0);
    s.serviceUsers.blog = 4000;
    s.upgrades.marketing = 4;
    s.step(8000); // 直近の集計が追いつくまで
    const before = s.money;
    s.step((GOAL.holdSec + 2) * 1000);
    expect(s.goalsDone).toBe(1);
    expect(s.lastGoal!.reward).toBe(GOALS[0].reward);
    expect(s.money).toBeGreaterThan(before + GOALS[0].reward - 50);
    expect(s.goal).toBe(GOALS[1]);
    expect(loadSave(parseSave(JSON.parse(JSON.stringify(createSave(s, 0))))!).goalsDone).toBe(1);
  });
});
