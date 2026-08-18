/**
 * Plan-editing tools for the Groundplan MCP server.
 *
 * The server used to expose four whole-file operations: validate a recipe,
 * list kits, apply a recipe, count what came out. An agent could therefore
 * generate a plan from scratch or read a total, and nothing in between — it
 * could not look at a plan, find the projector, and move it four feet. Every
 * capability the app has lived behind 127 Electron IPC handlers that only exist
 * while a window is open.
 *
 * This module puts the same capabilities on a headless session. It opens an
 * `.rv4` into memory with the same `Session` the main process uses, edits it
 * through the same `src/format/edit` functions, and gates every save on
 * `verifyWritable` — so an agent inherits the byte-identity guarantee rather
 * than routing around it.
 *
 * Coordinates are logical units throughout: tenths of an inch, 120 to the foot,
 * which is what the file format stores. `describe_units` exists so an agent
 * does not have to guess.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Session } from '../src/main/session.js';
import { buildSchedule } from '../src/format/schedule.js';
import { verifyWritable } from '../src/format/write.js';
import { deriveRoom, describeRoom, roomArea } from '../src/format/room.js';
import {
  deleteNode,
  duplicateNode,
  flipNode,
  measureNode,
  moveNode,
  nodeCentre,
  relabelNode,
  renameNode,
  resizeNode,
  rotateNode,
} from '../src/format/edit.js';
import { formatLength } from '../src/format/units.js';
import { COMMAND_CATALOG } from '../src/renderer/src/commands.js';
import type { RVDocument, RVNode } from '../src/format/rv.js';

/** 120 logical units to the foot; the format stores tenths of an inch. */
export const UNITS_PER_FOOT = 120;

/**
 * The one open plan.
 *
 * A single slot rather than a map: an agent editing two plans at once through
 * one stdio pipe is a bug waiting to happen, and `open_plan` is cheap enough to
 * call again. The path is the identity, so every mutating tool can check that
 * the agent is editing the file it thinks it is.
 */
let session: Session | null = null;

function active(): Session {
  if (!session) throw new Error('no plan is open — call open_plan first');
  return session;
}

/**
 * A node's display name.
 *
 * Mirrors the main process: a label stores [font family, text], and font names
 * are user-editable, so the second string is the wording rather than whichever
 * string fails a font allow-list.
 */
function nameOf(node: RVNode): string | undefined {
  if (node.cls === 'RVLabel' && node.labels.length >= 2) return node.labels[1];
  return node.labels.find((s) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(s));
}

export interface ObjectSummary {
  id: number;
  name?: string;
  cls: string;
  layer?: string;
  /** Centre of the object's bounds, in logical units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Absolute angle in degrees when the file stores one; null = rotate-by only. */
  angleDegrees: number | null;
  /** The same figures in feet and inches, so an agent need not convert. */
  readable: { x: string; y: string; width: string; height: string };
}

function summarise(node: RVNode, layer?: string): ObjectSummary {
  const measured = measureNode(node);
  const centre = nodeCentre(node) ?? {
    x: (node.bounds.left + node.bounds.right) / 2,
    y: (node.bounds.top + node.bounds.bottom) / 2,
  };
  return {
    id: node.id,
    name: nameOf(node),
    cls: node.cls,
    layer,
    x: Math.round(centre.x),
    y: Math.round(centre.y),
    width: Math.round(measured.width),
    height: Math.round(measured.height),
    angleDegrees:
      node.angle != null && Number.isFinite(node.angle)
        ? Math.round(((node.angle * 180) / Math.PI) * 10) / 10
        : null,
    readable: {
      x: formatLength(centre.x, 'imperial'),
      y: formatLength(centre.y, 'imperial'),
      width: formatLength(measured.width, 'imperial'),
      height: formatLength(measured.height, 'imperial'),
    },
  };
}

/** Layer per selectable object, read off the flattened scene. */
function layerIndex(s: Session): Map<number, string> {
  const layers = new Map<number, string>();
  for (const primitive of s.scene.primitives) {
    if (!layers.has(primitive.selectId)) layers.set(primitive.selectId, String(primitive.layer));
  }
  return layers;
}

/** Every node an agent can address, in document order. */
function selectableNodes(s: Session): RVNode[] {
  const seen = new Set<number>();
  const out: RVNode[] = [];
  for (const primitive of s.scene.primitives) {
    if (seen.has(primitive.selectId)) continue;
    seen.add(primitive.selectId);
    const node = s.index.byId.get(primitive.selectId);
    if (node) out.push(node);
  }
  return out;
}

function nodesFor(s: Session, ids: unknown): RVNode[] {
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids must be a non-empty array of object ids');
  return ids.map((raw) => {
    const node = s.index.byId.get(Number(raw));
    if (!node) throw new Error(`no object with id ${raw}`);
    return node;
  });
}

/**
 * Runs an edit inside a checkpoint, and rolls it back on refusal.
 *
 * This is the headless twin of `applyEdit` in the main process, including the
 * round-trip gate: an agent must not be able to write bytes the parser cannot
 * reproduce, because it has no Save dialog to notice the file went read-only.
 */
function edit<T>(run: (s: Session, doc: RVDocument) => T & { ok: boolean; reason?: string }): T & {
  ok: boolean;
  reason?: string;
} {
  const s = active();
  if (!s.editable) {
    return { ok: false, reason: 'this plan is read-only because it does not reproduce exactly' } as T & {
      ok: boolean;
      reason?: string;
    };
  }
  s.checkpoint();
  try {
    const result = run(s, s.loaded.document);
    if (!result.ok) {
      s.rollback();
      return result;
    }
    const verdict = verifyWritable(s.loaded.document);
    if (!verdict.ok) {
      s.rollback();
      return { ...result, ok: false, reason: verdict.reason };
    }
    s.refresh();
    return result;
  } catch (err) {
    s.rollback();
    return { ok: false, reason: err instanceof Error ? err.message : String(err) } as T & {
      ok: boolean;
      reason?: string;
    };
  }
}

/** Applies one edit to each of several nodes, stopping at the first refusal. */
function editEach(
  ids: unknown,
  apply: (doc: RVDocument, node: RVNode) => { ok: boolean; reason?: string },
): { ok: boolean; reason?: string; changed: number } {
  return edit((s, doc) => {
    const nodes = nodesFor(s, ids);
    let changed = 0;
    for (const node of nodes) {
      const result = apply(doc, node);
      if (!result.ok) return { ok: false, reason: result.reason, changed };
      changed++;
    }
    return { ok: true, changed };
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const PLAN_TOOLS = [
  {
    name: 'describe_units',
    description:
      'The coordinate system every other plan tool uses. Call once before doing arithmetic on positions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_plan',
    description:
      'Open an .rv4 plan into the editing session and return a summary (room, object count, layers). Required before any other plan tool.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the .rv4 file' } },
      required: ['path'],
    },
  },
  {
    name: 'list_objects',
    description:
      'Every addressable object on the open plan: id, name, class, layer, centre, size, angle. Filter by name or layer to find something specific.',
    inputSchema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Case-insensitive substring of the object name' },
        layer: { type: 'string', description: 'Exact layer name' },
        cls: { type: 'string', description: 'Exact class, e.g. RVShape or RVLabel' },
        limit: { type: 'number', description: 'Cap the number returned (default 200)' },
      },
    },
  },
  {
    name: 'describe_object',
    description: 'One object in full, including its bounds and the text it carries.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'move_objects',
    description: 'Move objects by a delta in logical units. Positive y is down the sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' } },
        dx: { type: 'number' },
        dy: { type: 'number' },
      },
      required: ['ids', 'dx', 'dy'],
    },
  },
  {
    name: 'rotate_objects',
    description: 'Rotate objects about their own centres, in degrees, clockwise.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'number' } }, degrees: { type: 'number' } },
      required: ['ids', 'degrees'],
    },
  },
  {
    name: 'resize_object',
    description:
      'Set one object to an absolute width and height in logical units. Scales about the object centre.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
      required: ['id', 'width', 'height'],
    },
  },
  {
    name: 'flip_objects',
    description: 'Mirror objects horizontally or vertically about their own centres.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' } },
        axis: { type: 'string', enum: ['horizontal', 'vertical'] },
      },
      required: ['ids', 'axis'],
    },
  },
  {
    name: 'duplicate_objects',
    description: 'Copy objects, offset by a delta. Returns the new ids.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' } },
        dx: { type: 'number' },
        dy: { type: 'number' },
      },
      required: ['ids', 'dx', 'dy'],
    },
  },
  {
    name: 'delete_objects',
    description: 'Remove objects from the plan.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'number' } } },
      required: ['ids'],
    },
  },
  {
    name: 'set_object_text',
    description: 'Rewrite a label’s wording, or an object’s catalogue name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        text: { type: 'string' },
        field: { type: 'string', enum: ['label', 'name'], description: 'Default label' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'plan_schedule',
    description: 'The counted schedule of everything on the plan, grouped by catalogue name.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'room_summary',
    description: 'The room outline: walls, perimeter, area, and the bounding extent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'undo_edit',
    description: 'Step back one edit in the open session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_plan',
    description:
      'Write the open plan back to disk. Refuses if the document no longer reproduces byte-for-byte. Omit path to overwrite the file that was opened.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Write somewhere else instead' } },
    },
  },
  {
    name: 'list_commands',
    description:
      'Every stable command id the Groundplan UI exposes, with titles and shortcuts. Use when driving a running app rather than a file.',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', description: 'Filter to one section' } },
    },
  },
] as const;

export function isPlanTool(name: string): boolean {
  return PLAN_TOOLS.some((tool) => tool.name === name);
}

export async function callPlanTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'describe_units':
      return {
        unit: 'logical unit = one tenth of an inch',
        unitsPerInch: 10,
        unitsPerFoot: UNITS_PER_FOOT,
        axes: 'x increases to the right, y increases DOWN the sheet',
        angles: 'degrees, clockwise, 0 = pointing right',
        note: 'Every position and size in these tools is in logical units unless the field is named `readable`.',
      };

    case 'open_plan': {
      const path = resolve(String(params.path));
      const bytes = readFileSync(path);
      session = new Session(path, bytes);
      const layers = layerIndex(session);
      return {
        ok: true,
        path,
        editable: session.editable,
        objects: selectableNodes(session).length,
        primitives: session.scene.primitives.length,
        layers: [...new Set(layers.values())].sort(),
        extent: session.scene.roomExtent,
        readOnlyReason: session.editable
          ? undefined
          : 'the parser cannot reproduce this file byte-for-byte, so edits are refused',
      };
    }

    case 'list_objects': {
      const s = active();
      const layers = layerIndex(s);
      const nameNeedle = params.nameContains ? String(params.nameContains).toLowerCase() : null;
      const limit = Number(params.limit) > 0 ? Number(params.limit) : 200;
      const all = selectableNodes(s).map((node) => summarise(node, layers.get(node.id)));
      const matched = all.filter((object) => {
        if (nameNeedle && !(object.name ?? '').toLowerCase().includes(nameNeedle)) return false;
        if (params.layer && object.layer !== String(params.layer)) return false;
        if (params.cls && object.cls !== String(params.cls)) return false;
        return true;
      });
      return { total: all.length, matched: matched.length, objects: matched.slice(0, limit) };
    }

    case 'describe_object': {
      const s = active();
      const node = s.index.byId.get(Number(params.id));
      if (!node) throw new Error(`no object with id ${params.id}`);
      const layers = layerIndex(s);
      return {
        ...summarise(node, layers.get(node.id)),
        bounds: node.bounds,
        labels: node.labels,
        children: node.children.length,
        shared: s.index.shared.has(node),
      };
    }

    case 'move_objects':
      return editEach(params.ids, (doc, node) => moveNode(doc, node, Number(params.dx), Number(params.dy)));

    case 'rotate_objects':
      return editEach(params.ids, (doc, node) =>
        rotateNode(doc, node, (Number(params.degrees) * Math.PI) / 180),
      );

    case 'resize_object':
      return edit((s, doc) => {
        const node = s.index.byId.get(Number(params.id));
        if (!node) return { ok: false, reason: `no object with id ${params.id}` };
        const current = measureNode(node);
        if (!(current.width > 0) || !(current.height > 0)) {
          return { ok: false, reason: 'this object has no size to change' };
        }
        const width = Number(params.width);
        const height = Number(params.height);
        if (!(width > 0) || !(height > 0)) return { ok: false, reason: 'width and height must be positive' };
        const result = resizeNode(doc, node, width / current.width, height / current.height);
        return { ...result, from: current, to: { width, height } };
      });

    case 'flip_objects': {
      const axis = String(params.axis) === 'vertical' ? 'vertical' : 'horizontal';
      return editEach(params.ids, (doc, node) => flipNode(doc, node, axis));
    }

    case 'duplicate_objects':
      return edit((s, doc) => {
        const nodes = nodesFor(s, params.ids);
        const created: number[] = [];
        for (const node of nodes) {
          const result = duplicateNode(doc, s.index, node, Number(params.dx), Number(params.dy));
          if (!result.ok) return { ok: false, reason: result.reason, created };
          if (result.created) created.push(...result.created);
        }
        return { ok: true, created };
      });

    case 'delete_objects':
      return edit((s, doc) => {
        // Delete from the back so earlier removals cannot invalidate later ones.
        const nodes = nodesFor(s, params.ids).reverse();
        let changed = 0;
        for (const node of nodes) {
          const result = deleteNode(doc, s.index, node);
          if (!result.ok) return { ok: false, reason: result.reason, changed };
          changed++;
        }
        return { ok: true, changed };
      });

    case 'set_object_text':
      return edit((s, doc) => {
        const node = s.index.byId.get(Number(params.id));
        if (!node) return { ok: false, reason: `no object with id ${params.id}` };
        const text = String(params.text);
        return params.field === 'name' ? renameNode(doc, node, text) : relabelNode(doc, node, text);
      });

    case 'plan_schedule': {
      const s = active();
      const schedule = buildSchedule(s.loaded.document);
      return {
        groups: schedule.groups.map((group) => ({ name: group.name, count: group.count })),
        total: schedule.groups.reduce((sum, group) => sum + group.count, 0),
      };
    }

    case 'room_summary': {
      const s = active();
      const derived = deriveRoom(s.loaded.document, s.scene);
      if (derived.source === 'none') {
        return { room: null, extent: s.scene.roomExtent, note: 'this plan has no room outline' };
      }
      const area = roomArea(derived.room);
      return {
        description: describeRoom(derived.room),
        // `source` and `closed` are the honest part: an extent-derived boundary
        // over-reports an irregular room, and an agent must be able to tell.
        source: derived.source,
        closed: derived.closed,
        walls: derived.room.walls.length,
        areaSquareFeet: Math.round(area / (UNITS_PER_FOOT * UNITS_PER_FOOT)),
        extent: s.scene.roomExtent,
      };
    }

    case 'undo_edit': {
      const s = active();
      const ok = s.undo();
      if (ok) s.refresh();
      return { ok, reason: ok ? undefined : 'nothing to undo' };
    }

    case 'save_plan': {
      const s = active();
      const verdict = verifyWritable(s.loaded.document);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const target = params.path ? resolve(String(params.path)) : s.path;
      const bytes = s.file();
      writeFileSync(target, bytes);
      s.markSaved(bytes);
      return { ok: true, path: target, bytes: bytes.length };
    }

    case 'list_commands': {
      const section = params.section ? String(params.section) : null;
      const commands = COMMAND_CATALOG.filter((command) => !section || command.section === section).map(
        (command) => ({
          id: command.id,
          title: command.title,
          subtitle: command.subtitle,
          section: command.section,
          shortcut: command.shortcut,
        }),
      );
      return {
        count: commands.length,
        howToRun: "window.groundplan.commandsRun('<id>') in a running app over CDP",
        commands,
      };
    }

    default:
      throw new Error(`unknown plan tool: ${name}`);
  }
}

/** Test hook: drop the open session so a suite can start clean. */
export function resetPlanSession(): void {
  session = null;
}
