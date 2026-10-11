import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { NCELL, cellNeighbor } from '../src/world/board.mjs';
import { createSim, step, feet, inputEdges, TICK, RUN_SPEED } from '../src/game/sim.mjs';
import { advance, snapshot, blend, SNAP_PX } from '../src/game/smooth.mjs';

const prev = { x: 100, y: 40, cx: 80, cy: 58 };
const cur = { x: 101.6, y: 40, cx: 81.2, cy: 59 };

test('blend returns prev, the midpoint and cur at alpha 0, 0.5 and 1, in all four fields', () => {
  assert.deepEqual(blend(prev, cur, 0), prev);
  assert.deepEqual(blend(prev, cur, 1), cur);
  const mid = blend(prev, cur, 0.5);
  for (const k of ['x', 'y', 'cx', 'cy']) assert.ok(Math.abs(mid[k] - (prev[k] + cur[k]) / 2) < 1e-12, k);
});

test('blend draws the latest state without a prev, or after a move over SNAP_PX', () => {
  assert.equal(SNAP_PX, 16);
  assert.deepEqual(blend(null, cur, 0.5), cur);
  const far = (dx, dy) => ({ ...cur, x: prev.x + dx, y: prev.y + dy });
  for (const [dx, dy] of [[17, 0], [-17, 0], [0, 17], [0, -17]]) {
    assert.deepEqual(blend(prev, far(dx, dy), 0.5), far(dx, dy), `${dx},${dy} snaps`);
  }
  for (const [dx, dy] of [[16, 0], [-16, 0], [0, 16], [0, -16]]) {
    const b = blend(prev, far(dx, dy), 0.5);
    assert.equal(b.x, prev.x + dx / 2, `${dx},${dy} blends`);
    assert.equal(b.y, prev.y + dy / 2, `${dx},${dy} blends`);
  }
});

test('advance spends ticks exactly as the loop did before: same count each frame, acc within 1e-12 s', () => {
  const intervals = [16.7, 8.3, 25, 400, 16.6, 33.4, 12.5, 250, 0, 16.8, 20.8, 1000];
  let acc = 0, base = 0;
  for (let round = 0; round < 3; round++) {
    for (const ms of intervals) {
      const dt = ms / 1000;
      base += Math.min(0.25, dt);
      let want = 0;
      while (base >= TICK) { base -= TICK; want++; }
      const got = advance(acc, dt);
      acc = got.acc;
      assert.equal(got.ticks, want, `${ms} ms`);
      assert.ok(Math.abs(acc - base) < 1e-12, `${ms} ms: acc ${acc} vs ${base}`);
    }
  }
});

/** The cell of the first board where `n` east links chain, as a sim on it. */
function runnerSim(world, n) {
  for (let y = 0; y < 40; y++) {
    for (let x = -3; x < 3; x++) {
      const bd = world.board(x, y);
      if (!bd.links) continue;
      for (let c = 0; c < NCELL; c++) {
        let k = c, ok = true;
        for (let i = 0; i < n && ok; i++) {
          if (!(bd.links[k] & 1)) ok = false;
          else k = cellNeighbor(k, 0);
        }
        if (ok) return createSim(world, { board: bd, cell: c });
      }
    }
  }
  throw new Error('no east chain');
}

test('drawn between ticks, the explorer and camera move by speed times the frame interval, on any cadence', () => {
  const sim = runnerSim(createWorld('00000000'), 3);
  const [x0, y0] = feet(sim);
  const cam = { x: x0 - 28.4, y: y0 + 18 };
  const intervals = [8.3, 25, 16.7, 12.5, 20.8, 16.6, 16.8];
  let acc = 0, total = 0, last = null, ph = 0, held = null;
  const ran = new Set();
  let compared = 0;
  // The loop's own order: advance, a snapshot before each step, a blend at acc / TICK.
  for (const ms of [...intervals, ...intervals]) {
    const spent = advance(acc, ms / 1000);
    acc = spent.acc;
    for (let i = 0; i < spent.ticks; i++) {
      held = snapshot(sim, cam);
      step(sim, 1, 0, false, inputEdges(ph, 0, 1, 0));
      ph = 1;
      cam.x += RUN_SPEED * TICK;
    }
    const drawn = blend(held, snapshot(sim, cam), acc / TICK);
    ran.add(spent.ticks);
    if (last && last.total >= 2) {
      assert.ok(Math.abs(drawn.x - last.x - (RUN_SPEED * ms) / 1000) < 1e-6, `feet at ${ms} ms: moved ${drawn.x - last.x}`);
      assert.ok(Math.abs(drawn.cx - last.cx - (RUN_SPEED * ms) / 1000) < 1e-6, `camera at ${ms} ms`);
      compared++;
    }
    total += spent.ticks;
    last = { ...drawn, total };
  }
  assert.deepEqual([...ran].sort(), [0, 1, 2], 'the cadence runs frames of 0, 1 and 2 ticks');
  assert.ok(compared >= 10, `${compared} frames compared`);
});
