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

  for (const p of node.points) add(p.x, p.y);
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
  const box = localBounds(node);
  if (box) return { width: box.maxX - box.minX, height: box.maxY - box.minY };
  return {
    width: node.bounds.right - node.bounds.left,
    height: node.bounds.bottom - node.bounds.top,
  };
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
    if (!transformGeometry(doc, geometry, (x, y) => [x * scaleX, y * scaleY])) {
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
