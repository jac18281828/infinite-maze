# Agents

`docs/SPEC.md` is the contract. Source lives in ES modules under `src/`;
`infinite-maze.html` is built from them and committed. Edit the modules, then
rebuild; never edit the HTML by hand.

## Gates

Run from the repository root, where `WT` is that root's absolute path and
`CHROME` is the Chrome binary:

```sh
WT="$(pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Every gate passes before a change lands. The same gates run in
`.github/workflows/ci-cd.yml`.

```sh
node tools/build.mjs --check
node --test test/
node tools/acceptance.mjs
"$CHROME" --headless=new --disable-gpu --virtual-time-budget=30000 \
  --dump-dom "file://$WT/infinite-maze.html#selftest" | grep -q 'data-selftest="pass"'
! grep -Eiq '(src|href)=["'\'']?https?:|fetch\(|XMLHttpRequest|WebSocket' infinite-maze.html
```

`node --test test/` runs `test/index.js`, which loads every `*.test.mjs`.
Node 26, the version tested, resolves a directory argument as a module path
and does not search it.

## Layout

- `src/world/`: the generator. Pure: no DOM, integer arithmetic only, so node
  and the browser build the same worlds.
- `src/game/`: simulation (`sim.mjs`, DOM-free), rendering, audio, the
  touch layer (`touch.mjs`: layout, d-pad and soft keys, emitting keyboard
  events), the self-test autopilot and the entry module `main.mjs`.
- `tools/build.mjs`: the bundler. It accepts `import { a, b as c } from
  './x.mjs';` and `export` before `function`, `class`, `const` or `let`, and
  rejects any other module syntax.
- `tools/acceptance.mjs`: the spec section 10 harness. Each check is an
  exported function over a world, so tests can feed it broken ones.

## Rules

- No npm dependencies and no network access, at build or run time. The one
  exception is `cdk/`, the infrastructure for maze.2ad.com: its dependencies
  are in `package.json` and never reach the game build or `infinite-maze.html`.
- Changing generation changes the three pinned digests, one per difficulty,
  of tombs `u ∈ [−2, 2]`, `v ∈ [0, 19]` in `test/world.test.mjs` and
  `tools/acceptance.mjs`; update both on purpose.
