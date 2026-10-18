// Coins: the payout rules, the save slot that holds a run's serial, tomb count
// and wallet, and the merge that writes it. DOM-free; main.mjs supplies the
// storage.
import { MILESTONE } from './ranks.mjs';
import { decodeSave } from '../world/save.mjs';
import { tombOf } from '../world/world.mjs';
import { NCELL } from '../world/board.mjs';
import { ROW_COINS } from '../world/floor.mjs';
import { DIFFICULTY } from '../world/band.mjs';
import { formatCode, CROCKFORD } from '../world/hash.mjs';

// The one key of the save slot: a JSON object, written whole.
export const SLOT_KEY = 'infinite-maze.plane.slot';

// The seven keys the slot replaced. A slot write removes them; `legacySlot`
// reads them once.
export const LEGACY_KEYS = {
  save: 'infinite-maze.plane.save',
  difficulty: 'infinite-maze.plane.save.difficulty',
  run: 'infinite-maze.plane.save.run',
  wallet: 'infinite-maze.wallet',
  coins: 'infinite-maze.plane.coins',
  paid: 'infinite-maze.plane.coins.paid',
  tombs: 'infinite-maze.plane.coins.tombs',
};

// Coins per tomb, by the world's difficulty.
export const COIN_RATE = { easy: 1, medium: 2, hard: 5, ultimate: 10 };

/**
 * The milestone coins due when a run's tomb count reaches `count` and the
 * highest count paid on the seed and level is `record`: 100 x k for each
 * milestone k with record < 100k <= count.
 */
export function milestonePayout(record, count) {
  const last = Math.floor(count / MILESTONE);
  const first = Math.floor(record / MILESTONE) + 1;
  return last >= first ? (MILESTONE * (first + last) * (last - first + 1)) / 2 : 0;
}

/** The key of a seed and level in the collected set and the record: `K7Q2M9XA:MEDIUM`. */
export function coinKey(code, difficulty) {
  return `${code}:${difficulty.toUpperCase()}`;
}

/**
 * The key of a coin in a collected set: `x,y,cell` for the dead-end coin or jar
 * on `cell`; `x,y,n` with n = NCELL + ROW_COINS * cell + i for coin `i` of the
 * row east of `cell`. The row form starts past the last cell, so the two kinds
 * never collide.
 */
export function coinId(bd, cell, i) {
  return `${bd.x},${bd.y},${i === undefined ? cell : NCELL + ROW_COINS * cell + i}`;
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

function parseObject(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [];
  } catch {
    return [];
  }
}

/** The wallet stored as a decimal integer; anything else reads as 0. */
export function parseWallet(text) {
  const n = /^\d+$/.test(text || '') ? Number(text) : NaN;
  return isCount(n) ? n : 0;
}

/** The pattern of a coin id in a collected set: "x,y,cell". */
export const COIN_ID = /^-?\d+,-?\d+,\d+$/;
/** The pattern of a tomb id in a solved set or a run: "u,v". */
export const TOMB_ID = /^-?\d+,-?\d+$/;

/** An id-set store as Map(key -> Set(id)), keeping the ids that match `pattern`; malformed input reads as empty. */
export function parseIdSets(text, pattern) {
  const out = new Map();
  for (const [key, list] of parseObject(text)) {
    if (!Array.isArray(list)) continue;
    out.set(key, new Set(list.filter((id) => typeof id === 'string' && pattern.test(id))));
  }
  return out;
}

/** The payout record as Map(key -> highest tomb count paid); malformed input reads as empty. */
export function parsePaid(text) {
  const out = new Map();
  for (const [key, n] of parseObject(text)) if (isCount(n)) out.set(key, n);
  return out;
}

/**
 * The pay rule for floor coins: 1 for each of `ids`, the coins a tick took,
 * that storage did not already list for `key`. Memory ids that storage lacks
 * never count, so blocked storage cannot credit a coin twice.
 */
export function coinPay(key, ids) {
  return (state, stored) => {
    const had = stored.coins.get(key);
    return ids.filter((id) => !(had && had.has(id))).length;
  };
}

/**
 * The pay rule for a tick that raised the run count to `count`: the level's
 * rate for each tomb of `solvedNow` the device has not paid, then the
 * milestones past the record. A tomb joins the device's set once paid, and the
 * record becomes the larger of itself and `count`. `pay.seen` is the merged
 * record it found, which decides the splash's paid flag.
 */
export function tombPay(key, level, solvedNow, count) {
  const pay = (state) => {
    let tombs = state.tombs.get(key);
    if (!tombs) state.tombs.set(key, (tombs = new Set()));
    const record = state.paid.get(key) || 0;
    let due = 0;
    for (const id of solvedNow) {
      if (!tombs.has(id)) {
        tombs.add(id);
        due += COIN_RATE[level];
      }
    }
    pay.seen = record;
    state.paid.set(key, Math.max(record, count));
    return due + milestonePayout(record, count);
  };
  pay.seen = 0;
  return pay;
}

const SLOT_ID = new RegExp(`^[${CROCKFORD}]{8}$`);

/** A fresh slot id: eight random base-32 characters. */
export function newSlotId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (n) => CROCKFORD[n & 31]).join('');
}

const idList = (list, pattern) => Array.isArray(list) && list.every((id) => typeof id === 'string' && pattern.test(id));

/**
 * The slot in `text` as { id, save, level, start, solved, wallet, coins, tombs,
 * record }, or null when absent, malformed or any id or count fails its check.
 * `save` is the serial, `level` its difficulty, `start` the run's start tomb
 * "u,v", `solved` its solved tombs and `coins` and `tombs` the sets the wallet
 * depends on.
 */
export function parseSlot(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const ok = typeof v.id === 'string' && SLOT_ID.test(v.id)
    && typeof v.save === 'string' && decodeSave(v.save) !== null
    && Object.hasOwn(COIN_RATE, v.level)
    && typeof v.start === 'string' && TOMB_ID.test(v.start)
    && idList(v.solved, TOMB_ID) && idList(v.tombs, TOMB_ID) && idList(v.coins, COIN_ID)
    && isCount(v.wallet) && isCount(v.record);
  if (!ok) return null;
  const { id, save, level, start, solved, wallet, coins, tombs, record } = v;
  return { id, save, level, start, solved, wallet, coins, tombs, record };
}

/** The slot as text; its lists may be arrays or Sets. */
export function serializeSlot(slot) {
  const { id, save, level, start, wallet, record } = slot;
  return JSON.stringify({
    id, save, level, start, solved: [...slot.solved], wallet, coins: [...slot.coins], tombs: [...slot.tombs], record,
  });
}

/**
 * The slot the seven old keys describe, under a fresh id, or null when they
 * hold no save. `load(key)` reads storage. The wallet is the device's; the
 * sets and the record are those of the save's seed and level. The run is the
 * old run when it names the save; else it starts at the save's own tomb, as a
 * typed save code does.
 */
export function legacySlot(load) {
  const text = load(LEGACY_KEYS.save) || '';
  const at = decodeSave(text);
  if (!at) return null;
  const d = load(LEGACY_KEYS.difficulty);
  const level = Object.hasOwn(COIN_RATE, d) ? d : 'ultimate';
  const key = coinKey(at.code, level);
  const tomb = tombOf(at.x, at.y, DIFFICULTY[level]);
  let run = null;
  try { run = JSON.parse(load(LEGACY_KEYS.run)); } catch { /* no run */ }
  const named = run && typeof run === 'object' && run.save === text && TOMB_ID.test(run.start) && idList(run.solved, TOMB_ID);
  return {
    id: newSlotId(),
    save: `${formatCode(at.code)}:${at.p}`,
    level,
    start: named ? run.start : `${tomb.u},${tomb.v}`,
    solved: named ? run.solved : [],
    wallet: parseWallet(load(LEGACY_KEYS.wallet)),
    coins: [...(parseIdSets(load(LEGACY_KEYS.coins), COIN_ID).get(key) || [])],
    tombs: [...(parseIdSets(load(LEGACY_KEYS.tombs), TOMB_ID).get(key) || [])],
    record: parsePaid(load(LEGACY_KEYS.paid)).get(key) || 0,
  };
}

/**
 * Writes the run state `{ id, save, level, start, solved, wallet, coins, tombs,
 * record }` (coins and tombs are Sets) through `io` `{ load(key), store(key,
 * value), remove(key) }` without losing what another tab wrote. A stored slot
 * with the same id is the same run: its wallet and record merge by max and its
 * Sets by union, in place so a running sim sees them. Any other slot, or none,
 * is replaced whole, and `pay` sees an empty stored state. The run fields are
 * the writer's. `pay(state, stored)` returns the coins this write earns, with
 * `state` and `stored` holding the slot's sets as one-entry Maps keyed by
 * `coinKey(seed, level)`; they join the wallet. The first write removes the
 * legacy keys. Returns the coins earned.
 */
export function commitSlot(io, state, pay) {
  const held = parseSlot(io.load(SLOT_KEY));
  const key = coinKey(decodeSave(state.save).code, state.level);
  const same = held !== null && held.id === state.id;
  const was = same ? held : { wallet: 0, coins: [], tombs: [], record: 0 };
  if (same) {
    state.wallet = Math.max(state.wallet, was.wallet);
    for (const id of was.coins) state.coins.add(id);
    for (const id of was.tombs) state.tombs.add(id);
    state.record = Math.max(state.record, was.record);
  }
  const view = (wallet, coins, tombs, record) => (
    { wallet, coins: new Map([[key, coins]]), tombs: new Map([[key, tombs]]), paid: new Map([[key, record]]) });
  const now = view(state.wallet, state.coins, state.tombs, state.record);
  const earned = pay(now, view(was.wallet, new Set(was.coins), new Set(was.tombs), was.record));
  state.wallet += earned;
  state.record = now.paid.get(key);
  io.store(SLOT_KEY, serializeSlot(state));
  for (const old of Object.values(LEGACY_KEYS)) io.remove(old);
  return earned;
}
