// Coins: the payout rules, the storage shapes of the wallet, the collected
// set, the solved tombs and the payout record, and the merge that writes them.
// DOM-free; main.mjs supplies the storage.
import { MILESTONE } from './ranks.mjs';

// The four coin keys. Each coin write re-reads and merges all four.
export const COIN_KEYS = {
  wallet: 'infinite-maze.wallet',
  coins: 'infinite-maze.plane.coins',
  paid: 'infinite-maze.plane.coins.paid',
  tombs: 'infinite-maze.plane.coins.tombs',
};

// Coins per tomb, by the world's difficulty.
export const COIN_RATE = { easy: 1, medium: 2, hard: 5, ultimate: 10 };

/**
 * Coins due when a run's tomb count rises from `record`, the highest count paid, to `count`:
 * the level rate per tomb, plus 100 x k for each milestone k with record < 100k <= count.
 */
export function tombPayout(difficulty, record, count) {
  const tombs = count > record ? COIN_RATE[difficulty] * (count - record) : 0;
  const last = Math.floor(count / MILESTONE);
  const first = Math.floor(record / MILESTONE) + 1;
  const milestones = last >= first ? (MILESTONE * (first + last) * (last - first + 1)) / 2 : 0;
  return tombs + milestones;
}

/** The key of a seed and level in the collected set and the record: `K7Q2M9XA:MEDIUM`. */
export function coinKey(code, difficulty) {
  return `${code}:${difficulty.toUpperCase()}`;
}

/** The key of a coin in a collected set: its board and cell. */
export function coinId(bd, cell) {
  return `${bd.x},${bd.y},${cell}`;
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

/** The collected set as Map(key -> Set("x,y,cell")); malformed input reads as empty. */
export function parseCollected(text) {
  const out = new Map();
  for (const [key, list] of parseObject(text)) {
    if (!Array.isArray(list)) continue;
    out.set(key, new Set(list.filter((id) => typeof id === 'string' && /^-?\d+,-?\d+,\d+$/.test(id))));
  }
  return out;
}

export function serializeCollected(collected) {
  const out = {};
  for (const [key, set] of collected) if (set.size) out[key] = [...set];
  return JSON.stringify(out);
}

/** The payout record as Map(key -> highest tomb count paid); malformed input reads as empty. */
export function parsePaid(text) {
  const out = new Map();
  for (const [key, n] of parseObject(text)) if (isCount(n)) out.set(key, n);
  return out;
}

export function serializePaid(paid) {
  return JSON.stringify(Object.fromEntries(paid));
}

/** The tombs paid as Map(key -> Set("u,v")); malformed input reads as empty. */
export function parseTombs(text) {
  const out = new Map();
  for (const [key, list] of parseObject(text)) {
    if (!Array.isArray(list)) continue;
    out.set(key, new Set(list.filter((id) => typeof id === 'string' && /^-?\d+,-?\d+$/.test(id))));
  }
  return out;
}

export function serializeTombs(tombs) {
  const out = {};
  for (const [key, set] of tombs) if (set.size) out[key] = [...set];
  return JSON.stringify(out);
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

/** Adds each id of `from`, Map(key -> Set), into the Sets of `into`, in place. */
function unionInto(into, from) {
  for (const [key, set] of from) {
    let mine = into.get(key);
    if (!mine) into.set(key, (mine = new Set()));
    for (const id of set) mine.add(id);
  }
}

/**
 * Writes the coin state `{ wallet, coins, tombs, paid }` through `io`
 * `{ load(key), store(key, value) }` without losing what another tab wrote:
 * re-reads storage, merges it into `state` (the wallet and records by max, the
 * Sets by union, in place so a running sim sees them), then adds
 * `pay(state, stored)`, the coins earned on the merged state, to the wallet and
 * rewrites all four keys. `stored` is what storage held before the merge.
 * Returns the coins earned.
 */
export function commitCoins(io, state, pay) {
  const stored = {
    wallet: parseWallet(io.load(COIN_KEYS.wallet)),
    coins: parseCollected(io.load(COIN_KEYS.coins)),
    tombs: parseTombs(io.load(COIN_KEYS.tombs)),
    paid: parsePaid(io.load(COIN_KEYS.paid)),
  };
  state.wallet = Math.max(state.wallet, stored.wallet);
  unionInto(state.coins, stored.coins);
  unionInto(state.tombs, stored.tombs);
  for (const [key, n] of stored.paid) state.paid.set(key, Math.max(state.paid.get(key) || 0, n));
  const earned = pay(state, stored);
  state.wallet += earned;
  io.store(COIN_KEYS.wallet, String(state.wallet));
  io.store(COIN_KEYS.coins, serializeCollected(state.coins));
  io.store(COIN_KEYS.tombs, serializeTombs(state.tombs));
  io.store(COIN_KEYS.paid, serializePaid(state.paid));
  return earned;
}
