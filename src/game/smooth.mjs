// Frames between ticks: the loop's accumulator and the blend of the last two
// tick states. DOM-free, so tests drive the loop's own arithmetic.
import { TICK, feet } from './sim.mjs';

// Legitimate motion moves the feet at most 9 px a tick (SPEC section 6); a
// larger move is a placement, which draws without a blend.
export const SNAP_PX = 16;

/** Adds `dt` seconds, capped at 0.25, to `acc` and spends whole ticks. */
export function advance(acc, dt) {
  acc += Math.min(0.25, dt);
  let ticks = 0;
  while (acc >= TICK) { acc -= TICK; ticks++; }
  return { acc, ticks };
}

/** The explorer's feet and the camera centre, copied: `cam` mutates in place. */
export function snapshot(sim, cam) {
  const [x, y] = feet(sim);
  return { x, y, cx: cam.x, cy: cam.y };
}

/** `prev` to `cur` at `alpha` in [0, 1]; `cur` when `prev` is null or the feet jumped. */
export function blend(prev, cur, alpha) {
  if (!prev || Math.abs(cur.x - prev.x) > SNAP_PX || Math.abs(cur.y - prev.y) > SNAP_PX) return cur;
  if (alpha <= 0) return { ...prev };
  if (alpha >= 1) return { ...cur };
  const mix = (a, b) => a + (b - a) * alpha;
  return { x: mix(prev.x, cur.x), y: mix(prev.y, cur.y), cx: mix(prev.cx, cur.cx), cy: mix(prev.cy, cur.cy) };
}
