// The board-crossing hitch: board art shades fast and byte for byte, the
// world warms ahead of the camera, and a frame allocates little.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import { createWorld, boardCoords, tombOf } from '../src/world/world.mjs';
import { windDir } from '../src/world/wind.mjs';
import { boardMask } from '../src/game/mask.mjs';
import { fixtureSets, dustMotes } from '../src/game/fixtures.mjs';
import { createRenderer } from '../src/game/render.mjs';
import { RGB, idx, ROCK } from '../src/game/art.mjs';
import { BOARD_W, BOARD_H, BURN_S, createSim, step, inputEdges, feet, feetX, feetY, torchRadius } from '../src/game/sim.mjs';
import { createAutopilot } from '../src/game/autopilot.mjs';
import { tombItems, packRecent } from '../src/game/wallet.mjs';
import { DX, DY } from '../src/world/board.mjs';
import { floorItems, coinRows } from '../src/world/floor.mjs';
import { createFrame, placeFrame, deviceX, deviceY, deviceSpan, blendTicks, blendsTicks } from '../src/game/camera.mjs';

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

/**
 * A canvas that does no pixel work; with `copy` it keeps the last
 * `putImageData` pixels on `canvas.shaded`, with `fills` it logs each fillRect.
 */
function nullCanvas(copy = false, fills = null) {
  const canvas = { width: 0, height: 0, shaded: null };
  const ctx = {
    canvas, fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    save() {}, restore() {}, drawImage() {}, clearRect() {},
    fillRect(x, y, w, h) { if (fills) fills.push([x, y, w, h, ctx.fillStyle]); },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img) {
      shades++;
      if (copy) canvas.shaded = Uint8ClampedArray.from(img.data);
    },
  };
  canvas.getContext = () => ctx;
  return canvas;
}

/** A null canvas the size of a fractional 8.6x display; with `fills` it logs each fillRect. */
function display(fills = null) {
  const d = nullCanvas(false, fills);
  d.width = 2752;
  d.height = 1548;
  return d;
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
      const renderer = createRenderer(nullCanvas(), world, display());
      // The world layer draws the boards.
      const draws = [];
      renderer.layers.world.getContext().drawImage = (src) => draws.push(src);
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
        const renderer = createRenderer(view, world, display());
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

/** The most boards a frame builds over five walks across a seam at `difficulty`, and the seams crossed. */
function seamWalks(difficulty) {
  let peak = 0, seams = 0;
  const walks = [
    ['east', 1, 0, 96, 'w'], ['west', -1, 0, 96, 'w'], ['north', 0, 1, 48, 'h'], ['south', 0, -1, 48, 'h'], ['fall', 0, -1, 300, 'h'],
  ];
  withDocument(() => nullCanvas(), () => {
    for (const [, dx, dy, speed, span] of walks) {
      const world = createWorld(CODE, { difficulty });
      const renderer = createRenderer(nullCanvas(), world, display());
      const tombW = world.size.w * BOARD_W, tombH = world.size.h * BOARD_H;
      const cam = { x: tombW / 2, y: 2 * tombH + tombH / 2 };
      const tombAt = () => tombOf(Math.floor(cam.x / BOARD_W), Math.floor(cam.y / BOARD_H), world.size);
      let at = tombAt();
      world.retain(at.u, at.v);
      const frame = (t) => {
        const before = world.boardsBuilt();
        const now = tombAt();
        if (now.u !== at.u || now.v !== at.v) { at = now; world.retain(at.u, at.v); seams++; }
        renderer.scene(null, cam, t);
        const bd = world.board(Math.floor(cam.x / BOARD_W), Math.floor(cam.y / BOARD_H));
        windDir(world, bd, 0);
        return world.boardsBuilt() - before;
      };
      let t = 0;
      for (let f = 0; f < 900; f++, t += 1 / 60) frame(t);
      seams = 0;
      const frames = Math.ceil((1.5 * (span === 'w' ? tombW : tombH)) / (speed / 60));
      for (let f = 0; f < frames; f++, t += 1 / 60) {
        cam.x += dx * speed / 60;
        cam.y += dy * speed / 60;
        peak = Math.max(peak, frame(t));
      }
      assert.ok(seams > 0, `the ${difficulty} walk crosses a seam`);
    }
  });
  return peak;
}

for (const difficulty of LEVELS) {
  test(`no frame of the ${difficulty} seam walks builds more than six boards`, () => {
    const peak = seamWalks(difficulty);
    assert.ok(peak <= 6, `peak ${peak} boards in a frame`);
  });
}

test('warm finishes a board and its flames in a few units without changing any result', () => {
  const world = createWorld(CODE, { difficulty: 'ultimate' }), twin = createWorld(CODE, { difficulty: 'ultimate' });
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(0, 2, i, world.size);
    let calls = 0;
    while (!world.warm(x, y)) assert.ok(++calls <= 200, `board ${x},${y} still cold after ${calls} units`);
    const built = world.boardsBuilt();
    assert.deepEqual(world.flamesAt(x, y), twin.flamesAt(x, y), `flames of ${x},${y}`);
    assert.equal(world.boardsBuilt(), built, 'flamesAt builds nothing after warm');
    assert.equal(world.warm(x, y), true);
    assert.equal(world.boardsBuilt(), built, 'a warm board builds nothing');
  }
});

test('boardsBuilt counts a board again after retain drops it', () => {
  const world = createWorld(CODE, { difficulty: 'easy' });
  assert.equal(world.boardsBuilt(), 0);
  world.board(0, 0);
  world.board(0, 0);
  assert.equal(world.boardsBuilt(), 1);
  world.retain(5, 5);
  world.board(0, 0);
  assert.equal(world.boardsBuilt(), 2);
});

const allocated = () => v8.getHeapStatistics().total_allocated_bytes;

test('an idle prepare allocates under 256 bytes', () => {
  withDocument(() => nullCanvas(), () => {
    const world = createWorld(CODE, { difficulty: 'ultimate' });
    const renderer = createRenderer(nullCanvas(), world, display());
    const bd = world.startPoint().board;
    const cam = centre(bd);
    for (let i = 0; i < 5000; i++) renderer.prepare(cam);
    const built = world.boardsBuilt(), put = shades;
    const per = [];
    for (let w = 0; w < 3; w++) {
      const before = allocated();
      for (let i = 0; i < 5000; i++) renderer.prepare(cam);
      per.push((allocated() - before) / 5000);
    }
    assert.equal(world.boardsBuilt(), built, 'the window was warm');
    assert.equal(shades, put, 'the art was built');
    assert.ok(Math.min(...per) < 256, `${per.map((b) => b.toFixed(0))} bytes a call`);
  });
});

/** A sim standing at the world's start point with `burn` seconds of torch, and a camera on it. */
function explorer(world, burn) {
  const sim = createSim(world, world.startPoint());
  sim.burn = burn;
  const [x, y] = feet(sim);
  return { sim, cam: { x, y } };
}

test('a steady play frame allocates under 8 KB', (t) => {
  withDocument(() => nullCanvas(), () => {
    const world = createWorld(CODE, { difficulty: 'medium' });
    const renderer = createRenderer(nullCanvas(), world, display());
    const { sim, cam } = explorer(world, 300);
    // The holders createGame builds once: the tick snapshot and the drawn camera and feet.
    const prev = { x: cam.x, y: cam.y, fx: feetX(sim), fy: feetY(sim), visit: 1 }, drawn = { x: 0, y: 0, fx: 0, fy: 0 };
    // Every draw of a play frame between ticks: the blend, the layers, the composite and the HUD.
    const frame = (f) => {
      const fx = feetX(sim), fy = feetY(sim);
      if (blendsTicks(prev, 'play', 1, fx, fy, 0.5)) blendTicks(drawn, prev, cam, fx, fy, 0.5);
      renderer.scene(sim, drawn, f / 60, drawn.fx, drawn.fy);
      renderer.composite();
      renderer.hud(sim, 0);
    };
    for (let f = 0; f < 5000; f++) frame(f);
    const before = allocated();
    for (let f = 5000; f < 10000; f++) frame(f);
    const per = (allocated() - before) / 5000;
    t.diagnostic(`${per.toFixed(0)} bytes a frame`);
    assert.ok(per < 8192, `${per.toFixed(0)} bytes a frame`);
  });
});

test('the dust draws the motes dustMotes lists, each with the toFixed(3) fill', () => {
  withDocument(() => nullCanvas(), () => {
    const world = createWorld(CODE, { difficulty: 'medium' });
    for (const burn of [300, 150, 40]) {
      const fills = [];
      const renderer = createRenderer(nullCanvas(), world, display(fills));
      const { sim, cam } = explorer(world, burn);
      assert.equal(windDir(world, sim.bd, sim.cell), -1, 'no wind, so the dust does not drift');
      const frame = createFrame();
      placeFrame(frame, cam, 2752, 1548, 320, 180);
      let drawn = 0;
      for (let f = 0; f < 600; f++) {
        const t = f / 60;
        fills.length = 0;
        const tip = renderer.scene(sim, cam, t);
        renderer.composite();
        const r = torchRadius(burn);
        // The torch tip in world px.
        const x0 = (tip[0] - frame.ox) / frame.sx, y0 = (frame.oy - tip[1]) / frame.sy;
        const want = [];
        for (const m of dustMotes(x0 - r, y0 - r, x0 + r, y0 + r, t, 0, 0)) {
          const a = 1 - Math.hypot(m.x - x0, m.y - y0) / (r * 0.9);
          // One game px, its top-left corner at the mote, each edge rounded once.
          const x = deviceX(frame, m.x), y = deviceY(frame, m.y);
          if (a > 0) want.push([Math.round(x), Math.round(y), deviceSpan(x, frame.sx), deviceSpan(y, frame.sy), `rgba(255,226,170,${(a * 0.7).toFixed(3)})`]);
        }
        const got = fills.filter((fill) => fill[4].startsWith('rgba(255,226,170,'));
        assert.deepEqual(got, want, `burn ${burn}, frame ${f}`);
        drawn += want.length;
      }
      assert.ok(drawn > 600, `burn ${burn} draws ${drawn} motes`);
    }
  });
});

test('the drawn feet move the torch tip and the explorer blit by d device px a game px from the sim\'s feet', (t) => {
  withDocument(() => nullCanvas(), () => {
    const world = createWorld(CODE, { difficulty: 'medium' });
    const screen = display();
    const renderer = createRenderer(nullCanvas(), world, screen);
    const { sim, cam } = explorer(world, 300);
    // The explorer's body blit: the first composite draw that is none of the layers.
    const layers = new Set(Object.values(renderer.layers));
    let body = null;
    screen.getContext().drawImage = (img, x, y) => { if (!layers.has(img) && body === null) body = [x, y]; };
    const draw = (...feetAt) => {
      body = null;
      const tip = renderer.scene(sim, cam, 0, ...feetAt);
      renderer.composite();
      return { tip, body };
    };
    const fx = feetX(sim), fy = feetY(sim), sx = 2752 / 320;
    const at = draw(fx, fy);
    assert.deepEqual(draw(), at, 'scene defaults to the sim\'s feet');
    const seen = [];
    for (const [dx, dy] of [[0.5, 0], [3, 0], [-7.25, 0], [0, 2.5], [1.5, -4]]) {
      const moved = draw(fx + dx, fy + dy);
      const tip = [moved.tip[0] - at.tip[0], moved.tip[1] - at.tip[1]], blit = [moved.body[0] - at.body[0], moved.body[1] - at.body[1]];
      seen.push(`(${dx}, ${dy}): tip ${tip.map((v) => v.toFixed(2))}, blit ${blit}`);
      // y runs down the display.
      const want = [dx * sx, -dy * sx];
      for (const i of [0, 1]) {
        assert.ok(Math.abs(tip[i] - want[i]) <= 1, `feet (${dx}, ${dy}) move the tip ${tip} device px, want ${want}`);
        assert.ok(Math.abs(blit[i] - want[i]) <= 1, `feet (${dx}, ${dy}) move the blit ${blit} device px, want ${want}`);
      }
    }
    t.diagnostic(seen.join('; '));
  });
});

const seeds = (n) => Array.from({ length: n }, (_, i) => `0000000${i}`);

for (const difficulty of LEVELS) {
  test(`createSim without a carry builds no board at ${difficulty}`, () => {
    for (const code of seeds(8)) {
      const world = createWorld(code, { difficulty });
      const start = world.startPoint();
      const built = world.boardsBuilt();
      createSim(world, start);
      assert.equal(world.boardsBuilt(), built, `seed ${code}`);
    }
  });
}

/** Builds every board of the tombs within one tomb of (u, v). */
function buildAround(world, u, v) {
  for (let dv = -1; dv <= 1; dv++) {
    for (let du = -1; du <= 1; du++) {
      for (let i = 0; i < world.size.w * world.size.h; i++) {
        const { x, y } = boardCoords(u + du, v + dv, i, world.size);
        world.board(x, y);
      }
    }
  }
}

/**
 * A world with every board around tomb (0, 0) and the tomb B its exit leads to built, and the cell `across` that
 * exit door. The scan of the board holding `across`, which the step onto it makes whatever a sim does, is cached.
 */
function crossingWorld(code, difficulty) {
  const world = createWorld(code, { difficulty });
  const d = world.exit(0, 0), b = { u: DX[d], v: DY[d] };
  const across = world.tombFlames(0, 0).chains[0].at(-1);
  buildAround(world, 0, 0);
  buildAround(world, b.u, b.v);
  const onto = world.board(across.x, across.y);
  floorItems(world, onto);
  coinRows(world, onto);
  return { world, across, B: `${b.u},${b.v}` };
}

/** The ms of the step that moves a sim from the start point of tomb (0, 0) across its exit door. */
function crossingStep(code, difficulty) {
  const { world, across } = crossingWorld(code, difficulty);
  const sim = createSim(world, world.startPoint());
  const auto = createAutopilot(world, [across]);
  let ph = 0, pv = 0;
  for (let i = 0; i < 60000; i++) {
    const [h, v, jump] = auto(sim);
    const lead = sim.recent[0];
    sim.burn = BURN_S;
    const t0 = performance.now();
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    const ms = performance.now() - t0;
    if (sim.recent[0] !== lead) return ms;
    ph = h;
    pv = v;
  }
  throw new Error(`seed ${code} at ${difficulty} never crosses`);
}

/** The ms of `tombItems` over tomb B of a world in the state `crossingStep` starts from. */
function enteredItems(code, difficulty) {
  const { world, B } = crossingWorld(code, difficulty);
  const t0 = performance.now();
  tombItems(world, B);
  return performance.now() - t0;
}

for (const difficulty of ['hard', 'ultimate']) {
  test(`a crossing step at ${difficulty} costs at most a quarter of the entered tomb's tombItems`, (t) => {
    const [warm, ...codes] = seeds(9);
    crossingStep(warm, difficulty);
    enteredItems(warm, difficulty);
    const steps = codes.map((code) => crossingStep(code, difficulty));
    const lists = codes.map((code) => enteredItems(code, difficulty));
    const stepMs = median(steps), list = median(lists);
    t.diagnostic(`crossing ${stepMs.toFixed(3)} ms against tombItems ${list.toFixed(3)} ms`);
    assert.ok(stepMs <= list / 4, `crossing step ${stepMs.toFixed(3)} ms against tombItems ${list.toFixed(3)} ms`);
  });
}

test('a tomb holding no take packs to "" without building a board', () => {
  const world = createWorld(CODE, { difficulty: 'medium' });
  const onward = ({ u, v }) => ({ u: u + DX[world.exit(u, v)], v: v + DY[world.exit(u, v)] });
  const A = { u: 0, v: 0 }, C = onward(onward(A));
  const key = ({ u, v }) => `${u},${v}`;
  const at = boardCoords(C.u, C.v, world.tomb(C.u, C.v).entries[0], world.size);
  const sim = createSim(world, world.resumePoint(at.x, at.y), { recent: [key(A)] });
  assert.deepEqual(sim.recent, [key(C), key(A)]);
  world.retain(C.u, C.v);
  const built = world.boardsBuilt();
  assert.deepEqual(packRecent(world, sim), [[key(C), ''], [key(A), '']]);
  assert.equal(world.boardsBuilt(), built, 'packing builds nothing');
  assert.equal(sim.items.size, 0, 'no list is stored');
});
