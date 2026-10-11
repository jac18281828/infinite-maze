// The tomb plane's flow: each tomb (u, v) leaves up, left or right, never
// down. Every side wall points one way, so two side neighbours never exit
// into each other, and with nothing leaving down no way on can loop.
// Directions match board directions: 0 right, 1 up, 2 left, 3 down. Exits
// never read the tomb size, so every difficulty shares one flow.
import { u32 } from './hash.mjs';

export const RIGHT = 0;
export const UP = 1;
export const LEFT = 2;
export const DOWN = 3;

/** Tomb offsets per direction. */
export const TDX = [1, 0, -1, 0];
export const TDY = [0, 1, 0, -1];

/** True when the wall between tombs (u, v) and (u + 1, v) points right. */
export function wallRight(H, u, v) {
  return H('flow', u, v)[0] < 128;
}

/**
 * Exit direction of tomb (u, v): up on r = 0 or with neither side open;
 * otherwise left on r = 1 and right on r = 2 when both sides are open, or
 * the one open side. `ignoreWalls` opens both sides, a broken world.
 */
export function exitDir(H, u, v, ignoreWalls = false) {
  const canR = ignoreWalls || wallRight(H, u, v);
  const canL = ignoreWalls || !wallRight(H, u - 1, v);
  const r = u32(H('exit', u, v)) % 3;
  if (r === 0 || (!canR && !canL)) return UP;
  if (canR && canL) return r === 1 ? LEFT : RIGHT;
  return canR ? RIGHT : LEFT;
}

/** Board column of the door between tombs (u, v) and (u, v + 1), for tombs of `size` boards. */
export function floorColumn(H, u, v, size) {
  return u32(H('tfloor', u, v)) % size.w;
}

/** Board row of the door between tombs (u, v) and (u + 1, v), for tombs of `size` boards. */
export function sideRow(H, u, v, size) {
  return u32(H('tside', u, v)) % size.h;
}

/**
 * The tomb plane's flow with memoized exits, for tombs of `size` boards.
 * `exit(u, v)` is the exit direction; `walls(u, v)` lists the tomb's wall
 * doors as { dir, i }, i the board index, the exit first, then the in-doors
 * in wall order floor, left, right. A broken world with `ignoreWalls` keys
 * each side door by the tomb that exits through it, so a pair exiting into
 * each other holds two doors.
 */
export function createFlow(H, size, { ignoreWalls = false } = {}) {
  const { w, h } = size;
  const exits = new Map();
  const key = (u, v) => `${u},${v}`;

  function exit(u, v) {
    const k = key(u, v);
    let d = exits.get(k);
    if (d === undefined) { d = exitDir(H, u, v, ignoreWalls); exits.set(k, d); }
    return d;
  }

  /** Board row of the side door tomb (u, v) exits through toward d. */
  function exitRow(u, v, d) {
    if (ignoreWalls) return sideRow(H, u, v, size);
    return sideRow(H, d === RIGHT ? u : u - 1, v, size);
  }

  /** Board index, within tomb (u, v), of the door it exits through. */
  function exitIndex(u, v) {
    const d = exit(u, v);
    if (d === UP) return (h - 1) * w + floorColumn(H, u, v, size);
    const row = exitRow(u, v, d);
    return row * w + (d === RIGHT ? w - 1 : 0);
  }

  function walls(u, v) {
    const out = [{ dir: exit(u, v), i: exitIndex(u, v) }];
    if (exit(u, v - 1) === UP) out.push({ dir: DOWN, i: floorColumn(H, u, v - 1, size) });
    if (exit(u - 1, v) === RIGHT) out.push({ dir: LEFT, i: exitRow(u - 1, v, RIGHT) * w });
    if (exit(u + 1, v) === LEFT) out.push({ dir: RIGHT, i: exitRow(u + 1, v, LEFT) * w + w - 1 });
    return out;
  }

  /** Forgets exits more than `reach` tombs from (u, v) in either axis. */
  function retain(u, v, reach) {
    for (const k of exits.keys()) {
      const [a, b] = k.split(',').map(Number);
      if (Math.abs(a - u) > reach || Math.abs(b - v) > reach) exits.delete(k);
    }
  }

  return { exit, walls, retain };
}
