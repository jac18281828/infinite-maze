// The camera: where it follows the explorer, and how a frame maps the world to device pixels.
import { feetX, feetY } from './sim.mjs';

// Game px each layer spans past the view on every side, so its blit covers the
// view at any fraction of the camera.
export const LAYER_MARGIN = 2;

export function snapCam(cam, sim) {
  cam.x = feetX(sim);
  cam.y = feetY(sim) + 18;
}

// Lerp toward a target held inside a deadzone around the view centre.
export function followCam(cam, sim) {
  const tx = feetX(sim), ty = feetY(sim) + 18;
  let gx = cam.x, gy = cam.y;
  if (tx - cam.x > 20) gx = tx - 20; else if (cam.x - tx > 20) gx = tx + 20;
  if (ty - cam.y > 12) gy = ty - 12; else if (cam.y - ty > 12) gy = ty + 12;
  cam.x += (gx - cam.x) * 0.16;
  cam.y += (gy - cam.y) * 0.16;
}

/** A frame transform for `placeFrame` to fill. */
export function createFrame() {
  return { sx: 1, sy: 1, ox: 0, oy: 0, wx: 0, wy: 0, worldX: 0, worldY: 0, bx: 0, by: 0, wallX: 0, wallY: 0, w: 0, h: 0 };
}

/**
 * Fills `f` with the transform of a frame at camera `cam` on a display of
 * `dw` × `dh` device px showing `vw` × `vh` game px; allocates nothing. T
 * maps world (x, y), y up, to device (x·sx + ox, oy − y·sy), y down, with
 * sx = dw / vw, sy = dh / vh and the camera unrounded. The world layer
 * renders at the whole camera (wx, wy) = floor(cam) and the back wall at
 * (bx, by) = floor(cam / 2). Each layer spans the view and LAYER_MARGIN more
 * on every side, `w` × `h` device px, its top-left corner at (worldX, worldY)
 * or (wallX, wallY). The corners stay unrounded: the blit's nearest-neighbour
 * sampling rounds each layer pixel's edge once, to the device pixel nearest
 * its true position.
 */
export function placeFrame(f, cam, dw, dh, vw, vh) {
  const x = cam.x, y = cam.y;
  const sx = dw / vw, sy = dh / vh, mx = vw / 2 + LAYER_MARGIN, my = vh / 2 + LAYER_MARGIN;
  f.sx = sx;
  f.sy = sy;
  f.ox = dw / 2 - x * sx;
  f.oy = dh / 2 + y * sy;
  f.wx = Math.floor(x);
  f.wy = Math.floor(y);
  f.worldX = (f.wx - mx - x) * sx + dw / 2;
  f.worldY = (y - f.wy - my) * sy + dh / 2;
  // The back wall travels half as far as the camera.
  const hx = x / 2, hy = y / 2;
  f.bx = Math.floor(hx);
  f.by = Math.floor(hy);
  f.wallX = (f.bx - mx - hx) * sx + dw / 2;
  f.wallY = (hy - f.by - my) * sy + dh / 2;
  f.w = (vw + 2 * LAYER_MARGIN) * sx;
  f.h = (vh + 2 * LAYER_MARGIN) * sy;
}

/** Device x of world x in frame `f`, unrounded. */
export function deviceX(f, x) {
  return x * f.sx + f.ox;
}

/** Device y of world y in frame `f`, unrounded. */
export function deviceY(f, y) {
  return f.oy - y * f.sy;
}
