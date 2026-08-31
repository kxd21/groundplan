import assert from 'node:assert/strict';

import { rectangularRoom } from '../src/format/room.js';
import { createSeatingPlan, solveSeating } from '../src/format/seating-plan.js';
import { estimateLayoutCapacity } from '../src/format/seating-capacity.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';

const F = UNITS_PER_FOOT;
const stage = { x: 30 * F, y: -6 * F };
const room = rectangularRoom(60 * F, 40 * F, 'Ballroom');
const plan = createSeatingPlan('banquet', stage);
plan.tableDiameter = 60 * UNITS_PER_INCH;
plan.seatsPerTable = 10;

const solved = solveSeating(plan, room);
const estimate = estimateLayoutCapacity(plan, room, {
  seats: solved.seats.length,
  tables: solved.tables.length,
  dropped: solved.dropped,
});

assert.ok(estimate.maxTables > 0, 'banquet room should fit some tables');
assert.ok(estimate.maxSeats > 0, 'banquet room should fit some seats');
assert.ok(estimate.summary, 'capacity summary should always explain how many tables fit');
assert.match(estimate.summary!, /table/i);
console.log('seating-capacity-test ok', estimate.maxTables, 'tables', estimate.maxSeats, 'seats');
console.log(' ', estimate.summary);
