/**
 * Wall-snap for door placement.
 *
 *   npx tsx tools/wall-snap-test.ts
 */
import { nearestWallSnap, wantsWallSnap, WALL_SNAP_REACH } from '../src/format/wall-snap.js';
import { wall } from '../src/format/room.js';
import { UNITS_PER_FOOT as F } from '../src/format/constants.js';

const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

check('doors want snap', wantsWallSnap('Door - Double (Out)'));
check('chairs do not', !wantsWallSnap('Chair 20.5W X 23.23D'));

const walls = [
  wall({ x: -100 * F, y: -50 * F }, { x: 100 * F, y: -50 * F }),
  wall({ x: 100 * F, y: -50 * F }, { x: 100 * F, y: 50 * F }),
  wall({ x: 100 * F, y: 50 * F }, { x: -100 * F, y: 50 * F }),
  wall({ x: -100 * F, y: 50 * F }, { x: -100 * F, y: -50 * F }),
];

const onSouth = nearestWallSnap(walls, 0, -48 * F);
check('snaps toward south wall', !!onSouth && Math.abs(onSouth!.y - -50 * F) < 1, `${onSouth?.y}`);
check('south wall angle ~0°', !!onSouth && Math.abs(onSouth!.angle) < 0.01, `${onSouth?.angle}`);

const onEast = nearestWallSnap(walls, 97 * F, 0);
check('snaps toward east wall', !!onEast && Math.abs(onEast!.x - 100 * F) < 1, `${onEast?.x}`);
check(
  'east wall angle ~90°',
  !!onEast && Math.abs(Math.abs(onEast!.angle) - Math.PI / 2) < 0.05,
  `${onEast?.angle}`,
);

const far = nearestWallSnap(walls, 0, 0);
check('centre of room does not snap', far == null || far.distance > WALL_SNAP_REACH);

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} failed` : `${checks.length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
