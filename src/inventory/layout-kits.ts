/**
 * Layout kit store — bundled fixtures + user-saved recipes under userData.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isLayoutRecipe,
  type LayoutRecipe,
  type LayoutRecipeSeatingBlock,
} from './layout-recipe.js';

export interface LayoutKitInfo {
  id: string;
  name: string;
  source: 'bundled' | 'user';
  path: string;
  chairs: number;
  banks: number;
  gear: number;
  event?: string;
  venue?: string;
  /** Optional capacity for variant kits. */
  capacityGuests?: number;
  /** Parent kit id when this is a seating/capacity variant. */
  variantOf?: string;
}

export interface BankPreset {
  id: string;
  name: string;
  savedAt: string;
  block: Omit<LayoutRecipeSeatingBlock, 'xFt' | 'yFt' | 'expectCount'> & {
    expectCount?: number;
  };
}

function kitRoot(): string {
  // Dist/dev: prefer package fixtures next to source.
  const fromSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'fixtures');
  if (existsSync(fromSrc)) return fromSrc;
  // Packaged: resources/fixtures
  const fromResources = join(process.resourcesPath || '', 'fixtures');
  if (existsSync(fromResources)) return fromResources;
  return fromSrc;
}

export function bundledKitsDir(): string {
  return kitRoot();
}

export function userKitsDir(userDataDir: string): string {
  return join(userDataDir, 'layout-kits');
}

export function bankPresetsPath(userDataDir: string): string {
  return join(userDataDir, 'bank-presets.json');
}

function describeKit(id: string, path: string, source: 'bundled' | 'user'): LayoutKitInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!isLayoutRecipe(raw)) return null;
    const recipe = raw as LayoutRecipe;
    return {
      id,
      name:
        recipe.identity?.event ??
        recipe.identity?.roomLabel ??
        basename(path, '.json').replace(/[-_]/g, ' '),
      source,
      path,
      chairs: recipe.expectations.chairs,
      banks: recipe.seating.length,
      gear: recipe.gear?.length ?? 0,
      event: recipe.identity?.event,
      venue: recipe.identity?.venue,
      capacityGuests: recipe.identity?.capacityGuests,
      variantOf: recipe.identity?.variantOf,
    };
  } catch {
    return null;
  }
}

export function listLayoutKits(userDataDir: string): LayoutKitInfo[] {
  const kits: LayoutKitInfo[] = [];
  const bundledDir = bundledKitsDir();
  if (existsSync(bundledDir)) {
    for (const file of readdirSync(bundledDir)
      .filter((f) => f.endsWith('-layout-recipe.json'))
      .sort()) {
      const path = join(bundledDir, file);
      const idBase = basename(file, '.json').replace(/-layout-recipe$/, '');
      const info = describeKit(`bundled:${idBase}`, path, 'bundled');
      if (info) kits.push(info);
    }
  }

  const userDir = userKitsDir(userDataDir);
  if (existsSync(userDir)) {
    for (const file of readdirSync(userDir).filter((f) => f.endsWith('.json'))) {
      const path = join(userDir, file);
      const info = describeKit(`user:${basename(file, '.json')}`, path, 'user');
      if (info) kits.push(info);
    }
  }
  // Small events first, then mid-size, then arenas / large houses.
  return kits.sort((a, b) => a.chairs - b.chairs || a.name.localeCompare(b.name));
}

export function loadLayoutKit(userDataDir: string, kitId: string): LayoutRecipe | null {
  const kits = listLayoutKits(userDataDir);
  const hit = kits.find((k) => k.id === kitId);
  if (!hit) return null;
  const raw = JSON.parse(readFileSync(hit.path, 'utf8'));
  return isLayoutRecipe(raw) ? raw : null;
}

export function saveLayoutKit(
  userDataDir: string,
  recipe: LayoutRecipe,
  fileName?: string,
): { ok: true; path: string; id: string } | { ok: false; reason: string } {
  if (!isLayoutRecipe(recipe)) return { ok: false, reason: 'not a valid layout recipe' };
  const dir = userKitsDir(userDataDir);
  mkdirSync(dir, { recursive: true });
  const base =
    (fileName ?? recipe.identity?.event ?? 'show-kit')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 64) || 'show-kit';
  const path = join(dir, `${base}.json`);
  writeFileSync(path, JSON.stringify(recipe, null, 2));
  return { ok: true, path, id: `user:${base}` };
}

export function importLayoutKitFile(
  userDataDir: string,
  sourcePath: string,
): { ok: true; path: string; id: string } | { ok: false; reason: string } {
  try {
    const raw = JSON.parse(readFileSync(sourcePath, 'utf8'));
    if (!isLayoutRecipe(raw)) return { ok: false, reason: 'file is not a groundplan-layout-recipe v1' };
    const base = basename(sourcePath, '.json');
    const dir = userKitsDir(userDataDir);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${base}.json`);
    copyFileSync(sourcePath, dest);
    return { ok: true, path: dest, id: `user:${base}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function loadBankPresets(userDataDir: string): BankPreset[] {
  const path = bankPresetsPath(userDataDir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveBankPreset(
  userDataDir: string,
  preset: Omit<BankPreset, 'id' | 'savedAt'> & { id?: string },
): BankPreset {
  const presets = loadBankPresets(userDataDir);
  const id = preset.id ?? `bank-${Date.now().toString(36)}`;
  const next: BankPreset = {
    id,
    name: preset.name,
    savedAt: new Date().toISOString(),
    block: preset.block,
  };
  const filtered = presets.filter((p) => p.id !== id);
  filtered.unshift(next);
  mkdirSync(dirname(bankPresetsPath(userDataDir)), { recursive: true });
  writeFileSync(bankPresetsPath(userDataDir), JSON.stringify(filtered.slice(0, 40), null, 2));
  return next;
}

export function deleteBankPreset(userDataDir: string, id: string): void {
  const presets = loadBankPresets(userDataDir).filter((p) => p.id !== id);
  writeFileSync(bankPresetsPath(userDataDir), JSON.stringify(presets, null, 2));
}
