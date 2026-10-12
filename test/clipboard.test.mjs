import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText, copyWithStatus, saveLabel } from '../src/game/clipboard.mjs';

test('copyText resolves true once the clipboard write resolves', async () => {
  const written = [];
  const clipboard = { writeText: async (text) => { written.push(text); } };
  assert.equal(await copyText(clipboard, 'K7Q2-M9XA:4813'), true);
  assert.deepEqual(written, ['K7Q2-M9XA:4813']);
});

test('copyText resolves false when the write rejects or the clipboard is missing', async () => {
  const refusing = { writeText: async () => { throw new Error('NotAllowedError'); } };
  assert.equal(await copyText(refusing, 'K7Q2-M9XA:4813'), false);
  assert.equal(await copyText(undefined, 'K7Q2-M9XA:4813'), false);
});

test('copyWithStatus shows COPIED on a write and COPY FAILED on a refusal or no clipboard', async () => {
  const shown = [];
  const show = (status) => shown.push(status);
  await copyWithStatus({ writeText: async () => {} }, 'K7Q2-M9XA:4813', show);
  await copyWithStatus({ writeText: async () => { throw new Error('NotAllowedError'); } }, 'K7Q2-M9XA:4813', show);
  await copyWithStatus(undefined, 'K7Q2-M9XA:4813', show);
  assert.deepEqual(shown, ['COPIED', 'COPY FAILED', 'COPY FAILED']);
});

// A clipboard whose write resolves, or rejects, when the test says.
function deferred() {
  const pending = [];
  return {
    writeText: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
    settle: (i = 0) => pending[i].resolve(),
    refuse: (i = 0) => pending[i].reject(new Error('NotAllowedError')),
  };
}

test('a copy that resolves after its screen visit ended shows nothing', async () => {
  const clipboard = deferred();
  const shown = [];
  let visit = 1;
  const done = copyWithStatus(clipboard, 'K7Q2-M9XA:4813', (status) => shown.push(status), () => visit === 1);
  visit = 2;
  clipboard.settle();
  await done;
  assert.deepEqual(shown, []);

  const refused = deferred();
  const late = copyWithStatus(refused, 'K7Q2-M9XA:4813', (status) => shown.push(status), () => visit === 1);
  refused.refuse();
  await late;
  assert.deepEqual(shown, [], 'a refusal after the visit ended shows nothing either');
});

test('a copy that resolves within its screen visit shows COPIED, or COPY FAILED on a refusal', async () => {
  const clipboard = deferred();
  const shown = [];
  const done = copyWithStatus(clipboard, 'K7Q2-M9XA:4813', (status) => shown.push(status), () => true);
  assert.deepEqual(shown, [], 'nothing shows before the write resolves');
  clipboard.settle();
  await done;
  assert.deepEqual(shown, ['COPIED']);

  const refused = deferred();
  const failed = copyWithStatus(refused, 'K7Q2-M9XA:4813', (status) => shown.push(status), () => true);
  refused.refuse();
  await failed;
  assert.deepEqual(shown, ['COPIED', 'COPY FAILED']);
});

test('the SAVE CODE label carries the copy status when there is one', () => {
  assert.equal(saveLabel(undefined), 'SAVE CODE');
  assert.equal(saveLabel(''), 'SAVE CODE');
  assert.equal(saveLabel('COPIED'), 'SAVE CODE  COPIED');
  // 6 px per glyph: the longest label fits the 220 px pause panel.
  assert.ok(saveLabel('COPY FAILED').length * 6 - 1 <= 200);
});
