// The frame's world-to-device transform scrolls the world evenly and holds the
// explorer still (spec section 8, Camera). DOM-free: it drives the real helper
// and followCam with feet placed each tick, as tick(g) calls followCam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW } from '../src/world/board.mjs';
import { createSim, feetX, feetY, nodeXY, CELL, TICK, RUN_SPEED, LADDER_SPEED } from '../src/game/sim.mjs';
import { snapCam, followCam, createFrame, placeFrame, deviceX, deviceY, LAYER_MARGIN } from '../src/game/camera.mjs';
import { VIEW_W, VIEW_H } from '../src/game/render.mjs';

const world = createWorld('00000000');
const mid = (m, c) => m && c % BW === 6 && ((c / BW) | 0) === 3;
const bd = (() => {
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (world.board(x, y).links?.some(mid)) return world.board(x, y);
  throw new Error('no tree board');
})();
const cell = bd.links.findIndex(mid);
const [nx, ny] = nodeXY(bd, cell);

const DISPLAYS = [
  { name: 'the 2752 x 1548 display at a fractional 8.6x', w: 2752, h: 1548 },
  { name: 'the 2560 x 1440 iPad display at 8x', w: 2560, h: 1440 },
  { name: 'the 1280 x 720 keyboard display at 4x', w: 1280, h: 720 },
];
const SPEEDS = [0.8, 1.2, 1.6];
// The feet d px from the cell's node: across the floor, or up a ladder. `k` indexes the moving coordinate.
const AXES = [
  { name: 'across', k: 0, place: (s, d) => { s.mode = 'floor'; s.off = d; } },
  { name: 'up', k: 1, place: (s, d) => { s.mode = 'link'; s.link = 1; s.len = CELL; s.prog = d; } },
];
const SETTLE = 120, TICKS = 300;

/**
 * Runs `ticks` ticks on `display`: each puts the feet by `place(sim, k)`,
 * follows them with the camera and places the frame, then calls
 * `frame(f, sim, cam, before, k)` with the camera before the follow.
 */
function drive(display, place, ticks, frame) {
  const sim = createSim(world, { board: bd, cell });
  const cam = { x: 0, y: 0 }, f = createFrame();
  place(sim, 0);
  snapCam(cam, sim);
  for (let k = 1; k <= ticks; k++) {
    const before = { ...cam };
    place(sim, k);
    followCam(cam, sim);
    placeFrame(f, cam, display.w, display.h, VIEW_W, VIEW_H);
    frame(f, sim, cam, before, k);
  }
}

// The blit samples nearest-neighbour: layer pixel edge i of a layer placed at
// device `at` with scale `s` lands on device pixel round(at + i·s).
/** The device pixel world point (x, y) lands on as the frame places the world layer. */
const worldPoint = (f, x, y) => [
  Math.round(f.worldX + (x - (f.camX - VIEW_W / 2 - LAYER_MARGIN)) * f.sx),
  Math.round(f.worldY + (f.camY + VIEW_H / 2 + LAYER_MARGIN - y) * f.sy),
];
/** The device pixel back-wall point (x, y) lands on as the frame places the back wall. */
const wallPoint = (f, x, y) => [
  Math.round(f.wallX + (x - (f.bx - VIEW_W / 2 - LAYER_MARGIN)) * f.sx),
  Math.round(f.wallY + (f.by + VIEW_H / 2 + LAYER_MARGIN - y) * f.sy),
];
const range = (xs) => [Math.min(...xs), Math.max(...xs)];

for (const display of DISPLAYS) {
  for (const axis of AXES) {
    for (const v of SPEEDS) {
      test(`(a) at ${v} px a tick ${axis.name} on ${display.name}, a world point and a back-wall point scroll by per-tick steps at most 1 device px apart`, (t) => {
        const steps = { world: [[], []], wall: [[], []] };
        let last = null;
        drive(display, (s, k) => axis.place(s, v * k), SETTLE + TICKS, (f, sim, cam, before, k) => {
          const now = { world: worldPoint(f, nx, ny), wall: wallPoint(f, Math.floor(nx / 2), Math.floor(ny / 2)) };
          if (k > SETTLE) for (const key of ['world', 'wall']) for (const i of [0, 1]) steps[key][i].push(now[key][i] - last[key][i]);
          last = now;
        });
        const [w0, w1] = range(steps.world[axis.k]), [b0, b1] = range(steps.wall[axis.k]);
        t.diagnostic(`world steps ${w0} to ${w1} device px, back wall ${b0} to ${b1}`);
        for (const key of ['world', 'wall']) {
          for (const i of [0, 1]) {
            const [lo, hi] = range(steps[key][i]);
            assert.ok(hi - lo <= 1, `the ${key} point's ${'xy'[i]} steps ${lo} to ${hi} device px a tick`);
          }
        }
      });

      test(`(b) at ${v} px a tick ${axis.name} on ${display.name}, the explorer holds within 1 device px of its first settled position`, (t) => {
        const at = [];
        drive(display, (s, k) => axis.place(s, v * k), SETTLE + TICKS, (f, sim, cam, before, k) => {
          if (k > SETTLE) at.push([Math.round(deviceX(f, feetX(sim))), Math.round(deviceY(f, feetY(sim)))]);
        });
        const spread = [0, 1].map((i) => Math.max(...at.map((p) => Math.abs(p[i] - at[0][i]))));
        t.diagnostic(`spread ${spread[0]}, ${spread[1]} device px from ${at[0]}`);
        assert.ok(spread[0] <= 1 && spread[1] <= 1, `the explorer strays ${spread} device px from ${at[0]}`);
      });
    }
  }
}

const run = RUN_SPEED * TICK, climb = LADDER_SPEED * TICK;
const STOPS = [
  { name: 'run', k: 0, place: (s, d) => { s.mode = 'floor'; s.off = d; }, v: run },
  { name: 'climb', k: 1, place: (s, d) => { s.mode = 'link'; s.link = 1; s.len = CELL; s.prog = d; }, v: climb },
];

for (const display of DISPLAYS) {
  for (const stop of STOPS) {
    test(`(c) with the feet at rest after a ${stop.name} on ${display.name}, the world scrolls one way while the camera settles, then not at all`, (t) => {
      const MOVE = 120, REST = 600;
      const steps = [], moved = [];
      let last = null;
      drive(display, (s, k) => stop.place(s, stop.v * Math.min(k, MOVE)), MOVE + REST, (f, sim, cam, before, k) => {
        const now = worldPoint(f, nx, ny)[stop.k];
        if (k > MOVE) {
          steps.push(now - last);
          moved.push(cam.x !== before.x || cam.y !== before.y);
        }
        last = now;
      });
      const settled = moved.lastIndexOf(true) + 1;
      const going = steps.slice(0, settled).filter((d) => d !== 0);
      t.diagnostic(`the camera settles ${settled} ticks after the stop; steps ${range(steps)} device px`);
      assert.ok(settled > 0 && settled < REST, `the camera settles ${settled} ticks after the stop`);
      assert.ok(going.length > 0, 'the world scrolls while the camera settles');
      assert.ok(going.every((d) => Math.sign(d) === Math.sign(going[0])), `the scroll reverses: ${going.join(' ')}`);
      assert.ok(steps.slice(settled).every((d) => d === 0), 'a camera at rest scrolls nothing');
    });
  }
}

const TURNS = [
  {
    name: 'run that turns at once',
    first: (s, k) => { s.facing = 1; s.off = run * k; },
    second: (s, k) => { s.facing = -1; s.off = run * 60 - run * k; },
    held: (fx, fy, cam) => Math.abs(fx - cam.x) <= 20,
  },
  {
    name: 'climb that turns at once',
    first: (s, k) => { s.mode = 'link'; s.link = 1; s.len = CELL; s.prog = climb * k; },
    // The down leg starts on the cell above, 48 px up, where the up leg ends.
    second: (s, k) => { s.cell = cell + BW; s.mode = 'link'; s.link = 3; s.len = CELL; s.prog = climb * k; },
    held: (fx, fy, cam) => Math.abs(fy + 18 - cam.y) <= 12,
  },
];

for (const display of DISPLAYS) {
  for (const turn of TURNS) {
    test(`(d) after a ${turn.name} on ${display.name}, the world layer holds its device position on every tick the deadzone holds the camera`, (t) => {
      const held = [], moved = [];
      let last = null;
      drive(display, (s, k) => (k <= 60 ? turn.first(s, k) : turn.second(s, k - 60)), 180, (f, sim, cam, before, k) => {
        if (k > 60 && turn.held(feetX(sim), feetY(sim), before)) {
          held.push(k - 60);
          if (f.worldX !== last.worldX || f.worldY !== last.worldY) moved.push(`${k - 60} (${(f.worldX - last.worldX).toFixed(2)}, ${(f.worldY - last.worldY).toFixed(2)})`);
        }
        last = { worldX: f.worldX, worldY: f.worldY };
      });
      t.diagnostic(`held ${held.length} ticks, ${held[0]} to ${held[held.length - 1]} after the turn`);
      assert.ok(held.length >= 10, `held ${held.length} ticks`);
      assert.deepEqual(moved, [], `held from tick ${held[0]}, the world moves on ticks ${moved.join(', ')}`);
    });
  }
}
