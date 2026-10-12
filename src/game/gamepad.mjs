// Controller layer. A standard-mapped gamepad's buttons and left stick become
// the keyboard's own key events, so the key handlers serve a controller
// unchanged. Pure: it reads a gamepad list and returns events, and imports
// without a DOM.

/** The left stick holds an arrow once past STICK_ON and keeps it until back inside STICK_OFF. */
export const STICK_ON = 0.5;
export const STICK_OFF = 0.4;

// The keys a controller sends, in the order a poll reports them.
const KEYS = [
  { code: 'ArrowLeft', key: 'ArrowLeft' }, { code: 'ArrowRight', key: 'ArrowRight' },
  { code: 'ArrowUp', key: 'ArrowUp' }, { code: 'ArrowDown', key: 'ArrowDown' },
  { code: 'Space', key: ' ' }, { code: 'Enter', key: 'Enter' },
  { code: 'KeyP', key: 'p' }, { code: 'KeyQ', key: 'q' },
];

// Standard-mapping button index to key code.
const BUTTONS = {
  0: 'Space', 1: 'Enter', 8: 'KeyQ', 9: 'KeyP',
  12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight',
};

// The stick axes: [axis, key for the negative side, key for the positive side].
// Axis 1 is positive down.
const AXES = [[0, 'ArrowLeft', 'ArrowRight'], [1, 'ArrowUp', 'ArrowDown']];

// The shared empty list: an idle poll returns it and allocates nothing.
const NONE = Object.freeze([]);

/** The side (-1, 0 or 1) an axis value holds, given the side it held before. */
function stickSide(value, was) {
  if (value <= -STICK_ON) return -1;
  if (value >= STICK_ON) return 1;
  if (was === -1 && value <= -STICK_OFF) return -1;
  if (was === 1 && value >= STICK_OFF) return 1;
  return 0;
}

/**
 * Tracks the gamepads `getGamepads()` lists. Each `poll()` returns the key
 * events due, as { type: 'keydown' | 'keyup', code, key }. A key goes down when
 * its first source presses and up when its last lets go, and never repeats.
 * Only standard-mapped gamepads count, each by its index in the list.
 */
export function createGamepad(getGamepads) {
  // Index in the list to { codes: the key codes it holds, sides: its stick's sides }.
  let pads = new Map();

  // The list as the browser hands it, with no copy: Safari lists four null
  // slots every frame.
  function read() {
    try {
      const list = getGamepads() || NONE;
      return typeof list.length === 'number' ? list : Array.from(list);
    } catch {
      return NONE;
    }
  }

  function look(pad, was) {
    const codes = new Set();
    const buttons = pad.buttons || [];
    for (const [i, code] of Object.entries(BUTTONS)) {
      if (buttons[i] && buttons[i].pressed) codes.add(code);
    }
    const sides = [0, 0];
    const axes = pad.axes || [];
    AXES.forEach(([axis, neg, pos], n) => {
      sides[n] = stickSide(axes[axis], was ? was.sides[n] : 0);
      if (sides[n] < 0) codes.add(neg);
      if (sides[n] > 0) codes.add(pos);
    });
    return { codes, sides };
  }

  const union = (map) => new Set([...map.values()].flatMap((p) => [...p.codes]));

  return {
    poll() {
      const list = read();
      let standard = false;
      for (let i = 0; i < list.length && !standard; i++) standard = !!list[i] && list[i].mapping === 'standard';
      if (!standard && pads.size === 0) return NONE;
      const next = new Map();
      for (let index = 0; index < list.length; index++) {
        const pad = list[index];
        if (pad && pad.mapping === 'standard') next.set(index, look(pad, pads.get(index)));
      }
      const before = union(pads), after = union(next);
      pads = next;
      return [
        ...KEYS.filter((k) => before.has(k.code) && !after.has(k.code)).map((k) => ({ type: 'keyup', ...k })),
        ...KEYS.filter((k) => after.has(k.code) && !before.has(k.code)).map((k) => ({ type: 'keydown', ...k })),
      ];
    },
  };
}
