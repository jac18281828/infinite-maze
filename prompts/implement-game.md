---
dispatch: project-implementer — builds the whole game from docs/SPEC.md and
  commits it, signed, on a local agent/ branch; no remote exists, so it pushes
  nothing and opens nothing
model: opus # the run composes pixel art, lighting and music to a quality bar
  and proves a generator correct over 48k boards; both exceed sonnet's taste
  and stamina at this size
effort: xhigh
machine: the owner's workstation (git signing key, node ≥ 22 and Google Chrome
  present)
scope: implement Infinite Maze per docs/SPEC.md as one standalone HTML file
  built from tested ES modules, with the §10 acceptance harness and a
  headless-browser self-test
---

# Writing Style

Heed the wisdom of Strunk and White: "Omit needless words."

In all written text, avoid a succession of loose sentences,
hedging with negation and expository speech.

# Implement Infinite Maze

## 1. Introduction

`docs/SPEC.md` specifies Infinite Maze, an endless SHA3-seeded tomb maze. It
has two scales, boards inside bands, with no loops and an unbroken route
upward, torch-and-flame pacing and a one-integer save. The repo holds only the
spec. This run builds the game.

**Goal:** the game is done when `infinite-maze.html` opens from disk and
plays as the spec describes, every §7 gate passes on the branch tip, and the
§8 fault-injection tests prove the acceptance checks catch a broken world.

**In scope:** everything under `$WT` that is new. That means `src/`, `test/`,
`tools/`, `infinite-maze.html`, `README.md` and `AGENTS.md`.

**Out of scope:** `docs/SPEC.md` is read-only. Where the spec proves wrong or
silent beyond the settled decisions below, choose, record the choice under
Departures and continue. Edits to `prompts/` are also out of scope.

**Authority:**
- No npm dependencies, no `package.json` scripts beyond `"type": "module"`
  and no network access, at build or at run time.
- No CI.

**Settled decisions:**
- **Source, build and output.** Source lives in ES modules under `src/`.
  `tools/build.mjs` inlines them into one committed `infinite-maze.html`. The
  spec demands one standalone file, and §10 demands a harness that runs the
  game's own generator in node. Committing the built file lets the owner play
  with a double-click.
- **The generator is pure.** `src/world/` imports nothing from the DOM, so
  node and the browser run the same bytes.
- **SHA3 is embedded.** `src/world/keccak.mjs` is a pure-JS Keccak-f[1600]
  exporting `sha3_256(bytes: Uint8Array): Uint8Array`. WebCrypto is async and
  lacks SHA-3 on mainstream engines. Node's `crypto` serves only as the test
  oracle.
- **Integer generation.** Generation uses integer arithmetic only (sfc32, u32
  mod), so a seed code builds identical worlds in every engine.
- **Branches ending at a door.** Spec §4's rule that every branch leaving the
  primary path runs at least 3 cells applies to dead-end branches only. A
  branch that ends at another door is exempt.
- **"Deepest cell"** means the cell farthest from the board's single door by
  tree path. Ties go to the lowest cell index `y·12 + x`.
- **Flame gaps.** The walking time between two flames is the time along the
  unique tree path between their cells, at the spec §6 speeds: one cell of
  run, gallery or ladder costs its link length divided by its speed. A gap's
  midpoint cell is the cell on that path at half the walking time.
- **The rendered maze admits exactly the cell tree's links.** No opening,
  gallery mouth or ladder may imply a link the tree lacks. How tiles realise
  a gallery through its 2×2 block is a construction choice; this invariant is
  the contract.
- **The game starts at band 0's entry**, at board `(e_0, 0)`, coming through
  its floor door. The title screen shows the seed code and offers a new roll
  or typed code entry.
- **Storage.** The last save code and the best band reached persist in
  `localStorage`, with every access wrapped in try/catch so the game runs
  without storage.
- **The save string** is `CODE4-CODE4:p`, for example `K7Q2-M9XA:4813`, and
  `p` may be negative.

## 2. Orientation

```
repo:       ~/sandbox/infinite_maze   (local only, no remote)
base:       main — tip SHA recorded at preflight; docs/SPEC.md sha256
            03630f2fe5d489f227e819bcbf716e12c73c9da622f648ac4b1de275492eb35d
toolchain:  node ≥ 22 (with sha3-256 in crypto.getHashes()), git, gpg
browser:    /Applications/Google Chrome.app (headless self-test gate)
signing:    key FD311EE84C8321C3E93C1E639028C4309ACCEB9B, every commit --gpg-sign
```

## 3. Localization

```sh
REPO="$HOME/sandbox/infinite_maze"
WT_ROOT="$HOME/sandbox/infinite_maze-wt"
WT="$WT_ROOT/implement-game"
BRANCH=agent/implement-game
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Work only in `$WT`. Leave the primary checkout at `$REPO` untouched.

## 4. Preflight

Each check passes or STOPs, and the run reports which one failed.

**Environment:**
1. `node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 && require("crypto").getHashes().includes("sha3-256") ? 0 : 1)'`
2. `gpg --list-secret-keys FD311EE84C8321C3E93C1E639028C4309ACCEB9B`
3. `test -x "$CHROME"`

**Repo:**

4. `git -C "$REPO" rev-parse --verify main` succeeds. Record the SHA as
   `BASE`.
5. `git -C "$REPO" show main:docs/SPEC.md | shasum -a 256` matches §2.
6. Branch `$BRANCH` and directory `$WT` are both absent.

## 5. Table setting

```sh
mkdir -p "$WT_ROOT"
git -C "$REPO" worktree add -b "$BRANCH" "$WT" "$BASE"
```

Cleanup removes only what this run started: any headless Chrome process it
launched, by its own PID, and any temp directory it created. Cleanup runs on
every exit path. The worktree and branch stay for review.

## 6. Implementation

When you refer to this prompt, or hand it to anyone, refer to it by
reference (a file pointer), never by copying its contents or context.

You cannot start subagents. Do every step yourself. Where a step reads as
fan-out, do it serially and record the substitution under Departures.

Deliver what was asked, at the scope intended. Make routine judgment calls
yourself, and check in only when different readings of the request would lead
to materially different work. If the request seems mistaken or a better
approach exists, say so in a sentence and continue with the task as asked
rather than quietly narrowing, widening, or transforming it. Finish the whole
task, and stop short of actions that are clearly beyond what was asked.

Read `docs/SPEC.md` in full before writing code. It is the contract for every
number below.

### Phase A — generator, harness and tests

1. **`src/world/keccak.mjs`.** Implement SHA3-256 per the settled decision.
2. **`src/world/`.** Implement spec §2–§5 as pure modules:
   - The world key and `H`, with fixed-width int64 big-endian encoding.
   - sfc32.
   - The band maze, including flames and gap splitting.
   - The board maze, including targets, rerolls and the 64-reroll fallback.
   - Door keys.
   - Save encode and decode.

   Module and function names below `src/world/` are yours to choose.
3. **`tools/acceptance.mjs`.** Implement every spec §10 check. It exits
   non-zero on any failure and prints a summary covering:
   - the bands checked;
   - the number of boards on their best-attempt fallback;
   - the maximum and 99th-percentile flame gap in seconds;
   - the run time.

   Build each check as an exported function over a world, so §8 can feed it
   a broken one.
4. **`test/*.test.mjs`.** Write the tests with `node:test`; §8 sets the bar.
5. **Commit Phase A**, then write the Phase A STATUS note.

### Phase B — the game

6. **`src/game/`.** Implement spec §6–§9:
   - Canvas rendering at 320×180, integer-scaled.
   - Sprites and tiles as palette-indexed strings.
   - The quarter-resolution light map lit by the torch, sconces and flames.
   - Parallax and dust.
   - The camera.
   - The explorer's animations.
   - Movement at the spec speeds.
   - The torch, ember and run-end flow, with Continue.
   - Esc to pause and show the save code, and M to mute.
   - Music and sound synthesized in WebAudio, starting on the first key
     press.

   The quality bar is a polished 16-bit game. Lighting, palette and music
   carry it.
7. **Self-test.** Opening `infinite-maze.html#selftest` boots seed code
   `0000-0000` and drives the simulation step directly, not through
   `requestAnimationFrame`, for 3600 ticks of scripted input. The input must:
   - run the explorer along a corridor;
   - climb at least one ladder;
   - cross at least one board seam;
   - touch at least one flame.

   It then renders a frame and checks that the canvas holds more than one
   colour. It also captures `window.onerror` and unhandled rejections.
   Finally it sets `data-selftest="pass"` on `<body>`, or `"fail: <reason>"`.
8. **`tools/build.mjs`.** It writes `infinite-maze.html`, one file with
   every module inlined and no external reference. With `--check`, it exits
   non-zero when the file on disk differs from a fresh build.
9. **Docs.** Two new files:
   - `README.md`: what the game is, how to play, the save code, how to
     build, and the gate list.
   - `AGENTS.md`: the §7 gate commands verbatim, so future prompts can cite
     them.

   `docs/SPEC.md` gets no edit; spec departures go under Departures.

   Comments, README and REPORT follow the house voice. Write plain, active,
   specific sentences without qualifiers or throat-clearing, and lead with
   the claim. A comment carries an invariant or documents an anomaly. Commits
   carry evidence.
10. **Commit Phase B**, run §7, and write the final REPORT.

**Commits.**
- Use conventional commits, for example `feat(world): band and board maze
  generator with acceptance harness`.
- Sign every commit with `--gpg-sign`.
- Add no attribution trailers: no `Co-Authored-By` and no "Generated with".

**Landing.** There is no remote, so nothing is pushed. The branch stays local
for review and gets no merge. Implementation complete is not task complete:
the branch now waits for review.

## 7. Gates

From `$WT`, in order:

```sh
node tools/build.mjs --check
node --test test/
node tools/acceptance.mjs
"$CHROME" --headless=new --disable-gpu --virtual-time-budget=30000 \
  --dump-dom "file://$WT/infinite-maze.html#selftest" | grep -q 'data-selftest="pass"'
! grep -Eiq '(src|href)=["'\'']?https?:|fetch\(|XMLHttpRequest|WebSocket' infinite-maze.html
```

The work is not complete until every gate passes on the final commit. If a
gate is still red after a genuine fix attempt, STOP and report the actual
error. Do not keep iterating on guesses.

Also capture a screenshot for the reviewer:

```sh
"$CHROME" --headless=new --screenshot="$WT_ROOT/implement-game.png" \
  --window-size=1280,720 --virtual-time-budget=5000 "file://$WT/infinite-maze.html"
```

## 8. Proof

The tests use `node:test`, are hermetic and need no network. Each one fails
when the behaviour it guards breaks:

- **Keccak.**
  - SHA3-256 of `""` is
    `a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a`.
  - SHA3-256 of `"abc"` is
    `3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532`.
  - `sha3_256` matches node's `crypto` `sha3-256` on 1,000 random inputs
    from 0 to 400 bytes, which crosses the 136-byte rate boundary.
- **Fault injection.** Each §10 check function rejects a world broken on
  purpose:
  - a door moved on one side of its wall;
  - an extra link that closes a loop;
  - a second door between bands;
  - a dead-end branch 3 boards deep;
  - a flame removed so that a gap exceeds 150 s.

  A check that accepts its broken world is vacuous.
- **Saves.** Saves round-trip, negative `p` included, and a board resumed
  from `p` equals the same board generated in sequence.
- **Determinism.** Seed code `0000-0000` yields a pinned digest over bands
  0–99, recorded in the test.

## 9. Status

Write a STATUS note after preflight, after Phase A's commit, after Phase B's
commit and after the gates. Each note gives what passed, what is next and any
departure so far.

Before each tool call, say in one sentence what you are about to do. While
working, give a brief update when you finish something important or change
direction. When you finish, lead with the outcome — what happened, or what
you found.

## 10. Reporting

The repo keeps no tracker. The record is the REPORT in your final reply,
together with the branch's commit log. The REPORT contains, in this order:

1. **Departures:** each place the run departed from this prompt or from
   `docs/SPEC.md`. Give what the prompt or spec said, what you did and the
   evidence. Write `none` if there were none.
2. **Branch:** the branch and its tip SHA, `BASE`, and the commit list.
3. **Gates:** each §7 command with its result, plus the acceptance summary
   lines.
4. **Proof:** the test names that cover each §8 bullet.
5. **Screenshot:** the screenshot path.
6. **Stage:** the last line reads: "Implementation complete; branch awaits
   review — not merged."
