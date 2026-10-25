// Coins and saves: the payout rules, the three save records that each bind a
// run's serial to its net, high, wallet, continue count and the takes of its
// last two tombs, their writes, and the migration from the old single slot.
// DOM-free; main.mjs supplies the storage.
import { MILESTONE } from './ranks.mjs';
import { decodeSave } from '../world/save.mjs';
import { tombOf, boardCoords } from '../world/world.mjs';
import { NCELL } from '../world/board.mjs';
import { ROW_COINS, floorItems, coinRows } from '../world/floor.mjs';
import { DIFFICULTY } from '../world/band.mjs';
import { formatCode, CROCKFORD } from '../world/hash.mjs';

// The old single slot: migration reads it once and never writes or removes it,
// so an older build still finds its save.
export const OLD_SLOT_KEY = 'infinite-maze.plane.slot';

// The seven keys the old slot replaced. Migration reads them through
// `legacySlot`, then removes them.
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
 * The milestone coins due when a save's high rises from `record` to `count`:
 * 100 x k for each milestone k with record < 100k <= count.
 */
export function milestonePayout(record, count) {
  const last = Math.floor(count / MILESTONE);
  const first = Math.floor(record / MILESTONE) + 1;
  return last >= first ? (MILESTONE * (first + last) * (last - first + 1)) / 2 : 0;
}

/** The key of a seed and level in the old keys' tomb sets and records: `K7Q2M9XA:MEDIUM`. */
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

/** The pattern of a tomb id: "u,v". */
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

const SLOT_ID = new RegExp(`^[${CROCKFORD}]{8}$`);

/** A fresh save id: eight random base-32 characters. */
export function newSlotId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (n) => CROCKFORD[n & 31]).join('');
}

const idList = (list, pattern) => Array.isArray(list) && list.every((id) => typeof id === 'string' && pattern.test(id));

const BITS = /^[0-9a-f]*$/;

/**
 * The `recent` field as [[tomb, bits], …], latest tomb first. An absent field
 * reads as [], and so does a malformed one: not an array, more than two
 * entries, an entry that is not a pair of strings, a tomb failing TOMB_ID, a
 * repeated tomb or bits outside lowercase hex. The old slot reads past a
 * malformed field; a record whose field reads short is damaged.
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
 * The old slot in `text`, migration's source, as { id, save, level, start,
 * solved, wallet, tombs, record, continues, recent }, or null when absent,
 * malformed or any id or count fails its check. `save` is the serial, `level`
 * its difficulty, `start` the run's start tomb "u,v", `solved` its solved
 * tombs, `tombs` the tombs the wallet has been paid for, `record` the highest
 * count paid, `continues` the run's continue count, 0 when absent, and
 * `recent` the takes of the run's last two tombs (`parseRecent`). The stored
 * `coins` list is ignored whatever it holds.
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

/**
 * The items of tomb `key` ("u,v") in the record's bit order, as { ids, jars }:
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
 * The record's `recent` for sim `s`: per recent tomb, latest first, a pair
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
 * The old slot the seven legacy keys describe, under a fresh id, or null when
 * they hold no save. `load(key)` reads storage. The wallet is the device's;
 * the tombs and the record are those of the save's seed and level. The run is
 * the old run when it names the save; else it starts at the save's own tomb,
 * as a typed save code does. The old coin key is not read, the continue count
 * is 0 and no tomb is recent.
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

// The three saves, one versioned record under each key, and the marker that
// the migration from the old slot has run on the device.
export const SAVE_V = 1;
export const SAVE_SLOTS = [1, 2, 3];
export const saveKey = (n) => `infinite-maze.save.${n}`;
export const MIGRATED_KEY = 'infinite-maze.save.migrated';

// The record's fields in the order a write puts them; any other is unknown.
// `played`, the time of the record's last play write, is optional: a record
// of revision 1's beta holds none.
const SAVE_FIELDS = ['v', 'id', 'save', 'level', 'start', 'net', 'high', 'wallet', 'continues', 'recent', 'played'];
const ABSENT = Object.freeze({ state: 'absent' });
const NEWER = Object.freeze({ state: 'newer' });
const DAMAGED = Object.freeze({ state: 'damaged' });

/**
 * A save key's text in one of its four states: `absent` with no text; `newer`
 * for a JSON object whose `v` is an integer above SAVE_V; `valid` for a v 1
 * record whose every field is present and well typed with `net ≤ high`, and
 * whose `played`, when present, is a safe integer, its fields as `record` and
 * its unknown fields, as stored, as `extra`; and `damaged` for anything else.
 */
export function parseSave(text) {
  if (text === null || text === undefined) return ABSENT;
  let o;
  try { o = JSON.parse(text); } catch { return DAMAGED; }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return DAMAGED;
  if (Number.isInteger(o.v) && o.v > SAVE_V) return NEWER;
  const ok = o.v === SAVE_V && typeof o.id === 'string' && SLOT_ID.test(o.id)
    && typeof o.save === 'string' && decodeSave(o.save) !== null && Object.hasOwn(COIN_RATE, o.level)
    && typeof o.start === 'string' && TOMB_ID.test(o.start)
    && Number.isSafeInteger(o.net) && isCount(o.high) && o.net <= o.high && isCount(o.wallet) && isCount(o.continues)
    && Array.isArray(o.recent) && parseRecent(o.recent).length === o.recent.length
    && (o.played === undefined || Number.isSafeInteger(o.played));
  if (!ok) return DAMAGED;
  const { id, save, level, start, net, high, wallet, continues, played } = o;
  return {
    state: 'valid',
    record: { id, save, level, start, net, high, wallet, continues, recent: parseRecent(o.recent), ...(played === undefined ? {} : { played }) },
    extra: Object.fromEntries(Object.entries(o).filter(([k]) => !SAVE_FIELDS.includes(k))),
  };
}

/** The record as text: its fields in SAVE_FIELDS order, `played` only when set, then the unknown fields `extra`. */
export function serializeSave(record, extra = {}) {
  const { id, save, level, start, net, high, wallet, continues, recent, played } = record;
  return JSON.stringify({ v: SAVE_V, id, save, level, start, net, high, wallet, continues, recent, played, ...extra });
}

/**
 * The time since a record's last play, `played`, at `now`, both in ms, in
 * whole units rounded down: JUST NOW under a minute and ahead of the clock,
 * then n MIN AGO, n HR AGO, 1 DAY AGO and n DAYS AGO under 100 days, then LONG
 * AGO; '' without `played`.
 */
export function playedLabel(played, now) {
  if (played === undefined) return '';
  const s = Math.floor((now - played) / 1000);
  if (s < 60) return 'JUST NOW';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} MIN AGO`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} HR AGO`;
  const d = Math.floor(h / 24);
  if (d < 100) return d === 1 ? '1 DAY AGO' : `${d} DAYS AGO`;
  return 'LONG AGO';
}

/**
 * The slot number, from 1, of the valid record among `helds` (parseSave
 * results by slot) played most recently with `latest`, else least recently;
 * null with none valid. A record without `played` ranks oldest, and a tie goes
 * to the lower slot.
 */
export function playedSlot(helds, latest) {
  let best = null, at = 0;
  helds.forEach((held, i) => {
    if (held.state !== 'valid') return;
    const t = held.record.played ?? -Infinity;
    if (best === null || (latest ? t > at : t < at)) {
      best = i + 1;
      at = t;
    }
  });
  return best;
}

/**
 * The coins a save's high earns rising from `paid` to `high` at `level`: the
 * level's rate per step, plus 100 × k for each k with paid < 100k ≤ high.
 */
export function risePay(level, paid, high) {
  return COIN_RATE[level] * Math.max(0, high - paid) + milestonePayout(paid, high);
}

/**
 * The bound write of run state `run`, { id, save, level, start, net, high,
 * wallet, continues, recent }, to save key `key` through `io` { load, store,
 * remove }. Only a valid record under `run.id` takes it: the same save, which
 * two tabs share. Wallet, high and continues merge by maximum, the run fields
 * are the writer's and the unknown fields the stored record's. The pay,
 * `coins` and the rise of `run.high` over the larger of `paid` and the stored
 * high, joins the merged wallet, so a rise pays once across tabs; `played`,
 * like every run field, is the writer's. Any other key stores nothing and
 * returns `ok` false, which unbinds the run. Returns { ok, held, record,
 * earned, seen }, `seen` being the high the pay rose from.
 */
export function commitSave(io, key, run, { coins = 0, paid = run.high } = {}) {
  const held = parseSave(io.load(key));
  if (held.state !== 'valid' || held.record.id !== run.id) return { ok: false, held };
  const was = held.record, seen = Math.max(paid, was.high);
  const earned = coins + risePay(run.level, seen, run.high);
  const record = {
    ...run, high: Math.max(run.high, was.high), wallet: Math.max(run.wallet, was.wallet) + earned,
    continues: Math.max(run.continues, was.continues),
  };
  io.store(key, serializeSave(record, held.extra));
  return { ok: true, held, record, earned, seen };
}

/**
 * The binding write: takes save key `key` for `run` under its fresh id. A new
 * save inherits no unknown field from the one it replaces. With `over` null it
 * takes an absent or damaged key; with an id, the valid record under that id,
 * which an OVERWRITE confirm drew. Any other key stores nothing and returns
 * `ok` false, and so does a store that does not land, which takes nothing.
 * The pay, `coins` and the rise of `run.high` over `paid`, joins the run's
 * wallet. Returns { ok, held, record, earned, seen }.
 */
export function takeSave(io, key, run, { coins = 0, paid = run.high, over = null } = {}) {
  const held = parseSave(io.load(key));
  const free = over === null ? held.state === 'absent' || held.state === 'damaged' : held.state === 'valid' && held.record.id === over;
  if (!free) return { ok: false, held };
  const earned = coins + risePay(run.level, paid, run.high);
  const record = { ...run, wallet: run.wallet + earned };
  if (!io.store(key, serializeSave(record))) return { ok: false, held };
  return { ok: true, held, record, earned, seen: paid };
}

/**
 * The migration, run while MIGRATED_KEY and the three save keys are absent.
 * Slot 1 takes the old slot when it parses, else the save the seven legacy
 * keys describe: `net` the length of its solved list and `high` the larger of
 * that and its record, so no paid milestone pays again. The marker follows
 * once that write lands; with no source it lands alone. The old slot stays as
 * stored, for older builds, and the legacy keys go with the marker. Returns
 * true when the marker landed.
 */
export function migrateSaves(io) {
  if (io.load(MIGRATED_KEY) !== null || SAVE_SLOTS.some((n) => io.load(saveKey(n)) !== null)) return false;
  const old = parseSlot(io.load(OLD_SLOT_KEY)) || legacySlot(io.load);
  if (old) {
    const { id, save, level, start, wallet, continues, recent } = old, net = old.solved.length;
    const record = { id, save, level, start, net, high: Math.max(net, old.record), wallet, continues, recent };
    if (!io.store(saveKey(1), serializeSave(record))) return false;
  }
  if (!io.store(MIGRATED_KEY, '1')) return false;
  for (const k of Object.values(LEGACY_KEYS)) io.remove(k);
  return true;
}
