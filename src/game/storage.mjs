// Guarded storage over a backend the caller supplies. `area()` returns the
// `getItem`, `setItem` and `removeItem` object, and runs inside each guard,
// because reaching `localStorage` itself throws when storage is blocked.
// DOM-free, so node tests it with a fake.

/** `load`, `store` and `unstore` over `area`, and `failed()`, true while the latest `store` did not land. */
export function createStorage(area) {
  let failed = false;
  return {
    /** The stored text, or null when absent or storage is unavailable. */
    load(key) {
      try { return area().getItem(key); } catch { return null; }
    },
    /** Writes `value`; true when it landed. Every call counts, whatever its key. */
    store(key, value) {
      try {
        area().setItem(key, value);
        failed = false;
      } catch {
        failed = true;
      }
      return !failed;
    },
    unstore(key) {
      try { area().removeItem(key); } catch { /* storage unavailable */ }
    },
    failed: () => failed,
  };
}
