# Infinite Maze

An endless tomb maze, climbed by torchlight. One seed code grows a plane of
tombs without end in any direction. The difficulty picked on the title sets a
tomb's size: EASY 3x2 boards, MEDIUM 4x3 and HARD 6x4. Every board is a 12x7
grid of cells, of which a board carves about 60% and leaves the rest rock.
Each tomb leaves up, left or right, never down, so the way on wanders sideways
as it climbs, and the maze has no loops at any scale. Every difficulty is the
same open plane: the tombs and their doors are the same at every level, and
only the boards inside a tomb differ.
`docs/SPEC.md` is the full specification.

## Play

Open `infinite-maze.html` in a browser. It is one file with no network access
and no assets.

- **Arrows or WASD** move. Left and right run the corridors. Up or down takes
  the cell's ladder or gallery stair from anywhere on its floor; holding the
  side away from a stair keeps the explorer on the floor. A stair is also
  taken by running into it, and an Up or Down tapped just before a cell counts
  on arrival. On a ladder, a Left or Right press climbs off at its nearer end.
- **Space or Z** jumps. In the air, Up grabs the ladder overhead or the stair
  below, and a jump onto a stair lands on it. On a ladder, a jump lets go and
  drops to the floor below; a held Up grabs again once pressed anew.
- **P** pauses and shows the tombs solved, the map of the passages walked
  and the save code; P resumes. Esc does the same outside full screen, where
  a browser keeps Esc for itself. The arrows (or WASD) pan the map one tomb
  per press. **C** there copies the save code. **M** mutes.
- **Touch.** On a phone the view fills the screen. A d-pad moves: its arms
  run, climb and descend, and its centre jumps. Soft keys cover every screen:
  RESUME, BEGIN, RESET, TYPE CODE (a prompt that takes a pasted save code),
  the difficulty, COPY, SOUND, PAUSE, CONTINUE, HOME and TITLE. Pressing a key
  switches back to the keyboard layout; `#touch` on the URL forces touch on a
  desktop. The pause map shows the explorer's tomb; panning needs a keyboard.
- The torch burns for 300 s, and its light shrinks as it burns. Touch a
  turquoise brazier to relight it. At zero it gutters to an ember for 10 s;
  reach a flame in that time or the run ends. Oil jars lie on dead ends,
  about one in ten at EASY, one in fourteen at MEDIUM and one in twenty at HARD
  (a coin takes a cell first, so 9.8%, 7.1% and 4.9% measured); touch one to
  add 60 s of burn, up to a full torch, or to relight an ember. They return on
  every new run.
- Some junctions on a route carry a carved arrow in the upper corner of the
  room, pointing along the link toward the way on; they are always on and
  about 1 in 6 at EASY, 1 in 8 at MEDIUM and 1 in 12 at HARD.
- Every tomb entry holds a flame, and no stretch of a way on runs more than
  150 s between flames.
- Coins lie on the floors of dead ends, about one dead end in twenty. Touch one
  to take it. Each tomb the run solves past its best on that seed and level
  pays 1 coin at EASY, 2 at MEDIUM and 5 at HARD, and a replay pays only past
  its best. The wallet shows under `TOMB n`; the end screen shows the coins
  earned this run. The game keeps the wallet, one per device, and the coins
  taken and payout record, per seed and level, in `localStorage`. Nothing buys
  with coins yet.
- Every 100 tombs a splash names an adventure rank and pays 100 × k coins once
  per seed and level; **Enter** or CONTINUE plays on, and **Q** or HOME goes to
  the title with the run open.
- The score counts tombs solved: a tomb is solved when the explorer leaves it
  through its exit door, if it lies on the way on from the run's start tomb:
  that tomb, the tomb its exit leads to, and so on. A tomb off that way on
  never counts. Each tomb counts once, and Continue keeps the count and the
  start tomb.

The title screen shows the seed code. **Enter** begins at tomb (0, 0)'s
first entry. **R** rolls a new world. **T** takes a typed seed or save code.
**L** cycles the difficulty, and Left and Right step it. **P** resumes the run
left by pause, or the last save at its own difficulty. Esc is its alias
outside full screen. **K** copies the save code shown, or the seed code. The
end screen's **C** copies its save code. The game keeps that save with its
difficulty, the setting and the most tombs solved per seed and difficulty in
`localStorage`, and runs without them where storage is blocked.

## Save codes

A save is the seed code and one integer: `K7Q2-M9XA:4813`. The integer pairs
the signed coordinates of board `(x, y)`: with `z(n) = 2n` for `n >= 0`, else
`-2n - 1`, `a = z(x)` and `b = z(y)`, `p = a >= b ? a*a + a + b : a + b*b`.
Saves hold `|x|` and `|y|` below 2^25, and a code runs to 26 characters. A
typed save code plays at the title's difficulty.
Resuming regenerates that board from the seed and lights the torch to full.
The explorer stands at the start of the board's way back along its route.
The end screen offers the code of the last tomb entry reached; Continue
resumes there.

## Build

```sh
node tools/build.mjs           # writes infinite-maze.html from src/
node tools/build.mjs --check   # fails when infinite-maze.html is stale
```

Tested with node 26. No dependencies.

## Gates

```sh
node tools/build.mjs --check
node --test test/
node tools/acceptance.mjs
"$CHROME" --headless=new --disable-gpu --virtual-time-budget=30000 \
  --dump-dom "file://$WT/infinite-maze.html#selftest" | grep -q 'data-selftest="pass"'
! grep -Eiq '(src|href)=["'\'']?https?:|fetch\(|XMLHttpRequest|WebSocket' infinite-maze.html
```

`AGENTS.md` defines `WT` and `CHROME`. The acceptance harness checks tombs
`u` -10 to 10 by `v` -50 to 50 (`--cols` and `--rows` set the half-widths) at
each difficulty and prints, per difficulty, the fallback-board count, the
largest and 99th percentile flame gaps and the shares of up, left and right
exits with the mean sideways run. Way up, run once at HARD, checks that every
tomb's way on climbs out of the window within 100,000 steps and reports how
many ways on meet tomb (0, 0)'s. The harness ends with its run time.
`infinite-maze.html#selftest` boots seed `0000-0000`, drives 3600 ticks of
scripted input and draws the pause map. A second leg resumes at MEDIUM in
tomb (1, 0), outside board columns 0-3, and fails unless the explorer's room
draws as maze rather than rock. The self-test then sets `data-selftest` on
`<body>`.

## Deploy

Every push to main deploys. `.github/workflows/ci-cd.yml` runs the gates,
then, for `main` only, deploys `StackMaze2adCom`, uploads `infinite-maze.html`
as `index.html` with `aws s3 sync --delete`, so the bucket holds the release
alone, and invalidates CloudFront. Pull requests run the gates alone,
with no AWS credentials. The game is served at https://maze.2ad.com from a
private S3 bucket behind CloudFront. `cdk/` defines the bucket, certificate,
distribution and DNS records in the shared `2ad.com` zone, which the stack
imports read-only.

A trial build for a phone play-test goes to `beta/<name>.html` in the bucket
and is served at `https://maze.2ad.com/beta/<name>.html` until the next deploy
removes it. It shares the live game's origin, and with it the wallet, saves and
records in local storage. Copy it uncached, so a re-copy under the same name
serves at once:

```sh
aws s3 cp trial.html s3://maze-us-east-1-504242000181/beta/<name>.html \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"
```

The workflow signs in through OIDC as `GithubDeployCI`. One-time setup outside
this repo: the role must trust
`repo:jac18281828@11556011/infinite-maze@1413247652:ref:refs/heads/main` and
carry an `AllowMazeDeploymentS3` policy like its `AllowSolitareDeploymentS3`.

### By hand

```sh
export AWS_PROFILE=awsapproach
bun install --frozen-lockfile
bun run test
bun run cdk:deploy -- StackMaze2adCom --require-approval never
site="$(mktemp -d)" && cp infinite-maze.html "$site/index.html" &&
  aws s3 sync "$site/" s3://maze-us-east-1-504242000181/ --delete \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"
aws cloudfront create-invalidation --paths "/*" \
  --distribution-id "$(aws cloudformation describe-stacks --stack-name StackMaze2adCom \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)"
```
