// The frame meter: how many animation frames the browser fired in the last
// second. DOM-free, so node drives it; `boot` binds it to the #fps canvas.

// The least ms between two readings.
const WINDOW_MS = 1000;

/** The reading from turning on until the first update. */
export const NO_READING = '-- FPS';

/** Whether the page's hash at load turns the meter on: `#fps` exactly. */
export function meterAtBoot(hash) {
  return hash === '#fps';
}

/**
 * A frame meter, off. `show(text)` takes each reading: NO_READING as the meter
 * turns on, `<n> FPS` at each update and null as it turns off. `frame(now)`
 * counts the animation frame at `now` ms: the first frame on starts the count,
 * and an update comes on the first frame WINDOW_MS or more past the previous
 * update, `n` the frames since. Off, a frame does nothing.
 */
export function createMeter(show) {
  let on = false, started = false, text = null, count = 0, since = 0;
  return {
    get on() { return on; },
    /** The reading shown, or null while off. */
    get text() { return text; },
    set(next) {
      if (next === on) return;
      on = next;
      started = false;
      count = 0;
      text = on ? NO_READING : null;
      show(text);
    },
    toggle() { this.set(!on); },
    frame(now) {
      if (!on) return;
      if (!started) {
        started = true;
        since = now;
        return;
      }
      count++;
      if (now - since < WINDOW_MS) return;
      text = `${count} FPS`;
      count = 0;
      since = now;
      show(text);
    },
  };
}
