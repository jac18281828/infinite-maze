// WebAudio music and sound, synthesized. The context is built at boot,
// suspended; the first key press or touch resumes it and starts the music.
// Music: Hijaz on E (E F G# A B C D), an 8th-note bass ostinato and a frame
// drum at 110 BPM. As the torch dims, layers enter and the tempo rises to
// 128 BPM; a relight drops both back. A low-pass, a light bit-crush and tape
// wobble (a slow LFO on every oscillator's detune) make it lo-fi.

const E2 = 41.2034;
const hz = (semi) => E2 * Math.pow(2, semi / 12);
// Hijaz degrees as semitones above E.
const H = [0, 1, 4, 5, 7, 8, 10];
const deg = (d, oct = 0) => H[((d % 7) + 7) % 7] + 12 * (oct + Math.floor(d / 7));

// Bass, one entry per 8th note over two bars, as Hijaz degrees.
const BASS = [0, 0, 4, 0, 1, 0, 2, 0, 0, 0, 4, 0, 3, 2, 1, 0];
// Maqsum on 8ths: D = doum, T = tek.
const DRUM = 'DT.TD.T.DT.TD.TT';
// Melody phrases over two bars: [16th step, degree, length in 16ths].
const PHRASES = [
  [[0, 7, 4], [4, 8, 2], [6, 9, 2], [8, 10, 6], [14, 9, 2], [16, 8, 4], [20, 7, 10]],
  [[0, 11, 3], [3, 12, 1], [4, 11, 4], [8, 10, 2], [10, 9, 2], [12, 8, 4], [16, 9, 4], [20, 8, 2], [22, 7, 8]],
  [[0, 14, 6], [6, 13, 2], [8, 12, 4], [12, 11, 4], [16, 10, 2], [18, 9, 2], [20, 8, 4], [24, 7, 8]],
  [[0, 7, 2], [2, 8, 2], [4, 9, 4], [8, 8, 2], [10, 9, 2], [12, 10, 4], [16, 11, 8], [24, 10, 2], [26, 9, 2], [28, 8, 4]],
];
const ARP = [0, 2, 4, 6, 7, 6, 4, 2];

export function createAudio() {
  let ac = null, master, music, sfx, wobble, noise, timer = 0, started = false;
  let muted = false, intensity = 0, eased = 0, nextTime = 0, step = 0, phrase = 0;

  function crushCurve(levels) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.round(x * levels) / levels;
    }
    return c;
  }

  /** Builds the context and its graph; a missing or throwing context leaves audio off. */
  function build() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    try {
      ac = new AC();
      graph();
    } catch {
      const dead = ac;
      ac = master = music = sfx = wobble = noise = null;
      try { Promise.resolve(dead && dead.close()).catch(() => {}); } catch { /* nothing to close */ }
    }
  }

  function graph() {
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ac.destination);
    music = ac.createGain();
    music.gain.value = 0.42;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.6;
    const crush = ac.createWaveShaper();
    crush.curve = crushCurve(24);
    const dry = ac.createGain(), wet = ac.createGain();
    dry.gain.value = 0.7;
    wet.gain.value = 0.3;
    music.connect(lp);
    lp.connect(dry).connect(master);
    lp.connect(crush).connect(wet).connect(master);
    sfx = ac.createGain();
    sfx.gain.value = 0.55;
    sfx.connect(master);
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.31;
    wobble = ac.createGain();
    wobble.gain.value = 11;
    lfo.connect(wobble);
    lfo.start();
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  /**
   * Resumes the context whenever it is not running, which covers iOS's
   * `interrupted` as well as `suspended`, and on the first call starts the music.
   */
  function start() {
    if (!ac) return;
    if (ac.state !== 'running') {
      try {
        const resumed = ac.resume();
        if (resumed && resumed.catch) resumed.catch(() => {});
      } catch { /* a refused resume leaves the context as it was */ }
    }
    if (started) return;
    started = true;
    nextTime = ac.currentTime + 0.08;
    timer = setInterval(schedule, 25);
  }

  // Every oscillator takes the tape wobble on its detune until it ends.
  function osc(type, f, t, out) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    wobble.connect(o.detune);
    o.onended = () => wobble.disconnect(o.detune);
    o.connect(out);
    return o;
  }

  function env(t, peak, attack, release) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return g;
  }

  function noiseHit(t, type, f, q, peak, dur, out) {
    const src = ac.createBufferSource();
    src.buffer = noise;
    const flt = ac.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(f, t);
    flt.Q.value = q;
    const g = env(t, peak, 0.003, dur);
    src.connect(flt).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
    return flt;
  }

  function bass(t, semi, dur, oct2) {
    const g = env(t, 0.3, 0.006, dur * 0.9);
    const flt = ac.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(900, t);
    flt.frequency.exponentialRampToValueAtTime(260, t + dur);
    g.connect(flt).connect(music);
    for (const [type, mul, lvl] of [['sawtooth', 1, 0.6], ['triangle', 0.5, 1]]) {
      const lg = ac.createGain();
      lg.gain.value = lvl;
      lg.connect(g);
      const o = osc(type, hz(semi) * mul * 2, t, lg);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    if (oct2) {
      const g2 = env(t, 0.06, 0.004, dur * 0.6);
      g2.connect(music);
      const o = osc('square', hz(semi + 24), t, g2);
      o.start(t);
      o.stop(t + dur);
    }
  }

  function doum(t) {
    const g = env(t, 0.9, 0.004, 0.32);
    g.connect(music);
    const o = osc('sine', 110, t, g);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.2);
    o.start(t);
    o.stop(t + 0.4);
    noiseHit(t, 'lowpass', 500, 0.7, 0.25, 0.08, music);
  }

  function tek(t, peak) {
    noiseHit(t, 'bandpass', 2600, 1.4, peak, 0.05, music);
  }

  function ney(t, semi, dur, peak) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.06);
    g.gain.setValueAtTime(peak, t + Math.max(0.07, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    const flt = ac.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 2200;
    g.connect(flt).connect(music);
    const vib = ac.createOscillator();
    vib.frequency.value = 5.2;
    const vg = ac.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(14, t + Math.min(0.4, dur));
    vib.connect(vg);
    for (const [type, mul, lvl] of [['triangle', 1, 1], ['sine', 2, 0.25]]) {
      const lg = ac.createGain();
      lg.gain.value = lvl;
      lg.connect(g);
      const o = osc(type, hz(semi) * mul, t, lg);
      vg.connect(o.detune);
      o.start(t);
      o.stop(t + dur + 0.2);
    }
    vib.start(t);
    vib.stop(t + dur + 0.2);
    noiseHit(t, 'bandpass', hz(semi) * 2, 3, peak * 0.15, Math.min(0.2, dur), music);
  }

  function drone(t, dur) {
    for (const semi of [12, 19]) {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const flt = ac.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 700;
      g.connect(flt).connect(music);
      const o = osc('sawtooth', hz(semi), t, g);
      o.detune.value = semi === 12 ? -6 : 6;
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  function pluck(t, semi) {
    const g = env(t, 0.07, 0.003, 0.14);
    g.connect(music);
    const o = osc('square', hz(semi), t, g);
    o.start(t);
    o.stop(t + 0.2);
  }

  function schedule() {
    if (!ac) return;
    eased += (intensity - eased) * 0.08;
    const bpm = 110 + 18 * eased;
    const s16 = 60 / bpm / 4;
    while (nextTime < ac.currentTime + 0.12) {
      const t = nextTime, i = step % 32;
      if (i % 2 === 0) {
        const e = i / 2;
        bass(t, deg(BASS[e]), s16 * 1.8, eased > 0.75);
        const hit = DRUM[e];
        if (hit === 'D') doum(t);
        else if (hit === 'T') tek(t, 0.22);
      } else if (eased > 0.5) {
        tek(t, 0.07 + 0.06 * eased);
      }
      if (i === 0) {
        if (eased > 0.25) drone(t, s16 * 32);
        if (step % 64 === 0) phrase = (phrase + 1) % PHRASES.length;
      }
      for (const [at, d, len] of PHRASES[phrase]) {
        if (at === i) ney(t, deg(d, 1), len * s16, 0.16);
      }
      if (eased > 0.75 && i % 2 === 1) pluck(t, deg(ARP[(i >> 1) % 8], 3));
      nextTime += s16;
      step++;
    }
  }

  function stepSound(t) {
    noiseHit(t, 'bandpass', 380 + Math.random() * 120, 1.2, 0.35, 0.05, sfx);
    const g = env(t, 0.25, 0.002, 0.06);
    g.connect(sfx);
    const o = osc('sine', 120, t, g);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.06);
    o.start(t); o.stop(t + 0.08);
  }

  function creakSound(t) {
    const flt = ac.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = 700;
    flt.Q.value = 9;
    const g = env(t, 0.12, 0.02, 0.16);
    flt.connect(g).connect(sfx);
    const o = osc('sawtooth', 210 + Math.random() * 30, t, flt);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.18);
    o.start(t); o.stop(t + 0.22);
  }

  function relightSound(t) {
    const f = noiseHit(t, 'bandpass', 300, 0.9, 0.5, 0.55, sfx);
    f.frequency.exponentialRampToValueAtTime(3800, t + 0.45);
    for (const [semi, lag] of [[deg(7, 2), 0.08], [deg(11, 2), 0.16], [deg(14, 2), 0.24]]) {
      const g = env(t + lag, 0.1, 0.005, 1.1);
      g.connect(sfx);
      const o = osc('sine', hz(semi), t + lag, g);
      o.start(t + lag); o.stop(t + lag + 1.2);
    }
  }

  function sputterSound(t) {
    for (let k = 0; k < 3; k++) noiseHit(t + k * 0.03 * Math.random(), 'highpass', 1800, 0.8, 0.12 * Math.random() + 0.04, 0.02, sfx);
  }

  function emberSound(t) {
    const g = env(t, 0.3, 0.01, 0.9);
    g.connect(sfx);
    const o = osc('triangle', 220, t, g);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.9);
    o.start(t); o.stop(t + 1);
  }

  function overSound(t) {
    for (const [k, semi] of [[0, deg(7, 1)], [1, deg(5, 1)], [2, deg(2, 1)], [3, deg(0, 1)]]) ney(t + k * 0.35, semi, 0.5, 0.2);
  }

  function bandSound(t) {
    for (const [k, semi] of [[0, deg(7, 2)], [1, deg(9, 2)], [2, deg(11, 2)]]) pluck(t + k * 0.09, semi);
  }

  const SOUNDS = {
    step: stepSound, creak: creakSound, relight: relightSound, sputter: sputterSound,
    ember: emberSound, over: overSound, band: bandSound,
  };

  function play(name) {
    if (!started || muted || !SOUNDS[name]) return;
    SOUNDS[name](ac.currentTime + 0.005);
  }

  build();

  return {
    start,
    play,
    /** Sets music intensity from the torch: 0 full, 1 at ember. */
    setIntensity(v) { intensity = Math.max(0, Math.min(1, v)); },
    relight() { intensity = 0; eased = Math.min(eased, 0.15); },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ac.currentTime, 0.02);
      return muted;
    },
    get muted() { return muted; },
    stop() { if (timer) clearInterval(timer); timer = 0; },
  };
}
