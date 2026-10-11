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
EASY 3×2 (6 boards), MEDIUM 4×3 (12) and HARD 6×4 (24). Every other rule
holds at every difficulty, and a world never mixes sizes. A tomb depends on
the seed, its position and the difficulty alone; the difficulty enters no
hash.

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
| Flame in a dead-end board | `H("flame", x, y)` byte 0 < 128 | 50% |
| Flame cell | `H("flame", x, y)` u32 at bytes 4–7 mod 84 | any of the 84 cells |
| Sign at a sign junction (§4) | `H("sign", x, y, cell)` u32 mod 48 | carved when under 8 (EASY), 6 (MEDIUM), 4 (HARD) or 3 (ULTIMATE) |
| Corner of a sign | `H("sign", x, y, cell)` u32 bit 31 | left, right |

Both boards on a shared wall read the same door key, and both tombs on a
shared tomb wall read the same crossing key, so door positions match across
every seam by construction. Doors stay out of corner cells, so two doors of
one board never share a cell.

## 3. Band maze

A tomb is W×H boards: 3×2 at EASY, 4×3 at MEDIUM and 6×4 at HARD (§1).
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
   half the tomb's boards: 3 at EASY, 6 at MEDIUM and 12 at HARD. When the
   entry board is `X` itself, the trunk is that one board and is exempt from
   the minimum.
3. **Tributaries.** For `j = 2 … k` in order, an `E_j` already in the tree
   needs nothing. Otherwise a randomized depth-first search on the same
   generator runs from `E_j` over boards outside the tree and ends on its
   first step onto a tree board; its stack, without that board, is the
   tributary. The unused boards around `E_j` always touch the tree, so a
   tributary never fails.
4. **Dead ends.** Repeatedly pick, uniformly, a board in the tree at depth
   below 2 with an unused neighbour, and attach that neighbour. Trunk and
   tributaries sit at depth 0. Stop when no candidate remains. Every dead-end
   branch is therefore at most `D = 2` boards deep.
5. **Rock.** Board positions left unused are solid rock.
6. **Flames.** Every `E_j` and `S` holds a flame at its flame cell, an `E_j`
   already on the trunk included. Number each route's boards from 0 at its
   entry: the trunk from `E_1` or `S`, a tributary from its `E_j`. Every
   route board whose index is a multiple of 3 holds a flame at its flame
   cell. Half the dead-end boards get a flame at their deepest cell. Then,
   for each entry in order, the generator walks that entry's chain: from its
   flame along the cell path through its route, the trunk from the
   confluence, and across the exit wall to the downstream tomb's entry board
   there, whose flame always burns. The chain holds the flames on those
   boards that the routes and earlier chains placed, in the order the walk
   reaches them. Any gap over 150 s of walking, at the §6 speeds, gets an
   extra flame at its midpoint cell, and this repeats until no gap exceeds
   150 s. A board's flames include every flame any tomb's chain places on it.

Every link in the band tree is a door, and a board holds a door on every tomb
wall it carries. A board has 1–4 doors, at most one per wall. On a trunk or
tributary board, the primary pair of §4 is the door toward its own route's
predecessor (the in-door on `E_j`, the flame cell on `S`) and the door toward
its successor (the exit door on `X`, the joined tree board on a tributary's
last board). When the two meet in one cell, on an `S` whose flame cell is the
door toward its successor, the second cell is the deepest cell from the
first, as on a dead-end board. §4 exempts branches that hold a door, so a
confluence board's extra door needs no rule of its own.

## 4. Board maze

Each attempt grows a spanning tree over a board's 12×7 grid with the
growing-tree algorithm, and the chosen tree is then carved down to 50 cells:

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
attempt's tree spans every cell. Boards average 4–10 galleries.

The board's primary door pair is its route entry and route exit, or, on a
dead-end board, its single door and its deepest cell. Each attempt must meet
two targets:

- The primary path covers at least 22 cells, with at least 6 junctions on it.
- Every branch leaving the primary path runs at least 3 cells, so its end
  sits outside torchlight at the junction.

The deficit of a tree is its shortfall in path cells, plus its shortfall in
junctions, plus, for each branch under 3 cells, the cells it lacks. A branch
holding a door is exempt. An attempt meets the targets at deficit 0.

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
- it removes at most (cells − 50) cells, where cells is the tree's current
  size; and
- the deficit afterwards, measured against `b`, is at most the deficit the
  chosen attempt had.

While the tree holds more than 50 cells, the carve lists the qualifying cuts
that remove no gallery link, or every qualifying cut when none is free of
one, in ascending cell order. It removes the cut at index `rng() % count`,
where `rng` is sfc32 of `H("carve", x, y)`. It stops at 50 cells or when no
cut qualifies. A cut leaves the path between protected cells whole, so every
flame lies on a carved cell and walking times between flames are unchanged.
The cells that remain form a tree, and the rest is rock: the game opens a
room only for a cell that holds a link or a door. Boards average about 51
carved cells and 5 galleries.

**Signs.** A sign junction is a cell of a route board (§3) on the tree path
from an in-cell to the out-door's cell `o`, `o` excepted, with three or more
ways out. A way out is a tree link or a door. The out-door is the door in the
board's route-exit direction, which leads toward the tomb's exit. The in-cells
are where routes enter: the cell of each door whose far board is a route board
leading back through it, which covers a route's predecessor, a tributary
merging here and the upstream tomb's exit board beyond an in-door, and the
flame cell of a source board `S`. These differ from the junctions above, which
count cells on the primary path with a tree link off it, `b` included and doors
not counted. Paths run from every in-cell, `o` has no sign because a sconce
already marks its door, and doors count as ways out. A route board holds 5.6
sign junctions on average at every level.

A sign junction carries a sign when `u32(H("sign", x, y, cell)) mod 48` is
under the level's threshold: 8 at EASY, 6 at MEDIUM, 4 at HARD and 3 at
ULTIMATE, about 1 junction in 6, 8, 12 and 16. The level selects the threshold
and enters no hash. A sign points along the tree link from its junction to the
next cell of its path toward `o`: one of the eight link directions,
galleries included. It names the link to take, not the distant door, and so
points the way on. Dead-end boards carry no sign, because the route does not
pass through them. Signs read the built board and enter no board, band or
digest.

Generation is lazy. The game holds the tombs within one of the explorer's in
both axes, and builds a board when it first comes within one board of the
camera.

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
- Every stored save keeps the difficulty of the run that wrote it; absent,
  it is HARD.
- RESUME plays the stored save at its own difficulty, and the title setting
  moves to match. A typed save code plays at the title setting.

Resuming lights the torch to full. Flames never run out, so the save carries
no pickup state. The game separately keeps the most tombs solved, as the
score, per seed and difficulty; HARD keeps the bare seed code as its key.

Browser storage holds the plane's values under keys of their own, so a
value from the stacked world that came before never reads as a position or
a score:

| Key | Holds |
|---|---|
| `infinite-maze.plane.save` | the save code |
| `infinite-maze.plane.save.difficulty` | the save's difficulty |
| `infinite-maze.plane.best` | the best per seed and difficulty |
| `infinite-maze.difficulty` | the title setting |

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
- **Light radius:** falls linearly with the remaining burn, from 96 px when
  full to 24 px at the last 10%. Flicker grows as the light shrinks.
- **Wall sconces:** every board has a lit sconce beside each door, with a
  64 px light radius. Entering a board lights the explorer and the doorway,
  and the rest of the board stays dark. Sconces give light only.
- **Flames:** a brazier burning turquoise relights the torch to full on touch
  and never runs out. §3 places them. A flame inside a route board can sit on
  a dead-end branch of that board's maze.

Every tomb entry holds a flame. No stretch of any entry's way on takes more
than 150 s to walk between flames, so a full torch covers the longest stretch
twice, and only real disorientation runs it dry.

When the burn reaches zero, the torch gutters to an 8 px ember for 10 s, and
reaching a flame in that time relights it. Otherwise the run ends. The end
screen shows the tombs solved, the time and the save code for the last tomb
entry reached, and Continue resumes there with a full torch.

## 8. Presentation

**Graphics.**
- Canvas 2D at a 320×180 internal resolution, with `imageSmoothingEnabled =
  false`. In keyboard mode the view scales up by the largest whole multiple of
  CSS pixels, centred.
- In touch mode (§9) the view fills the safe area at a fractional scale; the
  page background fills the letterbox. The canvas's backing store is in device
  pixels, so a game pixel spans ⌊s⌋ or ⌈s⌉ of them and the nearest-neighbour
  draw is the only resample. When the safe area's height less a full-width
  16:9 view leaves room for the d-pad and its margins, the view spans the
  width at the top and the controls fill the band below. Otherwise the view
  fits the safe area and the controls overlay it.
- 16×16 tiles. A cell is 3×3 tiles, so a board is 576×336 px.
- A palette of 32 colours: sandstone, ochre, lapis, turquoise, gold, torch
  orange and violet shadow.
- Sprites and tiles stored as palette-indexed strings in the source.

**Lighting.** A light map at quarter resolution, lit by the torch, the
sconces and the flames, composited multiplicatively over the scene. Hieroglyph walls scroll
behind at 0.5× for depth. Dust motes hang in the world, never with the explorer
or the camera, and show in torchlight: drawn inside the torch radius and
fading toward its edge.

**Stairs.** A stair draws as one solid flight, flush with the lower floor and
the upper floor, in air the mask already cuts. Where a gallery starts in a
cell, a ladder in that cell ends at the floor, and a bottom door's sconce
stands clear of the flight.

**Signs.** A sign is a carved arrow, at most 7×7 px, in one of eight glyphs,
one per link direction (E N W S NE NW SW SE). It sits in an upper corner of its
junction's room, in cell-local columns 8 to 15 or 32 to 39 (the hash picks
the corner) and rows 31 to 37, clear of the sconce flame, which ends at row 29.
Both corners of every sign junction hold room air and no ladder, stair, sconce
or flame pixel. The board art draws the sign after the mask's shading, so it
sits on the board layer at full brightness in front of the half-bright wall,
and the light map lights it as it lights the walls. Signs are a deliberate,
always-on exception to the rule that aids record and never point: they ship
with no setting.

**Score.** A tomb is solved when the explorer leaves it through its exit
door, and only if it lies on the run's way on: the run's start tomb, the tomb
its exit leads to, and so on along the generator's exits. A tomb off that way
on never counts, whatever door the explorer used, so an upstream basin cannot
be farmed. Each tomb counts once. Continue carries the run's start tomb and
its solved set, so the run keeps one way on; resuming a save or typing a code
starts a new run with its own start tomb. The HUD's `TOMB n`, the pause
header's `TOMB n`, the title's `BEST TOMB` and the end screen's `TOMBS
CLIMBED` show that count.

**Labels.** The title's panel holds a difficulty row naming EASY, MEDIUM and
HARD with the setting lit, and its save line names the save's difficulty. Its
best tomb is the shown seed's at the setting. The pause and end screens name
the run's difficulty after the save code. The pause map draws the run's tomb
at 3 px per cell, a frame of `W·36 × H·21` px: 108×42 at EASY, 144×63 at
MEDIUM and 216×84 at HARD.

**Camera.** Follows the explorer with a lerp and a deadzone, snapped to whole
pixels. It scrolls freely across board seams, and rock fills every position
outside the band trees.

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

**Sound.** Footsteps on stone, ladder creak, the whoosh of a relight and the
torch sputtering at low burn.

## 9. Runtime

The simulation runs on a fixed 60 Hz timestep, with rendering on
`requestAnimationFrame`. Building a board takes 0.7 ms on average and 17 ms
at most, and a tomb's board tree 0.04 ms on average and under 1 ms at most,
measured on node 26.7.0 and an Apple M3 Max.
Audio starts on the first key press or touch, as browser autoplay policy
requires.

Controls are the arrow keys or WASD for movement, Space or Z to jump, M to
mute and P to pause and show the save code. P returns the player to where
they were: from pause or the title it goes back to the game. Esc is the alias
for players outside full screen, where a browser keeps Esc for itself and a
real Esc press leaves full screen. The end screen takes Esc and Q to the
title and takes no P, so a pause press as the torch dies cannot skip the end
screen and its save code. The title and end screens ignore auto-repeated
Space presses, and the title ignores an auto-repeated P or Esc, so a held key
cannot skip a screen.

On the title, Enter begins the shown seed at tomb 0, R rolls a new seed and
keeps the save, and T opens code entry. L cycles the difficulty EASY, MEDIUM,
HARD and round again; Left and Right, or A and D, step it and stop at the
ends. A change rebuilds the title's world. P (or Esc) resumes:

- A title reached from pause by Q leaves the run open, and P returns to it
  unchanged: torch, time, trail and difficulty. The open run keeps its own
  seed and world, so R, a typed seed and the difficulty change only the
  title's world; Enter or a typed save code starts a new run.
- With no run open, as at startup, P rebuilds the stored save at its
  difficulty (§5). A rebuild never happens while a run is open, so a
  pause, title and resume cannot refill the torch.

C on the pause and end screens writes the save code shown to the clipboard.
On the title K copies the save code it shows, or the seed code when it shows
none; during code entry A, D, K, L and P type letters. Each screen then
reads COPIED, or COPY FAILED when the clipboard is absent or refuses. The copy
uses `navigator.clipboard.writeText`, which browsers allow from a key press
in a secure context, https and `file://` alike.

**Touch.** Touch mode is on at boot when the device reports a touch point or a
coarse pointer, or when the URL hash is `#touch`. A touch `pointerdown` turns
it on and a trusted keydown turns it off, so the page follows the last input
type. Every control dispatches the keyboard's own `keydown` and `keyup` events
on `window`, so the key handlers serve touch unchanged. The page never
scrolls, zooms or selects.
- **D-pad.** In play, a 4-way pad sits at the bottom left in overlay mode and
  in the band otherwise a quarter of the safe width in, never closer than the
  margin to the left edge. Its centre jumps on `pointerdown`. An arm
  holds its arrow key while a pointer is on it, a slide from arm to arm swaps
  the key, and a pointer that left the pad keeps mapping by angle until it
  lifts. The pad has no diagonals.
- **Soft keys.** Each is 44 px tall and acts on `click`:

  | Screen | Keys |
  |---|---|
  | title | RESUME (P, with a save or an open run), BEGIN (Enter), RESET (R), TYPE CODE, the difficulty (L, labelled with the setting), COPY (K), SOUND (M) |
  | title, typing | ACCEPT (Enter), CANCEL (Esc) |
  | play | PAUSE (P) |
  | pause | RESUME (P), COPY (C), SOUND (M), TITLE (Q) |
  | over | CONTINUE (Enter), COPY (C), TITLE (Q) |

  Each P key has Esc as its keyboard alias. CANCEL sends Esc, because P types
  a letter during code entry.
  TYPE CODE sends T, opens the browser's `prompt`, then sends each character
  of the answer as a key press and finally Enter, or Esc on cancel. The
  prompt takes a pasted save code.
- **Audio.** Any `pointerup` starts audio.

## 10. Acceptance

A headless test harness, run with `node`, checks the generator against the
same source the game uses, at every difficulty. It checks the window of tombs
`u ∈ [−10, 10]`, `v ∈ [−50, 50]`, 2,121 tombs, unless told otherwise. Each
check reads the tomb size from its world. Flow, Way up and Solvability's
tomb walk read the generator's exits, and every check reads a source tomb's
`S` from the generator. Everything else follows doors held on both sides,
never the generator's tomb graph, so a generator fault cannot vouch for
itself.

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
  so it runs once, at HARD. The harness reports, without judging them, the
  share of window tombs whose walk meets tomb `(0, 0)`'s within the cap and
  the largest and mean steps to meet.
- **Bounds:** every tomb's trunk covers at least half its boards, a
  one-board trunk aside, every dead-end branch is at most 2 boards deep, and
  every board meets the targets in §4 or records its best-attempt fallback.
  A run of at least 2,000 boards fails when more than 2% of them fall back; a
  shorter run reports the rate.
- **Galleries:** every gallery owns its 2×2 block, no two blocks share a
  cell, and galleries average 4–10 per board. The harness reports the mean
  and the block conflicts.
- **Carve:** every door cell and flame cell holds a link, every tree board
  carves at least 50 cells, and the mean stays within 48–56. A cell is carved
  when it holds a link, doors aside. The harness reports the mean.
- **Flames:** every tomb entry holds a flame, and along each entry's way on
  the walking time between consecutive chain flames stays at or under 150 s.
  The harness reports the maximum and the 99th percentile.
- **Solvability:** the harness follows the generator's exits from tomb
  `(0, −50)` until a tomb in row 50, leaving the window sideways if the walk
  does; a breadth-first search over carved cells and doors, confined to those
  tombs, reaches the last tomb's exit door from the first tomb's first entry.
- **Saves:** encoding and decoding round-trip for a sample of positions of
  both signs, and a board resumed at the world's difficulty is
  byte-identical to one generated in sequence.
- **Determinism:** a fixed seed code produces a fixed digest of tombs
  `u ∈ [−2, 2]`, `v ∈ [0, 19]`, v outer and u inner, at each difficulty: three
  pinned digests, each distinct.
