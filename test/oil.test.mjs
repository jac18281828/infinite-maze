import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worlds, sample } from './sample.mjs';
import { floorItems, itemSpot } from '../src/world/floor.mjs';
import {
  createSim, step, feet, nodeXY, inputEdges, runCarry, BURN_S, EMBER_S, JAR_S, TICK,
} from '../src/game/sim.mjs';
import { createAutopilot } from '../src/game/autopilot.mjs';
import { coinId } from '../src/game/wallet.mjs';

const near = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * Walks a sim from the neighbour across the jar's cell's link to the cell,
 * then toward the jar's spot. Until the jar is taken, the burn and ember are
 * pinned before every tick to `burn` and `ember`. Returns the contact tick
 * (the first with the feet within 12 px of the spot) with the burn before and
 * after it, that tick's events and whether the jar was taken on it, then
 * walks 30 ticks away and 30 back and counts the ticks that raised the burn.
 */
function walk(world, { bd, cell, link }, { burn = BURN_S, ember = 0, carry = null } = {}) {
  const to = world.step(bd, cell, link);
  const [sx, sy] = itemSpot(bd, cell);
  const side = Math.sign(sx - nodeXY(bd, cell)[0]);
  const sim = createSim(world, { board: to.board, cell: to.cell }, carry);
  const auto = createAutopilot(world, [{ x: bd.x, y: bd.y, cell }]);
  const id = coinId(bd, cell);
  const out = { sim, id, contact: -1, before: null, after: null, events: [], takenBefore: null, takenOn: null, raises: 0 };
  let ph = 0, pv = 0, back = 0;
  for (let i = 0; i < 1500 && back < 60; i++) {
    const arrived = sim.bd === bd && sim.cell === cell && sim.mode === 'floor';
    const away = out.contact >= 0;
    if (!away) { sim.burn = burn; sim.ember = ember; }
    const [h, v, jump] = away ? [back++ < 30 ? -side : side, 0, false] : arrived ? [side, 0, false] : auto(sim);
    const was = sim.burn, had = sim.jars.has(id);
    step(sim, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    const [fx, fy] = feet(sim);
    if (!away && Math.abs(fx - sx) <= 12 && Math.abs(fy - sy) <= 12) {
      out.contact = i;
      out.before = was;
      out.after = sim.burn;
      out.events = [...sim.events];
      out.takenBefore = had;
      out.takenOn = sim.jars.has(id);
    } else if (away && sim.burn > was) {
      out.raises++;
    }
  }
  return out;
}

/** Jars of tomb sample boards, up to `per` for each link direction, that a walk reaches with no flame. */
function jarsByLink(d, per) {
  const world = worlds[d];
  const count = new Map(), out = [];
  for (const bd of sample(d, 39)) {
    for (const { cell, kind } of floorItems(world, bd)) {
      if (kind !== 'oil') continue;
      const link = Math.log2(bd.links[cell]);
      if ((count.get(link) || 0) >= per) continue;
      const jar = { bd, cell, link };
      const probe = walk(world, jar);
      if (probe.contact < 0 || probe.sim.stats.flames > 0) continue;
      count.set(link, (count.get(link) || 0) + 1);
      out.push(jar);
    }
  }
  return out;
}

const jars = jarsByLink('medium', 1);

test('a jar adds 60 s, the owner\'s figure', () => {
  assert.equal(JAR_S, 60);
});

test('the sample holds a jar at the end of each of the eight link directions', () => {
  assert.equal(jars.length, 8);
});

test('at burn 100 s a jar adds JAR_S on the tick the feet come within 12 px, net of that tick\'s own burn, and relights', () => {
  for (const jar of jars) {
    const w = walk(worlds.medium, jar, { burn: 100 });
    assert.ok(w.contact >= 0, `the feet reach the jar on cell ${jar.cell} of board (${jar.bd.x},${jar.bd.y})`);
    assert.equal(w.takenBefore, false);
    assert.equal(w.takenOn, true, 'taken on the contact tick');
    assert.ok(near(w.after - w.before, JAR_S - TICK), `${w.after - w.before}`);
    assert.deepEqual(w.events, ['relight']);
    assert.deepEqual([...w.sim.jars], [w.id]);
    assert.equal(w.sim.collected.size, 0, 'a jar leaves the coin set alone');
  }
});

test('at burn 280 s a jar takes the burn to BURN_S less that tick\'s own burn', () => {
  for (const jar of jars) {
    const w = walk(worlds.medium, jar, { burn: 280 });
    assert.equal(w.takenOn, true);
    assert.ok(near(w.after, BURN_S - TICK), `${w.after}`);
    assert.deepEqual(w.events, ['relight']);
  }
});

test('a full torch takes the jar and the cap wastes it; the event is a touch', () => {
  for (const jar of jars) {
    for (const burn of [BURN_S, BURN_S * 0.98 + 0.5]) {
      const w = walk(worlds.medium, jar, { burn });
      assert.equal(w.takenOn, true, `taken at ${burn}`);
      assert.ok(near(w.after, BURN_S - TICK), `${w.after}`);
      assert.deepEqual(w.events, ['touch'], `at ${burn}`);
    }
  }
});

test('the jar adds before the tick\'s own burn: a torch about to gutter does not', () => {
  for (const jar of jars) {
    const w = walk(worlds.medium, jar, { burn: TICK / 2 });
    assert.ok(near(w.after, JAR_S + TICK / 2 - TICK), `${w.after}`);
    assert.equal(w.sim.ember, 0);
    assert.ok(!w.events.includes('ember'));
  }
});

test('during the ember a jar sets the burn to JAR_S, ends the ember and relights', () => {
  for (const jar of jars) {
    const w = walk(worlds.medium, jar, { burn: 0, ember: EMBER_S / 2 });
    assert.equal(w.takenOn, true);
    assert.ok(near(w.after, JAR_S - TICK), `${w.after}`);
    assert.equal(w.sim.ember, 0);
    assert.equal(w.sim.state, 'play');
    assert.deepEqual(w.events, ['relight']);
  }
});

test('walking away and back from a taken jar adds nothing', () => {
  for (const jar of jars) {
    const w = walk(worlds.medium, jar, { burn: 100 });
    assert.equal(w.takenOn, true);
    assert.equal(w.raises, 0, 'the burn only falls after the pickup');
    assert.deepEqual([...w.sim.jars], [w.id]);
    assert.ok(near(w.after - w.sim.burn, 60 * TICK), 'the 60 ticks away and back burn one TICK each');
  }
});

test('a new sim, fresh or from runCarry, finds the jar back and takes it again', () => {
  for (const jar of jars) {
    const first = walk(worlds.medium, jar, { burn: 100 });
    assert.equal(first.takenOn, true);
    const fresh = walk(worlds.medium, jar, { burn: 100 });
    assert.equal(fresh.takenOn, true, 'fresh');
    assert.ok(near(fresh.after - fresh.before, JAR_S - TICK));
    const carried = walk(worlds.medium, jar, { burn: 100, carry: runCarry(first.sim) });
    assert.equal(carried.takenBefore, false, 'runCarry carries no jars');
    assert.equal(carried.takenOn, true, 'carried');
    assert.ok(near(carried.after - carried.before, JAR_S - TICK));
    assert.ok(!('jars' in runCarry(first.sim)));
  }
});
