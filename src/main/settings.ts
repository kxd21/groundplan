/**
 * Application settings.
 *
 * Kept apart from the inventory and from the catalog: those are data, this is
 * how one person likes the application to behave. Mixing them would mean a
 * catalog update could plausibly change someone's preferences, which it must
 * never do.
 *
 * Every field has a default, unknown fields are preserved, and a corrupt file
 * falls back rather than throwing. Losing preferences is a small annoyance;
 * refusing to start because of them would not be.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteJson } from './storage.js';

export interface Settings {
  /** Defaults for File → Print to PDF. */
  print: {
    scale: string;
    paper: string;
    landscape: boolean;
    /** Job or client line for the title block, when the plan carries none. */
    subtitle: string;
    /** Who drew it. Usually constant for an operator, so it persists. */
    drawnBy: string;
    /** Which revision this sheet is. Bumped by hand as the plan is reissued. */
    revision: string;
  };

  /** Defaults for File → Export DXF for CAD. */
  dxf: {
    /** Write the item schedule beside the drawing. */
    includeSchedule: boolean;
    /** Only export layers currently visible. */
    visibleLayersOnly: boolean;
  };

  drawing: {
    /**
     * How lengths and areas are shown and entered.
     *
     * A display concern only — the format stores tenths of an inch whatever is
     * chosen here, so switching does not touch a single byte of a plan.
     */
    units: 'imperial' | 'metric';
    /** Snap step in logical units. Zero disables snapping. */
    snapStep: number;
    /** Align moving objects to nearby object edges and centres. */
    objectSnap: boolean;
    showGrid: boolean;
    /** Start newly opened plans on a white sheet instead of a dark sheet. */
    paperSheet: boolean;
    /** Fit the room to the available canvas when a plan opens. */
    autoFitOnOpen: boolean;
    /** Switch the inspector to Properties after clicking an object. */
    openPropertiesOnSelect: boolean;
    /** Numbered markers / hover card for overlapping pieces. */
    showStackPeek: boolean;
    /** Colour seat dots by A/V sightline grade (off by default — very busy). */
    showSightlineMarkers: boolean;
    /** Arrow-key movement in logical units. */
    nudgeStep: number;
    /** Shift+arrow fine movement in logical units. */
    fineNudgeStep: number;
    /** Confirm before deleting more than this many objects at once. */
    bulkDeleteWarning: number;
    /**
     * What an unmodified scroll wheel / two-finger swipe does on the plan.
     *
     * `pan` matches trackpads (default). `zoom` matches most CAD tools and
     * conventional mice — hold Alt to pan when zoom is primary.
     */
    wheelPrimary: 'pan' | 'zoom';
    /** When true, scrolling up zooms out (natural / inverted zoom). */
    wheelInvertZoom: boolean;
  };

  catalog: {
    policy: 'automatic' | 'automatic-small' | 'notify' | 'manual';
    smallUpdateLimitMb: number;
    checkIntervalHours: number;
  };

  app: {
    /** Look for a new application build shortly after launch. */
    checkOnLaunch: boolean;
  };

  inventory: {
    /** Fold newly imported gear into the inventory automatically. */
    autoAbsorbGear: boolean;
    /** Give unshaped items the closest drawn symbol after an import. */
    autoMatchShapes: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  print: { scale: '1/8', paper: 'Tabloid', landscape: true, subtitle: '', drawnBy: '', revision: '' },
  dxf: { includeSchedule: true, visibleLayersOnly: true },
  // Interactive edits snap at 1″ by default; Shift goes to 0.1″, Alt frees.
  drawing: {
    units: 'imperial',
    snapStep: 10,
    objectSnap: true,
    showGrid: true,
    paperSheet: true,
    autoFitOnOpen: true,
    openPropertiesOnSelect: true,
    showStackPeek: true,
    showSightlineMarkers: false,
    nudgeStep: 10,
    fineNudgeStep: 1,
    bulkDeleteWarning: 25,
    wheelPrimary: 'pan',
    wheelInvertZoom: false,
  },
  catalog: { policy: 'notify', smallUpdateLimitMb: 5, checkIntervalHours: 12 },
  app: { checkOnLaunch: true },
  inventory: { autoAbsorbGear: false, autoMatchShapes: false },
};

function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json');
}

/** Merges stored values over the defaults, one level deep. */
function merge(stored: Partial<Settings>): Settings {
  const out = { ...DEFAULT_SETTINGS } as Settings;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const value = stored[key];
    if (value && typeof value === 'object') {
      out[key] = { ...(DEFAULT_SETTINGS[key] as object), ...(value as object) } as never;
    }
  }
  return out;
}

export async function loadSettings(userDataDir: string): Promise<Settings> {
  try {
    return merge(JSON.parse(await readFile(settingsPath(userDataDir), 'utf8')) as Partial<Settings>);
  } catch {
    // No settings yet, or unreadable. Defaults are always usable.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(userDataDir: string, settings: Settings): Promise<void> {
  const path = settingsPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, settings, {
    backupPath: existsSync(path) ? `${path}.bak` : undefined,
  });
}

/**
 * Applies a partial change.
 *
 * Takes a patch rather than a whole object so one panel of the settings window
 * cannot overwrite a field another panel changed a moment earlier.
 */
export function applyPatch(current: Settings, patch: Partial<Settings>): Settings {
  const next = { ...current } as Settings;
  for (const key of Object.keys(patch) as Array<keyof Settings>) {
    const value = patch[key];
    if (value && typeof value === 'object') {
      next[key] = { ...(current[key] as object), ...(value as object) } as never;
    }
  }
  return next;
}
