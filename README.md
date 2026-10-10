# Infinite Maze

An endless tomb maze, explored by torchlight. One seed code grows a world of
bands that tile the plane. Every band is a 6x4 grid of boards and every board
a 12x7 grid of cells, of which a board carves about 60% and leaves the rest
rock. The route runs through nested blocks: a block is a 3x3 grid of smaller
blocks, down to single bands, and the route crosses each block once along a
random path through its children. It turns up, down, left and right in equal
measure, never loops and runs on without end both ways; bands off it are rock.
`docs/SPEC.md` is the full specification, and `docs/ROUTE.md` amends it with
the nested route.

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
- **Esc** pauses and shows the save code; **C** there copies it. **M** mutes.
- **Touch.** On a phone the view fills the screen. A d-pad moves: its arms
  run, climb and descend, and its centre jumps. Soft keys cover every screen:
  BEGIN, NEW ROLL, TYPE CODE (a prompt that takes a pasted save code),
  CONTINUE, COPY, SOUND, PAUSE, RESUME and TITLE. Pressing a key switches back to
  the keyboard layout; `#touch` on the URL forces touch on a desktop.
- The torch burns for 300 s, and its light shrinks as it burns. Touch a
  turquoise brazier to relight it. At zero it gutters to an ember for 10 s;
  reach a flame in that time or the run ends.
- Every band entry holds a flame, and no stretch of the route runs more than
  150 s between flames.

The title screen shows the seed code. **Enter** begins at the entry of the
start band, (0, 0). **R** rolls a new world. **T** takes a typed seed or save
code. **C** continues the last save. **K** copies the save code shown, or the
seed code. The end screen's **C** copies its save code. The game keeps that
save and the best score per seed in `localStorage` and runs without them where
storage is blocked.

The score is the farthest ring reached: band `(u, v)` lies on ring
`max(|u|, |v|)`. The HUD's TOMB, the title's BEST TOMB and the end screen's
TOMBS CLIMBED show it.

## Save codes

A save is the seed code and one integer: `K7Q2-M9XA:4813`. The integer pairs
the coordinates of board `(x, y)`: with `z(n) = 2n` for `n >= 0` and
`-2n - 1` otherwise, `a = z(x)` and `b = z(y)`, it is `a^2 + a + b` when
`a >= b` and `a + b^2` otherwise. It is never negative, and a save holds
`|x|` and `|y|` below 2^25. Resuming regenerates that board from the seed and
lights the torch to full. The explorer stands at the board's door back toward
its band entry; a rock board resumes at its band's entry, and a board in a
rock band at the start band's entry. The end screen offers the code of the
last band entry reached; Continue resumes there.

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

`AGENTS.md` defines `WT` and `CHROME`. The acceptance harness walks the route
from band (0, 0) through its doors and checks route indices -1000 to 1000
(`--bands N` checks -N to N). It checks the balance of moves over route bands
0 to 10,000 and start chain levels 1 to 20. It prints the fallback-board
count, the largest and 99th percentile flame gaps, the balance shares, the
highest start chain level the route needed and its run time.
`infinite-maze.html#selftest` boots seed `0000-0000` and drives 3600 ticks of
scripted input along the start band's flame chain. A second leg resumes on
the first route band off columns 0 to 5 and fails unless the frame draws the
explorer's board as maze rather than rock. It then sets `data-selftest` on
`<body>`.

## Deploy

Every push to main deploys. `.github/workflows/ci-cd.yml` runs the gates,
then, for `main` only, deploys `StackMaze2adCom`, uploads `infinite-maze.html`
as `index.html` and invalidates CloudFront. Pull requests run the gates alone,
with no AWS credentials. The game is served at https://maze.2ad.com from a
private S3 bucket behind CloudFront. `cdk/` defines the bucket, certificate,
distribution and DNS records in the shared `2ad.com` zone, which the stack
imports read-only.

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
aws s3 cp infinite-maze.html s3://maze-us-east-1-504242000181/index.html \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"
aws cloudfront create-invalidation --paths "/*" \
  --distribution-id "$(aws cloudformation describe-stacks --stack-name StackMaze2adCom \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)"
```
