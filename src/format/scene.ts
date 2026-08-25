/**
 * Flattens a parsed Room Viewer document into a draw list.
 *
 * Two coordinate systems exist in these files. Objects placed directly in the
 * plan (walls, region outlines, free-drawn shapes) carry absolute coordinates.
 * A placed catalogue item is an `RVShape` whose `RVGeometry` child holds the
 * outline in *local* coordinates centred on the origin — a 66in round table is
 * stored as points on a radius-330 circle regardless of where it sits.
 *
 * Placement comes from the shape's insertion point, **not** its `CRect`. The
 * rect is a cached bounding box that goes stale when a table-and-chairs group
 * is duplicated: a plan with 105 chairs has 105 distinct insertion points but
 * only 20 distinct rects, so trusting the rect stacks most of the room on top
 * of itself. Rotation needs no handling because each instance stores its
 * outline already rotated — a chair turned 150 degrees has a 272x281 geometry
 * box rather than its native 190x215.
 */

import { walk, UNITS_PER_FOOT, type RVDocument, type RVNode } from './rv.js';
import { disciplineFor } from './layers.js';
import { TRAILER_EVENT, TRAILER_VENUE } from './trailer.js';
import type { Extent } from './index.js';

export type PrimitiveType = 'line' | 'polyline' | 'polygon' | 'bezier' | 'text' | 'dimension';

/** Broad groupings the UI exposes as toggleable layers. */
export type Layer = 'walls' | 'furniture' | 'annotation' | 'region' | 'other';

export interface ScenePrimitive {
  id: number;
  /** Object this primitive was drawn from. */
  nodeId: number;
  /**
   * What a click should select. For catalogue items this is the placed shape
   * rather than the individual outline segment, so clicking a chair selects
   * the chair and not one of its four edges.
   */
  selectId: number;
  type: PrimitiveType;
  /** Flat [x0, y0, x1, y1, ...] in logical units (tenths of an inch). */
  pts: number[];
  /** COLORREF as 0x00BBGGRR. */
  color: number;
  cls: string;
  layer: Layer;
  /**
   * The production layer this belongs to — Video, Audio, Staging and so on.
   *
   * `layer` above says what KIND of geometry this is, which is what the file
   * format cares about and what decides how it is drawn. This says which
   * DISCIPLINE owns it, which is what a production cares about, and it is the
   * one a user turns on and off, locks, solos and prints.
   */
  discipline: string;
  /** Catalogue name of the owning shape, e.g. `Round 66"`. */
  owner?: string;
  /** Rendered text, for labels and dimensions. */
  text?: string;
  /** Saved RVLabel typography. Present only for editable text labels. */
  textStyle?: {
    family: string;
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikeOut: boolean;
    angleDegrees: number;
  };
}

export interface Scene {
  primitives: ScenePrimitive[];
  extent: Extent | null;
  /** Room outline extent only — a better default view than every annotation. */
  roomExtent: Extent | null;
  counts: Record<string, number>;
  /**
   * Names of placed catalogue items with how many of each appear. `category`
   * is filled in from the installation's shape catalogue when one is found.
   */
  inventory: Array<{ name: string; count: number; category?: string }>;
  title?: string;
}

function classify(cls: string, ancestors: string[]): Layer {
  if (cls === 'RVLabel' || cls === 'RVDimensionLine') return 'annotation';
  if (ancestors.includes('RVWalls')) return 'walls';
  if (ancestors.includes('RVShape')) return 'furniture';
  if (ancestors.includes('RVRegion')) return 'region';
  return 'other';
}

function primitiveTypeFor(node: RVNode): PrimitiveType | null {
  switch (node.cls) {
    case 'RVSegmentLine':
      return node.points.length > 2 ? 'polyline' : 'line';
    case 'RVSegmentRect':
      return 'polygon';
    case 'RVSegmentPoly':
      return 'polyline';
    case 'RVSegmentArc':
      // Arcs store a cubic Bezier in their final four points; earlier points
      // are construction data the original renderer did not draw.
      return node.points.length >= 4 ? 'bezier' : 'polyline';
    case 'RVDimensionLine':
      return 'dimension';
    case 'RVLabel':
      return 'text';
    case 'RVSegmentOle':
      return 'polygon';
    default:
      return null;
  }
}

function extendExtent(e: Extent | null, x: number, y: number): Extent {
  if (!e) return { minX: x, minY: y, maxX: x, maxY: y };
  if (x < e.minX) e.minX = x;
  if (y < e.minY) e.minY = y;
  if (x > e.maxX) e.maxX = x;
  if (y > e.maxY) e.maxY = y;
  return e;
}

/** Text of a label: strings are [fontName, text], so prefer the second. */
function labelText(node: RVNode): string | undefined {
  if (node.labels.length >= 2) return node.labels[1];
  const only = node.labels[0];
  if (!only) return undefined;
  // A lone string is the font name when it looks like one.
  return /^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(only) ? undefined : only;
}

export function buildScene(doc: RVDocument): Scene {
  const primitives: ScenePrimitive[] = [];
  const counts: Record<string, number> = {};
  const inventory = new Map<string, number>();
  let extent: Extent | null = null;
  let roomExtent: Extent | null = null;
  let id = 0;

  interface Frame {
    node: RVNode;
    ancestors: string[];
    dx: number;
    dy: number;
    owner?: string;
    depth: number;
    /** Nearest enclosing placed shape, which is the unit a user selects. */
    selectId?: number;
  }

  // The parser rejects back-references that would close a cycle, but this
  // traversal must stay bounded even for a file that defeats that check.
  const MAX_DEPTH = 96;
  const MAX_PRIMITIVES = 400_000;

  const stack: Frame[] = doc.roots.map((node) => ({ node, ancestors: [], dx: 0, dy: 0, depth: 0 }));

  while (stack.length) {
    if (primitives.length >= MAX_PRIMITIVES) break;
    const { node, ancestors, dx, dy, owner, depth, selectId } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;
    counts[node.cls] = (counts[node.cls] ?? 0) + 1;

    let childDx = dx;
    let childDy = dy;
    let childOwner = owner;
    let childSelectId = selectId;

    if (node.cls === 'RVShape') {
      childSelectId = node.id;
      // Children are stored around the origin; move them to the insertion point.
      const at = node.points[0];
      childDx = at ? at.x : (node.bounds.left + node.bounds.right) / 2;
      childDy = at ? at.y : (node.bounds.top + node.bounds.bottom) / 2;
      const name = node.labels.find((s) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(s));
      if (name) {
        childOwner = name;
        inventory.set(name, (inventory.get(name) ?? 0) + 1);
      }
    }

    const type = primitiveTypeFor(node);
    if (type && node.points.length) {
      const layer = classify(node.cls, ancestors);
      const source = node.cls === 'RVSegmentArc' && node.points.length >= 4 ? node.points.slice(-4) : node.points;

      const pts: number[] = [];
      for (const p of source) {
        const x = p.x + dx;
        const y = p.y + dy;
        pts.push(x, y);
        extent = extendExtent(extent, x, y);
        if (layer === 'walls' || layer === 'region') roomExtent = extendExtent(roomExtent, x, y);
      }

      const text = type === 'text' || type === 'dimension' ? labelText(node) : undefined;
      if (type !== 'text' || text) {
        primitives.push({
          id: id++,
          nodeId: node.id,
          selectId: selectId ?? node.id,
          type,
          pts,
          color: node.color ?? 0x000000,
          cls: node.cls,
          layer,
          discipline: disciplineFor(layer, owner),
          owner,
          text,
          textStyle:
            type === 'text'
              ? {
                  family: node.font?.family || 'Arial',
                  size: Math.max(4, Math.abs(node.font?.height ?? -90) / 10),
                  bold: (node.font?.weight ?? (node.bold ? 700 : 400)) >= 600,
                  italic: node.font?.italic ?? false,
                  underline: node.font?.underline ?? false,
                  strikeOut: node.font?.strikeOut ?? false,
                  angleDegrees: ((node.angle ?? 0) * 180) / Math.PI,
                }
              : undefined,
        });
      }
    }

    const nextAncestors = [...ancestors, node.cls];
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({
        node: node.children[i],
        ancestors: nextAncestors,
        dx: childDx,
        dy: childDy,
        owner: childOwner,
        depth: depth + 1,
        selectId: childSelectId,
      });
    }
  }

  // Fall back to the room definition's own rect when no wall geometry exists.
  if (!roomExtent) {
    for (const node of walk(doc)) {
      if (node.cls !== 'RVRoomDef' && node.cls !== 'RVRoom') continue;
      const b = node.bounds;
      if (b.right <= b.left || b.bottom <= b.top) continue;
      roomExtent = { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom };
      break;
    }
  }

  // The plan's own name, from the named slots of the document trailer. This
  // used to take `trailerStrings[0]`, which was never anything: the last wall
  // segment's span swallowed the trailer, so the array was empty for every file
  // in the corpus and the title always came from the fallback. Now that the
  // trailer is decoded, slot 0 is the *date* — "March 2023" is not a title — so
  // the event is asked for first, then the venue.
  const title =
    doc.trailerStrings[TRAILER_EVENT] ||
    doc.trailerStrings[TRAILER_VENUE] ||
    doc.roots[0]?.labels.find((s) => s.length > 6);

  return {
    primitives,
    extent,
    roomExtent: roomExtent ?? extent,
    counts,
    inventory: [...inventory.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    title,
  };
}

/** Formats logical units as feet and inches, the unit the app's UI uses. */
export function formatLength(units: number): string {
  const totalInches = units / 10;
  const feet = Math.floor(Math.abs(totalInches) / 12);
  const inches = Math.abs(totalInches) - feet * 12;
  const sign = units < 0 ? '-' : '';
  return `${sign}${feet}' ${inches.toFixed(1).replace(/\.0$/, '')}"`;
}

export { UNITS_PER_FOOT };
