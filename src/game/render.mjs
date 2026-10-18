// Canvas rendering at 320x180: board pre-renders, 0.5x parallax glyph wall,
// sprites, a quarter-resolution light map multiplied over the scene, dust.
import {
  PALETTE, RGB, idx, EXPLORER, torchTip, ROCK, WALL, GLYPHS, LADDER, SCONCE, SCONCE_FLAME,
  BRAZIER, COIN, JAR, FLAME, TORCH, FONT, FONT_W, FONT_H, ARROWS, SKELETONS,
} from './art.mjs';
import { BOARD_W, BOARD_H, nodeXY, torchRadius, SCONCE_R, feet, pose, BURN_S } from './sim.mjs';
import { BW, BH, DX, DY } from '../world/board.mjs';
import { arrows, arrowSide, skeletons, boostSkeletons, skeletonSide } from '../world/signs.mjs';
import { boardOfPos } from '../world/world.mjs';
import { floorItems, itemSpot, coinRows, rowSpot, ROW_COINS } from '../world/floor.mjs';
import { windDir, windBranches } from '../world/wind.mjs';
import { coinId } from './wallet.mjs';
import { boardMask } from './mask.mjs';
import { fixtureSets, eachMote, arrowSpot, skeletonSpot, skeletonPose } from './fixtures.mjs';
import { mapCells } from './map.mjs';

export const VIEW_W = 320;
export const VIEW_H = 180;
const LIGHT_W = VIEW_W / 4;
const LIGHT_H = VIEW_H / 4;
const FLAME_R = 80;
// Brazier flicker amplitudes; the light reach below is built from them.
const BRAZIER_FLICKER_A = 0.08;
const BRAZIER_FLICKER_B = 0.04;
// The farthest any light reaches: a brazier's radius at its peak flicker, the
// larger of the brazier's and the sconce's.
const LIGHT_REACH = FLAME_R * (1 + BRAZIER_FLICKER_A + BRAZIER_FLICKER_B);
const AMBIENT = [12, 9, 22];
// The warm step reaches this many boards past the view, one more than the art
// window, and does this many units of world work a frame (spec section 9).
const WARM_REACH = 2;
const WARM_UNITS = 2;
const WARM_MAX = 64;
// Dust fill styles by thousandth of opacity; a mote is at most 0.7 opaque.
const DUST_STYLE = Array.from({ length: 701 }, (_, k) => `rgba(255,226,170,${(k / 1000).toFixed(3)})`);
export const MAP_SCALE = 3;
// Seconds of burn below half over which tier-2 skeletons fade in.
export const BOOST_FADE_S = 10;

/** Opacity of the tier-2 skeletons at `burn`: 0 at half the torch, 1 BOOST_FADE_S below it. */
export function boostAlpha(burn) {
  return Math.min(1, Math.max(0, (BURN_S / 2 - burn) / BOOST_FADE_S));
}
// Dust drift in a windy branch (spec section 8): world px/s, reached and
// shed within a second, and the longest frame step the game loop allows.
export const WIND_SPEED = 12;
const MAX_FRAME_S = 0.25;

/** CSS colour of palette character `ch`. */
function pal(ch) {
  return PALETTE[idx(ch)];
}

/** Palette colour 0 (deepest violet) at opacity `alpha`. */
export function shade(alpha) {
  return `rgba(${RGB[0].join(',')},${alpha})`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Canvas of a palette-indexed sprite; `map` swaps characters. */
export function spriteCanvas(rows, flip = false, map = null) {
  const h = rows.length, w = rows[0].length;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ch = rows[y][flip ? w - 1 - x : x];
      if (map && map[ch]) ch = map[ch];
      const k = idx(ch);
      if (k < 0) continue;
      const o = (y * w + x) * 4;
      img.data[o] = RGB[k][0]; img.data[o + 1] = RGB[k][1]; img.data[o + 2] = RGB[k][2]; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function hash3(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// Rock tiles as palette indices, 16 rows of 16, and packed RGBA words, so the
// shading writes one word a pixel.
const TILES = ROCK.map((tile) => Uint8Array.from(tile.join(''), (ch) => idx(ch)));
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const packRGBA = ([r, g, b], a) => (LITTLE_ENDIAN ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
const ROCK_WORD = RGB.map((c) => packRGBA(c, 255));
// The shadow alphas the air rules produce.
const AIR_WORD = Object.fromEntries([0, 40, 50, 80, 95, 150].map((a) => [a, packRGBA(RGB[0], a)]));
// Palette indices of the rock edges: top face, top shade, floor face, floor shade, side.
const [K_TOP, K_TOP2, K_BOT, K_BOT2, K_SIDE] = ['b', 'a', '6', '7', '8'].map(idx);
// The grids hold the board with a PAD px border of its clamped edge, the
// shading's widest reach.
const PAD = 3;
const GRID_W = BOARD_W + 2 * PAD;
const solidGrid = new Uint8Array(GRID_W * (BOARD_H + 2 * PAD));
const filledGrid = new Uint8Array(solidGrid.length);

/** Fills `grid` with the union of the masks `a` and, when given, `b` and `c`, edge-clamped. */
function fillGrid(grid, a, b, c) {
  for (let y = -PAD; y < BOARD_H + PAD; y++) {
    const src = Math.min(BOARD_H - 1, Math.max(0, y)) * BOARD_W, row = (y + PAD) * GRID_W + PAD;
    if (b) for (let x = 0; x < BOARD_W; x++) grid[row + x] = a[src + x] | b[src + x] | c[src + x];
    else for (let x = 0; x < BOARD_W; x++) grid[row + x] = a[src + x];
    for (let k = 1; k <= PAD; k++) {
      grid[row - k] = grid[row];
      grid[row + BOARD_W - 1 + k] = grid[row + BOARD_W - 1];
    }
  }
}

/** Writes the board's pixels into `data`: the rock and shadow rules of `shadeMask` over its masks. */
function shadePixels(data, mask, p, stairs, ledge) {
  const words = new Uint32Array(data.buffer, data.byteOffset, BOARD_W * BOARD_H);
  fillGrid(solidGrid, mask);
  if (stairs) fillGrid(filledGrid, mask, stairs, ledge);
  const solid = solidGrid, filled = stairs ? filledGrid : solidGrid;
  const tiles = new Array(BOARD_W >> 4);
  for (let y = 0; y < BOARD_H; y++) {
    const row = (y & 15) << 4;
    if (row === 0) for (let tx = 0; tx < tiles.length; tx++) tiles[tx] = TILES[hash3(tx, y >> 4, p) % TILES.length];
    for (let x = 0; x < BOARD_W; x++) {
      const q = (y + PAD) * GRID_W + x + PAD;
      if (filled[q]) {
        let k;
        if (!filled[q - GRID_W]) k = K_TOP;
        else if (!filled[q - 2 * GRID_W]) k = K_TOP2;
        else if (!filled[q + GRID_W]) k = K_BOT;
        else if (!filled[q + 2 * GRID_W]) k = K_BOT2;
        else if (!filled[q - 1] || !filled[q + 1]) k = K_SIDE;
        else k = tiles[x >> 4][row | (x & 15)];
        words[y * BOARD_W + x] = ROCK_WORD[k];
      } else {
        let a = 0;
        if (solid[q - GRID_W]) a = 150; else if (solid[q - 2 * GRID_W]) a = 95; else if (solid[q - 3 * GRID_W]) a = 50;
        if (solid[q - 1] || solid[q + 1]) a = Math.max(a, 80);
        else if (solid[q - 2] || solid[q + 2]) a = Math.max(a, 40);
        words[y * BOARD_W + x] = AIR_WORD[a];
      }
    }
  }
}

export function createRenderer(canvas, world) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // One buffer serves every board: putImageData copies it.
  let shadeImg = null;
  const sprites = {};
  for (const [name, frames] of Object.entries(EXPLORER)) {
    sprites[name] = frames.map((f) => [spriteCanvas(f), spriteCanvas(f, true)]);
  }
  const ladder = spriteCanvas(LADDER);
  const sconce = spriteCanvas(SCONCE);
  const arrowGlyphs = ARROWS.map((rows) => spriteCanvas(rows));
  const skeletonSprites = SKELETONS.map((rows) => [spriteCanvas(rows), spriteCanvas(rows, true)]);
  const boostCache = new WeakMap();
  const sconceFlames = SCONCE_FLAME.map((f) => spriteCanvas(f));
  const brazier = spriteCanvas(BRAZIER);
  const coin = spriteCanvas(COIN);
  const jar = spriteCanvas(JAR);
  const flames = FLAME.map((f) => spriteCanvas(f));
  const torches = TORCH.map((f) => spriteCanvas(f));
  const ember = spriteCanvas(['.n.', 'nop', '.n.']);
  const background = buildBackground();
  const rockCanvas = buildBoardCanvas(null);
  const boards = new Map();
  const light = makeCanvas(LIGHT_W, LIGHT_H);
  const lightCtx = light.getContext('2d');
  const lightImg = lightCtx.createImageData(LIGHT_W, LIGHT_H);
  const acc = new Float32Array(LIGHT_W * LIGHT_H * 3);
  const glyphCache = new Map();
  // The dust lattice's offset and velocity in world px, and the last frame time.
  const drift = { ox: 0, oy: 0, vx: 0, vy: 0, last: null };

  function buildBackground() {
    const size = 128;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const plaster = spriteCanvas(WALL[0]);
    const glyphs = GLYPHS.map((rows) => spriteCanvas(rows));
    for (let ty = 0; ty < size / 16; ty++) {
      for (let tx = 0; tx < size / 16; tx++) {
        g.drawImage(plaster, tx * 16, ty * 16);
        g.fillStyle = pal('d');
        g.fillRect(tx * 16 + 2, ty * 16 + 2, 12, 12);
        if (ty % 4 === 3) {
          g.fillStyle = pal('7');
          g.fillRect(tx * 16, ty * 16 + 12, 16, 2);
          g.fillStyle = pal('l');
          g.fillRect(tx * 16, ty * 16 + 13, 16, 1);
        } else if (hash3(tx, ty, 7) % 3 !== 0) {
          g.drawImage(glyphs[hash3(tx, ty, 11) % glyphs.length], tx * 16, ty * 16);
        }
      }
    }
    // The back wall renders at half brightness.
    g.fillStyle = shade(0.5);
    g.fillRect(0, 0, size, size);
    return c;
  }

  /** Skeleton spots of the junctions `list` of board `bd`. */
  function skeletonSpots(bd, list) {
    return list.map(({ cell, dir }) => skeletonSpot(cell, skeletonSide(world, bd, cell, dir), dir));
  }

  /** Ladders, stairs, sconces, arrows, tier-1 skeletons and braziers of board `bd`, in board pixels. */
  function boardFixtures(bd, mask) {
    if (!bd) return { flights: [], stairs: null, ledge: null, ladders: [], sconces: [], arrows: [], skeletons: [], braziers: [] };
    const fx = fixtureSets(bd, mask);
    fx.arrows = arrows(world, bd).map(({ cell, dir }) => arrowSpot(cell, arrowSide(world, bd, cell), dir));
    fx.skeletons = skeletonSpots(bd, skeletons(world, bd));
    fx.braziers = world.flamesAt(bd.x, bd.y).map((cell) => nodeXY({ x: 0, y: 0 }, cell));
    return fx;
  }

  /**
   * Rock and shadow pixels from the mask, so every opening drawn is a tree
   * link or a door. `p` picks the rock tile variants. The `stairs` and
   * `ledge` pixels shade as rock, so a tread takes the floor's highlight and
   * a riser the side edge; air shadows read the mask alone, so none falls
   * from a stair or ledge.
   */
  function shadeMask(g, mask, p, stairs, ledge) {
    if (!shadeImg) shadeImg = g.createImageData(BOARD_W, BOARD_H);
    shadePixels(shadeImg.data, mask, p, stairs, ledge);
    g.putImageData(shadeImg, 0, 0);
  }

  /** Sprite canvas of a skeleton spot [x, yTop, dir, side]. */
  function skeletonSprite([, , dir, side]) {
    const { pose, flip } = skeletonPose(side, dir);
    return skeletonSprites[pose][flip ? 1 : 0];
  }

  /** The tier-2 skeleton spots of board `bd`, built once per board object. */
  function boostSpots(bd) {
    let spots = boostCache.get(bd);
    if (!spots) {
      spots = skeletonSpots(bd, boostSkeletons(world, bd));
      boostCache.set(bd, spots);
    }
    return spots;
  }

  function drawFixtures(g, fx) {
    const toY = (y) => BOARD_H - y;
    for (const [x, y0, y1] of fx.ladders) {
      for (let y = y0; y < y1; y += 8) {
        const h = Math.min(8, y1 - y);
        g.drawImage(ladder, 0, 0, 16, h, x, toY(y + h), 16, h);
      }
    }
    for (const [x, y] of fx.sconces) g.drawImage(sconce, x - 4, toY(y));
    for (const [x, yTop, dir] of fx.arrows) g.drawImage(arrowGlyphs[dir], x, toY(yTop + 1));
    for (const spot of fx.skeletons) g.drawImage(skeletonSprite(spot), spot[0], toY(spot[1] + 1));
  }

  function buildBoardCanvas(bd) {
    const c = makeCanvas(BOARD_W, BOARD_H);
    const g = c.getContext('2d');
    const mask = boardMask(bd);
    const fx = boardFixtures(bd, mask);
    shadeMask(g, mask, bd ? bd.p : 0, fx.stairs, fx.ledge);
    drawFixtures(g, fx);
    return { canvas: c, sconces: fx.sconces, braziers: fx.braziers };
  }

  function boardArt(bx, by) {
    const bd = world.board(bx, by);
    if (!bd.links) return null;
    let art = boards.get(bd.p);
    if (!art) { art = buildBoardCanvas(bd); boards.set(bd.p, art); }
    return art;
  }

  // The warm window sorted nearest the camera first, in preallocated arrays:
  // an idle frame allocates nothing.
  const warmX = new Int32Array(WARM_MAX), warmY = new Int32Array(WARM_MAX), warmD = new Float64Array(WARM_MAX);
  const windDone = new WeakSet();

  /**
   * Spends WARM_UNITS of world work on the boards within WARM_REACH of the
   * view, nearest the camera first and by row then column among equals: each
   * board's units, then its wind if it is a route board.
   */
  function warmAhead(cam) {
    const bx0 = Math.floor((cam.x - VIEW_W / 2) / BOARD_W) - WARM_REACH, bx1 = Math.floor((cam.x + VIEW_W / 2) / BOARD_W) + WARM_REACH;
    const by0 = Math.floor((cam.y - VIEW_H / 2) / BOARD_H) - WARM_REACH, by1 = Math.floor((cam.y + VIEW_H / 2) / BOARD_H) + WARM_REACH;
    let n = 0;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const d = Math.abs((bx + 0.5) * BOARD_W - cam.x) + Math.abs((by + 0.5) * BOARD_H - cam.y);
        let k = n++;
        for (; k > 0 && warmD[k - 1] > d; k--) { warmX[k] = warmX[k - 1]; warmY[k] = warmY[k - 1]; warmD[k] = warmD[k - 1]; }
        warmX[k] = bx; warmY[k] = by; warmD[k] = d;
      }
    }
    let units = WARM_UNITS;
    for (let k = 0; k < n; k++) {
      const bx = warmX[k], by = warmY[k];
      while (!world.warm(bx, by)) if (--units <= 0) return;
      const bd = world.board(bx, by);
      if (bd.kind === 'route' && !windDone.has(bd)) {
        windBranches(world, bd);
        windDone.add(bd);
        if (--units <= 0) return;
      }
    }
  }

  /** Warms the world ahead, builds one board's art within one board of the view, and drops distant art. */
  function prepare(cam, budget = 1) {
    warmAhead(cam);
    const bx0 = Math.floor((cam.x - VIEW_W / 2) / BOARD_W) - 1, bx1 = Math.floor((cam.x + VIEW_W / 2) / BOARD_W) + 1;
    const by0 = Math.floor((cam.y - VIEW_H / 2) / BOARD_H) - 1, by1 = Math.floor((cam.y + VIEW_H / 2) / BOARD_H) + 1;
    for (let by = by0; by <= by1 && budget > 0; by++) {
      for (let bx = bx0; bx <= bx1 && budget > 0; bx++) {
        const bd = world.board(bx, by);
        if (bd.links && !boards.has(bd.p)) { boardArt(bx, by); budget--; }
      }
    }
    if (boards.size > 48) {
      for (const p of boards.keys()) {
        const { x, y } = boardOfPos(p);
        if (Math.abs(x * BOARD_W - cam.x) > 3 * BOARD_W || Math.abs(y * BOARD_H - cam.y) > 3 * BOARD_H) boards.delete(p);
      }
    }
  }

  function addLight(sx, sy, r, col, gain) {
    const lx0 = Math.max(0, Math.floor((sx - r) / 4)), lx1 = Math.min(LIGHT_W - 1, Math.floor((sx + r) / 4));
    const ly0 = Math.max(0, Math.floor((sy - r) / 4)), ly1 = Math.min(LIGHT_H - 1, Math.floor((sy + r) / 4));
    const r2 = r * r;
    for (let ly = ly0; ly <= ly1; ly++) {
      for (let lx = lx0; lx <= lx1; lx++) {
        const dx = lx * 4 + 2 - sx, dy = ly * 4 + 2 - sy;
        const q = 1 - (dx * dx + dy * dy) / r2;
        if (q <= 0) continue;
        const k = q * q * gain, o = (ly * LIGHT_W + lx) * 3;
        acc[o] += col[0] * k; acc[o + 1] += col[1] * k; acc[o + 2] += col[2] * k;
      }
    }
  }

  function glyph(ch, color) {
    const key = ch + color;
    let c = glyphCache.get(key);
    if (!c) {
      const rows = FONT[ch] || FONT['?'];
      c = spriteCanvas(rows, false, { '#': color });
      glyphCache.set(key, c);
    }
    return c;
  }

  /** Pixel-font text; align is 'left', 'center' or 'right'. */
  function text(str, x, y, color = 'c', { align = 'left', scale = 1, shadow = '0' } = {}) {
    str = String(str).toUpperCase();
    const w = (str.length * (FONT_W + 1) - 1) * scale;
    let x0 = align === 'center' ? Math.round(x - w / 2) : align === 'right' ? x - w : x;
    for (const ch of str) {
      if (shadow) ctx.drawImage(glyph(ch, shadow), x0 + scale, y + scale, FONT_W * scale, FONT_H * scale);
      ctx.drawImage(glyph(ch, color), x0, y, FONT_W * scale, FONT_H * scale);
      x0 += (FONT_W + 1) * scale;
    }
  }

  function panel(x, y, w, h) {
    ctx.fillStyle = shade(0.82);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = pal('l');
    ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h); ctx.fillRect(x + w - 1, y, 1, h);
    ctx.fillStyle = pal('k');
    ctx.fillRect(x + 2, y + 2, w - 4, 1); ctx.fillRect(x + 2, y + h - 3, w - 4, 1);
  }

  // Back wall offset is half the camera position, wrapped to its 128 px pattern.
  function drawBackground(cx, cy) {
    const bgx = -(((Math.floor(cx / 2) % 128) + 128) % 128), bgy = ((Math.floor(cy / 2) % 128) + 128) % 128 - 128;
    for (let y = bgy; y < VIEW_H; y += 128) for (let x = bgx; x < VIEW_W; x += 128) ctx.drawImage(background, x, y);
  }

  /** Draws every board in view, rock outside the band tree; returns the in-view boards that hold art. */
  function drawBoards(cx, cy, sx, sy) {
    const bx0 = Math.floor((cx - VIEW_W / 2) / BOARD_W), bx1 = Math.floor((cx + VIEW_W / 2) / BOARD_W);
    const by0 = Math.floor((cy - VIEW_H / 2) / BOARD_H), by1 = Math.floor((cy + VIEW_H / 2) / BOARD_H);
    const lit = [];
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const art = boardArt(bx, by);
        ctx.drawImage(art ? art.canvas : rockCanvas.canvas, sx(bx * BOARD_W), sy((by + 1) * BOARD_H));
        if (art) lit.push([bx, by, art]);
      }
    }
    return lit;
  }

  /**
   * Draws the items of the in-view boards resting on the floor: the dead-end
   * and row coins that `collected` (the run's set of coin ids) lacks and the
   * jars that `jars` (the run's taken set) lacks.
   */
  function drawItems(lit, sx, sy, collected, jars) {
    for (const [bx, by] of lit) {
      const bd = world.board(bx, by);
      for (const { cell, kind } of floorItems(world, bd)) {
        const taken = kind === 'coin' ? collected : jars;
        if (taken && taken.has(coinId(bd, cell))) continue;
        const [x, y] = itemSpot(bd, cell);
        if (kind === 'coin') ctx.drawImage(coin, Math.round(sx(x)) - 3, Math.round(sy(y)) - 6);
        else {
          // The 9 px jar fills room columns 8..16 at the west spot and 31..39 at the east.
          const east = x > nodeXY(bd, cell)[0];
          ctx.drawImage(jar, Math.round(sx(x)) - (east ? 5 : 4), Math.round(sy(y)) - 12);
        }
      }
      for (const cell of coinRows(world, bd)) {
        for (let i = 0; i < ROW_COINS; i++) {
          if (collected && collected.has(coinId(bd, cell, i))) continue;
          const [x, y] = rowSpot(bd, cell, i);
          ctx.drawImage(coin, Math.round(sx(x)) - 3, Math.round(sy(y)) - 6);
        }
      }
    }
  }

  /** Draws the tier-2 skeletons of the in-view boards at opacity `alpha`; they sit under the light map like the walls. */
  function drawBoost(lit, sx, sy, alpha) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    for (const [bx, by] of lit) {
      for (const spot of boostSpots(world.board(bx, by))) {
        ctx.drawImage(skeletonSprite(spot), sx(bx * BOARD_W + spot[0]), sy(by * BOARD_H + spot[1] + 1));
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Draws the sconce and brazier sprites of the in-view boards `lit`, and adds
   * the light of every sconce and brazier whose light reaches the view: those
   * of the boards within LIGHT_REACH of it, in view or not, so a light never
   * pops at a board seam. A light farther than its radius adds nothing and
   * every light centre lies inside its board, so the reach is exact.
   */
  function drawFlames(lit, cx, cy, sx, sy, t) {
    for (const [bx, by, art] of lit) {
      const wx = bx * BOARD_W, wy = by * BOARD_H;
      for (const [x, y] of art.sconces) {
        const f = sconceFlames[Math.floor(t * 8 + x) % 3];
        ctx.drawImage(f, Math.round(sx(wx + x)) - 4, Math.round(sy(wy + y + 4)));
      }
      for (const [x, y] of art.braziers) {
        ctx.drawImage(brazier, Math.round(sx(wx + x)) - 8, Math.round(sy(wy + y + 10)));
        ctx.drawImage(flames[Math.floor(t * 9 + x) % 4], Math.round(sx(wx + x)) - 6, Math.round(sy(wy + y + 21)));
      }
    }
    const bx0 = Math.floor((cx - VIEW_W / 2 - LIGHT_REACH) / BOARD_W), bx1 = Math.floor((cx + VIEW_W / 2 + LIGHT_REACH) / BOARD_W);
    const by0 = Math.floor((cy - VIEW_H / 2 - LIGHT_REACH) / BOARD_H), by1 = Math.floor((cy + VIEW_H / 2 + LIGHT_REACH) / BOARD_H);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const art = boardArt(bx, by);
        if (!art) continue;
        const wx = bx * BOARD_W, wy = by * BOARD_H;
        for (const [x, y] of art.sconces) {
          const fl = 1 + 0.06 * Math.sin(t * 13 + x);
          addLight(sx(wx + x), sy(wy + y + 2), SCONCE_R * fl, [255, 168, 92], 0.95);
        }
        for (const [x, y] of art.braziers) {
          const fl = 1 + BRAZIER_FLICKER_A * Math.sin(t * 9 + y) + BRAZIER_FLICKER_B * Math.sin(t * 23 + x);
          addLight(sx(wx + x), sy(wy + y + 14), FLAME_R * fl, [70, 255, 225], 1.1);
        }
      }
    }
  }

  /** Draws the explorer and adds the torch light; returns the torch tip on screen. */
  function drawExplorer(sim, sx, sy, t) {
    const [fx, fy] = feet(sim);
    const { anim, frame } = pose(sim);
    const flip = sim.facing < 0;
    const px = Math.round(sx(fx)) - 8, py = Math.round(sy(fy)) - 24;
    const [tx, ty] = torchTip(anim, frame);
    const tip = [px + (flip ? 15 - tx : tx), py + ty];
    ctx.drawImage(sprites[anim][frame][flip ? 1 : 0], px, py);
    if (sim.burn > 0) {
      ctx.drawImage(torches[Math.floor(t * 12) % 3], tip[0] - 2, tip[1] - 4);
      // Flicker amplitude grows as the burn falls.
      const amp = 1.5 + 7 * (1 - sim.burn / BURN_S);
      const flick = amp * (0.6 * Math.sin(t * 17.3) + 0.4 * Math.sin(t * 41.9 + 1.7));
      addLight(tip[0], tip[1], Math.max(4, torchRadius(sim.burn) + flick), [255, 196, 128], 1.25);
    } else {
      ctx.drawImage(ember, tip[0] - 1, tip[1] - 1);
      addLight(tip[0], tip[1], 8 + Math.sin(t * 20), [255, 110, 50], 1.2);
    }
    return tip;
  }

  // The light map multiplies the scene; only this upscale is smoothed.
  function applyLight() {
    const d = lightImg.data;
    for (let i = 0, o = 0; i < acc.length; i += 3, o += 4) {
      d[o] = AMBIENT[0] + acc[i]; d[o + 1] = AMBIENT[1] + acc[i + 1]; d[o + 2] = AMBIENT[2] + acc[i + 2]; d[o + 3] = 255;
    }
    lightCtx.putImageData(lightImg, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(light, 0, 0, VIEW_W, VIEW_H);
    ctx.restore();
    ctx.imageSmoothingEnabled = false;
  }

  /**
   * Draws the world around `cam` with the explorer `sim` (or none).
   * `t` is seconds of wall time, used for flicker and animation.
   */
  function scene(sim, cam, t) {
    const cx = Math.round(cam.x), cy = Math.round(cam.y);
    const sx = (wx) => wx - cx + VIEW_W / 2;
    const sy = (wy) => cy - wy + VIEW_H / 2;
    const unsx = (px) => px + cx - VIEW_W / 2;
    const unsy = (py) => cy - py + VIEW_H / 2;
    prepare(cam);
    acc.fill(0);
    drawBackground(cx, cy);
    const lit = drawBoards(cx, cy, sx, sy);
    drawItems(lit, sx, sy, sim ? sim.collected : null, sim ? sim.jars : null);
    if (sim) drawBoost(lit, sx, sy, boostAlpha(sim.burn));
    drawFlames(lit, cx, cy, sx, sy, t);
    const tip = sim ? drawExplorer(sim, sx, sy, t) : null;
    applyLight();
    if (tip) drawDust(sim, tip, t, sx, sy, unsx, unsy);
    return tip;
  }

  /**
   * Moves the dust offset by the wall time since the last frame, never
   * backward and at most one game-loop frame. The velocity turns toward the
   * wind of direction `d` (-1 for none) by at most WIND_SPEED per second.
   */
  function stepDrift(d, t) {
    const dt = drift.last === null ? 0 : Math.min(MAX_FRAME_S, Math.max(0, t - drift.last));
    drift.last = drift.last === null ? t : Math.max(drift.last, t);
    const k = d < 0 ? 0 : WIND_SPEED / Math.hypot(DX[d], DY[d]);
    let ex = (d < 0 ? 0 : DX[d] * k) - drift.vx, ey = (d < 0 ? 0 : DY[d] * k) - drift.vy;
    const m = Math.hypot(ex, ey), cap = WIND_SPEED * dt;
    if (m > cap) { ex *= cap / m; ey *= cap / m; }
    drift.vx += ex;
    drift.vy += ey;
    drift.ox += drift.vx * dt;
    drift.oy += drift.vy * dt;
  }

  // Motes hang in the world and show only inside the torch radius. One drift
  // carries them all, set by the explorer's cell.
  let dustTip = null, dustR = 0, dustSx = null, dustSy = null;

  /** Draws the mote at world (mx, my) when the torch lights it; allocates nothing. */
  function drawMote(mx, my) {
    const x = dustSx(mx), y = dustSy(my);
    const a = 1 - Math.hypot(x - dustTip[0], y - dustTip[1]) / (dustR * 0.9);
    if (a <= 0) return;
    const v = a * 0.7 * 1000, n = Math.round(v);
    // The table holds toFixed(3) away from a rounding tie, where the double decides.
    ctx.fillStyle = DUST_STYLE[n] !== undefined && Math.abs(v - n) < 0.4999 ? DUST_STYLE[n] : `rgba(255,226,170,${(a * 0.7).toFixed(3)})`;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }

  function drawDust(sim, tip, t, sx, sy, unsx, unsy) {
    stepDrift(windDir(world, sim.bd, sim.cell), t);
    const r = sim.burn > 0 ? torchRadius(sim.burn) : 8;
    const x0 = unsx(tip[0]), y0 = unsy(tip[1]);
    dustTip = tip; dustR = r; dustSx = sx; dustSy = sy;
    eachMote(x0 - r, y0 - r, x0 + r, y0 + r, t, drift.ox, drift.oy, drawMote);
  }

  /** The torch bar, TOMB n, and under it the wallet: the coin sprite, then the count growing leftward. */
  function hud(sim, wallet = 0) {
    const frac = sim.burn / BURN_S;
    ctx.fillStyle = pal('0');
    ctx.fillRect(5, 5, 62, 7);
    ctx.fillStyle = pal('k');
    ctx.fillRect(6, 6, 60, 5);
    ctx.fillStyle = pal('1');
    ctx.fillRect(7, 7, 58, 3);
    if (sim.burn > 0) {
      const w = Math.max(1, Math.round(58 * frac));
      ctx.fillStyle = pal(frac > 0.3 ? 'p' : frac > 0.1 ? 'o' : 'n');
      ctx.fillRect(7, 7, w, 3);
      ctx.fillStyle = pal('q');
      ctx.fillRect(7, 7, w, 1);
    } else if (Math.floor(sim.time * 4) % 2 === 0) {
      text('EMBER', 70, 5, 'o');
    }
    text(`TOMB ${sim.solved.size}`, VIEW_W - 5, 5, 'm', { align: 'right' });
    const count = String(wallet);
    text(count, VIEW_W - 5, 14, 'm', { align: 'right' });
    ctx.drawImage(coin, VIEW_W - 5 - (count.length * (FONT_W + 1) - 1) - 2 * (FONT_W + 1), 14);
  }

  /** Draws board outline `o` in the current fill, open at each crossed door. */
  function mapOutline(o, cellPx) {
    const S = MAP_SCALE, w = BW * S, h = BH * S;
    const [left, top] = cellPx(o.col, o.row + BH - 1);
    // A crossed door opens its cell's three pixels of the wall.
    const gapX = (d, px) => o.gaps.some((g) => g.d === d && px >= cellPx(g.col, g.row)[0] && px < cellPx(g.col, g.row)[0] + S);
    const gapY = (d, py) => o.gaps.some((g) => g.d === d && py >= cellPx(g.col, g.row)[1] && py < cellPx(g.col, g.row)[1] + S);
    for (let k = 0; k < w; k++) {
      if (!gapX(1, left + k)) ctx.fillRect(left + k, top, 1, 1);
      if (!gapX(3, left + k)) ctx.fillRect(left + k, top + h - 1, 1, 1);
    }
    for (let k = 0; k < h; k++) {
      if (!gapY(2, top + k)) ctx.fillRect(left, top + k, 1, 1);
      if (!gapY(0, top + k)) ctx.fillRect(left + w - 1, top + k, 1, 1);
    }
  }

  /**
   * Draws a map model of the world's tomb at 3 px per cell, top left at
   * (x, y); `t` is seconds since the pause began. A link joins the centre
   * pixels of its two cells and a stub stays inside its own cell.
   */
  function drawMap(model, x, y, t) {
    const S = MAP_SCALE;
    const { cols: MAP_COLS, rows: MAP_ROWS } = mapCells(world.size);
    // Top left pixel of a frame cell; rows run up the screen.
    const cellPx = (col, row) => [x + col * S, y + (MAP_ROWS - 1 - row) * S];
    const dot = (col, row, i, d, color) => {
      const [px, py] = cellPx(col, row);
      ctx.fillStyle = color;
      ctx.fillRect(px + 1 + i * DX[d], py + 1 - i * DY[d], 1, 1);
    };
    const block = (c, color) => {
      const [px, py] = cellPx(c.col, c.row);
      ctx.fillStyle = color;
      ctx.fillRect(px, py, S, S);
    };
    ctx.fillStyle = pal('0');
    ctx.fillRect(x, y, MAP_COLS * S, MAP_ROWS * S);
    ctx.fillStyle = pal('4');
    for (const o of model.outlines) mapOutline(o, cellPx);
    for (const s of model.stubs) for (let i = 0; i < 2; i++) dot(s.col, s.row, i, s.d, pal('7'));
    for (const l of model.lines) for (let i = 0; i <= 3; i++) dot(l.col, l.row, i, l.d, pal('b'));
    for (const f of model.flames) {
      block(f, pal('i'));
      dot(f.col, f.row, 0, 0, pal('j'));
    }
    // The dot shows first, so it is on screen when the pause begins.
    if (model.explorer && Math.floor(t * 3) % 2 === 0) block(model.explorer, pal('p'));
  }

  return { ctx, scene, hud, text, panel, prepare, drawMap };
}
