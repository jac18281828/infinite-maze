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

test('the SAVE CODE label carries the copy status when there is one', () => {
  assert.equal(saveLabel(undefined), 'SAVE CODE');
  assert.equal(saveLabel(''), 'SAVE CODE');
  assert.equal(saveLabel('COPIED'), 'SAVE CODE  COPIED');
  // 6 px per glyph: the longest label fits the 220 px pause panel.
  assert.ok(saveLabel('COPY FAILED').length * 6 - 1 <= 200);
});
