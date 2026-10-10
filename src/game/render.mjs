// Canvas rendering at 320x180: board pre-renders, 0.5x parallax glyph wall,
// sprites, a quarter-resolution light map multiplied over the scene, dust.
import {
  PALETTE, RGB, idx, EXPLORER, torchTip, ROCK, WALL, GLYPHS, LADDER, SCONCE, SCONCE_FLAME,
  BRAZIER, FLAME, TORCH, FONT, FONT_W, FONT_H,
} from './art.mjs';
import { BOARD_W, BOARD_H, CELL, nodeXY, torchRadius, SCONCE_R, feet, pose, BURN_S } from './sim.mjs';
import { BW, NCELL } from '../world/board.mjs';
import { boardOfPos } from '../world/world.mjs';
import { boardMask } from './mask.mjs';

export const VIEW_W = 320;
export const VIEW_H = 180;
const LIGHT_W = VIEW_W / 4;
const LIGHT_H = VIEW_H / 4;
const FLAME_R = 80;
const AMBIENT = [12, 9, 22];

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

export function createRenderer(canvas, world) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const sprites = {};
  for (const [name, frames] of Object.entries(EXPLORER)) {
    sprites[name] = frames.map((f) => [spriteCanvas(f), spriteCanvas(f, true)]);
  }
  const ladder = spriteCanvas(LADDER);
  const sconce = spriteCanvas(SCONCE);
  const sconceFlames = SCONCE_FLAME.map((f) => spriteCanvas(f));
  const brazier = spriteCanvas(BRAZIER);
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
  const dust = [];

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

  /** Ladders, stairs, sconces and braziers of board `bd`, in board pixels. */
  function boardFixtures(bd) {
    const stairs = [], ladders = [], sconces = [], braziers = [];
    if (!bd) return { stairs, ladders, sconces, braziers };
    for (let c = 0; c < NCELL; c++) {
      const X = (c % BW) * CELL, Y = ((c / BW) | 0) * CELL;
      const m = bd.links[c], doors = bd.doorMask[c];
      if (m & 2) ladders.push([X + 16, Y + 8, Y + 64]);
      if (doors & 2) ladders.push([X + 16, Y + 8, Y + 48]);
      if (doors & 8) ladders.push([X + 16, Y, Y + 14]);
      if (m & 16) stairs.push([X + 24, Y + 8, 1]);
      if (m & 32) stairs.push([X + 24, Y + 8, -1]);
      if (doors) sconces.push([doors & 4 ? X + 13 : doors & 1 ? X + 35 : X + 36, Y + 26]);
    }
    for (const cell of world.flamesAt(bd.x, bd.y)) braziers.push(nodeXY({ x: 0, y: 0 }, cell));
    return { stairs, ladders, sconces, braziers };
  }

  /**
   * Rock and shadow pixels from the mask alone, so every opening drawn is a
   * tree link or a door. `p` picks the rock tile variants.
   */
  function shadeMask(g, mask, p) {
    const W = BOARD_W, H = BOARD_H;
    const img = g.createImageData(W, H);
    const d = img.data;
    const solid = (x, y) => mask[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    const [ar, ag, ab] = RGB[0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (mask[y * W + x]) {
          const tile = ROCK[hash3(x >> 4, y >> 4, p) % ROCK.length];
          let ch = tile[y & 15][x & 15];
          if (!solid(x, y - 1)) ch = 'b';
          else if (!solid(x, y - 2)) ch = 'a';
          else if (!solid(x, y + 1)) ch = '6';
          else if (!solid(x, y + 2)) ch = '7';
          else if (!solid(x - 1, y) || !solid(x + 1, y)) ch = '8';
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
    g.putImageData(img, 0, 0);
  }

  function drawFixtures(g, fx) {
    const toY = (y) => BOARD_H - y;
    for (const [x, y0, y1] of fx.ladders) {
      for (let y = y0; y < y1; y += 8) {
        const h = Math.min(8, y1 - y);
        g.drawImage(ladder, 0, 0, 16, h, x, toY(y + h), 16, h);
      }
    }
    for (const [x0, y0, dir] of fx.stairs) {
      for (let i = 0; i < 48; i += 4) {
        const x = dir > 0 ? x0 + i : x0 - i - 4;
        const top = toY(y0 + i + 2);
        g.fillStyle = pal('b'); g.fillRect(x, top, 4, 1);
        g.fillStyle = pal('a'); g.fillRect(x, top + 1, 4, 2);
        g.fillStyle = pal('8'); g.fillRect(x, top + 3, 4, 2);
        g.fillStyle = pal('6'); g.fillRect(x, top + 5, 4, 1);
      }
    }
    for (const [x, y] of fx.sconces) g.drawImage(sconce, x - 4, toY(y));
  }

  function buildBoardCanvas(bd) {
    const c = makeCanvas(BOARD_W, BOARD_H);
    const g = c.getContext('2d');
    const fx = boardFixtures(bd);
    shadeMask(g, boardMask(bd), bd ? bd.p : 0);
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

  /** Builds boards within one board of the view; drops distant ones. */
  function prepare(cam, budget = 1) {
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

  /** Draws every board in view, rock outside the band tree; returns the lit boards. */
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

  function drawFlames(lit, sx, sy, t) {
    for (const [bx, by, art] of lit) {
      const wx = bx * BOARD_W, wy = by * BOARD_H;
      for (const [x, y] of art.sconces) {
        const f = sconceFlames[Math.floor(t * 8 + x) % 3];
        ctx.drawImage(f, Math.round(sx(wx + x)) - 4, Math.round(sy(wy + y + 4)));
        const fl = 1 + 0.06 * Math.sin(t * 13 + x);
        addLight(sx(wx + x), sy(wy + y + 2), SCONCE_R * fl, [255, 168, 92], 0.95);
      }
      for (const [x, y] of art.braziers) {
        ctx.drawImage(brazier, Math.round(sx(wx + x)) - 8, Math.round(sy(wy + y + 10)));
        ctx.drawImage(flames[Math.floor(t * 9 + x) % 4], Math.round(sx(wx + x)) - 6, Math.round(sy(wy + y + 21)));
        const fl = 1 + 0.08 * Math.sin(t * 9 + y) + 0.04 * Math.sin(t * 23 + x);
        addLight(sx(wx + x), sy(wy + y + 14), FLAME_R * fl, [70, 255, 225], 1.1);
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
    prepare(cam);
    acc.fill(0);
    drawBackground(cx, cy);
    const lit = drawBoards(cx, cy, sx, sy);
    drawFlames(lit, sx, sy, t);
    const tip = sim ? drawExplorer(sim, sx, sy, t) : null;
    applyLight();
    if (tip) drawDust(sim, tip, t);
    return tip;
  }

  // Motes show only inside the torch radius.
  function drawDust(sim, tip, t) {
    if (dust.length === 0) {
      for (let i = 0; i < 48; i++) dust.push({ x: (hash3(i, 1, 2) % 200) - 100, y: (hash3(i, 3, 4) % 120) - 60, v: 2 + (hash3(i, 5, 6) % 7), ph: hash3(i, 7, 8) % 628 });
    }
    const r = sim.burn > 0 ? torchRadius(sim.burn) : 8;
    for (const m of dust) {
      const x = tip[0] + ((m.x + Math.sin(t * 0.7 + m.ph / 100) * 6 + 200) % 200) - 100;
      const y = tip[1] + ((m.y + t * m.v + 120) % 120) - 60;
      const dist = Math.hypot(x - tip[0], y - tip[1]);
      const a = 1 - dist / (r * 0.9);
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(255,226,170,${(a * 0.7).toFixed(3)})`;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }

  function hud(sim) {
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
    // The score: the farthest ring reached, max(|u|, |v|).
    text(`TOMB ${sim.maxRing}`, VIEW_W - 5, 5, 'm', { align: 'right' });
  }

  return { ctx, scene, hud, text, panel, prepare };
}
