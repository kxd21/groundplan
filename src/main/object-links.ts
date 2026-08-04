/**
 * Object pairs kept beside the plan (stage↔stairs, etc.).
 *
 * Room Viewer has no place for “these two objects move together”, so the link
 * lives next to the `.rv4` the same way dimension associations do.
 */

import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';

import { atomicWriteJson } from './storage.js';

export interface ObjectLinkPair {
  a: number;
  b: number;
  kind?: 'stage-stairs';
}

export interface ObjectLinkFile {
  format: 'groundplan-object-links';
  version: 1;
  pairs: ObjectLinkPair[];
}

const fileFor = (planPath: string): string => `${planPath}.groundplan-links.json`;

function emptyFile(): ObjectLinkFile {
  return { format: 'groundplan-object-links', version: 1, pairs: [] };
}

export async function loadObjectLinks(
  planPath: string,
): Promise<{ file: ObjectLinkFile; warning?: string }> {
  const path = fileFor(planPath);
  if (!existsSync(path)) return { file: emptyFile() };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const raw = parsed as Record<string, unknown>;
    if (
      raw.format !== 'groundplan-object-links' ||
      raw.version !== 1 ||
      !Array.isArray(raw.pairs)
    ) {
      throw new Error('unsupported format');
    }
    const pairs: ObjectLinkPair[] = [];
    for (const value of raw.pairs) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.a !== 'number' ||
        typeof entry.b !== 'number' ||
        !Number.isFinite(entry.a) ||
        !Number.isFinite(entry.b) ||
        entry.a === entry.b
      ) {
        continue;
      }
      pairs.push({
        a: entry.a,
        b: entry.b,
        kind: entry.kind === 'stage-stairs' ? 'stage-stairs' : undefined,
      });
    }
    return { file: { format: 'groundplan-object-links', version: 1, pairs } };
  } catch (error) {
    return {
      file: emptyFile(),
      warning: `Object links beside this plan could not be read (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

export function objectLinksPath(planPath: string): string {
  return fileFor(planPath);
}

export async function saveObjectLinks(planPath: string, file: ObjectLinkFile): Promise<void> {
  const path = fileFor(planPath);
  if (!file.pairs.length) {
    if (existsSync(path)) await unlink(path).catch(() => undefined);
    return;
  }
  await atomicWriteJson(path, file, {
    backupPath: existsSync(path) ? `${path}.bak` : undefined,
  });
}

export function objectLinksFromMap(links: Map<number, number[]>): ObjectLinkFile {
  const seen = new Set<string>();
  const pairs: ObjectLinkPair[] = [];
  for (const [a, partners] of links) {
    for (const b of partners) {
      if (a >= b) continue;
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b, kind: 'stage-stairs' });
    }
  }
  return { format: 'groundplan-object-links', version: 1, pairs };
}

export function applyObjectLinkFile(file: ObjectLinkFile, into: Map<number, number[]>): void {
  into.clear();
  for (const pair of file.pairs) {
    const add = (from: number, to: number) => {
      const list = into.get(from) ?? [];
      if (!list.includes(to)) list.push(to);
      into.set(from, list);
    };
    add(pair.a, pair.b);
    add(pair.b, pair.a);
  }
}
