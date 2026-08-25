/**
 * Editing operations on a parsed document.
 *
 * Every operation works by copying an object's original bytes and patching
 * only the fields it means to change. Nothing is rebuilt from the decoded
 * model, so pen styles, fill patterns, seat counts and the many fields this
 * project never identified all survive an edit untouched.
 *
 * Structural changes (delete, duplicate) do not rewrite bytes at all: they
 * change the child slot list, and the serializer renumbers the tag stream.
 */

import type { RVDocument, RVNode } from './rv.js';

export type EditKind = 'move' | 'delete' | 'duplicate' | 'recolor' | 'relabel' | 'rotate' | 'resize' | 'flip';

export interface LabelStylePatch {
  family?: string;
  /** User-facing size in points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeOut?: boolean;
  /** Absolute clockwise rotation in degrees. */
  angleDegrees?: number;
}

export interface EditResult {
  ok: boolean;
  reason?: string;
  /** Ids of objects the operation created. */
  created?: number[];
}

/** Index of every object by id, plus each object's parent. */
export interface DocumentIndex {
  byId: Map<number, RVNode>;
  parentOf: Map<RVNode, RVNode>;
  /** Objects referenced from more than one slot — editing these is refused. */
  shared: Set<RVNode>;
}

export function indexDocument(doc: RVDocument): DocumentIndex {
  const byId = new Map<number, RVNode>();
  const parentOf = new Map<RVNode, RVNode>();
  const refCount = new Map<RVNode, number>();
  const shared = new Set<RVNode>();

  const visit = (node: RVNode) => {
    if (byId.has(node.id)) return;
    byId.set(node.id, node);
    for (const slot of node.slots) {
      if (!slot.node) continue;
      refCount.set(slot.node, (refCount.get(slot.node) ?? 0) + 1);
      if ((refCount.get(slot.node) ?? 0) > 1 || slot.kind === 'ref') shared.add(slot.node);
      if (!parentOf.has(slot.node)) parentOf.set(slot.node, node);
      visit(slot.node);
    }
  };

  for (const root of doc.roots) visit(root);
  return { byId, parentOf, shared };
}

/** Returns the object's header bytes, making a private copy on first edit. */
function editableHeader(doc: RVDocument, node: RVNode): Buffer {
  if (!node.headerOverride) {
    node.headerOverride = Buffer.from(doc.source.subarray(node.span.bodyAt, node.span.headerEnd));
  }
  return node.headerOverride;
}

/** Converts an absolute stream offset to an index into the header buffer. */
function rel(node: RVNode, absolute: number): number {
  return absolute - node.span.bodyAt;
}

function canWriteAt(node: RVNode, header: Buffer, absolute: number | undefined, size: number): boolean {
  if (absolute == null) return false;
  const at = rel(node, absolute);
  return at >= 0 && at + size <= header.length;
}

/**
 * Translates an object and everything it contains.
 *
 * A placed shape stores its outline in local coordinates, so moving it is a
 * single change to its insertion point — the geometry follows. Free-drawn
 * geometry stores absolute coordinates, so each point moves. The cached bounds
 * rect is updated too, because Room Viewer uses it for hit-testing.
 */
export function moveNode(doc: RVDocument, node: RVNode, dx: number, dy: number, depth = 0): EditResult {
  if (depth > 64) return { ok: false, reason: 'object nests too deeply to move' };
  if (dx === 0 && dy === 0) return { ok: true };

  const header = editableHeader(doc, node);
  let touched = false;

  // Cached bounds, in whole logical units.
  if (canWriteAt(node, header, node.fields.boundsAt, 16)) {
    const at = rel(node, node.fields.boundsAt);
    header.writeInt32LE(Math.round(header.readInt32LE(at) + dx), at);
    header.writeInt32LE(Math.round(header.readInt32LE(at + 4) + dy), at + 4);
    header.writeInt32LE(Math.round(header.readInt32LE(at + 8) + dx), at + 8);
    header.writeInt32LE(Math.round(header.readInt32LE(at + 12) + dy), at + 12);
    node.bounds = {
      left: node.bounds.left + Math.round(dx),
      top: node.bounds.top + Math.round(dy),
      right: node.bounds.right + Math.round(dx),
      bottom: node.bounds.bottom + Math.round(dy),
    };
    touched = true;
  }

  if (node.cls === 'RVShape' || node.cls === 'RVLabel') {
    // The insertion point places the whole object; children are relative to it.
    if (canWriteAt(node, header, node.fields.placementAt, 16)) {
      const at = rel(node, node.fields.placementAt!);
      header.writeDoubleLE(header.readDoubleLE(at) + dx, at);
      header.writeDoubleLE(header.readDoubleLE(at + 8) + dy, at + 8);
      if (node.points[0]) {
        node.points[0] = { x: node.points[0].x + dx, y: node.points[0].y + dy };
      }
      return { ok: true };
    }
    return { ok: false, reason: `${node.cls} has no writable insertion point` };
  }

  if (node.fields.pointsAt != null && node.fields.pointCount) {
    const at = rel(node, node.fields.pointsAt);
    for (let i = 0; i < node.fields.pointCount; i++) {
      const px = at + i * 16;
      if (px + 16 > header.length) break;
      header.writeDoubleLE(header.readDoubleLE(px) + dx, px);
      header.writeDoubleLE(header.readDoubleLE(px + 8) + dy, px + 8);
    }
    node.points = node.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    touched = true;
  }

  for (const slot of node.slots) {
    // A shared instance must not be moved through one of its owners.
    if (slot.kind !== 'object' || !slot.node) continue;
    const r = moveNode(doc, slot.node, dx, dy, depth + 1);
    if (r.ok) touched = true;
  }

  return touched ? { ok: true } : { ok: false, reason: `${node.cls} has no movable geometry` };
}

/** Rewrites a container's child-count WORD after its slot list changes. */
function writeChildCount(doc: RVDocument, parent: RVNode): boolean {
  if (parent.fields.childCountAt == null) return false;
  const header = editableHeader(doc, parent);
  const at = rel(parent, parent.fields.childCountAt);
  if (at < 0 || at + 2 > header.length) return false;
  header.writeUInt16LE(parent.slots.length, at);
  return true;
}

/** Removes a top-level object from the document's part list. */
function removeRoot(doc: RVDocument, node: RVNode): boolean {
  const at = doc.parts.findIndex((p) => p.kind === 'node' && p.node === node);
  if (at === -1) return false;
  doc.parts.splice(at, 1);
  doc.roots = doc.roots.filter((r) => r !== node);
  return true;
}

export function deleteNode(doc: RVDocument, index: DocumentIndex, node: RVNode): EditResult {
  const parent = index.parentOf.get(node);
  if (!parent) {
    // Many items sit at document level rather than inside a room container.
    if (index.shared.has(node)) {
      return { ok: false, reason: 'this object is shared by other items and cannot be deleted on its own' };
    }
    return removeRoot(doc, node)
      ? { ok: true }
      : { ok: false, reason: 'object is not part of the document' };
  }
  if (index.shared.has(node)) {
    return { ok: false, reason: 'this object is shared by other items and cannot be deleted on its own' };
  }
  if (parent.fields.childCountAt == null) {
    return { ok: false, reason: `${parent.cls} does not store a child count that can be updated` };
  }

  const at = parent.slots.findIndex((s) => s.node === node);
  if (at === -1) return { ok: false, reason: 'object is not in its parent list' };

  parent.slots.splice(at, 1);
  parent.children = parent.slots.filter((s) => s.node).map((s) => s.node!);
  if (!writeChildCount(doc, parent)) return { ok: false, reason: 'could not update the parent child count' };
  return { ok: true };
}

/**
 * Deep-copies a subtree, giving every object a fresh id.
 *
 * `remap` maps each original node to its clone so self-referential `ref`
 * slots (a room pointing at itself from its child list) retarget into the
 * copy rather than leaking a pointer back into the source object.
 */
function cloneSubtree(
  node: RVNode,
  nextId: () => number,
  created: number[],
  remap: Map<RVNode, RVNode> = new Map(),
): RVNode {
  const copy: RVNode = {
    ...node,
    id: nextId(),
    bounds: { ...node.bounds },
    points: node.points.map((p) => ({ ...p })),
    labels: [...node.labels],
    fields: { ...node.fields },
    font: node.font ? { ...node.font } : undefined,
    headerOverride: node.headerOverride ? Buffer.from(node.headerOverride) : undefined,
    slots: [],
    children: [],
  };
  created.push(copy.id);
  remap.set(node, copy);

  for (const slot of node.slots) {
    if (slot.kind === 'object' && slot.node) {
      const child = cloneSubtree(slot.node, nextId, created, remap);
      copy.slots.push({ kind: 'object', node: child });
      copy.children.push(child);
    } else if (slot.kind === 'ref' && slot.refTarget && remap.has(slot.refTarget)) {
      // Parent-pointer / cyclic ref whose target was cloned with this subtree.
      copy.slots.push({ ...slot, refTarget: remap.get(slot.refTarget) });
    } else {
      // Shared external refs and null slots are reproduced as-is.
      copy.slots.push({ ...slot });
      if (slot.node) copy.children.push(slot.node);
    }
  }
  return copy;
}

export function duplicateNode(
  doc: RVDocument,
  index: DocumentIndex,
  node: RVNode,
  dx: number,
  dy: number,
): EditResult {
  const parent = index.parentOf.get(node);
  if (parent && parent.fields.childCountAt == null) {
    return { ok: false, reason: `${parent.cls} does not store a child count that can be updated` };
  }

  // Ids come from the document so repeated calls against one index — which is
  // what any generator does — cannot hand out the same id twice.
  const nextId = () => doc.nextId++;

  const created: number[] = [];
  const copy = cloneSubtree(node, nextId, created);

  if (!parent) {
    const at = doc.parts.findIndex((p) => p.kind === 'node' && p.node === node);
    if (at === -1) return { ok: false, reason: 'object is not part of the document' };
    doc.parts.splice(at + 1, 0, { kind: 'node', node: copy });
    doc.roots.splice(doc.roots.indexOf(node) + 1, 0, copy);
    moveNode(doc, copy, dx, dy);
    return { ok: true, created };
  }

  const at = parent.slots.findIndex((s) => s.node === node);
  parent.slots.splice(at + 1, 0, { kind: 'object', node: copy });
  parent.children = parent.slots.filter((s) => s.node).map((s) => s.node!);
  if (!writeChildCount(doc, parent)) return { ok: false, reason: 'could not update the parent child count' };

  moveNode(doc, copy, dx, dy);
  return { ok: true, created };
}


/**
 * Rewrites a segment's coordinates in place.
 *
 * The point count cannot change: the array is embedded in a header whose
 * surrounding bytes carry pen and fill fields, and the parser locates the array
 * by its length. A caller that needs a different number of points has to
 * replace the object rather than edit it, which is why this reports failure
 * instead of resizing.
 */
export function setPoints(doc: RVDocument, node: RVNode, points: Array<{ x: number; y: number }>): EditResult {
  if (node.fields.pointsAt == null || !node.fields.pointCount) {
    return { ok: false, reason: `${node.cls} has no editable point array` };
  }
  if (points.length !== node.fields.pointCount) {
    return {
      ok: false,
      reason: `${node.cls} holds ${node.fields.pointCount} points, not ${points.length}`,
    };
  }
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return { ok: false, reason: 'points must be finite' };
  }

  const header = editableHeader(doc, node);
  const at = rel(node, node.fields.pointsAt);
  if (at < 0 || at + points.length * 16 > header.length) {
    return { ok: false, reason: 'the point array is outside the decoded region' };
  }

  points.forEach((p, i) => {
    header.writeDoubleLE(p.x, at + i * 16);
    header.writeDoubleLE(p.y, at + i * 16 + 8);
  });
  node.points = points.map((p) => ({ ...p }));

  const box = localBounds(node);
  if (box) setBounds(doc, node, box.minX, box.minY, box.maxX, box.maxY);
  return { ok: true };
}

/**
 * Adds an object to a container's child list.
 *
 * The counterpart to `deleteNode`, and the way anything built by `synthesize.ts`
 * enters a document. The child count is the only byte that changes: the tag
 * stream is rebuilt from the slot list when the document is serialized.
 */
export function appendChild(doc: RVDocument, parent: RVNode, node: RVNode, at?: number): EditResult {
  if (parent.fields.childCountAt == null) {
    return { ok: false, reason: `${parent.cls} does not store a child count that can be updated` };
  }
  if (parent === node) return { ok: false, reason: 'an object cannot contain itself' };
  if (parent.slots.length >= 20000) {
    return { ok: false, reason: `${parent.cls} already holds as many children as the format allows` };
  }

  const index = at == null ? parent.slots.length : Math.max(0, Math.min(at, parent.slots.length));
  parent.slots.splice(index, 0, { kind: 'object', node });
  parent.children = parent.slots.filter((s) => s.node).map((s) => s.node!);

  if (!writeChildCount(doc, parent)) {
    // Put it back rather than leaving the list and the declared count disagreeing.
    parent.slots.splice(index, 1);
    parent.children = parent.slots.filter((s) => s.node).map((s) => s.node!);
    return { ok: false, reason: 'could not update the parent child count' };
  }
  return { ok: true, created: [node.id] };
}

/**
 * Adds an object at document level, after `after` when given.
 *
 * Room Viewer plans keep most items inside a room container, but placed shapes
 * and labels sit at document level in many files, so this is a real position
 * rather than a fallback.
 */
export function addRoot(doc: RVDocument, node: RVNode, after?: RVNode): EditResult {
  if (after) {
    const at = doc.parts.findIndex((p) => p.kind === 'node' && p.node === after);
    if (at === -1) return { ok: false, reason: 'the object to insert after is not in the document' };
    doc.parts.splice(at + 1, 0, { kind: 'node', node });
    doc.roots.splice(doc.roots.indexOf(after) + 1, 0, node);
    return { ok: true, created: [node.id] };
  }

  // Default to the end of the last object rather than the true end of the part
  // list, which is the document trailer — plan name, ceiling notes, defaults.
  let at = doc.parts.length;
  for (let i = doc.parts.length - 1; i >= 0; i--) {
    if (doc.parts[i].kind === 'node') {
      at = i + 1;
      break;
    }
  }
  doc.parts.splice(at, 0, { kind: 'node', node });
  doc.roots.push(node);
  return { ok: true, created: [node.id] };
}

/**
 * Moves an object to the front or the back of its parent's child list.
 *
 * Draw order in this format *is* slot order — later children are drawn over
 * earlier ones — so bringing something forward is a reordering of the list and
 * not a property on the object. No bytes change except the parent's child
 * count, which does not move; the serializer rebuilds the tag stream from the
 * new order.
 */
export function reorderChild(
  doc: RVDocument,
  index: DocumentIndex,
  node: RVNode,
  to: 'front' | 'back',
): EditResult {
  const parent = index.parentOf.get(node);
  if (!parent) {
    // A document-level object reorders among the document's parts instead.
    const at = doc.parts.findIndex((p) => p.kind === 'node' && p.node === node);
    if (at === -1) return { ok: false, reason: 'object is not part of the document' };

    const [part] = doc.parts.splice(at, 1);
    // Never past the trailing raw region: that is the document's own metadata,
    // not something an object may be placed after.
    let last = doc.parts.length;
    for (let i = doc.parts.length - 1; i >= 0; i--) {
      if (doc.parts[i].kind === 'node') {
        last = i + 1;
        break;
      }
    }
    let first = 0;
    for (let i = 0; i < doc.parts.length; i++) {
      if (doc.parts[i].kind === 'node') {
        first = i;
        break;
      }
    }
    doc.parts.splice(to === 'front' ? last : first, 0, part);

    doc.roots = doc.roots.filter((r) => r !== node);
    if (to === 'front') doc.roots.push(node);
    else doc.roots.unshift(node);
    return { ok: true };
  }

  const at = parent.slots.findIndex((s) => s.node === node);
  if (at === -1) return { ok: false, reason: 'object is not in its parent list' };
  if (parent.slots.length < 2) return { ok: true };
  if ((to === 'front' && at === parent.slots.length - 1) || (to === 'back' && at === 0)) {
    return { ok: true };
  }

  const [slot] = parent.slots.splice(at, 1);
  if (to === 'front') parent.slots.push(slot);
  else parent.slots.unshift(slot);
  parent.children = parent.slots.filter((s) => s.node).map((s) => s.node!);
  return { ok: true };
}

/**
 * Applies a transform to every coordinate a subtree owns.
 *
 * Placed items keep their outline in local coordinates around the origin, so
 * rotating or scaling one means rewriting those points — the insertion point is
 * left alone and the item stays where it was put. Points are patched in place,
 * which keeps every byte around them intact.
 */
function transformGeometry(
  doc: RVDocument,
  node: RVNode,
  fn: (x: number, y: number) => [number, number],
  depth = 0,
): boolean {
  if (depth > 64) return false;
  let touched = false;

  if (node.fields.pointsAt != null && node.fields.pointCount) {
    const header = editableHeader(doc, node);
    const at = rel(node, node.fields.pointsAt);
    const next: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < node.fields.pointCount; i++) {
      const px = at + i * 16;
      if (px + 16 > header.length) break;
      const [x, y] = fn(header.readDoubleLE(px), header.readDoubleLE(px + 8));
      header.writeDoubleLE(x, px);
      header.writeDoubleLE(y, px + 8);
      next.push({ x, y });
    }
    if (next.length) {
      node.points = next;
      touched = true;
    }
  }

  for (const slot of node.slots) {
    if (slot.kind !== 'object' || !slot.node) continue;
    if (transformGeometry(doc, slot.node, fn, depth + 1)) touched = true;
  }
  return touched;
}

/** Bounding box of a subtree's local geometry. */
function localBounds(node: RVNode, depth = 0): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (depth > 64) return null;
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  const add = (x: number, y: number) => {
    if (!box) box = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
    }
  };

  // An arc carries eight points but only the last four are drawn — the leading
  // four are control data that never reaches the page. Measuring all eight
  // reports a box the shape does not occupy: an 8ft circular deck came out 27ft
  // across, and an 18in round table six feet. The renderer already takes the
  // last four; measurement has to agree with it or the two describe different
  // shapes.
  const drawn =
    node.cls === 'RVSegmentArc' && node.points.length >= 4 ? node.points.slice(-4) : node.points;
  for (const p of drawn) add(p.x, p.y);
  for (const slot of node.slots) {
    if (slot.kind !== 'object' || !slot.node) continue;
    const inner = localBounds(slot.node, depth + 1);
    if (inner) {
      add(inner.minX, inner.minY);
      add(inner.maxX, inner.maxY);
    }
  }
  return box;
}

/**
 * Measures an object's real footprint.
 *
 * Segments carry a zeroed `CRect` — their size lives in the point array — so
 * reading the cached rect reports nothing for a wall, a booth or any free
 * geometry. Measuring the points is the only reliable answer.
 */
export function measureNode(node: RVNode): { width: number; height: number } {
  // A placed shape keeps its insertion point in absolute coordinates and its
  // outline local to that point. Handing the shape itself to `localBounds`
  // unions the two spaces and measures from the plan origin out to the shape
  // instead of measuring the shape: a 42ft stage placed 101ft along the room
  // reports 143ft 6in. Measure the geometry alone, which is the same thing
  // `refreshShapeBounds` does when it writes the rect back.
  const geometry = node.children.find((child) => child.cls === 'RVGeometry');
  const box = localBounds(geometry ?? node);
  if (box && box.maxX > box.minX && box.maxY > box.minY) {
    return { width: box.maxX - box.minX, height: box.maxY - box.minY };
  }
  // Nothing measurable. A catalogue shape keeps its outline behind a shared
  // reference the parser does not follow, so its geometry is an empty husk and
  // the points collapse to the insertion point — an 8ft circle measures zero.
  // The stored rect is the better answer, and it is the difference between
  // "resize to 6ft" working and being refused for having no size.
  return {
    width: node.bounds.right - node.bounds.left,
    height: node.bounds.bottom - node.bounds.top,
  };
}

/**
 * The object's OWN rectangle — width, height, and the angle it is drawn at.
 *
 * `node.angle` cannot answer this. `rotateNode` turns the outline *and* adds the
 * delta to that field, so it is a running total of the turns applied since
 * placement rather than an absolute facing: a chair whose symbol was drawn at
 * -120 degrees still reads 0, and one turned repeatedly reads 512. Reporting it
 * as an absolute angle put "512" in the Properties panel next to a chair that is
 * visibly at 32 degrees.
 *
 * The outline knows. Measuring it recovers the angle the user can actually see,
 * and the object's real side lengths instead of the axis-aligned box that
 * `measureNode` returns — a 20.5x23.2in chair at -120 degrees boxes to 30.4x29.4.
 *
 * Only a true rectangle is recovered: four corners with square adjacent edges.
 * A round table or a traced speaker outline has no meaningful own rectangle, so
 * this returns null and callers keep the axis-aligned box.
 */
export function orientedExtent(
  node: RVNode,
): { width: number; height: number; angleRadians: number } | null {
  const geometry = node.children.find((child) => child.cls === 'RVGeometry');
  const root = geometry ?? node;

  // A symbol is rarely one rectangle — a chair is a seat plus a back — so the
  // angle comes from the largest rectangular part and the size is then measured
  // in that part's frame, covering every point in the outline.
  let best: { angle: number; area: number } | null = null;
  const consider = (m: RVNode, depth = 0): void => {
    if (depth > 64) return;
    // A closed ring repeats its first point at the end — an 8x4 riser is stored
    // as five points, not four, and dropping it here left every synthesized
    // rectangle measured by its bounding box.
    const raw = m.points;
    const c =
      raw.length === 5 && Math.hypot(raw[4].x - raw[0].x, raw[4].y - raw[0].y) < 1e-6
        ? raw.slice(0, 4)
        : raw;
    if (c.length === 4) {
      const edge = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: b.x - a.x, y: b.y - a.y });
      const e0 = edge(c[0], c[1]);
      const e1 = edge(c[1], c[2]);
      const e2 = edge(c[2], c[3]);
      const e3 = edge(c[3], c[0]);
      const w = Math.hypot(e0.x, e0.y);
      const h = Math.hypot(e1.x, e1.y);
      const square = Math.abs(e0.x * e1.x + e0.y * e1.y) <= w * h * 1e-3;
      const closed =
        Math.abs(Math.hypot(e2.x, e2.y) - w) <= Math.max(1e-6, w * 1e-3) &&
        Math.abs(Math.hypot(e3.x, e3.y) - h) <= Math.max(1e-6, h * 1e-3);
      if (w > 1e-6 && h > 1e-6 && square && closed && (!best || w * h > best.area)) {
        best = { angle: Math.atan2(e0.y, e0.x), area: w * h };
      }
    }
    for (const child of m.children) consider(child, depth + 1);
  };
  consider(root);
  if (!best) return null;

  const { angle } = best;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  const add = (m: RVNode, depth = 0): void => {
    if (depth > 64) return;
    for (const q of m.points) {
      const x = q.x * cos - q.y * sin;
      const y = q.x * sin + q.y * cos;
      box = box
        ? {
            minX: Math.min(box.minX, x),
            minY: Math.min(box.minY, y),
            maxX: Math.max(box.maxX, x),
            maxY: Math.max(box.maxY, y),
          }
        : { minX: x, minY: y, maxX: x, maxY: y };
    }
    for (const child of m.children) add(child, depth + 1);
  };
  add(root);
  if (!box) return null;
  const extent: { minX: number; minY: number; maxX: number; maxY: number } = box;
  const width = extent.maxX - extent.minX;
  const height = extent.maxY - extent.minY;
  if (width < 1e-6 || height < 1e-6) return null;
  return { width, height, angleRadians: angle };
}

/** Rewrites a node's cached bounds rect. */
function setBounds(doc: RVDocument, node: RVNode, l: number, t: number, r2: number, b: number): void {
  if (node.fields.boundsAt == null) return;
  const header = editableHeader(doc, node);
  const at = rel(node, node.fields.boundsAt);
  if (at < 0 || at + 16 > header.length) return;
  header.writeInt32LE(Math.round(l), at);
  header.writeInt32LE(Math.round(t), at + 4);
  header.writeInt32LE(Math.round(r2), at + 8);
  header.writeInt32LE(Math.round(b), at + 12);
  node.bounds = { left: Math.round(l), top: Math.round(t), right: Math.round(r2), bottom: Math.round(b) };
}

/** Refreshes the bounds of a placed shape and its geometry after a transform. */
function refreshShapeBounds(doc: RVDocument, node: RVNode): void {
  const anchor = node.points[0];
  const geometry = node.children.find((c) => c.cls === 'RVGeometry');
  const box = localBounds(geometry ?? node);
  if (!box || !anchor) return;

  if (geometry) setBounds(doc, geometry, box.minX, box.minY, box.maxX, box.maxY);
  // The shape's own rect is absolute; the geometry's is local to it.
  const cx = (node.bounds.left + node.bounds.right) / 2;
  const cy = (node.bounds.top + node.bounds.bottom) / 2;
  setBounds(doc, node, cx + box.minX, cy + box.minY, cx + box.maxX, cy + box.maxY);
}

/** World-space centre of a placed node (bounds midpoint). */
export function nodeCentre(node: RVNode): { x: number; y: number } | null {
  const box = node.bounds;
  if (!box) return null;
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

/**
 * Rotates a placed item about an arbitrary world pivot.
 *
 * The placement orbits the pivot, then the outline spins about the item's own
 * centre — so a selected bank of chairs turns as one piece (angled wings)
 * instead of each chair spinning in place on a fixed grid.
 */
export function rotateNodeAbout(
  doc: RVDocument,
  node: RVNode,
  radians: number,
  pivot: { x: number; y: number },
): EditResult {
  if (!radians) return { ok: true };
  const centre = nodeCentre(node);
  if (!centre) return rotateNode(doc, node, radians);

  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = centre.x - pivot.x;
  const dy = centre.y - pivot.y;
  const nx = pivot.x + dx * cos - dy * sin;
  const ny = pivot.y + dx * sin + dy * cos;
  const moved = moveNode(doc, node, nx - centre.x, ny - centre.y);
  if (!moved.ok) return moved;
  return rotateNode(doc, node, radians);
}

/**
 * Rotates a placed item by `radians`, clockwise on screen.
 *
 * The stored outline is already rotated — an instance turned 90 degrees is
 * saved turned — so rotating means transforming the points themselves rather
 * than setting a field the renderer would honour.
 */
export function rotateNode(doc: RVDocument, node: RVNode, radians: number): EditResult {
  if (!radians) return { ok: true };
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const target = node.cls === 'RVShape' ? (node.children.find((c) => c.cls === 'RVGeometry') ?? node) : node;

  if (node.cls === 'RVShape') {
    const turned = transformGeometry(doc, target, (x, y) => [x * cos - y * sin, x * sin + y * cos]);
    if (!turned) return { ok: false, reason: 'this item has no outline to rotate' };

    if (node.fields.angleAt != null) {
      const header = editableHeader(doc, node);
      const at = rel(node, node.fields.angleAt);
      if (at >= 0 && at + 8 <= header.length) {
        const angle = header.readDoubleLE(at) + radians;
        header.writeDoubleLE(angle, at);
        node.angle = angle;
      }
    }
    refreshShapeBounds(doc, node);
    return { ok: true };
  }

  // Free geometry is in absolute coordinates, so it turns about its own centre.
  const box = localBounds(node);
  if (!box) return { ok: false, reason: 'this item has no geometry to rotate' };
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;

  const turned = transformGeometry(doc, node, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
  if (!turned) return { ok: false, reason: 'this item has no geometry to rotate' };

  const after = localBounds(node)!;
  setBounds(doc, node, after.minX, after.minY, after.maxX, after.maxY);
  return { ok: true };
}

/**
 * Scales a placed item about its centre.
 *
 * Scale factors are relative to the item's current size, so 2 doubles it.
 */
export function resizeNode(doc: RVDocument, node: RVNode, scaleX: number, scaleY: number): EditResult {
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return { ok: false, reason: 'invalid scale' };
  if (scaleX <= 0.01 || scaleY <= 0.01 || scaleX > 100 || scaleY > 100) {
    return { ok: false, reason: 'scale is out of range' };
  }
  if (scaleX === 1 && scaleY === 1) return { ok: true };

  if (node.cls === 'RVShape') {
    const geometry = node.children.find((c) => c.cls === 'RVGeometry');
    if (!geometry) return { ok: false, reason: 'this item has no outline to resize' };
    // Scaling on world axes shears anything that is not axis-aligned: asking a
    // 20.5x23.2in chair drawn at -120 degrees to double its width returned
    // 27.1x41.9in with 123-degree corners — a parallelogram, not a wider chair.
    // Scale on the object's own axes so width means the width you can see.
    const own = orientedExtent(node);
    const angle = own?.angleRadians ?? 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const scale = angle
      ? (x: number, y: number): [number, number] => {
          const lx = x * cos + y * sin;
          const ly = -x * sin + y * cos;
          const sx = lx * scaleX;
          const sy = ly * scaleY;
          return [sx * cos - sy * sin, sx * sin + sy * cos];
        }
      : (x: number, y: number): [number, number] => [x * scaleX, y * scaleY];
    if (!transformGeometry(doc, geometry, scale)) {
      return { ok: false, reason: 'this item has no outline to resize' };
    }
    refreshShapeBounds(doc, node);
    return { ok: true };
  }

  const box = localBounds(node);
  if (!box) return { ok: false, reason: 'this item has no geometry to resize' };
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;

  if (!transformGeometry(doc, node, (x, y) => [cx + (x - cx) * scaleX, cy + (y - cy) * scaleY])) {
    return { ok: false, reason: 'this item has no geometry to resize' };
  }
  const after = localBounds(node)!;
  setBounds(doc, node, after.minX, after.minY, after.maxX, after.maxY);
  return { ok: true };
}

/**
 * Uniformly scales every root object about the plan origin.
 *
 * Used when a measured dimension on the drawing should become a known real
 * length — the whole plan grows or shrinks so that dimension matches.
 */
export function scalePlanUniform(doc: RVDocument, factor: number): EditResult {
  if (!Number.isFinite(factor) || factor <= 0.01 || factor > 100) {
    return { ok: false, reason: 'scale is out of range' };
  }
  if (Math.abs(factor - 1) < 1e-9) return { ok: true };
  for (const root of doc.roots) {
    if (!transformGeometry(doc, root, (x, y) => [x * factor, y * factor])) {
      // Some roots have no points (containers); still try to scale bounds.
    }
    const box = localBounds(root);
    if (box) setBounds(doc, root, box.minX, box.minY, box.maxX, box.maxY);
    if (root.cls === 'RVShape') refreshShapeBounds(doc, root);
  }
  return { ok: true };
}

/** Mirrors an item about its own centre without changing its footprint. */
export function flipNode(doc: RVDocument, node: RVNode, axis: 'horizontal' | 'vertical'): EditResult {
  if (node.cls === 'RVShape') {
    const geometry = node.children.find((child) => child.cls === 'RVGeometry');
    if (!geometry) return { ok: false, reason: 'this item has no outline to flip' };
    const flipped = transformGeometry(
      doc,
      geometry,
      (x, y) => (axis === 'horizontal' ? [-x, y] : [x, -y]),
    );
    if (!flipped) return { ok: false, reason: 'this item has no outline to flip' };
    refreshShapeBounds(doc, node);
    return { ok: true };
  }

  const box = localBounds(node);
  if (!box) return { ok: false, reason: 'this item has no geometry to flip' };
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const flipped = transformGeometry(doc, node, (x, y) =>
    axis === 'horizontal' ? [cx - (x - cx), y] : [x, cy - (y - cy)],
  );
  if (!flipped) return { ok: false, reason: 'this item has no geometry to flip' };
  const after = localBounds(node)!;
  setBounds(doc, node, after.minX, after.minY, after.maxX, after.maxY);
  return { ok: true };
}

export function recolorNode(doc: RVDocument, node: RVNode, colorRef: number, depth = 0): EditResult {
  if (depth > 64) return { ok: false, reason: 'object nests too deeply' };
  let touched = false;

  if (node.fields.colorAt != null) {
    const header = editableHeader(doc, node);
    const at = rel(node, node.fields.colorAt);
    if (at >= 0 && at + 4 <= header.length) {
      header.writeUInt32LE(colorRef >>> 0, at);
      node.color = colorRef >>> 0;
      touched = true;
    }
  }

  for (const slot of node.slots) {
    if (slot.kind !== 'object' || !slot.node) continue;
    if (recolorNode(doc, slot.node, colorRef, depth + 1).ok) touched = true;
  }

  return touched ? { ok: true } : { ok: false, reason: 'nothing here carries a colour' };
}

/**
 * Replaces a label's text.
 *
 * The text is a length-prefixed string, so changing it resizes the header. The
 * bytes on either side are copied unchanged, which keeps the surrounding
 * LOGFONT and trailing fields intact.
 */
export function relabelNode(doc: RVDocument, node: RVNode, text: string): EditResult {
  if (node.cls !== 'RVLabel') return { ok: false, reason: 'only labels carry editable text' };
  if (node.fields.textAt == null) return { ok: false, reason: 'this label was not decoded precisely enough to edit' };

  const encoded = Buffer.from(text, 'latin1');
  if (encoded.length > 254) return { ok: false, reason: 'label text is too long' };

  const header = editableHeader(doc, node);
  const at = rel(node, node.fields.textAt);
  const oldLen = header[at];
  if (at < 0 || at + 1 + oldLen > header.length) {
    return { ok: false, reason: 'label text is outside the decoded region' };
  }

  const before = header.subarray(0, at);
  const after = header.subarray(at + 1 + oldLen);
  const replacement = Buffer.concat([
    before,
    Buffer.from([encoded.length]),
    encoded,
    after,
  ]);

  node.headerOverride = replacement;
  // Later offsets shift by the length delta.
  const delta = encoded.length - oldLen;
  if (delta !== 0) {
    for (const key of ['pointsAt', 'colorAt', 'childCountAt'] as const) {
      const v = node.fields[key];
      if (v != null && v > node.fields.textAt) node.fields[key] = v + delta;
    }
  }
  node.fields.textLen = encoded.length;

  const idx = node.labels.length >= 2 ? 1 : 0;
  node.labels[idx] = text;
  return { ok: true };
}

/** Applies typography directly to the LOGFONT stored by an RVLabel. */
export function setLabelStyle(
  doc: RVDocument,
  node: RVNode,
  patch: LabelStylePatch,
): EditResult {
  if (node.cls !== 'RVLabel') return { ok: false, reason: 'only text labels carry typography' };
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'the text formatting is invalid' };
  const header = editableHeader(doc, node);
  let touched = false;

  const writeI32 = (absolute: number | undefined, value: number): boolean => {
    if (absolute == null) return false;
    const at = rel(node, absolute);
    if (at < 0 || at + 4 > header.length) return false;
    header.writeInt32LE(value, at);
    return true;
  };
  const writeFlag = (absolute: number | undefined, value: boolean): boolean => {
    if (absolute == null) return false;
    const at = rel(node, absolute);
    if (at < 0 || at >= header.length) return false;
    header.writeUInt8(value ? 1 : 0, at);
    return true;
  };

  if (patch.size != null) {
    if (!Number.isFinite(patch.size) || patch.size < 4 || patch.size > 144) {
      return { ok: false, reason: 'text size must be between 4 and 144 points' };
    }
    const height = -Math.round(patch.size * 10);
    if (!writeI32(node.fields.fontHeightAt, height)) {
      return { ok: false, reason: 'this label has no writable font size' };
    }
    if (node.font) node.font.height = height;
    touched = true;
  }

  if (patch.bold != null) {
    const weight = patch.bold ? 700 : 400;
    if (!writeI32(node.fields.fontWeightAt, weight)) {
      return { ok: false, reason: 'this label has no writable font weight' };
    }
    node.bold = patch.bold;
    if (node.font) node.font.weight = weight;
    touched = true;
  }

  for (const [key, at] of [
    ['italic', node.fields.fontItalicAt],
    ['underline', node.fields.fontUnderlineAt],
    ['strikeOut', node.fields.fontStrikeOutAt],
  ] as const) {
    const value = patch[key];
    if (value == null) continue;
    if (!writeFlag(at, value)) return { ok: false, reason: `this label has no writable ${key} setting` };
    if (node.font) node.font[key] = value;
    touched = true;
  }

  if (patch.family != null) {
    const family = patch.family.trim();
    const encoded = Buffer.from(family, 'latin1');
    if (!family || encoded.length > 63) return { ok: false, reason: 'enter a font name up to 63 characters' };
    if (node.fields.fontFaceAt == null || node.fields.fontFaceLen == null) {
      return { ok: false, reason: 'this label has no writable font family' };
    }
    const at = rel(node, node.fields.fontFaceAt);
    const oldLen = node.fields.fontFaceLen;
    const current = node.headerOverride!;
    if (at < 0 || at + 1 + oldLen > current.length) {
      return { ok: false, reason: 'the font name is outside the decoded label' };
    }
    node.headerOverride = Buffer.concat([
      current.subarray(0, at),
      Buffer.from([encoded.length]),
      encoded,
      current.subarray(at + 1 + oldLen),
    ]);
    const delta = encoded.length - oldLen;
    if (delta !== 0) {
      for (const key of ['textAt', 'colorAt', 'pointsAt', 'childCountAt'] as const) {
        const value = node.fields[key];
        if (value != null && value > node.fields.fontFaceAt) node.fields[key] = value + delta;
      }
    }
    node.fields.fontFaceLen = encoded.length;
    if (node.font) node.font.family = family;
    if (node.labels.length >= 2) node.labels[0] = family;
    else node.labels.unshift(family);
    touched = true;
  }

  if (patch.angleDegrees != null) {
    if (!Number.isFinite(patch.angleDegrees) || Math.abs(patch.angleDegrees) > 3600) {
      return { ok: false, reason: 'text rotation must be between -3600° and 3600°' };
    }
    if (node.fields.angleAt == null) return { ok: false, reason: 'this label has no writable rotation' };
    const at = rel(node, node.fields.angleAt);
    const current = node.headerOverride!;
    if (at < 0 || at + 8 > current.length) {
      return { ok: false, reason: 'the text rotation is outside the decoded label' };
    }
    const angle = (patch.angleDegrees * Math.PI) / 180;
    current.writeDoubleLE(angle, at);
    node.angle = angle;
    touched = true;
  }

  return touched ? { ok: true } : { ok: false, reason: 'choose a text formatting change' };
}

/**
 * Renames a placed shape (catalogue name) or a text label.
 *
 * Placed furniture stores its inventory name as a length-prefixed string at
 * `nameAt`. Labels use `textAt`. One IPC covers both so the Properties panel
 * can offer a single "Name" / "Text" field.
 */
export function renameNode(doc: RVDocument, node: RVNode, name: string): EditResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'enter a name' };

  if (node.cls === 'RVLabel') return relabelNode(doc, node, trimmed);

  if (node.fields.nameAt == null) {
    return { ok: false, reason: 'this object has no editable name' };
  }

  const encoded = Buffer.from(trimmed.slice(0, 254), 'latin1');
  const header = editableHeader(doc, node);
  const at = rel(node, node.fields.nameAt);
  const oldLen = header[at];
  if (at < 0 || at + 1 + oldLen > header.length) {
    return { ok: false, reason: 'the name field is outside the decoded region' };
  }

  node.headerOverride = Buffer.concat([
    header.subarray(0, at),
    Buffer.from([encoded.length]),
    encoded,
    header.subarray(at + 1 + oldLen),
  ]);
  node.fields.nameLen = encoded.length;
  node.labels = [trimmed];
  return { ok: true };
}
