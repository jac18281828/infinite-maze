import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords } from '../src/world/world.mjs';
import { BW, NCELL } from '../src/world/board.mjs';
import { boardMask, MASK_W, MASK_H } from '../src/game/mask.mjs';
import { createSim, nodeXY } from '../src/game/sim.mjs';
import { RGB, idx, SIGNS, SCONCE_FLAME, COIN } from '../src/game/art.mjs';
import { floorItems, itemSpot } from '../src/world/floor.mjs';
import {
  fixtureSets, ladderPixels, sconcePixels, signPixels, signSpot, dustMotes, maskRow, ROLE, SWAY_X, SWAY_Y,
} from '../src/game/fixtures.mjs';
import { junctions, signs, signSide } from '../src/world/signs.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { createRenderer, spriteCanvas } from '../src/game/render.mjs';

const world = createWorld('00000000');
const NE = 16, NW = 32;

/** Tree boards of tombs (0, 0)..(0, 9) with their masks and fixture sets. */
const boards = [];
for (let v = 0; v < 10; v++) {
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(0, v, i, world.size);
    const bd = world.board(x, y);
    if (!bd.links) continue;
    const mask = boardMask(bd);
    boards.push({ bd, mask, fx: fixtureSets(bd, mask) });
  }
}
const px = (x, y) => maskRow(y) * MASK_W + x;
const cellXY = (c) => [(c % BW) * 48, ((c / BW) | 0) * 48];
const flights = boards.flatMap(({ bd, mask, fx }) => fx.flights.map((f) => ({ bd, mask, fx, ...f })));
// The rows of column t of a flight, from the spec: tread down to above the support.
const treadOf = (Y, t) => Y + 11 + 4 * (t >> 2);
const supportOf = (Y, t) => (t < 16 ? Y + 7 : Y + 8 + t);
const colX = (X, t, dir) => (dir > 0 ? X + 24 + t : X + 23 - t);

test('the sample holds the stairs the diagnosis counted', () => {
  assert.equal(flights.length, 1183);
});

test('every stair pixel is mask air, at row Y+8 or above, inside its 48 columns and outside the side room', () => {
  for (const { bd, mask, fx, X, Y, dir, runs } of flights) {
    assert.equal(runs.length > 0, true);
    for (const { t, x, top, bot } of runs) {
      assert.equal(x, colX(X, t, dir), 'inside its columns');
      assert.ok(bot >= Y + 8, 'no row under the room floor');
      // The side room lies under the gallery's rock from column 32 on.
      if (t >= 32) assert.ok(bot > Y + 40, `board ${bd.p}: column ${t} reaches into the side room`);
      for (let y = bot; y <= top; y++) assert.equal(mask[px(x, y)], 0, `board ${bd.p}: column ${t} row ${y} is rock`);
    }
  }
  // The role map holds those pixels and no others.
  for (const { fx } of boards) {
    const want = new Set(fx.flights.flatMap(({ runs }) => runs.flatMap(({ x, top, bot }) => Array.from({ length: top - bot + 1 }, (_, i) => px(x, bot + i)))));
    let n = 0;
    for (let k = 0; k < fx.stairs.length; k++) if (fx.stairs[k]) { n++; assert.ok(want.has(k)); }
    assert.equal(n, want.size);
  }
});

test('every stair column is contiguous from its tread down to the row above its support', () => {
  for (const { fx, X, Y, dir } of flights) {
    for (let t = 0; t < 48; t++) {
      const x = colX(X, t, dir), top = treadOf(Y, t), sup = supportOf(Y, t);
      const want = [];
      for (let y = sup + 1; y <= top; y++) want.push(y);
      const got = [];
      for (let y = Y + 8; y <= Y + 60; y++) if (fx.stairs[px(x, y)]) got.push(y);
      // Each pixel's ROLE label: a tread on top, a riser face in a step's first column, else body.
      for (const y of want) {
        assert.equal(fx.stairs[px(x, y)], y === top ? ROLE.tread : t % 4 === 0 ? ROLE.riser : ROLE.body, `label at column ${t} row ${y - Y}`);
      }
      assert.deepEqual(got, want, `column ${t} of the flight at (${X}, ${Y}) dir ${dir}`);
    }
  }
});

test('the first tread sits 4 px over the floor and the last is flush with the upper floor', () => {
  for (const { fx, X, Y, dir } of flights) {
    const c0 = colX(X, 0, dir), c47 = colX(X, 47, dir);
    let top0 = -1;
    for (let y = Y + 8; y <= Y + 60; y++) if (fx.stairs[px(c0, y)]) top0 = y;
    assert.equal(top0 - (Y + 7), 4);
    assert.equal(fx.stairs[px(c0, top0)], ROLE.tread);
    // The rock edge carries the last tread: column 46 ends at Y+55 and column 47 holds no stair pixel.
    let top46 = -1;
    for (let y = Y + 8; y <= Y + 60; y++) if (fx.stairs[px(colX(X, 44, dir), y)]) top46 = y;
    assert.equal(top46, Y + 55);
    for (let y = Y + 8; y <= Y + 60; y++) assert.equal(fx.stairs[px(c47, y)], 0);
    assert.equal(treadOf(Y, 47), Y + 55);
  }
});

test('a stair leaves rock the mask holds bare, whatever the flight would cover', () => {
  const { bd, mask, fx } = boards.find(({ fx }) => fx.flights.length > 0);
  const { X, Y, dir } = fx.flights[0];
  const punched = mask.slice();
  for (const [t, y] of [[2, Y + 9], [20, Y + 30]]) punched[px(colX(X, t, dir), y)] = 1;
  const out = fixtureSets(bd, punched).stairs;
  for (const [t, y] of [[2, Y + 9], [20, Y + 30]]) {
    const x = colX(X, t, dir);
    assert.equal(out[px(x, y)], 0, 'the rock stays bare');
    assert.ok(out[px(x, y + 1)] && out[px(x, y - 1)] && fx.stairs[px(x, y)], 'its neighbours keep the stair');
  }
});

/** Board-pixel index sets of the ladder and sconce sprites. */
function spriteSets(fx) {
  const ladders = new Set(), sconces = new Set();
  for (const box of fx.ladders) for (const [x, y] of ladderPixels(box)) ladders.add(px(x, y));
  for (const s of fx.sconces) for (const [x, y] of sconcePixels(s)) sconces.add(px(x, y));
  return { ladders, sconces };
}

test('no stair pixel lies on a ladder or sconce pixel, and the sample holds both overlaps the fix serves', () => {
  let overLadder = 0, overDoorSconce = 0;
  for (const { bd, fx } of boards) {
    const { ladders, sconces } = spriteSets(fx);
    // The ladder boxes are clear too, not only their opaque pixels.
    const boxed = new Set();
    for (const [x, y0, y1] of fx.ladders) for (let y = y0; y < y1; y++) for (let i = 0; i < 16; i++) boxed.add(px(x + i, y));
    for (let k = 0; k < fx.stairs.length; k++) {
      if (!fx.stairs[k]) continue;
      assert.ok(!ladders.has(k) && !boxed.has(k) && !sconces.has(k), `board ${bd.p} pixel ${k}`);
    }
    for (const f of fx.flights) {
      const below = f.c - BW;
      if ((below >= 0 && bd.links[below] & 2) || bd.doorMask[f.c] & 8) overLadder++;
      if (bd.doorMask[f.c] & 8) overDoorSconce++;
    }
  }
  assert.ok(overLadder >= 1 && overDoorSconce >= 1, 'stairs over a ladder and over a bottom door');
  // A bottom door and a north-east stair whose sconce would sit at X+36.
  assert.ok(flights.some(({ bd, c, dir }) => dir > 0 && bd.doorMask[c] & 8 && !(bd.doorMask[c] & 5)));
});

test('each ladder box matches L1, or L2 where it reaches a stair cell, and each door sconce sits at its L3 centre', () => {
  let cut = 0, moved = 0;
  for (const { bd, fx } of boards) {
    const wantL = [], wantS = [];
    const stairCell = (c) => c >= 0 && c < NCELL && (bd.links[c] & (NE | NW)) !== 0;
    for (let c = 0; c < NCELL; c++) {
      const [X, Y] = cellXY(c);
      const m = bd.links[c], doors = bd.doorMask[c];
      if (m & 2) wantL.push([X + 16, Y + 8, stairCell(c + BW) ? (cut++, Y + 56) : Y + 64]);
      if (doors & 2) wantL.push([X + 16, Y + 8, Y + 48]);
      if (doors & 8) wantL.push([X + 16, Y, stairCell(c) ? (cut++, Y + 8) : Y + 14]);
      if (doors) {
        const x = doors & 4 ? X + 13 : doors & 1 ? X + 35 : doors & 8 && m & NE ? (moved++, X + 12) : X + 36;
        wantS.push([x, Y + 26]);
      }
    }
    assert.deepEqual(fx.ladders, wantL);
    assert.deepEqual(fx.sconces, wantS);
  }
  assert.ok(cut > 100 && moved > 0, 'the sample holds cut ladders and a moved sconce');
});

// A 2D canvas stub: pixel buffers with source-over drawing, enough for the
// renderer to build and draw a scene. Each canvas keeps the last putImageData
// as `shaded` and flags the pixels drawn after it in `touched`.
function stubCanvas() {
  const canvas = { w: 0, h: 0, data: null, shaded: null, touched: null, fills: [], draws: [] };
  const size = () => { canvas.data = new Uint8ClampedArray(canvas.w * canvas.h * 4); canvas.touched = new Uint8Array(canvas.w * canvas.h); };
  Object.defineProperties(canvas, {
    width: { get: () => canvas.w, set: (v) => { canvas.w = v; size(); } },
    height: { get: () => canvas.h, set: (v) => { canvas.h = v; size(); } },
  });
  const over = (i, r, g, b, a) => {
    const d = canvas.data, k = a / 255, o = d[i + 3] / 255, out = k + o * (1 - k);
    [r, g, b].forEach((v, j) => { d[i + j] = out ? (v * k + d[i + j] * o * (1 - k)) / out : 0; });
    d[i + 3] = out * 255;
    canvas.touched[i >> 2] = 1;
  };
  const colour = (s) => {
    if (s[0] === '#') return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(255);
    const m = s.match(/rgba?\(([^)]*)\)/)[1].split(',').map(Number);
    return [m[0], m[1], m[2], m.length > 3 ? m[3] * 255 : 255];
  };
  const ctx = {
    canvas,
    fillStyle: '#000',
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    save() {}, restore() {},
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img) {
      canvas.data.set(img.data);
      canvas.shaded = Uint8ClampedArray.from(img.data);
      canvas.touched.fill(0);
    },
    fillRect(x, y, w, h) {
      canvas.fills.push([x, y, w, h, ctx.fillStyle]);
      const [r, g, b, a] = colour(ctx.fillStyle);
      for (let yy = Math.max(0, y); yy < Math.min(canvas.h, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(canvas.w, x + w); xx++) over((yy * canvas.w + xx) * 4, r, g, b, a);
      }
    },
    drawImage(src, ...a) {
      canvas.draws.push([src, ...a]);
      if (ctx.globalCompositeOperation !== 'source-over') return;
      const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, src.width, src.height, a[0], a[1], src.width, src.height]
        : a.length === 4 ? [0, 0, src.width, src.height, ...a] : a;
      for (let j = 0; j < dh; j++) {
        for (let i = 0; i < dw; i++) {
          const x = dx + i, y = dy + j;
          if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) continue;
          const s = ((sy + Math.floor((j * sh) / dh)) * src.width + sx + Math.floor((i * sw) / dw)) * 4;
          if (src.data[s + 3]) over((y * canvas.w + x) * 4, src.data[s], src.data[s + 1], src.data[s + 2], src.data[s + 3]);
        }
      }
    },
  };
  canvas.getContext = () => ctx;
  return canvas;
}

globalThis.document = { createElement: () => stubCanvas() };
const view = document.createElement('canvas');
view.width = 320;
view.height = 180;
const renderer = createRenderer(view, world);

/** Draws `bd` centred in the view; returns the board's art canvas and the view's draw log. */
function renderBoard(bd, sim = null, cam = { x: bd.x * 576 + 288, y: bd.y * 336 + 168 }, t = 0) {
  const ctx = view.getContext('2d');
  view.draws.length = 0;
  view.fills.length = 0;
  renderer.scene(sim, cam, t);
  const art = view.draws.map(([src]) => src).find((src) => src.width === 576 && src.height === 336);
  return { art, ctx };
}

const isStairColour = (d, i) => ['b', 'a', '8', '6'].some((ch) => {
  const c = RGB[idx(ch)];
  return d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2];
});
const ROLE_COLOUR = { [ROLE.tread]: 'b', [ROLE.riser]: 'a', [ROLE.body]: '8' };
const isColour = (d, i, ch) => {
  const c = RGB[idx(ch)];
  return d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2];
};

/** Sign pixels of board `bd` as pixel index -> palette character, from the glyph rows. */
function signGlyphs(bd) {
  const out = new Map();
  for (const { cell, dir } of signs(world, bd)) {
    const [x, yTop] = signSpot(cell, signSide(world, bd, cell), dir);
    SIGNS[dir].forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== '.') out.set(px(x + c, yTop - r), ch); }));
  }
  return out;
}

test('the renderer paints each stair pixel its role colour (tread b, riser a, body 8) and every ladder and sconce pixel inside its box, nothing else', () => {
  // "Nothing else" admits the sign pixels by name, each in its glyph's colour.
  let signed = 0;
  for (const { bd, fx } of boards.filter((_, i) => i % 3 === 0)) {
    const { art } = renderBoard(bd);
    assert.ok(art, 'board art drawn');
    const { ladders, sconces } = spriteSets(fx);
    const carved = signGlyphs(bd);
    signed += carved.size > 0 ? 1 : 0;
    const bad = [];
    for (let k = 0; k < MASK_W * MASK_H && bad.length < 5; k++) {
      const drawn = art.touched[k] === 1;
      // Each stair pixel takes the colour of its ROLE label.
      const ok = fx.stairs[k] ? drawn && isColour(art.data, k * 4, ROLE_COLOUR[fx.stairs[k]])
        : ladders.has(k) ? drawn
          : sconces.has(k) ? drawn && !isStairColour(art.data, k * 4)
            : carved.has(k) ? drawn && isColour(art.data, k * 4, carved.get(k))
              : !drawn;
      if (!ok) bad.push(`(${k % MASK_W}, ${MASK_H - 1 - ((k / MASK_W) | 0)})`);
    }
    assert.deepEqual(bad, [], `board ${bd.p}`);
  }
  assert.ok(signed >= 3, 'the sample holds boards with signs');
});

test('a sign junction shows its sign exactly when it carries one, in its direction and its corner of the room', () => {
  let shown = 0, bare = 0;
  for (const { bd } of boards) {
    const js = junctions(world, bd);
    if (!js.length) continue;
    const { art } = renderBoard(bd);
    const carry = new Map(signs(world, bd).map((sg) => [sg.cell, sg]));
    for (const { cell, dir } of js) {
      const [X, Y] = cellXY(cell);
      for (const side of [0, 1]) {
        const pixels = signPixels(signSpot(cell, side, dir));
        const on = pixels.filter(([x, y]) => art.touched[px(x, y)] === 1).length;
        if (!carry.has(cell)) { assert.equal(on, 0, `board ${bd.p} cell ${cell}: no sign`); continue; }
        if (side !== signSide(world, bd, cell)) { assert.equal(on, 0, `board ${bd.p} cell ${cell}: the other corner`); continue; }
        assert.equal(on, pixels.length, `board ${bd.p} cell ${cell}`);
        // The glyph lies in a corner column range and in rows 30 to 39 of its cell.
        for (const [x, y] of pixels) {
          assert.ok((x - X >= 8 && x - X < 16) || (x - X >= 32 && x - X < 40), `column ${x - X}`);
          assert.ok(y - Y >= 30 && y - Y < 40, `row ${y - Y}`);
        }
        shown++;
      }
      if (!carry.has(cell)) bare++;
    }
  }
  assert.ok(shown >= 20 && bare >= 20, `${shown} signs shown, ${bare} bare junctions`);
});

test('both corners of every sign junction hold room air and no ladder, stair, sconce or sconce-flame pixel, at every level', () => {
  let corners = 0;
  for (const level of DIFFICULTIES) {
    const w = createWorld('00000000', { difficulty: level });
    for (let v = 0; v <= 5; v++) {
      for (let u = -2; u <= 2; u++) {
        for (let i = 0; i < w.size.w * w.size.h; i++) {
          const { x, y } = boardCoords(u, v, i, w.size);
          const bd = w.board(x, y);
          const js = junctions(w, bd);
          if (!js.length) continue;
          const mask = boardMask(bd), fx = fixtureSets(bd, mask);
          const { ladders, sconces } = spriteSets(fx);
          const boxed = new Set(), flames = new Set();
          for (const [lx, y0, y1] of fx.ladders) for (let yy = y0; yy < y1; yy++) for (let c = 0; c < 16; c++) boxed.add(px(lx + c, yy));
          for (const [cx, sy] of fx.sconces) {
            for (const frame of SCONCE_FLAME) {
              frame.forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== '.') flames.add(px(cx - 4 + c, sy + 3 - r)); }));
            }
          }
          for (const { cell, dir } of js) {
            for (const side of [0, 1]) {
              for (const [sx, sy] of signPixels(signSpot(cell, side, dir))) {
                const k = px(sx, sy);
                assert.equal(mask[k], 0, `${level} board ${bd.p}: rock at (${sx}, ${sy})`);
                assert.ok(!fx.stairs[k] && !ladders.has(k) && !boxed.has(k) && !sconces.has(k) && !flames.has(k), `${level} board ${bd.p}: fixture at (${sx}, ${sy})`);
              }
              corners++;
            }
          }
        }
      }
    }
  }
  assert.ok(corners > 5000, `${corners} corners`);
});

test('rock shading counts the stair as solid: no highlight under a flight, and a lone tread keeps its second row', () => {
  let lone = 0;
  for (const { bd, mask, fx } of boards.filter((_, i) => i % 3 === 1)) {
    const { art } = renderBoard(bd);
    const bad = [];
    for (let k = MASK_W; k < MASK_W * (MASK_H - 1); k++) {
      if (!fx.stairs[k] || !mask[k + MASK_W]) continue;
      // The rock pixel directly beneath a stair pixel is no top row.
      if (isColour(art.shaded, (k + MASK_W) * 4, 'b')) bad.push(`b under (${k % MASK_W}, ${MASK_H - 1 - ((k / MASK_W) | 0)})`);
      // A stair column of one pixel leaves the rock's second row under it.
      if (!fx.stairs[k - MASK_W]) {
        lone++;
        if (!isColour(art.shaded, (k + MASK_W) * 4, 'a')) bad.push(`no a under (${k % MASK_W}, ${MASK_H - 1 - ((k / MASK_W) | 0)})`);
      }
    }
    assert.deepEqual(bad.slice(0, 5), [], `board ${bd.p}`);
  }
  assert.ok(lone > 0, 'the sample holds a one-pixel stair column');
});

// Motes.
const sortMotes = (a) => a.slice().sort((p, q) => p.hx - q.hx || p.hy - q.hy);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('motes in two overlapping rectangles agree on the overlap, at any time and offset', () => {
  for (const [t, ox, oy] of [[0, 0, 0], [3.7, 0, 0], [41.2, 13.5, -22.25], [1000.5, -4096, 777]]) {
    const A = dustMotes(-300, -200, 100, 90, t, ox, oy), B = dustMotes(-120, -80, 260, 200, t, ox, oy);
    const inside = (m) => m.x >= -120 && m.x < 100 && m.y >= -80 && m.y < 90;
    const a = sortMotes(A.filter(inside)), b = sortMotes(B.filter(inside));
    assert.ok(a.length > 20, 'the overlap holds motes');
    assert.equal(a.length, b.length);
    a.forEach((m, i) => { near(m.x, b[i].x); near(m.y, b[i].y); });
  }
});

test('a mote stays within its patch at every time, and the offset moves every mote with it', () => {
  let maxX = 0, maxY = 0;
  for (let t = 0; t < 900; t += 3.3) {
    for (const m of dustMotes(-100, -60, 100, 60, t)) {
      assert.ok(Math.abs(m.x - m.hx) <= SWAY_X + 1e-9 && Math.abs(m.y - m.hy) <= SWAY_Y + 1e-9);
      maxX = Math.max(maxX, Math.abs(m.x - m.hx));
      maxY = Math.max(maxY, Math.abs(m.y - m.hy));
    }
  }
  assert.ok(maxX > SWAY_X * 0.8 && maxY > SWAY_Y * 0.8, 'the motes sway through their patches');
  const base = dustMotes(-100, -60, 100, 60, 12.5);
  const moved = dustMotes(-100 + 31.5, -60 - 9.25, 100 + 31.5, 60 - 9.25, 12.5, 31.5, -9.25);
  const homes = new Map(base.map((m) => [`${m.hx + 31.5}|${m.hy - 9.25}`, m]));
  let matched = 0;
  for (const m of moved) {
    const o = homes.get(`${m.hx}|${m.hy}`);
    if (!o) continue;
    near(m.x, o.x + 31.5); near(m.y, o.y - 9.25);
    matched++;
  }
  assert.ok(matched > 40, 'the offset carries the motes');
});

test('sampled 200 x 120 windows hold 40 to 56 motes, 48 on average', () => {
  let sum = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const m = dustMotes(i * 37.3 - 5000, i * -19.1 + 800, i * 37.3 - 4800, i * -19.1 + 920, i * 1.7);
    assert.ok(m.length >= 40 && m.length <= 56, `${m.length} motes`);
    sum += m.length; n++;
  }
  assert.ok(Math.abs(sum / n - 48) < 1.5);
});

test('the renderer draws the motes of its world position, whatever the explorer and camera do', () => {
  const bd = boards[0].bd;
  const cell = boards[0].bd.links.findIndex((m) => m);
  for (const [dx, camX, camY] of [[0, 0, 0], [30, 0, 0], [0, 37, 11]]) {
    const sim = createSim(world, { board: bd, cell });
    sim.off = dx;
    const [nx, ny] = nodeXY(bd, cell);
    const cam = { x: nx + camX, y: ny + 20 + camY };
    renderBoard(bd, sim, cam, 5.5);
    const dots = view.fills.filter((f) => f[4].startsWith('rgba(255,226,170') && f[2] === 1 && f[3] === 1);
    assert.ok(dots.length > 5, 'the torch lights motes');
    const cx = Math.round(cam.x), cy = Math.round(cam.y);
    const all = dustMotes(cx - 200, cy - 120, cx + 200, cy + 120, 5.5);
    for (const [x, y] of dots) {
      const wx = x + cx - 160, wy = cy + 90 - y;
      assert.ok(all.some((m) => Math.abs(m.x - wx) <= 0.51 && Math.abs(m.y - wy) <= 0.51), `mote at ${wx}, ${wy} is not in the world`);
    }
  }
});

// Floor coins and the wallet.
const coinSprite = spriteCanvas(COIN);
const isCoin = ([src]) => src.width === 6 && src.height === 6 && Buffer.from(src.data).equals(Buffer.from(coinSprite.data));
const coinBoard = boards.find(({ bd }) => floorItems(world, bd).length > 1);

test('a scene draws the coin sprite at each uncollected coin\'s floor point, and none for a collected one', () => {
  assert.ok(coinBoard, 'the sample holds a board with coins');
  const { bd } = coinBoard;
  for (const { cell } of floorItems(world, bd)) {
    const [wx, wy] = itemSpot(bd, cell);
    const cam = { x: wx, y: wy + 18 };
    const cx = Math.round(cam.x), cy = Math.round(cam.y);
    // The 6x6 sprite rests on the floor point: bottom row at the point's pixel row.
    const want = [Math.round(wx) - cx + 160 - 3, cy - Math.round(wy) + 90 - 6];
    const drawn = (sim) => { renderBoard(bd, sim, cam, 0); return view.draws.filter(isCoin).map(([, x, y]) => [x, y]); };
    const taken = new Set();
    const sim = createSim(world, { board: bd, cell: bd.a }, null, { collected: taken });
    assert.ok(drawn(sim).some(([x, y]) => x === want[0] && y === want[1]), `coin at cell ${cell} drawn at ${want}`);
    assert.ok(drawn(null).some(([x, y]) => x === want[0] && y === want[1]), 'a scene with no explorer draws it too');
    // The light map multiplies the scene last, so a coin drawn after it would stay bright in the dark.
    renderBoard(bd, sim, cam, 0);
    const lit = view.draws.findIndex(([src, ...a]) => src.width === 80 && src.height === 45 && a.length === 4);
    const coin = view.draws.findIndex(isCoin);
    assert.ok(coin >= 0 && lit > coin, `coin draw ${coin} precedes the light map draw ${lit}`);
    taken.add(`${bd.x},${bd.y},${cell}`);
    assert.ok(!drawn(sim).some(([x, y]) => x === want[0] && y === want[1]), `collected coin at cell ${cell} is gone`);
  }
});

test('hud draws the wallet under TOMB n: the coin sprite, then the count right-aligned at x 315 with its top row at y 14', () => {
  const { bd } = coinBoard;
  const sim = createSim(world, { board: bd, cell: bd.a });
  for (const wallet of [0, 7, 123, 40500]) {
    view.draws.length = 0;
    renderer.hud(sim, wallet);
    const coins = view.draws.filter(isCoin);
    const width = String(wallet).length * 6 - 1;
    assert.equal(coins.length, 1);
    assert.deepEqual(coins[0].slice(1), [315 - width - 2 - 6, 14]);
    // One glyph per digit, 6 px apart, the last ending at x 315.
    const glyphs = view.draws.filter((d) => d.length === 5 && d[2] === 14).map((d) => d[1]);
    assert.deepEqual(glyphs, Array.from(String(wallet), (_, i) => 315 - width + 6 * i));
  }
});
