import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../src/game/clipboard.mjs';

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
