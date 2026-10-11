// Save strings: `CODE4-CODE4:p` with p = W*y + x for the tomb width W of the
// world the save belongs to, p possibly negative. The string omits the
// difficulty; its reader supplies the size.
import { parseCode, formatCode } from './hash.mjs';
import { boardOfPos, posOf } from './world.mjs';
import { DIFFICULTY } from './band.mjs';

export function encodeSave(code, x, y, size = DIFFICULTY.hard) {
  return formatCode(code) + ':' + posOf(x, y, size);
}

/** `{ code, p, x, y }` from a save string read at tomb `size`, or null when malformed. */
export function decodeSave(text, size = DIFFICULTY.hard) {
  const m = /^\s*([^:]+):\s*(-?\d+)\s*$/.exec(String(text));
  if (!m) return null;
  const code = parseCode(m[1]);
  const p = Number(m[2]);
  if (!code || !Number.isSafeInteger(p)) return null;
  return { code, p, ...boardOfPos(p, size) };
}
