// The camera: where it follows the explorer and which whole-pixel camera a frame draws at.
import { feetX, feetY } from './sim.mjs';

export function snapCam(cam, sim) {
  cam.x = feetX(sim);
  cam.y = feetY(sim) + 18;
}

/**
 * The whole-pixel camera `[cx, cy]` a frame draws at. With the explorer at
 * feet `at` the offset from the camera rounds once, so the sprite stands
 * round(at[0] - cam.x) right of the view centre and round(cam.y - at[1]) below
 * it, on the world column round(at[0]) and row -round(-at[1]). A whole camera
 * comes back unchanged.
 * With no explorer the camera rounds as is.
 */
export function pixelCam(cam, at) {
  if (!at) return [Math.round(cam.x), Math.round(cam.y)];
  return [
    Math.round(at[0]) - Math.round(at[0] - cam.x),
    Math.round(cam.y - at[1]) - Math.round(-at[1]),
  ];
}

/** `pixelCam`'s x for the explorer `sim` (none: the camera as is); allocates nothing. */
export function pixelCamX(cam, sim) {
  if (!sim) return Math.round(cam.x);
  const x = feetX(sim);
  return Math.round(x) - Math.round(x - cam.x);
}

/** `pixelCam`'s y for the explorer `sim` (none: the camera as is); allocates nothing. */
export function pixelCamY(cam, sim) {
  if (!sim) return Math.round(cam.y);
  const y = feetY(sim);
  return Math.round(cam.y - y) - Math.round(-y);
}

// Lerp toward a target held inside a deadzone around the view centre. An axis the
// deadzone holds stores its whole-pixel camera, so the world stands still.
export function followCam(cam, sim) {
  const tx = feetX(sim), ty = feetY(sim) + 18;
  let gx = cam.x, gy = cam.y;
  if (tx - cam.x > 20) gx = tx - 20; else if (cam.x - tx > 20) gx = tx + 20;
  if (ty - cam.y > 12) gy = ty - 12; else if (cam.y - ty > 12) gy = ty + 12;
  const px = pixelCamX(cam, sim), py = pixelCamY(cam, sim);
  if (gx === cam.x) cam.x = px; else cam.x += (gx - cam.x) * 0.16;
  if (gy === cam.y) cam.y = py; else cam.y += (gy - cam.y) * 0.16;
}
