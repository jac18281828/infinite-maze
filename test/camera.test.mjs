import v8 from 'node:v8';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW } from '../src/world/board.mjs';
import { createSim, feetX, feetY } from '../src/game/sim.mjs';
import { snapCam, followCam, createFrame, placeFrame, deviceX, deviceY } from '../src/game/camera.mjs';

const world = createWorld('00000000');
const mid = (m, c) => m && c % BW === 6 && ((c / BW) | 0) === 3;
const bd = (() => {
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (world.board(x, y).links?.some(mid)) return world.board(x, y);
  throw new Error('no tree board');
})();
const cell = bd.links.findIndex(mid);

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

test('the frame\'s camera step allocates under 32 bytes a call', (t) => {
  const { sim, cam } = steady();
  // The iPad's display, at a fractional camera.
  cam.x += 0.37;
  cam.y -= 0.61;
  const f = createFrame();
  const place = bytesPerCall(() => placeFrame(f, cam, 2752, 1548, 320, 180));
  const fx = feetX(sim), fy = feetY(sim);
  // A typed sink: a double stored in a closure variable boxes on every call.
  const sink = new Float64Array(1);
  const map = bytesPerCall(() => { sink[0] += deviceX(f, fx) + deviceY(f, fy); });
  assert.ok(sink[0] !== 0 && f.sx === 8.6);
  t.diagnostic(`placeFrame ${place} bytes a call, deviceX and deviceY ${map}`);
  assert.ok(place < 32, `placeFrame: ${place} bytes a call`);
  assert.ok(map < 32, `deviceX and deviceY: ${map} bytes a call`);
});

test('followCam allocates under 32 bytes a call', (t) => {
  const { sim, cam } = steady();
  const per = bytesPerCall(() => followCam(cam, sim));
  t.diagnostic(`${per} bytes a call`);
  assert.ok(per < 32, `${per} bytes a call`);
});
