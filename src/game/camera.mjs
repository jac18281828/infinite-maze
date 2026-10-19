// The camera follow, DOM-free so tests drive the real one.
import { feet } from './sim.mjs';

export function snapCam(cam, sim) {
  const [x, y] = feet(sim);
  cam.x = x;
  cam.y = y + 18;
}

// Lerp toward a target held inside a deadzone around the view centre.
export function followCam(cam, sim) {
  const [x, y] = feet(sim);
  const tx = x, ty = y + 18;
  let gx = cam.x, gy = cam.y;
  if (tx - cam.x > 20) gx = tx - 20; else if (cam.x - tx > 20) gx = tx + 20;
  if (ty - cam.y > 12) gy = ty - 12; else if (cam.y - ty > 12) gy = ty + 12;
  cam.x += (gx - cam.x) * 0.16;
  cam.y += (gy - cam.y) * 0.16;
}
