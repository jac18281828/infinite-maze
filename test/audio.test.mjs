import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAudio } from '../src/game/audio.mjs';

const RUN_S = 0.025;
const clock = (j) => j * RUN_S;

// Pins of the steady music trace (intensity 0 and 1) as BASE's scheduler
// builds it over 10 s of 25 ms runs.
const STEADY = {
  0: '02b6c758356167c57620cb85a427c0fd455766844e735d99c15bea9fe06bb1be',
  1: '49f1594fce560f4c197242352454a2b4e3119a8f28aa80ec13fd83b8267930ea',
};

function param() {
  const p = { value: 0 };
  for (const m of ['setValueAtTime', 'exponentialRampToValueAtTime', 'linearRampToValueAtTime', 'setTargetAtTime']) p[m] = () => p;
  return p;
}

/** A fake AudioContext recording each node created and the time each source starts. */
function fakeContext(log) {
  return class FakeContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 1000;
      this.state = 'running';
      this.destination = { kind: 'destination' };
      log.ac = this;
    }
    resume() {}
    #node(kind, extra = {}) {
      const node = {
        kind, startTime: null, ...extra,
        connect: (to) => to, disconnect() {},
        start: (t) => { node.startTime = t; },
        stop() {},
      };
      log.nodes.push(node);
      return node;
    }
    createGain() { return this.#node('gain', { gain: param() }); }
    createBiquadFilter() { return this.#node('filter', { frequency: param(), Q: param(), detune: param() }); }
    createWaveShaper() { return this.#node('shaper'); }
    createOscillator() { return this.#node('osc', { frequency: param(), detune: param() }); }
    createBufferSource() { return this.#node('source'); }
    createBuffer(n, len) { return { getChannelData: () => new Float32Array(len) }; }
  };
}

/** Runs `body` with a fake AudioContext and a captured scheduler; restores the globals. */
function withAudio(body) {
  const saved = { AudioContext: globalThis.AudioContext, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  try {
    return body(() => {
      const log = { nodes: [], ac: null, callback: null };
      globalThis.AudioContext = fakeContext(log);
      globalThis.setInterval = (fn) => { log.callback = fn; return 1; };
      globalThis.clearInterval = () => {};
      const audio = createAudio();
      audio.start();
      log.nodes.length = 0;
      /** Runs the scheduler with the clock at `t`; returns the nodes it created. */
      const run = (t) => {
        log.ac.currentTime = t;
        const before = log.nodes.length;
        log.callback();
        return log.nodes.slice(before);
      };
      return { audio, run, log };
    });
  } finally {
    Object.assign(globalThis, saved);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete globalThis[k];
  }
}

/** Started nodes as kind@start; the buffer offset is random and stays out. */
const starts = (nodes) => nodes.filter((n) => n.startTime !== null).map((n) => `${n.kind}@${n.startTime}`);
const trace = (runs) => createHash('sha3-256').update(runs.map((nodes) => `${nodes.length}:${starts(nodes).join(',')}`).join('\n')).digest('hex');

for (const intensity of [0, 1]) {
  test(`steady music matches BASE's trace at intensity ${intensity}`, () => {
    withAudio((make) => {
      const { audio, run } = make();
      audio.setIntensity(intensity);
      const runs = [];
      for (let j = 1; j <= 400; j++) runs.push(run(clock(j)));
      assert.ok(runs.some((nodes) => nodes.length > 0));
      assert.equal(trace(runs), STEADY[intensity]);
    });
  });
}

test('a muted scheduler builds no node and keeps time, so unmuting drops in mid-tune', () => {
  withAudio((make) => {
    const a = make(), b = make();
    for (const r of [a, b]) r.audio.setIntensity(0.5);
    let j = 1;
    for (; j <= 80; j++) { a.run(clock(j)); b.run(clock(j)); }
    a.audio.toggleMute();
    let built = 0;
    for (; j <= 160; j++) { built += a.run(clock(j)).length; b.run(clock(j)); }
    assert.equal(built, 0, 'nodes built while muted');
    a.audio.toggleMute();
    let compared = 0;
    for (; j <= 320; j++) {
      const want = starts(b.run(clock(j)));
      assert.deepEqual(starts(a.run(clock(j))), want, `run ${j}`);
      compared += want.length;
    }
    assert.ok(compared > 20, 'music plays after unmuting');
  });
});

for (const [gap, label] of [[1, '1 s'], [60, '60 s']]) {
  test(`after a ${label} stall the scheduler skips the missed notes and resumes on the wall clock`, () => {
    withAudio((make) => {
      for (const intensity of [0, 1]) {
        const a = make(), b = make();
        for (const r of [a, b]) r.audio.setIntensity(intensity);
        const jumpFrom = 400, jumpTo = jumpFrom + gap / RUN_S, end = jumpTo + 120;
        for (let j = 1; j <= jumpFrom; j++) { a.run(clock(j)); b.run(clock(j)); }
        const aNodes = [], bNodes = [];
        for (let j = jumpFrom + 1; j <= end; j++) bNodes.push(...b.run(clock(j)));
        const first = a.run(clock(jumpTo));
        aNodes.push(...first);
        assert.ok(first.length <= 40, `${first.length} nodes in the first run`);
        for (const n of first) if (n.startTime !== null) assert.ok(n.startTime >= clock(jumpTo), 'a built node starts before the clock');
        let firstMusic = first.length > 0 ? clock(jumpTo) : null;
        for (let j = jumpTo + 1; j <= end; j++) {
          const made = a.run(clock(j));
          if (firstMusic === null && made.length > 0) firstMusic = clock(j);
          aNodes.push(...made);
        }
        assert.ok(firstMusic !== null && firstMusic - clock(jumpTo) <= 0.2 + 1e-9, 'music resumes within 0.2 s');
        if (intensity === 0) {
          const after = (nodes) => starts(nodes.filter((n) => n.startTime !== null && n.startTime >= clock(jumpTo)));
          assert.deepEqual(after(aNodes), after(bNodes));
        }
      }
    });
  });
}
