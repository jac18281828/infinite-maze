import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { worlds, sample } from './sample.mjs';
import { DX, DY } from '../src/world/board.mjs';
import { floorItems, itemSpot } from '../src/world/floor.mjs';
import { createSim, step, feet, nodeXY, tombCount, runCarry, inputEdges } from '../src/game/sim.mjs';
import { createAutopilot } from '../src/game/autopilot.mjs';
import {
  COIN_KEYS, COIN_RATE, coinKey, coinId, coinPay, tombPay, commitCoins, parseWallet, parseCollected, parsePaid, parseTombs,
  serializeCollected, serializePaid, serializeTombs,
} from '../src/game/wallet.mjs';

test('the level rates are 1, 2, 5 and 10', () => {
  assert.deepEqual(COIN_RATE, { easy: 1, medium: 2, hard: 5, ultimate: 10 });
});

test('the wallet, the collected set and the payout record read absent or malformed storage as empty', () => {
  assert.equal(parseWallet('12'), 12);
  for (const bad of [null, '', 'x', '-3', '1.5', '1e3', '9007199254740993']) assert.equal(parseWallet(bad), 0, String(bad));
  const set = parseCollected('{"K7Q2M9XA:MEDIUM":["0,0,21","-1,2,5","junk",7],"A:EASY":"no"}');
  assert.deepEqual([...set.get('K7Q2M9XA:MEDIUM')], ['0,0,21', '-1,2,5']);
  assert.deepEqual([...set.get('A:EASY') ?? []], []);
  for (const bad of [null, '', '{', '[]', '3', 'null']) assert.equal(parseCollected(bad).size, 0, String(bad));
  const paid = parsePaid('{"K7Q2M9XA:HARD":4,"B:EASY":-1,"C:EASY":"2","D:EASY":1.5}');
  assert.deepEqual([...paid], [['K7Q2M9XA:HARD', 4]]);
  for (const bad of [null, '', '{not json', '[1]']) assert.equal(parsePaid(bad).size, 0, String(bad));
  assert.deepEqual(parseCollected(serializeCollected(set)).get('K7Q2M9XA:MEDIUM'), set.get('K7Q2M9XA:MEDIUM'));
  assert.deepEqual([...parsePaid(serializePaid(paid))], [...paid]);
  assert.equal(coinKey('K7Q2M9XA', 'medium'), 'K7Q2M9XA:MEDIUM');
});

test('the coin keys, and the solved tombs read absent or malformed storage as empty, drop bad ids and round-trip', () => {
  assert.deepEqual(COIN_KEYS, {
    wallet: 'infinite-maze.wallet',
    coins: 'infinite-maze.plane.coins',
    paid: 'infinite-maze.plane.coins.paid',
    tombs: 'infinite-maze.plane.coins.tombs',
  });
  const tombs = parseTombs('{"K7Q2M9XA:MEDIUM":["0,0","-2,19","1,2,3","x","0,0,",7,"3,-4"],"A:EASY":"no"}');
  assert.deepEqual([...tombs.get('K7Q2M9XA:MEDIUM')], ['0,0', '-2,19', '3,-4']);
  assert.deepEqual([...tombs.get('A:EASY') ?? []], []);
  for (const bad of [null, '', '{', '[]', '3', 'null']) assert.equal(parseTombs(bad).size, 0, String(bad));
  assert.deepEqual(parseTombs(serializeTombs(tombs)).get('K7Q2M9XA:MEDIUM'), tombs.get('K7Q2M9XA:MEDIUM'));
  assert.equal(serializeTombs(new Map([['K:EASY', new Set()], ['K:HARD', new Set(['1,1'])]])), '{"K:HARD":["1,1"]}');
});

/** A Map-backed storage, and the coin state a game would read from it. */
const memoryIo = () => {
  const m = new Map();
  return { m, load: (k) => (m.has(k) ? m.get(k) : null), store: (k, v) => { m.set(k, v); } };
};
const readState = (io) => ({
  wallet: parseWallet(io.load(COIN_KEYS.wallet)), coins: parseCollected(io.load(COIN_KEYS.coins)),
  tombs: parseTombs(io.load(COIN_KEYS.tombs)), paid: parsePaid(io.load(COIN_KEYS.paid)),
});
/** The tick of a game taking coin `id`: the sim adds it to the run's Set, then the game commits. */
function takeCoin(io, state, key, id) {
  let set = state.coins.get(key);
  if (!set) state.coins.set(key, (set = new Set()));
  set.add(id);
  return commitCoins(io, state, coinPay(key, [id]));
}

test('two games that take the same coin are paid once', () => {
  const io = memoryIo();
  io.m.set(COIN_KEYS.wallet, '10');
  const a = readState(io), b = readState(io), key = 'K7Q2M9XA:MEDIUM';
  assert.equal(takeCoin(io, a, key, '0,0,21'), 1);
  assert.equal(takeCoin(io, b, key, '0,0,21'), 0);
  assert.equal(io.m.get(COIN_KEYS.wallet), '11');
  assert.equal(b.wallet, 11);
  assert.equal(io.m.get(COIN_KEYS.coins), '{"K7Q2M9XA:MEDIUM":["0,0,21"]}');
});

/** A game solving tombs `ids` at `level`, reaching run count `count`; returns the pay rule it committed. */
function solveTombs(io, state, key, level, ids, count) {
  const pay = tombPay(key, level, ids, count);
  return { earned: commitCoins(io, state, pay), pay };
}

test('two games that interleave coins, tombs and records lose none and pay each once', () => {
  const io = memoryIo(), key = 'K7Q2M9XA:MEDIUM';
  io.m.set(COIN_KEYS.wallet, '30');
  const a = readState(io), b = readState(io);
  const setA = (a.coins.set(key, new Set()), a.coins.get(key));
  assert.equal(takeCoin(io, a, key, '0,0,1'), 1);
  assert.equal(takeCoin(io, b, key, '0,0,2'), 1);
  assert.equal(solveTombs(io, a, key, 'medium', ['0,1'], 1).earned, 2);
  assert.equal(solveTombs(io, b, key, 'medium', ['0,2'], 1).earned, 2);
  assert.equal(solveTombs(io, a, key, 'medium', [], 7).earned, 0);
  assert.equal(solveTombs(io, b, key, 'medium', [], 5).earned, 0);
  assert.equal(io.m.get(COIN_KEYS.wallet), String(30 + 1 + 1 + 2 + 2));
  assert.deepEqual(JSON.parse(io.m.get(COIN_KEYS.coins))[key].sort(), ['0,0,1', '0,0,2']);
  assert.deepEqual(JSON.parse(io.m.get(COIN_KEYS.tombs))[key].sort(), ['0,1', '0,2']);
  assert.deepEqual(JSON.parse(io.m.get(COIN_KEYS.paid)), { [key]: 7 });
  assert.equal(a.coins.get(key), setA, 'A keeps its Set object');
  assert.ok(setA.has('0,0,2'), 'A holds B\'s coin after its next write');
});

test('two games that solve the same tomb are paid its rate once', () => {
  const io = memoryIo(), key = 'K7Q2M9XA:MEDIUM';
  const a = readState(io), b = readState(io);
  assert.equal(solveTombs(io, a, key, 'medium', ['0,1'], 1).earned, 2);
  assert.equal(solveTombs(io, b, key, 'medium', ['0,1'], 1).earned, 0);
  assert.equal(io.m.get(COIN_KEYS.wallet), '2');
});

test('a tomb pays its rate the first time at any run count, and a replay pays nothing', () => {
  for (const [level, rate] of [['easy', 1], ['medium', 2], ['hard', 5], ['ultimate', 10]]) {
    const io = memoryIo(), key = `K7Q2M9XA:${level.toUpperCase()}`;
    const g = readState(io);
    g.paid.set(key, 50);
    assert.equal(solveTombs(io, g, key, level, ['3,4'], 3).earned, rate, `${level} under the record`);
    assert.equal(solveTombs(io, g, key, level, ['3,4'], 60).earned, 0, `${level} replayed`);
    assert.equal(solveTombs(io, g, key, level, ['3,5'], 61).earned, rate, `${level} new past the record`);
  }
});

test('two games that cross the same milestone are paid once, and the later one sees the merged record', () => {
  const io = memoryIo(), key = 'K7Q2M9XA:EASY';
  io.m.set(COIN_KEYS.paid, JSON.stringify({ [key]: 99 }));
  const a = readState(io), b = readState(io);
  assert.equal(solveTombs(io, a, key, 'easy', [], 100).earned, 100);
  const later = solveTombs(io, b, key, 'easy', [], 100);
  assert.equal(later.earned, 0);
  assert.equal(later.pay.seen, 100);
  assert.equal(io.m.get(COIN_KEYS.wallet), '100');
});

test('storage that holds nothing and takes nothing credits each coin once and never lowers the wallet', () => {
  const io = { load: () => null, store: () => {} }, key = 'K7Q2M9XA:MEDIUM';
  const state = { wallet: 24, coins: new Map(), tombs: new Map(), paid: new Map() };
  assert.equal(takeCoin(io, state, key, 'c1'), 1);
  assert.equal(state.wallet, 25);
  assert.equal(takeCoin(io, state, key, 'c2'), 1);
  assert.equal(state.wallet, 26);
  assert.deepEqual([...state.coins.get(key)], ['c1', 'c2']);
});

test('the merge keeps the coins another game took and the Set a running sim holds', () => {
  const io = memoryIo(), key = 'K7Q2M9XA:EASY';
  const a = readState(io), b = readState(io);
  takeCoin(io, a, key, '0,0,1');
  const setA = a.coins.get(key);
  takeCoin(io, b, key, '0,0,2');
  assert.equal(io.m.get(COIN_KEYS.wallet), '2');
  takeCoin(io, a, key, '0,0,3');
  assert.equal(a.coins.get(key), setA, 'the Set stays the same object');
  assert.deepEqual([...setA].sort(), ['0,0,1', '0,0,2', '0,0,3']);
  assert.equal(io.m.get(COIN_KEYS.wallet), '3');
  assert.equal(a.wallet, 3);
});

test('10,000 solved tombs under one key serialize to at most 130,100 characters', () => {
  const ids = new Set();
  for (let i = 0; ids.size < 10000; i++) ids.add(`${(i % 1999) - 999},${99999 - Math.floor(i / 1999)}`);
  assert.equal(ids.size, 10000);
  const text = serializeTombs(new Map([['K7Q2M9XA:MEDIUM', ids]]));
  assert.ok(text.length <= 130100, `${text.length} characters`);
});

test('a sim climbing two tombs along the way on counts 2, and a sim built from its carry counts 2', () => {
  const world = worlds.easy;
  const away = world.exit(0, 0);
  const next = { u: DX[away], v: DY[away] };
  const first = world.tombFlames(0, 0).chains[0];
  const last = first[first.length - 1];
  const second = world.tombFlames(next.u, next.v).chains.find((c) => c[0].x === last.x && c[0].y === last.y && c[0].cell === last.cell);
  assert.ok(second, 'the downstream tomb has a chain from the flame that ends the first');
  const sim = createSim(world, world.startPoint());
  assert.equal(tombCount(sim), 0);
  const drive = createAutopilot(world, [...first, ...second]);
  let ph = 0, pv = 0, ticks = 0, afterOne = -1;
  while (tombCount(sim) < 2 && ticks < 30000) {
    const [h, v, jump] = drive(sim);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    ticks++;
    if (afterOne < 0 && tombCount(sim) === 1) afterOne = ticks;
  }
  assert.equal(sim.state, 'play');
  assert.equal(tombCount(sim), 2);
  assert.deepEqual([...sim.solved], ['0,0', `${next.u},${next.v}`], 'the two tombs of the way on');
  assert.ok(afterOne > 0 && afterOne < ticks, 'the first exit scores one tomb before the second');
  assert.ok(ticks > 5000 && ticks < 20000, `${ticks} ticks`);
  const carried = createSim(world, world.resumePoint(sim.bd.x, sim.bd.y), runCarry(sim));
  assert.equal(tombCount(carried), 2);
});

/** Standing coins of tomb sample boards, up to `per` for each link direction. */
function coinsByLink(d, per) {
  const count = new Map(), out = [];
  for (const bd of sample(d, 3)) {
    for (const { cell, kind } of floorItems(worlds[d], bd)) {
      if (kind !== 'coin') continue;
      const link = Math.log2(bd.links[cell]);
      if ((count.get(link) || 0) >= per) continue;
      count.set(link, (count.get(link) || 0) + 1);
      out.push({ bd, cell, link });
    }
  }
  return out;
}

/**
 * Walks a sim from the neighbour across the coin's cell's link to the cell,
 * then toward the coin's spot, and then to and fro for 60 ticks. Returns the
 * tick of each 'coin' event and the first tick the feet were within 12 px.
 */
function walkPast(world, { bd, cell, link }, collected) {
  const to = world.step(bd, cell, link);
  const [sx, sy] = itemSpot(bd, cell);
  const side = Math.sign(sx - nodeXY(bd, cell)[0]);
  const sim = createSim(world, { board: to.board, cell: to.cell }, null, { collected });
  const auto = createAutopilot(world, [{ x: bd.x, y: bd.y, cell }]);
  const events = [];
  let near = -1, ph = 0, pv = 0, back = 0;
  for (let i = 0; i < 1500 && back < 60; i++) {
    const arrived = sim.bd === bd && sim.cell === cell && sim.mode === 'floor';
    // Once the feet are on the coin, walk away and back.
    const [h, v, jump] = near >= 0 ? [back++ < 30 ? -side : side, 0, false] : arrived ? [side, 0, false] : auto(sim);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    const [fx, fy] = feet(sim);
    if (near < 0 && Math.abs(fx - sx) <= 12 && Math.abs(fy - sy) <= 12) near = i;
    for (const ev of sim.events) if (ev === 'coin') events.push(i);
  }
  return { events, near, sim };
}

test('a sim walked to a coin takes it once, on the tick its feet come within 12 px of the spot, and never again', () => {
  const world = worlds.medium;
  const sample8 = coinsByLink('medium', 1);
  assert.equal(sample8.length, 8, 'a coin at the end of each link direction');
  for (const coin of sample8) {
    const set = new Set();
    const { events, near, sim } = walkPast(world, coin, set);
    assert.ok(near >= 0, `the feet reach the coin on cell ${coin.cell} of board (${coin.bd.x},${coin.bd.y})`);
    assert.deepEqual(events, [near], 'one pickup, on the first tick within reach');
    assert.deepEqual([...set], [coinId(coin.bd, coin.cell)]);
    assert.ok(sim.collected === set, 'the sim fills the set it was handed');
    // A key already in the set takes nothing.
    assert.deepEqual(walkPast(world, coin, new Set([coinId(coin.bd, coin.cell)])).events, []);
  }
});

test('a run that never nears a coin takes none', () => {
  const world = worlds.hard;
  const sim = createSim(world, world.startPoint());
  const drive = createAutopilot(world, world.tombFlames(0, 0).chains[0]);
  let ph = 0, pv = 0;
  for (let i = 0; i < 3000; i++) {
    const [h, v, jump] = drive(sim);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    assert.ok(!sim.events.includes('coin'));
  }
  assert.equal(sim.collected.size, 0);
});

// The end screen's row sits inside its panel and 4 px clear of every other row.
test('drawOver draws a COINS row inside its panel, 11 px from the y of every other row', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const fn = src.match(/function drawOver\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'drawOver found');
  const panel = fn[0].match(/r\.panel\((\d+), (\d+), (\d+), (\d+)\)/);
  assert.ok(panel, 'drawOver draws a panel');
  const [px, py, pw, ph] = panel.slice(1).map(Number);
  const rows = [...fn[0].matchAll(/r\.text\(([^\n]*?), VIEW_W \/ 2, (\d+), [^\n]*/g)].map((m) => ({
    text: m[1], y: +m[2], h: /scale: 2/.test(m[0]) ? 14 : 7,
  }));
  const coins = rows.filter((r) => r.text.startsWith('`COINS'));
  assert.equal(coins.length, 1, 'one COINS row');
  const y = coins[0].y;
  // The panel's inner rules sit 2 px in at the top and 3 px up from the bottom.
  for (const r of rows) assert.ok(r.y >= py + 3 && r.y + r.h <= py + ph - 3, `${r.text} at ${r.y} lies inside the panel ${py}..${py + ph}`);
  assert.ok(px <= 40 && px + pw >= 280, 'the panel keeps its x extents');
  for (const other of rows.filter((r) => r !== coins[0])) assert.ok(Math.abs(other.y - y) >= 11, `${other.text} at ${other.y}`);
});
