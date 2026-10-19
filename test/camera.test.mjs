import v8 from 'node:v8';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW } from '../src/world/board.mjs';
import { createSim, feet, TICK, RUN_SPEED, LADDER_SPEED, CELL } from '../src/game/sim.mjs';
import { snapCam, followCam, pixelCam, pixelCamX, pixelCamY } from '../src/game/camera.mjs';

const world = createWorld('00000000');
const mid = (m, c) => m && c % BW === 6 && ((c / BW) | 0) === 3;
const bd = (() => {
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (world.board(x, y).links?.some(mid)) return world.board(x, y);
  throw new Error('no tree board');
})();
const cell = bd.links.findIndex(mid);

const run = RUN_SPEED * TICK, climb = LADDER_SPEED * TICK;

/**
 * Drives the camera through a motion that turns at once. `first(sim, k)` and
 * `second(sim, k)` put the feet for tick k of the first and the second motion;
 * `held(f, cam)` tells whether the deadzone holds the camera on the motion's
 * axis. Returns the pixelCam value of every held tick after the turn.
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
  const seen = new Set(span.map(String));
  assert.equal(seen.size, 1, `the world steps: ${[...seen].join(' | ')}`);
});

test('a climb that turns at once draws one world position while the deadzone holds the camera', () => {
  const up = (s, k) => { s.mode = 'link'; s.link = 1; s.len = CELL; s.prog = climb * k; };
  // The down leg starts on the cell above, 48 px up, where the up leg ends.
  const down = (s, k) => { s.cell = cell + BW; s.mode = 'link'; s.link = 3; s.len = CELL; s.prog = climb * k; };
  const span = turn(up, down, heldY);
  assert.ok(span.length >= 10, `held ${span.length} ticks`);
  const seen = new Set(span.map(String));
  assert.equal(seen.size, 1, `the world steps: ${[...seen].join(' | ')}`);
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

test('the camera step equals pixelCam of the feet in floor, air and link modes, and of no explorer', () => {
  const fractions = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9];
  const sim = createSim(world, { board: bd, cell });
  const place = {
    floor: (a) => { sim.mode = 'floor'; sim.off = a * 10 - 5; },
    air: (a, b) => { sim.mode = 'air'; sim.off = a * 10 - 5; sim.alt = b * 7; },
    link: (a) => { sim.mode = 'link'; sim.link = 1; sim.len = CELL; sim.prog = a * 7; },
  };
  const cams = [{ x: -300.5, y: -80.25 }, { x: 0, y: 0 }, { x: 7.5, y: 3.4 }, { x: 1234.75, y: 999.5 }];
  for (const mode of ['floor', 'air', 'link']) {
    for (const a of fractions) {
      for (const b of fractions) {
        place[mode](a, b);
        for (const cam of cams) {
          const want = pixelCam(cam, feet(sim));
          assert.deepEqual([pixelCamX(cam, sim), pixelCamY(cam, sim)], want, `${mode} (${a}, ${b}) cam (${cam.x}, ${cam.y})`);
        }
      }
    }
  }
  for (const cam of [{ x: 3.4, y: -7.6 }, { x: 2.5, y: 0.5 }]) {
    assert.deepEqual([pixelCamX(cam, null), pixelCamY(cam, null)], pixelCam(cam, null));
  }
});

const allocated = () => v8.getHeapStatistics().total_allocated_bytes;

/** The least bytes a call of `step` allocates over 3 windows of 100,000 calls, after a warm-up of as many. */
function bytesPerCall(step) {
  for (let i = 0; i < 100000; i++) step();
  const per = [];
  for (let w = 0; w < 3; w++) {
    const before = allocated();
    for (let i = 0; i < 100000; i++) step();
    per.push((allocated() - before) / 100000);
  }
  return Math.min(...per);
}

/** A steady explorer on the floor at a half pixel, and a camera that holds it. */
function steady() {
  const sim = createSim(world, { board: bd, cell });
  sim.off = 0.5;
  const cam = { x: 0, y: 0 };
  snapCam(cam, sim);
  return { sim, cam };
}

test('the frame\'s camera step allocates under 32 bytes a call', () => {
  const { sim, cam } = steady();
  let sink = 0;
  const per = bytesPerCall(() => { sink += pixelCamX(cam, sim) + pixelCamY(cam, sim); });
  assert.ok(sink !== 0);
  assert.ok(per < 32, `${per} bytes a call`);
});

test('followCam allocates under 32 bytes a call', () => {
  const { sim, cam } = steady();
  const per = bytesPerCall(() => followCam(cam, sim));
  assert.ok(per < 32, `${per} bytes a call`);
});
