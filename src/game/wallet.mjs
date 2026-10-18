// Coins: the payout rules, the save slot that holds a run's serial, tomb count,
// wallet, continue count and the takes of its last two tombs, and the merge
// that writes it. DOM-free; main.mjs supplies the storage.
import { MILESTONE } from './ranks.mjs';
import { decodeSave } from '../world/save.mjs';
import { tombOf, boardCoords } from '../world/world.mjs';
import { NCELL } from '../world/board.mjs';
import { ROW_COINS, floorItems, coinRows } from '../world/floor.mjs';
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

/** The key of a seed and level in the tomb set and the record: `K7Q2M9XA:MEDIUM`. */
export function coinKey(code, difficulty) {
  return `${code}:${difficulty.toUpperCase()}`;
}

/**
 * The key of a coin in a run's taken set: `x,y,cell` for the dead-end coin or
 * jar on `cell`; `x,y,n` with n = NCELL + ROW_COINS * cell + i for coin `i` of
 * the row east of `cell`. The row form starts past the last cell, so the two
 * kinds never collide.
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
 * The pay rule for floor coins: 1 for each of `ids`, the coins a tick took.
 * The run's taken set keeps a coin from paying twice while its tomb is one of
 * the run's two recent tombs; the slot stores those takes as bits (`recent`).
 */
export function coinPay(ids) {
  return () => ids.length;
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

const BITS = /^[0-9a-f]*$/;

/**
 * The `recent` field as [[tomb, bits], …], latest tomb first. An absent field
 * reads as [], and so does a malformed one, which leaves the slot parsed: not
 * an array, more than two entries, an entry that is not a pair of strings, a
 * tomb failing TOMB_ID, a repeated tomb or bits outside lowercase hex.
 */
function parseRecent(list) {
  if (!Array.isArray(list) || list.length > 2) return [];
  const seen = new Set();
  for (const e of list) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string') return [];
    if (!TOMB_ID.test(e[0]) || !BITS.test(e[1]) || seen.has(e[0])) return [];
    seen.add(e[0]);
  }
  return list.map(([key, bits]) => [key, bits]);
}

/**
 * The slot in `text` as { id, save, level, start, solved, wallet, tombs,
 * record, continues, recent }, or null when absent, malformed or any id or
 * count fails its check. `save` is the serial, `level` its difficulty, `start`
 * the run's start tomb "u,v", `solved` its solved tombs, `tombs` the tombs the
 * wallet has been paid for, `continues` the run's continue count, 0 when
 * absent, and `recent` the takes of the run's last two tombs (`parseRecent`).
 * The stored `coins` list is ignored whatever it holds: older builds read the
 * field, and a slot without it would read as no slot there.
 */
export function parseSlot(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const ok = typeof v.id === 'string' && SLOT_ID.test(v.id)
    && typeof v.save === 'string' && decodeSave(v.save) !== null
    && Object.hasOwn(COIN_RATE, v.level)
    && typeof v.start === 'string' && TOMB_ID.test(v.start)
    && idList(v.solved, TOMB_ID) && idList(v.tombs, TOMB_ID)
    && isCount(v.wallet) && isCount(v.record) && (v.continues === undefined || isCount(v.continues));
  if (!ok) return null;
  const { id, save, level, start, solved, wallet, tombs, record } = v;
  return { id, save, level, start, solved, wallet, tombs, record, continues: v.continues ?? 0, recent: parseRecent(v.recent) };
}

/** The slot as text; its lists may be arrays or Sets. It writes `coins` empty, for older builds. */
export function serializeSlot(slot) {
  const { id, save, level, start, wallet, record, continues, recent = [] } = slot;
  return JSON.stringify({
    id, save, level, start, solved: [...slot.solved], wallet, coins: [], tombs: [...slot.tombs], record, continues, recent,
  });
}

/**
 * The items of tomb `key` ("u,v") in the slot's bit order, as { ids, jars }:
 * the ids of its jars, then its dead-end coins, then its row coins, each kind
 * by board index, cell and row coin; the first `jars` ids are jars. It builds
 * the tomb's boards the world has dropped, so a run reads it once while the
 * tomb stays recent.
 */
export function tombItems(world, key) {
  const [u, v] = key.split(',').map(Number);
  const jars = [], coins = [], rows = [];
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(u, v, i, world.size);
    const bd = world.board(x, y);
    for (const { cell, kind } of floorItems(world, bd)) {
      if (kind === 'oil') jars.push(coinId(bd, cell));
      else if (kind === 'coin') coins.push(coinId(bd, cell));
    }
    for (const cell of coinRows(world, bd)) for (let j = 0; j < ROW_COINS; j++) rows.push(coinId(bd, cell, j));
  }
  return { ids: [...jars, ...coins, ...rows], jars: jars.length };
}

/**
 * The slot's `recent` for sim `s`: per recent tomb, latest first, a pair
 * [tomb, bits]. Item k of the tomb's `tombItems` is hex digit k >> 2, value
 * 1 << (k & 3), set when taken; trailing 0 digits drop. It reads the sim's
 * stored item lists and builds a board only for a tomb the sim holds none of.
 */
export function packRecent(world, s) {
  return s.recent.map((key) => {
    const { ids, jars } = (s.items && s.items.get(key)) || tombItems(world, key);
    let bits = '';
    for (let k = 0; k < ids.length; k += 4) {
      let digit = 0;
      for (let m = 0; m < 4 && k + m < ids.length; m++) {
        if ((k + m < jars ? s.jars : s.collected).has(ids[k + m])) digit |= 1 << m;
      }
      bits += digit.toString(16);
    }
    return [key, bits.replace(/0+$/, '')];
  });
}

/**
 * A parsed `recent` as { recent, collected, jars }, the takes `createSim`'s
 * carry holds. A bit past a tomb's last item is ignored.
 */
export function unpackRecent(world, recent) {
  const collected = new Set(), jars = new Set();
  for (const [key, bits] of recent) {
    const { ids, jars: n } = tombItems(world, key);
    for (let k = 0; k < ids.length; k++) {
      if ((parseInt(bits[k >> 2] ?? '0', 16) >> (k & 3)) & 1) (k < n ? jars : collected).add(ids[k]);
    }
  }
  return { recent: recent.map(([key]) => key), collected, jars };
}

/**
 * The slot the seven old keys describe, under a fresh id, or null when they
 * hold no save. `load(key)` reads storage. The wallet is the device's; the
 * tombs and the record are those of the save's seed and level. The run is the
 * old run when it names the save; else it starts at the save's own tomb, as a
 * typed save code does. The old coin key is not read, the continue count is 0
 * and no tomb is recent.
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
    tombs: [...(parseIdSets(load(LEGACY_KEYS.tombs), TOMB_ID).get(key) || [])],
    record: parsePaid(load(LEGACY_KEYS.paid)).get(key) || 0,
    continues: 0,
    recent: [],
  };
}

/**
 * Writes the run state `{ id, save, level, start, solved, wallet, tombs,
 * record, continues, recent }` (solved and tombs are Sets) through `io`
 * `{ load(key), store(key, value), remove(key) }` without losing what another
 * tab wrote. A stored slot with the same id is the same run: its wallet, record
 * and continue count merge by max and its tombs by union, in place so a running
 * sim sees them. Any other slot, or none, is replaced whole, and `pay` sees an
 * empty stored state. The run fields are the writer's, `recent` among them: two
 * tabs on one slot are two runs, each with its own takes.
 * `pay(state, stored)` returns the coins this write earns, with `state` and
 * `stored` holding the slot's tombs and record as one-entry Maps keyed by
 * `coinKey(seed, level)`; they join the wallet. The first write removes the
 * legacy keys. Returns the coins earned.
 */
export function commitSlot(io, state, pay) {
  const held = parseSlot(io.load(SLOT_KEY));
  const key = coinKey(decodeSave(state.save).code, state.level);
  const same = held !== null && held.id === state.id;
  const was = same ? held : { wallet: 0, tombs: [], record: 0, continues: 0 };
  if (same) {
    state.wallet = Math.max(state.wallet, was.wallet);
    for (const id of was.tombs) state.tombs.add(id);
    state.record = Math.max(state.record, was.record);
    state.continues = Math.max(state.continues, was.continues);
  }
  const view = (wallet, tombs, record) => (
    { wallet, tombs: new Map([[key, tombs]]), paid: new Map([[key, record]]) });
  const now = view(state.wallet, state.tombs, state.record);
  const earned = pay(now, view(was.wallet, new Set(was.tombs), was.record));
  state.wallet += earned;
  state.record = now.paid.get(key);
  io.store(SLOT_KEY, serializeSlot(state));
  for (const old of Object.values(LEGACY_KEYS)) io.remove(old);
  return earned;
}
