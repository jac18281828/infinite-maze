import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build, OUT } from '../tools/build.mjs';

test('the build inlines every game and world module into one script', () => {
  const html = build();
  for (const dir of ['src/world', 'src/game']) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (f.endsWith('.mjs')) assert.ok(html.includes(`// ${dir}/${f}\n`), `${dir}/${f} is inlined`);
    }
  }
  assert.doesNotMatch(html, /^\s*(import|export)\s/m);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.doesNotMatch(html, /(src|href)=["']?https?:|fetch\(|XMLHttpRequest|WebSocket/i);
});

test('the build is deterministic and matches the committed file', () => {
  assert.equal(build(), build());
  assert.equal(readFileSync(OUT, 'utf8'), build());
});
