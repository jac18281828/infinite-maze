import v8 from 'node:v8';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW } from '../src/world/board.mjs';
import { createSim, feetX, feetY } from '../src/game/sim.mjs';
import {
  snapCam, followCam, createFrame, placeFrame, deviceX, deviceY, deviceSpan, blendTicks, blendsTicks,
} from '../src/game/camera.mjs';

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
  // A fractional 8.6x display, at a fractional camera.
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

test('the blend between ticks and its choice allocate under 32 bytes a call', (t) => {
  const { sim, cam } = steady();
  // The holders createGame builds once, a fractional camera and feet a tick apart.
  const prev = { x: cam.x - 1.6, y: cam.y - 0.4, fx: feetX(sim) - 1.6, fy: feetY(sim), visit: 2 };
  const drawn = { x: 0, y: 0, fx: 0, fy: 0 };
  const fx = feetX(sim), fy = feetY(sim);
  const alpha = new Float64Array(1);
  const blend = bytesPerCall(() => { blendTicks(drawn, prev, cam, fx, fy, alpha[0] = (alpha[0] + 0.37) % 1); });
  const sink = new Int32Array(1);
  const choice = bytesPerCall(() => { sink[0] += blendsTicks(prev, 'play', 2, fx, fy, alpha[0]) ? 1 : 0; });
  assert.ok(sink[0] > 0 && drawn.x !== 0);
  t.diagnostic(`blendTicks ${blend} bytes a call, blendsTicks ${choice}`);
  assert.ok(blend < 32, `blendTicks: ${blend} bytes a call`);
  assert.ok(choice < 32, `blendsTicks: ${choice} bytes a call`);
});

// Each edge lands on round(edge): a span is round(a + len) - round(a) device px.
test('deviceSpan rounds each edge once: 8.6 or 9 px for a game px at 8.6x, always 8 at 8x', () => {
  // [a, len, device px], worked by hand: 0.3 + 8.6 = 8.9 rounds to 9 over 0; 0.6 + 8.6 = 9.2 rounds to 9 over 1.
  const at86 = [
    [0.3, 8.6, 9], [0.6, 8.6, 8], [3.2, 8.6, 9], [7.6, 8.6, 8], [10.1, 8.6, 9], [100.45, 8.6, 9], [-3.6, 8.6, 9],
    [0.3, 137.6, 138], [0.6, 137.6, 137],
  ];
  const at8 = [[0.3, 8, 8], [0.6, 8, 8], [123.7, 8, 8], [-3.6, 8, 8], [0.3, 128, 128], [0.6, 128, 128]];
  for (const [a, len, want] of [...at86, ...at8]) assert.equal(deviceSpan(a, len), want, `${len} px from ${a}`);
  // Abutting spans meet, so they tile without a gap or an overlap.
  assert.equal(deviceSpan(0.6, 8.6) + deviceSpan(0.6 + 8.6, 8.6), deviceSpan(0.6, 17.2));
});

test('deviceSpan allocates under 32 bytes a call', (t) => {
  const sink = new Float64Array(1);
  let a = 0.3;
  const per = bytesPerCall(() => { a += 0.37; sink[0] += deviceSpan(a, 8.6); });
  assert.ok(sink[0] > 0);
  t.diagnostic(`${per} bytes a call`);
  assert.ok(per < 32, `${per} bytes a call`);
});
