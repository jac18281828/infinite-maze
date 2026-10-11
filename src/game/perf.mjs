// Frame-timing probe behind `#perf`: the rAF interval histogram, the ticks each
// frame ran and the draw cost. DOM-free; main.mjs feeds it and shows it.

const BINS = 21;
const BIN_MS = 2;
const TICK_BINS = 4;

const hundredths = (ms) => Math.round(ms * 100) / 100;

export function createProbe() {
  const bins = new Array(BINS).fill(0);
  const ticks = new Array(TICK_BINS).fill(0);
  let frames = 0, drawSum = 0, drawMax = 0;
  return {
    /** Records one animation frame: rAF interval, ticks run and draw time, in ms. */
    frame(intervalMs, ran, drawMs) {
      frames++;
      bins[Math.min(BINS - 1, Math.max(0, Math.floor(intervalMs / BIN_MS)))]++;
      ticks[Math.min(TICK_BINS - 1, ran)]++;
      drawSum += drawMs;
      if (drawMs > drawMax) drawMax = drawMs;
    },
    /**
     * Bin i counts intervals in [2i, 2i + 2) ms and bin 20 those of 40 ms and
     * over. `ticks` counts frames that ran 0, 1, 2 and 3 or more ticks.
     */
    summary() {
      return {
        frames,
        bins: bins.slice(),
        ticks: ticks.slice(),
        drawMeanMs: frames ? hundredths(drawSum / frames) : 0,
        drawMaxMs: hundredths(drawMax),
      };
    },
  };
}
