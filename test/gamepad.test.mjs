import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGamepad, STICK_ON, STICK_OFF } from '../src/game/gamepad.mjs';

// A standard gamepad as a browser snapshots it: 17 buttons and 4 axes.
const pad = ({ mapping = 'standard', pressed = [], axes = [0, 0, 0, 0] } = {}) => ({
  mapping,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
  axes: [...axes],
});

// A reader whose list the test sets; every call builds fresh objects.
function rig() {
  const state = { pads: [] };
  const reader = createGamepad(() => state.pads.map((p) => p && pad(p)));
  return { state, poll: () => reader.poll().map((o) => `${o.type} ${o.code}`), reader };
}

const LEFT = 14, A = 0, B = 1, SELECT = 8, START = 9;

test('d-pad left and A send ArrowLeft and Space as edges, with no repeat', () => {
  const { state, poll } = rig();
  state.pads = [{ pressed: [LEFT, A] }];
  assert.deepEqual(poll(), ['keydown ArrowLeft', 'keydown Space']);
  assert.deepEqual(poll(), []);
  state.pads = [{}];
  assert.deepEqual(poll(), ['keyup ArrowLeft', 'keyup Space']);
  assert.deepEqual(poll(), []);
});

test('each button sends its key and key value', () => {
  const sent = (button) => {
    const { state, reader } = rig();
    state.pads = [{ pressed: [button] }];
    return reader.poll();
  };
  const want = {
    12: ['ArrowUp', 'ArrowUp'], 13: ['ArrowDown', 'ArrowDown'], 14: ['ArrowLeft', 'ArrowLeft'], 15: ['ArrowRight', 'ArrowRight'],
    [A]: ['Space', ' '], [B]: ['Enter', 'Enter'], [START]: ['KeyP', 'p'], [SELECT]: ['KeyQ', 'q'],
  };
  for (const [button, [code, key]] of Object.entries(want)) {
    assert.deepEqual(sent(Number(button)), [{ type: 'keydown', code, key }], `button ${button}`);
  }
  for (const other of [2, 3, 4, 5, 6, 7, 10, 11, 16]) assert.deepEqual(sent(other), [], `button ${other}`);
});

test('the stick holds an arrow from STICK_ON until back inside STICK_OFF', () => {
  assert.equal(STICK_ON, 0.5);
  assert.equal(STICK_OFF, 0.4);
  const { state, poll } = rig();
  const axes = (x, y = 0) => { state.pads = [{ axes: [x, y, 0, 0] }]; return poll(); };
  assert.deepEqual(axes(-0.45), []);
  assert.deepEqual(axes(-0.6), ['keydown ArrowLeft']);
  assert.deepEqual(axes(-0.45), []);
  assert.deepEqual(axes(-0.3), ['keyup ArrowLeft']);
  assert.deepEqual(axes(-0.45), []);
  assert.deepEqual(axes(-0.5), ['keydown ArrowLeft']);
  assert.deepEqual(axes(0.5), ['keyup ArrowLeft', 'keydown ArrowRight']);
  assert.deepEqual(axes(0.45, -0.5), ['keydown ArrowUp']);
  assert.deepEqual(axes(0, 0.5), ['keyup ArrowRight', 'keyup ArrowUp', 'keydown ArrowDown']);
  assert.deepEqual(axes(0, 0), ['keyup ArrowDown']);
});

test('a diagonal push holds two arrows', () => {
  const { state, poll } = rig();
  state.pads = [{ axes: [0.7, -0.7, 0, 0] }];
  assert.deepEqual(poll(), ['keydown ArrowRight', 'keydown ArrowUp']);
  state.pads = [{}];
  assert.deepEqual(poll(), ['keyup ArrowRight', 'keyup ArrowUp']);
});

test('a slide releases before it presses, and keyups come before keydowns', () => {
  const { state, poll } = rig();
  state.pads = [{ pressed: [LEFT, START] }];
  poll();
  state.pads = [{ pressed: [15, B] }];
  assert.deepEqual(poll(), ['keyup ArrowLeft', 'keyup KeyP', 'keydown ArrowRight', 'keydown Enter']);
});

test('sources merge: a key goes up when its last source lets go', () => {
  const { state, poll } = rig();
  state.pads = [{ pressed: [LEFT], axes: [-0.9, 0, 0, 0] }];
  assert.deepEqual(poll(), ['keydown ArrowLeft']);
  state.pads = [{ axes: [-0.9, 0, 0, 0] }];
  assert.deepEqual(poll(), []);
  state.pads = [{ pressed: [LEFT] }];
  assert.deepEqual(poll(), []);
  state.pads = [{}];
  assert.deepEqual(poll(), ['keyup ArrowLeft']);

  state.pads = [{ pressed: [A] }, { pressed: [A] }];
  assert.deepEqual(poll(), ['keydown Space']);
  state.pads = [{}, { pressed: [A] }];
  assert.deepEqual(poll(), []);
  state.pads = [{}, {}];
  assert.deepEqual(poll(), ['keyup Space']);
});

test('a gamepad that vanishes releases its keys, and one that stays keeps its own', () => {
  const { state, poll } = rig();
  state.pads = [{ pressed: [LEFT, A] }];
  poll();
  state.pads = [];
  assert.deepEqual(poll(), ['keyup ArrowLeft', 'keyup Space']);
  state.pads = [{ pressed: [A] }, { pressed: [A, B] }];
  assert.deepEqual(poll(), ['keydown Space', 'keydown Enter']);
  state.pads = [null, { pressed: [A, B] }];
  assert.deepEqual(poll(), []);
  state.pads = [null, null];
  assert.deepEqual(poll(), ['keyup Space', 'keyup Enter']);
});

test('a gamepad is its index, so fresh snapshot objects keep the stick\'s hysteresis', () => {
  const { state, poll } = rig();
  state.pads = [{ axes: [-0.6, 0, 0, 0] }];
  assert.deepEqual(poll(), ['keydown ArrowLeft']);
  state.pads = [{ axes: [-0.45, 0, 0, 0] }];
  for (let i = 0; i < 3; i++) assert.deepEqual(poll(), []);
});

test('the stick keeps its arrow at exactly STICK_OFF and lets go just inside it', () => {
  const { state, poll } = rig();
  state.pads = [{ axes: [-0.6, 0, 0, 0] }];
  assert.deepEqual(poll(), ['keydown ArrowLeft']);
  state.pads = [{ axes: [-STICK_OFF, 0, 0, 0] }];
  assert.deepEqual(poll(), []);
  state.pads = [{ axes: [-0.39, 0, 0, 0] }];
  assert.deepEqual(poll(), ['keyup ArrowLeft']);
});

test('other mappings, null entries, a missing reader and a throwing reader send nothing', () => {
  const { state, poll } = rig();
  state.pads = [{ mapping: '', pressed: [LEFT, A, B, START, SELECT], axes: [1, 1, 0, 0] }, null,
    { mapping: 'xr-standard', pressed: [A] }];
  assert.deepEqual(poll(), []);
  assert.deepEqual(createGamepad(undefined).poll(), []);
  assert.deepEqual(createGamepad(() => { throw new Error('detached'); }).poll(), []);
  assert.deepEqual(createGamepad(() => null).poll(), []);
});

test('a reader that starts throwing releases what the gamepads held', () => {
  let live = true;
  const reader = createGamepad(() => {
    if (!live) throw new Error('gone');
    return [pad({ pressed: [A] })];
  });
  assert.deepEqual(reader.poll().map((o) => o.type), ['keydown']);
  live = false;
  assert.deepEqual(reader.poll().map((o) => `${o.type} ${o.code}`), ['keyup Space']);
});

test('runLoop\'s frame polls the gamepads before it ticks', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const frame = src.match(/function runLoop\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(frame, 'runLoop found');
  const body = frame[0].slice(frame[0].indexOf('function frame(now) {'));
  const poll = body.indexOf('pollGamepads()'), ticks = body.indexOf('tick(g)');
  assert.ok(poll >= 0 && ticks >= 0 && poll < ticks, 'frame calls pollGamepads() before tick(g)');
});
