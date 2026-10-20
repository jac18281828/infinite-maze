# Infinite Maze — specification

Infinite Maze is one endless tomb maze, generated on demand from a seed. It
has no levels and no end. An explorer climbs it by torchlight, and the torch
is the clock. The maze has no loops at any scale and stays solvable forever.
Any position in it is one integer, so a run can stop and resume anywhere, and
the player can go up or down from there.

The game ships as one standalone HTML file with inline JavaScript. It has no
dependencies, no asset files and no network access.

## 1. World structure

The world has two scales, and both use the same maze rule:

- **Board:** a 12×7 grid of cells. This is one room of the tomb, a little
  larger than two screens in each direction.
- **Tomb:** a W×H grid of boards, also called a band; §3 builds its board
  tree. Tombs tile an unbounded plane.

The difficulty, picked on the title (§8), sets the tomb's size in boards:
EASY 2×2 (4 boards), MEDIUM 3×3 (9), HARD 4×4 (16) and ULTIMATE 6×4 (24).
ULTIMATE is the original 6×4 world. The level also sets the room parameters
of §3 and §4: the dead-end depth, the carve count and the path, junction and
side-branch targets. A world never mixes sizes. A tomb depends on the seed,
its position and the difficulty alone; the difficulty enters no hash.

Board coordinates are integers `(x, y)`, both unbounded, where y increases
upward. Tombs are keyed `(u, v)`, both in ℤ: tomb `(u, v)` holds boards
`x ∈ [Wu, Wu + W)`, `y ∈ [Hv, Hv + H)`. Tomb `(0, 0)` holds the start. Every
tomb is a pure function of the seed and its position, so the world is static
and any tomb can be entered at any time.

**Flow.** Each tomb leaves through one exit door: up, left or right, never
down. The wall between tombs `(u, v)` and `(u + 1, v)` points right or left.
With `r = u32(H("exit", u, v)) mod 3`, the tomb can leave right when wall
`(u, v)` points right and left when wall `(u − 1, v)` points left. It exits
up when `r = 0` or neither side is open; otherwise it exits left on `r = 1`
and right on `r = 2` when both sides are open, or through the one open side.

A tomb holds an in-door on its floor when the tomb below exits up, on its
left wall when the left tomb exits right, and on its right wall when the
right tomb exits left. The exit wall and the in-walls are distinct by
construction, so a tomb has one exit and 0–3 in-doors, and a tomb wall holds
at most one door.

The flow cannot loop, because no exit goes down. A cycle of three or more
tombs would need a directed cycle within one row, which a line cannot hold. A
two-tomb cycle would need two doors on one wall, which holds at most one. The
wall's one direction forbids a facing pair: two side neighbours that exit into
each other would close a two-tomb basin with no way up. So a tomb's exit
walk, the tombs its exits lead through, climbs without end.

Two tombs are joined exactly when their exit walks meet. The column gap
between two walks moves like a recurrent random walk on a line, so they meet
with probability 1, and the tombs, joined by their doors, form one tree with
probability 1. They can meet far up: on seed `0000-0000`, the walks from
tombs `(0, 0)` and `(10, −50)` are 15 columns apart at row 0 and first meet
at row 773,851. The Way up check of §10 tests the part a finite run can:
every exit walk from a window tomb climbs out of the window.

Within a tomb, the boards form a tree that joins all of its doors: a trunk
from an entry to the exit, tributaries from the other entries, dead-end
branches, and rock on board positions in none of them. Every board's cells
form a tree that connects all of that board's doors. Trees of cells, joined
by single doors into tomb trees along a flow without loops, give these
properties, at every depth:

- No loops, so a path between two cells is unique.
- An unbroken route upward from every cell.
- With probability 1, a path between any two cells, through the tomb where
  their exit walks meet.

## 2. Seed and hashing

The seed code is 8 Crockford base32 characters, 40 bits in all. Rolling a new
world draws them from `crypto.getRandomValues`. The player can also type a
code. The world key is:

```
WORLD = SHA3-256("infinite-maze/v1" ‖ code)
H(tag, n₁, n₂, …) = SHA3-256(WORLD ‖ tag ‖ int64be(n₁) ‖ int64be(n₂) ‖ …)
```

Tags are ASCII strings. The integers use fixed width, so `(1, 23)` and
`(12, 3)` never share an input. Every random value in the game comes from `H`
of a tag and coordinates, never from a previous hash, so the generator holds
no chain that could cycle. A repeat needs a SHA3-256 collision.

SHA3-256 is embedded as a compact Keccak-f[1600], verified against the FIPS
202 test vectors. Bulk randomness comes from sfc32, seeded from the first 16
bytes of a digest. Generation uses integer arithmetic only, so a seed produces
the same world on every engine.

| Value | Source | Range |
|---|---|---|
| Wall between tombs `(u,v)` and `(u+1,v)` | `H("flow", u, v)` byte 0 < 128 | right, else left |
| Tomb exit draw `r` | `H("exit", u, v)` u32 mod 3 | `[0, 3)` |
| Door between tombs `(u,v)` and `(u,v+1)` | `H("tfloor", u, v)` u32 mod W | board column `[0, W)` |
| Door between tombs `(u,v)` and `(u+1,v)` | `H("tside", u, v)` u32 mod H | board row `[0, H)` |
| Entry board `S` of a source tomb | `H("source", u, v)` u32 mod W·H | board index `[0, W·H)` |
| Band maze | sfc32 of `H("band", u, v, k)`, k = reroll | — |
| Side door between `(x,y)` and `(x+1,y)` | `H("hdoor", x, y)` u32 mod 5 + 1 | cell row `[1, 5]` |
| Floor door between `(x,y)` and `(x,y+1)` | `H("vdoor", x, y)` u32 mod 10 + 1 | cell column `[1, 10]` |
| Board cell maze | sfc32 of `H("board", x, y, k)`, k = reroll | — |
| Dead-end flame candidate | `H("flame", x, y)` byte 0 < 128 makes a dead-end board a candidate, which §3 may drop | 50% |
| Route board-0 flame candidate | `H("flame", x, y)` byte 0 < 85 makes a route's first board a candidate, which §3 may drop | 33% |
| Flame cell | `H("flame", x, y)` u32 at bytes 4–7 mod 84 | any of the 84 cells |
| Pointer at a sign junction (§4) | `H("sign", x, y, cell)` u32 mod 1024 | tier-1 skeleton when under `t`, tier-2 skeleton when in `[t, 2t)`, arrow when in `[2t, 2t + a)`, with `t` 104 (EASY), 30 (MEDIUM), 17 (HARD) or 11 (ULTIMATE) and `a` 85, 64, 43 or 32; a candidate within two cells of a pointer already standing gives way, tier 1 first, then arrows, then tier 2, each by cell |
| Corner of an arrow | `H("sign", x, y, cell)` u32 bit 31 | upper left, upper right |
| Corner of a skeleton | `H("sign", x, y, cell)` u32 bit 31 | lower left, lower right: the corner of an up or down way; a way to the right prefers the left corner and a way to the left the right, and a gallery's side gives way (§8) |
| Floor coin | `H("coin", x, y, cell)` u32 mod 100 < 5 | on a dead-end cell (§4) |
| Coin row | `H("row", x, y, cell)` u32 mod 100 < 4 | the corridor east of `cell` (§4) |
| Oil jar | `H("oil", x, y, cell)` u32 | on the board's free cells (§4) of lowest value, the lower cell winning a tie: 2 at EASY, 1 at MEDIUM, HARD and ULTIMATE |
| Wind | `H("wind", x, y, cell)` u32 mod 64 at a branch's first cell | windy when under `min(n, 18)` for a branch of `n` cells (§4) |

Both boards on a shared wall read the same door key, and both tombs on a
shared tomb wall read the same crossing key, so door positions match across
every seam by construction. Doors stay out of corner cells, so two doors of
one board never share a cell.

## 3. Band maze

A tomb is W×H boards: 2×2 at EASY, 3×3 at MEDIUM, 4×4 at HARD and 6×4 at
ULTIMATE (§1).
Tomb `(u, v)` spans board columns `Wu … Wu+W−1` and rows `Hv … Hv+H−1`, and
its board index is `i = W · row + column` within the tomb. A door on the tomb
wall between `(u, v)` and `(u, v + 1)` crosses at board column
`u32(H("tfloor", u, v)) mod W`; on the wall between `(u, v)` and
`(u + 1, v)`, at board row `u32(H("tside", u, v)) mod H`. The exit board `X`
holds the exit door.

1. **Entries.** List the tomb's in-door boards in wall order floor, left,
   right: `E_1 … E_k`. A tomb with no in-door is a source; its single entry
   board is `S = u32(H("source", u, v)) mod W·H`.
2. **Trunk.** Run a randomized depth-first search over the W×H boards,
   seeded from `H("band", u, v, k)`, from `E_1` (or `S`) to `X`. The search
   stack on arrival is the trunk. Reroll `k` until the trunk covers at least
   half the tomb's boards, rounded down: 2 at EASY, 4 at MEDIUM, 8 at HARD
   and 12 at ULTIMATE. When the entry board is `X` itself, the trunk is that
   one board and is exempt from the minimum.
3. **Tributaries.** For `j = 2 … k` in order, an `E_j` already in the tree
   needs nothing. Otherwise a randomized depth-first search on the same
   generator runs from `E_j` over boards outside the tree and ends on its
   first step onto a tree board; its stack, without that board, is the
   tributary. The unused boards around `E_j` always touch the tree, so a
   tributary never fails.
4. **Dead ends.** Repeatedly pick, uniformly, a board in the tree at depth
   below the level's dead-end depth `D` with an unused neighbour, and attach
   that neighbour. Trunk and tributaries sit at depth 0. Stop when no
   candidate remains. Every dead-end branch is therefore at most `D` boards
   deep: `D = 1` at EASY and 2 at MEDIUM, HARD and ULTIMATE.
5. **Rock.** Board positions left unused are solid rock.
6. **Flames.** No board burns for being an entry. Number each route's boards
   from 0 at its entry: the trunk from `E_1` or `S`, a tributary from its
   `E_j`; an `E_j` already in the tree has no route of its own and counts by
   the index of the route it lies on. A route board is a candidate at its
   flame cell when its index is a positive multiple of 3, and a route's board 0
   is a candidate when byte 0 of `H("flame", x, y)` is under 85 (33%, §2); half
   the dead-end boards are dead-end candidates at their deepest cell. The
   generator keeps the route candidates, by route in tomb order and by
   ascending index within it, and then the dead-end candidates by board index,
   each unless it stands within 20 s of walking, at the §6 speeds, of a flame
   its tomb has already kept: the walk follows the cell tree through doors and
   across board seams and tomb walls. A route or dead-end flame therefore
   stands more than 20 s' walk from every other flame its tomb keeps; a
   dropped candidate burns nowhere, and gap flames are exempt. Flames of two
   tombs can stand within 20 s of each other.

   Then, for each entry in order, the generator builds that entry's chain along
   its way on: the boards from the entry along its route to `X`, then across
   the exit door. The chain runs from `P` to `Q`. `P` is the start of the way,
   the flame cell of `S` on a source tomb, burning or not, and the cell of the
   in-door on the entry board otherwise. `Q` is the cell across the tomb's exit
   door, on the downstream tomb's entry board; the downstream chain of the same
   way on starts at it. The chain's first member is a `start` at `P`, then come
   the flames on the way's boards that the routes and earlier chains placed, in
   the order the walk reaches them (a flame on `P`'s cell is its own member,
   after the start), and its last is an `end` at `Q`. A stretch is the walk
   between consecutive members, at the §6 speeds. Its limit is 150 s, less 75 s
   for each end that is an in-door `P` or `Q`: 150 s between flames and from
   `S` to the first flame, 75 s from an in-door to the first flame and from the
   last flame to `Q`, 75 s from `S` straight to `Q` and 0 s from an in-door
   straight to `Q`, so every in-door way on holds a flame. A stretch over its
   limit gains a flame at its midpoint cell, and this repeats until none
   exceeds its limit. A midpoint past the exit door takes the exit door's cell
   instead. The gap flames of one chain count as flames for the next. A tomb
   crossing therefore joins a trail of at most 75 s to a lead of at most 75 s,
   and no stretch between flames takes over 150 s, across tomb walls too. No
   chain places a flame past its exit door, so a board's flames are those of
   its own tomb alone.

Every link in the band tree is a door, and a board holds a door on every tomb
wall it carries. A board has 1–4 doors, at most one per wall. On a trunk or
tributary board, the primary pair of §4 is the door toward its own route's
predecessor (the in-door on `E_j`, the flame cell on `S`, burning or not) and
the door toward its successor (the exit door on `X`, the joined tree board on
a tributary's last board). When the two meet in one cell, on an `S` whose
flame cell is the door toward its successor, the second cell is the deepest
cell from the first, as on a dead-end board. §4 exempts branches that hold a door, so a
confluence board's extra door needs no rule of its own.

## 4. Board maze

Each attempt grows a spanning tree over a board's 12×7 grid with the
growing-tree algorithm, and the chosen tree is then carved down to the
level's carve count `C` cells:

- Pick the newest active cell with probability 0.6, otherwise a random
  active cell.
- Choose neighbours by weight: horizontal 4, vertical 1, diagonal 1.

A horizontal link is a corridor, a vertical link is a ladder and a diagonal
link is a 45° gallery. A gallery from `(x, y)` to `(x±1, y+1)` owns the 2×2
block of those four cells: no other link joins two of its cells, and no cell
lies in two blocks. A cell therefore holds at most one gallery, and at most
one up-link and one down-link.

Before growing its tree, each attempt reserves up to 8 disjoint blocks from
at most 32 random draws. A reserved block loses its four orthogonal links and
offers one diagonal, drawn at random. A block whose four cells the remaining
links no longer join is dropped, so those links connect the grid and each
attempt's tree spans every cell. Boards average 4·C/50 to 10·C/50 galleries
(§10).

The board's primary door pair is its route entry and route exit, or, on a
dead-end board, its single door and its deepest cell. Each attempt must meet
two targets, set per level with the carve count:

- The primary path covers at least `P` cells, with at least `J` junctions on
  it.
- Every branch leaving the primary path runs at least `B` cells.

| Level | `C` | `P` | `J` | `B` |
|---|---|---|---|---|
| EASY | 40 | 16 | 4 | 2 |
| MEDIUM | 45 | 22 | 6 | 2 |
| HARD | 50 | 22 | 6 | 3 |
| ULTIMATE | 50 | 22 | 6 | 3 |

The deficit of a tree is its shortfall in path cells, plus its shortfall in
junctions, plus, for each branch under `B` cells, the cells it lacks. A branch
holding a door is exempt. An attempt meets the targets at deficit 0. The
level's targets govern attempt selection, repair and carve alike.

After growing its tree, an attempt repairs it by edge swaps. A swap adds a
link between two cells that the attempt's reserved blocks leave open and
removes one link on the cycle the new link closes, so the tree keeps spanning
and every gallery keeps its block. The new link starts at a cell of a short
branch, or at any cell when no short branch is left. A swap stays when it
lowers the deficit, tried in cell, direction and cycle order. The repair stops
at deficit 0, when no swap lowers the deficit, or after 24 swaps.

Reroll `k` from 0 until an attempt meets the targets. After 32 rerolls the
board takes the attempt with the lowest deficit, the earliest on a tie. The
cap bounds generation time, and the band and board seeds stay fixed, so the
chosen attempt is deterministic too. Over tombs `u ∈ [−10, 10]`,
`v ∈ [−50, 50]` of seed `0000-0000`, under 1% of boards take that fallback at
every difficulty.

The carve runs once on the chosen attempt, passing or fallback, and leaves
`k` and the fallback flag as they were. It roots the tree at the first
primary cell `a`. A cut at a cell `c ≠ a` removes `c`, every cell beyond it
away from `a`, and their links. A cut qualifies when:

- it removes no protected cell: a door cell, `a`, the second primary cell `b`
  (the deepest cell on a dead-end board) or the flame cell of §2;
- it removes at most (cells − `C`) cells, where cells is the tree's current
  size; and
- the deficit afterwards, measured against `b`, is at most the deficit the
  chosen attempt had.

While the tree holds more than `C` cells, the carve lists the qualifying cuts
that remove no gallery link, or every qualifying cut when none is free of
one, in ascending cell order. It removes the cut at index `rng() % count`,
where `rng` is sfc32 of `H("carve", x, y)`. It stops at `C` cells or when no
cut qualifies. A cut leaves the path between protected cells whole, so every
flame lies on a carved cell and walking times between flames are unchanged.
The cells that remain form a tree, and the rest is rock: the game opens a
room only for a cell that holds a link or a door. Over the §10 window, boards
average 40.7 carved cells and 4.59 galleries at EASY, 45.8 and 4.72 at
MEDIUM, 50.6 and 5.03 at HARD and 50.7 and 5.02 at ULTIMATE.

**Sign junctions.** A sign junction is a cell of a route board (§3) on the tree
path from an in-cell to the out-door's cell `o`, `o` excepted, with three or
more real ways out. A way out is a tree link or a door. A tree link into a
**stub** is no real way out: a stub is a carved cell with exactly one tree link
and no door, and a source board's flame cell is never a stub, because the player
arrives from it and does not see it as a closed room. Only a one-room stub drops
out, and a longer dead end still counts. The out-door is the door in the board's
route-exit direction, which leads toward the tomb's exit. The in-cells are where
routes enter: the cell of each door whose far board is a route board leading
back through it, which covers a route's predecessor, a tributary merging here
and the upstream tomb's exit board beyond an in-door, and the flame cell of a
source board `S`. These differ from the junctions above, which count cells on
the primary path with a tree link off it, `b` included and doors not counted.
Paths run from every in-cell, `o` has no pointer because a sconce already marks
its door, and doors count as ways out. A route board holds 3.9 sign junctions on
average at EASY, 5.7 at MEDIUM and 5.6 at HARD and ULTIMATE. The stub rule
changes where pointers stand and never the board: over tombs
`u ∈ [−2, 2]` by `v ∈ [0, 19]` of seed `0000-0000` it removes 7, 4, 6 and 5
cells out of 1158, 3478, 5844 and 9507 at EASY to ULTIMATE.

**Pointers.** A sign junction holds at most one pointer, an arrow or a
skeleton, by one hash. With `h = u32(H("sign", x, y, cell)) mod 1024`, the
level's skeleton threshold `t` and its arrow width `a`, a junction holds:

| Band | Pointer |
|---|---|
| `h < t` | tier-1 skeleton |
| `t <= h < 2t` | tier-2 skeleton |
| `2t <= h < 2t + a` | arrow |

The thresholds `t` are 104 at EASY, 30 at MEDIUM, 17 at HARD and 11 at
ULTIMATE, so each skeleton tier averages about one per tomb. EASY's sits above
one per tomb before spacing, so each tier keeps its count under the wider
spacing; its arrow band `[2t, 2t + a)` moves with it and is `[208, 293)`. The
widths `a` are 85, 64, 43 and 32, `round(1024 / N)` for an arrow at 1 junction
in `N` = 12, 16, 24 and 32.
The bands are disjoint, so no junction holds two pointers.

**Spacing.** No two pointers of a board, of any kind or tier, stand within
Chebyshev distance 2 of each other: `max(|col p − col q|, |row p − row q|)` is 3
or more, with `col = cell mod 12` and `row = floor(cell / 12)`. The band
members are the candidates. Tier 1 goes first, then the arrows, then tier 2,
each ascending by cell, and a candidate stands unless a pointer already standing
lies within distance 2. Tier 2 goes last because it hides above half the burn,
so a hidden skeleton never removes a pointer the player can see; tier 1 goes
before the arrows because it is the chosen hint at about one per tomb. The rule
spans one board and reads its board and hash alone, so placement stays
deterministic and lazy; a pair across a board edge is not checked and stays
rare. The 440 tombs below held 182, 153, 77 and 62 candidate pairs within two
cells at EASY to ULTIMATE before the rule.

| Level | Sign junctions per tomb | Tier 1 per tomb | Tier 2 per tomb | Arrows per tomb | Arrow share |
|---|---|---|---|---|---|
| EASY | 10.84 | 1.016 | 0.839 | 0.795 | 0.0734 |
| MEDIUM | 34.10 | 1.066 | 0.911 | 1.914 | 0.0561 |
| HARD | 60.08 | 0.936 | 0.959 | 2.518 | 0.0419 |
| ULTIMATE | 90.64 | 1.052 | 0.843 | 2.736 | 0.0302 |

Measured over the 440 tombs `u` −5..5 by `v` 0..39 of seed `0000-0000`. Before
spacing the tiers held 1.093, 1.016 and 0.920 per tomb at EASY, 1.086, 1.030 and
2.100 at MEDIUM, 0.939, 1.020 and 2.620 at HARD and 1.064, 0.893 and 2.816 at
ULTIMATE. 36% to 42% of tombs hold no tier-1 skeleton and the most in one tomb
is 4 to 5. The level selects the bands and enters no hash; tier 1 is the same
set with or without tier 2 or the arrows, because it goes first. A pointer
points along the tree link from its junction to the next cell of its path
toward `o`: one of the eight link directions, galleries included. It names the
link to take, not the distant door, and so points the way on. Dead-end boards
carry no pointer, because the route does not pass through them. Pointers read
the built board and enter no board, band or digest.

Generation is lazy. The game holds the tombs within one of the explorer's in
both axes, and builds a board when it first comes within one board of the
camera.

**Floor items.** A dead-end cell is a carved cell of a tree board with exactly
one tree link, no door and no flame, where a flame is any in the board's flame
set: gap flames and a dead-end board's deepest-cell flame included. The flame
cell of §2, which the carve protects whether or not it burns, stays eligible.
A rock board has none. An ordered item list names each kind, its hash tag and
its percentage or its count. The rows claim cells in list order from the
dead-end cells the earlier rows left, so two items never share a cell. A
percentage row takes each such cell whose `u32(H(tag, x, y, cell)) mod 100`
falls below it. A count row takes that many such cells of lowest
`u32(H(tag, x, y, cell))`, the lower cell winning a tie, or all of them when
fewer remain. Two kinds ship, in this order: the coin, at 5 under the tag
`coin`, then the oil jar under the tag `oil`, counted: every tree board holds
2 jars at EASY and 1 at MEDIUM, HARD and ULTIMATE. The coin keeps its cell, so
a jar ranks only the board's **free cells**, its dead-end cells without a
coin; a coin on a jar's first-ranked cell moves the jar to the next rank and
never removes it. A board with fewer free cells than its count holds a jar on
each and a board with none holds none; no tree board in the sample below has
none. Placement reads hashes only. Items are read off a built board and built
into none. The difficulty enters the jar's count and no tag, and no pinned
digest depends on either. On seed `0000-0000`, tombs `u ∈ [−2, 2]` by
`v ∈ [0, 19]`:

| Level | Dead-end cells per tree board | Coin | Jars per tree board | Short of the count |
|---|---|---|---|---|
| EASY | 4.66 | 5.9% | 1.99 | 5 of 388 |
| MEDIUM | 6.41 | 5.0% | 1.00 | 0 of 888 |
| HARD | 6.60 | 5.0% | 1.00 | 0 of 1551 |
| ULTIMATE | 6.61 | 4.8% | 1.00 | 0 of 2378 |

**Coin rows.** A **corridor** is a tree link east from cell `c` to cell
`c + 1` of one board; a board seam and a door carry no tree link. A corridor
holds a **row** when `u32(H("row", x, y, c)) mod 100 < 4`, with `(x, y)` the
board and `c` its west cell. One rate holds at every level, and the level
enters neither the tag nor the rate. The rule reads the link and its hash
alone, so a row is as likely on the way on as in a dead end, and a row marks
neither: coins point nowhere. No jar or brazier follows a row, and a row in a
dead end tempts the player down it, a choice between coins and torch time.

A row holds three coins, 6 px wide with 1 px gaps. Coin `i` of 0, 1 and 2 rests
on the floor at board x `48·col + 48 + 7·(i − 1)`, with `col = c mod 12`, and
at the floor y of a dead-end item: the middle of the 16 px wall opening between
the rooms and 7 px either side. The sprites span board x `48·col + 38` to
`48·col + 57`. That span lies between the two rooms' ladder and brazier columns
(x 16 to 31 of each room) and beside the skeleton corners (x 32 to 38 of the
west room, 9 to 15 of the east), so no opaque pixel of a coin meets rock, a
ladder, a stair, a ledge, a sconce, an arrow, a skeleton of either tier, a
brazier, a jar or a dead-end coin. A pitch of 8 reaches a skeleton. Every row
coin lies at least 17 px from both standing points of its corridor, past the
12 px touch reach (§5), so a run starts or resumes on any cell that touches no
row coin, and a tomb entry needs no exception. A row reads no flame, no sign and no
level, and builds into no board or band: no pinned digest depends on it. The
rows add about ten times the dead-end coins to a tomb. On seed `0000-0000`,
tombs `u ∈ [−2, 2]` by `v ∈ [0, 19]`:

| Level | Corridors per tree board | Rows per tomb | Row coins per tomb |
|---|---|---|---|
| EASY | 21.71 | 3.26 | 9.78 |
| MEDIUM | 24.63 | 8.52 | 25.56 |
| HARD | 27.10 | 16.86 | 50.58 |
| ULTIMATE | 26.94 | 25.62 | 76.86 |

**Wind.** A route board's **way on** is every cell on the tree path from one of
its in-cells to the out-door's cell `o`, `o` included, with the in-cells and
`o` of the sign junctions above. A **dead-end branch** is what hangs off the
way on through one link or door: the cell beyond that link or door, its
**first cell**, and every carved cell reachable from it without entering the
way on. The way-on cell it hangs from is its **junction**, the entrance. A
branch includes every dead-end board behind a door in it, so a side passage and
the dead-end rooms behind it are one branch. Every carved cell of a tree board
lies on the way on or in exactly one branch. A branch's length `n` counts its
carved cells, those holding a link or a door, across every board it spans.

A branch is windy when `u32(H("wind", x, y, cell)) mod 64` is under
`min(n, 18)`, where `(x, y, cell)` is its first cell, and no cell of it on its
route board holds a flame of that board's flame set. The chance `n/64` reaches
its cap of 18/64, 28%, at 18 cells. The flame rule keeps the 150 s gap rule
whole: a chain flame can stand in a side passage, and a wrong way there could
cost the torch. A dead-end board's own flame lies off every chain and exempts
nothing, nor do coins or oil jars. The level enters neither the tag nor the
threshold. Wind reads built boards and enters no board, band, digest or level.
Half to two thirds of all branches are stubs of the level's branch target, 2
cells at EASY and MEDIUM and 3 at HARD and ULTIMATE; the cap keeps most
dead-end rooms still. On seed `0000-0000`, tombs `u ∈ [−2, 2]` by
`v ∈ [0, 19]`:

| Level | Branches | Windy | Branch cells | Windy cells | Reach a dead-end board | Other, 8+ cells | Under 8 cells |
|---|---|---|---|---|---|---|---|
| EASY | 1258 | 93 (7.4%) | 9385 | 1941 (20.7%) | 28/90 | 32/177 | 33/991 |
| MEDIUM | 3757 | 234 (6.2%) | 25115 | 5256 (20.9%) | 65/206 | 38/306 | 131/3245 |
| HARD | 6304 | 399 (6.3%) | 52901 | 7595 (14.4%) | 80/348 | 68/562 | 251/5394 |
| ULTIMATE | 10250 | 723 (7.1%) | 78718 | 13534 (17.2%) | 132/497 | 136/936 | 455/8817 |

The last three columns give windy branches over all branches of each class.
A tomb holds 0.93, 2.34, 3.99 and 7.23 windy branches by level. Over
`u ∈ [−5, 5]` by `v ∈ [0, 39]`, 5.9% to 7.8% of branches and 16.6% to 18.7% of
branch cells are windy.

## 5. Save code

A position is one integer that pairs the board's signed coordinates. With
`z(n) = 2n` for `n ≥ 0`, else `−2n − 1`, `a = z(x)` and `b = z(y)`:

```
p = a ≥ b ? a² + a + b : a + b²
```

The full save is the seed code plus `p`, written `K7Q2-M9XA:4813`. Resuming
inverts the pairing, then regenerates that tomb and board directly from `H`.
No replay is needed. A save holds `|x|` and `|y|` below 2²⁵, where `p` stays
an exact integer, and a code outside that range is rejected; the longest
code runs to 26 characters. The hero appears at the board's first primary
cell `a`, the start of its way back along its route; a rock board resumes at
its tomb's first entry. Any tomb entry is a valid start, a million tombs up
included.

The save code omits the difficulty, so one `p` names a board of different
tombs at different difficulties. The player picks the difficulty on the
title, and the code reads at the difficulty in force:

- The game stores the title setting; absent, it is MEDIUM.
- The save slot (below) keeps the difficulty of the run that wrote it. A save
  from before the slot, with no difficulty beside it, reads ULTIMATE, the 6×4
  world a save from before difficulties holds. A stored `hard` names the level
  called HARD, now 4×4, so a HARD save from before the four levels resumes in
  the 4×4 world, as a typed code would.
- Restoring the slot plays its serial at the slot's difficulty, and the title
  setting moves to match. A typed save code other than the slot's serial plays
  at the title setting.

**The save slot.** One key, `infinite-maze.plane.slot`, holds the last serial,
its run and its wallet as one JSON object, rewritten whole on each write:
`{"id", "save", "level", "start", "solved", "wallet", "coins", "tombs",
"record", "continues", "recent"}`.

- `id` is 8 random base-32 characters, made when a run takes the slot.
- `save` is the serial, a save code, and `level` its difficulty.
- `start` is the run's start tomb `u,v` and `solved` its solved tombs, each
  `u,v`, so `TOMB n` is the length of `solved`.
- `wallet` and `record` are counts. `tombs` lists the tomb ids `u,v` paid, in
  the serial's seed and level.
- `coins` is always empty: taken coins live in `recent`. This build writes `[]`
  and ignores the field on read, whatever it holds or whether it is there. An
  older build rejects a slot without the field, and its next write would replace
  the slot whole, wallet included, so the empty list stays. A slot written with
  its `coins` full of ids reads as any other slot, and the next write empties
  the list.
- `continues` is the run's continue count, the times it went on after its torch
  died (§7), 0 when absent; a value that is not a count fails the slot. The end
  screen's Continue starts the next run at the count plus one. A restore of a
  slot whose run died goes on past that death, so it counts too. The slot learns
  of the death through one rule: a slot write carries the run's count, plus one
  from a dead run, the count any continuation of that run carries. The write
  that ends the run is such a write, and so is a coin, tomb, jar or
  change-of-tomb write on the tick the run died. A write stores the larger of
  that count and the stored one; a live run adopts the stored maximum, and a
  dead run's count stays as it is, so two writes on one death store one rise. A
  Continue then matches the slot, and a restore over that slot, from the end
  screen's Q and RESUME or after a reload, restores the raised count. Pause and
  resume, the title and RESUME of the open run, the splash's CONTINUE and a
  restore of a slot last written by a live run (PAUSE, a tomb entry, the splash)
  add nothing. BEGIN, a typed code other than the slot's serial and the BEGIN
  that follows RESET or a typed seed start the run at 0, and a death followed by
  BEGIN leaves nothing behind. An older build's write drops the field; this
  build then reads 0, and the same-id merge's maximum restores the count from
  memory. A reload after such a write reads 0.
- `recent` holds the coins and oil jars taken in the run's two recent tombs
  (§7), one bit per item. The recent tombs are the tomb the explorer is in and
  the tomb it stood in before, latest first. When the explorer moves from tomb T
  to tomb T′, the list becomes `[T′, T]`, and a tomb that leaves it loses its
  takes: its coins and jars lie back. So A → B → A keeps both tombs' takes, and
  A → B → C lays A's back. The field is an array of at most two pairs
  `["u,v", bits]`, the latest tomb first, and every recent tomb is written,
  `""` included, so the order survives.
  - A tomb's items run in this order: its jars, then its dead-end coins, then
    its row coins. Within a kind they run by board index `i` ascending (§3,
    `boardCoords(u, v, i, size)`), then by cell ascending, then, for a row, by
    coin 0, 1, 2.
  - `bits` is lowercase hex: digit `j` holds items `4j` to `4j + 3`, item `4j`
    as value 1, and item k is set when taken. Trailing `0` digits are dropped,
    so a tomb with nothing taken writes `""`, and items 0 and 5 taken write
    `"12"`.
  - An absent `recent` reads as no recent tombs, and so does a malformed one:
    not an array, more than two entries, an entry that is not a pair of
    strings, a tomb failing the `u,v` form, a repeated tomb, or bits outside
    `[0-9a-f]`. The slot still parses, for losing the field lays a few items
    back, where failing the slot would cost the wallet at the next write. A bit
    past a tomb's item count is ignored, so a slot read under a later
    generator marks at worst a few wrong items taken.
  - A sim built from recent tombs applies the list to the tomb it starts in:
    when that tomb is one of them, it moves to the front and both stay;
    otherwise it comes first, the latest recent tomb follows and the older
    tomb's takes lie back. Through play the serial lies in a recent tomb, so
    only a slot made elsewhere meets the second case.
  - An older build reads a slot that carries `recent`, and its next write drops
    the field; this build then reads no recent tombs, a loss accepted.

One write keeps the serial, its run and its wallet together, where separate
keys written in turn by two tabs could pair one serial's wallet with another's
save. The slot costs one serial and level, at most 13 characters for each
solved or paid tomb while `|u| < 1000` and `v < 100,000`, and for `recent` two
keys and one hex digit per four items of each recent tomb: at most 147 items,
37 hex digits, over the sample tombs.

The slot obeys these rules:

- **Clean start.** The game boots clean, and so do BEGIN, RESET, a typed seed, a
  typed save code other than the slot's serial and N at CONTINUE? (§8): wallet
  0, `TOMB 0`, continues 0 and empty tomb and record sets. The tombs and
  milestones of that seed pay again, because a clean state owns nothing. The
  title still shows the slot's serial: its seed, its save line and K COPY read
  the slot, so the player can copy the serial to type it later.
- **Taking the slot.** A clean run writes nothing until its first coin or its
  first solved tomb; before that its tomb entries, jar takes, changes of tomb,
  PAUSE, the splash and the end of the run store nothing. That first coin or
  tomb takes the slot: a new `id`, the run's last entry as the serial, and the
  run's own level, run, tombs, continue count and recent tombs replace what the
  slot held. Each later tomb entry, PAUSE, splash and end of the run rewrites
  the serial and the run, the recent tombs included; a jar take and a change of
  tomb rewrite the run and keep the serial, so a reload after either finds the
  recent tombs as the sim held them. A mis-tap of N, or a BEGIN on the wrong
  screen, so cannot erase a 20-tomb run before play starts: the slot outlives N
  until a new run earns.
- **Restoring the slot.** CONTINUE? (§8) restores it, asked by RESUME with no
  run open and by TYPE CODE with the slot's serial. A typed serial matches on
  the save code alone: the code omits the difficulty, and the slot holds the one
  its run used. Y restores the wallet, the tombs and the record into memory and
  begins the run at the serial's position, at the slot's difficulty, with the
  slot's start tomb, solved tombs, continue count and recent tombs, so `TOMB n`
  and the count continue. The clock, the trail and the coins earned this run
  start fresh. The coins and jars of the recent tombs stay taken, and every
  other floor coin and oil jar lies back (§7). An open run, left by pause or
  the splash, continues on RESUME with no question.
- **Migration.** A save from before the slot lives under seven keys:
  `infinite-maze.plane.save`, `….save.difficulty`, `….save.run`,
  `infinite-maze.wallet`, `infinite-maze.plane.coins`, `….coins.paid` and
  `….coins.tombs`. While the slot key is absent or malformed and the save key
  holds a save, the game builds a legacy slot from them under a fresh id: the
  old serial; its difficulty, ULTIMATE when none is stored; its run, when the
  old run names that save, and otherwise `TOMB 0` with the save's own tomb as
  the start tomb, as for a typed save code, so that the run's tombs can count;
  the device's wallet; the tombs and record of that seed and level; continues 0;
  and no recent tombs. The old coin key is not read. It asks CONTINUE? like any
  slot, and Y adopts it and writes the slot at once, so the device wallet joins
  the slot once. The first slot write of any kind removes the seven keys, so a
  legacy wallet that no Y adopted is then gone.

Resuming lights the torch to full. Flames never run out, so the save code
carries no pickup state, and the slot carries the takes of the two recent tombs
alone (`recent`); every other coin and oil jar lies back (§7). The game
separately keeps the most tombs solved, as the score, per seed and difficulty;
ULTIMATE keeps the bare seed code as its key, and EASY, MEDIUM and HARD add
`:EASY`, `:MEDIUM` or `:HARD`.

Browser storage holds the plane's values under keys of their own, so a
value from the stacked world that came before never reads as a position or
a score. The slot holds the wallet, so no wallet key survives:

| Key | Holds |
|---|---|
| `infinite-maze.plane.slot` | the save slot, JSON `{"id": "<8 characters>", "save": "<save code>", "level": "<difficulty>", "start": "u,v", "solved": ["u,v", …], "wallet": n, "coins": [], "tombs": ["u,v", …], "record": n, "continues": n, "recent": [["u,v", "<hex>"], …]}`; `coins` is always empty, kept for older builds and ignored on read |
| `infinite-maze.plane.best` | the best per seed and difficulty, one per device |
| `infinite-maze.difficulty` | the title setting, one per device |
| `infinite-maze.pad` | the d-pad's side, `left` or `right`, one per device |

**Coins.** Touching a coin of §4, a dead-end coin or a coin of a row, the feet
within 12 px of its floor point in x and in y, as for a flame, adds one coin to
the wallet and the coin's id to the run's taken set. The coin then stays taken
while its tomb is one of the run's two recent tombs (`recent`, above), as an oil
jar does (§7): the tomb the explorer is in and the tomb before it. It stays
through pause, the title and resume of the open run, the splash's CONTINUE, the
end screen's Continue and a restore of the slot (Y at CONTINUE?, RESUME after a
reload, a typed copy of the slot's serial). A coin of any other tomb lies on its
floor and is taken again as a fresh one, paying 1. BEGIN, a typed code other
than the slot's serial and the BEGIN after RESET or a typed seed start the run
with every coin back. RESET and a typed seed clean the title, and the run after
them starts with BEGIN. The taken set lives with the sim, which drops a tomb's
coins when the tomb leaves the recent tombs, and the slot keeps the recent
tombs' coins as bits. A dead-end coin's id is `x,y,cell`; coin `i` of the row
east of cell `c` has `x,y,n` with `n = 84 + 3c + i`, from 84 to 332, past every
cell number, so one set holds both kinds without a collision. An id holds a
board's coordinates and a number, never `p`, so it holds in any world layout.
Walking back past the recent tombs to take their coins and jars again is
accepted: no check stops it.

A run also earns coins for tombs. The slot's tomb set holds the tombs its
wallet has been paid for, each as `u,v`; it starts empty. When a run solves a
tomb (§8) that the set lacks, the wallet gains the rate and the set gains the
tomb. The run's tomb count and the record play no part: a tomb pays its rate
the first time the slot's run solves it, at any count, and a replay of a solved
tomb pays nothing. The rate is 1 per tomb at EASY, 2 at MEDIUM, 5 at HARD and
10 at ULTIMATE, set by the world's difficulty alone. Only tombs a run solves
pay: those a Continue or a restore carries were paid when first solved. The set
has no cap, because an evicted tomb would pay again.

The record holds the highest tomb count already paid in the slot, 0 when
absent, and serves the milestone alone. A milestone pays on top: for each k
with `record < 100k ≤ count`, the wallet gains 100 × k, and the record becomes
the larger of itself and the count, so each k pays once per slot. A record
already past 100k counts as paid.

Every slot write merges with storage. It re-reads the slot and compares ids:

- **The same id** is the same run, which two tabs share when both answered Y to
  one slot. The wallet, the record and the continue count merge by maximum, the
  paid tombs by union, and the pay is decided on the merged state. No coin
  merges. The run fields (serial, start tomb, solved tombs and recent tombs) are
  the writer's, and the last writer wins.
- **Another id, or none,** means the writer has taken the slot, and its whole
  state replaces what is stored. Its pay is decided against an empty stored
  state, so every coin the tick took credits. The last tab played owns the
  slot. The key is the id, not the seed, so a clean run on the slot's own seed
  earns from 0 rather than adding to the old wallet.

The pay is added to the wallet, and the slot is rewritten. Two tabs on one slot
that solve the same tomb or cross the same milestone are paid once, and neither
loses the other's coins. A tick's floor coins pay one each, with no stored list
to check, and the run's taken set keeps a coin from paying twice while its tomb
stays recent. Two tabs on one slot are two runs, each with its own taken set and
recent tombs, so each pays the coins it takes, the same coin included, as a
BEGIN on the same seed would. Blocked storage never credits a coin twice while
its tomb stays recent and never lowers the wallet. A tab shows its own last
wallet until its next write, and there is no lock and no `storage` listener.
Absent, blocked or malformed storage reads as empty, and the game plays on.
While the latest write failed, whatever its key, the title reads `SAVES OFF:
COPY YOUR CODE` above its name until a write succeeds. The `#selftest` page
keeps its storage in memory and never reads or writes the player's.

## 6. Movement

The explorer can run left and right along corridors, climb ladders up and
down, walk galleries up and down at 45° and jump. Doors are openings in a
board's wall at the door cell. Crossing one scrolls seamlessly into the
neighbouring board.

Movement speeds are 96 px/s running, 72 px/s on a gallery and 48 px/s on a
ladder.

**Rails.** The explorer moves along the cell graph. A jump is an air state of
the current cell, and a let-go one of the ladder's lower cell. On the ground or
in the air, the explorer leaves a cell only along a tree link or door, so
motion follows exactly the tree. Nothing falls between cells: a drop would be
a one-way link, which could open a second route or trap the explorer. Ladder
tops are solid to walk and land on.

**Intent.** On the floor, Up takes the cell's up-link, unless Left or Right
is held toward the side opposite an up-gallery; Down mirrors it.
- The link engages from any point on the floor. The explorer slides to its
  foot at run speed, facing the gallery's direction, or keeping its facing
  for a ladder.
- Walking toward a side with no corridor and one gallery enters that gallery.
  Left, Right, Up or Down along a link moves along it.
- A Left or Right press sets facing at once, even when the explorer cannot
  move.
- An Up or Down tap released up to 150 ms (9 ticks) before the tick that
  enters a cell with a matching link engages it, whether held one tick or
  pressed and released within one. Travel along the link still needs the key
  held.

**Leaving a ladder.** Every point on a ladder lies within 24 px of a floor.
- On a ladder, with Up and Down released, a Left or Right press commits the
  explorer to the ladder's nearer end, the far end from the midpoint on. It
  travels there at ladder speed and stands on that end's floor; a side still
  held then walks by the floor rules. A side held from before the ladder
  engaged leaves the explorer on it. Holding Up or Down cancels the dismount
  and moves along the ladder.
- A jump lets go. The explorer drops from the height of its feet, with zero
  vertical speed, over the ladder's lower cell, and the air rules carry it to
  that floor. A let-go from a down-ladder moves to the link's lower cell along
  the ladder link, firing the board events a ladder arrival fires. At the
  ladder's start, before it has moved, the explorer stands on the floor it
  engaged from, and a jump there is an ordinary floor jump.
- After a let-go, a held Up grabs nothing until Up is pressed anew or the
  explorer lands.

**Jump.** The jump starts from the floor or a ladder's start: a launch at
128 px/s under 512 px/s² gravity, a 16 px apex after 0.25 s and 0.5 s of air,
covering 48 px of run. Horizontal control in the air runs at run speed. A
jump on a gallery is ignored.
- The explorer tucks in the air to 16 px tall, which leaves it 16 px of head
  room in a room's 32 px interior. Every floor jump peaks at exactly that
  height, in a room, a corridor or under a shaft, and no rise exceeds it by
  more than rounding.
- After a let-go with its tucked head above the room's ceiling, the explorer
  stays within 3 px of the shaft's centre until the head drops below it.
- Over the cell's own up-stair, the stair bounds the landing point from
  below. Once the feet pass 11 px from the cell centre toward the stair, the
  landing point is the leading foot, the box's lower corner 5 px from the
  feet on the stair's rising side; that corner then lies past the room wall,
  where the stair is rock. Elsewhere it is the feet's centre, since the room
  holds no stair rock. The explorer lands when its landing point meets the
  stair, at the gallery position under its feet, so a leading-foot landing
  drops the feet at most 5 px. The air box never enters rock.
- Elsewhere the floor's side limits hold in the air, so a down-gallery's
  mouth keeps the explorer out.
- Along corridors, ladder cells included, a jump never speeds or slows a run.
  At gallery mouths it does. Over an up-stair the air keeps run speed, which
  the stair walk lacks, and a jump saves up to 0.1 s (6 ticks), 7.4 px on the
  stair. A down-gallery's mouth holds an airborne explorer at the cell centre
  until it lands, and a jump there loses up to 36.0 px of route over a run
  from the corridor cell before the mouth.

**Air grabs.** In the air:
- Up grabs the cell's ladder up at the current height when the explorer is
  within 3 px of its shaft's centre.
- A landing point that falls onto the cell's up-stair lands on the gallery.
- With Up held, the up-gallery engages once the landing point comes within
  4 px of its stair. The arc lands at 128 px/s, so per tick it closes that gap
  by at most 3.7 px, 2.1 vertical and 1.6 horizontal, and a held Up never
  skips the window, except on the tick the feet pass 11 px, where the landing
  point moves 5 px up the stair and the stair landing catches the explorer.

## 7. Torch

The torch is the explorer's light, and its burn time is the game's clock. Fuel
is abstract: touching a flame relights the torch to full, like a fresh
battery.

- **Burn:** a full torch burns for 300 s.
- **Light radius:** the lit area falls linearly with the remaining burn, from
  a 96 px radius when full to 24 px at the last 10%, so the radius is the
  square root of that blend, about 39 px at 20% burn. Flicker grows as the
  light shrinks.
- **Wall sconces:** every board has a lit sconce beside each door, with a
  64 px light radius. Entering a board lights the explorer and the doorway,
  and the rest of the board stays dark. Sconces give light only.
- **Flames:** a brazier burning turquoise relights the torch to full on touch
  and never runs out. §3 places them. A flame inside a route board can sit on
  a dead-end branch of that board's maze.
- **Oil jars:** touching a jar of §4, the feet within 12 px of its floor point
  in x and in y, as for a flame, adds 60 s of burn, capped at a full torch,
  before that tick's own burn. A jar is taken at any burn, a full torch
  included, and the cap wastes the excess. During the ember a jar sets the
  burn to 60 s and ends the ember, where a flame sets it to full. A jar pushes
  the event a flame does, so the relight sound and the music's drop follow it.
  A taken jar stays taken while its tomb is one of the two recent tombs (§5),
  through pause, the title, a reload, RESUME and Continue, and lies back once
  its tomb is neither the explorer's tomb nor the tomb before it, and on BEGIN
  and a typed code other than the slot's serial.
- **Tier-2 skeletons:** §4's second tier shows only under half the burn. Its
  opacity is `clamp((150 − burn) / 10, 0, 1)` with `burn` in seconds: 0 at 150
  s, 1 at 140 s and in the ember. A flame or a jar that lifts the burn to 150 s
  or above hides it on that tick. Tier 1 and the arrows show at every burn.

No board burns for being a tomb entry: braziers stand where chance and the gap
rule put them (§3). No stretch of a way on takes more than 150 s between
flames, across tomb walls too, so a full torch covers the longest stretch
twice, and only real disorientation runs it dry. A new run and a resume light
the torch to full at their start (§5), so the first flame lies within 150 s of
a source tomb's `S` and within 75 s of an in-door, where the explorer arrives
carrying burn.

When the burn reaches zero, the torch gutters to an 8 px ember for 10 s, and
reaching a flame in that time relights it. Otherwise the run ends. The end
screen shows the tombs solved, the time, the run's continue count (§5) and the
save code for the last tomb entry reached, and Continue resumes there with a
full torch and adds one to the count.

## 8. Presentation

**Graphics.**
- Canvas 2D, with `imageSmoothingEnabled = false`. The view spans 320×180
  game pixels, and the art, drawn in game pixels, scales nearest-neighbour.
  Every resample is nearest-neighbour except the light map's smoothed upscale
  onto the display (Lighting). In keyboard mode the view scales up by the
  largest whole multiple of CSS pixels, centred.
- The world, the back wall, the explorer, the light and the dust draw through
  one world-to-device transform at device-pixel precision: a layer's pixel
  edges and a sprite's outer edges land on the device pixels nearest their
  true positions. The HUD and the screens stay on whole game pixels.
- In touch mode (§9) the canvas's backing store is in device pixels and the
  page background fills the letterbox. When the safe area holds a whole scale
  of at least 6 device pixels per game pixel, the view scales by the largest
  whole number that fits, so a game pixel spans exactly that many device
  pixels. Below 6 the view fills the safe area at a fractional scale `s`, and
  a game pixel spans ⌊s⌋ or ⌈s⌉ of them.
- When the safe area's height less a full-width 16:9 view leaves room for the
  d-pad and its margins, the controls fill a band below the view and the view
  stands at the top: a whole view centred across, a fractional one spanning
  the width. The band starts at the view's bottom and keeps the safe area's
  full width. Otherwise the controls overlay the view, and a whole view
  centres in the safe area across and down, a fractional one fitting it.
- 16×16 tiles. A cell is 3×3 tiles, so a board is 576×336 px.
- A palette of 32 colours: sandstone, ochre, lapis, turquoise, gold, torch
  orange and violet shadow.
- Sprites and tiles stored as palette-indexed strings in the source.

**Lighting.** A light map at quarter resolution, lit by the torch, the
sconces and the flames, composited multiplicatively over the scene. The light
map renders in the world layer's frame (§9) and rides the same transform, so a
sconce's light and its sprite round together and the torch's light centres on
the torch tip. A sconce or flame lights the light map wherever its light
reaches it, from a board the world layer shows or not: the boards within
89.6 px of the light map, the brazier's 80 px radius at its peak flicker of
1.12, contribute lights, and only the boards the world layer shows draw
sprites.
Hieroglyph walls scroll behind at 0.5× for depth. Dust motes hang in the world, never with the explorer
or the camera, and show in torchlight: drawn inside the torch radius and
fading toward its edge. While the explorer's cell lies in a windy branch (§4),
all motes drift together at 12 px/s along the first link or door of the walk
from that cell to the branch's junction. The drift velocity turns toward its
target by at most 12 px/s each second, so the motes reach full speed or rest
within a second, and a turn bends. It advances by the wall time between frames,
at most 0.25 s a frame and never backward. The torch flame stays upright, and
the dust hangs still on the way on and in a windless branch.

**Stairs.** A stair draws side-on as six 8×8 steps in solid stone, flush
with the lower floor and the upper floor. Column `t` of a flight, 0 to 47,
holds the cut air from its tread row down to the first rock and never below
the room floor's first air row, `Y + 8`. The tread over column `t` is row
`Y + 15 + 8·⌊t/8⌋`: the first tread stands 8 px over the lower floor, each
tread's inner corner, `t = 8k + 7`, sits on the feet row `Y + 8 + t`, and
the last tread is the upper floor. Where a tread row is rock, the column holds no
stair pixel and the rock's own top edge draws the tread; likewise the rock's
side edge draws the bottom row of a riser face from `t = 16` on. A stair
pixel shades as rock, taking the rock tile: each tread takes the floor's
highlight on its top row and the row under it, each riser face the side edge.
The stair paints nothing of its own and casts no shadow on the air beside
it. Where the side cell of the riser at `t = 32` is carved, that room's
ceiling underside shades the riser's rows `Y + 40` and `Y + 41`. Steps that overhang
a ladder shaft or a bottom door rest on a 4-row rock ledge, which the ladder
draws over. The lower room's ceiling corner gives way under the gallery's
ceiling line, so a climbing explorer's head stays in air. Where a gallery
starts in a cell, a ladder in that cell ends at the floor, and a bottom
door's sconce stands clear of the flight.

**Arrows.** An arrow is a carved glyph, at most 7×7 px, in one of eight glyphs,
one per link direction (E N W S NE NW SW SE). It sits in an upper corner of its
junction's room, in cell-local columns 8 to 15 or 32 to 39 (the hash picks
the corner) and rows 31 to 37, clear of the sconce flame, which ends at row 29.
Both upper corners of every sign junction hold room air and no ladder, stair,
sconce or flame pixel. The board art draws the arrow after the mask's shading,
so it sits on the board layer at full brightness in front of the half-bright
wall, and the light map lights it as it lights the walls.

**Skeletons.** A skeleton is a small, dim figure slumped in a lower corner of
its junction's room, its arm pointing the way on. It fills a 7×10 px box on
the floor, against the room's side edge: cell-local columns 9 to 15 for the
left corner or 32 to 38 for the right, rows 8 to 17. The ladder's floor opening
at columns 16 to 31 and the sconce, whose pixels start at row 20, lie outside
it. The explorer is 16×24, so the skeleton stands under half its height. Where
the room's side edge is a doorway, the skeleton sits beside it.

- **Corner.** A way on to the right prefers the left corner, and one to the
  left the right, so the arm reaches across the room toward the corridor. An up
  or down way takes the hash's corner (§2). A corner is blocked when the
  cell's gallery runs toward that side: a north-east or south-east link blocks
  the right corner, a north-west or south-west link the left. A blocked
  preferred corner gives way to the other. A cell holds at most one gallery, so
  one corner is always clear; the preferred corner is clear at 85% to 87% of
  sign junctions. A corner box holds room air, solid floor beneath it and no
  ladder, stair, stair-ledge, sconce or sconce-flame pixel exactly when its
  side is not blocked.
- **Poses.** Six poses, drawn for the left corner with column 0 at the side
  edge and column 6 toward the room, each with its skull in rows 1 to 3 and
  one `9` pixel, the fingertip. Row 0 is the top row and sits at room row
  `Y + 17`, so sprite row `r` sits at `Y + 17 − r`. Right: the arm out at
  shoulder height, the fingertip at row 4, column 6. Up: the arm raised beside
  the skull, the fingertip at row 1, column 5. Left: the arm across the body
  toward the side edge, the fingertip at row 4, column 0. Down: the arm
  reaching down in front of the legs, the fingertip at row 7, column 5.
  Down-right: the arm slanting down and out, the fingertip at row 7, column 5.
  Up-right: the arm slanting up and out, the fingertip at row 2, column 5.
  Every fingertip but left's has one opaque neighbour of its eight inside the
  sprite, the arm pixel it extends from: orthogonal on right, up and down,
  diagonal on up-right and down-right. Left's fingertip touches its arm pixel
  and its rib pixel at row 5, column 1. Down's and down-right's fingertips sit
  at room row `Y + 10`, three rows above the floor's top row at `Y + 7`; rows
  `Y + 8` and `Y + 9` under the fingertip are room air. The galleries draw
  their own diagonals: a north-east or south-east way draws up-right or
  down-right in the left corner, and a north-west or south-west way the mirror
  in the right corner, which its gallery forces. The other ways draw right,
  up, left and down. The right corner draws each pose mirrored, column `c` to
  `6 − c`, so its left pose stands for right and its right pose for left; up,
  down and the diagonals keep their pose and draw it mirrored.
- **Palette.** Palette `5` to `9`, umber to sandstone, so a skeleton sits
  darker than the stair treads and the bone white.
- **Tiers.** Tier 1 draws on the board layer after the mask's shading, as the
  ladder does, at every burn; the stair draws in that shading. Tier 2 draws in
  the scene after the boards and the floor items and before the flames and the
  light map, at the opacity §7 gives, and draws nothing with no explorer. The
  light map lights both as it lights the walls, the sconces and flames
  included.

Arrows and skeletons are a deliberate, always-on exception to the rule that
aids record and never point: they ship with no setting.

**Score.** A tomb is solved when the explorer leaves it through its exit
door, and only if it lies on the run's way on: the run's start tomb, the tomb
its exit leads to, and so on along the generator's exits. A tomb off that way
on never counts, whatever door the explorer used, so an upstream basin cannot
be farmed. Each tomb counts once. Continue carries the run's start tomb and
its solved set, so the run keeps one way on. Y at CONTINUE? (below) continues
them from the slot (§5); BEGIN, a typed seed and any other save code start a
new run with its own start tomb. The
HUD's `TOMB n`, the pause header's `TOMB n`, the title's `BEST TOMB` and the
end screen's `TOMBS CLIMBED` show that count. The run also keeps a continue
count (§5), the times it went on after its torch died: Continue raises it by
one, and pause, resume and the splash's CONTINUE never do. The end screen, the
pause header and CONTINUE? show it beside the tomb count, and `BEST TOMB` keeps
the tomb count alone.

**Oil jars.** A jar is a sprite at most 9×12 px: a knobbed lid over an umber
rim and a rounded body of dark violet oil, outlined in umber so it stands off
the lapis back wall. It rests on the floor at the same point as a coin: 12 px
from its cell's standing point, away from the cell's one link, or east of a
ladder. It stands in the room's columns 8 to 16 at the west point and 31 to 39
at the east, so it never covers rock or a shaft. The scene draws untaken jars
after the boards and before the light map, as it draws coins, and never bakes
one into the board art.

**Coins.** A coin is a gold sprite at most 6×6 px, ringed in gold with a bone
glint on its upper left. It rests on the floor 12 px from its cell's standing
point, on the side away from the cell's one link, or east of a ladder, which
keeps it off the corridor mouth, the ladder shaft and the stair. A row coin (§4)
rests on the corridor floor at its own point, drawn and lit as a dead-end coin.
The scene draws a coin after the boards and before the light map, so the torch,
sconces and flames light it and it is dark where they are. It is never baked
into the board art, and a taken coin is not drawn. The HUD shows the wallet
under `TOMB n` at the top right: the coin sprite, one space after it, then the
count right-aligned at x 315 with its top row at y 14, growing leftward. The end
screen has a row `COINS n` inside its panel: every coin this run earned in this
tab, from the floor and from tombs; coins another tab merges raise the wallet
but not this row. The count carries through Continue and through pause, title
and resume of the open run, and restarts on BEGIN, on a typed code and on Y at
CONTINUE?. A row `CONTINUES n` stands under it, 11 px below and inside the
panel, with the run's continue count. The pause header shows `CONTINUES n` on
the row of `TOMB n`, left-aligned at the panel's inner edge, x 53, mirroring
`TOMB n` at the right; for n up to 99 the text and its shadow end at x 124,
flush against PAUSED at 125.

**Splash.** When the tomb count rises to 100 × k, k ≥ 1, the game shows the
`splash` screen once that tick ends, and stores the save in the slot as pause
does, once the run has taken it (§5). A run
that ends on the same tick shows the end screen, and the payout stands. The
run stands still under the splash: the sim does not step, so the torch and the
clock hold until CONTINUE. Every run that reaches a milestone shows its
splash; only the payout is once per slot (§5). One panel, x 50 to
270, holds these rows:
- the milestone, `<100 × k> TOMBS`;
- the rank name, at scale 2 when it fits the panel and else at scale 1;
- `<100 × k> COINS`, only when this crossing paid (the font draws no `+`);
- the key hint `ENTER CONTINUE  Q HOME`.

The rank names below are the owner's to revise:

| k | Rank |
|---|---|
| 1 | TORCHBEARER |
| 2 | RELIC HUNTER |
| 3 | TOMB DELVER |
| 4 | SCARAB SEEKER |
| 5 | PATHFINDER |
| 6 | ROYAL SCRIBE |
| 7 | HIGH PRIEST |
| 8 | GRAND VIZIER |
| 9 | HEIR OF THE NILE |
| 10 | PHARAOH |

Past k = 10 the rank reads `PHARAOH` and the Roman numeral of k − 9: PHARAOH II
at k = 11, PHARAOH III at 12. A numeral past 3999 adds a leading M per
thousand. Every name uses only characters the font draws.

**Labels.** The title's panel holds a difficulty row naming EASY, MEDIUM, HARD
and ULTIMATE with the setting lit, and its save line names the slot's serial
and difficulty. Its best tomb is the shown seed's at the setting. The pause and
end screens name the run's difficulty after the save code. The pause map draws
the run's tomb at 3 px per cell, a frame of `W·36 × H·21` px: 72×42 at EASY,
108×63 at MEDIUM, 144×84 at HARD and 216×84 at ULTIMATE, centred in the
largest.

**CONTINUE?** A panel on the title, in the title's own panel, asks before a
stored slot is restored. It reads `CONTINUE?`, names the slot's serial, its
difficulty and `TOMB n`, shows the slot's wallet and continue count as
`COINS n  CONTINUES m`, and hints `Y YES N NO`. RESUME with no run open opens
it (§9), and so does a typed save code equal to the slot's serial; RESUME of an
open run continues with no question. Y or Enter restores the slot (§5) and
begins its run. N, Esc or Q returns to the title with the clean state,
whichever path opened the panel, and the slot stands until a new run earns. The
panel ignores auto-repeated keydowns, so a held key answers nothing, and
ignores every other key, Space and P included, except M, which mutes as on
every screen.

**Camera.** The camera follows the explorer with a lerp and a deadzone and is
never rounded. The frame maps the world to device pixels through it and rounds
only at the draw, so at a constant speed a world point's step a tick varies by
at most one device pixel, the explorer and its torch light hold still at a
steady lag, and the world stands still while the deadzone holds the camera.
The explorer draws from its true feet, within a device pixel of them. It
scrolls freely across board seams, and rock fills every position outside the
band trees.

**Explorer.** A khaki-clad figure in a fedora, carrying a torch, with these
animations:

| Animation | Frames |
|---|---|
| Idle | 4 |
| Run | 8 |
| Climb | 4 |
| Gallery walk | 8 |
| Ember gasp | 2 |
| Jump | 2: rising, falling, tucked 16 px tall |

**Music.** Synthesized with WebAudio on a lookahead scheduler:
- The Hijaz mode on E (E F G♯ A B C D) carries the melancholy.
- An 8th-note bass ostinato and a synthesized frame drum at 110 BPM carry the
  urgency.
- A low-pass filter, light bit-crushing and tape wobble (a slow LFO on detune)
  make it lo-fi.
- Intensity follows the burn: as the torch dims, the music adds layers and
  its tempo rises to 128 BPM. A relight drops it back.
- The scheduler follows the wall clock. While muted it keeps time and builds
  nothing, so unmuting drops in mid-tune; after a stall it drops the notes it
  missed and resumes where the music would have been.

**Sound.** Footsteps on stone, ladder creak, the whoosh of a relight and the
torch sputtering at low burn.

## 9. Runtime

The simulation runs on a fixed 60 Hz timestep, with rendering on
`requestAnimationFrame`. The frame draws the back-wall, world and light layers
at game resolution, each spanning the view and 2 px more on every side: the
world and light layers at the whole camera ⌊cam⌋ and the back wall at
⌊cam / 2⌋. It then composites them, the explorer and the dust onto the display
through the world-to-device transform (§8), the light map multiplying the back
wall, the world and the explorer, and draws the overlay of the HUD and the
screens over them at the display's size. Building a board takes 0.7 ms on
average and 17 ms at most, and a tomb's board tree 0.04 ms on average and
under 1 ms at most, measured on node 26.7.0 and an Apple M3 Max.
The frame warms the world ahead of the view. The warm window spans two boards
beyond the view on every side, one more than the window that gets board art,
and warms its boards nearest the camera first, by row and then column among
equals. Each frame does two units of world work: building a board, building
one tree board of the board's tomb, whose flames the board reads alone (§3),
computing that tomb's flames, computing the board's flames, or, on a route
board, computing its wind. A board unit builds one board. A flames or wind
unit builds none of its own, but its walks can build up to three beyond the
tomb, so a frame builds at most six. A board enters the warm window one board
of travel before the art window: 6 s running, 7 s climbing. The frame then
builds one board's art, which takes 1.4 ms at the median on the same node and
chip; a board in view, or within the 89.6 px light reach (§8), with no art
builds it at once. The art window reaches past the light reach, so in play
those boards are built ahead. A run's first frame, a resume, a code entry and
the title preview's first frame build what they show at once.
Audio starts on the first key press or touch, as browser autoplay policy
requires. A frame that throws logs its first error to the console, shows
`ERROR  SAVE CODE` and the run's save code over a dark strip across the middle
of the view (`ERROR  SEED` and the seed while the run holds no save), and the
next frame still runs, with no tick backlog. The line stays until the screen
changes or a key is pressed, and an auto-repeat does not count.

Controls are the arrow keys or WASD for movement, Space or Z to jump, M to
mute and P to pause and show the save code. P returns the player to where
they were: from pause or the title it goes back to the game. Esc is the alias
for players outside full screen, where a browser keeps Esc for itself and a
real Esc press leaves full screen. The end screen takes Esc and Q to the
title and takes no P, so a pause press as the torch dies cannot skip the end
screen and its save code. The title and end screens ignore auto-repeated
Space presses, and the title ignores an auto-repeated P or Esc, so a held key
cannot skip a screen.

On the milestone splash (§8), Enter continues the same run and Q goes to the
title with the run open, as from pause: P there returns to it in play with its
torch, time and trail. P and Esc do nothing there, since P pauses and Esc
leaves full screen, and Space does nothing, since a fresh jump as tomb 100
lands would otherwise skip the screen. The splash ignores every auto-repeated
keydown, so a held key cannot skip it. M mutes, as on every screen.

On the title, Enter begins the shown seed at tomb 0, R rolls a new seed and
keeps the slot, and T opens code entry. H swaps the sides of the touch d-pad
and fire button and stores the side (§5), and the title ignores an
auto-repeated H. L cycles the difficulty EASY, MEDIUM, HARD, ULTIMATE and
round again; Left and Right, or A and D, step it and stop at EASY and
ULTIMATE. A change rebuilds the title's world. P (or Esc) resumes:

- A title reached from pause by Q leaves the run open, and P returns to it
  unchanged: torch, time, trail and difficulty. The open run keeps its own
  seed and world, so R, a typed seed and the difficulty change only the
  title's world; Enter or a typed save code starts a new run.
- With no run open, as at startup, P opens CONTINUE? (§8) over the stored
  slot, and Y rebuilds its run at its difficulty (§5). A rebuild never happens
  while a run is open, so a pause, title and resume cannot refill the torch.

CONTINUE? takes Y and Enter for yes and N, Esc and Q for no, and nothing else
answers it (§8).

C on the pause and end screens writes the save code shown to the clipboard.
On the title K copies the save code it shows, or the seed code when it shows
none; during code entry A, D, H, K, L and P type letters. Each screen then
reads COPIED, or COPY FAILED when the clipboard is absent or refuses, on the
screen visit that asked and nowhere once it ended. A visit ends whenever the
screen changes, even back to the same one. The copy uses
`navigator.clipboard.writeText`, which browsers allow from a key press in a
secure context, https and `file://` alike.

**Touch.** Touch mode is on at boot when the device reports a touch point or a
coarse pointer, or when the URL hash is `#touch`. A touch `pointerdown` turns
it on and a trusted keydown turns it off, so the page follows the last input
type. Every control dispatches the keyboard's own `keydown` and `keyup` events
on `window`, so the key handlers serve touch unchanged. The page never
scrolls, zooms or selects.
- **D-pad.** In play, a 4-way pad sits at the bottom left in overlay mode. In
  the band, which starts at the scaled view's bottom (§8), its centre lies a
  quarter of the safe width in, never closer than the margin to the left edge,
  and a third of the way down the band, never closer than the margin to the
  view. Its centre is neutral: a pointer there holds no direction and sends
  nothing, and a slide from an arm into it releases the arm. An arm holds its
  arrow key while a pointer is on it, a slide from arm to arm swaps the key,
  and a pointer that left the pad keeps mapping by angle until it lifts. The
  pad has no diagonals. With the title's PAD key set to `right`, the pad
  stands where its mirror across the safe area's vertical centre line would,
  and the fire button where the pad stood.
- **Fire button.** In play, a red circle (palette index `0x17`) stands
  opposite the pad at the pad's centre height, 0.4 of the pad's diameter and
  at least 44 px across; in overlay mode it draws at the pad's alpha. A
  `pointerdown` on it sends Space, so a jump fires on press, and it shows
  pressed while a pointer holds it. Its pointers and the pad's are separate,
  so two thumbs work at once.
- **Soft keys.** Each is 44 px tall and acts on `click`:

  | Screen | Keys |
  |---|---|
  | title | RESUME (P, with a slot or an open run), BEGIN (Enter), RESET (R), TYPE CODE, the difficulty (L, labelled with the setting), COPY (K), SOUND (M), PAD (H, labelled `PAD LEFT` or `PAD RIGHT`) |
  | title, typing | ACCEPT (Enter), CANCEL (Esc) |
  | title, CONTINUE? | YES (Y), NO (N) |
  | play | PAUSE (P), 96 px wide at the bottom centre, its bottom 8 px above the safe area's, in both modes and on either side; where that comes within 8 px of the pad or the fire button, it moves over the fire button, just above it |
  | pause | RESUME (P), COPY (C), SOUND (M), TITLE (Q) |
  | over | CONTINUE (Enter), COPY (C), TITLE (Q) |
  | splash | CONTINUE (Enter), HOME (Q) |

  In overlay mode a screen's keys stand in one column beside its panel, on the
  title the right one; where one column cannot hold them (the title's eight
  need a safe height of 410 px, so 640x360 splits them and 736x414 does not),
  the first half stand in the left strip and the rest in the right. A split
  title's left column stands at the top of its strip, and the title's preview
  explorer stands lower, below it.

  Each P key has Esc as its keyboard alias. CANCEL sends Esc, because P types
  a letter during code entry.
  TYPE CODE sends T, opens the browser's `prompt`, then sends each character
  of the answer as a key press and finally Enter, or Esc on cancel. The
  prompt takes a pasted save code.
- **Audio.** Any `pointerup` starts audio.

**Controller.** A gamepad whose `mapping` is `'standard'` plays through the
keyboard's own events, as touch does; the game ignores every other gamepad.
Once per animation frame, before the ticks, the game reads
`navigator.getGamepads()` and dispatches the keys due as `keydown` and `keyup`
events on `window`, with `repeat` false:

| Source | Key |
|---|---|
| d-pad (buttons 12 to 15) | ArrowUp, ArrowDown, ArrowLeft, ArrowRight |
| left stick, axis 0 at -0.5 or less, 0.5 or more | ArrowLeft, ArrowRight |
| left stick, axis 1 at -0.5 or less, 0.5 or more (down positive) | ArrowUp, ArrowDown |
| A or cross (button 0) | Space |
| B or circle (button 1) | Enter |
| Select or Back (button 8) | Q |
| Start (button 9) | P |

A key sends one `keydown` when its first source presses and one `keyup` when
its last lets go, and never a repeat. A stick axis holds its arrow from 0.5
until it is back inside 0.4, so a stick at the threshold does not chatter, and
a diagonal push holds two arrows. Sources merge: a key stays down while any
d-pad button, stick or other gamepad holds it, and a gamepad that leaves the
list releases what it held. A gamepad is its index in the list, so a browser
that returns fresh snapshots on every call reads as one steady gamepad. The
right stick, the triggers, the other buttons, rumble and remapping are absent.

Touch mode stays as it is: the events are untrusted, so a controller neither
turns touch mode off nor hides a touch control. Start acts as P does: it
pauses in play, resumes from pause and resumes the open run on the
title, or asks CONTINUE? over the stored slot; the end screen and the splash
ignore it. Select acts as Q does: it goes to the title from pause and from the
splash with the run left open, and from the end screen; play and the title
ignore it. A on the splash does nothing, as Space does nothing there, so B,
which sends Enter and never jumps, is a controller's way on. On CONTINUE? B
answers yes and Select no, and A and Start do nothing, so a jump habit cannot
answer. During code entry Start and Select type P and Q and B
submits. Gamepad input grants a browser no user activation, so audio may stay
silent until the first key, click or touch.

## 10. Acceptance

A headless test harness, run with `node`, checks the generator against the
same source the game uses, at each of the four levels over one window of
tombs: `u ∈ [−10, 10]`, `v ∈ [−50, 50]`, 2,121 tombs, unless told otherwise.
Each check reads the tomb size from its world, and the room parameters of §3
and §4 from the harness's own table by the world's level. Flow, Way up and
Solvability's tomb walk read the generator's exits, and every check reads a
source tomb's `S` from the generator. Everything else follows doors held on both sides,
never the generator's tomb graph, so a generator fault cannot vouch for
itself. Per level, the summary also prints the room rule and the exploration
time: the mean, over the tree boards checked, of the walk that takes every
link of a room out and back.

- **Keccak:** SHA3-256 matches the FIPS 202 test vectors.
- **Continuity:** every door in the window matches in position on both
  sides of its wall.
- **Tree:** per tomb, the graph of carved cells and doors is one tree,
  connected with edges = nodes − 1, that joins all of the tomb's wall doors.
  A carved cell holds a link or a door.
- **Flow:** each tomb's exit is left, right or up; its exit wall holds
  exactly one door, matched on both sides; every other door of the tomb faces
  a neighbour whose exit points into it; no two side neighbours exit into
  each other. The harness reports the shares of up, left and right exits and
  the mean sideways run.
- **Acyclic:** the window's tombs, joined by their wall doors, form a forest:
  union-find over tomb doors finds no cycle, so a second door on one tomb
  wall fails.
- **Way up:** from every window tomb, the walk along the generator's exits
  climbs past the window's top row within 100,000 steps, leaving the window
  sideways if it does. It reads the flow alone, which no difficulty changes,
  so it runs once, at ULTIMATE. The harness reports, without judging them,
  the share of window tombs whose walk meets tomb `(0, 0)`'s within the cap
  and the largest and mean steps to meet.
- **Bounds:** every tomb's trunk covers at least half its boards, rounded
  down, a one-board trunk aside, every dead-end branch is at most the level's
  `D` boards deep, and every board meets the level's targets in §4 or
  records its best-attempt fallback.
  A run of at least 2,000 boards fails when more than 2% of them fall back; a
  shorter run reports the rate.
- **Galleries:** every gallery owns its 2×2 block, no two blocks share a
  cell, and galleries average 4·C/50 to 10·C/50 per board: 3.2–8 at EASY,
  3.6–9 at MEDIUM and 4–10 at HARD and ULTIMATE. The harness reports the mean
  and the block conflicts.
- **Carve:** every door cell and flame cell holds a link, every tree board
  carves at least `C` cells, and the mean stays within C·96/100 to C·112/100:
  38.4–44.8 at EASY, 43.2–50.4 at MEDIUM and 48–56 at HARD and ULTIMATE. A
  cell is carved when it holds a link, doors aside. The harness reports the
  mean.
- **Flames:** each entry's chain runs from a `start` at `P` to an `end` at
  `Q`; every member between them is lit, lies on the tomb's own way-on boards
  and runs in walk order; every stretch stays within its limit, 150 s between
  flames and 75 s from an in-door or to `Q`; every flame on a route board
  belongs to a chain of its tomb; and every crossing of a tomb wall in the
  window, the upstream chain's trail plus the downstream chain's lead, takes at
  most 150 s. The harness reports the maximum and the 99th percentile over the
  flame-to-flame stretches, an `S` start counting as a flame, with each
  crossing measured whole.
- **Solvability:** the harness follows the generator's exits from tomb
  `(0, −50)` until a tomb in row 50, leaving the window sideways if the walk
  does; a breadth-first search over carved cells and doors, confined to those
  tombs, reaches the last tomb's exit door from the first tomb's first entry.
- **Saves:** encoding and decoding round-trip for a sample of positions of
  both signs, and a board resumed at the world's difficulty is
  byte-identical to one generated in sequence.
- **Determinism:** a fixed seed code produces a fixed digest of tombs
  `u ∈ [−2, 2]`, `v ∈ [0, 19]`, v outer and u inner, at each difficulty: four
  pinned digests, each distinct.
