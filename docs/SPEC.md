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
- **Band:** a 6×4 grid of boards. Bands stack upward without end.

Board coordinates are integers `(x, y)` with `x ∈ [0, 6)` and `y ∈ ℤ`, where y
increases upward. Board `(x, y)` belongs to band `b = ⌊y / 4⌋`. Band 0 holds
the start, and negative bands exist, so retreating downward is endless too.

Within a band, the boards form a tree with one route from a door in the band's
floor to a door in its ceiling. Dead-end branches hang off that route, and
board positions on neither are solid rock. Consecutive bands share exactly one
door. Every board's cells form a tree that connects all of that board's doors.
A tree of trees, joined by single doors, is a tree. That gives three
properties, at every depth:

- A unique path between any two cells.
- No loops.
- An unbroken route upward.

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
| Band edge column `e_b`: column of the door between bands `b−1` and `b` | `H("edge", b)` u32 mod 6 | `[0, 6)` |
| Band maze | sfc32 of `H("band", b, k)`, k = reroll | — |
| Side door between `(x,y)` and `(x+1,y)` | `H("hdoor", x, y)` u32 mod 5 + 1 | cell row `[1, 5]` |
| Floor door between `(x,y)` and `(x,y+1)` | `H("vdoor", x, y)` u32 mod 10 + 1 | cell column `[1, 10]` |
| Board cell maze | sfc32 of `H("board", x, y, k)`, k = reroll | — |
| Flame in a dead-end board | `H("flame", x, y)` byte 0 < 128 | 50% |
| Flame cell | `H("flame", x, y)` u32 at bytes 4–7 mod 84 | any of the 84 cells |

Both boards on a shared wall read the same door key, so door positions match
across every seam by construction. Doors stay out of corner cells, so two
doors of one board never share a cell.

## 3. Band maze

Band `b` spans board rows `4b … 4b+3`. Its entry is board `(e_b, 4b)`, through
the floor. Its exit is board `(e_{b+1}, 4b+3)`, through the ceiling.

1. **Route.** Run a randomized depth-first search over the 6×4 boards from
   entry to exit. The search stack on arrival is the route. Reroll `k` until
   the route covers at least 12 boards.
2. **Dead ends.** Repeatedly pick, uniformly, a board in the tree at depth
   below 2 with an unused neighbour, and attach that neighbour. The route sits
   at depth 0. Stop when no candidate remains. Every dead-end branch is
   therefore at most `D = 2` boards deep.
3. **Rock.** Board positions left unused are solid rock.
4. **Flames.** Number the route boards from 0 at the band entry. Every route
   board whose index is a multiple of 3 gets a flame at its flame cell, so
   every band entry holds one. Half the dead-end boards get a flame at their
   deepest cell. Then the generator measures the walking time, at the §6
   speeds, along the cell path between consecutive route flames, crossing
   into the next band's entry board where needed. Any gap over 150 s gets an
   extra flame at its midpoint cell, and this repeats until no gap exceeds
   150 s.

Every link in the band tree is a door. A board has 1–4 doors, at most one per
wall. A route board's doors never share a wall, because the route never
reverses.

## 4. Board maze

A board's cells form a spanning tree over its 12×7 grid. It is built with the
growing-tree algorithm:

- Pick the newest active cell with probability 0.6, otherwise a random
  active cell.
- Choose neighbours by weight: horizontal 4, vertical 1, diagonal 1.

A horizontal link is a corridor, a vertical link is a ladder and a diagonal
link is a 45° gallery. A diagonal is refused when the diagonal crossing it in
the same 2×2 block is already carved. Corridors and ladders alone connect the
grid, so the tree always spans every cell.

The board's primary door pair is its route entry and route exit, or, on a
dead-end board, its single door and its deepest cell. Reroll `k` until both
targets hold:

- The primary path covers at least 22 cells, with at least 6 junctions on it.
- Every branch leaving the primary path runs at least 3 cells, so its end
  sits outside torchlight at the junction.

After 64 rerolls, the board takes the attempt that best meets the targets.
The cap bounds generation time, and the band and board seeds stay fixed, so
the chosen attempt is deterministic too.

Generation is lazy. The game holds the current band and its neighbours, and
builds a board when it first comes within one board of the camera.

## 5. Save code

A position is one integer, `p = 6y + x`. The full save is the seed code plus
`p`, written `K7Q2-M9XA:4813`. Resuming computes `y = ⌊p / 6⌋` and
`x = p mod 6`, then regenerates that band and board directly from `H`. No
replay is needed. The hero appears at the board's door that leads back toward
the band entry. Any band entry is a valid start, a million bands up included.

Resuming lights the torch to full. Flames never run out, so the save carries
no pickup state. The game separately keeps the deepest band reached, as the
score.

## 6. Movement

The explorer can run left and right along corridors, climb ladders up and
down, and walk galleries up and down at 45°. The game has no jump and no fall:
floors are solid everywhere except at ladder shafts and gallery mouths. A drop
would be a one-way link, which could open a second route or trap the explorer.
Doors are openings in a board's wall at the door cell. Crossing one scrolls
seamlessly into the neighbouring board.

Movement speeds are 96 px/s running, 72 px/s on a gallery and 48 px/s on a
ladder.

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

Every band entry holds a flame. No stretch of the route takes more than 150 s
to walk between flames, so a full torch covers the longest stretch twice, and
only real disorientation runs it dry.

When the burn reaches zero, the torch gutters to an 8 px ember for 10 s, and
reaching a flame in that time relights it. Otherwise the run ends. The end
screen shows the bands climbed, the time and the save code for the last band
entry reached, and Continue resumes there with a full torch.

## 8. Presentation

**Graphics.**
- Canvas 2D at a 320×180 internal resolution, scaled up by the largest whole
  multiple, with `imageSmoothingEnabled = false`.
- 16×16 tiles. A cell is 3×3 tiles, so a board is 576×336 px.
- A palette of 32 colours: sandstone, ochre, lapis, turquoise, gold, torch
  orange and violet shadow.
- Sprites and tiles stored as palette-indexed strings in the source.

**Lighting.** A light map at quarter resolution, lit by the torch, the
sconces and the flames, composited multiplicatively over the scene. Hieroglyph walls scroll
behind at 0.5× for depth, and dust motes drift in the torch beam.

**Camera.** Follows the explorer with a lerp and a deadzone, snapped to whole
pixels. It scrolls freely across board seams, and rock fills every position
outside the band tree.

**Explorer.** A khaki-clad figure in a fedora, carrying a torch, with these
animations:

| Animation | Frames |
|---|---|
| Idle | 4 |
| Run | 8 |
| Climb | 4 |
| Gallery walk | 8 |
| Ember gasp | 2 |

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
`requestAnimationFrame`. Building a board takes under 1 ms, and a band under
0.1 ms. Audio starts on the first key press, as browser autoplay policy
requires.

Controls are the arrow keys or WASD for movement, M to mute and Esc to pause
and show the save code.

## 10. Acceptance

A headless test harness, run with `node`, checks the generator against the
same source the game uses:

- **Keccak:** SHA3-256 matches the FIPS 202 test vectors.
- **Continuity:** over bands −1000 to 1000, every door matches in position on
  both sides of its wall.
- **Tree:** over the same range, the graph of all cells and doors is
  connected and has edges = nodes − 1 for each band. Exactly one door joins
  consecutive bands.
- **Bounds:** every dead-end branch is at most 2 boards deep, and every board
  meets the targets in §4 or records its best-attempt fallback.
- **Flames:** every band entry holds a flame, and the walking time between
  consecutive route flames stays at or under 150 s. The harness reports the
  maximum and the 99th percentile.
- **Solvability:** a breadth-first search from band −1000's entry reaches band
  1000's exit.
- **Saves:** encoding and decoding round-trip for a sample of positions, and
  a resumed board is byte-identical to one generated in sequence.
- **Determinism:** a fixed seed code produces a fixed digest of bands 0–99.
