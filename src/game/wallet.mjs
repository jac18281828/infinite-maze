// Coins: the payout rule and the storage shapes of the wallet, the collected
// set and the payout record. DOM-free; main.mjs does the reading and writing.
import { MILESTONE } from './ranks.mjs';

// Coins per tomb, by the world's difficulty.
export const COIN_RATE = { easy: 1, medium: 2, hard: 5 };

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
