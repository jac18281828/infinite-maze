// Sconce and brazier light is continuous across a board seam (spec sections 8 and 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../src/game/render.mjs';
import { fixtureSets } from '../src/game/fixtures.mjs';
import { nodeXY, BOARD_W, BOARD_H } from '../src/game/sim.mjs';
import { createFrame, placeFrame, LAYER_MARGIN } from '../src/game/camera.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { worlds, sample } from './sample.mjs';

const T = 1.3;
// The light map covers the world layer, the view and LAYER_MARGIN more on every side, at a quarter of its resolution.
const LIGHT_W = (320 + 2 * LAYER_MARGIN) / 4, LIGHT_H = (180 + 2 * LAYER_MARGIN) / 4;
// A light centre this near a seam counts as beside it.
const NEAR = 40;
// A brazier's light centre sits 14 px above its art point, a sconce's 2 px.
const LIFT = { sconce: 2, brazier: 14 };
const SIDES = ['above', 'below', 'left', 'right'];
const KINDS = ['brazier', 'sconce'];

/** Runs `body` with a document whose canvases do no pixel work; restores the global. */
function withDocument(body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const made = [];
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, shaded: null };
      const ctx = {
        canvas, fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
        save() {}, restore() {}, drawImage() {}, fillRect() {}, clearRect() {},
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(img) { if (img.width === LIGHT_W) canvas.shaded = Uint8ClampedArray.from(img.data); },
      };
      canvas.getContext = () => ctx;
      made.push(canvas);
      return canvas;
    },
  };
  try {
    return body(made);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete globalThis.document;
  }
}

/** A renderer over `world` and a function giving the light map of the scene at `cam` with no explorer. */
function lightRig(world, made) {
  const view = document.createElement('canvas');
  view.width = 320;
  view.height = 180;
  const display = document.createElement('canvas');
  display.width = 1280;
  display.height = 720;
  const renderer = createRenderer(view, world, display);
  const light = made.find((c) => c.width === LIGHT_W && c.height === LIGHT_H);
  return (cam) => {
    renderer.scene(null, cam, T);
    return light.shaded;
  };
}

/** Whether board `bd` lies in the window `drawBoards` draws at `cam`: the world layer's, at the frame's whole camera. */
function inView(bd, cam) {
  const f = createFrame();
  placeFrame(f, cam, 1280, 720, 320, 180);
  const hw = 160 + LAYER_MARGIN, hh = 90 + LAYER_MARGIN;
  return bd.x >= Math.floor((f.wx - hw) / BOARD_W) && bd.x <= Math.floor((f.wx + hw) / BOARD_W)
    && bd.y >= Math.floor((f.wy - hh) / BOARD_H) && bd.y <= Math.floor((f.wy + hh) / BOARD_H);
}

/** Each kind and side's first source on the tree boards of `sample(d, 3)` whose light centre lies within NEAR of the seam facing the view. */
function findCases(d) {
  const world = worlds[d], found = new Map();
  for (const bd of sample(d, 3)) {
    if (!bd.links) continue;
    const spots = {
      sconce: fixtureSets(bd).sconces,
      brazier: world.flamesAt(bd.x, bd.y).map((cell) => nodeXY({ x: 0, y: 0 }, cell)),
    };
    for (const kind of KINDS) {
      for (const [x, y0] of spots[kind]) {
        const y = y0 + LIFT[kind];
        const near = { above: y <= NEAR, below: BOARD_H - y <= NEAR, left: BOARD_W - x <= NEAR, right: x <= NEAR };
        for (const side of SIDES) {
          const key = `${kind} ${side}`;
          if (near[side] && !found.has(key)) found.set(key, { bd, kind, side, x, y });
        }
      }
    }
  }
  return found;
}

/** The camera pair, in view then out of view, 4 px apart across the seam of `c`, the other axis at the source. */
function cameras({ bd, side, x, y }) {
  const wx = bd.x * BOARD_W + x, wy = bd.y * BOARD_H + y;
  switch (side) {
    case 'above': return [{ x: wx, y: bd.y * BOARD_H - 90 }, { x: wx, y: bd.y * BOARD_H - 94 }];
    case 'below': return [{ x: wx, y: (bd.y + 1) * BOARD_H + 89 }, { x: wx, y: (bd.y + 1) * BOARD_H + 93 }];
    case 'left': return [{ x: (bd.x + 1) * BOARD_W + 159, y: wy }, { x: (bd.x + 1) * BOARD_W + 163, y: wy }];
    default: return [{ x: bd.x * BOARD_W - 160, y: wy }, { x: bd.x * BOARD_W - 164, y: wy }];
  }
}

/** The largest channel difference between light maps `a` and `b` of cameras `ca` and `cb` over the texels both show, after the shift. */
function seamDiff(a, b, ca, cb) {
  const dx = (ca.x - cb.x) / 4, dy = (cb.y - ca.y) / 4;
  let worst = 0, shared = 0;
  for (let ly = 0; ly < LIGHT_H; ly++) {
    for (let lx = 0; lx < LIGHT_W; lx++) {
      const mx = lx + dx, my = ly + dy;
      if (mx < 0 || mx >= LIGHT_W || my < 0 || my >= LIGHT_H) continue;
      shared++;
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[(ly * LIGHT_W + lx) * 4 + k] - b[(my * LIGHT_W + mx) * 4 + k]));
    }
  }
  assert.ok(shared > 0.9 * LIGHT_W * LIGHT_H, `${shared} texels shared`);
  return worst;
}

for (const d of DIFFICULTIES) {
  test(`light crosses every board seam at ${d}`, async (t) => {
    const found = findCases(d);
    for (const kind of KINDS) for (const side of SIDES) assert.ok(found.has(`${kind} ${side}`), `a ${kind} ${side} case exists`);
    for (const c of found.values()) {
      await t.test(`${c.kind} ${c.side} of board ${c.bd.x},${c.bd.y} at ${c.x},${c.y}`, (st) => {
        const [camIn, camOut] = cameras(c);
        assert.ok(inView(c.bd, camIn) && !inView(c.bd, camOut), 'the board is in view at one camera only');
        const diff = withDocument((made) => {
          const lightAt = lightRig(worlds[d], made);
          const mapIn = Uint8ClampedArray.from(lightAt(camIn));
          return seamDiff(mapIn, lightAt(camOut), camIn, camOut);
        });
        st.diagnostic(`largest channel difference ${diff}`);
        assert.ok(diff <= 1, `channel difference ${diff}`);
      });
    }
  });
}

test('the light at a camera ignores which boards were rendered before', () => {
  const c = findCases('medium').get('brazier above');
  assert.ok(c, 'a brazier case exists');
  const [camIn, camOut] = cameras(c);
  const fresh = withDocument((made) => Uint8ClampedArray.from(lightRig(worlds.medium, made)(camOut)));
  const warm = withDocument((made) => {
    const lightAt = lightRig(worlds.medium, made);
    lightAt(camIn);
    return Uint8ClampedArray.from(lightAt(camOut));
  });
  let worst = 0;
  for (let i = 0; i < fresh.length; i++) worst = Math.max(worst, Math.abs(fresh[i] - warm[i]));
  assert.ok(worst <= 1, `channel difference ${worst}`);
});
