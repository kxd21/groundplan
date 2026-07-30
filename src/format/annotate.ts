/**
 * Creating annotation.
 *
 * 98% of the plans in the corpus carry text labels and 91% carry dimension
 * lines — Scott's arena plan has 86 and 43 of them. A tool that can move a
 * chair but cannot write "Stage 8' X 42' X 24"" next to the stage is not a
 * tool you can draw a show with.
 *
 * Like everything else here, nothing is written from scratch: an existing
 * label or dimension in the file is cloned and its text or endpoints rewritten,
 * so the font block and the pen settings stay byte-valid.
 */

import type { RVDocument, RVNode } from './rv.js';
import { UNITS_PER_FOOT } from './rv.js';
import {
  addRoot,
  appendChild,
  duplicateNode,
  moveNode,
  relabelNode,
  type DocumentIndex,
  type EditResult,
} from './edit.js';
import { createLabel as synthesizeLabel, createSegment } from './synthesize.js';
import { formatLength, type UnitSystem } from './units.js';

/** Finds a template of a given class that carries the fields we need to rewrite. */
function findTemplate(doc: RVDocument, cls: string, needs: (n: RVNode) => boolean): RVNode | null {
  const seen = new Set<RVNode>();
  const stack = [...doc.roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.cls === cls && needs(node)) return node;
    for (const child of node.children) stack.push(child);
  }
  return null;
}

function findById(doc: RVDocument, id: number): RVNode | null {
  const seen = new Set<RVNode>();
  const stack = [...doc.roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.id === id) return node;
    for (const child of node.children) stack.push(child);
  }
  return null;
}

/**
 * Formats a length for a dimension label.
 *
 * Imperial keeps the spelled-out form these drawings use — `22 ft  0 in`, with
 * the double space — so a dimension this app adds is indistinguishable from the
 * ones already on the sheet. Metric has no such precedent to match, so it uses
 * the ordinary form.
 */
export function formatDistance(units: number, system: UnitSystem = 'imperial'): string {
  if (system === 'metric') return formatLength(units, 'metric');
  const totalInches = Math.abs(units) / 10;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  return inches === 12 ? `${feet + 1} ft  0 in` : `${feet} ft  ${inches} in`;
}

export interface AnnotateResult extends EditResult {
  text?: string;
}

export interface AnnotationCapabilities {
  label: boolean;
  dimension: boolean;
  dimensionLine: boolean;
}

/**
 * What can be annotated in this plan.
 *
 * Both are now always true — anything missing a template is synthesized — so
 * this reports whether a *template* was found rather than whether the operation
 * is available. Callers use it to say whether new annotation will match the
 * sheet's existing styling or fall back to the defaults.
 */
export function annotationCapabilities(doc: RVDocument): AnnotationCapabilities {
  const label =
    findTemplate(doc, 'RVLabel', (node) => node.fields.textAt != null && node.points.length > 0) != null;
  const dimensionLine =
    findTemplate(
      doc,
      'RVDimensionLine',
      (node) => node.fields.pointsAt != null && node.fields.pointCount === 2,
    ) != null;
  return { label, dimensionLine, dimension: label && dimensionLine };
}

/** Where a newly synthesized annotation object should live. */
function annotationHost(doc: RVDocument): RVNode | null {
  let best: RVNode | null = null;
  const seen = new Set<RVNode>();
  const stack = [...doc.roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.fields.childCountAt != null && (node.cls === 'RVRoomDef' || node.cls === 'RVRoom')) {
      if (!best) best = node;
    }
    for (const child of node.children) stack.push(child);
  }
  return best;
}

/** Adds a freshly built object wherever this plan can take one. */
function placeNew(doc: RVDocument, node: RVNode): EditResult {
  const host = annotationHost(doc);
  return host ? appendChild(doc, host, node) : addRoot(doc, node);
}

/** Rewrites the two endpoints of an existing legacy dimension line. */
export function setDimensionGeometry(
  doc: RVDocument,
  node: RVNode,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EditResult {
  if (node.cls !== 'RVDimensionLine' || node.fields.pointsAt == null) {
    return { ok: false, reason: 'the dimension line has no writable geometry' };
  }
  const header =
    node.headerOverride ??
    (node.headerOverride = Buffer.from(doc.source.subarray(node.span.bodyAt, node.span.headerEnd)));
  const at = node.fields.pointsAt - node.span.bodyAt;
  if (at < 0 || at + 32 > header.length) {
    return { ok: false, reason: 'the dimension line has no writable geometry' };
  }
  header.writeDoubleLE(x1, at);
  header.writeDoubleLE(y1, at + 8);
  header.writeDoubleLE(x2, at + 16);
  header.writeDoubleLE(y2, at + 24);
  node.points = [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ];
  return { ok: true };
}

/**
 * Writes a text label at a point.
 *
 * Multi-line text is supported the way the corpus stores it, with a carriage
 * return and newline between lines — "SoloFrame\r\n1500 on Case".
 */
export function createLabel(
  doc: RVDocument,
  index: DocumentIndex,
  text: string,
  x: number,
  y: number,
): AnnotateResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'enter some text' };

  const template = findTemplate(doc, 'RVLabel', (n) => n.fields.textAt != null && n.points.length > 0);
  if (!template) {
    // No label to copy: build one. This is the empty-plan case, and refusing
    // it was the single most common reason annotation was unavailable.
    const built = synthesizeLabel(doc, { text: trimmed, x, y });
    if (!built.ok || !built.node) return { ok: false, reason: built.reason };
    const added = placeNew(doc, built.node);
    if (!added.ok) return added;
    return { ok: true, created: [built.node.id], text: trimmed };
  }

  const copy = duplicateNode(doc, index, template, 0, 0);
  if (!copy.ok || !copy.created?.length) return copy;

  const node = findById(doc, copy.created[0]);
  if (!node) return { ok: false, reason: 'the new label could not be located' };

  const anchor = node.points[0];
  if (anchor) moveNode(doc, node, x - anchor.x, y - anchor.y);

  const renamed = relabelNode(doc, node, trimmed.replace(/\r?\n/g, '\r\n'));
  if (!renamed.ok) return { ...renamed, created: copy.created };

  return { ok: true, created: copy.created, text: trimmed };
}

/**
 * Draws a dimension between two points.
 *
 * The corpus pairs a dimension line with a separate text label carrying the
 * measurement, which is why "22 ft  0 in" shows up as a label rather than as
 * part of the line — so both are created here.
 */
export function createDimension(
  doc: RVDocument,
  index: DocumentIndex,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  system: UnitSystem = 'imperial',
): AnnotateResult {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < UNITS_PER_FOOT / 12) return { ok: false, reason: 'those two points are the same' };

  const template = findTemplate(
    doc,
    'RVDimensionLine',
    (n) => n.fields.pointsAt != null && n.fields.pointCount === 2,
  );

  const created: number[] = [];

  if (template) {
    const copy = duplicateNode(doc, index, template, 0, 0);
    if (!copy.ok || !copy.created?.length) return copy;

    const node = findById(doc, copy.created[0]);
    if (!node || node.fields.pointsAt == null) {
      return { ok: false, reason: 'the new dimension could not be located' };
    }
    const geometry = setDimensionGeometry(doc, node, x1, y1, x2, y2);
    if (!geometry.ok) return geometry;
    created.push(...copy.created);
  } else {
    const built = createSegment(doc, {
      cls: 'RVDimensionLine',
      points: [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
    });
    if (!built.ok || !built.node) return { ok: false, reason: built.reason };
    const added = placeNew(doc, built.node);
    if (!added.ok) return added;
    created.push(built.node.id);
  }

  const text = formatDistance(length, system);

  // The measurement itself is a label at the midpoint, matching how these
  // drawings are put together.
  const label = createLabel(doc, index, text, (x1 + x2) / 2, (y1 + y2) / 2);
  if (!label.ok) {
    // The Session transaction wrapper restores the checkpoint when this
    // failure is returned, leaving neither a line nor a partial label behind.
    return { ok: false, reason: label.reason ?? 'the dimension label could not be created' };
  }
  if (label.created) created.push(...label.created);

  return { ok: true, created, text };
}
