// Scripted input for the self-test: walks the explorer up band 0's chain of
// route flames by feeding the same arrow input a player would.
import { DX, DY } from '../world/board.mjs';
import { createSim, step } from './sim.mjs';

export const SELFTEST_CODE = '00000000';
export const SELFTEST_TICKS = 3600;

/** Link directions of the cell path from (bd, cell) to (goal, goalCell). */
export function pathTo(world, bd, cell, goal, goalCell) {
  const lo = Math.min(bd.band, goal.band) - 1, hi = Math.max(bd.band, goal.band) + 1;
  const key = (b, c) => b.p * 128 + c;
  const target = key(goal, goalCell);
  const prev = new Map([[key(bd, cell), null]]);
  const queue = [[bd, cell]];
  for (let h = 0; h < queue.length && !prev.has(target); h++) {
    const [b, c] = queue[h];
    for (let d = 0; d < 8; d++) {
      const t = world.step(b, c, d);
      if (!t || t.board.band < lo || t.board.band > hi) continue;
      const k = key(t.board, t.cell);
      if (prev.has(k)) continue;
      prev.set(k, [key(b, c), d]);
      queue.push([t.board, t.cell]);
    }
  }
  if (!prev.has(target)) return null;
  const dirs = [];
  for (let k = target; prev.get(k); k = prev.get(k)[0]) dirs.push(prev.get(k)[1]);
  return dirs.reverse();
}

/** Input source steering toward each goal cell in turn. */
export function createAutopilot(world, goals) {
  let gi = 0, path = null, at = -1;
  return function input(s) {
    if (s.mode === 'link') return [DX[s.link], DY[s.link]];
    while (gi < goals.length) {
      const g = goals[gi];
      const gb = world.board(g.x, g.y);
      if (s.bd !== gb || s.cell !== g.cell) break;
      if (Math.abs(s.off) > 1) return [-Math.sign(s.off), 0];
      gi++;
      path = null;
    }
    if (gi >= goals.length) return [0, 0];
    const k = s.bd.p * 128 + s.cell;
    if (!path || at !== k) {
      const g = goals[gi];
      path = pathTo(world, s.bd, s.cell, world.board(g.x, g.y), g.cell);
      at = k;
    }
    if (!path || !path.length) return [0, 0];
    return [DX[path[0]], DY[path[0]]];
  };
}

/**
 * Runs the self-test script: band 0's entry, then up its flame chain, for
 * `ticks` steps. Returns the sim and the first unmet requirement, if any.
 */
export function runScript(world, ticks = SELFTEST_TICKS) {
  const t = world.tree(0);
  const sim = createSim(world, world.resumePoint(t.entryX, 0));
  const drive = createAutopilot(world, world.bandFlames(0).chain);
  for (let i = 0; i < ticks; i++) {
    const [h, v] = drive(sim);
    step(sim, h, v);
  }
  const st = sim.stats;
  let reason = null;
  if (st.corridor < 1) reason = 'no corridor run';
  else if (st.ladderUp < 1) reason = 'no ladder climbed';
  else if (st.seams < 1) reason = 'no board seam crossed';
  else if (st.flames < 1) reason = 'no flame touched';
  else if (sim.state !== 'play') reason = `run ended: ${sim.state}`;
  return { sim, reason };
}
