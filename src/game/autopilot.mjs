// Scripted input for the self-test: walks the explorer along the start band's
// chain of route flames by feeding the same arrow and jump input a player would.
import { DX, DY } from '../world/board.mjs';
import { createSim, step, inputEdges } from './sim.mjs';

export const SELFTEST_CODE = '00000000';
export const SELFTEST_TICKS = 3600;

/**
 * Link directions of the cell path from (bd, cell) to (goal, goalCell),
 * searched within the bands one band around both ends.
 */
export function pathTo(world, bd, cell, goal, goalCell) {
  const u0 = Math.min(bd.u, goal.u) - 1, u1 = Math.max(bd.u, goal.u) + 1;
  const v0 = Math.min(bd.v, goal.v) - 1, v1 = Math.max(bd.v, goal.v) + 1;
  const near = (b) => b.u >= u0 && b.u <= u1 && b.v >= v0 && b.v <= v1;
  // Boards near the start keep p below 2^46, so the key stays exact.
  const key = (b, c) => b.p * 128 + c;
  const target = key(goal, goalCell);
  const prev = new Map([[key(bd, cell), null]]);
  const queue = [[bd, cell]];
  for (let h = 0; h < queue.length && !prev.has(target); h++) {
    const [b, c] = queue[h];
    for (let d = 0; d < 8; d++) {
      const t = world.step(b, c, d);
      if (!t || !near(t.board)) continue;
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

/**
 * Input source steering toward each goal cell in turn; returns [h, v, jump].
 * With `jumps`, it jumps at the foot of each ladder up; with `grabs`, it
 * holds Up from the apex to grab the ladder in the air.
 */
export function createAutopilot(world, goals, { jumps = true, grabs = true } = {}) {
  let gi = 0, path = null, at = -1, hopped = -1;
  return function input(s) {
    if (s.mode === 'link') return [DX[s.link], DY[s.link], false];
    if (s.mode === 'air') return [0, grabs && s.vy <= 0 ? 1 : 0, false];
    while (gi < goals.length) {
      const g = goals[gi];
      const gb = world.board(g.x, g.y);
      if (s.bd !== gb || s.cell !== g.cell) break;
      if (Math.abs(s.off) > 1) return [-Math.sign(s.off), 0, false];
      gi++;
      path = null;
    }
    if (gi >= goals.length) return [0, 0, false];
    const k = s.bd.p * 128 + s.cell;
    if (!path || at !== k) {
      const g = goals[gi];
      path = pathTo(world, s.bd, s.cell, world.board(g.x, g.y), g.cell);
      at = k;
    }
    if (!path || !path.length) return [0, 0, false];
    if (jumps && path[0] === 1 && hopped !== k) {
      if (Math.abs(s.off) > 1) return [-Math.sign(s.off), 0, false];
      hopped = k;
      return [0, 0, true];
    }
    return [DX[path[0]], DY[path[0]], false];
  };
}

/**
 * Runs the self-test script: the start band's entry, then along its flame
 * chain, for `ticks` steps. Returns the sim and the first unmet
 * requirement, if any. `options` pass to createAutopilot.
 */
export function runScript(world, ticks = SELFTEST_TICKS, options = {}) {
  const sim = createSim(world, world.startPoint());
  const drive = createAutopilot(world, world.bandFlames(0, 0).chain, options);
  let ph = 0, pv = 0;
  for (let i = 0; i < ticks; i++) {
    const [h, v, jump] = drive(sim);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
  }
  const st = sim.stats;
  let reason = null;
  if (st.corridor < 1) reason = 'no corridor run';
  else if (st.ladderUp < 1) reason = 'no ladder climbed';
  else if (st.seams < 1) reason = 'no board seam crossed';
  else if (st.flames < 1) reason = 'no flame touched';
  else if (st.jumps < 1) reason = 'no jump';
  else if (st.airGrabs + st.stairLandings < 1) reason = 'no air grab or stair landing';
  else if (sim.state !== 'play') reason = `run ended: ${sim.state}`;
  return { sim, reason };
}
