import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worlds, sample } from './sample.mjs';
import { DX, DY } from '../src/world/board.mjs';
import { floorItems, itemSpot, coinRows, rowSpot } from '../src/world/floor.mjs';
import { createSim, step, feet, nodeXY, tombCount, runCarry, inputEdges } from '../src/game/sim.mjs';
import { createAutopilot } from '../src/game/autopilot.mjs';
import {
  SLOT_KEY, LEGACY_KEYS, COIN_RATE, COIN_ID, TOMB_ID, coinKey, coinId, coinPay, tombPay, commitSlot, parseSlot, serializeSlot,
  legacySlot, parseWallet, parseIdSets, parsePaid,
} from '../src/game/wallet.mjs';

test('the level rates are 1, 2, 5 and 10', () => {
  assert.deepEqual(COIN_RATE, { easy: 1, medium: 2, hard: 5, ultimate: 10 });
});

test('the wallet, the collected set and the payout record read absent or malformed storage as empty', () => {
  assert.equal(parseWallet('12'), 12);
  for (const bad of [null, '', 'x', '-3', '1.5', '1e3', '9007199254740993']) assert.equal(parseWallet(bad), 0, String(bad));
  const set = parseIdSets('{"K7Q2M9XA:MEDIUM":["0,0,21","-1,2,5","junk",7],"A:EASY":"no"}', COIN_ID);
  assert.deepEqual([...set.get('K7Q2M9XA:MEDIUM')], ['0,0,21', '-1,2,5']);
  assert.deepEqual([...set.get('A:EASY') ?? []], []);
  for (const bad of [null, '', '{', '[]', '3', 'null']) assert.equal(parseIdSets(bad, COIN_ID).size, 0, String(bad));
  const paid = parsePaid('{"K7Q2M9XA:HARD":4,"B:EASY":-1,"C:EASY":"2","D:EASY":1.5}');
  assert.deepEqual([...paid], [['K7Q2M9XA:HARD', 4]]);
  for (const bad of [null, '', '{not json', '[1]']) assert.equal(parsePaid(bad).size, 0, String(bad));
  assert.equal(coinKey('K7Q2M9XA', 'medium'), 'K7Q2M9XA:MEDIUM');
});

test('the solved tombs read absent or malformed storage as empty and drop bad ids', () => {
  const tombs = parseIdSets('{"K7Q2M9XA:MEDIUM":["0,0","-2,19","1,2,3","x","0,0,",7,"3,-4"],"A:EASY":"no"}', TOMB_ID);
  assert.deepEqual([...tombs.get('K7Q2M9XA:MEDIUM')], ['0,0', '-2,19', '3,-4']);
  assert.deepEqual([...tombs.get('A:EASY') ?? []], []);
  for (const bad of [null, '', '{', '[]', '3', 'null']) assert.equal(parseIdSets(bad, TOMB_ID).size, 0, String(bad));
});

const SAVE = 'K7Q2-M9XA:13', KEY = 'K7Q2M9XA:MEDIUM';
/** A slot as stored, with `over` changing fields. */
const slotOf = (over = {}) => ({
  id: 'AAAAAAAA', save: SAVE, level: 'medium', start: '0,0', solved: [], wallet: 0, coins: [], tombs: [], record: 0, ...over,
});

test('the slot key, and a slot reads absent or malformed text as null and round-trips', () => {
  assert.equal(SLOT_KEY, 'infinite-maze.plane.slot');
  const full = slotOf({ solved: ['0,0', '-2,19'], wallet: 143, coins: ['0,0,21', '-1,2,5'], tombs: ['0,0'], record: 20 });
  assert.deepEqual(parseSlot(serializeSlot(full)), full);
  const sets = { ...full, solved: new Set(full.solved), coins: new Set(full.coins), tombs: new Set(full.tombs) };
  assert.equal(serializeSlot(sets), serializeSlot(full), 'Sets and arrays serialize alike');
  const bad = [
    null, '', '{', '[]', '3', 'null', '"x"',
    JSON.stringify(slotOf({ id: 'AAAAAAA' })), JSON.stringify(slotOf({ id: 'AAAAAAAAA' })), JSON.stringify(slotOf({ id: 'aaaaaaaa' })),
    JSON.stringify(slotOf({ id: 'AAAAAAAI' })), JSON.stringify(slotOf({ id: 8 })),
    JSON.stringify(slotOf({ save: 'junk' })), JSON.stringify(slotOf({ level: 'impossible' })), JSON.stringify(slotOf({ start: '0;0' })),
    JSON.stringify(slotOf({ wallet: -1 })), JSON.stringify(slotOf({ wallet: 1.5 })), JSON.stringify(slotOf({ wallet: '3' })),
    JSON.stringify(slotOf({ record: -2 })), JSON.stringify(slotOf({ solved: ['0,0', 'x'] })), JSON.stringify(slotOf({ solved: 'no' })),
    JSON.stringify(slotOf({ coins: ['0,0'] })), JSON.stringify(slotOf({ tombs: ['0,0,1'] })), JSON.stringify(slotOf({ tombs: [7] })),
    JSON.stringify({ ...slotOf(), id: undefined }), JSON.stringify({ ...slotOf(), coins: undefined }),
  ];
  for (const text of bad) assert.equal(parseSlot(text), null, String(text));
});

/** A Map-backed storage. */
const memoryIo = () => {
  const m = new Map();
  return { m, load: (k) => (m.has(k) ? m.get(k) : null), store: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
};
/** Stores `slot` and returns a game's run state read from it, with Sets as a running sim holds them. */
function readRun(io) {
  const s = parseSlot(io.load(SLOT_KEY));
  return { ...s, solved: new Set(s.solved), coins: new Set(s.coins), tombs: new Set(s.tombs) };
}
const hold = (io, over) => { io.m.set(SLOT_KEY, serializeSlot(slotOf(over))); return io; };
/** The tick of a game taking coin `id`: the sim adds it to the run's Set, then the game commits. */
function takeCoin(io, state, id) {
  state.coins.add(id);
  return commitSlot(io, state, coinPay(KEY, [id]));
}
/** A game solving tombs `ids` at its level, reaching run count `count`; returns the pay rule it committed. */
function solveTombs(io, state, ids, count) {
  for (const id of ids) state.solved.add(id);
  const pay = tombPay(KEY, state.level, ids, count);
  return { earned: commitSlot(io, state, pay), pay };
}
const stored = (io) => parseSlot(io.m.get(SLOT_KEY));

test('two games on one slot that take the same coin are paid once', () => {
  const io = hold(memoryIo(), { wallet: 10 });
  const a = readRun(io), b = readRun(io);
  assert.equal(takeCoin(io, a, '0,0,21'), 1);
  assert.equal(takeCoin(io, b, '0,0,21'), 0);
  assert.equal(stored(io).wallet, 11);
  assert.equal(b.wallet, 11);
  assert.deepEqual(stored(io).coins, ['0,0,21']);
});

test('two games on one slot that interleave coins, tombs and records lose none and pay each once', () => {
  const io = hold(memoryIo(), { wallet: 30 });
  const a = readRun(io), b = readRun(io);
  const setA = a.coins;
  assert.equal(takeCoin(io, a, '0,0,1'), 1);
  assert.equal(takeCoin(io, b, '0,0,2'), 1);
  assert.equal(solveTombs(io, a, ['0,1'], 1).earned, 2);
  assert.equal(solveTombs(io, b, ['0,2'], 1).earned, 2);
  assert.equal(solveTombs(io, a, [], 7).earned, 0);
  assert.equal(solveTombs(io, b, [], 5).earned, 0);
  const slot = stored(io);
  assert.equal(slot.wallet, 30 + 1 + 1 + 2 + 2);
  assert.deepEqual([...slot.coins].sort(), ['0,0,1', '0,0,2']);
  assert.deepEqual([...slot.tombs].sort(), ['0,1', '0,2']);
  assert.equal(slot.record, 7);
  assert.equal(a.coins, setA, 'A keeps its Set object');
  assert.ok(setA.has('0,0,2'), 'A holds B\'s coin after its next write');
});

test('two games on one slot that solve the same tomb are paid its rate once', () => {
  const io = hold(memoryIo());
  const a = readRun(io), b = readRun(io);
  assert.equal(solveTombs(io, a, ['0,1'], 1).earned, 2);
  assert.equal(solveTombs(io, b, ['0,1'], 1).earned, 0);
  assert.equal(stored(io).wallet, 2);
});

test('a tomb pays its rate the first time at any run count, and a replay pays nothing', () => {
  for (const [level, rate] of [['easy', 1], ['medium', 2], ['hard', 5], ['ultimate', 10]]) {
    const io = hold(memoryIo(), { level, record: 50 });
    const g = readRun(io);
    const key = coinKey('K7Q2M9XA', level);
    const run = (ids, count) => { for (const id of ids) g.solved.add(id); return commitSlot(io, g, tombPay(key, level, ids, count)); };
    assert.equal(run(['3,4'], 3), rate, `${level} under the record`);
    assert.equal(run(['3,4'], 60), 0, `${level} replayed`);
    assert.equal(run(['3,5'], 61), rate, `${level} new past the record`);
  }
});

test('two games on one slot that cross the same milestone are paid once, and the later one sees the merged record', () => {
  const io = hold(memoryIo(), { level: 'easy', record: 99 });
  const a = readRun(io), b = readRun(io);
  const key = 'K7Q2M9XA:EASY';
  const cross = (g) => { const pay = tombPay(key, 'easy', [], 100); return { earned: commitSlot(io, g, pay), pay }; };
  assert.equal(cross(a).earned, 100);
  const later = cross(b);
  assert.equal(later.earned, 0);
  assert.equal(later.pay.seen, 100);
  assert.equal(stored(io).wallet, 100);
});

test('storage that holds nothing and takes nothing credits each coin once and never lowers the wallet', () => {
  const io = { load: () => null, store: () => {}, remove: () => {} };
  const state = { ...slotOf({ wallet: 24 }), solved: new Set(), coins: new Set(), tombs: new Set() };
  assert.equal(takeCoin(io, state, 'c1'), 1);
  assert.equal(state.wallet, 25);
  assert.equal(takeCoin(io, state, 'c2'), 1);
  assert.equal(state.wallet, 26);
  assert.deepEqual([...state.coins], ['c1', 'c2']);
});

test('the merge keeps the coins another game took and the Set a running sim holds', () => {
  const io = hold(memoryIo(), { level: 'easy' });
  const a = readRun(io), b = readRun(io);
  takeCoin(io, a, '0,0,1');
  const setA = a.coins;
  takeCoin(io, b, '0,0,2');
  assert.equal(stored(io).wallet, 2);
  takeCoin(io, a, '0,0,3');
  assert.equal(a.coins, setA, 'the Set stays the same object');
  assert.deepEqual([...setA].sort(), ['0,0,1', '0,0,2', '0,0,3']);
  assert.equal(stored(io).wallet, 3);
  assert.equal(a.wallet, 3);
});

test('legacySlot reads the seven old keys of a MEDIUM save into a slot with a fresh id', () => {
  assert.deepEqual(LEGACY_KEYS, {
    save: 'infinite-maze.plane.save',
    difficulty: 'infinite-maze.plane.save.difficulty',
    run: 'infinite-maze.plane.save.run',
    wallet: 'infinite-maze.wallet',
    coins: 'infinite-maze.plane.coins',
    paid: 'infinite-maze.plane.coins.paid',
    tombs: 'infinite-maze.plane.coins.tombs',
  });
  const other = 'A1B2C3D4:MEDIUM';
  const old = (over = {}) => {
    const m = new Map(Object.entries({
      'infinite-maze.plane.save': SAVE,
      'infinite-maze.plane.save.difficulty': 'medium',
      'infinite-maze.plane.save.run': JSON.stringify({ save: SAVE, start: '3,-2', solved: ['3,-2', '3,-1'] }),
      'infinite-maze.wallet': '57',
      'infinite-maze.plane.coins': JSON.stringify({ [KEY]: ['0,0,21', '-1,2,5'], [other]: ['9,9,9'] }),
      'infinite-maze.plane.coins.tombs': JSON.stringify({ [KEY]: ['3,-2', '3,-1'], [other]: ['7,7'] }),
      'infinite-maze.plane.coins.paid': JSON.stringify({ [KEY]: 12, [other]: 40 }),
      ...over,
    }));
    for (const [k, v] of m) if (v === null) m.delete(k);
    return (k) => (m.has(k) ? m.get(k) : null);
  };
  const slot = legacySlot(old());
  assert.match(slot.id, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(legacySlot(old()).id, slot.id, 'each read mints a fresh id');
  assert.deepEqual({ ...slot, id: 'AAAAAAAA' }, slotOf({
    start: '3,-2', solved: ['3,-2', '3,-1'], wallet: 57, coins: ['0,0,21', '-1,2,5'], tombs: ['3,-2', '3,-1'], record: 12,
  }));
  assert.deepEqual(parseSlot(serializeSlot(slot)), slot);
  // No old save: nothing to adopt, whatever else the old keys hold.
  assert.equal(legacySlot(old({ 'infinite-maze.plane.save': null })), null);
  assert.equal(legacySlot(old({ 'infinite-maze.plane.save': 'junk' })), null);
  // A save with no difficulty beside it reads ULTIMATE, and so does an invalid one.
  for (const bad of [null, 'impossible']) {
    const got = legacySlot(old({ 'infinite-maze.plane.save.difficulty': bad }));
    assert.equal(got.level, 'ultimate');
    assert.deepEqual(got.coins, [], 'the ULTIMATE seed holds none of the MEDIUM entries');
  }
  // The run counts only when it names the save; else it starts at the save's own tomb: board (-2, -1) of
  // K7Q2-M9XA:13 lies in tomb (-1, -1) at MEDIUM.
  const runs = [null, '{not json', JSON.stringify({ save: 'K7Q2-M9XA:14', start: '3,-2', solved: ['3,-2'] }),
    JSON.stringify({ save: SAVE, start: 'x', solved: [] }), JSON.stringify({ save: SAVE, start: '0,0', solved: ['x'] })];
  for (const run of runs) {
    const got = legacySlot(old({ 'infinite-maze.plane.save.run': run }));
    assert.deepEqual([got.start, got.solved], ['-1,-1', []], String(run));
  }
  // K7Q2-M9XA:19 is board (-2, 2): tomb (-1, 0) at MEDIUM and at ULTIMATE (6x4), tomb (-1, 1) at EASY (2x2).
  for (const [level, start] of [['medium', '-1,0'], ['ultimate', '-1,0'], ['easy', '-1,1']]) {
    const got = legacySlot(old({
      'infinite-maze.plane.save': 'K7Q2-M9XA:19', 'infinite-maze.plane.save.difficulty': level, 'infinite-maze.plane.save.run': null,
    }));
    assert.deepEqual([got.start, got.solved], [start, []], level);
  }
});

test('the first commitSlot write removes the seven old keys', () => {
  const io = memoryIo();
  for (const k of Object.values(LEGACY_KEYS)) io.m.set(k, 'x');
  io.m.set('infinite-maze.plane.best', '{}');
  const state = { ...slotOf({ id: 'BBBBBBBB' }), solved: new Set(), coins: new Set(), tombs: new Set() };
  commitSlot(io, state, () => 0);
  for (const k of Object.values(LEGACY_KEYS)) assert.equal(io.load(k), null, k);
  assert.equal(io.load('infinite-maze.plane.best'), '{}', 'the best score stays');
  assert.equal(stored(io).id, 'BBBBBBBB');
});

/** A run that has taken the slot: the id, an empty wallet and the sets of a clean state. */
const fresh = (id, over = {}) => ({ ...slotOf({ id }), solved: new Set(), coins: new Set(), tombs: new Set(), ...over });

test('a run with another id takes the slot whole, and its pay sees an empty stored state', () => {
  const io = hold(memoryIo(), { wallet: 143, coins: ['0,0,21'], tombs: ['0,5'], record: 7, solved: ['0,5'], start: '0,5' });
  const b = fresh('BBBBBBBB', { save: '0000-0000:1', coins: new Set(['0,0,21']) });
  assert.equal(commitSlot(io, b, coinPay('00000000:MEDIUM', ['0,0,21'])), 1);
  const slot = stored(io);
  assert.equal(slot.id, 'BBBBBBBB');
  assert.equal(slot.wallet, 1);
  assert.deepEqual(slot.coins, ['0,0,21']);
  assert.deepEqual(slot.tombs, []);
  assert.deepEqual(slot.solved, []);
  assert.equal(slot.record, 0);
  assert.equal(slot.save, '0000-0000:1');
});

test('takeover: coin c listed in the old slot, taken by a new id, leaves wallet 1 and coins {c}', () => {
  const c = '0,0,21';
  const io = hold(memoryIo(), { wallet: 143, coins: [c], tombs: ['0,5'], record: 7, save: '0000-0000:1' });
  const b = fresh('BBBBBBBB');
  assert.equal(takeCoin(io, b, c), 1);
  const slot = stored(io);
  assert.deepEqual([slot.id, slot.wallet, slot.coins, slot.tombs, slot.record], ['BBBBBBBB', 1, [c], [], 0]);
});

test('same seed, new id: the wallet is still 1, never 144', () => {
  const io = hold(memoryIo(), { wallet: 143, coins: ['0,0,21'], save: SAVE });
  const b = fresh('BBBBBBBB', { save: 'K7Q2-M9XA:99' });
  assert.equal(takeCoin(io, b, '0,0,21'), 1);
  assert.equal(stored(io).wallet, 1);
  assert.equal(b.wallet, 1);
});

test('the slot of 10,000 solved tombs under one key costs at most 13 characters each', () => {
  const ids = new Set();
  for (let i = 0; ids.size < 10000; i++) ids.add(`${(i % 1999) - 999},${99999 - Math.floor(i / 1999)}`);
  assert.equal(ids.size, 10000);
  const none = serializeSlot(slotOf()).length;
  assert.ok(serializeSlot(slotOf({ tombs: ids })).length - none <= 130000);
  assert.ok(serializeSlot(slotOf({ solved: ids })).length - none <= 130000);
});

test('a sim climbing two tombs along the way on counts 2, and a sim built from its carry counts 2', () => {
  const world = worlds.easy;
  const away = world.exit(0, 0);
  const next = { u: DX[away], v: DY[away] };
  const first = world.tombFlames(0, 0).chains[0];
  const last = first[first.length - 1];
  const second = world.tombFlames(next.u, next.v).chains.find((c) => c[0].x === last.x && c[0].y === last.y && c[0].cell === last.cell);
  assert.ok(second, 'the downstream tomb has a chain that starts at the cell that ends the first');
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
  assert.ok(ticks > 4000 && ticks < 20000, `${ticks} ticks`);
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
 * tick of each pickup of the target coin and the first tick the feet were
 * within 12 px of it; row coins the walk crosses are left out.
 */
function walkPast(world, { bd, cell, link }, collected) {
  const to = world.step(bd, cell, link);
  const [sx, sy] = itemSpot(bd, cell);
  const id = coinId(bd, cell);
  const side = Math.sign(sx - nodeXY(bd, cell)[0]);
  const sim = createSim(world, { board: to.board, cell: to.cell }, null, { collected });
  const auto = createAutopilot(world, [{ x: bd.x, y: bd.y, cell }]);
  const events = [];
  let near = -1, ph = 0, pv = 0, back = 0;
  for (let i = 0; i < 1500 && back < 60; i++) {
    const arrived = sim.bd === bd && sim.cell === cell && sim.mode === 'floor';
    // Once the feet are on the coin, walk away and back.
    const [h, v, jump] = near >= 0 ? [back++ < 30 ? -side : side, 0, false] : arrived ? [side, 0, false] : auto(sim);
    const had = sim.collected.has(id);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    const [fx, fy] = feet(sim);
    if (near < 0 && Math.abs(fx - sx) <= 12 && Math.abs(fy - sy) <= 12) near = i;
    if (!had && sim.collected.has(id) && sim.events.includes('coin')) events.push(i);
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
    assert.deepEqual([...set].filter((k) => Number(k.split(',')[2]) < 84), [coinId(coin.bd, coin.cell)], 'the dead-end coin, once');
    assert.ok(sim.collected === set, 'the sim fills the set it was handed');
    // A key already in the set takes nothing.
    assert.deepEqual(walkPast(world, coin, new Set([coinId(coin.bd, coin.cell)])).events, []);
  }
});

/** The world pixel and id of every coin, dead-end and row, on board `bd`. */
function coinsOn(world, bd) {
  const out = [];
  for (const { cell, kind } of floorItems(world, bd)) if (kind === 'coin') out.push({ id: coinId(bd, cell), spot: itemSpot(bd, cell) });
  for (const cell of coinRows(world, bd)) for (let i = 0; i < 3; i++) out.push({ id: coinId(bd, cell, i), spot: rowSpot(bd, cell, i) });
  return out;
}

test('a run takes a coin only on a tick its feet lie within 12 px of the coin\'s spot, and every coin it never reached stays untaken', () => {
  const world = worlds.hard;
  const sim = createSim(world, world.startPoint());
  const drive = createAutopilot(world, world.tombFlames(0, 0).chains[0]);
  const walked = new Map(), reached = new Set();
  let ph = 0, pv = 0;
  for (let i = 0; i < 3000; i++) {
    const [h, v, jump] = drive(sim);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    const [fx, fy] = feet(sim);
    const boards = sim.mode === 'link' && sim.to.board !== sim.bd ? [sim.bd, sim.to.board] : [sim.bd];
    const near = [];
    for (const bd of boards) {
      if (!walked.has(bd.p)) walked.set(bd.p, coinsOn(world, bd));
      for (const { id, spot } of walked.get(bd.p)) if (Math.abs(fx - spot[0]) <= 12 && Math.abs(fy - spot[1]) <= 12) near.push(id);
    }
    const events = sim.events.filter((ev) => ev === 'coin').length;
    const fresh = near.filter((id) => !reached.has(id));
    assert.equal(events, fresh.length, `tick ${i}: ${events} pickups, ${fresh.length} coins newly within reach`);
    for (const id of near) reached.add(id);
  }
  const all = [...walked.values()].flat().map(({ id }) => id);
  assert.ok(reached.size >= 3 && all.length > reached.size, `${reached.size} reached of ${all.length} coins on the walked boards`);
  for (const id of all) assert.equal(sim.collected.has(id), reached.has(id), id);
  assert.equal(sim.collected.size, reached.size);
});

test('coinId keys a dead-end coin x,y,cell and coin i of the row east of cell c x,y,84 + 3c + i, and a board\'s coin ids never collide', () => {
  const world = worlds.medium;
  let rows = 0, dead = 0;
  for (const bd of sample('medium', 3)) {
    if (!bd.links) continue;
    const ids = [];
    for (const { cell, kind } of floorItems(world, bd)) {
      if (kind !== 'coin') continue;
      assert.equal(coinId(bd, cell), `${bd.x},${bd.y},${cell}`);
      ids.push(coinId(bd, cell));
      dead++;
    }
    // A jar shares the dead-end form, on a cell the coin leaves.
    for (const { cell, kind } of floorItems(world, bd)) if (kind === 'oil') ids.push(coinId(bd, cell));
    for (const c of coinRows(world, bd)) {
      for (let i = 0; i < 3; i++) {
        assert.equal(coinId(bd, c, i), `${bd.x},${bd.y},${84 + 3 * c + i}`);
        ids.push(coinId(bd, c, i));
        rows++;
      }
    }
    assert.equal(new Set(ids).size, ids.length, `board (${bd.x},${bd.y}) holds distinct ids`);
  }
  assert.ok(rows > 100 && dead > 30, `${rows} row coins, ${dead} dead-end coins`);
  // The row form runs from 84 to 332, past every cell of a board.
  const bd = sample('medium', 0).find((b) => b.links);
  assert.deepEqual([coinId(bd, 0, 0), coinId(bd, 82, 2)], [`${bd.x},${bd.y},84`, `${bd.x},${bd.y},332`]);
});

/**
 * Walks a sim over the corridor east of `cell` of `bd`, from the standing point of its west cell east
 * (dir 1) or of its east cell west (dir -1), 30 ticks to the other standing point. Returns, per tick, the
 * pickups the sim pushed and the coins newly within 12 px of the feet.
 */
function crossRow(world, bd, cell, dir, collected = new Set()) {
  const here = dir > 0 ? { board: bd, cell } : { board: bd, cell: cell + 1 };
  const sim = createSim(world, here, null, { collected });
  const spots = [0, 1, 2].map((i) => rowSpot(bd, cell, i));
  const seen = new Set(), ticks = [];
  let ph = 0, pv = 0;
  for (let i = 0; i < 30; i++) {
    step(sim, dir, 0, false, inputEdges(ph, pv, dir, 0));
    ph = dir;
    pv = 0;
    const [fx, fy] = feet(sim);
    const near = spots.flatMap(([x, y], k) => (Math.abs(fx - x) <= 12 && Math.abs(fy - y) <= 12 && !seen.has(k) ? [k] : []));
    for (const k of near) seen.add(k);
    ticks.push({ pickups: sim.events.filter((ev) => ev === 'coin').length, near: near.length });
  }
  return { ticks, sim };
}

test('a sim crossing a corridor that holds a row, in either direction, takes its three coins, one event each on the tick the feet come within 12 px, and none again', () => {
  const world = worlds.medium;
  const seen = [0, 0];
  for (const bd of sample('medium', 3)) {
    for (const cell of coinRows(world, bd)) {
      if (seen[0] >= 6 && seen[1] >= 6) break;
      for (const dir of [1, -1]) {
        const { ticks, sim } = crossRow(world, bd, cell, dir);
        assert.deepEqual(ticks.map((t) => t.pickups), ticks.map((t) => t.near), `cell ${cell} of board (${bd.x},${bd.y}), direction ${dir}`);
        assert.equal(ticks.reduce((n, t) => n + t.pickups, 0), 3, 'the three coins');
        assert.deepEqual([...sim.collected].sort(), [0, 1, 2].map((i) => coinId(bd, cell, i)).sort());
        assert.deepEqual(crossRow(world, bd, cell, dir, new Set(sim.collected)).ticks.map((t) => t.pickups), ticks.map(() => 0), 'none again');
        seen[dir > 0 ? 0 : 1]++;
      }
    }
  }
  assert.ok(seen[0] >= 6 && seen[1] >= 6, `${seen} corridors crossed each way`);
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
