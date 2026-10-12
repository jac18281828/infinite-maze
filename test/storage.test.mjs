import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/game/storage.mjs';

// A map-backed area whose writes can be made to throw.
function area() {
  const items = new Map();
  const a = {
    refuse: false,
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => {
      if (a.refuse) throw new DOMException('QuotaExceededError');
      items.set(k, String(v));
    },
    removeItem: (k) => { items.delete(k); },
  };
  return a;
}

// Blocked storage: reaching the area throws, as `localStorage` does.
const blocked = () => { throw new DOMException('SecurityError'); };

test('a landed write reports true, reads back and leaves the saves-off state clear', () => {
  const a = area();
  const s = createStorage(() => a);
  assert.equal(s.store('k', 7), true);
  assert.equal(s.load('k'), '7');
  assert.equal(s.failed(), false);
});

test('a backend whose setItem throws fails the write and holds the saves-off state', () => {
  const a = area();
  const s = createStorage(() => a);
  a.refuse = true;
  assert.equal(s.store('k', 'v'), false);
  assert.equal(s.failed(), true);
  assert.equal(s.store('other', 'v'), false);
  assert.equal(s.failed(), true);
  assert.equal(s.load('k'), null, 'a regression pin: a refused write reads as absent');
});

test('a backend whose very access throws fails the write and holds the saves-off state', () => {
  const s = createStorage(blocked);
  assert.equal(s.store('k', 'v'), false);
  assert.equal(s.failed(), true);
  assert.equal(s.load('k'), null, 'a regression pin: blocked storage reads as empty');
  assert.doesNotThrow(() => s.unstore('k'));
});

test('a later landed write clears the saves-off state, whatever its key', () => {
  const a = area();
  const s = createStorage(() => a);
  a.refuse = true;
  s.store('k', 'v');
  assert.equal(s.failed(), true);
  a.refuse = false;
  assert.equal(s.store('another', 'v'), true);
  assert.equal(s.failed(), false);
  a.refuse = true;
  s.store('k', 'v');
  assert.equal(s.failed(), true);
});

test('unstore is not a write: it neither sets nor clears the saves-off state', () => {
  const a = area();
  const s = createStorage(() => a);
  s.unstore('k');
  assert.equal(s.failed(), false);
  a.refuse = true;
  s.store('k', 'v');
  s.unstore('k');
  assert.equal(s.failed(), true);
  const b = createStorage(blocked);
  b.unstore('k');
  assert.equal(b.failed(), false);
});
