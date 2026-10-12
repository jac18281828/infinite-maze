// The board-crossing hitch: board art shades fast and byte for byte, the
// world warms ahead of the camera, and a frame allocates little.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorld, boardCoords } from '../src/world/world.mjs';
import { boardMask } from '../src/game/mask.mjs';
import { fixtureSets } from '../src/game/fixtures.mjs';
import { createRenderer } from '../src/game/render.mjs';
import { RGB, idx, ROCK } from '../src/game/art.mjs';
import { BOARD_W, BOARD_H } from '../src/game/sim.mjs';

const CODE = '00000000';
const LEVELS = ['easy', 'medium', 'hard', 'ultimate'];

// BASE's board shading, kept verbatim as the oracle for byte identity and the
// yardstick for speed. A deliberate change to rock shading updates this copy
// and REFERENCE_DIGEST.
function hash3(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function referenceShade(mask, p, stairs, ledge) {
  const W = BOARD_W, H = BOARD_H;
  const d = new Uint8ClampedArray(W * H * 4);
  const at = (x, y) => Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x));
  const solid = (x, y) => mask[at(x, y)];
  const filled = stairs ? (x, y) => mask[at(x, y)] || stairs[at(x, y)] || ledge[at(x, y)] : solid;
  const [ar, ag, ab] = RGB[0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (filled(x, y)) {
        const tile = ROCK[hash3(x >> 4, y >> 4, p) % ROCK.length];
        let ch = tile[y & 15][x & 15];
        if (!filled(x, y - 1)) ch = 'b';
        else if (!filled(x, y - 2)) ch = 'a';
        else if (!filled(x, y + 1)) ch = '6';
        else if (!filled(x, y + 2)) ch = '7';
        else if (!filled(x - 1, y) || !filled(x + 1, y)) ch = '8';
        const k = idx(ch);
        d[o] = RGB[k][0]; d[o + 1] = RGB[k][1]; d[o + 2] = RGB[k][2]; d[o + 3] = 255;
      } else {
        let a = 0;
        if (solid(x, y - 1)) a = 150; else if (solid(x, y - 2)) a = 95; else if (solid(x, y - 3)) a = 50;
        if (solid(x - 1, y) || solid(x + 1, y)) a = Math.max(a, 80);
        else if (solid(x - 2, y) || solid(x + 2, y)) a = Math.max(a, 40);
        d[o] = ar; d[o + 1] = ag; d[o + 2] = ab; d[o + 3] = a;
      }
    }
  }
  return d;
}

// The sha3-256 of the sample's pixels as BASE's renderer shades them: the
// tree boards of MEDIUM, then of ULTIMATE, in tomb order, then the rock board.
const REFERENCE_DIGEST = '4f0fd8d3846b657ae9d8ae0115bda475b1823872e5001ae6e74b83ca78252517';

/** Runs `body` with `document.createElement` making `make()` canvases; restores the global. */
function withDocument(make, body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { createElement: make };
  try {
    return body();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete globalThis.document;
  }
}

// Board shadings put so far, one per art build.
let shades = 0;

/** A canvas that does no pixel work; with `copy` it keeps the last `putImageData` pixels on `canvas.shaded`. */
function nullCanvas(copy = false) {
  const canvas = { width: 0, height: 0, shaded: null };
  const ctx = {
    canvas, fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    save() {}, restore() {}, fillRect() {}, drawImage() {},
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img) {
      shades++;
      if (copy) canvas.shaded = Uint8ClampedArray.from(img.data);
    },
  };
  canvas.getContext = () => ctx;
  return canvas;
}

/** Tree boards of tombs u -1..1, v 0..2 at `difficulty`, with their masks and fixture sets. */
function sampleBoards(world) {
  const out = [];
  for (let v = 0; v <= 2; v++) {
    for (let u = -1; u <= 1; u++) {
      for (let i = 0; i < world.size.w * world.size.h; i++) {
        const { x, y } = boardCoords(u, v, i, world.size);
        const bd = world.board(x, y);
        if (!bd.links) continue;
        const mask = boardMask(bd);
        const fx = fixtureSets(bd, mask);
        out.push({ bd, mask, stairs: fx.stairs, ledge: fx.ledge });
      }
    }
  }
  return out;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const centre = (bd) => ({ x: bd.x * BOARD_W + BOARD_W / 2, y: bd.y * BOARD_H + BOARD_H / 2 });

test('board art equals the reference shading byte for byte over the sample', () => {
  const made = [];
  const make = () => { const c = nullCanvas(true); made.push(c); return c; };
  const hash = createHash('sha3-256');
  let boards = 0;
  withDocument(make, () => {
    for (const difficulty of ['medium', 'ultimate']) {
      const world = createWorld(CODE, { difficulty });
      const view = nullCanvas();
      const draws = [];
      view.getContext().drawImage = (src) => draws.push(src);
      const renderer = createRenderer(view, world);
      for (const { bd, mask, stairs, ledge } of sampleBoards(world)) {
        draws.length = 0;
        renderer.scene(null, centre(bd), 0);
        const art = draws.find((c) => c.width === BOARD_W && c.height === BOARD_H);
        const want = referenceShade(mask, bd.p, stairs, ledge);
        assert.ok(Buffer.from(art.shaded).equals(Buffer.from(want)), `board ${bd.x},${bd.y} at ${difficulty}`);
        hash.update(want);
        boards++;
      }
    }
    const rock = made.find((c) => c.shaded && c.width === BOARD_W);
    const want = referenceShade(boardMask(null), 0, null, null);
    assert.ok(Buffer.from(rock.shaded).equals(Buffer.from(want)), 'rock board');
    hash.update(want);
  });
  assert.equal(boards, 296);
  assert.equal(hash.digest('hex'), REFERENCE_DIGEST);
});

test('a board-art build takes at most a quarter of the reference shading time', () => {
  const view = nullCanvas();
  const builds = [], reference = [];
  const timed = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
  withDocument(() => nullCanvas(), () => {
    for (const difficulty of ['medium', 'ultimate']) {
      const world = createWorld(CODE, { difficulty });
      const sample = sampleBoards(world);
      for (const pass of [0, 1]) {
        const renderer = createRenderer(view, world);
        for (const { bd, mask, stairs, ledge } of sample) {
          if (pass === 1) reference.push(timed(() => referenceShade(mask, bd.p, stairs, ledge)));
          // Each prepare builds at most one board's art; a build shows as one shade.
          for (;;) {
            const before = shades;
            const ms = timed(() => renderer.prepare(centre(bd)));
            if (shades === before) break;
            if (pass === 1) builds.push(ms);
          }
        }
      }
    }
  });
  assert.ok(builds.length > 296, `${builds.length} builds`);
  const art = median(builds), ref = median(reference);
  assert.ok(art <= ref / 4, `art build ${art.toFixed(2)} ms against reference ${ref.toFixed(2)} ms`);
});
