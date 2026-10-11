// Shared by the floor and coin tests: seed 0000-0000 at each level.
import { createWorld, boardCoords } from '../src/world/world.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';

export const CODE = '00000000';
export const worlds = Object.fromEntries(DIFFICULTIES.map((d) => [d, createWorld(CODE, { difficulty: d })]));

/** Boards of tombs u -2..2 by v 0..v1 at a level, rock included. */
export function sample(d, v1) {
  const world = worlds[d];
  const out = [];
  for (let v = 0; v <= v1; v++) {
    for (let u = -2; u <= 2; u++) {
      for (let i = 0; i < world.size.w * world.size.h; i++) {
        const { x, y } = boardCoords(u, v, i, world.size);
        out.push(world.board(x, y));
      }
    }
  }
  return out;
}
