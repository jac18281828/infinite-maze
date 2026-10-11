import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbe } from '../src/game/perf.mjs';

test('intervals land in 2 ms bins, 40 ms and over in the last', () => {
  const p = createProbe();
  const want = [[1.99, 0], [2.0, 1], [16.7, 8], [39.99, 19], [40, 20], [250, 20]];
  for (const [ms] of want) p.frame(ms, 1, 1);
  const { bins, frames } = p.summary();
  assert.equal(frames, want.length);
  assert.equal(bins.length, 21);
  for (const [ms, bin] of want) {
    const one = createProbe();
    one.frame(ms, 1, 1);
    const at = one.summary().bins;
    assert.equal(at[bin], 1, `${ms} ms lands in bin ${bin}`);
    assert.equal(at.reduce((a, b) => a + b, 0), 1);
  }
  assert.deepEqual(bins.map((n, i) => [i, n]).filter(([, n]) => n), [[0, 1], [1, 1], [8, 1], [19, 1], [20, 2]]);
});

test('frames of 0, 1, 2, 3 and 15 ticks count as 1, 1, 1 and 2', () => {
  const p = createProbe();
  for (const n of [0, 1, 2, 3, 15]) p.frame(16.7, n, 1);
  assert.deepEqual(p.summary().ticks, [1, 1, 1, 2]);
});

test('draw mean and maximum match the recorded times, to 0.01 ms', () => {
  const p = createProbe();
  assert.deepEqual([p.summary().drawMeanMs, p.summary().drawMaxMs], [0, 0]);
  for (const ms of [1.234, 5.678, 2]) p.frame(16.7, 1, ms);
  const s = p.summary();
  assert.equal(s.drawMeanMs, 2.97);
  assert.equal(s.drawMaxMs, 5.68);
});
