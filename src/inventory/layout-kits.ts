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
  /**
   * What the kit's seating actually is, so a recommendation can match a
   * requested layout instead of pattern-matching the kit's NAME. A kit called
   * "Card Party" is a banquet whatever it is called.
   */
  seatingKinds?: Array<'theatre' | 'schoolroom' | 'round'>;
  /** True when the kit builds a stage, so a brief that needs one can prefer it. */
  hasStage?: boolean;
  /** Footprint the kit occupies in feet, for fitting it to a room. */
  extentFt?: { width: number; depth: number };
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

/**
 * How much floor the kit's own contents cover, in feet.
 *
 * Measured from the blocks and stages the recipe places rather than declared,
 * because a recipe carries no footprint of its own and "does this fit" is the
 * first question a room asks of a kit.
 */
function kitExtentFt(recipe: LayoutRecipe): { width: number; depth: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const span = (x: number, y: number, w: number, d: number) => {
    minX = Math.min(minX, x - w / 2);
    maxX = Math.max(maxX, x + w / 2);
    minY = Math.min(minY, y - d / 2);
    maxY = Math.max(maxY, y + d / 2);
  };

  for (const stage of recipe.stage ?? []) span(stage.xFt, stage.yFt, stage.widthFt, stage.depthFt);
  for (const block of recipe.seating) {
    // A block's own size is not stored, so it is estimated from its rows: 2ft a
    // seat across and 3ft a row deep are the spacings the seating solver uses.
    const perRow = block.rowLengths?.length
      ? Math.max(...block.rowLengths)
      : (block.perRow ?? 10);
    const rows = block.rowLengths?.length ?? block.rows ?? 5;
    span(
      block.xFt,
      block.yFt,
      perRow * (block.seatSpacingFt ?? 2),
      rows * (block.rowSpacingFt ?? 3),
    );
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return { width: Math.round(maxX - minX), depth: Math.round(maxY - minY) };
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
      seatingKinds: [
        ...new Set(recipe.seating.map((block) => block.kind ?? 'theatre')),
      ],
      hasStage: (recipe.stage?.length ?? 0) > 0,
      extentFt: kitExtentFt(recipe),
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
