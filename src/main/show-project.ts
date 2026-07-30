/**
 * A small local Show spine.
 *
 * Legacy plans remain canonical files. This manifest only proves which plan
 * and saved gear list belong to the same job, without forcing users into a
 * database or breaking the fast loose-file workflow.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { GearList } from '../gear/model.js';
import { atomicWriteJson } from './storage.js';

export const SHOW_FILE_SUFFIX = '.groundplan-show.json';

export interface ShowManifest {
  format: 'groundplan-show';
  version: 1;
  id: string;
  title: string;
  jobNumber?: string;
  location?: string;
  status: 'planning' | 'ready' | 'complete' | 'archived';
  plan: {
    path: string;
  };
  gear: {
    path: string;
    listId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ShowLinkState {
  manifest: ShowManifest | null;
  linked: boolean;
  planPath?: string;
  gearPath?: string;
  reason?: string;
}

export function showFileFor(planPath: string): string {
  return `${planPath}${SHOW_FILE_SUFFIX}`;
}

function portableLink(fromPlan: string, target: string): string {
  const linked = relative(dirname(resolve(fromPlan)), resolve(target));
  return linked && !isAbsolute(linked) ? linked.replace(/\\/g, '/') : resolve(target);
}

function resolveLink(fromPlan: string, linked: string): string {
  return isAbsolute(linked) ? resolve(linked) : resolve(dirname(fromPlan), linked);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseManifest(value: unknown): ShowManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Show manifest is not an object');
  }
  const raw = value as Record<string, unknown>;
  const plan = raw.plan as Record<string, unknown> | undefined;
  const gear = raw.gear as Record<string, unknown> | undefined;
  if (
    raw.format !== 'groundplan-show' ||
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.title !== 'string' ||
    !plan ||
    typeof plan.path !== 'string' ||
    !gear ||
    typeof gear.path !== 'string'
  ) {
    throw new Error('Show manifest is incomplete or unsupported');
  }
  const status =
    raw.status === 'ready' || raw.status === 'complete' || raw.status === 'archived'
      ? raw.status
      : 'planning';
  return {
    format: 'groundplan-show',
    version: 1,
    id: raw.id,
    title: raw.title.trim() || 'Untitled Show',
    jobNumber: optionalString(raw.jobNumber),
    location: optionalString(raw.location),
    status,
    plan: { path: plan.path },
    gear: { path: gear.path, listId: optionalString(gear.listId) },
    createdAt: optionalString(raw.createdAt) ?? new Date(0).toISOString(),
    updatedAt: optionalString(raw.updatedAt) ?? new Date(0).toISOString(),
  };
}

export async function loadShowManifest(planPath: string): Promise<ShowManifest | null> {
  const path = showFileFor(planPath);
  if (!existsSync(path)) return null;
  return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export async function showLinkState(
  planPath: string | undefined,
  gearPath: string | undefined,
): Promise<ShowLinkState> {
  if (!planPath) return { manifest: null, linked: false, reason: 'no plan is open' };
  let manifest: ShowManifest | null;
  try {
    manifest = await loadShowManifest(planPath);
  } catch (error) {
    return {
      manifest: null,
      linked: false,
      planPath,
      gearPath,
      reason: `the Show link is damaged: ${String(error)}`,
    };
  }
  if (!manifest) {
    return {
      manifest: null,
      linked: false,
      planPath,
      gearPath,
      reason: gearPath ? 'this plan and gear list are not linked yet' : 'no saved gear list is open',
    };
  }

  const linkedPlan = resolveLink(planPath, manifest.plan.path);
  const linkedGear = resolveLink(planPath, manifest.gear.path);
  const currentPlan = resolve(planPath);
  const currentGear = gearPath ? resolve(gearPath) : undefined;
  const linked = linkedPlan === currentPlan && !!currentGear && linkedGear === currentGear;
  return {
    manifest,
    linked,
    planPath: linkedPlan,
    gearPath: linkedGear,
    reason: linked
      ? undefined
      : currentGear
        ? 'the open gear list is not the one linked to this Show'
        : 'open the linked gear list to verify this Show',
  };
}

export async function linkShow(
  planPath: string,
  gearPath: string,
  list: GearList,
): Promise<ShowLinkState> {
  const previous = await loadShowManifest(planPath).catch(() => null);
  const now = new Date().toISOString();
  const manifest: ShowManifest = {
    format: 'groundplan-show',
    version: 1,
    id: previous?.id ?? randomUUID(),
    title: list.title.trim() || previous?.title || 'Untitled Show',
    jobNumber: list.jobNumber ?? previous?.jobNumber,
    location: list.location ?? previous?.location,
    status: previous?.status ?? 'planning',
    plan: { path: portableLink(planPath, planPath) || '.' },
    gear: { path: portableLink(planPath, gearPath), listId: list.id },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await atomicWriteJson(showFileFor(planPath), manifest, {
    backupPath: existsSync(showFileFor(planPath)) ? `${showFileFor(planPath)}.bak` : undefined,
  });
  return showLinkState(planPath, gearPath);
}

/** Rewrites copied Show metadata so a Save As points at its new plan path. */
export async function copyShowForSaveAs(sourcePlan: string, targetPlan: string): Promise<boolean> {
  const manifest = await loadShowManifest(sourcePlan);
  if (!manifest) return false;
  const linkedGear = resolveLink(sourcePlan, manifest.gear.path);
  const copied: ShowManifest = {
    ...manifest,
    id: randomUUID(),
    plan: { path: portableLink(targetPlan, targetPlan) || '.' },
    gear: { ...manifest.gear, path: portableLink(targetPlan, linkedGear) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(showFileFor(targetPlan), copied, {
    backupPath: existsSync(showFileFor(targetPlan)) ? `${showFileFor(targetPlan)}.bak` : undefined,
  });
  return true;
}
