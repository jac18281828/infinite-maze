# Infinite Maze

An endless tomb maze, climbed by torchlight. One seed code grows a world of
bands stacked without end. Every band is a 6x4 grid of boards and every board
a 12x7 grid of cells. The maze has no loops at any scale, and one route always
leads up. `docs/SPEC.md` is the full specification.

## Play

Open `infinite-maze.html` in a browser. It is one file with no network access
and no assets.

- **Arrows or WASD** move. Left and right run the corridors. Up or down takes
  the cell's ladder or gallery stair from anywhere on its floor; holding the
  side away from a stair keeps the explorer on the floor. A stair is also
  taken by running into it, and an Up or Down tapped just before a cell counts
  on arrival.
- **Space or Z** jumps. In the air, Up grabs the ladder overhead or the stair
  below, and a jump onto a stair lands on it.
- **Esc** pauses and shows the save code. **M** mutes.
- The torch burns for 300 s, and its light shrinks as it burns. Touch a
  turquoise brazier to relight it. At zero it gutters to an ember for 10 s;
  reach a flame in that time or the run ends.
- Every band entry holds a flame, and no stretch of the route runs more than
  150 s between flames.

The title screen shows the seed code. **Enter** begins at band 0. **R** rolls
a new world. **T** takes a typed seed or save code. **C** continues the last
save. The game keeps that save and the best band per seed in `localStorage`
and runs without them where storage is blocked.

## Save codes

A save is the seed code and one integer: `K7Q2-M9XA:4813`. The integer is
`p = 6y + x` for board `(x, y)`, and it may be negative below band 0.
Resuming regenerates that board from the seed and lights the torch to full.
The explorer stands at the board's door back toward its band entry. The end
screen offers the code of the last band entry reached; Continue resumes there.

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

`AGENTS.md` defines `WT` and `CHROME`. The acceptance harness checks bands
-1000 to 1000 and prints the fallback-board count, the largest and 99th
percentile flame gaps and its run time. `infinite-maze.html#selftest` boots
seed `0000-0000` and drives 3600 ticks of scripted input. It then sets
`data-selftest` on `<body>`.

## Deploy

The game is served at https://maze.2ad.com from a private S3 bucket behind
CloudFront. `cdk/` defines the bucket, certificate, distribution and DNS
records in the shared `2ad.com` zone, which the stack imports read-only.

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
