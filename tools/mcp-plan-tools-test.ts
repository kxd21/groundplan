/**
 * The agent-facing plan tools, driven the way an MCP client drives them.
 *
 * These are the calls an AI makes to look at a plan and change it, so the test
 * walks a real round trip: open a file, find something by name, move it, prove
 * the coordinate actually changed, undo, and prove it changed back. The save
 * gate is exercised against a copy so nothing in the corpus is touched.
 *
 *   npx tsx tools/mcp-plan-tools-test.ts [plan.rv4]
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callPlanTool, isPlanTool, PLAN_TOOLS, resetPlanSession } from './mcp-plan-tools.js';
import { COMMAND_IDS } from '../src/shell/command-ids.js';

const source =
  process.argv[2] || join(process.env.HOME || '', 'Downloads', 'Electricities_Grand_Ballroom_East.rv4');

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(` FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 200)}`}`);
  }
};

async function main() {
  // The tool list is the whole contract with an agent: every name it can call
  // has to carry a schema, or the client cannot build a request at all.
  check('every tool declares a schema', PLAN_TOOLS.every((t) => t.name && t.description && t.inputSchema));
  check('tool names are unique', new Set(PLAN_TOOLS.map((t) => t.name)).size === PLAN_TOOLS.length);
  check('the dispatcher claims its own tools', PLAN_TOOLS.every((t) => isPlanTool(t.name)));
  check('the dispatcher does not claim strangers', !isPlanTool('apply_layout_recipe'));

  const units = (await callPlanTool('describe_units', {})) as { unitsPerFoot: number };
  check('units are published', units.unitsPerFoot === 120, units);

  // Editing before opening must be refused rather than throwing something
  // unhelpful — an agent reads the message and recovers.
  resetPlanSession();
  let refused = '';
  try {
    await callPlanTool('list_objects', {});
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check('tools refuse until a plan is open', /open_plan/.test(refused), refused);

  if (!existsSync(source)) {
    console.log(`\nskip: no plan at ${source} — structural checks only`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  // Work on a copy: the save gate writes bytes, and the corpus is not ours.
  const scratch = mkdtempSync(join(tmpdir(), 'gp-mcp-'));
  const plan = join(scratch, 'plan.rv4');
  copyFileSync(source, plan);
  const before = readFileSync(plan);

  const opened = (await callPlanTool('open_plan', { path: plan })) as {
    ok: boolean;
    editable: boolean;
    objects: number;
    layers: string[];
  };
  check('open_plan reports objects', opened.ok && opened.objects > 0, opened);
  check('open_plan reports layers', Array.isArray(opened.layers) && opened.layers.length > 0, opened.layers);

  const listed = (await callPlanTool('list_objects', { limit: 5 })) as {
    total: number;
    matched: number;
    objects: Array<{ id: number; x: number; y: number; readable: { x: string } }>;
  };
  check('list_objects returns addressable ids', listed.objects.length > 0 && listed.objects[0]!.id > 0);
  check('list_objects caps at the limit', listed.objects.length <= 5, listed.objects.length);
  check('positions come with a readable form', /\d/.test(listed.objects[0]!.readable.x));

  // The filter is what makes the surface usable: an agent asks for "projector"
  // rather than paging 7,000 objects.
  const named = (await callPlanTool('list_objects', { nameContains: 'stage', limit: 50 })) as {
    matched: number;
    objects: Array<{ id: number; name?: string }>;
  };
  check(
    'name filter narrows the set',
    named.matched <= listed.total && named.objects.every((o) => /stage/i.test(o.name ?? '')),
    { matched: named.matched, total: listed.total },
  );

  const target = listed.objects[0]!;
  const detail = (await callPlanTool('describe_object', { id: target.id })) as { id: number; bounds: unknown };
  check('describe_object finds the same object', detail.id === target.id);

  // --- move, then prove the coordinate moved -------------------------------
  const moved = (await callPlanTool('move_objects', { ids: [target.id], dx: 240, dy: 0 })) as {
    ok: boolean;
    reason?: string;
    changed: number;
  };
  check('move_objects reports success', moved.ok && moved.changed === 1, moved);

  const afterMove = (await callPlanTool('describe_object', { id: target.id })) as { x: number };
  check('the object actually moved two feet', afterMove.x - target.x === 240, {
    from: target.x,
    to: afterMove.x,
  });

  const undone = (await callPlanTool('undo_edit', {})) as { ok: boolean };
  check('undo_edit steps back', undone.ok, undone);
  const afterUndo = (await callPlanTool('describe_object', { id: target.id })) as { x: number };
  check('undo restores the position', afterUndo.x === target.x, { expected: target.x, got: afterUndo.x });

  // --- refusals -------------------------------------------------------------
  const missing = (await callPlanTool('move_objects', { ids: [999999999], dx: 1, dy: 1 })) as {
    ok: boolean;
    reason?: string;
  };
  check('a bad id is refused, not silently skipped', !missing.ok && /999999999/.test(missing.reason ?? ''), missing);

  const zeroResize = (await callPlanTool('resize_object', { id: target.id, width: 0, height: 10 })) as {
    ok: boolean;
  };
  check('a zero size is refused', !zeroResize.ok, zeroResize);

  // A refused edit must leave nothing behind, or the next save writes a
  // half-finished change the agent never asked for.
  const stillThere = (await callPlanTool('describe_object', { id: target.id })) as { x: number };
  check('a refused edit leaves the plan alone', stillThere.x === target.x);

  // --- reads ----------------------------------------------------------------
  const schedule = (await callPlanTool('plan_schedule', {})) as { total: number; groups: unknown[] };
  check('plan_schedule counts the sheet', schedule.total > 0 && schedule.groups.length > 0, schedule.total);

  const room = (await callPlanTool('room_summary', {})) as { source?: string; areaSquareFeet?: number };
  check('room_summary says how it knows', typeof room.source === 'string', room);

  const commands = (await callPlanTool('list_commands', {})) as {
    count: number;
    commands: Array<{ id: string }>;
  };
  // Parity, not a magic number: every stable id the app ships has to be
  // reachable by an agent, or the surface silently drifts behind the UI.
  check(
    'list_commands exposes every stable command id',
    commands.count === COMMAND_IDS.length &&
      COMMAND_IDS.every((id) => commands.commands.some((c) => c.id === id)),
    { exposed: commands.count, ids: COMMAND_IDS.length },
  );
  check('command ids look stable', commands.commands.every((c) => /^[a-z]+\.[a-z-]+$/.test(c.id)));

  // --- save -----------------------------------------------------------------
  // Nothing was committed since the undo, so a save must reproduce the source
  // byte for byte. That is the whole safety property, checked end to end.
  const saved = (await callPlanTool('save_plan', {})) as { ok: boolean; path?: string };
  check('save_plan writes', saved.ok, saved);
  check('an unchanged plan saves byte-identical', readFileSync(plan).equals(before));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
