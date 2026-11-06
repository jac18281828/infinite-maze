// The frame's world-to-device transform scrolls the world evenly and holds the
// explorer still (spec section 8, Camera), per tick and per display frame
// between ticks. DOM-free: it drives the real helper and followCam with feet
// placed each tick, as tick(g) calls followCam, and the real guard, blend and
// blend choice per frame, as runLoop and draw call them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW } from '../src/world/board.mjs';
import { createSim, feetX, feetY, nodeXY, CELL, TICK, RUN_SPEED, LADDER_SPEED } from '../src/game/sim.mjs';
import {
  snapCam, followCam, createFrame, placeFrame, deviceX, deviceY, LAYER_MARGIN, blendTicks, blendsTicks,
} from '../src/game/camera.mjs';
import { createGuard } from '../src/game/loop.mjs';
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

// Display frames between ticks. The clock fires frames at `hz`, each moved by
// up to ±jitter ms from a fixed seed; each frame runs the guard's due ticks,
// then draws at its fraction as draw(g, t, alpha) does.
const RATES = [
  { name: '60 Hz', hz: 60, jitter: 0 },
  { name: '90 Hz', hz: 90, jitter: 0 },
  { name: '120 Hz', hz: 120, jitter: 0 },
  { name: '240 Hz', hz: 240, jitter: 0 },
  { name: '120 Hz with 2 ms of jitter', hz: 120, jitter: 2 },
];

// A fixed-seed LCG in [0, 1).
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** The tick snapshot and drawn holders, as createGame builds them. */
const holders = () => ({ prev: { x: 0, y: 0, fx: 0, fy: 0, visit: -1 }, drawn: { x: 0, y: 0, fx: 0, fy: 0 } });

/** Keeps the camera and feet before a tick in `prev`, as tick(g) does. */
function keep(prev, cam, sim, visit) {
  prev.x = cam.x; prev.y = cam.y; prev.fx = feetX(sim); prev.fy = feetY(sim); prev.visit = visit;
}

/**
 * The camera and feet a frame draws, as draw(g, t, alpha) picks them: the
 * blend at `alpha` where blendsTicks allows, else the latest camera and feet.
 */
function pick(h, screen, visit, cam, sim, alpha) {
  const fx = feetX(sim), fy = feetY(sim);
  if (blendsTicks(h.prev, screen, visit, fx, fy, alpha)) {
    blendTicks(h.drawn, h.prev, cam, fx, fy, alpha);
    return { cam: h.drawn, fx: h.drawn.fx, fy: h.drawn.fy, blended: true };
  }
  return { cam, fx, fy, blended: false };
}

/**
 * Runs display frames at `rate` on `display` until `ticks` ticks or more have run.
 * Tick k puts the feet by `place(sim, k)` and follows them with the camera.
 * Each frame places the transform at the camera it draws and calls
 * `frame(f, at, dt, k)`, `at` the drawn camera and feet and `dt` the frame's
 * interval in seconds.
 */
function driveFrames(display, rate, place, ticks, frame) {
  const sim = createSim(world, { board: bd, cell });
  const cam = { x: 0, y: 0 }, f = createFrame(), h = holders(), next = rng(29);
  place(sim, 0);
  snapCam(cam, sim);
  const guard = createGuard({ request: () => {}, screen: () => 'play', step: TICK, start: 0 });
  let k = 0, last = 0;
  // Twice the frames the ticks take, plus a margin: a guard that never ticks fails here rather than hang.
  const bound = Math.ceil(2 * ticks * TICK * rate.hz) + 60;
  for (let i = 1; k < ticks; i++) {
    assert.ok(i <= bound, `driveFrames stalled: ${k} of ${ticks} ticks after ${i - 1} frames at ${rate.name}`);
    const now = (i * 1000) / rate.hz + (next() * 2 - 1) * rate.jitter;
    guard.run(() => {}, now, (due) => {
      while (due()) {
        keep(h.prev, cam, sim, 1);
        place(sim, ++k);
        followCam(cam, sim);
      }
      const at = pick(h, 'play', 1, cam, sim, guard.fraction());
      placeFrame(f, at.cam, display.w, display.h, VIEW_W, VIEW_H);
      frame(f, at, (now - last) / 1000, k);
    });
    last = now;
  }
}

for (const rate of RATES) {
  for (const display of DISPLAYS) {
    for (const axis of AXES) {
      for (const v of SPEEDS) {
        const where = `at ${v} px a tick ${axis.name} on ${display.name} at ${rate.name}`;
        /** Each measured frame's world and back-wall point steps along the axis, its ideal, and the explorer's device position. */
        const measure = () => {
          const out = { world: [], wall: [], ideal: [], explorer: [] };
          let last = null;
          driveFrames(display, rate, (s, k) => axis.place(s, v * k), SETTLE + TICKS, (f, at, dt, k) => {
            const now = { world: worldPoint(f, nx, ny)[axis.k], wall: wallPoint(f, Math.floor(nx / 2), Math.floor(ny / 2))[axis.k] };
            if (k > SETTLE) {
              out.world.push(now.world - last.world);
              out.wall.push(now.wall - last.wall);
              out.ideal.push(v * (axis.k ? f.sy : f.sx) * 60 * dt);
              out.explorer.push([Math.round(deviceX(f, at.fx)), Math.round(deviceY(f, at.fy))]);
            }
            last = now;
          });
          return out;
        };

        test(`(e) even: ${where}, each frame steps a world point within 1 device px of the camera's travel over its interval, a back-wall point of half`, (t) => {
          const m = measure();
          const off = (steps, k) => steps.map((d, i) => Math.abs(d) - k * m.ideal[i]);
          const [w0, w1] = range(off(m.world, 1)), [b0, b1] = range(off(m.wall, 0.5));
          t.diagnostic(`world steps ${range(m.world.map(Math.abs))} device px against ${range(m.ideal).map((x) => x.toFixed(2))}, off by ${w0.toFixed(2)} to ${w1.toFixed(2)}; back wall off by ${b0.toFixed(2)} to ${b1.toFixed(2)}`);
          assert.ok(m.world.length >= TICKS, `${m.world.length} frames measured`);
          assert.ok(Math.max(-w0, w1) <= 1, `a world point's step strays ${w0.toFixed(2)} to ${w1.toFixed(2)} device px from the ideal`);
          assert.ok(Math.max(-b0, b1) <= 1, `a back-wall point's step strays ${b0.toFixed(2)} to ${b1.toFixed(2)} device px from half the ideal`);
        });

        test(`(f) monotonic: ${where}, no world or back-wall point steps backward`, () => {
          const m = measure();
          // The camera moves right or up, so the world moves left (x falls) or down (y rises) on the display.
          const sign = axis.k ? 1 : -1;
          for (const [key, steps] of [['world', m.world], ['wall', m.wall]]) {
            const back = steps.filter((d) => d * sign < 0);
            assert.deepEqual(back, [], `a ${key} point steps backward`);
          }
        });

        test(`(g) explorer: ${where}, the drawn explorer holds within 1 device px of its first settled position`, (t) => {
          const at = measure().explorer;
          const spread = [0, 1].map((i) => Math.max(...at.map((p) => Math.abs(p[i] - at[0][i]))));
          t.diagnostic(`spread ${spread[0]}, ${spread[1]} device px from ${at[0]}`);
          assert.ok(spread[0] <= 1 && spread[1] <= 1, `the explorer strays ${spread} device px from ${at[0]}`);
        });
      }
    }
  }
}

for (const rate of RATES) {
  for (const display of DISPLAYS) {
    for (const stop of STOPS) {
      test(`(h) with the feet at rest after a ${stop.name} on ${display.name} at ${rate.name}, each frame steps the world one way while the camera settles, then not at all`, (t) => {
        const MOVE = 120, REST = 600;
        const steps = [], ticks = [];
        let last = null;
        driveFrames(display, rate, (s, k) => stop.place(s, stop.v * Math.min(k, MOVE)), MOVE + REST, (f, at, dt, k) => {
          const now = worldPoint(f, nx, ny)[stop.k];
          if (k > MOVE) {
            steps.push(now - last);
            ticks.push(k);
          }
          last = now;
        });
        const moved = steps.map((d, i) => [d, ticks[i]]).filter(([d]) => d !== 0);
        const still = moved.length ? moved[moved.length - 1][1] - MOVE : 0;
        t.diagnostic(`the world last steps ${still} ticks after the stop; steps ${range(steps)} device px`);
        assert.ok(moved.length > 0, 'the world steps while the camera settles');
        assert.ok(moved.every(([d]) => Math.sign(d) === Math.sign(moved[0][0])), `the step reverses: ${moved.map(([d]) => d).join(' ')}`);
        assert.ok(still < REST - 60, `the world still steps ${still} ticks after the stop`);
      });
    }
  }
}

/** A snapshot and feet a tick apart in visit 3, on the floor at speed 1.6 with a camera behind. */
function f4() {
  const sim = createSim(world, { board: bd, cell });
  const cam = { x: 0, y: 0 }, h = holders();
  sim.off = 0;
  snapCam(cam, sim);
  keep(h.prev, cam, sim, 3);
  sim.off = 1.6;
  cam.x += 0.8;
  return { sim, cam, h };
}

test('(F4) a frame of the snapshot\'s own play visit blends', () => {
  const { sim, cam, h } = f4();
  const at = pick(h, 'play', 3, cam, sim, 0.25);
  assert.equal(at.blended, true);
  assert.ok(Math.abs(at.cam.x - (h.prev.x + 0.2)) < 1e-9 && Math.abs(at.fx - (h.prev.fx + 0.4)) < 1e-9, `drawn at ${at.cam.x}, ${at.fx}`);
  assert.equal(pick(h, 'play', 3, cam, sim, 0).blended, true, 'a frame at fraction 0 blends');
  assert.equal(pick(h, 'play', 3, cam, sim, 1).blended, false, 'a frame at fraction 1 draws the latest state itself');
});

test('(F4) a frame at a fraction of 1 or more, or below 0, draws the latest state', () => {
  const { sim, cam, h } = f4();
  for (const alpha of [1, 1.5, -0.25, -1e-9]) {
    const at = pick(h, 'play', 3, cam, sim, alpha);
    assert.ok(!at.blended && at.cam === cam && at.fx === feetX(sim) && at.fy === feetY(sim), `fraction ${alpha}`);
  }
});

test('(F4) a frame stamped before the guard\'s start draws the latest state', () => {
  const { sim, cam, h } = f4();
  const guard = createGuard({ request: () => {}, screen: () => 'play', step: TICK, start: 100 });
  guard.run(() => {}, 92, () => {});
  assert.ok(guard.fraction() < 0, `fraction ${guard.fraction()}`);
  const at = pick(h, 'play', 3, cam, sim, guard.fraction());
  assert.ok(!at.blended && at.cam === cam && at.fx === feetX(sim) && at.fy === feetY(sim));
});

test('(F4) a frame of a later visit draws the latest state', () => {
  const { sim, cam, h } = f4();
  for (const visit of [4, 5, 100]) {
    const at = pick(h, 'play', visit, cam, sim, 0.25);
    assert.ok(!at.blended && at.cam === cam && at.fx === feetX(sim) && at.fy === feetY(sim), `visit ${visit}`);
  }
});

test('(F4) a frame on any screen but play draws the latest state', () => {
  const { sim, cam, h } = f4();
  for (const screen of ['title', 'load', 'pick', 'savein', 'pause', 'over', 'splash']) {
    const at = pick(h, screen, 3, cam, sim, 0.25);
    assert.ok(!at.blended && at.cam === cam && at.fx === feetX(sim), screen);
  }
});

test('(F4) a frame after a feet move over CELL on either axis draws the latest state; CELL itself blends', () => {
  for (const [d, k, blends] of [[CELL + 0.01, 0, false], [-CELL - 0.01, 0, false], [CELL + 0.01, 1, false], [-CELL - 0.01, 1, false], [CELL, 0, true], [-CELL, 1, true]]) {
    const { sim, cam, h } = f4();
    // The snapshot's feet stand d px off the latest on axis k.
    if (k) h.prev.fy = feetY(sim) - d; else h.prev.fx = feetX(sim) - d;
    assert.equal(pick(h, 'play', 3, cam, sim, 0.5).blended, blends, `a move of ${d} px on ${'xy'[k]}`);
  }
});
