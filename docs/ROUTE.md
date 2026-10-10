# Infinite Maze — nested route

The route runs through nested blocks: bands, 3×3 blocks of bands, 3×3 blocks
of those, and so on without end. Each block is a bounding volume the route
enters once and leaves once. Inside it, the route takes a random path through
nine children, and that small path is the whole loop check for that scale.
The hierarchy lives in the coordinates, so the generator stores no history,
and a position still resumes from one integer.

The route moves up, down, left and right in equal measure at every scale. It
never revisits a band, and it can never trap itself.

This document amends `docs/SPEC.md`. §8 lists the sections it replaces; every
other section stands.

## 1. Why the route needs structure

An endless route that never returns must move away from its start. Stacked
bands make "away" mean up. Nested blocks make it mean every direction. Two
sequential designs fail, measured on a prototype with regions of 2–4 bands a
side:

| Design | Result |
|---|---|
| Each region placed outside the bounding box of all history | Locks to one or two directions. Over 600 walks of 2,000 regions, the last 500 regions used one direction in 386 walks and two in 214. |
| Each region placed clear of every earlier region (exact BVH) | Traps itself, at region 70 in the median walk. |
| Exact BVH with outward bias e³ | Still traps: 9% of walks within 20,000 regions. |

The bounding box locks because a new region can leave only through a wall of
the last region that lies on the box's face, and at a corner that leaves two
walls for good. The exact BVH traps because a walk that remembers everything
can still close a pocket around itself; bias delays the trap and never
removes it. Both also tie region `n` to the history before it, so walking
back past a save needs a box that cannot be un-merged.

Nested blocks fix the volumes in advance. The route never asks where it has
been, only which block it is in.

## 2. Coordinates

Board coordinates are `(x, y) ∈ ℤ²`, with y increasing upward. A band is a
6×4 grid of boards, and band coordinates are `(u, v) = (⌊x / 6⌋, ⌊y / 4⌋)`.
Band `(0, 0)` holds the start.

| Symbol | Value | Meaning |
|---|---|---|
| `G` | 3 | children per block side |
| `S_k` | `3^(k−1)` | bands per side of a level-`k` block |
| `o_k` | `−(S_k − 1) / 2` | origin offset of the level-`k` grid |

A level-1 block is one band. Block `(k, i, j)` covers bands
`u ∈ [i·S_k + o_k, (i+1)·S_k + o_k)` and the same range in `v` for `j`.
`o_k − o_{k−1} = −S_{k−1}`, so every level's grid aligns with the one below.
The children of `(k, i, j)` are `(k−1, 3i−1+a, 3j−1+b)` for `a, b ∈ {0, 1, 2}`,
and child `(a, b)` sits at grid position `(a, b)` within its parent.

The start chain is the blocks `(k, 0, 0)`. Each one is the centre child of
the next, so the world grows outward from the start in every direction.

## 3. Doors between blocks

The route crosses between two sibling level-`k` blocks through one band pair
on their shared wall. The wall's hash picks the pair:

| Wall | Source | Offset |
|---|---|---|
| Between `(k, i, j)` and `(k, i+1, j)` | `H("vwall", k, i, j)` u32 mod `S_k` | band row `j·S_k + o_k + t` |
| Between `(k, i, j)` and `(k, i, j+1)` | `H("hwall", k, i, j)` u32 mod `S_k` | band column `i·S_k + o_k + t` |

A crossing between two bands lands on a board pair chosen by the band wall's
own hash:

| Wall | Source | Offset |
|---|---|---|
| Between bands `(u, v)` and `(u+1, v)` | `H("bandv", u, v)` u32 mod 4 | board row `4v + t` |
| Between bands `(u, v)` and `(u, v+1)` | `H("bandh", u, v)` u32 mod 6 | board column `6u + t` |

The board door's cell then comes from SPEC §2's `hdoor` and `vdoor` keys.
Each crossing belongs to exactly one level, the level of the two siblings it
joins, so no two hashes ever compete for the same door. Both sides of every
wall read the same key, so doors match across every seam at every scale.

## 4. Route through a block

A block's route comes in through one wall at an entry band and leaves through
a different wall at an exit band. Its parent, or the start chain, fixes both.

1. **Children.** The entry child holds the entry band, and the exit child
   holds the exit band.
2. **Path.** If they are the same child, the path is that child alone.
   Otherwise, enumerate every simple path from the entry child to the exit
   child over the 3×3 grid, in depth-first order with neighbours tried L, R,
   D, U. Keep the paths of at least `min(5, longest)` children, and take
   the one at index `H("route", k, i, j)` u32 mod their count.
3. **Crossings.** Consecutive children on the path cross through the door on
   their shared wall (§3). Each child's entry is the previous crossing, or
   the block's entry, and its exit is the next crossing, or the block's exit.
4. **Rock.** Children off the path are solid rock, along with everything they
   contain.

A child on the path enters from its predecessor and leaves toward its
successor. They are distinct cells, so its entry and exit walls differ, and
the rule above applies to it unchanged. At level 1 the child is a band, and
SPEC §3 builds its board maze with these changes:

- The entry board is the board behind the entry crossing, on the entry wall.
  The exit board is the board behind the exit crossing, on the exit wall.
- When one corner board holds both, the route is that board alone. Dead
  ends keep SPEC §3's two-board depth, and the rest of the band is rock.

## 5. The start chain

The start chain gives the route both of its infinite ends. Every block
`(k, 0, 0)` carries an entry wall `E_k` and an exit wall `X_k`, with
`E_k ≠ X_k`.

- **Level 1.** `H("start", 1)` picks `E_1` from the four walls, u32 mod 4,
  and `X_1` from the remaining three, bytes 4–7 mod 3.
- **Level `k ≥ 2`.** The centre child is the level `k−1` start block. The
  route must reach its `E_{k−1}` neighbour `n_in`, cross the centre, and
  leave from its `X_{k−1}` neighbour `n_out`. Shuffle the 12 ordered wall
  pairs with sfc32 of `H("start", k)`. For each pair `(E, X)` in turn, the
  doors on walls `E` and `X` give the entry child `a` and the exit child `b`.
  Enumerate every pair of disjoint simple paths `P1: a → n_in` and
  `P2: n_out → b` that avoid the centre, in the depth-first order of §4 with
  `P1` outermost. The first wall pair with any such pair wins. Each pair
  gives the block path `P1 ‖ centre ‖ P2`. Keep the block paths of at least
  `min(5, longest)` children, and take the one at index `H("start", k)` bytes
  4–7 mod their count.

The start chain depends only on the seed. The generator builds it once, up to
the highest level a position needs, and caches it. Saves reach level 17 at
most (§8). The generator refuses levels above 20, a margin of three levels
over that limit; `S_22` would outgrow the u32 door offsets.

Route index 0 is the start band. Following exits counts up, and following
entries counts down; both directions are endless.

## 6. Locating a position

A position is rock or route by its ancestry, and finding that ancestry takes
one small path per level:

1. **Climb.** Find the smallest `K` with `|u|, |v| ≤ (S_K − 1) / 2`. Block
   `(K, 0, 0)` holds the band.
2. **Descend.** Build the route of the level-`K` block, find the child
   holding the band and take that child's entry and exit. Repeat down to
   level 1. A child off its parent's path makes the band rock.
3. **Band.** Build the band's board maze from its entry and exit.

A band a million bands from the start needs `K = 15`. Each level enumerates
paths on a 3×3 grid, so locating a band costs microseconds before the band
maze.

## 7. Loops

The route is a simple path at every scale, by induction on level:

- **Level 1.** A band's route is a simple path of boards (SPEC §3).
- **Level `k`.** The block's route is a simple path of distinct children.
  Each child's route is simple by hypothesis and confined to the child, and
  children are disjoint. Consecutive children share one crossing. The
  concatenation therefore visits no band twice.

Dead ends stay inside their band, at most two boards deep, and every board is
a cell tree joined by single doors. SPEC §1's tree-of-trees argument holds
unchanged: one path between any two cells, no loops, and an unbroken route in
both directions.

A prototype of §2–§5, keyed by the repo's `H`, agrees. Over seeds
`00000000`, `K7Q2M9XA`, `000001D5`, `ZZZZZZZZ` and `12345678`, the level-9
start block, 6561×6561 bands, carries a route of 1.39–2.78 million bands,
with no repeat and every step to an adjacent band. Each direction takes
24.8–25.3% of moves. Block paths average 6.2 children, so a route
grows about sixfold per level. The route runs straight for 1.41 bands on
average and 5 at most. Drift away from the start is slow: 30–87 bands after
1,000 bands of route, and 727–989 after 100,000. For seed `0000-0000` the
figures are 1,861,285 bands, 34 and 749.

## 8. Changes to SPEC.md

| SPEC section | Change |
|---|---|
| §1 | Bands tile the plane, `x ∈ ℤ`, and the band tree joins bands through the nested route instead of stacking upward. |
| §2 | `H("edge", b)` and `H("band", b, k)` give way to §3's wall keys, `H("route", …)`, `H("start", …)` and `H("band", u, v, k)` for the band maze. |
| §3 | A band's entry and exit come from §4. The flame-gap rule crosses into whichever band comes next on the route. |
| §5 | The save packs two signed integers (below). The hero appears at the board's door that leads back toward its band's entry. |
| §7 | The end screen shows the farthest ring reached, `max(|u|, |v|)`, in place of bands climbed. |
| §10 | The checks run over the route from index −1000 to 1000, and §9 below adds its own. |

**Save.** With `z(n) = 2n` for `n ≥ 0` and `−2n − 1` otherwise, and
`a = z(x)`, `b = z(y)`:

```
p = a ≥ b ? a² + a + b : a + b²
```

`p` stays an exact JavaScript integer for `|x|, |y| < 2²⁵`, about 5.59
million bands from the start horizontally and 8.39 million vertically. The save string keeps its form, `K7Q2-M9XA:4813`, and
decoding inverts the pairing and runs §6.

## 9. Acceptance

The harness adds these checks, each an exported function over a world:

- **Simple route:** route indices −1000 to 1000 visit no band twice, and each
  step moves to an adjacent band.
- **Walls:** every band on the route enters and leaves through different
  walls.
- **Start chain:** levels 1–20 each find a wall pair and a path.
- **Locate:** for a sample of route bands, §6 from the coordinates alone
  returns the same entry and exit as following the route.
- **Balance:** over the route from index 0 to 10,000, each direction carries
  between 20% and 30% of moves.

Fault injection adds three broken worlds, each of which its check must
reject: a block path that visits a child twice, a door offset that differs on
two sides of one block wall, and a start block placed off centre.
