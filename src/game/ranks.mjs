// Adventure ranks for the milestone splash: one name per 100 tombs. DOM-free.

// Tombs between milestones.
export const MILESTONE = 100;

// Ranks for milestones 1 to 10. Every name uses only characters art.mjs's FONT draws.
export const RANKS = [
  'TORCHBEARER', 'RELIC HUNTER', 'TOMB DELVER', 'SCARAB SEEKER', 'PATHFINDER',
  'ROYAL SCRIBE', 'HIGH PRIEST', 'GRAND VIZIER', 'HEIR OF THE NILE', 'PHARAOH',
];

const NUMERALS = [
  [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'],
  [5, 'V'], [4, 'IV'], [1, 'I'],
];

// One M per thousand, so a numeral past 3999 stays well formed.
function roman(n) {
  let out = 'M'.repeat(Math.floor(n / 1000));
  let rest = n % 1000;
  for (const [value, glyphs] of NUMERALS) {
    while (rest >= value) { out += glyphs; rest -= value; }
  }
  return out;
}

/** The rank of milestone k >= 1: PHARAOH II at k = 11, PHARAOH III at 12, and so on. */
export function rankName(k) {
  return k <= RANKS.length ? RANKS[k - 1] : `PHARAOH ${roman(k - RANKS.length + 1)}`;
}
