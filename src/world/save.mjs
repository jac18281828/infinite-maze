// Save strings: `CODE4-CODE4:p` with p = 6y + x, p possibly negative.
import { parseCode, formatCode } from './hash.mjs';
import { boardOfPos, posOf } from './world.mjs';

export function encodeSave(code, x, y) {
  return formatCode(code) + ':' + posOf(x, y);
}

/** `{ code, p, x, y }` from a save string, or null when malformed. */
export function decodeSave(text) {
  const m = /^\s*([^:]+):\s*(-?\d+)\s*$/.exec(String(text));
  if (!m) return null;
  const code = parseCode(m[1]);
  const p = Number(m[2]);
  if (!code || !Number.isSafeInteger(p)) return null;
  return { code, p, ...boardOfPos(p) };
}
