// Palette-indexed art. Each character indexes PALETTE in base 32
// ('0'-'9', 'a'-'v'); '.' is transparent.

export const PALETTE = [
  '#0d0a14', '#1b1426', '#2c1f3d', '#46304f', // 0-3 violet shadow
  '#5e3f52', '#3b2a22', '#5a3e2b', '#7d5636', // 4 mauve, 5-7 umber
  '#a8743f', '#c9984f', '#ddb873', '#efd49c', // 8 ochre, 9-b sandstone
  '#fff1cf', '#13284a', '#1f3f78', '#3264b0', // c bone, d-f lapis
  '#0f4f4c', '#1f8a80', '#3fd0c0', '#a6fff0', // g-j turquoise
  '#6b4a0f', '#b8860b', '#f2c14e', '#8a2a12', // k-m gold, n torch red
  '#d2561a', '#ff9a2e', '#ffd27a', '#6e5a3a', // o-q torch orange, r khaki dark
  '#a08a5c', '#c8b483', '#e0a882', '#8e5a44', // s-t khaki, u skin, v leather
];

export const RGB = PALETTE.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

/** Palette index of a character, or -1 for transparent. */
export function idx(ch) {
  return ch === '.' ? -1 : parseInt(ch, 32);
}

// Explorer, 16x24, facing right. Frames compose a head (rows 0-9), a torso
// (rows 10-15) and legs (rows 16-23); `bob` lowers head and torso.
const HEAD = {
  side: [
    '................',
    '......6666......',
    '.....677776.....',
    '.....677776.....',
    '.....655556.....',
    '...66677777666..',
    '......uuuuu.....',
    '......uuu0u.....',
    '......uuuuuu....',
    '.......vuuv.....',
  ],
  gasp: [
    '................',
    '................',
    '......6666......',
    '.....677776.....',
    '.....655556.....',
    '...66677777666..',
    '......uuuuu.....',
    '......uuu0u.....',
    '......uuuu0u....',
    '.......vuuv.....',
  ],
  back: [
    '................',
    '......6666......',
    '.....677776.....',
    '.....677776.....',
    '.....655556.....',
    '...6667777766...',
    '......vvvvv.....',
    '......vuuuv.....',
    '.......uuu......',
    '.......vuv......',
  ],
};

const TORSO = {
  hold: [
    '.....ssssss.v...',
    '....sstssstsv...',
    '....sstssssvu...',
    '....ssttsss.....',
    '....ssssss......',
    '....v555v5......',
  ],
  swing: [
    '.....ssssss.v...',
    '...ssstssstsv...',
    '...usstssssvu...',
    '....ssttsss.....',
    '....ssssss......',
    '....v555v5......',
  ],
  chest: [
    '.....ssssss.....',
    '....sstsssts....',
    '....sstsuuvs....',
    '....ssttsss.....',
    '....ssssss......',
    '....v555v5......',
  ],
  climbA: [
    '...u.ssssss.....',
    '...sssstssss....',
    '....ssttssssu...',
    '....ssttsss.....',
    '....ssssss......',
    '....v555v5......',
  ],
  climbB: [
    '.....ssssss.u...',
    '....ssssstsss...',
    '...ussssttss....',
    '....sssttss.....',
    '....ssssss......',
    '....v555v5......',
  ],
};

// Near leg in khaki 's', far leg in khaki dark 'r'.
const LEGS = {
  stand: [
    '.....rrssss.....',
    '.....rr..ss.....',
    '.....rr..ss.....',
    '.....rr..ss.....',
    '.....rr..ss.....',
    '.....rr..ss.....',
    '....655..655....',
    '....5555.5555...',
  ],
  run0: [
    '.....rrssss.....',
    '....rrr..sss....',
    '....rr....sss...',
    '...rr......ss...',
    '...rr.......ss..',
    '..rr........ss..',
    '.655........655.',
    '.55..........555',
  ],
  run1: [
    '.....rrssss.....',
    '.....rr.sss.....',
    '....rr...ss.....',
    '....rr...sss....',
    '...rr.....ss....',
    '...rr.....ss....',
    '..655.....655...',
    '..55......5555..',
  ],
  run2: [
    '.....rrssss.....',
    '.....rrsss......',
    '.....rrss.......',
    '.....rss.ss.....',
    '.....rr..sss....',
    '.....rr...655...',
    '....655...55....',
    '....5555........',
  ],
  run3: [
    '.....ssrrrr.....',
    '....sss..rr.....',
    '...ss.....rr....',
    '...ss.....rr....',
    '..655......rr...',
    '..55.......655..',
    '...........55...',
    '................',
  ],
  run4: [
    '.....ssrrrr.....',
    '....sss..rrr....',
    '....ss....rrr...',
    '...ss......rr...',
    '...ss.......rr..',
    '..ss........rr..',
    '.655........655.',
    '.55..........555',
  ],
  run5: [
    '.....ssrrrr.....',
    '.....ss.rrr.....',
    '....ss...rr.....',
    '....ss...rrr....',
    '...ss.....rr....',
    '...ss.....rr....',
    '..655.....655...',
    '..55......5555..',
  ],
  run6: [
    '.....ssrrrr.....',
    '.....ssrrr......',
    '.....ssrr.......',
    '.....srr.rr.....',
    '.....ss..rrr....',
    '.....ss...655...',
    '....655...55....',
    '....5555........',
  ],
  run7: [
    '.....rrssss.....',
    '....rrr..ss.....',
    '...rr.....ss....',
    '...rr.....ss....',
    '..655......ss...',
    '..55.......655..',
    '...........55...',
    '................',
  ],
  step0: [
    '.....rrssss.....',
    '.....rr..sss....',
    '.....rr...ss....',
    '....rr....ss....',
    '....rr.....ss...',
    '....rr.....ss...',
    '...655.....655..',
    '...55......5555.',
  ],
  step1: [
    '.....rrssss.....',
    '.....rr.ss......',
    '.....rr.sss.....',
    '.....rr..ss.....',
    '.....rr..ss.....',
    '.....rr..655....',
    '....655..55.....',
    '....5555........',
  ],
  step2: [
    '.....ssrrrr.....',
    '.....ss..rrr....',
    '.....ss...rr....',
    '....ss....rr....',
    '....ss.....rr...',
    '....ss.....rr...',
    '...655.....655..',
    '...55......5555.',
  ],
  step3: [
    '.....ssrrrr.....',
    '.....ss.rr......',
    '.....ss.rrr.....',
    '.....ss..rr.....',
    '.....ss..rr.....',
    '.....ss..655....',
    '....655..55.....',
    '....5555........',
  ],
  climbA: [
    '.....rrrrrr.....',
    '.....rr..rr.....',
    '.....rr..rr.....',
    '....rr...rr.....',
    '....655..rr.....',
    '....55...rr.....',
    '.........655....',
    '.........55.....',
  ],
  climbB: [
    '.....rrrrrr.....',
    '.....rr..rr.....',
    '.....rr..rr.....',
    '.....rr...rr....',
    '.....rr..655....',
    '.....rr...55....',
    '....655.........',
    '.....55.........',
  ],
};

// Jump: the explorer tucks into rows 8-23, 16 px tall, knees drawn up while
// rising and legs reaching down while falling. The torch hand sits at
// column 12, rows 14-16.
const TUCK = {
  rise: [
    '......6666......',
    '.....677776.....',
    '.....655556.....',
    '...66677777666..',
    '......uuu0u.....',
    '......uuuuuu....',
    '.....sssvuv.v...',
    '...ssstssstsv...',
    '...usstssssvu...',
    '....sstsssss....',
    '....v555v5sss...',
    '....rrr.ssss....',
    '...rrrr.sss.....',
    '...rr655.655....',
    '...655...55.....',
    '...55...........',
  ],
  fall: [
    '......6666......',
    '.....677776.....',
    '.....655556.....',
    '...66677777666..',
    '......uuu0u.....',
    '......uuuuuu....',
    '.....ssvuuv.v...',
    '....sstssstsv...',
    '....sstssssvu...',
    '....ssttsss.....',
    '....v555v5......',
    '....rr...ss.....',
    '...rr.....ss....',
    '...rr.....ss....',
    '..655.....655...',
    '..55.......55...',
  ],
};

function tucked(rows) {
  return [...Array(8).fill('.'.repeat(16)), ...rows];
}

function compose(head, torso, legs, bob = 0) {
  const top = [...HEAD[head], ...TORSO[torso]];
  const shifted = bob ? [...Array(bob).fill('.'.repeat(16)), ...top.slice(0, top.length - bob)] : top;
  return [...shifted, ...LEGS[legs]];
}


export const EXPLORER = {
  idle: [
    compose('side', 'hold', 'stand'), compose('side', 'hold', 'stand'),
    compose('side', 'hold', 'stand', 1), compose('side', 'hold', 'stand', 1),
  ],
  run: [
    compose('side', 'swing', 'run0', 1), compose('side', 'hold', 'run1'),
    compose('side', 'hold', 'run2'), compose('side', 'swing', 'run3'),
    compose('side', 'swing', 'run4', 1), compose('side', 'hold', 'run5'),
    compose('side', 'hold', 'run6'), compose('side', 'swing', 'run7'),
  ],
  climb: [
    compose('back', 'climbA', 'climbA'), compose('back', 'climbA', 'climbB', 1),
    compose('back', 'climbB', 'climbB'), compose('back', 'climbB', 'climbA', 1),
  ],
  gallery: [
    compose('side', 'hold', 'step0'), compose('side', 'hold', 'step1', 1),
    compose('side', 'hold', 'step1'), compose('side', 'hold', 'step0', 1),
    compose('side', 'hold', 'step2'), compose('side', 'hold', 'step3', 1),
    compose('side', 'hold', 'step3'), compose('side', 'hold', 'step2', 1),
  ],
  gasp: [compose('gasp', 'chest', 'stand', 1), compose('gasp', 'chest', 'stand', 2)],
  jump: [tucked(TUCK.rise), tucked(TUCK.fall)],
};

/** Torch tip (x, y) within a frame, where the flame is drawn. */
export function torchTip(anim, frame) {
  let y = 9;
  if (anim === 'climb') y = frame < 2 ? 11 : 9;
  else if (anim === 'gasp') y = 12;
  else if (anim === 'jump') y = 13;
  return [12, y + EXPLORER_BOB[anim][frame]];
}

const EXPLORER_BOB = {
  idle: [0, 0, 1, 1], run: [1, 0, 0, 0, 1, 0, 0, 0], climb: [0, 1, 0, 1],
  gallery: [0, 1, 0, 1, 0, 1, 0, 1], gasp: [1, 2], jump: [0, 0],
};

// Sandstone blocks in three variants.
export const ROCK = [
  [
    '9999999899999998',
    '9aaaaaa89aaaaaa8',
    '9aaabaa89aabaaa8',
    '9aaaaaa89aaaaa98',
    '9aaaaa989aaaaaa8',
    '9aaaaaa89aaaaaa8',
    '9a9aaaa89aaaa9a8',
    '8888888888888888',
    '9999899999998999',
    'aaa89aaaaaaa89aa',
    'aba89aaabaaa89aa',
    'aaa89aaaaaaa89ab',
    'aaa89aa9aaaa89aa',
    'aaa89aaaaaa989aa',
    'a9a89aaaaaaa89aa',
    '8888888888888888',
  ],
  [
    '9999999999998999',
    '9aaaaaaaaaa89aaa',
    '9aabaaaaaaa89aba',
    '9aaaaaa9aaa89aaa',
    '9aaaaaaaaaa89aaa',
    '9a9aaaaaaba89aaa',
    '9aaaaaaaaaa89aa9',
    '8888888888888888',
    '9998999999999998',
    'aa89aaaaaaaaaaa8',
    'aa89aaabaaaaa9a8',
    'ab89aaaaaaaaaaa8',
    'aa89a9aaaaaaaaa8',
    'aa89aaaaaa9aaaa8',
    'a989aaaaaaaaaaa8',
    '8888888888888888',
  ],
  [
    '9999998999999998',
    '9aaaa989aaaaaaa8',
    '9aaaaa89aa7aaaa8',
    '9abaaa89a777aaa8',
    '9aaaaa89aa7aaaa8',
    '9aaaaa89aaaaaba8',
    '9aa9aa89aaaaaaa8',
    '8888888888888888',
    '9999999999899999',
    'aaaaaaa9a89aaaaa',
    'aabaaaaaa89aaaba',
    'aaaaaaaaa89aaaaa',
    'aaaa9aaaa89a9aaa',
    'aaaaaaaaa89aaaaa',
    'a9aaaaaaa89aaaaa',
    '8888888888888888',
  ],
];

// Back wall, seen through every passage at half the camera speed:
// lapis-washed plaster with painted glyph registers.
export const WALL = [
  [
    'dddddddddddddddd',
    'deeeeeeeeeeeeeed',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'de.............e',
    'deeeeeeeeeeeeeed',
    'dddddddddddddddd',
  ],
];

// 16x16 glyph panels painted over the wall tone ('.' keeps the wall).
export const GLYPHS = [
  [ // eye of Horus
    '................',
    '................',
    '....lllllll.....',
    '...l.......l....',
    '..l..mmmm...l...',
    '.l..mm00mm...l..',
    '..l..mmmm...l...',
    '...lllllllll....',
    '......l..l......',
    '.....l....l.....',
    '....l......ll...',
    '...l.........l..',
    '................',
    '................',
    '................',
    '................',
  ],
  [ // ankh
    '................',
    '......llll......',
    '.....l....l.....',
    '.....l....l.....',
    '.....l....l.....',
    '......l..l......',
    '...llllllllll...',
    '...llllllllll...',
    '.......ll.......',
    '.......ll.......',
    '.......ll.......',
    '.......ll.......',
    '.......ll.......',
    '.......ll.......',
    '................',
    '................',
  ],
  [ // reed and water
    '................',
    '.......h........',
    '......hhh.......',
    '......hhh.......',
    '.......h........',
    '.......h........',
    '.......h........',
    '.......h........',
    '................',
    '..i..i..i..i..i.',
    '.i.ii.ii.ii.ii.i',
    '................',
    '..i..i..i..i..i.',
    '.i.ii.ii.ii.ii.i',
    '................',
    '................',
  ],
  [ // bird
    '................',
    '................',
    '.......mm.......',
    '......m0mm......',
    '.....mmmmm88....',
    '......mmmm......',
    '.....mmmmmm.....',
    '....mmmmmmmm....',
    '...mmmmmmmmm....',
    '.....mmmmmmm....',
    '.......m..m.....',
    '......mm.mm.....',
    '................',
    '................',
    '................',
    '................',
  ],
  [ // sun disc
    '................',
    '................',
    '.....kkkkkk.....',
    '....kllllllk....',
    '...kllmmmmllk...',
    '...klmmmmmmlk...',
    '...klmmmmmmlk...',
    '...kllmmmmllk...',
    '....kllllllk....',
    '.....kkkkkk.....',
    '..ffff....ffff..',
    '.ff..ffffff..ff.',
    '................',
    '................',
    '................',
    '................',
  ],
  [ // scarab
    '................',
    '................',
    '......hhhh......',
    '.....hiiiih.....',
    '..h..hiiiih..h..',
    '...h.hhhhhh.h...',
    '....hgggggghh...',
    '...hhgiggigh....',
    '....hgigggih....',
    '...h.hggggh.h...',
    '..h...hhhh...h..',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
];

// Ladder segment, 16 wide, repeating every 8 rows.
export const LADDER = [
  '...76......76...',
  '...76......76...',
  '...78888888876..',
  '...76666666676..',
  '...76......76...',
  '...76......76...',
  '...76......76...',
  '...76......76...',
];

// Wall sconce: bracket and bowl; the flame is drawn above it.
export const SCONCE = [
  '..kllk..',
  '.kmmmmk.',
  '..kllk..',
  '...kk...',
  '...kk...',
  '..kllk..',
];

export const SCONCE_FLAME = [
  ['...q....', '..qpq...', '..pop...', '..ono...'],
  ['....q...', '...pq...', '..pqp...', '..ono...'],
  ['..q.....', '..qp....', '..pqp...', '..ono...'],
];

// Signs carved at a junction, 7x7, one per direction in DX, DY order: E N W S
// NE NW SW SE. Each arrow points along the link it names.
export const SIGNS = [
  [
    '...9...',
    '....9..',
    '.....9.',
    '9999999',
    '.....9.',
    '....9..',
    '...9...',
  ],
  [
    '...9...',
    '..9.9..',
    '.9.9.9.',
    '...9...',
    '...9...',
    '...9...',
    '...9...',
  ],
  [
    '...9...',
    '..9....',
    '.9.....',
    '9999999',
    '.9.....',
    '..9....',
    '...9...',
  ],
  [
    '...9...',
    '...9...',
    '...9...',
    '...9...',
    '.9.9.9.',
    '..9.9..',
    '...9...',
  ],
  [
    '...9999',
    '.....99',
    '....9.9',
    '...9..9',
    '..9....',
    '.9.....',
    '9......',
  ],
  [
    '9999...',
    '99.....',
    '9.9....',
    '9..9...',
    '....9..',
    '.....9.',
    '......9',
  ],
  [
    '......9',
    '.....9.',
    '....9..',
    '9..9...',
    '9.9....',
    '99.....',
    '9999...',
  ],
  [
    '9......',
    '.9.....',
    '..9....',
    '...9..9',
    '....9.9',
    '.....99',
    '...9999',
  ],
];

// Brazier for a turquoise flame; 16x10 bowl on a gold stand.
export const BRAZIER = [
  '.kllllllllllllk.',
  'kmmmmmmmmmmmmmmk',
  '.kllmlllllmllk..',
  '..kllllllllllk..',
  '....kkllllkk....',
  '......kllk......',
  '......kllk......',
  '.....kllllk.....',
  '....kkllllkk....',
  '...kkkkkkkkkk...',
];

// Floor coin and wallet icon, 6x6 in gold.
export const COIN = [
  '..kk..',
  '.kmmk.',
  'kmmlmk',
  'kmllmk',
  '.klmk.',
  '..kk..',
];

export const FLAME = [
  [
    '......j.....',
    '.....jj.....',
    '.....jij....',
    '....jiij....',
    '...jiiiij...',
    '...jiiiij...',
    '..jiihhiij..',
    '..jihhhhij..',
    '..ihhgghhi..',
    '..ihggggh...',
    '...hgggh....',
    '....ggg.....',
  ],
  [
    '.....j......',
    '.....jj.....',
    '....jijj....',
    '....jiij....',
    '...jiiiij...',
    '..jiiiiiij..',
    '..jiihhiij..',
    '..jihhhhij..',
    '..ihhgghhi..',
    '...hggggh...',
    '...hgggh....',
    '....ggg.....',
  ],
  [
    '.......j....',
    '......jj....',
    '.....jij....',
    '....jiij....',
    '...jiiiij...',
    '...jiiiiij..',
    '..jiihhiij..',
    '..jihhhhij..',
    '..ihhgghhi..',
    '...hggggh...',
    '....hggh....',
    '....ggg.....',
  ],
  [
    '............',
    '.....j......',
    '....jj......',
    '....jij.....',
    '...jiiij....',
    '...jiiiij...',
    '..jiihhiij..',
    '..jihhhhij..',
    '..ihhgghhi..',
    '...hggggh...',
    '...hgggh....',
    '....ggg.....',
  ],
];

// Hand torch flame, three flicker frames, anchored at the bottom centre.
export const TORCH = [
  ['..q..', '.qpq.', '.pop.', '..n..'],
  ['...q.', '.qpq.', '.pqp.', '..n..'],
  ['.q...', '.qp..', '.pop.', '..n..'],
];

// 5x7 pixel font. '#' marks ink.
const FONT_ROWS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '..#..'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

export const FONT = FONT_ROWS;
export const FONT_W = 5;
export const FONT_H = 7;

/** Every art string set, for width checks. */
export function artSets() {
  return {
    explorer: Object.values(EXPLORER).flat(),
    rock: ROCK, wall: WALL, glyphs: GLYPHS, ladder: [LADDER], sconce: [SCONCE],
    sconceFlame: SCONCE_FLAME, sign: SIGNS, brazier: [BRAZIER], coin: [COIN], flame: FLAME, torch: TORCH,
    font: Object.values(FONT_ROWS),
  };
}
