import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW } from '../src/world/board.mjs';
import { createSim, feet, TICK, RUN_SPEED, LADDER_SPEED, CELL } from '../src/game/sim.mjs';
import { snapCam, followCam, pixelCam } from '../src/game/camera.mjs';

const world = createWorld('00000000');
const mid = (m, c) => m && c % BW === 6 && ((c / BW) | 0) === 3;
const bd = (() => {
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (world.board(x, y).links?.some(mid)) return world.board(x, y);
  throw new Error('no tree board');
})();
const cell = bd.links.findIndex(mid);

const run = RUN_SPEED * TICK, climb = LADDER_SPEED * TICK;

/**
 * Drives the camera through a motion that turns at once. `place(sim, k)` puts
 * the feet for tick k of the motion; `held(f, cam)` tells whether the deadzone
 * holds the camera on the motion's axis. Returns the pixelCam value of every
 * held tick after the turn.
 */
function turn(first, second, held) {
  const sim = createSim(world, { board: bd, cell });
  const cam = { x: 0, y: 0 };
  first(sim, 0);
  snapCam(cam, sim);
  for (let k = 1; k <= 60; k++) { first(sim, k); followCam(cam, sim); }
  const out = [];
  for (let k = 1; k <= 120; k++) {
    second(sim, k);
    const before = { ...cam };
    followCam(cam, sim);
    if (held(feet(sim), before)) out.push(pixelCam(cam, feet(sim)));
  }
  return out;
}

const heldX = ([fx], cam) => Math.abs(fx - cam.x) <= 20;
const heldY = ([, fy], cam) => Math.abs(fy + 18 - cam.y) <= 12;

test('a run that turns at once draws one world position while the deadzone holds the camera', () => {
  const east = (s, k) => { s.facing = 1; s.off = run * k; };
  const west = (s, k) => { s.facing = -1; s.off = run * 60 - run * k; };
  const span = turn(east, west, heldX);
  assert.ok(span.length >= 10, `held ${span.length} ticks`);
  assert.deepEqual([...new Set(span.map(String))].length, 1, `the world steps: ${[...new Set(span.map(String))].join(' | ')}`);
});

test('a climb that turns at once draws one world position while the deadzone holds the camera', () => {
  const up = (s, k) => { s.mode = 'link'; s.link = 1; s.len = CELL; s.prog = climb * k; };
  // The down leg starts on the cell above, 48 px up, where the up leg ends.
  const down = (s, k) => { s.cell = cell + BW; s.mode = 'link'; s.link = 3; s.len = CELL; s.prog = climb * k; };
  const span = turn(up, down, heldY);
  assert.ok(span.length >= 10, `held ${span.length} ticks`);
  assert.deepEqual([...new Set(span.map(String))].length, 1, `the world steps: ${[...new Set(span.map(String))].join(' | ')}`);
});

test('pixelCam returns a whole camera unchanged for feet on a grid that includes the half pixel, and rounds the camera without an explorer', () => {
  const fractions = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9];
  for (const cx of [-300, -1, 0, 7, 1234]) {
    for (const cy of [-80, 0, 3, 999]) {
      for (const a of fractions) {
        for (const b of fractions) {
          const f = [100 + a, 40 + b];
          assert.deepEqual(pixelCam({ x: cx, y: cy }, f), [cx, cy], `cam (${cx}, ${cy}) feet (${f})`);
          assert.deepEqual(pixelCam({ x: cx, y: cy }, [-100 - a, -40 - b]), [cx, cy], `cam (${cx}, ${cy}) feet (${-100 - a}, ${-40 - b})`);
        }
      }
    }
  }
  assert.deepEqual(pixelCam({ x: 3.4, y: -7.6 }, null), [3, -8]);
  assert.deepEqual(pixelCam({ x: 2.5, y: 0.5 }, null), [3, 1]);
});
