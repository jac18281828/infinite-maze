import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords } from '../src/world/world.mjs';
import { BW, NCELL } from '../src/world/board.mjs';
import { boardMask, MASK_W, MASK_H } from '../src/game/mask.mjs';
import { createSim, step, nodeXY, torchRadius } from '../src/game/sim.mjs';
import { RGB, idx, ARROWS, SKELETONS, SCONCE_FLAME, COIN, EXPLORER, JAR } from '../src/game/art.mjs';
import { floorItems, itemSpot } from '../src/world/floor.mjs';
import {
  fixtureSets, ladderPixels, sconcePixels, arrowPixels, arrowSpot, skeletonPixels, skeletonSpot, dustMotes, maskRow, ROLE, SWAY_X, SWAY_Y,
} from '../src/game/fixtures.mjs';
import { junctions, arrows, arrowSide, skeletons, boostSkeletons, skeletonSide } from '../src/world/signs.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { createRenderer, spriteCanvas, boostAlpha, BOOST_FADE_S } from '../src/game/render.mjs';

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
// The band rule's last row of column t >= 16: down from the support to Y+t-8, stopping at air.
const bandBottom = (mask, Y, x, t) => {
  let y = supportOf(Y, t);
  while (y >= Y + t - 8 && mask[px(x, y)] === 1) y--;
  return y + 1;
};

test('the sample holds the stairs the diagnosis counted', () => {
  assert.equal(flights.length, 1183);
});

test('every stair pixel is mask air above its support or band rock at or below it, inside its 48 columns and off the side room', () => {
  let rock = 0;
  for (const { bd, mask, X, Y, dir, runs } of flights) {
    assert.equal(runs.length > 0, true);
    for (const { t, x, top, bot } of runs) {
      assert.equal(x, colX(X, t, dir), 'inside its columns');
      assert.ok(bot >= Y + 8, 'no row under the room floor');
      for (let y = bot; y <= top; y++) {
        if (y > supportOf(Y, t)) { assert.equal(mask[px(x, y)], 0, `board ${bd.p}: column ${t} row ${y} is rock`); continue; }
        // At or below the support only the band occurs: rock of a column t >= 16, down to row Y+t-8.
        assert.ok(t >= 16 && y >= Y + t - 8, `board ${bd.p}: column ${t} row ${y} is below the band`);
        assert.equal(mask[px(x, y)], 1, `board ${bd.p}: column ${t} row ${y} is air`);
        rock++;
      }
      // The side room's columns are t >= 32; its air holds no stair pixel.
      if (t >= 32) for (let y = bot; y <= top; y++) if (y >= Y + 8 && y < Y + 40) assert.equal(mask[px(x, y)], 1, `board ${bd.p}: column ${t} row ${y} is side-room air`);
    }
  }
  assert.ok(rock > 100000, `${rock} band pixels`);
  // The role map holds those pixels and no others.
  for (const { fx } of boards) {
    const want = new Set(fx.flights.flatMap(({ runs }) => runs.flatMap(({ x, top, bot }) => Array.from({ length: top - bot + 1 }, (_, i) => px(x, bot + i)))));
    let n = 0;
    for (let k = 0; k < fx.stairs.length; k++) if (fx.stairs[k]) { n++; assert.ok(want.has(k)); }
    assert.equal(n, want.size);
  }
});

test('every stair column is contiguous from its tread down to row Y+8, or for t >= 16 to the band rule\'s last row', () => {
  for (const { mask, fx, X, Y, dir } of flights) {
    for (let t = 0; t < 48; t++) {
      const x = colX(X, t, dir), top = treadOf(Y, t);
      const last = t < 16 ? Y + 8 : bandBottom(mask, Y, x, t);
      const want = [];
      for (let y = last; y <= top; y++) want.push(y);
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
    // The last step's four columns share one tread on the upper floor's top row, Y+55.
    let top44 = -1;
    for (let y = Y + 8; y <= Y + 60; y++) if (fx.stairs[px(colX(X, 44, dir), y)]) top44 = y;
    assert.equal(top44, Y + 55);
    // Column 47 holds stone under that tread.
    let top47 = -1, n47 = 0;
    for (let y = Y + 8; y <= Y + 60; y++) if (fx.stairs[px(c47, y)]) { top47 = y; n47++; }
    assert.equal(top47, Y + 55);
    assert.equal(fx.stairs[px(c47, top47)], ROLE.tread);
    assert.ok(n47 > 1, 'column 47 holds stone under its tread');
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
// as `shaded` and flags the pixels drawn after it in `touched`. A draw record
// is [src, ...args] and carries the context's globalAlpha as `.alpha`.
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
    globalAlpha: 1,
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
      const record = [src, ...a];
      record.alpha = ctx.globalAlpha;
      canvas.draws.push(record);
      if (ctx.globalCompositeOperation !== 'source-over') return;
      const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, src.width, src.height, a[0], a[1], src.width, src.height]
        : a.length === 4 ? [0, 0, src.width, src.height, ...a] : a;
      for (let j = 0; j < dh; j++) {
        for (let i = 0; i < dw; i++) {
          const x = dx + i, y = dy + j;
          if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) continue;
          const s = ((sy + Math.floor((j * sh) / dh)) * src.width + sx + Math.floor((i * sw) / dw)) * 4;
          if (src.data[s + 3]) over((y * canvas.w + x) * 4, src.data[s], src.data[s + 1], src.data[s + 2], src.data[s + 3] * ctx.globalAlpha);
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

/** Arrow pixels of board `bd` as pixel index -> palette character, from the glyph rows. */
function arrowGlyphs(bd) {
  const out = new Map();
  for (const { cell, dir } of arrows(world, bd)) {
    const [x, yTop] = arrowSpot(cell, arrowSide(world, bd, cell), dir);
    ARROWS[dir].forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== '.') out.set(px(x + c, yTop - r), ch); }));
  }
  return out;
}

// Pose index of each way on, E N W S then the galleries folded up and down.
const POSE_IDX = [0, 1, 2, 3, 1, 1, 3, 3];
/** Pixel index -> palette character of the skeleton at `cell` in corner `side`, from the literal box and rows. */
function skeletonMap(cell, side, dir) {
  const [X, Y] = cellXY(cell);
  const k = POSE_IDX[dir], pose = side && k % 2 === 0 ? k ^ 2 : k;
  const x0 = X + (side ? 32 : 9), out = new Map();
  SKELETONS[pose].forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== '.') out.set(px(x0 + (side ? 6 - c : c), Y + 17 - r), ch); }));
  return out;
}
/** A gallery toward a side takes that lower corner: NE 16 and SE 128 the right, NW 32 and SW 64 the left. */
const cornerBlocked = (bd, cell, side) => (bd.links[cell] & (side ? 16 | 128 : 32 | 64)) !== 0;

/** Tier-1 skeleton pixels of board `bd` as pixel index -> palette character. */
function skeletonGlyphs(bd) {
  const out = new Map();
  for (const { cell, dir } of skeletons(world, bd)) {
    for (const [k, ch] of skeletonMap(cell, skeletonSide(world, bd, cell, dir), dir)) out.set(k, ch);
  }
  return out;
}

test('the renderer paints each stair pixel its role colour (tread b, riser a, body 8) and every ladder and sconce pixel inside its box, nothing else', () => {
  // "Nothing else" admits the arrow and tier-1 skeleton pixels by name, each in its palette colour.
  let signed = 0;
  for (const { bd, fx } of boards.filter((_, i) => i % 3 === 0)) {
    const { art } = renderBoard(bd);
    assert.ok(art, 'board art drawn');
    const { ladders, sconces } = spriteSets(fx);
    const carved = new Map([...arrowGlyphs(bd), ...skeletonGlyphs(bd)]);
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
  assert.ok(signed >= 3, 'the sample holds boards with arrows or skeletons');
});

test('a sign junction shows its arrow exactly when it carries one, in its direction and its corner of the room', () => {
  let shown = 0, bare = 0;
  for (const { bd } of boards) {
    const js = junctions(world, bd);
    if (!js.length) continue;
    const { art } = renderBoard(bd);
    const carry = new Map(arrows(world, bd).map((sg) => [sg.cell, sg]));
    for (const { cell, dir } of js) {
      const [X, Y] = cellXY(cell);
      for (const side of [0, 1]) {
        const pixels = arrowPixels(arrowSpot(cell, side, dir));
        const on = pixels.filter(([x, y]) => art.touched[px(x, y)] === 1).length;
        if (!carry.has(cell)) { assert.equal(on, 0, `board ${bd.p} cell ${cell}: no arrow`); continue; }
        if (side !== arrowSide(world, bd, cell)) { assert.equal(on, 0, `board ${bd.p} cell ${cell}: the other corner`); continue; }
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
  assert.ok(shown >= 20 && bare >= 20, `${shown} arrows shown, ${bare} bare junctions`);
});

test('both upper corners of every sign junction hold room air and no ladder, stair, sconce or sconce-flame pixel, at every level', () => {
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
              for (const [sx, sy] of arrowPixels(arrowSpot(cell, side, dir))) {
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

test('a sign junction shows its tier-1 skeleton exactly when it carries one, in its pose and its corner of the room', () => {
  let shown = 0, bare = 0;
  for (const { bd } of boards) {
    const js = junctions(world, bd);
    if (!js.length) continue;
    const { art } = renderBoard(bd);
    const carry = new Map(skeletons(world, bd).map((sg) => [sg.cell, sg]));
    for (const { cell, dir } of js) {
      for (const side of [0, 1]) {
        const want = skeletonMap(cell, side, dir);
        const on = [...want.keys()].filter((k) => art.touched[k] === 1).length;
        if (!carry.has(cell) || side !== skeletonSide(world, bd, cell, dir)) {
          // A corner under a gallery holds the stair; every other empty corner is untouched.
          if (!cornerBlocked(bd, cell, side)) assert.equal(on, 0, `board ${bd.p} cell ${cell} side ${side}: no skeleton`);
          continue;
        }
        assert.equal(on, want.size, `board ${bd.p} cell ${cell}`);
        for (const [k, ch] of want) assert.ok(isColour(art.data, k * 4, ch), `board ${bd.p} cell ${cell}: pixel ${k} is palette ${ch}`);
        shown++;
      }
      if (!carry.has(cell)) bare++;
    }
  }
  assert.ok(shown >= 8 && bare >= 20, `${shown} skeletons shown, ${bare} bare junctions`);
});

test('a corner box is clear exactly when the cell\'s gallery runs away from it, and every skeleton lies inside its clear box', () => {
  let corners = 0, blockedCorners = 0, placed = 0;
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
          const clear = (cell, side) => {
            const [X, Y] = cellXY(cell), x0 = X + (side ? 32 : 9);
            for (let xx = x0; xx < x0 + 7; xx++) {
              if (mask[px(xx, Y + 7)] !== 1) return false;
              for (let yy = Y + 8; yy < Y + 18; yy++) {
                const k = px(xx, yy);
                if (mask[k] || fx.stairs[k] || fx.ledge[k] || ladders.has(k) || boxed.has(k) || sconces.has(k) || flames.has(k)) return false;
              }
            }
            return true;
          };
          for (const { cell } of js) {
            for (const side of [0, 1]) {
              const blocked = cornerBlocked(bd, cell, side);
              assert.equal(clear(cell, side), !blocked, `${level} board ${bd.p} cell ${cell} side ${side}`);
              corners++;
              if (blocked) blockedCorners++;
            }
          }
          for (const { cell, dir } of [...skeletons(w, bd), ...boostSkeletons(w, bd)]) {
            const side = skeletonSide(w, bd, cell, dir), [X, Y] = cellXY(cell), x0 = X + (side ? 32 : 9);
            assert.ok(clear(cell, side), `${level} board ${bd.p} cell ${cell}: the skeleton's corner is clear`);
            const pixels = skeletonPixels(skeletonSpot(cell, side, dir));
            assert.ok(pixels.length > 20);
            for (const [sx, sy] of pixels) assert.ok(sx >= x0 && sx < x0 + 7 && sy >= Y + 8 && sy < Y + 18, `${level} board ${bd.p} cell ${cell}: pixel (${sx}, ${sy}) outside its box`);
            assert.deepEqual(new Set(pixels.map(([sx, sy]) => px(sx, sy))), new Set(skeletonMap(cell, side, dir).keys()), 'the pose and corner draw the literal pixels');
            placed++;
          }
        }
      }
    }
  }
  assert.ok(corners > 5000 && blockedCorners > 500 && placed > 150, `${corners} corners, ${blockedCorners} blocked, ${placed} skeletons`);
});

test('in either corner a drawn skeleton\'s fingertip lies in the box row or column its way on names', () => {
  const need = new Set(['0 up', '0 down', '0 right', '0 left', '1 up', '1 down', '1 right', '1 left']);
  const keyOf = (dir) => ['right', 'up', 'left', 'down'][POSE_IDX[dir]];
  const tip = RGB[idx('9')];
  for (const level of DIFFICULTIES) {
    const w = createWorld('00000000', { difficulty: level });
    const rend = createRenderer(view, w);
    for (let v = 0; v <= 19 && need.size; v++) {
      for (let u = -2; u <= 2 && need.size; u++) {
        for (let i = 0; i < w.size.w * w.size.h && need.size; i++) {
          const { x, y } = boardCoords(u, v, i, w.size);
          const bd = w.board(x, y);
          const found = skeletons(w, bd).map(({ cell, dir }) => ({ cell, dir, side: skeletonSide(w, bd, cell, dir) }))
            .filter(({ dir, side }) => need.has(`${side} ${keyOf(dir)}`));
          if (!found.length) continue;
          view.draws.length = 0;
          rend.scene(null, { x: bd.x * 576 + 288, y: bd.y * 336 + 168 }, 0);
          const art = view.draws.map(([src]) => src).find((src) => src.width === 576 && src.height === 336);
          for (const { cell, dir, side } of found) {
            const key = keyOf(dir);
            if (!need.has(`${side} ${key}`)) continue;
            const [X, Y] = cellXY(cell), x0 = X + (side ? 32 : 9);
            const tips = [];
            for (let xx = x0; xx < x0 + 7; xx++) {
              for (let yy = Y + 8; yy < Y + 18; yy++) {
                const o = px(xx, yy) * 4;
                if (art.touched[px(xx, yy)] && art.data[o] === tip[0] && art.data[o + 1] === tip[1] && art.data[o + 2] === tip[2]) tips.push([xx, yy]);
              }
            }
            assert.equal(tips.length, 1, `${level} board ${bd.p} cell ${cell}: one fingertip`);
            const [[tx, ty]] = tips;
            if (key === 'up') assert.equal(ty, Y + 17);
            if (key === 'down') {
              // The fingertip stands in the box's second row from the bottom; air separates it from the floor row.
              assert.equal(ty, Y + 9);
              assert.equal(art.touched[px(tx, Y + 8)], 0, `${level} board ${bd.p} cell ${cell}: air under the fingertip`);
              assert.equal(boardMask(bd)[px(tx, Y + 7)], 1, `${level} board ${bd.p} cell ${cell}: rock under the air`);
            }
            if (key === 'right') { assert.equal(tx, x0 + 6); assert.ok(ty >= Y + 12 && ty <= Y + 14); }
            if (key === 'left') { assert.equal(tx, x0); assert.ok(ty >= Y + 12 && ty <= Y + 14); }
            need.delete(`${side} ${key}`);
          }
        }
      }
    }
  }
  assert.deepEqual([...need], [], 'every corner and way on appeared');
});

// Skeleton sprites by pose and flip, and the scene's draws of them.
const skelSprites = SKELETONS.map((rows) => [spriteCanvas(rows), spriteCanvas(rows, true)]);
const sameSprite = (a, b) => a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data));
const isSkeleton = ([src]) => src.width === 7 && src.height === 10 && skelSprites.flat().some((c) => sameSprite(c, src));
const skeletonDraws = () => view.draws.filter(isSkeleton);

/** Where the scene under `cam` draws the skeleton `{ cell, dir }` of `bd`, and which sprite. */
function skeletonDraw(bd, { cell, dir }, cam) {
  const side = skeletonSide(world, bd, cell, dir), [X, Y] = cellXY(cell);
  const k = POSE_IDX[dir], pose = side && k % 2 === 0 ? k ^ 2 : k;
  return {
    at: [bd.x * 576 + X + (side ? 32 : 9) - Math.round(cam.x) + 160, Math.round(cam.y) - (bd.y * 336 + Y + 18) + 90],
    sprite: skelSprites[pose][side],
  };
}
/** Skeletons `pick(world, bd)` of `bd` and its eight neighbours, as skeletonDraw records. */
function around(bd, pick, cam) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nb = world.board(bd.x + dx, bd.y + dy);
      for (const sg of pick(world, nb)) out.push({ ...skeletonDraw(nb, sg, cam), own: nb === bd });
    }
  }
  return out;
}
const tier1Board = boards.find(({ bd }) => skeletons(world, bd).length > 0 && boostSkeletons(world, bd).length === 0).bd;
const tier2Board = boards.find(({ bd }) => boostSkeletons(world, bd).length > 0).bd;
/** A camera centring the board's first tier-2 skeleton. */
const camOn = (bd, sg) => {
  const [X, Y] = cellXY(sg.cell);
  return { x: bd.x * 576 + X + 12, y: bd.y * 336 + Y + 13 };
};
/** The burn `b` and ember of a sim standing at the first cell of `bd`. */
function simAt(bd, burn, ember = 0) {
  const sim = createSim(world, { board: bd, cell: bd.a });
  sim.burn = burn;
  sim.ember = ember;
  return sim;
}

test('boostAlpha fades tier 2 in over the 10 s under half the burn: 0 at 150 s, 0.5 at 145 s, 1 at 140 s and below', () => {
  assert.equal(BOOST_FADE_S, 10);
  for (const [burn, want] of [[300, 0], [200, 0], [150, 0], [147, 0.3], [145, 0.5], [142, 0.8], [140, 1], [100, 1], [1, 1], [0, 1]]) near(boostAlpha(burn), want);
});

test('tier 1 never depends on the burn: the board art and its skeleton pixels hold at 300, 150, 145 and 0 s and in the ember, and the scene never redraws them', () => {
  const bd = tier1Board;
  const cam = { x: bd.x * 576 + 288, y: bd.y * 336 + 168 };
  const want = skeletonGlyphs(bd);
  assert.ok(want.size > 20, 'the board holds a tier-1 skeleton');
  let first = null;
  for (const [burn, ember] of [[300, 0], [150, 0], [145, 0], [0, 0], [0, 5]]) {
    const { art } = renderBoard(bd, simAt(bd, burn, ember), cam, 0);
    const snap = Uint8ClampedArray.from(art.data);
    if (first) assert.deepEqual(snap, first, `burn ${burn}: the board art is the same`);
    first = first || snap;
    for (const [k, ch] of want) assert.ok(isColour(art.data, k * 4, ch), `burn ${burn}: skeleton pixel ${k}`);
    const tier1 = around(bd, skeletons, cam).map((d) => d.at.join());
    for (const d of skeletonDraws()) assert.ok(!tier1.includes(`${d[1]},${d[2]}`), `burn ${burn}: the scene redraws a tier-1 skeleton`);
  }
});

test('the scene draws a board\'s tier-2 skeletons, at their spots and poses, exactly when boostAlpha is above 0, at that alpha', () => {
  const bd = tier2Board, sg = boostSkeletons(world, bd)[0], cam = camOn(bd, sg);
  const expected = around(bd, boostSkeletons, cam);
  const own = expected.filter((d) => d.own);
  assert.ok(own.length >= 1);
  for (const [burn, ember, alpha] of [[300, 0, 0], [150, 0, 0], [145, 0, 0.5], [140, 0, 1], [60, 0, 1], [0, 5, 1]]) {
    renderBoard(bd, simAt(bd, burn, ember), cam, 0);
    // Each frame restores the alpha, and no draw but a skeleton's records another.
    assert.equal(view.getContext('2d').globalAlpha, 1, `burn ${burn}: the alpha is restored`);
    assert.ok(view.draws.filter((d) => !isSkeleton(d)).every((d) => d.alpha === 1), `burn ${burn}: only skeletons draw translucent`);
    const drawn = skeletonDraws();
    if (!alpha) { assert.equal(drawn.length, 0, `burn ${burn}: no tier-2 skeleton`); continue; }
    for (const d of drawn) {
      assert.equal(d.alpha, alpha, `burn ${burn}: alpha`);
      assert.ok(expected.some((e) => e.at[0] === d[1] && e.at[1] === d[2] && sameSprite(e.sprite, d[0])), `burn ${burn}: a drawn skeleton at ${d[1]}, ${d[2]} is no tier-2 spot`);
    }
    for (const e of own) assert.ok(drawn.some((d) => d[1] === e.at[0] && d[2] === e.at[1] && sameSprite(e.sprite, d[0])), `burn ${burn}: the skeleton at ${e.at} is drawn in its pose`);
    // The scene draws them before the light map, which multiplies the scene last.
    const lit = view.draws.findIndex(([src, ...a]) => src.width === 80 && src.height === 45 && a.length === 4);
    assert.ok(view.draws.findIndex(isSkeleton) < lit, 'tier 2 draws before the light map');
  }
  renderBoard(bd, null, cam, 0);
  assert.equal(skeletonDraws().length, 0, 'with no sim, tier 2 draws nothing');
});

test('a refuel to half the burn or above hides tier 2 on its tick, and one that stays under half leaves it shown', () => {
  const bd = tier2Board, cam = camOn(bd, boostSkeletons(world, bd)[0]);
  const shown = (sim) => { renderBoard(bd, sim, cam, 0); return skeletonDraws().length; };
  // A brazier at 100 s.
  const flameBd = boards.find(({ bd: b }) => world.flamesAt(b.x, b.y).length > 0).bd;
  let sim = createSim(world, { board: flameBd, cell: world.flamesAt(flameBd.x, flameBd.y)[0] });
  sim.burn = 100;
  assert.ok(shown(sim) > 0, 'tier 2 shows at 100 s');
  step(sim, 0, 0);
  assert.equal(sim.burn, 300);
  assert.equal(shown(sim), 0, 'the flame hides tier 2');
  // A jar from 100 s to 160 s hides it; one from 50 s to 110 s does not.
  const { bd: jbd } = jarBoard, jar = jarsOf(jbd)[0];
  const jarSim = (burn) => {
    const s = createSim(world, { board: jbd, cell: jar.cell });
    s.off = itemSpot(jbd, jar.cell)[0] - nodeXY(jbd, jar.cell)[0];
    s.burn = burn;
    return s;
  };
  sim = jarSim(100);
  const before = shown(sim);
  assert.ok(before > 0);
  step(sim, 0, 0);
  assert.ok(sim.burn > 159 && sim.burn <= 160, `the jar lifts 100 s to ${sim.burn}`);
  assert.equal(shown(sim), 0, 'a jar to 160 s hides tier 2');
  sim = jarSim(50);
  step(sim, 0, 0);
  assert.ok(sim.burn > 109 && sim.burn <= 110, `the jar lifts 50 s to ${sim.burn}`);
  assert.equal(shown(sim), before, 'a jar to 110 s leaves tier 2 shown');
  assert.ok(skeletonDraws().every((d) => d.alpha === 1));
});

test('rock shading counts the stair as solid: no highlight under a flight, and a lone tread keeps its second row', () => {
  // Only stair pixels that are mask air: a band pixel is rock and its tile may carry b itself.
  let lone = 0;
  for (const { bd, mask, fx } of boards.filter((_, i) => i % 3 === 1)) {
    const { art } = renderBoard(bd);
    const bad = [];
    for (let k = MASK_W; k < MASK_W * (MASK_H - 1); k++) {
      if (!fx.stairs[k] || mask[k] || !mask[k + MASK_W]) continue;
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

// The §2 fixture: the default world's board (4, 0), cell 57 at (432, 192), a north-east flight.
const fixture = boards.find(({ bd }) => bd.x === 4 && bd.y === 0);
const fixtureFlight = fixture.fx.flights.find(({ c }) => c === 57);

test('the fixture flight draws column 24 as stone on rows 208 to 227 and column 27 from its tread down to row 211', () => {
  const { mask, fx, bd } = fixture;
  assert.deepEqual([fixtureFlight.X, fixtureFlight.Y, fixtureFlight.dir], [432, 192, 1]);
  const { art } = renderBoard(bd);
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  // The flight spans rows 200 to 252; the cell below holds its own flight in the same columns.
  const rows = (x) => range(200, 252).filter((y) => fx.stairs[px(x, y)]);
  // Column 24 (riser face): tread on 227 over air, rock on 208 to 224 under the support at 224.
  assert.deepEqual(rows(480), range(208, 227));
  assert.equal(fx.stairs[px(480, 227)], ROLE.tread);
  for (const y of range(208, 224)) assert.equal(mask[px(480, y)], 1, `row ${y} is rock`);
  // Column 27: the tread is the support row, so the stair starts on rock.
  assert.deepEqual(rows(483), range(211, 227));
  assert.equal(fx.stairs[px(483, 227)], ROLE.tread);
  assert.equal(mask[px(483, 227)], 1);
  for (const [x, role] of [[480, 'a'], [483, '8']]) {
    for (const y of rows(x)) {
      const want = fx.stairs[px(x, y)] === ROLE.tread ? 'b' : role;
      assert.equal(art.touched[px(x, y)], 1);
      assert.ok(isColour(art.data, px(x, y) * 4, want), `(${x}, ${y}) paints ${want}`);
    }
  }
});

test('the fixture ledge shades rows 196 to 199 of columns 456 to 463 as rock, and the ladder draws over it', () => {
  const { mask, fx, bd } = fixture;
  const { art } = renderBoard(bd);
  const ladder = new Set(fx.ladders.flatMap(ladderPixels).map(([x, y]) => px(x, y)));
  let over = 0, bare = 0;
  for (let x = 456; x < 464; x++) {
    for (let y = 196; y < 200; y++) {
      const k = px(x, y);
      assert.equal(mask[k], 0, `(${x}, ${y}) is mask air`);
      assert.equal(fx.ledge[k], 1);
      assert.ok(['6', '7', '8', '9', 'a', 'b'].some((ch) => isColour(art.shaded, k * 4, ch)), `(${x}, ${y}) shades as rock`);
      if (ladder.has(k)) { assert.equal(art.touched[k], 1, 'the ladder draws over the ledge'); over++; } else { assert.equal(art.touched[k], 0); bare++; }
    }
  }
  assert.ok(over > 0 && bare > 0, `${over} ladder pixels over the ledge, ${bare} bare`);
  // Shading counts the ledge as filled: no 6 or 7 edge on a bare pixel with ledge below it
  // (rows 198, 199), and no side edge 8 on the rock at x 464 beside the ledge's right column.
  for (let x = 456; x < 464; x++) {
    for (const y of [198, 199]) {
      const k = px(x, y);
      if (ladder.has(k)) continue;
      assert.ok(!isColour(art.shaded, k * 4, '6') && !isColour(art.shaded, k * 4, '7'), `(${x}, ${y}) has no under-edge`);
    }
  }
  for (let y = 196; y < 200; y++) {
    assert.equal(mask[px(464, y)], 1);
    assert.ok(!isColour(art.shaded, px(464, y) * 4, '8'), `(464, ${y}) has no side edge`);
  }
});

/** Opaque pixels of the top 12 rows of the gallery frames, with feet at (fx, fy) and the sprite facing `dir`, on mask rock. */
function hatRock(mask, fx, fy, dir) {
  let n = 0;
  for (const frame of EXPLORER.gallery) {
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 16; c++) {
        const x = fx - 8 + (dir > 0 ? c : 15 - c), y = fy + 23 - r;
        if (idx(frame[r][c]) >= 0 && x >= 0 && x < MASK_W && y >= 0 && y < MASK_H && mask[px(x, y)] === 1) n++;
      }
    }
  }
  return n;
}

test('along the fixture flight the explorer\'s upper half meets no mask rock', () => {
  const { mask } = fixture;
  for (let k = 0; k <= 48; k++) assert.equal(hatRock(mask, 432 + 24 + k, 192 + 8 + k, 1), 0, `k = ${k}`);
});

test('along every flight in the sample, either direction, the explorer\'s upper half meets no mask rock', () => {
  let ne = 0, nw = 0;
  for (const { mask, X, Y, dir } of flights) {
    // Feet on the walk line (X + 24 + dir * k, Y + 8 + k), as feet() puts them, facing up the flight and down it.
    for (let k = 0; k <= 48; k++) {
      for (const facing of [dir, -dir]) {
        assert.equal(hatRock(mask, X + 24 + dir * k, Y + 8 + k, facing), 0, `flight at (${X}, ${Y}) dir ${dir}, facing ${facing}, k = ${k}`);
      }
    }
    if (dir > 0) ne++; else nw++;
  }
  assert.ok(ne > 100 && nw > 100, `${ne} north-east and ${nw} north-west flights`);
});

test('a flight\'s band reaches row Y+t-8 in every column, or stops at a carved side room', () => {
  let full = 0, stopped = 0;
  for (const { mask, fx, X, Y, dir } of flights) {
    let all = true;
    for (let t = 16; t < 48; t++) {
      let low = Y + 60;
      for (let y = Y + 60; y >= Y + 8; y--) if (fx.stairs[px(colX(X, t, dir), y)]) low = y;
      if (low !== Y + t - 8) all = false;
    }
    if (all) full++; else stopped++;
  }
  assert.deepEqual([full, stopped], [718, 465]);
});

test('every ledge pixel is mask air on rows Y+4 to Y+7 of a column t < 16 over air, and each such column holds all four rows', () => {
  let ne = 0, nw = 0, columns = 0;
  const want = new Set();
  for (const { bd, mask, fx, X, Y, dir } of flights) {
    let over = false;
    for (let t = 0; t < 16; t++) {
      const x = colX(X, t, dir);
      if (mask[px(x, Y + 7)] !== 0) continue;
      over = true;
      columns++;
      for (let y = Y + 4; y <= Y + 7; y++) { assert.equal(fx.ledge[px(x, y)], 1, `board ${bd.p}: column ${t} row ${y - Y}`); want.add(`${bd.p}|${px(x, y)}`); }
    }
    if (over) { if (dir > 0) ne++; else nw++; }
  }
  for (const { bd, mask, fx } of boards) {
    for (let k = 0; k < fx.ledge.length; k++) {
      if (!fx.ledge[k]) continue;
      assert.equal(mask[k], 0, `board ${bd.p}: ledge pixel ${k} is rock`);
      assert.ok(want.has(`${bd.p}|${k}`), `board ${bd.p}: ledge pixel ${k} is off every shaft-side column`);
    }
  }
  assert.deepEqual([ne, nw], [230, 242]);
  assert.ok(columns > 0);
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

// Wind: the dust drifts toward the entrance of a windy dead-end branch.
// Board (1, 2)'s cell 33 is on the way on; the branch off it into cell 34 is
// windy and spans two dead-end boards.
const isMote = (f) => f[4].startsWith('rgba(255,226,170') && f[2] === 1 && f[3] === 1;

function driftRenderer() {
  const v = document.createElement('canvas');
  v.width = 320;
  v.height = 180;
  return { v, r: createRenderer(v, world) };
}

/** Draws one frame; returns the torch tip and the mote pixels. */
function frame({ v, r }, bd, cell, t) {
  const sim = createSim(world, { board: bd, cell });
  const [nx, ny] = nodeXY(bd, cell);
  v.draws.length = 0;
  v.fills.length = 0;
  const tip = r.scene(sim, { x: nx, y: ny + 20 }, t);
  return { tip, r: torchRadius(sim.burn), dots: v.fills.filter(isMote).map(([x, y]) => [x, y]) };
}

/**
 * The shift that carries the motes of `still` onto those of `moved`, drawn at
 * one time. It scans lengths along screen direction `dir`, keeps the one that
 * matches the most motes lit well inside both torch discs, and averages the
 * matched pairs' displacements. Returns the shift, the matched pairs and
 * the motes inside both discs that match none.
 */
function shiftOf(still, moved, dir, maxLen) {
  const inside = (p, f) => Math.hypot(p[0] - f.tip[0], p[1] - f.tip[1]) < 0.9 * f.r - 2;
  const nearest = (dots, x, y) => dots.reduce((b, q) => (Math.hypot(q[0] - x, q[1] - y) < Math.hypot(b[0] - x, b[1] - y) ? q : b), [1e9, 1e9]);
  const pairsAt = (len) => {
    const sx = dir[0] * len, sy = dir[1] * len, out = [];
    let lost = 0;
    for (const p of still.dots) {
      if (!inside(p, still) || !inside([p[0] + sx, p[1] + sy], moved)) continue;
      const q = nearest(moved.dots, p[0] + sx, p[1] + sy);
      if (Math.hypot(q[0] - p[0] - sx, q[1] - p[1] - sy) <= 1.5) out.push([p, q]); else lost++;
    }
    return { out, lost };
  };
  let best = -1, lens = [];
  for (let len = 0; len <= maxLen; len += 0.25) {
    const n = pairsAt(len).out.length;
    if (n > best) { best = n; lens = []; }
    if (n === best) lens.push(len);
  }
  const { out, lost } = pairsAt(lens.reduce((a, b) => a + b) / lens.length);
  const dx = out.reduce((a, [p, q]) => a + q[0] - p[0], 0) / out.length;
  const dy = out.reduce((a, [p, q]) => a + q[1] - p[1], 0) / out.length;
  return { dx, dy, len: Math.hypot(dx, dy), pairs: out.length, lost, out };
}

const s2 = Math.SQRT1_2;
const windBoard = world.board(1, 2);
const WIND_CASES = [
  // [board, cell, screen direction (y down) of the wind, label]
  [windBoard, 34, [-1, 0], 'cell 34, west'],
  [windBoard, 47, [0, 1], 'cell 47, down'],
  [world.board(2, 2), 0, [0, -1], 'a dead-end board, up'],
  [windBoard, 81, [s2, s2], 'a gallery cell, south-east'],
];

test('the dust drifts toward the branch entrance by 30 to 48 px after 4 s in a windy branch', (t) => {
  for (const [bd, cell, dir, label] of WIND_CASES) {
    const moving = driftRenderer(), fresh = driftRenderer();
    let last;
    for (let k = 0; k <= 16; k++) last = frame(moving, bd, cell, k * 0.25);
    const still = frame(fresh, bd, cell, 4);
    const m = shiftOf(still, last, dir, 80);
    t.diagnostic(`${label}: shift ${m.dx.toFixed(2)}, ${m.dy.toFixed(2)} = ${m.len.toFixed(2)} px over ${m.pairs} motes`);
    assert.ok(m.pairs >= 8 && m.lost === 0, `${label}: ${m.pairs} motes match, ${m.lost} do not`);
    assert.ok(m.len >= 30 && m.len <= 48, `${label}: shift ${m.len}`);
    assert.ok(Math.abs(m.dx * dir[1] - m.dy * dir[0]) < 0.5 && m.dx * dir[0] + m.dy * dir[1] > 0, `${label}: direction ${m.dx}, ${m.dy}`);
    for (const [p, q] of m.out) assert.ok(Math.abs(q[0] - p[0] - m.dx) <= 1 && Math.abs(q[1] - p[1] - m.dy) <= 1, `${label}: a mote strays`);
  }
});

test('the dust hangs still on the way on and in a windless branch', () => {
  for (const [bd, cell] of [[windBoard, 33], [world.board(0, 0), 0]]) {
    const moving = driftRenderer(), fresh = driftRenderer();
    let last;
    for (let k = 0; k <= 16; k++) last = frame(moving, bd, cell, k * 0.25);
    const still = frame(fresh, bd, cell, 4);
    assert.ok(still.dots.length > 10);
    assert.deepEqual(last.dots, still.dots);
  }
});

test('the drift eases in, rests within a second of leaving the branch, and takes one frame at most 0.25 s', (t) => {
  const west = [-1, 0];
  // The shift of renderer `R` against a new renderer drawing one frame, which has not drifted.
  const shiftAt = (R, cell, t, maxLen) => shiftOf(frame(driftRenderer(), windBoard, cell, t), frame(R, windBoard, cell, t), west, maxLen);

  const R = driftRenderer();
  frame(R, windBoard, 34, 0);
  frame(R, windBoard, 34, 0.25);
  const eased = shiftAt(R, 34, 0.5, 12);
  t.diagnostic(`shift after two 0.25 s frames: ${eased.len.toFixed(2)} px`);
  assert.ok(eased.len > 0.5 && eased.len <= 2.5, `two frames shift ${eased.len}`);

  for (let k = 3; k <= 16; k++) frame(R, windBoard, 34, k * 0.25);
  // The explorer leaves the branch at 4 s; the drift rests within a second.
  for (let k = 17; k < 21; k++) frame(R, windBoard, 33, k * 0.25);
  const rest = [];
  for (let k = 21; k <= 32; k++) rest.push(shiftAt(R, 33, k * 0.25, 80));
  t.diagnostic(`rest shift ${rest[0].len.toFixed(2)} px, spread ${Math.max(...rest.map((m) => Math.hypot(m.dx - rest[0].dx, m.dy - rest[0].dy))).toFixed(2)} px`);
  assert.ok(rest[0].len > 30, 'the motes keep the place they drifted to');
  for (const m of rest) assert.ok(Math.abs(m.dx - rest[0].dx) <= 1 && Math.abs(m.dy - rest[0].dy) <= 1, 'the shift holds still');

  const late = driftRenderer();
  frame(late, windBoard, 34, 0);
  const jump = shiftAt(late, 34, 60, 12);
  t.diagnostic(`shift of a frame after 60 s: ${jump.len.toFixed(2)} px`);
  assert.ok(jump.len > 0.2 && jump.len <= 3, `a frame after 60 s shifts ${jump.len}`);

  // A frame dated earlier than the last moves nothing.
  const back = driftRenderer();
  for (let k = 0; k <= 12; k++) frame(back, windBoard, 34, k * 0.25);
  const at3 = shiftAt(back, 34, 3, 80);
  const before = shiftAt(back, 34, 2.5, 80);
  assert.ok(Math.abs(at3.dx - before.dx) < 0.35 && Math.abs(at3.dy - before.dy) < 0.35, `${at3.dx} then ${before.dx}`);
  // The next forward frame steps from the latest time seen, 3 s: 0.1 s at 12 px/s.
  const ahead = shiftAt(back, 34, 3.1, 80);
  t.diagnostic(`forward frame after the earlier one: ${(at3.dx - ahead.dx).toFixed(2)} px`);
  assert.ok(Math.abs(at3.dx - ahead.dx - 1.2) < 0.35 && Math.abs(at3.dy - ahead.dy) < 0.35, `${at3.dx} then ${ahead.dx}`);
});

// Floor coins and the wallet.
const coinSprite = spriteCanvas(COIN);
const isCoin = ([src]) => src.width === 6 && src.height === 6 && Buffer.from(src.data).equals(Buffer.from(coinSprite.data));
const coinsOf = (bd) => floorItems(world, bd).filter((it) => it.kind === 'coin');
const coinBoard = boards.find(({ bd }) => coinsOf(bd).length > 1);

test('a scene draws the coin sprite at each uncollected coin\'s floor point, and none for a collected one', () => {
  assert.ok(coinBoard, 'the sample holds a board with coins');
  const { bd } = coinBoard;
  for (const { cell } of coinsOf(bd)) {
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

// Floor oil jars.
const jarSprite = spriteCanvas(JAR);
const isJar = ([src]) => src.width === 7 && src.height === 8 && Buffer.from(src.data).equals(Buffer.from(jarSprite.data));
const jarsOf = (bd) => floorItems(world, bd).filter((it) => it.kind === 'oil');
const jarBoard = boards.find(({ bd }) => jarsOf(bd).length > 1);

test('a scene draws the jar sprite at each untaken jar\'s floor point, before the light map, and none for a taken one', () => {
  assert.ok(jarBoard, 'the sample holds a board with jars');
  const { bd } = jarBoard;
  for (const { cell } of jarsOf(bd)) {
    const [wx, wy] = itemSpot(bd, cell);
    const cam = { x: wx, y: wy + 18 };
    const cx = Math.round(cam.x), cy = Math.round(cam.y);
    // The 7x8 sprite rests on the floor point: bottom row at the point's pixel row.
    const want = [Math.round(wx) - cx + 160 - 3, cy - Math.round(wy) + 90 - 8];
    const drawn = (sim) => { renderBoard(bd, sim, cam, 0); return view.draws.filter(isJar).map(([, x, y]) => [x, y]); };
    const sim = createSim(world, { board: bd, cell: bd.a });
    assert.ok(drawn(sim).some(([x, y]) => x === want[0] && y === want[1]), `jar at cell ${cell} drawn at ${want}`);
    assert.ok(drawn(null).some(([x, y]) => x === want[0] && y === want[1]), 'a scene with no explorer draws it too');
    renderBoard(bd, sim, cam, 0);
    const lit = view.draws.findIndex(([src, ...a]) => src.width === 80 && src.height === 45 && a.length === 4);
    const jar = view.draws.findIndex(isJar);
    assert.ok(jar >= 0 && lit > jar, `jar draw ${jar} precedes the light map draw ${lit}`);
    sim.jars.add(`${bd.x},${bd.y},${cell}`);
    assert.ok(!drawn(sim).some(([x, y]) => x === want[0] && y === want[1]), `taken jar at cell ${cell} is gone`);
    // A collected coin key never hides a jar: the two sets are separate.
    const other = createSim(world, { board: bd, cell: bd.a }, null, { collected: new Set([`${bd.x},${bd.y},${cell}`]) });
    assert.ok(drawn(other).some(([x, y]) => x === want[0] && y === want[1]), 'the coin set does not take the jar');
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
