import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../src/game/audio.mjs';

/** A stand-in for the WebAudio graph nodes: every method and parameter is inert. */
function node(log) {
  log.nodes++;
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} });
  return {
    gain: param(), frequency: param(), detune: param(), Q: param(), curve: null, type: '', buffer: null,
    connect: (to) => to, disconnect() {}, start() {}, stop() {},
  };
}

/** Installs a fake `AudioContext` in `state`; `resume` answers with `resumed()`. */
function fakeContext(state, resumed = () => Promise.resolve()) {
  const log = { constructed: 0, resumes: 0, nodes: 0, closes: 0 };
  globalThis.AudioContext = class {
    constructor() {
      log.constructed++;
      this.state = state;
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = node(log);
    }
    resume() { log.resumes++; return resumed(); }
    close() { log.closes++; return Promise.resolve(); }
    createGain() { return node(log); }
    createBiquadFilter() { if (this.failAt === 'filter') throw new Error('no filter'); return node(log); }
    createWaveShaper() { return node(log); }
    createOscillator() { return node(log); }
    createBufferSource() { return node(log); }
    createBuffer(channels, length) { log.nodes++; return { getChannelData: () => new Float32Array(length) }; }
  };
  return log;
}

/** Runs `body` with a fresh audio, then stops its scheduler and removes the fake. */
async function withAudio(body) {
  const audio = createAudio();
  try {
    await body(audio);
  } finally {
    audio.stop();
    delete globalThis.AudioContext;
    delete globalThis.webkitAudioContext;
  }
}

test('createAudio builds one context before any key; start resumes it, once, and builds none', async () => {
  const log = fakeContext('suspended');
  await withAudio((audio) => {
    assert.equal(log.constructed, 1, 'built at creation');
    assert.equal(log.resumes, 0);
    audio.start();
    assert.equal(log.constructed, 1);
    assert.equal(log.resumes, 1);
    audio.start();
    assert.equal(log.constructed, 1);
  });
});

test('start resumes an interrupted context as it does a suspended one, and leaves a running one alone', async () => {
  for (const [state, resumes] of [['interrupted', 1], ['suspended', 1], ['running', 0]]) {
    const log = fakeContext(state);
    await withAudio((audio) => {
      audio.start();
      assert.equal(log.resumes, resumes, state);
    });
  }
});

test('a resume that rejects raises nothing', async () => {
  fakeContext('suspended', () => Promise.reject(new Error('refused')));
  const stray = [];
  const note = (e) => stray.push(e);
  process.on('unhandledRejection', note);
  try {
    await withAudio(async (audio) => {
      audio.start();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    });
  } finally {
    process.off('unhandledRejection', note);
  }
  assert.deepEqual(stray, []);
});

test('play sounds nothing before the first start, a context left running included', async () => {
  const log = fakeContext('running');
  await withAudio((audio) => {
    const built = log.nodes;
    audio.play('step');
    audio.play('band');
    assert.equal(log.nodes, built, 'no node before start');
    audio.start();
    const started = log.nodes;
    audio.play('step');
    assert.ok(log.nodes > started, 'a node after start');
  });
});

test('with no AudioContext, or one whose constructor throws, every call is a no-op', async () => {
  const calls = (audio) => {
    audio.start();
    audio.play('step');
    audio.setIntensity(0.5);
    audio.relight();
    assert.equal(audio.toggleMute(), true);
    audio.start();
    audio.stop();
  };
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  await withAudio(calls);
  globalThis.AudioContext = class { constructor() { throw new Error('no audio'); } };
  await withAudio(calls);
  // A context whose graph cannot be built.
  globalThis.AudioContext = class { constructor() { this.state = 'suspended'; } };
  await withAudio(calls);
});

test('a graph that fails after createGain closes its context and leaves mute and every call silent', async () => {
  const log = fakeContext('suspended');
  const Real = globalThis.AudioContext;
  globalThis.AudioContext = class extends Real { constructor() { super(); this.failAt = 'filter'; } };
  await withAudio((audio) => {
    assert.ok(log.nodes > 0, 'the graph got as far as a gain');
    assert.equal(log.constructed, 1);
    assert.equal(log.closes, 1, 'the half-built context is closed');
    assert.doesNotThrow(() => audio.toggleMute());
    assert.equal(audio.muted, true);
    audio.start();
    audio.play('step');
    assert.equal(log.resumes, 0, 'no context left to resume');
  });
});
