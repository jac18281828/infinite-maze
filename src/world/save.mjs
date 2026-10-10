// Save strings: `CODE4-CODE4:p`, p the docs/ROUTE.md section 8 pairing of the
// board's (x, y), with |x| and |y| below 2^25.
import { parseCode, formatCode } from './hash.mjs';
import { boardOfPos, posOf, SAVE_LIMIT } from './world.mjs';

export function encodeSave(code, x, y) {
  return formatCode(code) + ':' + posOf(x, y);
}

/** `{ code, p, x, y }` from a save string, or null when malformed or out of range. */
export function decodeSave(text) {
  const m = /^\s*([^:]+):\s*(\d+)\s*$/.exec(String(text));
  if (!m) return null;
  const code = parseCode(m[1]);
  const p = Number(m[2]);
  if (!code || !Number.isSafeInteger(p)) return null;
  const { x, y } = boardOfPos(p);
  if (Math.abs(x) >= SAVE_LIMIT || Math.abs(y) >= SAVE_LIMIT) return null;
  return { code, p, x, y };
}
