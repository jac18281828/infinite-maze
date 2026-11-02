// The frame guard. One frame's exception never stops the loop: the next frame
// is requested whatever the frame's work does. DOM-free, so node drives it
// with a fake request.

/** The ERROR line: the run's save code, or its seed while the run holds none. */
export function errorLine(serial, seed) {
  return serial ? `ERROR  SAVE CODE ${serial}` : `ERROR  SEED ${seed}`;
}

/**
 * Guards the frame loop and keeps its tick accumulator. `request(next)` asks
 * for the next frame, `screen()` names the screen shown, `step` is the tick in
 * seconds and `start` the clock's first reading in ms. After a failure `shown()`
 * holds until the screen changes or `release()` runs.
 */
export function createGuard({ request, screen, step, start, log = (e) => console.error(e), onFail = () => {} }) {
  let acc = 0, last = start, logged = false, held = null;
  // True while a tick is due, consuming it.
  const due = () => {
    if (acc < step) return false;
    acc -= step;
    return true;
  };
  return {
    /** Runs `work(due)` for the frame at `now` ms, then requests `next`. */
    run(next, now, work) {
      let failed = false;
      try {
        acc += Math.min(0.25, (now - last) / 1000);
        last = now;
        work(due);
      } catch (e) {
        failed = true;
        // A burst of ticks must not follow the failure.
        acc = 0;
        held = { screen: screen() };
        if (!logged) { logged = true; log(e); }
      } finally {
        request(next);
      }
      if (failed) onFail();
    },
    /** The tick fraction the accumulator holds, in [0, 1) once the frame's ticks have run. */
    fraction() { return acc / step; },
    release() { held = null; },
    /** Whether the ERROR line shows: from a failure until the screen changes or `release()`. */
    shown() {
      if (held !== null && held.screen !== screen()) held = null;
      return held !== null;
    },
  };
}
