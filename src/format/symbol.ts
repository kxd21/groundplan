/**
 * Bringing shapes in from other files.
 *
 * Placing gear that the open plan has never seen produces a labelled box —
 * correct in size, but not the real symbol. The symbols themselves live in the
 * `.se4` shapes and `.add`/`.stk` libraries that ship with Room Viewer, and in
 * every plan already drawn. This imports one across.
 *
 * The trick is that an imported object has no bytes in the destination
 * document. Every node in the subtree therefore carries its own header and
 * trailer, copied from the file it came from, which the serializer emits in
 * place of a slice of the destination's source.
 */

import type { RVDocument, RVNode } from './rv.js';
import { measureNode, type DocumentIndex, type EditResult } from './edit.js';

export interface SymbolSource {
  /** Catalogue name as stored in the file. */
  name: string;
  width: number;
  height: number;
}

/** Lists the named shapes a file can contribute, with their real footprints. */
export function listSymbols(doc: RVDocument): SymbolSource[] {
  const byName = new Map<string, SymbolSource>();
  const seen = new Set<RVNode>();
  const stack = [...doc.roots];

  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (node.cls === 'RVShape' && node.fields.nameAt != null) {
      const name = node.labels.find(
        (l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l),
      );
      const geometry = node.children.find((c) => c.cls === 'RVGeometry');
      if (name && geometry && !byName.has(name)) {
        const size = measureNode(geometry);
        if (size.width > 0 && size.height > 0) {
          byName.set(name, { name, width: size.width, height: size.height });
        }
      }
    }
    for (const child of node.children) stack.push(child);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds a named shape in a source document. */
export function findSymbol(doc: RVDocument, name: string): RVNode | null {
  const want = name.trim().toLowerCase();
  const seen = new Set<RVNode>();
  const stack = [...doc.roots];

  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (node.cls === 'RVShape' && node.children.some((c) => c.cls === 'RVGeometry')) {
      const label = node.labels.find(
        (l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l),
      );
      if (label && label.trim().toLowerCase() === want) return node;
    }
    for (const child of node.children) stack.push(child);
  }
  return null;
}

/**
 * Deep-copies a subtree out of one document so it can live in another.
 *
 * Each copy takes its bytes with it, which is what makes it independent of the
 * file it came from.
 */
function detach(node: RVNode, source: RVDocument, nextId: () => number, created: number[]): RVNode {
  const copy: RVNode = {
    ...node,
    id: nextId(),
    bounds: { ...node.bounds },
    points: node.points.map((p) => ({ ...p })),
    labels: [...node.labels],
    fields: { ...node.fields },
    headerOverride: Buffer.from(
      node.headerOverride ?? source.source.subarray(node.span.bodyAt, node.span.headerEnd),
    ),
    trailerOverride: Buffer.from(
      node.trailerOverride ?? source.source.subarray(node.span.trailerAt, node.span.end),
    ),
    slots: [],
    children: [],
  };
  created.push(copy.id);

  for (const slot of node.slots) {
    if (slot.kind === 'object' && slot.node) {
      const child = detach(slot.node, source, nextId, created);
      copy.slots.push({ kind: 'object', node: child });
      copy.children.push(child);
    } else if (slot.kind === 'null') {
      copy.slots.push({ kind: 'null', node: null });
    }
    // Reference slots are dropped: they point into the source file's load
    // array, which means nothing here.
  }
  return copy;
}

/** Where a newly imported object should live in the destination. */
function findHost(doc: RVDocument): RVNode | null {
  let best: { node: RVNode; count: number } | null = null;
  const seen = new Set<RVNode>();
  const stack = [...doc.roots];

  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (node.fields.childCountAt != null && (node.cls === 'RVRoomDef' || node.cls === 'RVRoom')) {
      const count = node.children.filter((c) => c.cls === 'RVShape').length;
      if (!best || count > best.count) best = { node, count };
    }
    for (const child of node.children) stack.push(child);
  }
  return best?.node ?? null;
}

export interface ImportResult extends EditResult {
  name?: string;
}

/**
 * Imports a named shape from another document and places it at a point.
 */
export function importSymbol(
  doc: RVDocument,
  index: DocumentIndex,
  source: RVDocument,
  name: string,
  x: number,
  y: number,
): ImportResult {
  const original = findSymbol(source, name);
  if (!original) return { ok: false, reason: `"${name}" is not in that file` };

  const host = findHost(doc);
  if (!host || host.fields.childCountAt == null) {
    return { ok: false, reason: 'this plan has no room container to add the shape to' };
  }

  const created: number[] = [];
  const copy = detach(original, source, () => doc.nextId++, created);

  host.slots.push({ kind: 'object', node: copy });
  host.children.push(copy);

  // Keep the host's declared child count in step with its slots.
  const header =
    host.headerOverride ??
    (host.headerOverride = Buffer.from(doc.source.subarray(host.span.bodyAt, host.span.headerEnd)));
  const at = host.fields.childCountAt - host.span.bodyAt;
  if (at < 0 || at + 2 > header.length) {
    return { ok: false, reason: 'could not update the room child count' };
  }
  header.writeUInt16LE(host.slots.length, at);

  // Move it to the requested point via its insertion point.
  const anchor = copy.points[0];
  if (anchor && copy.fields.placementAt != null) {
    const dx = x - anchor.x;
    const dy = y - anchor.y;
    const offset = copy.fields.placementAt - copy.span.bodyAt;
    if (offset >= 0 && offset + 16 <= copy.headerOverride!.length) {
      copy.headerOverride!.writeDoubleLE(anchor.x + dx, offset);
      copy.headerOverride!.writeDoubleLE(anchor.y + dy, offset + 8);
      copy.points[0] = { x, y };
    }
    const boundsAt = copy.fields.boundsAt - copy.span.bodyAt;
    if (boundsAt >= 0 && boundsAt + 16 <= copy.headerOverride!.length) {
      const b = copy.headerOverride!;
      b.writeInt32LE(Math.round(copy.bounds.left + dx), boundsAt);
      b.writeInt32LE(Math.round(copy.bounds.top + dy), boundsAt + 4);
      b.writeInt32LE(Math.round(copy.bounds.right + dx), boundsAt + 8);
      b.writeInt32LE(Math.round(copy.bounds.bottom + dy), boundsAt + 12);
    }
  }

  void index;
  return { ok: true, created, name };
}
