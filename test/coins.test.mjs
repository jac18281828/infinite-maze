import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worlds, sample, CODE } from './sample.mjs';
import { DX, DY, NCELL } from '../src/world/board.mjs';
import { createWorld, boardCoords, tombOf } from '../src/world/world.mjs';
import { floorItems, itemSpot, coinRows, rowSpot, ROW_COINS } from '../src/world/floor.mjs';
import { textWidth } from '../src/game/touch.mjs';
import { createSim, step, feet, nodeXY, tombCount, runCarry, inputEdges, BURN_S, JAR_S, TICK } from '../src/game/sim.mjs';
import { createAutopilot } from '../src/game/autopilot.mjs';
import {
  SLOT_KEY, LEGACY_KEYS, COIN_RATE, TOMB_ID, coinKey, coinId, coinPay, tombPay, commitSlot, parseSlot, serializeSlot,
  legacySlot, parseWallet, parseIdSets, parsePaid, packRecent, unpackRecent,
  SAVE_SLOTS, MIGRATED_KEY, saveKey, parseSave, serializeSave, risePay, commitSave, takeSave, eraseSave, migrateSaves,
} from '../src/game/wallet.mjs';

test('the level rates are 1, 2, 5 and 10', () => {
  assert.deepEqual(COIN_RATE, { easy: 1, medium: 2, hard: 5, ultimate: 10 });
});

test('the wallet and the payout record read absent or malformed storage as empty', () => {
  assert.equal(parseWallet('12'), 12);
  for (const bad of [null, '', 'x', '-3', '1.5', '1e3', '9007199254740993']) assert.equal(parseWallet(bad), 0, String(bad));
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
/** A slot as parsed, with `over` changing fields; it holds no `coins`, which the slot writes empty and reads past. */
const slotOf = (over = {}) => ({
  id: 'AAAAAAAA', save: SAVE, level: 'medium', start: '0,0', solved: [], wallet: 0, tombs: [], record: 0, continues: 0, recent: [], ...over,
});
/** A slot as 83c2cf7 wrote it: `coins` listed, `continues` and `recent` absent. */
const olderSlot = (over = {}) => {
  const { continues, recent, ...rest } = slotOf();
  return { ...rest, coins: [], ...over };
};

test('the slot key, and a slot reads absent or malformed text as null and round-trips', () => {
  assert.equal(SLOT_KEY, 'infinite-maze.plane.slot');
  const full = slotOf({ solved: ['0,0', '-2,19'], wallet: 143, tombs: ['0,0'], record: 20, continues: 3 });
  assert.deepEqual(parseSlot(serializeSlot(full)), full);
  assert.deepEqual(JSON.parse(serializeSlot(full)), { ...full, coins: [] }, 'the field order of the written slot');
  assert.deepEqual(Object.keys(JSON.parse(serializeSlot(full))), ['id', 'save', 'level', 'start', 'solved', 'wallet', 'coins', 'tombs', 'record', 'continues', 'recent']);
  const sets = { ...full, solved: new Set(full.solved), tombs: new Set(full.tombs) };
  assert.equal(serializeSlot(sets), serializeSlot(full), 'Sets and arrays serialize alike');
  // The stored coin list is read past, whatever it holds or whether it is there.
  for (const coins of [undefined, [], ['0,0,21', '-1,2,5'], ['junk', 7], 'no', null, ['0,0']]) {
    assert.deepEqual(parseSlot(JSON.stringify({ ...full, coins })), full, JSON.stringify(coins));
  }
  const bad = [
    null, '', '{', '[]', '3', 'null', '"x"',
    JSON.stringify(slotOf({ id: 'AAAAAAA' })), JSON.stringify(slotOf({ id: 'AAAAAAAAA' })), JSON.stringify(slotOf({ id: 'aaaaaaaa' })),
    JSON.stringify(slotOf({ id: 'AAAAAAAI' })), JSON.stringify(slotOf({ id: 8 })),
    JSON.stringify(slotOf({ save: 'junk' })), JSON.stringify(slotOf({ level: 'impossible' })), JSON.stringify(slotOf({ start: '0;0' })),
    JSON.stringify(slotOf({ wallet: -1 })), JSON.stringify(slotOf({ wallet: 1.5 })), JSON.stringify(slotOf({ wallet: '3' })),
    JSON.stringify(slotOf({ record: -2 })), JSON.stringify(slotOf({ solved: ['0,0', 'x'] })), JSON.stringify(slotOf({ solved: 'no' })),
    JSON.stringify(slotOf({ tombs: ['0,0,1'] })), JSON.stringify(slotOf({ tombs: [7] })),
    JSON.stringify({ ...slotOf(), id: undefined }),
  ];
  for (const text of bad) assert.equal(parseSlot(text), null, String(text));
});

/** A Map-backed storage; `store` reports the write landed, as the game's storage does. */
const memoryIo = () => {
  const m = new Map();
  return { m, load: (k) => (m.has(k) ? m.get(k) : null), store: (k, v) => { m.set(k, v); return true; }, remove: (k) => { m.delete(k); } };
};
/** Stores `slot` and returns a game's run state read from it, with Sets as a running sim holds them. */
function readRun(io) {
  const s = parseSlot(io.load(SLOT_KEY));
  return { ...s, solved: new Set(s.solved), tombs: new Set(s.tombs) };
}
const hold = (io, over) => { io.m.set(SLOT_KEY, serializeSlot(slotOf(over))); return io; };
/** Stores a slot as 83c2cf7 wrote it, its `coins` listed. */
const holdOlder = (io, over) => { io.m.set(SLOT_KEY, JSON.stringify(olderSlot(over))); return io; };
/** The tick of a game taking coin `id`: the sim adds it to the run's taken set, then the game commits. */
function takeCoin(io, state, id, taken = new Set()) {
  taken.add(id);
  return commitSlot(io, state, coinPay([id]));
}
/** A game solving tombs `ids` at its level, reaching run count `count`; returns the pay rule it committed. */
function solveTombs(io, state, ids, count) {
  for (const id of ids) state.solved.add(id);
  const pay = tombPay(KEY, state.level, ids, count);
  return { earned: commitSlot(io, state, pay), pay };
}
const stored = (io) => parseSlot(io.m.get(SLOT_KEY));
/** The `coins` list of the slot as written. */
const storedCoins = (io) => JSON.parse(io.m.get(SLOT_KEY)).coins;

test('two games on one slot that take the same coin are each paid for it, as two runs on one seed are', () => {
  const io = hold(memoryIo(), { wallet: 10 });
  const a = readRun(io), b = readRun(io);
  assert.equal(takeCoin(io, a, '0,0,21'), 1);
  assert.equal(takeCoin(io, b, '0,0,21'), 1);
  assert.equal(stored(io).wallet, 12);
  assert.equal(b.wallet, 12);
  assert.deepEqual(storedCoins(io), []);
});

test('two games on one slot that interleave coins, tombs and records lose none and pay each once', () => {
  const io = hold(memoryIo(), { wallet: 30 });
  const a = readRun(io), b = readRun(io);
  assert.equal(takeCoin(io, a, '0,0,1'), 1);
  assert.equal(takeCoin(io, b, '0,0,2'), 1);
  assert.equal(solveTombs(io, a, ['0,1'], 1).earned, 2);
  assert.equal(solveTombs(io, b, ['0,2'], 1).earned, 2);
  assert.equal(solveTombs(io, a, [], 7).earned, 0);
  assert.equal(solveTombs(io, b, [], 5).earned, 0);
  const slot = stored(io);
  assert.equal(slot.wallet, 30 + 1 + 1 + 2 + 2);
  assert.deepEqual(storedCoins(io), []);
  assert.deepEqual([...slot.tombs].sort(), ['0,1', '0,2']);
  assert.equal(slot.record, 7);
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

test('storage that holds nothing and takes nothing credits each coin at its tick and never lowers the wallet', () => {
  const io = { load: () => null, store: () => {}, remove: () => {} };
  const state = { ...slotOf({ wallet: 24 }), solved: new Set(), tombs: new Set() };
  const taken = new Set();
  assert.equal(takeCoin(io, state, 'c1', taken), 1);
  assert.equal(state.wallet, 25);
  assert.equal(takeCoin(io, state, 'c2', taken), 1);
  assert.equal(state.wallet, 26);
  assert.deepEqual([...taken], ['c1', 'c2'], 'the run\'s taken set keeps the coins from paying twice');
});

test('the merge adds no coin to a running sim\'s taken set, and another game\'s coin joins neither the set nor the slot', () => {
  const io = hold(memoryIo(), { level: 'easy' });
  const a = readRun(io), b = readRun(io);
  const taken = new Set();
  takeCoin(io, a, '0,0,1', taken);
  takeCoin(io, b, '0,0,2');
  assert.equal(stored(io).wallet, 2);
  takeCoin(io, a, '0,0,3', taken);
  assert.deepEqual([...taken], ['0,0,1', '0,0,3'], 'the set holds the coins its own sim took');
  assert.deepEqual(storedCoins(io), []);
  assert.equal(stored(io).wallet, 3);
  assert.equal(a.wallet, 3);
});

test('legacySlot reads the seven old keys of a MEDIUM save into a slot with a fresh id, past the old coin list', () => {
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
    start: '3,-2', solved: ['3,-2', '3,-1'], wallet: 57, tombs: ['3,-2', '3,-1'], record: 12, continues: 0,
  }));
  assert.ok(!('coins' in slot), 'the old coin key is not read');
  assert.deepEqual(parseSlot(serializeSlot(slot)), slot);
  // No old save: nothing to adopt, whatever else the old keys hold.
  assert.equal(legacySlot(old({ 'infinite-maze.plane.save': null })), null);
  assert.equal(legacySlot(old({ 'infinite-maze.plane.save': 'junk' })), null);
  // A save with no difficulty beside it reads ULTIMATE, and so does an invalid one.
  for (const bad of [null, 'impossible']) {
    const got = legacySlot(old({ 'infinite-maze.plane.save.difficulty': bad }));
    assert.equal(got.level, 'ultimate');
    assert.deepEqual(got.tombs, [], 'the ULTIMATE seed holds none of the MEDIUM entries');
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
  const state = { ...slotOf({ id: 'BBBBBBBB' }), solved: new Set(), tombs: new Set() };
  commitSlot(io, state, () => 0);
  for (const k of Object.values(LEGACY_KEYS)) assert.equal(io.load(k), null, k);
  assert.equal(io.load('infinite-maze.plane.best'), '{}', 'the best score stays');
  assert.equal(stored(io).id, 'BBBBBBBB');
});

/** A run that has taken the slot: the id, an empty wallet and the sets of a clean state. */
const fresh = (id, over = {}) => ({ ...slotOf({ id }), solved: new Set(), tombs: new Set(), ...over });

test('a run with another id takes the slot whole, and its pay sees an empty stored state', () => {
  const io = holdOlder(memoryIo(), { wallet: 143, coins: ['0,0,21'], tombs: ['0,5'], record: 7, solved: ['0,5'], start: '0,5' });
  const b = fresh('BBBBBBBB', { save: '0000-0000:1' });
  assert.equal(commitSlot(io, b, coinPay(['0,0,21'])), 1);
  const slot = stored(io);
  assert.equal(slot.id, 'BBBBBBBB');
  assert.equal(slot.wallet, 1);
  assert.deepEqual(storedCoins(io), []);
  assert.deepEqual(slot.tombs, []);
  assert.deepEqual(slot.solved, []);
  assert.equal(slot.record, 0);
  assert.equal(slot.continues, 0);
  assert.equal(slot.save, '0000-0000:1');
});

test('takeover: coin c listed in the old slot, taken by a new id, leaves wallet 1 and no coin listed', () => {
  const c = '0,0,21';
  const io = holdOlder(memoryIo(), { wallet: 143, coins: [c], tombs: ['0,5'], record: 7, save: '0000-0000:1' });
  const b = fresh('BBBBBBBB');
  assert.equal(takeCoin(io, b, c), 1);
  const slot = stored(io);
  assert.deepEqual([slot.id, slot.wallet, storedCoins(io), slot.tombs, slot.record], ['BBBBBBBB', 1, [], [], 0]);
});

test('same seed, new id: the wallet is still 1, never 144', () => {
  const io = holdOlder(memoryIo(), { wallet: 143, coins: ['0,0,21'], save: SAVE });
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

test('the slot lists no coin id: an older slot with coins listed parses, a slot without the field parses, a write lists none, and a new sim takes none', () => {
  const full = { solved: ['0,0'], wallet: 5, tombs: ['0,0'], record: 1 };
  assert.deepEqual(parseSlot(JSON.stringify(olderSlot(full))), slotOf(full));
  assert.deepEqual(parseSlot(JSON.stringify(olderSlot({ ...full, coins: ['0,0,21', '5,6,7'] }))), slotOf(full), 'ids listed');
  const { coins, ...without } = olderSlot(full);
  assert.deepEqual(parseSlot(JSON.stringify(without)), slotOf(full), 'no coins field');
  for (const held of [olderSlot({ ...full, coins: ['0,0,21'] }), olderSlot(full), without, slotOf(full)]) {
    const io = memoryIo();
    io.m.set(SLOT_KEY, JSON.stringify(held));
    const state = readRun(io);
    commitSlot(io, state, () => 0);
    assert.equal(io.m.get(SLOT_KEY).includes('"coins":[]'), true);
    assert.deepEqual(storedCoins(io), []);
  }
  const sim = createSim(worlds.medium, worlds.medium.startPoint());
  assert.equal(sim.collected.size, 0);
  assert.equal(sim.jars.size, 0);
  assert.notEqual(createSim(worlds.medium, worlds.medium.startPoint()).collected, sim.collected, 'each sim owns its set');
});

test('the continue count reads 0 when absent, round-trips, fails the slot unless a count, merges by maximum and rides runCarry', () => {
  const { continues, ...without } = slotOf({ wallet: 4 });
  assert.equal(parseSlot(JSON.stringify(without)).continues, 0, 'absent reads 0');
  for (const n of [0, 1, 7, 12345]) assert.equal(parseSlot(serializeSlot(slotOf({ continues: n }))).continues, n);
  for (const bad of [-1, 1.5, '3', null, [3], true]) assert.equal(parseSlot(JSON.stringify(slotOf({ continues: bad }))), null, JSON.stringify(bad));
  // Another build's write drops the field, which reads 0 and keeps its other fields.
  assert.deepEqual(parseSlot(JSON.stringify(olderSlot({ wallet: 4 }))), slotOf({ wallet: 4 }));
  // The same-id merge stores the larger count, from either side; another id's write stores its own.
  const io = hold(memoryIo(), { continues: 3 });
  const lower = readRun(io), higher = readRun(io);
  lower.continues = 1;
  higher.continues = 5;
  commitSlot(io, lower, () => 0);
  assert.equal(stored(io).continues, 3, 'a lower count leaves the stored one');
  assert.equal(lower.continues, 3, 'the writer takes the merged maximum');
  commitSlot(io, higher, () => 0);
  assert.equal(stored(io).continues, 5);
  const taker = fresh('BBBBBBBB', { continues: 2 });
  commitSlot(io, taker, () => 0);
  assert.deepEqual([stored(io).id, stored(io).continues], ['BBBBBBBB', 2], 'another id takes the slot with its own count');
  // runCarry carries the count into the next sim, and a sim with no carry starts at 0.
  const world = worlds.medium, start = world.startPoint();
  const a = createSim(world, start);
  assert.equal(a.continues, 0);
  a.continues = 4;
  assert.equal(runCarry(a).continues, 4);
  assert.equal(createSim(world, start, runCarry(a)).continues, 4);
  assert.equal(createSim(world, start, { ...runCarry(a), continues: undefined }).continues, 0);
});

test('the end, pause and CONTINUE? screens draw the continue count: CONTINUES under COINS in the end panel, on the pause header\'s row at x 53, and in the COINS row of CONTINUE?', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const body = (name) => {
    const fn = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(fn, `${name} found`);
    return fn[0];
  };
  // The end screen: the row sits under COINS, 11 px below it, inside the panel.
  const over = body('drawOver');
  const [py, ph] = over.match(/r\.panel\((\d+), (\d+), (\d+), (\d+)\)/).slice(2, 5).map(Number).filter((_, i) => i !== 1);
  const rows = [...over.matchAll(/r\.text\(([^\n]*?), VIEW_W \/ 2, (\d+), [^\n]*/g)].map((m) => ({ text: m[1], y: +m[2], h: /scale: 2/.test(m[0]) ? 14 : 7 }));
  const coins = rows.find((r) => r.text.startsWith('`COINS')), continues = rows.filter((r) => r.text.startsWith('`CONTINUES'));
  assert.equal(continues.length, 1, 'one CONTINUES row');
  assert.equal(continues[0].y - coins.y, 11, 'under COINS');
  assert.ok(continues[0].y >= py + 3 && continues[0].y + continues[0].h <= py + ph - 3, 'inside the panel');
  assert.match(continues[0].text, /\$\{s\.continues\}/, 'the run\'s count');
  // The pause header: left-aligned at x 53 on TOMB n's row, ending before PAUSED at x 125 up to 99.
  const pause = body('drawPause');
  const tomb = pause.match(/r\.text\(`TOMB \$\{[^}]*\}`, (\d+), (\d+), /);
  const mark = pause.match(/r\.text\(`CONTINUES \$\{g\.sim\.continues\}`, (\d+), (\d+), '[a-z0-9]'\);/);
  assert.ok(tomb && mark, 'drawPause draws TOMB n and CONTINUES n');
  assert.deepEqual(mark.slice(1).map(Number), [53, +tomb[2]], 'x 53 on the row of TOMB n');
  assert.ok(53 + textWidth('CONTINUES 99') <= 124 && 53 + textWidth('CONTINUES 100') > 124, 'flush against PAUSED up to 99');
  // CONTINUE?: the COINS row names the slot's count.
  const title = body('drawTitle');
  assert.match(title, /const \{ save, level, solved, wallet, continues \} = g\.confirm\.slot;/);
  assert.match(title, /r\.text\(`COINS  \$\{wallet\}  CONTINUES  \$\{continues\}`, 72, 98, 'b'\);/);
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

/** The items of tomb `key` in the slot's bit order, from floorItems and coinRows: jars, dead-end coins, then row coins. */
function orderOf(world, key) {
  const [u, v] = key.split(',').map(Number);
  const jars = [], coins = [], rows = [];
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(u, v, i, world.size);
    const bd = world.board(x, y);
    for (const it of floorItems(world, bd)) (it.kind === 'oil' ? jars : coins).push(coinId(bd, it.cell));
    for (const cell of coinRows(world, bd)) for (let k = 0; k < ROW_COINS; k++) rows.push(coinId(bd, cell, k));
  }
  return { ids: [...jars, ...coins, ...rows], jars: jars.length };
}

/** Board, cell and floor point of coin or jar `id`: `x,y,cell` for a dead end, `x,y,NCELL + 3 cell + i` for a row coin. */
function locate(world, id) {
  const [x, y, n] = id.split(',').map(Number);
  const bd = world.board(x, y);
  if (n < NCELL) return { bd, cell: n, spot: itemSpot(bd, n) };
  const cell = Math.floor((n - NCELL) / ROW_COINS);
  return { bd, cell, spot: rowSpot(bd, cell, (n - NCELL) % ROW_COINS) };
}

const tombKeyOf = (world, id) => {
  const [x, y] = id.split(',').map(Number);
  const t = tombOf(x, y, world.size);
  return `${t.u},${t.v}`;
};

/**
 * The self-test seed's way on: A = (0, 0), B the tomb A's exit leads to, C the
 * tomb B's exit leads to, `qa` and `qb` the cells across A's and B's exit doors,
 * and `gate` the cell of A's exit board that its exit door opens from.
 */
function route(world) {
  const away = (t) => { const d = world.exit(t.u, t.v); return { u: t.u + DX[d], v: t.v + DY[d] }; };
  const key = (t) => `${t.u},${t.v}`;
  const a = { u: 0, v: 0 }, b = away(a), c = away(b);
  const same = (m, n) => m.x === n.x && m.y === n.y && m.cell === n.cell;
  const qa = world.tombFlames(a.u, a.v).chains[0].at(-1);
  const qb = world.tombFlames(b.u, b.v).chains.find((chain) => same(chain[0], qa)).at(-1);
  const t = world.tomb(a.u, a.v);
  const at = boardCoords(a.u, a.v, t.X, world.size), xb = world.board(at.x, at.y);
  const gate = { x: xb.x, y: xb.y, cell: xb.doors.find((d) => d.dir === t.exit).cell };
  return { A: key(a), B: key(b), C: key(c), qa, qb, gate };
}

/** The tomb `key`'s first entry, where a restore of a serial in the tomb starts. */
function entryOf(world, key) {
  const [u, v] = key.split(',').map(Number);
  const at = boardCoords(u, v, world.tomb(u, v).entries[0], world.size);
  return world.resumePoint(at.x, at.y);
}

/**
 * Steers `sim` by `input` until `done()`, tick by tick. The torch is set to
 * `pin` before every tick, so `sim.burn` after the walk is the last tick's
 * burn. `each` runs after every tick.
 */
function drive(sim, input, done, each = () => {}, pin = BURN_S) {
  let ph = 0, pv = 0;
  for (let i = 0; i < 60000 && !done(); i++) {
    const [h, v, jump] = input(sim);
    sim.burn = pin;
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    each();
  }
  assert.ok(done(), 'the walk ends within its ticks');
}

/** Walks `sim` along the cells `goals`, to the last one. */
function walkCells(sim, goals, each, pin) {
  const last = goals.at(-1), auto = createAutopilot(sim.world, goals);
  drive(sim, auto, () => sim.bd.x === last.x && sim.bd.y === last.y && sim.cell === last.cell && sim.mode === 'floor', each, pin);
}

/** Walks `sim` to the cell of item `id`, then toward its floor point until the feet come within 12 px of it. */
function reach(sim, id, each, pin) {
  const { bd, cell, spot } = locate(sim.world, id);
  const side = Math.sign(spot[0] - nodeXY(bd, cell)[0]);
  const auto = createAutopilot(sim.world, [{ x: bd.x, y: bd.y, cell }]);
  const here = (s) => s.bd.x === bd.x && s.bd.y === bd.y && s.cell === cell && s.mode === 'floor';
  const near = () => { const [fx, fy] = feet(sim); return Math.abs(fx - spot[0]) <= 12 && Math.abs(fy - spot[1]) <= 12; };
  drive(sim, (s) => (here(s) ? [side, 0, false] : auto(s)), near, each, pin);
}

/**
 * A per-tick check: the step pushed one 'coin' event for each coin id it added,
 * which the game's tick counts; the recent tombs lead with the explorer's tomb;
 * and every take lies in a recent tomb.
 */
function coinEvents(sim) {
  let before = new Set(sim.collected);
  return () => {
    const gained = [...sim.collected].filter((id) => !before.has(id)).length;
    assert.equal(sim.events.filter((ev) => ev === 'coin').length, gained, 'one coin event for each coin taken');
    before = new Set(sim.collected);
    assert.equal(sim.recent[0], `${sim.bd.u},${sim.bd.v}`, 'the explorer\'s tomb leads');
    assert.ok([...sim.collected, ...sim.jars].every((id) => sim.recent.includes(tombKeyOf(sim.world, id))), 'every take lies in a recent tomb');
  };
}

test('a run keeps the coins and jars of its two recent tombs: A, B, A keeps both takes, A, B, C lays A\'s back and the walk back takes them afresh', () => {
  const world = worlds.medium, { A, B, C, qa, qb, gate } = route(world);
  const { ids, jars } = orderOf(world, A);
  const coin = ids[jars], jar = ids[0];
  assert.equal(tombKeyOf(world, coin), A);
  const sim = createSim(world, world.startPoint());
  const seen = coinEvents(sim);
  assert.deepEqual(sim.recent, [A]);
  reach(sim, coin, seen);
  reach(sim, jar, seen);
  assert.ok(sim.collected.has(coin) && sim.jars.has(jar), 'a coin and a jar of A taken');
  walkCells(sim, [qa], seen);
  assert.deepEqual(sim.recent, [B, A]);
  walkCells(sim, [gate], seen);
  assert.deepEqual(sim.recent, [A, B]);
  assert.ok(sim.collected.has(coin) && sim.jars.has(jar), 'A, B, A keeps both takes');
  walkCells(sim, [qa, qb], seen);
  assert.deepEqual(sim.recent, [C, B]);
  assert.ok(!sim.collected.has(coin) && !sim.jars.has(jar), 'A, B, C lays A\'s takes back');
  assert.ok([...sim.collected, ...sim.jars].every((id) => tombKeyOf(world, id) !== A), 'no id of A is left');
  // The walk back takes the coin once, with one coin event, and the jar again.
  const hits = [];
  reach(sim, coin, () => {
    seen();
    if (!hits.length && sim.collected.has(coin)) hits.push(sim.events.filter((ev) => ev === 'coin').length);
  });
  assert.deepEqual(hits, [1], 'the coin\'s take raises one coin event');
  assert.ok(!sim.jars.has(jar), 'the jar still lies on its floor');
  reach(sim, jar, seen);
  assert.ok(sim.jars.has(jar), 'the jar is taken again');
  assert.deepEqual(sim.recent, [A, B]);
});

test('a sim built from a carry applies the recent tombs to the tomb it starts in', () => {
  const world = worlds.medium, { A, B, C } = route(world);
  const pick = (key) => { const { ids, jars } = orderOf(world, key); return { coin: ids[jars], jar: ids[0] }; };
  const a = pick(A), b = pick(B);
  const carry = () => ({ recent: [B, A], collected: new Set([a.coin, b.coin]), jars: new Set([a.jar, b.jar]) });
  const sorted = (set) => [...set].sort();
  // Starting in A or in B, one of the carried tombs, moves it to the front and keeps both.
  for (const [key, recent] of [[A, [A, B]], [B, [B, A]]]) {
    const sim = createSim(world, entryOf(world, key), carry());
    assert.deepEqual(sim.recent, recent, key);
    assert.deepEqual(sorted(sim.collected), [a.coin, b.coin].sort(), key);
    assert.deepEqual(sorted(sim.jars), [a.jar, b.jar].sort(), key);
  }
  // Starting in C puts C first behind the carried latest, B, and lays A's takes back.
  const c = createSim(world, entryOf(world, C), carry());
  assert.deepEqual(c.recent, [C, B]);
  assert.deepEqual([...c.collected], [b.coin]);
  assert.deepEqual([...c.jars], [b.jar]);
  // A carry with one recent tomb gives two, and the carry stays as it was.
  const one = createSim(world, entryOf(world, B), { recent: [A], collected: new Set([a.coin]), jars: new Set() });
  assert.deepEqual(one.recent, [B, A]);
  assert.ok(one.collected.has(a.coin));
  const kept = carry();
  createSim(world, entryOf(world, C), kept);
  assert.deepEqual([kept.recent, kept.collected.size, kept.jars.size], [[B, A], 2, 2], 'the carried sets and list are not shared');
  // No carry, a carry without the fields and runCarry of a fresh sim give nothing taken.
  const fresh = createSim(world, entryOf(world, B));
  for (const sim of [fresh, createSim(world, entryOf(world, B), { time: 5 }), createSim(world, entryOf(world, B), runCarry(fresh))]) {
    assert.deepEqual([sim.recent, sim.collected.size, sim.jars.size], [[B], 0, 0]);
  }
  // runCarry hands over the recent tombs and their takes.
  const sim = createSim(world, entryOf(world, A), carry());
  const out = runCarry(sim);
  assert.deepEqual([out.recent, sorted(out.collected), sorted(out.jars)], [[A, B], [a.coin, b.coin].sort(), [a.jar, b.jar].sort()]);
});

test('a reload keeps the previous tomb\'s jar taken: the slot unpacks to a sim in the next tomb that finds it taken', () => {
  const world = worlds.medium, { A, B, qa } = route(world);
  const jar = orderOf(world, A).ids[0];
  const sim = createSim(world, world.startPoint());
  reach(sim, jar);
  walkCells(sim, [qa]);
  assert.deepEqual(sim.recent, [B, A]);
  const slot = parseSlot(serializeSlot(slotOf({ recent: packRecent(world, sim) })));
  const resume = world.resumePoint(qa.x, qa.y);
  // Walking to the jar with the burn pinned: the contact tick burns one tick, or adds the jar's burn besides.
  const gain = (made) => {
    reach(made, jar, undefined, 100);
    return made.burn - 100;
  };
  const back = createSim(world, resume, unpackRecent(world, slot.recent));
  assert.deepEqual(back.recent, [B, A]);
  assert.ok(back.jars.has(jar), 'the unpacked sim holds the jar');
  assert.ok(Math.abs(gain(back) + TICK) < 1e-9, 'the taken jar adds nothing');
  assert.ok(Math.abs(gain(createSim(world, resume)) - (JAR_S - TICK)) < 1e-9, 'a sim with no recent tombs takes it for its 60 s');
});

test('packRecent sets bit k of a recent tomb for item k of the slot\'s order, latest tomb first, and a slot round-trips them', () => {
  const world = worlds.medium, { A, B } = route(world);
  const order = { [A]: orderOf(world, A), [B]: orderOf(world, B) };
  assert.ok(order[A].jars > 5 && order[A].ids.length > order[A].jars + 4 && order[B].ids.length > order[B].jars + 4, 'jars, dead-end coins and rows');
  const made = (recent, taken) => {
    const collected = new Set(), jars = new Set();
    for (const [key, list] of Object.entries(taken)) for (const k of list) (k < order[key].jars ? jars : collected).add(order[key].ids[k]);
    return { recent, collected, jars };
  };
  assert.deepEqual(packRecent(world, made([A, B], {})), [[A, ''], [B, '']], 'nothing taken writes "" for every recent tomb');
  assert.deepEqual(packRecent(world, made([B, A], {})).map(([key]) => key), [B, A], 'latest first');
  assert.deepEqual(packRecent(world, made([A], { [A]: [0, 5] })), [[A, '12']]);
  // Item k alone sets digit k >> 2 to 1 << (k & 3): jars, then dead-end coins, then row coins.
  for (const key of [A, B]) {
    for (let k = 0; k < order[key].ids.length; k++) {
      const [[, bits]] = packRecent(world, made([key], { [key]: [k] }));
      assert.equal(bits, '0'.repeat(k >> 2) + (1 << (k & 3)).toString(16), `item ${k} of ${key}`);
    }
  }
  // Row coins come last, by board, cell and coin; a jar's id never appears among the coins' bits.
  const rows = order[A].ids.slice(order[A].jars).filter((id) => Number(id.split(',')[2]) >= NCELL);
  assert.deepEqual(order[A].ids.slice(-rows.length), rows, 'row coins close the list');
  // Round trip through the slot's text.
  const run = made([B, A], {
    [A]: [...order[A].ids.keys()].filter((k) => k % 3 === 0), [B]: [...order[B].ids.keys()].filter((k) => k % 3 === 1),
  });
  const packed = packRecent(world, run);
  const text = serializeSlot(slotOf({ recent: packed }));
  assert.deepEqual(JSON.parse(text).recent, packed);
  assert.ok(packed.every(([, bits]) => /^[0-9a-f]*[1-9a-f]$/.test(bits)), 'no trailing 0 digit');
  const back = unpackRecent(world, parseSlot(text).recent);
  assert.deepEqual(back.recent, [B, A]);
  assert.deepEqual([...back.collected].sort(), [...run.collected].sort());
  assert.deepEqual([...back.jars].sort(), [...run.jars].sort());
  // A bit past a tomb's last item reads as nothing.
  const all = unpackRecent(world, [[A, 'f'.repeat(80)]]);
  assert.equal(all.collected.size + all.jars.size, order[A].ids.length);
});

test('a slot reads recent absent, or malformed in any form of R8, as no recent tombs and still parses', () => {
  const good = [['0,0', '12'], ['-1,0', '']];
  assert.deepEqual(parseSlot(JSON.stringify(slotOf({ recent: good }))).recent, good);
  assert.deepEqual(parseSlot(JSON.stringify(slotOf({ recent: [] }))).recent, []);
  assert.deepEqual(parseSlot(JSON.stringify(slotOf({ recent: [['0,0', '10']] }))).recent, [['0,0', '10']], 'trailing zeros read as written');
  const { recent, ...without } = slotOf({ wallet: 5 });
  assert.deepEqual(parseSlot(JSON.stringify(without)), slotOf({ wallet: 5 }), 'absent');
  // A slot as the coin-rows build writes it: coins empty, a continue count, no recent.
  assert.deepEqual(parseSlot(JSON.stringify({ ...without, coins: [], continues: 2 })), slotOf({ wallet: 5, continues: 2 }));
  const bad = [
    'no', 7, null, true, {}, { '0,0': '1' },
    [['0,0', '1'], ['1,0', '2'], ['2,0', '3']],
    ['0,0'], [['0,0']], [['0,0', '1', '2']], [[]], [7], [[0, '1']], [['0,0', 1]], [['0,0', null]], [[['0,0'], '1']],
    [['0;0', '1']], [['0,0,1', '1']], [['x', '1']], [['', '1']], [[' 0,0', '1']],
    [['0,0', '1'], ['0,0', '2']],
    [['0,0', 'G']], [['0,0', 'A']], [['0,0', '1 ']], [['0,0', '0x1']], [['0,0', '-1']],
    [['0,0', '1'], ['1,0', 'z']],
  ];
  for (const recent of bad) {
    const slot = parseSlot(JSON.stringify(slotOf({ wallet: 5, recent })));
    assert.deepEqual(slot, slotOf({ wallet: 5 }), JSON.stringify(recent));
  }
});

test('packRecent builds no board: a sim whose older recent tomb lies two tombs away packs after retain drops that tomb', () => {
  const world = createWorld(CODE, { difficulty: 'medium' }), { A, C } = route(world);
  const { ids, jars } = orderOf(world, A);
  const [u, v] = C.split(',').map(Number);
  // R5's third case: the sim starts in C, two tombs from the carried latest, A.
  const sim = createSim(world, entryOf(world, C), { recent: [A], collected: new Set([ids[jars]]), jars: new Set([ids[0]]) });
  assert.deepEqual(sim.recent, [C, A]);
  world.retain(u, v);
  const built = world.boardsBuilt();
  const packed = packRecent(world, sim);
  assert.equal(world.boardsBuilt(), built, 'packing builds nothing');
  assert.deepEqual(packed, [[C, ''], [A, packRecent(world, { recent: [A], collected: sim.collected, jars: sim.jars })[0][1]]]);
  assert.notEqual(packed[1][1], '', 'A\'s takes are packed');
  assert.ok(world.boardsBuilt() > built, 'a pack with no stored list rebuilds the dropped boards');
});

test('a same-id write stores the writer\'s recent tombs, whatever the stored slot held', () => {
  const held = [['0,0', 'f'], ['-1,0', '3']];
  for (const writer of [[['-2,0', '1']], [], [['-1,0', '8'], ['-2,0', '']]]) {
    const io = hold(memoryIo(), { recent: held, wallet: 4 });
    const state = readRun(io);
    state.recent = writer;
    commitSlot(io, state, () => 0);
    assert.deepEqual(parseSlot(io.m.get(SLOT_KEY)).recent, writer);
    assert.deepEqual(JSON.parse(io.m.get(SLOT_KEY)).recent, writer);
  }
  // Another id takes the slot whole, with its own recent tombs.
  const io = hold(memoryIo(), { recent: held });
  const taker = fresh('BBBBBBBB', { recent: [['2,2', '1']] });
  commitSlot(io, taker, () => 0);
  assert.deepEqual(stored(io).recent, [['2,2', '1']]);
});

// The save records (design §2, §4 and §7).
const RECORD = { id: 'AAAAAAAA', save: SAVE, level: 'medium', start: '0,0', net: 0, high: 0, wallet: 0, continues: 0, recent: [] };
const recordOf = (over = {}) => ({ ...RECORD, ...over });
const K1 = saveKey(1);
/** Stores the record of `over` and its unknown fields `extra` under slot n. */
const putRecord = (io, n, over = {}, extra = {}) => { io.m.set(saveKey(n), serializeSave(recordOf(over), extra)); return io; };
const heldAt = (io, n = 1) => parseSave(io.load(saveKey(n)));

test('the save keys, and a record round-trips and reads absent, newer, valid or damaged', () => {
  assert.deepEqual([...SAVE_SLOTS.map(saveKey), MIGRATED_KEY],
    ['infinite-maze.save.1', 'infinite-maze.save.2', 'infinite-maze.save.3', 'infinite-maze.save.migrated']);
  const full = recordOf({ net: -3, high: 20, wallet: 300, continues: 2, recent: [['0,0', '12'], ['-1,0', '']] });
  const text = serializeSave(full);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['v', 'id', 'save', 'level', 'start', 'net', 'high', 'wallet', 'continues', 'recent']);
  assert.equal(JSON.parse(text).v, 1);
  assert.deepEqual(parseSave(text), { state: 'valid', record: full, extra: {} });
  assert.deepEqual(parseSave(serializeSave(recordOf())), { state: 'valid', record: recordOf(), extra: {} }, 'net 0 at high 0');
  assert.equal(parseSave(null).state, 'absent');
  for (const v of [2, 3, 1000]) assert.equal(parseSave(JSON.stringify({ v })).state, 'newer', `v ${v}`);
  assert.equal(parseSave(JSON.stringify({ ...JSON.parse(text), v: 2, id: 7, net: 'x' })).state, 'newer', 'a newer record, whatever its fields hold');
  const of = (over) => JSON.stringify({ ...JSON.parse(text), ...over });
  const { recent, ...noRecent } = JSON.parse(text), { continues, ...noContinues } = JSON.parse(text), { v, ...noV } = JSON.parse(text);
  const damaged = [
    '', '{', '{not json', 'null', '[]', '3', '"x"', JSON.stringify([full]),
    of({ v: 0 }), of({ v: 1.5 }), of({ v: '1' }), of({ v: -1 }), of({ v: true }), of({ v: '2' }), of({ v: 2.5 }), JSON.stringify(noV),
    of({ net: 21 }), of({ net: 1.5 }), of({ net: '3' }), of({ high: -1 }), of({ high: 2.5 }), of({ high: '20' }),
    of({ wallet: -1 }), of({ wallet: 1.5 }), of({ continues: -1 }), JSON.stringify(noContinues), JSON.stringify(noRecent),
    of({ recent: [['x', '1']] }), of({ recent: [['0,0', '1'], ['1,0', ''], ['2,0', '']] }), of({ recent: 'no' }),
    of({ id: 'AAAAAAA' }), of({ id: 'aaaaaaaa' }), of({ id: 8 }), of({ save: 'junk' }), of({ level: 'impossible' }), of({ start: '0;0' }),
  ];
  for (const t of damaged) assert.equal(parseSave(t).state, 'damaged', t);
});

test('a record\'s unknown fields ride every write of its save, merges included, and no binding write', () => {
  const extra = { skins: ['gold', 'jade'], later: { n: 1 } };
  const io = putRecord(memoryIo(), 1, { net: 3, high: 3, wallet: 5 }, extra);
  const kept = () => {
    const o = JSON.parse(io.m.get(K1));
    return { skins: o.skins, later: o.later };
  };
  assert.ok(commitSave(io, K1, recordOf({ net: 4, high: 4, wallet: 5 }), { coins: 1, paid: 3 }).ok);
  assert.deepEqual(kept(), extra, 'a same-id write keeps them');
  assert.deepEqual(heldAt(io).extra, extra);
  // A second tab on the save, behind the first: its write merges and keeps them too.
  assert.ok(commitSave(io, K1, recordOf({ net: 1, high: 1, wallet: 2 })).ok);
  assert.deepEqual(kept(), extra, 'a merge keeps them');
  assert.deepEqual([heldAt(io).record.high, heldAt(io).record.wallet], [4, 5 + 1 + COIN_RATE.medium]);
  // OVERWRITE's binding write starts a new save, which inherits none.
  assert.ok(takeSave(io, K1, recordOf({ id: 'BBBBBBBB' }), { over: 'AAAAAAAA' }).ok);
  assert.deepEqual([heldAt(io).record.id, heldAt(io).extra], ['BBBBBBBB', {}]);
  assert.deepEqual(kept(), { skins: undefined, later: undefined });
});

test('no write and no erase touches a newer build\'s record, and the bound write reports the run unbound', () => {
  const newer = JSON.stringify({ v: 2, id: 'AAAAAAAA', save: SAVE, wallet: 900, skins: ['gold'] });
  const over = (op) => {
    const io = memoryIo();
    io.m.set(K1, newer);
    const out = op(io);
    assert.equal(io.m.get(K1), newer);
    return out;
  };
  assert.equal(over((io) => commitSave(io, K1, recordOf({ id: 'CCCCCCCC' }))).ok, false, 'a bound write reports the run unbound');
  assert.equal(over((io) => commitSave(io, K1, recordOf({ wallet: 5 }), { coins: 1 })).ok, false, 'a same-id write');
  assert.equal(over((io) => takeSave(io, K1, recordOf({ id: 'BBBBBBBB' }))).ok, false, 'a binding write');
  assert.equal(over((io) => takeSave(io, K1, recordOf({ id: 'BBBBBBBB' }), { over: 'AAAAAAAA' })).ok, false, 'OVERWRITE');
  assert.equal(over((io) => eraseSave(io, K1, 'AAAAAAAA')).ok, false, 'ERASE');
  assert.equal(over((io) => migrateSaves(io)), false, 'migration');
});

test('the pay follows rises of the high: nothing at the stored high, the rate per step, each milestone once across tabs', () => {
  for (const [level, rate] of Object.entries(COIN_RATE)) {
    assert.equal(risePay(level, 0, 1), rate, `${level}: 0 to 1`);
    assert.equal(risePay(level, 99, 100), rate + 100, `${level}: 99 to 100`);
    assert.equal(risePay(level, 1, 1), 0, `${level}: no rise`);
    assert.equal(risePay(level, 5, 3), 0, `${level}: below the paid high`);
    // A stored high of 1 pays nothing for a count of 1, whatever the writer had paid.
    assert.equal(commitSave(putRecord(memoryIo(), 1, { level, net: 1, high: 1 }), K1, recordOf({ level, net: 1, high: 1 }), { paid: 0 }).earned, 0);
    assert.equal(commitSave(putRecord(memoryIo(), 1, { level }), K1, recordOf({ level, net: 1, high: 1 }), { paid: 0 }).earned, rate);
    assert.equal(commitSave(putRecord(memoryIo(), 1, { level, net: 99, high: 99 }), K1, recordOf({ level, net: 100, high: 100 }), { paid: 99 }).earned,
      rate + 100);
  }
  // Two same-id writers that both rise to 100 are paid once; the later one sees the merged high.
  const io = putRecord(memoryIo(), 1, { level: 'easy', net: 99, high: 99, wallet: 10 });
  const rise = () => commitSave(io, K1, recordOf({ level: 'easy', net: 100, high: 100, wallet: 10 }), { paid: 99 });
  const a = rise(), b = rise();
  assert.deepEqual([a.earned, a.seen, b.earned, b.seen], [101, 99, 0, 100]);
  assert.equal(heldAt(io).record.wallet, 111);
  // A binding write pays against the run's own paid high: a coin and a first tomb.
  const free = memoryIo();
  const took = takeSave(free, K1, recordOf({ net: 1, high: 1, wallet: 4 }), { coins: 1, paid: 0 });
  assert.deepEqual([took.ok, took.earned, took.seen, heldAt(free).record.wallet], [true, 1 + COIN_RATE.medium, 0, 4 + 1 + COIN_RATE.medium]);
});

test('a same-id write merges wallet, high and continues by maximum and takes save, net, start and recent from the writer', () => {
  const stored = { save: 'K7Q2-M9XA:13', start: '0,0', net: 5, high: 9, wallet: 40, continues: 3, recent: [['0,0', 'f']] };
  const writer = recordOf({ save: 'K7Q2-M9XA:14', start: '1,0', net: 2, high: 4, wallet: 10, continues: 1, recent: [['1,0', '3']] });
  const io = putRecord(memoryIo(), 1, stored);
  const out = commitSave(io, K1, writer);
  assert.deepEqual(heldAt(io).record, { ...writer, high: 9, wallet: 40, continues: 3 });
  assert.deepEqual(out.record, heldAt(io).record);
  const ahead = recordOf({ ...stored, net: 12, high: 12, wallet: 50, continues: 4 });
  commitSave(io, K1, ahead);
  assert.deepEqual(heldAt(io).record, ahead, 'the larger side wins from either end');
  // A later write that finds another id, no record or a damaged one stores nothing and reports the run unbound.
  for (const [what, text] of [['another id', serializeSave(recordOf({ id: 'BBBBBBBB', wallet: 7 }))], ['a damaged key', '{'], ['no record', null]]) {
    const other = memoryIo();
    if (text !== null) other.m.set(K1, text);
    assert.equal(commitSave(other, K1, recordOf({ wallet: 99 }), { coins: 1 }).ok, false, what);
    assert.equal(other.load(K1), text, what);
  }
  // A binding write takes an empty or damaged slot, and reports a slot another writer filled.
  for (const text of [null, '{', JSON.stringify({ v: 1, id: 'AAAAAAAA' })]) {
    const io2 = memoryIo();
    if (text !== null) io2.m.set(K1, text);
    const took = takeSave(io2, K1, recordOf({ id: 'BBBBBBBB', wallet: 3 }));
    assert.deepEqual([took.ok, heldAt(io2).record.id, heldAt(io2).record.wallet], [true, 'BBBBBBBB', 3], String(text));
  }
  const filled = putRecord(memoryIo(), 1, { id: 'CCCCCCCC' }), before = filled.m.get(K1);
  const lost = takeSave(filled, K1, recordOf({ id: 'BBBBBBBB' }));
  assert.deepEqual([lost.ok, lost.held.state, lost.held.record.id, filled.m.get(K1)], [false, 'valid', 'CCCCCCCC', before]);
  // OVERWRITE takes the record it drew and no other; ERASE removes the record it drew and no other.
  assert.equal(takeSave(filled, K1, recordOf({ id: 'BBBBBBBB' }), { over: 'DDDDDDDD' }).ok, false);
  assert.equal(filled.m.get(K1), before);
  assert.equal(eraseSave(filled, K1, 'DDDDDDDD').ok, false);
  assert.equal(filled.m.get(K1), before);
  assert.equal(eraseSave(filled, K1, 'CCCCCCCC').ok, true);
  assert.equal(filled.load(K1), null);
});

test('migration moves the old slot or the legacy keys to slot 1 once per device, the marker after the write', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `0,${-1 - i}`);
  // An old slot of 20 solved tombs and a record of 50: net 20 and high 50, and the old slot stays as stored.
  const io = memoryIo();
  const old = JSON.stringify(olderSlot({ id: 'QQQQQQQQ', solved: twenty, record: 50, wallet: 300, tombs: ['0,0'] }));
  io.m.set(SLOT_KEY, old);
  assert.equal(migrateSaves(io), true);
  assert.deepEqual(heldAt(io).record, recordOf({ id: 'QQQQQQQQ', net: 20, high: 50, wallet: 300 }));
  assert.equal(io.load(MIGRATED_KEY), '1');
  assert.equal(io.m.get(SLOT_KEY), old, 'the old slot is never written or removed');
  assert.deepEqual([heldAt(io, 2).state, heldAt(io, 3).state], ['absent', 'absent']);
  // Once migrated, erasing every slot never brings the old save back.
  io.m.delete(K1);
  assert.equal(migrateSaves(io), false);
  assert.deepEqual([io.load(K1), io.m.size], [null, 2]);
  // The seven legacy keys through legacySlot, after which they are absent.
  const legacy = memoryIo();
  for (const [k, value] of Object.entries({
    [LEGACY_KEYS.save]: SAVE, [LEGACY_KEYS.difficulty]: 'medium',
    [LEGACY_KEYS.run]: JSON.stringify({ save: SAVE, start: '3,-2', solved: ['3,-2', '3,-1'] }),
    [LEGACY_KEYS.wallet]: '57', [LEGACY_KEYS.paid]: JSON.stringify({ [KEY]: 12 }), [LEGACY_KEYS.tombs]: JSON.stringify({ [KEY]: ['3,-2'] }),
    [LEGACY_KEYS.coins]: JSON.stringify({ [KEY]: ['0,0,21'] }),
  })) legacy.m.set(k, value);
  legacy.m.set(SLOT_KEY, '{');
  assert.equal(migrateSaves(legacy), true);
  const got = heldAt(legacy).record;
  assert.match(got.id, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.deepEqual({ ...got, id: 'AAAAAAAA' }, recordOf({ start: '3,-2', net: 2, high: 12, wallet: 57 }));
  for (const k of Object.values(LEGACY_KEYS)) assert.equal(legacy.load(k), null, k);
  assert.equal(legacy.m.get(SLOT_KEY), '{');
  // An unparseable source migrates nothing but the marker.
  const junk = memoryIo();
  junk.m.set(SLOT_KEY, '{not json');
  junk.m.set(LEGACY_KEYS.save, 'junk');
  assert.equal(migrateSaves(junk), true);
  assert.deepEqual([junk.load(K1), junk.load(MIGRATED_KEY), junk.m.get(SLOT_KEY)], [null, '1', '{not json']);
  // A slot 1 write that fails leaves the marker absent, so the next boot migrates again.
  const full = memoryIo();
  full.m.set(SLOT_KEY, old);
  const store = full.store;
  full.store = (k, value) => k !== K1 && store(k, value);
  assert.equal(migrateSaves(full), false);
  assert.deepEqual([full.load(K1), full.load(MIGRATED_KEY)], [null, null]);
  full.store = store;
  assert.equal(migrateSaves(full), true);
  assert.equal(heldAt(full).record.id, 'QQQQQQQQ');
  // A save key in place, marker or not, leaves migration out.
  const placed = putRecord(memoryIo(), 3, { id: 'CCCCCCCC' });
  placed.m.set(SLOT_KEY, old);
  assert.equal(migrateSaves(placed), false);
  assert.deepEqual([placed.load(K1), placed.load(MIGRATED_KEY)], [null, null]);
});
