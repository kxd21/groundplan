/** Associative dimension relationships kept safely outside the legacy file. */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
  formatDistance,
  setDimensionGeometry,
} from '../format/annotate.js';
import { moveNode, relabelNode, type DocumentIndex } from '../format/edit.js';
import { walk, type RVDocument, type RVNode } from '../format/rv.js';
import { atomicWriteJson } from './storage.js';

interface ObjectAnchor {
  nodeId: number;
  cls: string;
  name?: string;
  lastX: number;
  lastY: number;
  /** Click offset in the object's unrotated local coordinates. */
  localX: number;
  localY: number;
  angleAt: number;
}

interface DimensionBinding {
  id: string;
  lineId: number;
  labelId: number;
  last: { x1: number; y1: number; x2: number; y2: number; text: string };
  start?: ObjectAnchor;
  end?: ObjectAnchor;
}

export interface DimensionAssociationFile {
  format: 'groundplan-dimension-associations';
  version: 1;
  entries: DimensionBinding[];
}

const fileFor = (planPath: string): string => `${planPath}.groundplan-dimensions.json`;
const nameOf = (node: RVNode): string | undefined =>
  node.labels.find(
    (label) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(label),
  );
const originOf = (node: RVNode): { x: number; y: number } =>
  node.points[0] ?? {
    x: (node.bounds.left + node.bounds.right) / 2,
    y: (node.bounds.top + node.bounds.bottom) / 2,
  };
const normalise = (value?: string): string => value?.trim().toLowerCase() ?? '';

function validAnchor(value: unknown): ObjectAnchor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.nodeId !== 'number' ||
    typeof raw.cls !== 'string' ||
    !['lastX', 'lastY', 'localX', 'localY', 'angleAt'].every(
      (key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]),
    )
  ) {
    return undefined;
  }
  return {
    nodeId: raw.nodeId,
    cls: raw.cls,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    lastX: raw.lastX as number,
    lastY: raw.lastY as number,
    localX: raw.localX as number,
    localY: raw.localY as number,
    angleAt: raw.angleAt as number,
  };
}

function emptyFile(): DimensionAssociationFile {
  return { format: 'groundplan-dimension-associations', version: 1, entries: [] };
}

export async function loadDimensionAssociations(
  planPath: string,
): Promise<{ file: DimensionAssociationFile; warning?: string }> {
  const path = fileFor(planPath);
  if (!existsSync(path)) return { file: emptyFile() };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const raw = parsed as Record<string, unknown>;
    if (
      raw.format !== 'groundplan-dimension-associations' ||
      raw.version !== 1 ||
      !Array.isArray(raw.entries)
    ) {
      throw new Error('unsupported format');
    }
    const entries: DimensionBinding[] = [];
    for (const value of raw.entries) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const last = entry.last as Record<string, unknown> | undefined;
      if (
        typeof entry.id !== 'string' ||
        typeof entry.lineId !== 'number' ||
        typeof entry.labelId !== 'number' ||
        !last ||
        typeof last.text !== 'string' ||
        !['x1', 'y1', 'x2', 'y2'].every(
          (key) => typeof last[key] === 'number' && Number.isFinite(last[key]),
        )
      ) {
        continue;
      }
      entries.push({
        id: entry.id,
        lineId: entry.lineId,
        labelId: entry.labelId,
        last: last as unknown as DimensionBinding['last'],
        start: validAnchor(entry.start),
        end: validAnchor(entry.end),
      });
    }
    return {
      file: { format: 'groundplan-dimension-associations', version: 1, entries },
    };
  } catch (error) {
    return {
      file: emptyFile(),
      warning: `Associative dimension metadata is damaged and was left untouched: ${String(error)}`,
    };
  }
}

export async function saveDimensionAssociations(
  planPath: string,
  file: DimensionAssociationFile,
): Promise<void> {
  const path = fileFor(planPath);
  await atomicWriteJson(path, file, {
    backupPath: existsSync(path) ? `${path}.bak` : undefined,
  });
}

function captureAnchor(
  node: RVNode | undefined,
  x: number,
  y: number,
): ObjectAnchor | undefined {
  if (!node) return undefined;
  const origin = originOf(node);
  const angle = node.angle ?? 0;
  const dx = x - origin.x;
  const dy = y - origin.y;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return {
    nodeId: node.id,
    cls: node.cls,
    name: nameOf(node),
    lastX: origin.x,
    lastY: origin.y,
    localX: dx * cos - dy * sin,
    localY: dx * sin + dy * cos,
    angleAt: angle,
  };
}

function nodeMatches(anchor: ObjectAnchor, node: RVNode): boolean {
  return node.cls === anchor.cls && normalise(nameOf(node)) === normalise(anchor.name);
}

function resolveAnchor(
  doc: RVDocument,
  anchor: ObjectAnchor,
  presentById: Map<number, RVNode>,
  allowRematch: boolean,
): RVNode | null {
  const direct = presentById.get(anchor.nodeId);
  if (direct && nodeMatches(anchor, direct)) {
    const origin = originOf(direct);
    if (
      !allowRematch ||
      Math.hypot(origin.x - anchor.lastX, origin.y - anchor.lastY) <= 2 * 120
    ) {
      return direct;
    }
  }
  if (!allowRematch) return null;
  const candidates = [...walk(doc)]
    .filter((node) => nodeMatches(anchor, node))
    .map((node) => {
      const origin = originOf(node);
      return { node, distance: Math.hypot(origin.x - anchor.lastX, origin.y - anchor.lastY) };
    })
    .sort((a, b) => a.distance - b.distance);
  // Reopening may renumber legacy nodes, but silently jumping a dimension to a
  // same-named chair across the room is worse than leaving the endpoint fixed.
  if (!candidates.length || candidates[0].distance > 2 * 120) return null;
  if (candidates.length > 1 && Math.abs(candidates[0].distance - candidates[1].distance) < 10) {
    return null;
  }
  anchor.nodeId = candidates[0].node.id;
  return candidates[0].node;
}

function pointFor(node: RVNode, anchor: ObjectAnchor): { x: number; y: number } {
  const origin = originOf(node);
  const angle = node.angle ?? anchor.angleAt;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  anchor.lastX = origin.x;
  anchor.lastY = origin.y;
  anchor.angleAt = angle;
  return {
    x: origin.x + anchor.localX * cos - anchor.localY * sin,
    y: origin.y + anchor.localX * sin + anchor.localY * cos,
  };
}

function lineScore(node: RVNode, binding: DimensionBinding): number {
  if (node.cls !== 'RVDimensionLine' || node.points.length < 2) return Number.POSITIVE_INFINITY;
  const [a, b] = node.points;
  const direct =
    Math.hypot(a.x - binding.last.x1, a.y - binding.last.y1) +
    Math.hypot(b.x - binding.last.x2, b.y - binding.last.y2);
  const reverse =
    Math.hypot(a.x - binding.last.x2, a.y - binding.last.y2) +
    Math.hypot(b.x - binding.last.x1, b.y - binding.last.y1);
  return Math.min(direct, reverse);
}

function resolveDimensionLine(
  doc: RVDocument,
  binding: DimensionBinding,
  presentById: Map<number, RVNode>,
  allowRematch: boolean,
): RVNode | null {
  const direct = presentById.get(binding.lineId);
  if (
    direct?.cls === 'RVDimensionLine' &&
    (!allowRematch || lineScore(direct, binding) <= 20)
  ) {
    return direct;
  }
  if (!allowRematch) return null;
  const candidates = [...walk(doc)]
    .map((node) => ({ node, score: lineScore(node, binding) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score);
  if (!candidates.length || candidates[0].score > 20) return null;
  if (candidates.length > 1 && Math.abs(candidates[0].score - candidates[1].score) < 0.001) {
    return null;
  }
  binding.lineId = candidates[0].node.id;
  return candidates[0].node;
}

function resolveDimensionLabel(
  doc: RVDocument,
  binding: DimensionBinding,
  presentById: Map<number, RVNode>,
  allowRematch: boolean,
): RVNode | null {
  const midpoint = {
    x: (binding.last.x1 + binding.last.x2) / 2,
    y: (binding.last.y1 + binding.last.y2) / 2,
  };
  const score = (node: RVNode): number => {
    if (
      node.cls !== 'RVLabel' ||
      node.fields.textAt == null ||
      !node.labels.includes(binding.last.text)
    ) {
      return Number.POSITIVE_INFINITY;
    }
    const origin = originOf(node);
    return Math.hypot(origin.x - midpoint.x, origin.y - midpoint.y);
  };
  const direct = presentById.get(binding.labelId);
  if (
    direct?.cls === 'RVLabel' &&
    (!allowRematch || score(direct) <= 20)
  ) {
    return direct;
  }
  if (!allowRematch) return null;
  const candidates = [...walk(doc)]
    .map((node) => ({ node, score: score(node) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score);
  if (!candidates.length || candidates[0].score > 20) return null;
  if (candidates.length > 1 && Math.abs(candidates[0].score - candidates[1].score) < 0.001) {
    return null;
  }
  binding.labelId = candidates[0].node.id;
  return candidates[0].node;
}

export function registerDimensionAssociation(
  doc: RVDocument,
  index: DocumentIndex,
  file: DimensionAssociationFile,
  created: number[],
  startPoint: { x: number; y: number; nodeId?: number },
  endPoint: { x: number; y: number; nodeId?: number },
): boolean {
  if (startPoint.nodeId == null && endPoint.nodeId == null) return false;
  const createdSet = new Set(created);
  const createdNodes = [...walk(doc)].filter((node) => createdSet.has(node.id));
  const line = createdNodes.find((node) => node.cls === 'RVDimensionLine');
  const label = createdNodes.find((node) => node.cls === 'RVLabel');
  if (!line || !label) return false;
  const text = formatDistance(
    Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y),
  );
  file.entries.push({
    id: randomUUID(),
    lineId: line.id,
    labelId: label.id,
    last: {
      x1: startPoint.x,
      y1: startPoint.y,
      x2: endPoint.x,
      y2: endPoint.y,
      text,
    },
    start: captureAnchor(
      startPoint.nodeId == null ? undefined : index.byId.get(startPoint.nodeId),
      startPoint.x,
      startPoint.y,
    ),
    end: captureAnchor(
      endPoint.nodeId == null ? undefined : index.byId.get(endPoint.nodeId),
      endPoint.x,
      endPoint.y,
    ),
  });
  return true;
}

export function updateAssociativeDimensions(
  doc: RVDocument,
  _index: DocumentIndex,
  file: DimensionAssociationFile,
  allowRematch = false,
): number {
  let updated = 0;
  const presentById = new Map([...walk(doc)].map((node) => [node.id, node]));
  const surviving: DimensionBinding[] = [];
  for (const binding of file.entries) {
    const line = resolveDimensionLine(doc, binding, presentById, allowRematch);
    const label = resolveDimensionLabel(doc, binding, presentById, allowRematch);
    if (!line || !label) {
      // During a normal edit, deleting either half of a dimension deletes its
      // relationship too. During cautious reopen rematching, retain unresolved
      // metadata so the user can inspect rather than silently losing it.
      if (allowRematch) surviving.push(binding);
      else updated++;
      continue;
    }
    surviving.push(binding);
    const startNode = binding.start
      ? resolveAnchor(doc, binding.start, presentById, allowRematch)
      : null;
    const endNode = binding.end
      ? resolveAnchor(doc, binding.end, presentById, allowRematch)
      : null;
    const start = startNode && binding.start
      ? pointFor(startNode, binding.start)
      : { x: binding.last.x1, y: binding.last.y1 };
    const end = endNode && binding.end
      ? pointFor(endNode, binding.end)
      : { x: binding.last.x2, y: binding.last.y2 };
    if (
      start.x === binding.last.x1 &&
      start.y === binding.last.y1 &&
      end.x === binding.last.x2 &&
      end.y === binding.last.y2
    ) {
      continue;
    }

    const geometry = setDimensionGeometry(doc, line, start.x, start.y, end.x, end.y);
    if (!geometry.ok) continue;
    const text = formatDistance(Math.hypot(end.x - start.x, end.y - start.y));
    const labelOrigin = originOf(label);
    moveNode(
      doc,
      label,
      (start.x + end.x) / 2 - labelOrigin.x,
      (start.y + end.y) / 2 - labelOrigin.y,
    );
    relabelNode(doc, label, text);
    binding.last = { x1: start.x, y1: start.y, x2: end.x, y2: end.y, text };
    updated++;
  }
  if (surviving.length !== file.entries.length) file.entries = surviving;
  return updated;
}

export function dimensionAssociationPath(planPath: string): string {
  return fileFor(planPath);
}
