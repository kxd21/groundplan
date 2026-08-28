/**
 * Electron main process.
 *
 * All file parsing happens here, in Node, and only the flattened scene crosses
 * the IPC boundary — a large ballroom plan is tens of thousands of objects, and
 * shipping the raw object tree to the renderer would cost far more than the
 * draw list it turns into.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, Menu, type MenuItemConstructorOptions } from 'electron';
import { join, dirname, basename, extname } from 'node:path';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { buildScene, type Scene } from '../format/scene.js';
import { symbolThumbnail, type Thumbnail } from '../format/thumbnail.js';
import { toDxf } from '../format/dxf.js';
import { applyPatch, loadSettings, saveSettings, type Settings } from './settings.js';
import {
  checkForAppUpdate,
  cleanStaging,
  installAppUpdate,
  stageAppUpdate,
} from '../update/app-update.js';
import {
  applyUpdate,
  checkForUpdate,
  loadPreferences,
  savePreferences,
  shouldCheck,
  shouldInstallSilently,
  type CatalogPreferences,
} from '../catalog/service.js';
import { catalogPaths } from '../catalog/install.js';
import {
  findReleaseFolder,
  planUsbUpdate,
  readUsbSource,
  stageUsbUpdate,
} from '../update/usb-update.js';
import { loadBuffer } from '../format/index.js';
import { findCatalogPath, loadCatalog, lookup, type Catalog } from '../format/catalog.js';
import {
  moveNode,
  deleteNode,
  duplicateNode,
  recolorNode,
  relabelNode,
  rotateNode,
  resizeNode,
  measureNode,
  flipNode,
  reorderChild,
} from '../format/edit.js';
import { arrangeMoves, type ArrangeBounds, type ArrangeMode } from '../format/arrange.js';
import { addSeating, type SeatingRequest } from '../format/seating.js';
import {
  annotationCapabilities,
  createLabel,
  createDimension,
  type AnnotationCapabilities,
} from '../format/annotate.js';
import { listSymbols, importSymbol } from '../format/symbol.js';
import { placeGear, parseDimensions } from '../format/place.js';
import { verifyWritable } from '../format/write.js';
import { Session } from './session.js';
import { canonicalPath, pathIdentity, samePath } from './paths.js';
import { printPlanToPdf, SCALES, type PrintRequest } from './print.js';
import { scheduleToCsv, scheduleSummaryCsv, entryKey, type Schedule } from '../format/schedule.js';
import { importGearPdf } from '../gear/import-pdf.js';
import { loadGearFileWithStatus, saveGearFile, GEAR_EXTENSION } from '../gear/store.js';
import {
  nextId,
  totalsFor,
  walkItems,
  locateGearItem,
  updateGearItem,
  removeGearItem,
  restoreGearItem,
  type GearList,
  type GearTotals,
  type RemovedGearItem,
} from '../gear/model.js';
import { reconcile, type ReconcileReport } from '../gear/reconcile.js';
import {
  emptyInventory,
  mergeItems,
  normaliseName,
  locateInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  restoreInventoryItem,
  departmentsOf,
  categoriesOf,
  ensureCategories,
  searchInventory,
  parseCsv,
  type Inventory,
  type InventoryItem,
  type RemovedInventoryItem,
} from '../inventory/model.js';
import { mapSymbols } from '../inventory/match.js';
import {
  classify,
  CATEGORY_LABELS,
  LAYER_LABELS,
  LAYER_ORDER,
  type Category,
} from '../inventory/classify.js';
import { loadInventoryWithStatus, saveInventory, inventoryPath } from '../inventory/store.js';
import { atomicWriteFile, atomicWriteJson } from './storage.js';
import {
  copyShowForSaveAs,
  linkShow,
  showFileFor,
  showLinkState,
  type ShowLinkState,
} from './show-project.js';
import {
  listRecoveries,
  readRecovery,
  recoveryId,
  removeRecovery,
  writeRecovery,
  type RecoveryEntry,
} from './recovery.js';
import { buildStableSchedule, setStableScheduleField } from './schedule-metadata.js';
import type { UnitSystem } from '../format/units.js';
import { createBlankPlan, ROOM_PRESETS } from '../format/blank.js';
import { companionPathFor } from './companion-store.js';
import {
  addStage,
  applySeating as applySeatingModel,
  removeSeatingRegion,
  seatingRegionOf,
  clearStage,
  createRectangularRoom,
  curveRoomWall,
  drawShape,
  dimensionTheRoom,
  drapePerimeter,
  placeGearList,
  openPlanModel,
  planAllocation,
  planModelView,
  planReport,
  previewSeating,
  reshapeRoom,
  resetPlanModel,
  savePlanModel,
  type DrawTool,
  type ReportOptions,
  type SeatingRequestView,
} from './plan-model.js';
import {
  dimensionAssociationPath,
  loadDimensionAssociations,
  registerDimensionAssociation,
  saveDimensionAssociations,
  updateAssociativeDimensions,
  type DimensionAssociationFile,
} from './dimension-associations.js';
import {
  addPlansToFolder,
  clonePlanFolders,
  createPlanFolder,
  emptyPlanFolders,
  loadPlanFolders,
  removePlanFolder,
  removePlanFromFolder,
  renamePlanFolder,
  savePlanFolders,
  type PlanFolder,
  type PlanFolderLibrary,
} from './plan-folders.js';

/**
 * macOS AppleDouble sidecars.
 *
 * Copying a plan onto a non-HFS volume leaves a `._Name.rv4` beside it holding
 * the resource fork. It carries a plan extension but is not a plan, so anything
 * that walks a folder has to skip it or it will try to parse 4KB of metadata.
 */
const isSidecar = (name: string): boolean => name.startsWith('._');

const PLAN_EXTENSIONS = ['.rv4', '.rs4', '.se4', '.ds4', '.rsd'];
const LIBRARY_EXTENSIONS = ['.add', '.stk', '.lib'];
const GEAR_EXTENSIONS = ['.pdf', '.json'];
const ALL_EXTENSIONS = [...PLAN_EXTENSIONS, ...LIBRARY_EXTENSIONS];
/** Everything the app will open when handed a path on the command line. */
const OPENABLE_EXTENSIONS = [...ALL_EXTENSIONS, ...GEAR_EXTENSIONS];
const MAX_PLAN_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const dataFileFor = (planPath: string) => `${planPath}.groundplan-data.json`;
const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

/**
 * Renderer paths are capabilities, not arbitrary filesystem input. A path is
 * granted only after an OS open/save dialog, a recent-list response, a folder
 * listing, or an OS file-association event.
 */
const grantedPaths = new Map<string, string>();
const grantedDirectories = new Map<string, string>();
const grantPath = (path: string): string => {
  const granted = canonicalPath(path);
  grantedPaths.set(pathIdentity(granted), granted);
  return granted;
};
const grantDirectory = (path: string): string => {
  const granted = canonicalPath(path);
  grantedDirectories.set(pathIdentity(granted), granted);
  return granted;
};
const requireGrantedPath = (path: unknown, extensions?: readonly string[]): string => {
  if (typeof path !== 'string' || !path.trim()) throw new Error('a valid file path is required');
  const candidate = canonicalPath(path);
  const granted = grantedPaths.get(pathIdentity(candidate));
  if (!granted) throw new Error('that file was not selected in Groundplan');
  if (extensions && !extensions.includes(extname(granted).toLowerCase())) {
    throw new Error('that file type is not supported for this action');
  }
  return granted;
};
const requireGrantedDirectory = (path: unknown): string => {
  if (typeof path !== 'string' || !path.trim()) throw new Error('a valid folder is required');
  const candidate = canonicalPath(path);
  const granted = grantedDirectories.get(pathIdentity(candidate));
  if (!granted) throw new Error('that folder was not selected in Groundplan');
  return granted;
};

async function enforceFileSize(path: string, maximum: number): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('the selected path is not a file');
  if (info.size > maximum) {
    throw new Error(`the selected file is too large (${Math.ceil(info.size / 1024 / 1024)} MB)`);
  }
}

export interface OpenResult {
  path: string;
  name: string;
  container: string;
  repaired: boolean;
  byteLength: number;
  warnings: number;
  warningSamples: string[];
  scene: Scene;
  /**
   * Whether this file can be saved.
   *
   * Only files that re-serialize to exactly their original bytes are editable.
   * Anything else is opened read-only, because saving a file the parser does
   * not fully reproduce could silently lose data.
   */
  editable: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  revision: number;
  recovered: boolean;
  dimensionWarning?: string;
  annotationCapabilities: AnnotationCapabilities;
}

/** Details of the currently selected object, for the properties panel. */
export interface SelectionInfo {
  nodeId: number;
  cls: string;
  name?: string;
  text?: string;
  color?: number;
  canDelete: boolean;
  canRelabel: boolean;
  widthUnits: number;
  heightUnits: number;
  /** Centre of the object's bounds, in logical units. */
  x: number;
  y: number;
}

/** The gear lists currently loaded, with their totals. */
export interface GearState {
  path?: string;
  dirty: boolean;
  notice?: string;
  lists: GearList[];
  totals: GearTotals[];
}

export interface DirectoryEntry {
  path: string;
  name: string;
  extension: string;
  size: number;
  modified: number;
}

let mainWindow: BrowserWindow | null = null;
/** Allows a close to continue after the unsaved-work prompt has been accepted. */
let closeConfirmed = false;
let rendererReady = false;
let pendingOpenPath: string | null = null;
export interface RecentFile {
  path: string;
  name: string;
  folder: string;
  extension: string;
  size: number;
  modified: number;
  openedAt: number;
}

export interface PlanFolderPlan {
  folderId: string;
  path: string;
  name: string;
  sourceFolder: string;
  extension: string;
  size: number;
  modified: number;
  missing: boolean;
  addedAt: string;
}

export interface PlanFolderState {
  folders: PlanFolder[];
  plans: PlanFolderPlan[];
  notice?: string;
}

let recentFiles: string[] = [];
let recentOpenedAt = new Map<string, number>();
/** Recents live beside the inventory so they survive a quit. */
let recentsFile = '';
let recentTimesFile = '';
let planFoldersFile = '';
let planFolders = emptyPlanFolders();
let planFolderNotice: string | undefined;
let planFolderMutation = Promise.resolve();

function mutatePlanFolders<T>(run: (next: PlanFolderLibrary) => T): Promise<T> {
  const task = planFolderMutation.then(async () => {
    const next = clonePlanFolders(planFolders);
    const result = run(next);
    await savePlanFolders(planFoldersFile, next);
    planFolders = next;
    return result;
  });
  planFolderMutation = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function planFolderState(): Promise<PlanFolderState> {
  await planFolderMutation;
  const plans: PlanFolderPlan[] = [];
  for (const membership of planFolders.memberships) {
    try {
      const info = await stat(membership.path);
      if (!info.isFile()) throw new Error('not a file');
      grantPath(membership.path);
      plans.push({
        folderId: membership.folderId,
        path: membership.path,
        name: basename(membership.path),
        sourceFolder: basename(dirname(membership.path)),
        extension: extname(membership.path).replace(/^\./, '').toUpperCase(),
        size: info.size,
        modified: info.mtimeMs,
        missing: false,
        addedAt: membership.addedAt,
      });
    } catch {
      plans.push({
        folderId: membership.folderId,
        path: membership.path,
        name: basename(membership.path),
        sourceFolder: basename(dirname(membership.path)),
        extension: extname(membership.path).replace(/^\./, '').toUpperCase(),
        size: 0,
        modified: 0,
        missing: true,
        addedAt: membership.addedAt,
      });
    }
  }
  return {
    folders: [...planFolders.folders].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    ),
    plans: plans.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    notice: planFolderNotice,
  };
}

async function loadRecents(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(recentsFile, 'utf8'));
    if (Array.isArray(parsed)) {
      // A short-lived development build wrote objects here. Recover those
      // without abandoning the original string array that older installs read.
      recentFiles = parsed.flatMap((entry): string[] => {
        if (typeof entry === 'string') return [entry];
        if (
          entry &&
          typeof entry === 'object' &&
          typeof entry.path === 'string' &&
          typeof entry.openedAt === 'number'
        ) {
          recentOpenedAt.set(entry.path, entry.openedAt);
          return [entry.path];
        }
        return [];
      });
    }
  } catch {
    // No recents yet, or the file is unreadable — start empty.
  }
  try {
    const parsed = JSON.parse(await readFile(recentTimesFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [path, timestamp] of Object.entries(parsed)) {
        if (typeof timestamp === 'number') recentOpenedAt.set(path, timestamp);
      }
    }
  } catch {
    // Last-opened context is optional; bare paths still render correctly.
  }
  // Rewrites the one experimental object format as the backward-compatible
  // string list immediately, before an older installed build is relaunched.
  persistRecents();
  persistRecentTimes();
}

let recentsWrite = Promise.resolve();
function queueRecentWrite(path: string, value: unknown): void {
  recentsWrite = recentsWrite
    .catch(() => undefined)
    .then(() => atomicWriteJson(path, value))
    .catch((error) => console.error(`[groundplan] could not persist ${basename(path)}:`, error));
}

function persistRecents(): void {
  queueRecentWrite(recentsFile, [...recentFiles]);
}

function persistRecentTimes(): void {
  queueRecentWrite(recentTimesFile, Object.fromEntries(recentOpenedAt));
}

/**
 * A plan path passed on the command line.
 *
 * Windows file associations launch the app this way, and it also makes
 * `groundplan plan.rv4` work from a terminal on both platforms. macOS instead
 * delivers an `open-file` event, handled separately below.
 */
function pathFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    if (!OPENABLE_EXTENSIONS.includes(extname(arg).toLowerCase())) continue;
    if (existsSync(arg)) return arg;
  }
  return null;
}

/**
 * Queues an OS file-open request until the renderer has installed its listener.
 *
 * Finder can deliver `open-file` before a slow inventory migration or window
 * load finishes. A fixed timer loses that request on slower machines.
 */
function dispatchOpenPath(path: string): void {
  const granted = grantPath(path);
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    rendererReady &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send('menu:open-path', granted);
    return;
  }
  // Groundplan edits one document at a time, so the latest explicit OS request
  // is the one the newly ready window should present.
  pendingOpenPath = granted;
}

function flushPendingOpenPath(): void {
  if (!pendingOpenPath || !mainWindow || mainWindow.isDestroyed() || !rendererReady) return;
  const path = pendingOpenPath;
  pendingOpenPath = null;
  mainWindow.webContents.send('menu:open-path', path);
}

function rememberRecent(path: string): void {
  path = grantPath(path);
  const identity = pathIdentity(path);
  const i = recentFiles.findIndex((entry) => pathIdentity(entry) === identity);
  if (i !== -1) recentFiles.splice(i, 1);
  recentFiles.unshift(path);
  recentOpenedAt.set(path, Date.now());
  if (recentFiles.length > 15) {
    for (const removed of recentFiles.splice(15)) recentOpenedAt.delete(removed);
  }
  app.addRecentDocument(path);
  persistRecents();
  persistRecentTimes();
}

/** Symbol sources are parsed once and reused for every placement. */
const symbolCache = new Map<string, ReturnType<typeof loadBuffer>['document']>();

/**
 * Flattened scenes for the plans symbols are taken from.
 *
 * Building one costs real time on a large plan, and dozens of inventory items
 * usually come from the same file, so previews would otherwise rebuild the same
 * scene over and over.
 */
const symbolSceneCache = new Map<string, Scene>();
const thumbnailCache = new Map<string, Thumbnail | null>();

/** Catalogues are cached per file — reparsing the Jet database per plan is waste. */
const catalogCache = new Map<string, Catalog | null>();

function catalogFor(planPath: string): Catalog | null {
  const found = findCatalogPath(planPath);
  if (!found) return null;
  if (!catalogCache.has(found)) {
    try {
      catalogCache.set(found, loadCatalog(found));
    } catch {
      // A missing or unreadable catalogue only costs category labels.
      catalogCache.set(found, null);
    }
  }
  return catalogCache.get(found) ?? null;
}

/** The document currently open. Groundplan edits one plan at a time. */
let session: Session | null = null;

/** How this person likes the application to behave. Loaded once at startup. */
let settings: Settings | null = null;

/**
 * The unit system for display and entry.
 *
 * Read synchronously from whatever has been loaded, because it is needed on
 * every readout and an await per label would be absurd. Before the settings
 * file has been read it falls back to the default, which is also what a first
 * run gets.
 */
function unitSystem(): UnitSystem {
  return settings?.drawing.units === 'metric' ? 'metric' : 'imperial';
}
let dimensionAssociations: DimensionAssociationFile = {
  format: 'groundplan-dimension-associations',
  version: 1,
  entries: [],
};
let dimensionAssociationWarning: string | undefined;
let dimensionWrite = Promise.resolve();
let dimensionUndoStack: DimensionAssociationFile[] = [];
let dimensionRedoStack: DimensionAssociationFile[] = [];
let planSaving = false;

const cloneDimensionAssociations = (): DimensionAssociationFile =>
  structuredClone(dimensionAssociations);

function resetDimensionHistory(): void {
  dimensionUndoStack = [];
  dimensionRedoStack = [];
}

function commitDimensionHistory(before: DimensionAssociationFile): void {
  dimensionUndoStack.push(before);
  if (dimensionUndoStack.length > 100) dimensionUndoStack.shift();
  dimensionRedoStack = [];
}

function persistDimensionAssociations(planPath: string): void {
  const snapshot = structuredClone(dimensionAssociations);
  dimensionWrite = dimensionWrite
    .catch(() => undefined)
    .then(() => saveDimensionAssociations(planPath, snapshot))
    .catch((error) => console.error('[groundplan] could not save dimension associations:', error));
}

/** The equipment inventory, loaded once at startup and saved after each change. */
let inventory: Inventory = emptyInventory();
let inventoryFile = '';
let lastRemovedInventory: RemovedInventoryItem | null = null;
let inventoryNotice: string | undefined;
let harvestRunning = false;
let harvestCancelled = false;
let harvestCompletion = Promise.resolve();
let finishHarvest: (() => void) | null = null;
let harvestCloseRequested = false;

export interface InventoryState {
  items: InventoryItem[];
  departments: Array<{ name: string; count: number }>;
  /** Category counts, already grouped into the drawing's layer families. */
  groups: Array<{
    layer: string;
    label: string;
    categories: Array<{ id: string; label: string; count: number }>;
  }>;
  total: number;
  path: string;
  notice?: string;
}

function inventoryState(
  query = '',
  department: string | null = null,
  category: Category | null = null,
): InventoryState {
  const counts = categoriesOf(inventory);
  const groups = LAYER_ORDER.map((layer) => ({
    layer,
    label: LAYER_LABELS[layer],
    categories: counts
      .filter((c) => c.layer === layer)
      .map((c) => ({ id: c.id, label: CATEGORY_LABELS[c.id], count: c.count })),
  })).filter((g) => g.categories.length > 0);

  return {
    items: searchInventory(inventory, query, department, category),
    departments: departmentsOf(inventory),
    groups,
    total: inventory.items.length,
    path: inventoryFile,
    notice: inventoryNotice,
  };
}

async function persistInventory(): Promise<void> {
  await saveInventory(inventoryFile, inventory);
}

/** The gear lists currently loaded, independent of the open plan. */
let gear: {
  lists: GearList[];
  path?: string;
  dirty: boolean;
  notice?: string;
  /** Complete-file digest used to reject overwriting an external revision. */
  savedDigest?: string;
} | null = null;
let gearSaving = false;
let lastRemovedGear:
  | { listId?: string; listIndex: number; removed: RemovedGearItem }
  | null = null;

export interface GearItemPatch {
  checked?: boolean;
  quantity?: number;
  description?: string;
  remove?: boolean;
}

function gearState(): GearState | null {
  if (!gear) return null;
  return {
    path: gear.path,
    dirty: gear.dirty,
    notice: gear.notice,
    lists: gear.lists,
    totals: gear.lists.map(totalsFor),
  };
}

let recoveryRoot = '';
let planRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let gearRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let planRecoveryWrite = Promise.resolve();
let gearRecoveryWrite = Promise.resolve();
let planRecoveryGeneration = 0;
let gearRecoveryGeneration = 0;
let activePlanRecoveryId: string | null = null;
let activeGearRecoveryId: string | null = null;

function notifyRecoveryChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recovery:changed');
  }
}

function cancelPlanRecoverySchedule(): void {
  planRecoveryGeneration++;
  if (planRecoveryTimer) clearTimeout(planRecoveryTimer);
  planRecoveryTimer = null;
}

function cancelGearRecoverySchedule(): void {
  gearRecoveryGeneration++;
  if (gearRecoveryTimer) clearTimeout(gearRecoveryTimer);
  gearRecoveryTimer = null;
}

function gearRecoveryKeyFor(value: typeof gear): string | null {
  if (!value) return null;
  if (value.path) return canonicalPath(value.path);
  return value.lists
    .map((list) => list.sourceFingerprint ?? list.id ?? list.jobNumber ?? list.title)
    .join('|');
}

function currentGearRecoveryKey(): string | null {
  return gearRecoveryKeyFor(gear);
}

function schedulePlanRecovery(s: Session): void {
  if (!recoveryRoot) return;
  if (planRecoveryTimer) clearTimeout(planRecoveryTimer);
  const generation = planRecoveryGeneration;
  planRecoveryTimer = setTimeout(() => {
    planRecoveryTimer = null;
    planRecoveryWrite = planRecoveryWrite
      .catch(() => undefined)
      .then(async () => {
        if (generation !== planRecoveryGeneration || session !== s) return;
        if (!s.dirty) {
          await removeRecovery(recoveryRoot, recoveryId('plan', canonicalPath(s.path)));
        } else {
          await writeRecovery(
            recoveryRoot,
            'plan',
            canonicalPath(s.path),
            s.loaded.name,
            s.file(),
            s.path,
            s.savedFileHash,
          );
        }
        if (generation === planRecoveryGeneration) notifyRecoveryChanged();
      })
      .catch((error) => console.error('[groundplan] could not write plan recovery:', error));
  }, 1_500);
}

function scheduleGearRecovery(): void {
  if (!recoveryRoot || !gear) return;
  if (gearRecoveryTimer) clearTimeout(gearRecoveryTimer);
  const expected = gear;
  const key = currentGearRecoveryKey();
  if (!key) return;
  const generation = gearRecoveryGeneration;
  gearRecoveryTimer = setTimeout(() => {
    gearRecoveryTimer = null;
    gearRecoveryWrite = gearRecoveryWrite
      .catch(() => undefined)
      .then(async () => {
        if (generation !== gearRecoveryGeneration || gear !== expected) return;
        if (!expected.dirty) {
          await removeRecovery(recoveryRoot, recoveryId('gear', key));
        } else {
          const title = expected.lists[0]?.title ?? 'Unsaved gear list';
          const payload = {
            format: 'groundplan-gear',
            version: 2,
            lists: expected.lists,
          };
          await writeRecovery(
            recoveryRoot,
            'gear',
            key,
            title,
            `${JSON.stringify(payload, null, 2)}\n`,
            expected.path,
          );
        }
        if (generation === gearRecoveryGeneration) notifyRecoveryChanged();
      })
      .catch((error) => console.error('[groundplan] could not write gear recovery:', error));
  }, 1_500);
}

/** Builds the payload the renderer renders from, annotating catalogue names. */
function describe(s: Session): OpenResult {
  const catalog = catalogFor(s.path);
  if (catalog) {
    for (const item of s.scene.inventory) {
      item.category = lookup(catalog, item.name)?.category;
    }
  }

  return {
    path: s.path,
    name: s.loaded.name,
    container: s.loaded.container,
    repaired: s.loaded.repaired,
    byteLength: s.loaded.byteLength,
    warnings: s.loaded.document.warnings.length,
    warningSamples: s.loaded.document.warnings.slice(0, 5).map((w) => w.message),
    scene: s.scene,
    editable: s.editable,
    dirty: s.dirty,
    canUndo: s.canUndo(),
    canRedo: s.canRedo(),
    revision: s.revision,
    recovered: s.recovered,
    dimensionWarning: dimensionAssociationWarning,
    annotationCapabilities: annotationCapabilities(s.loaded.document),
  };
}

function restoreDimensionLinks(s: Session): void {
  if (dimensionAssociationWarning || dimensionAssociations.entries.length === 0) return;
  const updated = updateAssociativeDimensions(
    s.loaded.document,
    s.index,
    dimensionAssociations,
    true,
  );
  if (updated > 0) {
    s.refresh();
    schedulePlanRecovery(s);
  }
  // Node IDs can be repaired even when the geometry was already current.
  persistDimensionAssociations(s.path);
}

async function openPath(path: string): Promise<OpenResult> {
  if (planSaving) throw new Error('wait for the current plan save to finish');
  path = grantPath(path);
  await enforceFileSize(path, MAX_PLAN_BYTES);
  const buf = await readFile(path);
  session = new Session(path, buf);
  const associations = await loadDimensionAssociations(path);
  dimensionAssociations = associations.file;
  dimensionAssociationWarning = associations.warning;
  restoreDimensionLinks(session);
  resetDimensionHistory();
  await openPlanModel(path, session.loaded.document, unitSystem());
  activePlanRecoveryId = null;
  rememberRecent(path);
  return describe(session);
}

/** Runs an edit against the open document, with undo recorded. */
/**
 * Wraps every IPC handler so a thrown error reaches the user.
 *
 * `ipcRenderer.invoke` rejects when a handler throws, and almost no call site
 * awaits inside a try — so an unreadable file or a full disk showed up as a
 * button that quietly did nothing. Intent handlers keep their `{ok, reason}`
 * shape; value handlers reject so cancellation and failure stay distinct.
 */
function isSafeIpcValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value == null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 128 * 1024 * 1024;
  if (Array.isArray(value)) {
    return value.length <= 20_000 && value.every((entry) => isSafeIpcValue(entry, depth + 1));
  }
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length <= 2_000 && keys.every((key) => isSafeIpcValue(record[key], depth + 1));
}

/** Channels whose public contract is a discriminated `{ok, reason}` result. */
const RESULT_CHANNELS = new Set([
  'recovery:dismiss',
  'plan-folders:create',
  'plan-folders:rename',
  'plan-folders:remove',
  'plan-folders:add-files',
  'plan-folders:add-current',
  'plan-folders:remove-plan',
  'edit:move',
  'edit:delete',
  'edit:duplicate',
  'edit:recolor',
  'edit:relabel',
  'edit:batch',
  'edit:arrange',
  'inventory:map-symbols',
  'inventory:absorb-gear',
  'inventory:harvest',
  'inventory:cancel-harvest',
  'inventory:import',
  'inventory:add',
  'inventory:update',
  'inventory:duplicate',
  'inventory:remove',
  'inventory:restore-last',
  'inventory:place',
  'gear:save',
  'gear:update',
  'gear:restore-last',
  'gear:add',
  'show:link-current',
  'plan:place-gear',
  'plan:rotate',
  'plan:resize',
  'plan:add-seating',
  'plan:add-label',
  'plan:add-dimension',
  'file:save',
  'schedule:set-field',
  'export:dxf',
  'print:pdf',
  'plan:room-create',
  'plan:room-reshape',
  'plan:room-curve',
  'plan:room-dimension',
  'plan:seating-apply',
  'plan:stage-add',
  'plan:report-export',
  'plan:draw',
  'file:new',
]);

function handle(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown,
  onError?: unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        throw new Error('request rejected from an untrusted renderer');
      }
      if (!args.every((argument) => isSafeIpcValue(argument))) {
        throw new Error('request rejected because its payload is invalid or too large');
      }
      return await listener(event, ...(args as never[]));
    } catch (err) {
      console.error(`[groundplan] ${channel} failed:`, err);
      if (onError !== undefined) return onError;
      const reason = err instanceof Error ? err.message : String(err);
      if (RESULT_CHANNELS.has(channel)) return { ok: false, reason };
      // Value-returning calls reject so renderer try/catch paths can distinguish
      // an actual failure from the user cancelling a native dialog.
      throw err;
    }
  });
}

function applyEdit(run: (s: Session) => { ok: boolean; reason?: string; text?: string; note?: string; created?: number[] }): {
  ok: boolean;
  reason?: string;
  text?: string;
  note?: string;
  created?: number[];
  doc?: OpenResult;
} {
  const s = session;
  if (!s) return { ok: false, reason: 'no plan is open' };
  if (!s.editable) {
    return { ok: false, reason: 'this file is open read-only because it does not reproduce exactly' };
  }

  const associationsBefore = cloneDimensionAssociations();
  s.checkpoint();
  let result: { ok: boolean; reason?: string; text?: string; note?: string; created?: number[] };
  try {
    result = run(s);
    if (!result.ok) {
      // Nothing changed; drop both halves of the transaction.
      s.rollback();
      dimensionAssociations = associationsBefore;
      return result;
    }

    const associatedUpdates = updateAssociativeDimensions(
      s.loaded.document,
      s.index,
      dimensionAssociations,
    );

    // Refuse edits that would write a document the parser cannot reproduce —
    // the synthesis contract. Blank plans already gate on this; live edits must
    // too, or a bad seating/label/room write reaches disk on Save.
    const verdict = verifyWritable(s.loaded.document);
    if (!verdict.ok) {
      s.rollback();
      dimensionAssociations = associationsBefore;
      return { ok: false, reason: verdict.reason };
    }

    s.refresh();
    commitDimensionHistory(associationsBefore);
    if (associatedUpdates > 0) persistDimensionAssociations(s.path);
    schedulePlanRecovery(s);
    return { ok: true, text: result.text, note: result.note, created: result.created, doc: describe(s) };
  } catch (err) {
    // Roll back rather than undo: an edit that threw must not be offered as a
    // redo, or Redo would re-apply the half-finished change.
    s.rollback();
    dimensionAssociations = associationsBefore;
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

interface SavePlanResult {
  ok: boolean;
  reason?: string;
  warning?: string;
  conflict?: boolean;
  cancelled?: boolean;
  path?: string;
  doc?: OpenResult;
}

async function savePlanDocumentCore(saveAs: boolean): Promise<SavePlanResult> {
  const s = session;
  if (!s) return { ok: false, reason: 'no plan is open' };
  if (!s.editable) return { ok: false, reason: 'this file is open read-only' };

  const source = s.path;
  let target = source;
  if (saveAs) {
    const result = await dialog.showSaveDialog({
      title: 'Save plan as',
      defaultPath: source,
      filters: [{ name: 'Room Viewer plan', extensions: [extname(source).slice(1) || 'rv4'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    target = grantPath(result.filePath);
  }
  const overwritingSource = samePath(target, source);

  if (overwritingSource) {
    try {
      const currentDiskFile = await readFile(source);
      if (!s.matchesSavedFile(currentDiskFile)) {
        return {
          ok: false,
          conflict: true,
          reason:
            'This plan changed outside Groundplan. Reopen it to use the newer file, or choose Save As to keep both versions.',
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: false,
          conflict: true,
          reason: 'This plan was moved or deleted outside Groundplan. Use Save As to choose a safe location.',
        };
      }
      return { ok: false, reason: `could not verify the current plan revision: ${String(error)}` };
    }
  }

  const backup = `${source}.bak`;
  const verdict = verifyWritable(s.loaded.document);
  if (!verdict.ok) {
    return {
      ok: false,
      reason:
        verdict.reason ??
        'this plan no longer reproduces exactly and cannot be saved without risking the file',
    };
  }
  const body = s.body();
  const bytes = s.file();
  const associationsAtSave = cloneDimensionAssociations();
  try {
    await atomicWriteFile(target, bytes, {
      // Refresh .bak on every overwrite so it stays a last-good copy, matching
      // companion / dimension / schedule sidecar writers.
      backupPath: overwritingSource ? backup : undefined,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        ? 'the file is open in another program, or is read-only'
        : String(error);
    return { ok: false, reason: `could not save: ${reason}` };
  }

  let warning: string | undefined;
  const addWarning = (message: string): void => {
    warning = warning ? `${warning} ${message}` : message;
  };
  if (!overwritingSource) {
    const sourceData = dataFileFor(source);
    if (existsSync(sourceData)) {
      const targetData = dataFileFor(target);
      try {
        await atomicWriteFile(targetData, await readFile(sourceData), {
          backupPath: existsSync(targetData) ? `${targetData}.bak` : undefined,
        });
        grantPath(targetData);
      } catch (error) {
        addWarning(`The plan was saved, but its schedule metadata could not be copied: ${String(error)}`);
      }
    }
    try {
      if (await copyShowForSaveAs(source, target)) grantPath(showFileFor(target));
    } catch (error) {
      addWarning(`Its Show link could not be copied: ${String(error)}`);
    }
    const sourceDimensions = dimensionAssociationPath(source);
    if (existsSync(sourceDimensions) || associationsAtSave.entries.length > 0) {
      try {
        await dimensionWrite;
        if (dimensionAssociationWarning && existsSync(sourceDimensions)) {
          await atomicWriteFile(
            dimensionAssociationPath(target),
            await readFile(sourceDimensions),
            {
              backupPath: existsSync(dimensionAssociationPath(target))
                ? `${dimensionAssociationPath(target)}.bak`
                : undefined,
            },
          );
        } else {
          await saveDimensionAssociations(target, associationsAtSave);
        }
        grantPath(dimensionAssociationPath(target));
      } catch (error) {
        addWarning(`Its associative dimensions could not be copied: ${String(error)}`);
      }
    }
  }

  s.path = target;
  s.markSaved(bytes, body);
  try {
    // After the plan lands, never before: the companion fingerprints the bytes
    // that actually reached disk, or it reads as stale on the next open.
    await savePlanModel(target, body);
    grantPath(companionPathFor(target));
  } catch (error) {
    addWarning(`Its Groundplan data could not be saved: ${String(error)}`);
  }
  if (recoveryRoot) {
    cancelPlanRecoverySchedule();
    await planRecoveryWrite;
    const ids = new Set([
      recoveryId('plan', canonicalPath(source)),
      recoveryId('plan', canonicalPath(target)),
      ...(activePlanRecoveryId ? [activePlanRecoveryId] : []),
    ]);
    await Promise.all([...ids].map((id) => removeRecovery(recoveryRoot, id)));
    activePlanRecoveryId = null;
    notifyRecoveryChanged();
  }
  // A newer edit may have landed while the snapshot was being written. It is
  // intentionally still dirty and needs a fresh crash-recovery checkpoint.
  if (s.dirty) {
    persistDimensionAssociations(target);
    schedulePlanRecovery(s);
  }
  rememberRecent(target);
  return { ok: true, path: target, warning, doc: describe(s) };
}

async function savePlanDocument(saveAs: boolean): Promise<SavePlanResult> {
  if (planSaving) {
    return { ok: false, reason: 'a plan save is already in progress' };
  }
  planSaving = true;
  try {
    return await savePlanDocumentCore(saveAs);
  } finally {
    planSaving = false;
  }
}

interface SaveGearResult {
  ok: boolean;
  reason?: string;
  conflict?: boolean;
  cancelled?: boolean;
  path?: string;
  gear?: GearState | null;
}

async function saveGearDocumentCore(saveAs: boolean): Promise<SaveGearResult> {
  const state = gear;
  if (!state) return { ok: false, reason: 'no gear list is open' };

  const recoveryKeyBeforeSave = gearRecoveryKeyFor(state);
  const source = state.path;
  let target = source;
  if (saveAs || !target) {
    const suggested =
      (state.lists[0]?.jobNumber ? `Job ${state.lists[0].jobNumber}` : 'Gear list') +
      GEAR_EXTENSION;
    const result = await dialog.showSaveDialog({
      title: 'Save gear list',
      defaultPath: state.path ?? suggested,
      filters: [{ name: 'Groundplan gear list', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    target = grantPath(result.filePath);
  }

  const overwritingSource = !!source && samePath(target, source);
  if (overwritingSource && state.savedDigest) {
    try {
      if (sha256(await readFile(source)) !== state.savedDigest) {
        return {
          ok: false,
          conflict: true,
          reason:
            'This gear list changed outside Groundplan. Reopen it to use the newer file, or choose Save As to keep both versions.',
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: false,
          conflict: true,
          reason: 'This gear list was moved or deleted outside Groundplan. Use Save As to choose a safe location.',
        };
      }
      return { ok: false, reason: `could not verify the current gear-list revision: ${String(error)}` };
    }
  }

  const listsAtSave = structuredClone(state.lists);
  try {
    await saveGearFile(target, listsAtSave);
  } catch (error) {
    return { ok: false, reason: `could not save the gear list: ${String(error)}` };
  }
  const writtenDigest = sha256(await readFile(target));
  const unchangedDuringSave =
    gear === state && JSON.stringify(state.lists) === JSON.stringify(listsAtSave);
  state.path = target;
  state.dirty = !unchangedDuringSave;
  state.notice = undefined;
  state.savedDigest = writtenDigest;
  if (recoveryRoot) {
    cancelGearRecoverySchedule();
    await gearRecoveryWrite;
    const recoveryKeys = [recoveryKeyBeforeSave, gearRecoveryKeyFor(state)].filter(
      (key): key is string => !!key,
    );
    await Promise.all(
      [...new Set(recoveryKeys)].map((key) =>
        removeRecovery(recoveryRoot, recoveryId('gear', key)),
      ),
    );
    if (activeGearRecoveryId) {
      await removeRecovery(recoveryRoot, activeGearRecoveryId);
      activeGearRecoveryId = null;
    }
    notifyRecoveryChanged();
  }
  if (state.dirty && gear === state) scheduleGearRecovery();
  return { ok: true, path: target, gear: gear === state ? gearState() : undefined };
}

async function saveGearDocument(saveAs: boolean): Promise<SaveGearResult> {
  if (gearSaving) {
    return { ok: false, reason: 'a gear-list save is already in progress' };
  }
  gearSaving = true;
  try {
    return await saveGearDocumentCore(saveAs);
  } finally {
    gearSaving = false;
  }
}

async function showSaveFailure(result: { reason?: string; conflict?: boolean }): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: result.conflict ? 'warning' : 'error',
    title: result.conflict ? 'Plan changed outside Groundplan' : 'Could not save',
    message: result.reason ?? 'The document could not be saved.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  if (mainWindow) await dialog.showMessageBox(mainWindow, options);
  else await dialog.showMessageBox(options);
}

async function confirmDiscard(kind: 'plan' | 'gear' | 'all'): Promise<boolean> {
  const dirtyPlan = !!session?.dirty;
  const dirtyGear = !!gear?.dirty;
  const needsPlan = kind !== 'gear' && dirtyPlan;
  const needsGear = kind !== 'plan' && dirtyGear;
  if (!needsPlan && !needsGear) return true;

  const work =
    needsPlan && needsGear
      ? 'the open plan and gear list'
      : needsPlan
        ? `“${session?.loaded.name ?? 'the open plan'}”`
        : 'the open gear list';
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Unsaved changes',
    message: `Save changes to ${work}?`,
    detail: 'Save keeps your latest work. Discard Changes permanently removes the unsaved edits.',
    buttons: ['Cancel', 'Save Changes', 'Discard Changes'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  };
  const response = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (response.response === 2) {
    if (recoveryRoot) {
      if (needsPlan) cancelPlanRecoverySchedule();
      if (needsGear) cancelGearRecoverySchedule();
      await Promise.all([
        needsPlan ? planRecoveryWrite : Promise.resolve(),
        needsGear ? gearRecoveryWrite : Promise.resolve(),
      ]);
      const removals: Promise<void>[] = [];
      if (needsPlan && session) {
        removals.push(
          removeRecovery(recoveryRoot, recoveryId('plan', canonicalPath(session.path))),
        );
        if (activePlanRecoveryId) removals.push(removeRecovery(recoveryRoot, activePlanRecoveryId));
        activePlanRecoveryId = null;
      }
      const gearKey = needsGear ? currentGearRecoveryKey() : null;
      if (gearKey) removals.push(removeRecovery(recoveryRoot, recoveryId('gear', gearKey)));
      if (needsGear && activeGearRecoveryId) {
        removals.push(removeRecovery(recoveryRoot, activeGearRecoveryId));
        activeGearRecoveryId = null;
      }
      await Promise.all(removals);
      notifyRecoveryChanged();
    }
    return true;
  }
  if (response.response !== 1) return false;

  if (needsPlan) {
    const saved = await savePlanDocument(false);
    if (!saved.ok) {
      if (!saved.cancelled) await showSaveFailure(saved);
      return false;
    }
  }
  if (needsGear) {
    const saved = await saveGearDocument(false);
    if (!saved.ok) {
      if (!saved.cancelled) await showSaveFailure(saved);
      return false;
    }
  }
  return true;
}

/**
 * Offers an application update, downloads it, and restarts into it.
 *
 * Uses the system dialog rather than a bespoke panel: an update prompt has to
 * work when the window is busy or a plan is mid-edit, and it is the one moment
 * where interrupting is the point.
 */
async function runAppUpdate(interactive: boolean): Promise<void> {
  const staging = join(app.getPath('userData'), 'updates');
  await cleanStaging(staging);

  const plan = await checkForAppUpdate({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });

  if (!plan.available) {
    // A silent check that finds nothing says nothing; only a deliberate one
    // deserves an answer.
    if (interactive) {
      await dialog.showMessageBox({
        type: 'info',
        message: plan.reason === 'the application is up to date' ? 'Groundplan is up to date' : 'No update available',
        detail:
          plan.reason === 'the application is up to date'
            ? `You are running version ${plan.currentVersion}.`
            : (plan.reason ?? 'Could not check for updates just now.'),
        buttons: ['OK'],
      });
    }
    return;
  }

  const size = plan.package ? `${(plan.package.bytes / 1024 / 1024).toFixed(1)} MB` : 'unknown size';
  const answer = await dialog.showMessageBox({
    type: 'info',
    message: `Groundplan ${plan.latestVersion} is available`,
    detail: `${plan.notes ? `${plan.notes}\n\n` : ''}You are on ${plan.currentVersion}. Download size: ${size}.\n\nGroundplan will restart to finish installing.`,
    buttons: ['Download and install', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  mainWindow?.webContents.send('app:update-progress', { phase: 'downloading', received: 0, total: plan.package?.bytes });

  const staged = await stageAppUpdate(plan, staging, (received, total) => {
    mainWindow?.webContents.send('app:update-progress', { phase: 'downloading', received, total });
    if (total > 0) mainWindow?.setProgressBar(received / total);
  });
  mainWindow?.setProgressBar(-1);

  if (!staged.ok) {
    mainWindow?.webContents.send('app:update-progress', { phase: 'failed', message: staged.reason });
    await dialog.showMessageBox({
      type: 'error',
      message: 'The update could not be downloaded',
      detail: `${staged.reason ?? 'The download did not finish.'}\n\nGroundplan ${plan.currentVersion} is unchanged and still works.`,
      buttons: ['OK'],
    });
    return;
  }

  // macOS replaces the .app bundle, so the path has to be the bundle rather
  // than the executable buried inside it. Windows hands off to the installer
  // and never reads this.
  const bundlePath =
    process.platform === 'darwin'
      ? app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]*$/, '')
      : app.getPath('exe');

  const installed = await installAppUpdate(staged, bundlePath, () => app.quit());
  if (!installed.ok) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'The update could not be installed',
      detail: `${installed.reason ?? 'Unknown problem.'}\n\nGroundplan ${plan.currentVersion} is unchanged.`,
      buttons: ['OK'],
    });
  }
}

async function catalogPreferences(): Promise<{
  paths: ReturnType<typeof catalogPaths>;
  preferences: CatalogPreferences;
}> {
  const root = join(app.getPath('userData'), 'catalog');
  const paths = catalogPaths(root);
  const stored = await loadPreferences(root);
  settings ??= await loadSettings(app.getPath('userData'));
  return {
    paths,
    preferences: {
      ...stored,
      policy: settings.catalog.policy,
      smallUpdateLimit: Math.max(1, settings.catalog.smallUpdateLimitMb) * 1024 * 1024,
      checkIntervalHours: Math.max(1, settings.catalog.checkIntervalHours),
    },
  };
}

/**
 * Looks for a signed equipment-catalog update and installs it per Settings.
 *
 * Quiet on launch (unless the policy says to ask / auto-install). Interactive
 * checks always report the outcome so the Settings button is not a no-op.
 */
async function runCatalogUpdate(interactive: boolean): Promise<void> {
  const { paths, preferences } = await catalogPreferences();
  if (!interactive && !shouldCheck(preferences)) return;

  let check: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    check = await checkForUpdate(paths, app.getVersion(), preferences);
  } catch (error) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'error',
        message: 'The equipment catalog could not be checked',
        detail: String(error),
        buttons: ['OK'],
      });
    }
    return;
  }

  await savePreferences(paths.root, {
    ...preferences,
    lastCheck: check.status.lastCheck ?? new Date().toISOString(),
    lastCheckSucceeded: !check.status.offline,
  });

  if (check.status.offline) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'The equipment catalog could not be checked',
        detail: 'Groundplan is offline, or the catalog host is unreachable. The catalog you already have is unchanged.',
        buttons: ['OK'],
      });
    }
    return;
  }

  if (check.status.blocked) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Catalog update unavailable',
        detail: check.status.blocked,
        buttons: ['OK'],
      });
    }
    return;
  }

  if (!check.status.available || !check.plan || check.plan.kind === 'none') {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Equipment catalog is up to date',
        detail: `Version ${check.status.installedVersion} · ${check.status.productCount} products.`,
        buttons: ['OK'],
      });
    }
    return;
  }

  const available = check.status.available;
  const silent = shouldInstallSilently(check.plan, preferences);
  if (!silent) {
    // Manual policy stays quiet unless the user asked; notify / large updates ask.
    if (!interactive && preferences.policy === 'manual') return;
    const size = `${(available.bytes / 1024 / 1024).toFixed(1)} MB`;
    const answer = await dialog.showMessageBox({
      type: available.urgent ? 'warning' : 'info',
      message: `Equipment catalog ${available.version} is available`,
      detail:
        `${available.notes ? `${available.notes}\n\n` : ''}` +
        `You have ${check.status.installedVersion}. Download size: ${size} (${available.kind}).`,
      buttons: ['Download and install', 'Later', 'Skip this version'],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 1) return;
    if (answer.response === 2) {
      await savePreferences(paths.root, {
        ...preferences,
        snoozedVersion: available.version,
        lastCheck: preferences.lastCheck,
        lastCheckSucceeded: true,
      });
      return;
    }
  }

  const applied = await applyUpdate(paths, check.plan, (progress) => {
    mainWindow?.webContents.send('app:update-progress', progress);
  });

  if (!applied.ok) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'The equipment catalog could not be updated',
      detail: `${applied.reason ?? 'The update did not finish.'}\n\nThe catalog you already have is unchanged.`,
      buttons: ['OK'],
    });
    return;
  }

  if (interactive || !silent) {
    await dialog.showMessageBox({
      type: 'info',
      message: `Equipment catalog ${applied.version} installed`,
      detail: `Added ${applied.added}, updated ${applied.updated}, deprecated ${applied.deprecated}.`,
      buttons: ['OK'],
    });
  }
}

/**
 * Installs an update from a folder on a USB stick.
 *
 * Shares the last two thirds of `runAppUpdate` — verify, stage, swap — and
 * differs only in where the bytes come from. The signature and hash checks are
 * the same ones, so accepting a stick from a colleague is exactly as safe as
 * accepting a download, and neither is trusted on the strength of where it came
 * from.
 */
async function runUsbUpdate(): Promise<void> {
  const picked = await dialog.showOpenDialog(mainWindow!, {
    title: 'Install update from USB',
    message: 'Choose the Groundplan release folder on the drive',
    properties: ['openDirectory'],
    buttonLabel: 'Use this folder',
  });
  if (picked.canceled || !picked.filePaths[0]) return;

  // Accept either the release folder or the drive it sits on, because both are
  // reasonable things to point at.
  const chosen = picked.filePaths[0];
  const folder = (await findReleaseFolder(chosen)) ?? chosen;

  const { source, reason } = await readUsbSource(folder);
  if (!source) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'That folder does not hold a Groundplan update',
      detail: reason ?? 'Unknown problem.',
      buttons: ['OK'],
    });
    return;
  }

  const plan = planUsbUpdate(source, {
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });

  if (!plan.available) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Nothing to install',
      detail: plan.reason ?? 'That drive has no newer version for this computer.',
      buttons: ['OK'],
    });
    return;
  }

  const size = plan.package ? `${(plan.package.bytes / 1024 / 1024).toFixed(1)} MB` : 'unknown size';
  const answer = await dialog.showMessageBox({
    type: 'info',
    message: `Install Groundplan ${plan.latestVersion} from this drive?`,
    detail:
      `${plan.notes ? `${plan.notes}\n\n` : ''}You are on ${plan.currentVersion}. ${size} will be copied off the drive ` +
      `and checked against its signature before anything is replaced.\n\nGroundplan will restart to finish installing.`,
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  const staging = join(app.getPath('userData'), 'updates');
  await cleanStaging(staging);
  mainWindow?.webContents.send('app:update-progress', { phase: 'downloading', received: 0, total: plan.package?.bytes });

  const staged = await stageUsbUpdate(source, plan, staging);
  mainWindow?.setProgressBar(-1);

  if (!staged.ok) {
    mainWindow?.webContents.send('app:update-progress', { phase: 'failed', message: staged.reason });
    await dialog.showMessageBox({
      type: 'error',
      message: 'The update could not be installed',
      detail: `${staged.reason ?? 'The copy did not finish.'}\n\nGroundplan ${plan.currentVersion} is unchanged and still works.`,
      buttons: ['OK'],
    });
    return;
  }

  const bundlePath =
    process.platform === 'darwin'
      ? app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]*$/, '')
      : app.getPath('exe');

  const installed = await installAppUpdate(staged, bundlePath, () => app.quit());
  if (!installed.ok) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'The update could not be installed',
      detail: `${installed.reason ?? 'Unknown problem.'}\n\nGroundplan ${plan.currentVersion} is unchanged.`,
      buttons: ['OK'],
    });
  }
}

function createWindow(): void {
  closeConfirmed = false;
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#11151c',
    title: 'Groundplan',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (harvestRunning) {
      event.preventDefault();
      harvestCancelled = true;
      if (!harvestCloseRequested) {
        harvestCloseRequested = true;
        void harvestCompletion.finally(() => {
          harvestCloseRequested = false;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        });
      }
      return;
    }
    if (closeConfirmed || (!session?.dirty && !gear?.dirty)) return;
    event.preventDefault();
    void confirmDiscard('all').then((discard) => {
      if (!discard || !mainWindow) return;
      closeConfirmed = true;
      mainWindow.close();
    });
  });
  mainWindow.on('closed', () => {
    // On macOS the process remains alive after its last window closes. Dispose
    // document-scoped state so reopening starts clean and no pending timer can
    // recreate recovery work the user deliberately discarded.
    cancelPlanRecoverySchedule();
    cancelGearRecoverySchedule();
    harvestCancelled = true;
    session = null;
    gear = null;
    lastRemovedGear = null;
    resetPlanModel();
    activePlanRecoveryId = null;
    activeGearRecoveryId = null;
    dimensionAssociations = {
      format: 'groundplan-dimension-associations',
      version: 1,
      entries: [],
    };
    resetDimensionHistory();
    dimensionAssociationWarning = undefined;
    rendererReady = false;
    mainWindow = null;
    closeConfirmed = false;
  });

  const startupPath = pathFromArgv(process.argv);
  if (startupPath) dispatchOpenPath(startupPath);
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    flushPendingOpenPath();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
        void shell.openExternal(url);
      }
    } catch {
      // Malformed and non-allowlisted URLs stay closed.
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const productionUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const requested = new URL(url);
      const allowed = developmentUrl
        ? requested.origin === new URL(developmentUrl).origin
        : requested.protocol === 'file:' &&
          requested.pathname === new URL(productionUrl).pathname;
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Groundplan',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Check for Updates…', click: () => void runAppUpdate(true) },
              { label: 'Install Update from USB…', click: () => void runUsbUpdate() },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => mainWindow?.webContents.send('menu:settings'),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: '&File',
      submenu: [
        {
          label: 'New Plan…',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new'),
        },
        { type: 'separator' },
        {
          label: 'Open Plan…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open'),
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow?.webContents.send('menu:open-folder'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
        { type: 'separator' },
        {
          label: 'Print to PDF…',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow?.webContents.send('menu:print'),
        },
        {
          label: 'Export DXF for CAD…',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => mainWindow?.webContents.send('menu:export-dxf'),
        },
        {
          label: 'Export SVG…',
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow?.webContents.send('menu:export-svg'),
        },
        { type: 'separator' },
        ...(isMac
          ? []
          : [
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => mainWindow?.webContents.send('menu:settings'),
              },
              { type: 'separator' as const },
            ]),
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      /**
       * The standard text-editing menu.
       *
       * Without it macOS has nothing bound to the cut/copy/paste/select-all
       * roles, so those shortcuts do nothing in any text field in the app —
       * search boxes, rename fields, sizes. Undo and Redo are listed without
       * accelerators on purpose: Cmd+Z belongs to the drawing, and the renderer
       * already leaves it alone while a text field has focus, which is what
       * lets a field keep its own native undo.
       */
      label: '&Edit',
      submenu: [
        { label: 'Undo', click: () => mainWindow?.webContents.send('menu:undo') },
        { label: 'Redo', click: () => mainWindow?.webContents.send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' },
        { type: 'separator' },
        {
          // Not the `selectAll` role: that always acts on the web page, which
          // would take Cmd+A away from the drawing. The renderer decides based
          // on whether a text field has focus.
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => mainWindow?.webContents.send('menu:select-all'),
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.send('menu:fit') },
        ...(!app.isPackaged
          ? [
              { type: 'separator' as const },
              { role: 'reload' as const },
              { role: 'toggleDevTools' as const },
            ]
          : []),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: '&Help',
      submenu: [
        { label: 'Check for Updates…', click: () => void runAppUpdate(true) },
        { label: 'Install Update from USB…', click: () => void runUsbUpdate() },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Only one copy of the app may run.
 *
 * On Windows a file association launches a *new* process for every plan the
 * user double-clicks. Without this the second one opens its own window with its
 * own document, and the two can end up saving over each other. Holding the lock
 * means later launches hand their path to the window already open.
 */
// Keep menus, notifications, and the Windows taskbar product-branded even
// when the app is launched through the generic Electron executable in dev.
app.setName('Groundplan');
if (process.platform === 'win32') app.setAppUserModelId('com.groundplan.app');

if (!app.isPackaged) {
  // A development preview must not read or rewrite the installed app's
  // inventory, recents, or preferences while a real job is open beside it.
  app.setPath('userData', join(app.getPath('appData'), 'groundplan-development'));
}

// A developer preview uses its own data and may run beside an installed copy.
// Production still stays single-instance so two windows cannot overwrite the
// same plan on Windows.
const gotTheLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const path = pathFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (path) dispatchOpenPath(path);
    }
  });
}

app.whenReady().then(async () => {
  recoveryRoot = join(app.getPath('userData'), 'recovery');

  handle(
    'recovery:list',
    async (): Promise<RecoveryEntry[]> => {
      const entries = await listRecoveries(recoveryRoot);
      // The plan or gear list currently open already holds its own unsaved work,
      // so listing a "recover" entry for it reads as lost work when it is simply
      // the live document. The journal file stays on disk — a crash still leaves
      // it recoverable on the next launch — it is only hidden from the list while
      // its document is the one open in front of the user.
      const activeIds = new Set<string>();
      if (session) activeIds.add(recoveryId('plan', canonicalPath(session.path)));
      const gearKey = currentGearRecoveryKey();
      if (gear && gearKey) activeIds.add(recoveryId('gear', gearKey));
      return entries.filter((entry) => !activeIds.has(entry.id));
    },
    [],
  );

  handle('recovery:open', async (_event, id: string) => {
    const recovered = await readRecovery(recoveryRoot, id);
    if (recovered.entry.kind === 'plan') {
      if (planSaving) throw new Error('wait for the current plan save to finish');
      if (!(await confirmDiscard('plan'))) return null;
      const planPath =
        recovered.entry.sourcePath ?? join(recoveryRoot, recovered.entry.dataFile);
      if (recovered.entry.sourcePath && existsSync(recovered.entry.sourcePath)) {
        grantPath(recovered.entry.sourcePath);
      }
      session = new Session(planPath, recovered.data);
      const associations = await loadDimensionAssociations(planPath);
      dimensionAssociations = associations.file;
      dimensionAssociationWarning = associations.warning;
      resetDimensionHistory();
      session.markRecovered(recovered.entry.sourceDigest);
      restoreDimensionLinks(session);
      activePlanRecoveryId = recovered.entry.id;
      return { kind: 'plan' as const, doc: describe(session) };
    }

    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    if (!(await confirmDiscard('gear'))) return null;
    const loaded = await loadGearFileWithStatus(join(recoveryRoot, recovered.entry.dataFile));
    gear = {
      lists: loaded.lists,
      dirty: true,
      notice: 'Recovered unsaved gear work after an interrupted session. Save As to keep it.',
    };
    lastRemovedGear = null;
    activeGearRecoveryId = recovered.entry.id;
    return { kind: 'gear' as const, gear: gearState() };
  });

  handle('recovery:dismiss', async (_event, id: string) => {
    await removeRecovery(recoveryRoot, id);
    if (activePlanRecoveryId === id) activePlanRecoveryId = null;
    if (activeGearRecoveryId === id) activeGearRecoveryId = null;
    notifyRecoveryChanged();
    return { ok: true };
  });

  handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open a Room Viewer plan',
      properties: ['openFile'],
      filters: [
        { name: 'Room Viewer plans', extensions: PLAN_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'Shape libraries', extensions: LIBRARY_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    if (!(await confirmDiscard('plan'))) return null;
    return openPath(grantPath(result.filePaths[0]));
  });

  handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder of Room Viewer files',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return grantDirectory(result.filePaths[0]);
  });

  handle('plan-folders:list', () => planFolderState());

  handle('plan-folders:create', async (_event, name: string, parentId: string | null) => {
    if (parentId !== null && typeof parentId !== 'string') {
      throw new Error('a valid parent folder is required');
    }
    const id = await mutatePlanFolders(
      (next) => createPlanFolder(next, name, parentId).id,
    );
    return { ok: true, id, state: await planFolderState() };
  });

  handle('plan-folders:rename', async (_event, id: string, name: string) => {
    if (typeof id !== 'string') throw new Error('a valid folder is required');
    await mutatePlanFolders((next) => renamePlanFolder(next, id, name));
    return { ok: true, state: await planFolderState() };
  });

  handle('plan-folders:remove', async (_event, id: string) => {
    if (typeof id !== 'string') throw new Error('a valid folder is required');
    const removed = await mutatePlanFolders((next) => removePlanFolder(next, id));
    return { ok: true, removed, state: await planFolderState() };
  });

  handle('plan-folders:add-files', async (_event, folderId: string) => {
    if (
      typeof folderId !== 'string' ||
      !planFolders.folders.some((folder) => folder.id === folderId)
    ) {
      throw new Error('that plan folder no longer exists');
    }
    const result = await dialog.showOpenDialog({
      title: 'Add plans to folder',
      defaultPath: session?.path ? dirname(session.path) : undefined,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Room Viewer plans', extensions: PLAN_EXTENSIONS.map((extension) => extension.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, cancelled: true, added: 0, state: await planFolderState() };
    }
    for (const path of result.filePaths) {
      if (!PLAN_EXTENSIONS.includes(extname(path).toLowerCase())) {
        throw new Error(`${basename(path)} is not a supported plan file`);
      }
      await enforceFileSize(path, MAX_PLAN_BYTES);
    }
    const added = await mutatePlanFolders((next) =>
      addPlansToFolder(next, folderId, result.filePaths),
    );
    return { ok: true, added, state: await planFolderState() };
  });

  handle('plan-folders:add-current', async (_event, folderId: string) => {
    if (!session || !existsSync(session.path)) throw new Error('open a saved plan first');
    if (!PLAN_EXTENSIONS.includes(extname(session.path).toLowerCase())) {
      throw new Error('the open document is not a Room Viewer plan');
    }
    const added = await mutatePlanFolders((next) =>
      addPlansToFolder(next, folderId, [session!.path]),
    );
    return { ok: true, added, state: await planFolderState() };
  });

  handle('plan-folders:remove-plan', async (_event, folderId: string, path: string) => {
    if (typeof folderId !== 'string' || typeof path !== 'string') {
      throw new Error('a valid folder and plan are required');
    }
    const removed = await mutatePlanFolders((next) =>
      removePlanFromFolder(next, folderId, path),
    );
    return { ok: true, removed, state: await planFolderState() };
  });

  handle('file:open', async (_event, path: string) => {
    if (!(await confirmDiscard('plan'))) return null;
    return openPath(requireGrantedPath(path, ALL_EXTENSIONS));
  });

  handle(
    'app:confirm',
    async (_event, options: {
      title: string;
      message: string;
      detail?: string;
      confirmLabel?: string;
      danger?: boolean;
    }) => {
      if (!options || typeof options.message !== 'string' || typeof options.title !== 'string') {
        return false;
      }
      const messageOptions: Electron.MessageBoxOptions = {
        type: options.danger ? 'warning' : 'question',
        title: options.title.slice(0, 120),
        message: options.message.slice(0, 500),
        detail: typeof options.detail === 'string' ? options.detail.slice(0, 2_000) : undefined,
        buttons: ['Cancel', options.confirmLabel?.slice(0, 80) || 'Continue'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const response = mainWindow
        ? await dialog.showMessageBox(mainWindow, messageOptions)
        : await dialog.showMessageBox(messageOptions);
      return response.response === 1;
    },
    false,
  );

  handle('app:set-document-state', (_event, state: {
    path?: string;
    name?: string;
    dirty?: boolean;
  }) => {
    if (!mainWindow) return;
    const name = state?.name?.trim().slice(0, 240) || 'Groundplan';
    mainWindow.setTitle(name === 'Groundplan' ? name : `${name} — Groundplan`);
    if (process.platform === 'darwin') {
      mainWindow.setDocumentEdited(!!state.dirty);
      const represented =
        typeof state?.path === 'string' && grantedPaths.has(pathIdentity(state.path))
          ? grantedPaths.get(pathIdentity(state.path)) ?? ''
          : '';
      mainWindow.setRepresentedFilename(represented);
    }
  });

  // --- editing ------------------------------------------------------------

  handle('edit:move', (_event, nodeId: number, dx: number, dy: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      return moveNode(s.loaded.document, node, dx, dy);
    }),
  );

  handle('edit:delete', (_event, nodeId: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      return deleteNode(s.loaded.document, s.index, node);
    }),
  );

  handle('edit:duplicate', (_event, nodeId: number, dx: number, dy: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      return duplicateNode(s.loaded.document, s.index, node, dx, dy);
    }),
  );

  handle('edit:recolor', (_event, nodeId: number, color: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      return recolorNode(s.loaded.document, node, color);
    }),
  );

  handle('edit:relabel', (_event, nodeId: number, text: string) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      return relabelNode(s.loaded.document, node, text);
    }),
  );

  // --- equipment inventory --------------------------------------------------

  handle(
    'inventory:list',
    (_event, query: string, department: string | null, category: string | null) =>
      inventoryState(query ?? '', department ?? null, (category as Category) ?? null),
  );

  /**
   * Gives every unshaped item the best drawn symbol available.
   *
   * A gear list carries names and sizes but no geometry, so those items place
   * as plain boxes. Mapping them by hand is impractical on a list of several
   * hundred, so each description is classified — projector, speaker, truss —
   * and matched to a symbol harvested from the shop's own plans.
   */
  handle('inventory:map-symbols', async () => {
    const summary = mapSymbols(inventory);
    await persistInventory();
    return { ok: true, ...summary, inventory: inventoryState() };
  });

  /** Folds the gear lists currently open into the inventory. */
  handle('inventory:absorb-gear', async () => {
    if (!gear) return { ok: false, reason: 'no gear list is open' };

    let added = 0;
    let updated = 0;
    for (const list of gear.lists) {
      for (const department of list.departments) {
        const incoming = [];
        for (const item of walkItems({ ...list, departments: [department] })) {
          if (item.note) continue;
          const size = parseDimensions(item.description);
          incoming.push({
            name: item.description,
            department: department.name,
            quantity: item.quantity,
            width: size.source === 'parsed' ? size.width : undefined,
            height: size.source === 'parsed' ? size.height : undefined,
            sizeSource: size.source === 'parsed' ? ('parsed' as const) : ('unknown' as const),
          });
        }
        const summary = mergeItems(inventory, incoming, new Date(), {
          id: list.jobNumber
            ? `gear-job:${normaliseName(list.jobNumber)}`
            : list.sourceFingerprint
              ? `gear-source:${list.sourceFingerprint}`
              : `gear-list:${list.id ?? list.sourcePath ?? list.title}`,
          type: 'gear-pdf',
          jobId: list.id ?? list.jobNumber,
          label: list.title,
          sourcePath: list.sourcePath,
        });
        added += summary.added;
        updated += summary.updated;
      }
    }

    await persistInventory();
    return { ok: true, added, updated, inventory: inventoryState() };
  });

  /** Imports straight from a gear-list PDF or a CSV, without opening it first. */
  /**
   * Harvests real drawn symbols out of a folder of plans.
   *
   * The gear list only ever gives a name and a size, which is why items placed
   * from it come out as plain boxes. The plans themselves hold the actual
   * outlines someone drew — a projector that looks like a projector — so
   * scanning a job folder is what turns the inventory from a list into a
   * palette.
   */
  handle('inventory:harvest', async (event) => {
    if (harvestRunning) {
      return { ok: false, reason: 'an Equipment Library scan is already running' };
    }
    const chosen = await dialog.showOpenDialog({
      title: 'Import symbols from plans',
      message: 'Choose a folder of plans to take drawn symbols from.',
      properties: ['openDirectory'],
    });
    if (chosen.canceled || chosen.filePaths.length === 0) return null;
    harvestRunning = true;
    harvestCancelled = false;
    harvestCompletion = new Promise<void>((resolve) => {
      finishHarvest = resolve;
    });
    const root = chosen.filePaths[0];

    const plans: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (harvestCancelled) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (/\.(rv4|rs4|se4)$/i.test(entry.name) && !isSidecar(entry.name)) plans.push(full);
      }
    };
    let added = 0;
    let updated = 0;
    let scanned = 0;
    let failed = 0;
    let processed = 0;

    try {
      await walk(root, 0);
      for (const plan of plans) {
        if (harvestCancelled) break;
        try {
          const doc = loadBuffer(await readFile(plan), plan).document;
          const summary = mergeItems(
            inventory,
            listSymbols(doc).map((sym) => ({
              name: sym.name,
              width: sym.width,
              height: sym.height,
              sizeSource: 'symbol' as const,
              symbolPath: plan,
            })),
            new Date(),
            { type: 'plan', sourcePath: plan, label: basename(plan) },
          );
          added += summary.added;
          updated += summary.updated;
          scanned++;
        } catch {
          failed++;
        }
        processed++;
        // Periodic durable checkpoints limit crash exposure without turning a
        // large 15,000-plan scan into thousands of filesystem writes.
        if (processed % 250 === 0) await persistInventory();
        // Frequent progress plus each awaited read keeps long scans visible
        // and gives cancellation a chance between plans.
        if (processed % 10 === 0 || processed === plans.length) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('inventory:harvest-progress', {
              scanned,
              processed,
              total: plans.length,
              added,
              failed,
              cancelled: harvestCancelled,
            });
          }
        }
      }

      await persistInventory();
      return {
        ok: true,
        added,
        updated,
        scanned,
        processed,
        failed,
        cancelled: harvestCancelled,
        plans: plans.length,
        inventory: inventoryState(),
      };
    } finally {
      harvestRunning = false;
      finishHarvest?.();
      finishHarvest = null;
    }
  });

  handle('inventory:cancel-harvest', () => {
    if (!harvestRunning) return { ok: false, reason: 'no Equipment Library scan is running' };
    harvestCancelled = true;
    return { ok: true };
  });

  handle('inventory:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Add to the equipment inventory',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Gear list, spreadsheet or shapes', extensions: ['pdf', 'csv', 'rv4', 'rs4', 'se4', 'add', 'stk', 'lib'] },
        { name: 'Gear list PDF', extensions: ['pdf'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Plans and shape libraries', extensions: ['rv4', 'rs4', 'se4', 'add', 'stk', 'lib'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    let added = 0;
    let updated = 0;
    for (const source of result.filePaths) {
      const lower = source.toLowerCase();

      // A plan or shape inventory contributes real symbols, not just names.
      if (/\.(rv4|rs4|se4|add|stk|lib)$/.test(lower)) {
        const shapes = listSymbols(loadBuffer(await readFile(source), source).document);
        const summary = mergeItems(
          inventory,
          shapes.map((sym) => ({
            name: sym.name,
            width: sym.width,
            height: sym.height,
            sizeSource: 'symbol' as const,
            symbolPath: source,
          })),
          new Date(),
          {
            type: /\.(add|stk|lib)$/.test(lower) ? 'symbol-library' : 'plan',
            sourcePath: source,
            label: basename(source),
          },
        );
        added += summary.added;
        updated += summary.updated;
        continue;
      }

      if (lower.endsWith('.csv')) {
        const summary = mergeItems(
          inventory,
          parseCsv(await readFile(source, 'utf8')),
          new Date(),
          { type: 'csv', sourcePath: source, label: basename(source) },
        );
        added += summary.added;
        updated += summary.updated;
        continue;
      }

      const lists = await importGearPdf(new Uint8Array(await readFile(source)), source);
      for (const list of lists) {
        for (const department of list.departments) {
          const incoming = [];
          for (const item of walkItems({ ...list, departments: [department] })) {
            if (item.note) continue;
            const size = parseDimensions(item.description);
            incoming.push({
              name: item.description,
              department: department.name,
              quantity: item.quantity,
              width: size.source === 'parsed' ? size.width : undefined,
              height: size.source === 'parsed' ? size.height : undefined,
              sizeSource: size.source === 'parsed' ? ('parsed' as const) : ('unknown' as const),
            });
          }
          const summary = mergeItems(inventory, incoming, new Date(), {
            id: list.jobNumber
              ? `gear-job:${normaliseName(list.jobNumber)}`
              : list.sourceFingerprint
                ? `gear-source:${list.sourceFingerprint}`
                : `gear-source-path:${canonicalPath(source)}:${list.title}`,
            type: 'gear-pdf',
            jobId: list.id ?? list.jobNumber,
            label: list.title,
            sourcePath: source,
          });
          added += summary.added;
          updated += summary.updated;
        }
      }
    }

    await persistInventory();
    return { ok: true, added, updated, files: result.filePaths.length, inventory: inventoryState() };
  });

  handle('inventory:add', async (_event, name: string, department?: string) => {
    const summary = mergeItems(inventory, [{ name, department }], new Date(), {
      id: `manual:${normaliseName(name)}`,
      type: 'manual',
      label: name.trim(),
    });
    await persistInventory();
    return { ok: summary.added > 0, reason: summary.added ? undefined : 'already in the inventory', inventory: inventoryState() };
  });

  handle(
    'inventory:update',
    async (_event, id: string, patch: { name?: string; department?: string; width?: number; height?: number; notes?: string }) => {
      if (!patch || typeof id !== 'string') return { ok: false, reason: 'invalid equipment edit' };
      const updated = updateInventoryItem(inventory, id, patch);
      if (!updated.ok) return { ok: false, reason: updated.reason };
      if (updated.changed) {
        await persistInventory();
        lastRemovedInventory = null;
      }
      return { ok: true, changed: updated.changed, inventory: inventoryState() };
    },
  );

  /**
   * Copies an item so a shop can keep variations of the same thing.
   *
   * Sizes, department and drawn symbol come across, because a variation is
   * nearly always the same object with a different name — "Round 60" in gold
   * linen" is still a 60 inch round.
   */
  handle('inventory:duplicate', async (_event, id: string, name?: string) => {
    const item = inventory.items.find((i) => i.id === id);
    if (!item) return { ok: false, reason: 'item no longer exists' };

    let wanted = name?.trim() || `${item.name} (copy)`;
    if (inventory.items.some((i) => normaliseName(i.name) === normaliseName(wanted))) {
      let n = 2;
      while (inventory.items.some((i) => normaliseName(i.name) === normaliseName(`${wanted} ${n}`))) n++;
      wanted = `${wanted} ${n}`;
    }

    const [copy] = mergeItems(
      inventory,
      [
        {
          name: wanted,
          department: item.department,
          width: item.width,
          height: item.height,
          sizeSource: item.sizeSource,
          symbolPath: item.symbolPath,
        },
      ],
      new Date(),
      { id: `manual-copy:${item.id}:${normaliseName(wanted)}`, type: 'manual', label: wanted },
    )
      ? [inventory.items[inventory.items.length - 1]]
      : [];

    if (copy) {
      copy.symbolName = item.symbolName;
      copy.mappedBy = item.mappedBy;
      copy.mapReason = item.mapReason;
      // A copy starts unused rather than inheriting the original's history.
      copy.timesSeen = 1;
    }

    await persistInventory();
    return { ok: true, id: copy?.id, inventory: inventoryState() };
  });

  /**
   * Plan-view previews for inventory rows.
   *
   * Batched, because the palette wants one per visible row and each is a
   * lookup into an already-parsed plan rather than a round trip worth making
   * individually.
   */
  handle(
    'inventory:thumbnails',
    async (_event, ids: string[]) => {
      const out: Record<string, Thumbnail | null> = {};
      for (const id of ids ?? []) {
        const item = inventory.items.find((i) => i.id === id);
        if (!item?.symbolPath || !existsSync(item.symbolPath)) {
          out[id] = null;
          continue;
        }

        const name = item.symbolName ?? item.name;
        const key = `${item.symbolPath}::${name}`;
        if (thumbnailCache.has(key)) {
          out[id] = thumbnailCache.get(key) ?? null;
          continue;
        }

        try {
          let scene = symbolSceneCache.get(item.symbolPath);
          if (!scene) {
            let doc = symbolCache.get(item.symbolPath);
            if (!doc) {
              doc = loadBuffer(await readFile(item.symbolPath), item.symbolPath).document;
              symbolCache.set(item.symbolPath, doc);
            }
            scene = buildScene(doc);
            symbolSceneCache.set(item.symbolPath, scene);
          }
          const thumbnail = symbolThumbnail(scene, name);
          thumbnailCache.set(key, thumbnail);
          out[id] = thumbnail;
        } catch {
          // A preview is a nicety; an unreadable source just means no picture.
          thumbnailCache.set(key, null);
          out[id] = null;
        }
      }
      return out;
    },
    {},
  );

  /**
   * Adds an item whose outline was traced from a picture.
   *
   * The geometry is stored on the item rather than pointing at a plan file,
   * because there is no plan behind it — the shape came from a datasheet or a
   * photograph. It shows in the palette immediately and travels with the
   * inventory.
   */
  handle(
    'inventory:add-traced',
    async (
      _event,
      payload: { name: string; width: number; height: number; paths: Array<{ points: number[]; closed: boolean }> },
    ) => {
      const name = payload?.name?.trim();
      if (!name) return { ok: false, reason: 'the item needs a name' };
      if (!payload.paths?.length) return { ok: false, reason: 'the traced outline is empty' };
      if (!(payload.width > 0) || !(payload.height > 0)) {
        return { ok: false, reason: 'the item needs a real width and depth' };
      }
      if (inventory.items.some((i) => normaliseName(i.name) === normaliseName(name))) {
        return { ok: false, reason: `there is already an item called "${name}"` };
      }

      // An outline is numbers. Anything else means something came along with
      // it that should not have.
      for (const path of payload.paths) {
        if (typeof path.closed !== 'boolean' || !Array.isArray(path.points)) {
          return { ok: false, reason: 'the traced outline is malformed' };
        }
        for (const value of path.points) {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { ok: false, reason: 'the traced outline is malformed' };
          }
        }
      }

      mergeItems(inventory, [
        { name, width: payload.width, height: payload.height, sizeSource: 'user' },
      ]);
      const created = inventory.items.find((i) => normaliseName(i.name) === normaliseName(name));
      if (created) {
        created.category = classify(name).category;
        created.tracedIcon = { paths: payload.paths, width: payload.width, height: payload.height };
      }

      await persistInventory();
      return { ok: true, id: created?.id, inventory: inventoryState() };
    },
  );

  handle('inventory:remove', async (_event, id: string) => {
    const removed = removeInventoryItem(inventory, id);
    if (!removed.ok) return { ok: false, reason: removed.reason };
    if (!removed.changed || !removed.value) return { ok: false, reason: 'the equipment item was not removed' };
    lastRemovedInventory = removed.value;
    await persistInventory();
    return { ok: true, undoAvailable: true, inventory: inventoryState() };
  });

  handle('inventory:restore-last', async () => {
    if (!lastRemovedInventory) {
      return { ok: false, reason: 'there is no deleted equipment item to restore' };
    }
    const restored = restoreInventoryItem(inventory, lastRemovedInventory);
    if (!restored.ok) return { ok: false, reason: restored.reason };
    if (!restored.changed || !restored.value) {
      return { ok: false, reason: 'the equipment item was not restored' };
    }
    lastRemovedInventory = null;
    await persistInventory();
    return { ok: true, restoredId: restored.value.id, inventory: inventoryState() };
  });

  /** Places a inventory item, using its remembered footprint when it has one. */
  handle('inventory:place', async (_event, id: string, x: number, y: number) => {
    const item = locateInventoryItem(inventory, id);
    if (!item) return { ok: false, reason: 'item no longer exists' };

    const placeAsBox = () =>
      applyEdit((s) =>
        placeGear(
          s.loaded.document,
          s.index,
          item.name,
          x,
          y,
          item.width && item.height ? { width: item.width, height: item.height } : undefined,
        ),
      );

    if (item.symbolPath && existsSync(item.symbolPath)) {
      let source = symbolCache.get(item.symbolPath);
      if (!source) {
        try {
          source = loadBuffer(await readFile(item.symbolPath), item.symbolPath).document;
          symbolCache.set(item.symbolPath, source);
        } catch {
          // An unreadable or unplugged source is not a reason to fail the
          // placement; fall through and draw the item as a sized box.
          source = undefined;
        }
      }
      const from = source;
      if (!from) return placeAsBox();
      // A matched item borrows a shape drawn under a different name — the gear
      // list says "Panasonic PT-RZ21KU", the drawing says "LCD Projector".
      const lookFor = item.symbolName ?? item.name;
      const imported = applyEdit((s) => importSymbol(s.loaded.document, s.index, from, lookFor, x, y));
      // Fall through to a drawn box only if the symbol could not be brought in.
      if (imported.ok) return imported;
    }

    return placeAsBox();
  });

  // --- gear lists ---------------------------------------------------------

  handle('gear:import', async () => {
    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    const result = await dialog.showOpenDialog({
      title: 'Import a gear list',
      properties: ['openFile'],
      filters: [{ name: 'Gear list PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    if (!(await confirmDiscard('gear'))) return null;

    const source = grantPath(result.filePaths[0]);
    await enforceFileSize(source, MAX_IMPORT_BYTES);
    const lists = await importGearPdf(new Uint8Array(await readFile(source)), source);
    gear = { lists, dirty: true };
    lastRemovedGear = null;
    activeGearRecoveryId = null;
    scheduleGearRecovery();
    return gearState();
  });

  handle('gear:import-path', async (_event, source: string) => {
    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    if (!(await confirmDiscard('gear'))) return null;
    source = requireGrantedPath(source, ['.pdf']);
    await enforceFileSize(source, MAX_IMPORT_BYTES);
    const lists = await importGearPdf(new Uint8Array(await readFile(source)), source);
    gear = { lists, dirty: true };
    lastRemovedGear = null;
    activeGearRecoveryId = null;
    scheduleGearRecovery();
    return gearState();
  });

  handle('gear:open-path', async (_event, path: string) => {
    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    if (!(await confirmDiscard('gear'))) return null;
    path = requireGrantedPath(path, ['.json']);
    await enforceFileSize(path, MAX_IMPORT_BYTES);
    const loaded = await loadGearFileWithStatus(path);
    const notice = loaded.recoveredFromBackup
      ? 'Recovered this gear list from its last-good backup. The damaged file was quarantined.'
      : loaded.migration.changed
        ? 'Updated this gear list to the current safe format. Its original IDs and hierarchy were preserved.'
        : undefined;
    gear = {
      lists: loaded.lists,
      path,
      dirty: loaded.migration.changed,
      notice,
      savedDigest: sha256(await readFile(path)),
    };
    lastRemovedGear = null;
    activeGearRecoveryId = null;
    return gearState();
  });

  handle('gear:open', async () => {
    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    const result = await dialog.showOpenDialog({
      title: 'Open a gear list',
      properties: ['openFile'],
      filters: [{ name: 'Groundplan gear list', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    if (!(await confirmDiscard('gear'))) return null;
    const path = grantPath(result.filePaths[0]);
    await enforceFileSize(path, MAX_IMPORT_BYTES);
    const loaded = await loadGearFileWithStatus(path);
    const notice = loaded.recoveredFromBackup
      ? 'Recovered this gear list from its last-good backup. The damaged file was quarantined.'
      : loaded.migration.changed
        ? 'Updated this gear list to the current safe format. Save once to keep the migration.'
        : undefined;
    gear = {
      lists: loaded.lists,
      path,
      dirty: loaded.migration.changed,
      notice,
      savedDigest: sha256(await readFile(path)),
    };
    lastRemovedGear = null;
    activeGearRecoveryId = null;
    return gearState();
  });

  handle('gear:save', (_event, saveAs: boolean) => saveGearDocument(saveAs === true));

  handle(
    'show:get',
    async (): Promise<ShowLinkState> => showLinkState(session?.path, gear?.path),
    { manifest: null, linked: false, reason: 'Show link could not be read' },
  );

  handle('show:link-current', async (_event, listIndex: number) => {
    const list = gear?.lists[listIndex];
    if (!session) return { ok: false, reason: 'open a plan first' };
    if (!gear || !list) return { ok: false, reason: 'open a gear list first' };
    if (!gear.path) return { ok: false, reason: 'save the gear list before linking it to a Show' };
    if (gear.dirty) return { ok: false, reason: 'save the latest gear changes before linking this pair' };
    const show = await linkShow(session.path, gear.path, list);
    grantPath(showFileFor(session.path));
    return { ok: true, show };
  });

  /** Compares the open gear list against what the open plan actually shows. */
  handle('gear:reconcile', async (_event, listIndex: number): Promise<ReconcileReport | null> => {
    const list = gear?.lists[listIndex];
    if (!list || !session) return null;
    const show = await showLinkState(session.path, gear?.path);
    return reconcile(list, session.scene, {
      planId: show.manifest?.id,
      planRevision: session.revision,
      planPath: session.path,
    });
  });

  handle('gear:place-all', (_event, listIndex: number) => {
    const list = gear?.lists[listIndex];
    if (!list) return { ok: false, reason: 'no gear list is open' };
    return applyEdit((s) => placeGearList(s, list));
  });

  handle('gear:export-csv', async (_event, listIndex: number) => {
    const list = gear?.lists[listIndex];
    if (!list) return null;
    const { toCsv } = await import('../gear/model.js');
    const result = await dialog.showSaveDialog({
      title: 'Export gear list as CSV',
      defaultPath: `${list.title.replace(/[\\/:*?"<>|]/g, '-')}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await atomicWriteFile(result.filePath, toCsv(list));
    return grantPath(result.filePath);
  });

  handle('gear:update', (_event, listIndex: number, itemId: string, patch: GearItemPatch) => {
    const list = gear?.lists[listIndex];
    if (!list || !gear) return { ok: false, reason: 'no gear list is open' };
    if (!patch || typeof itemId !== 'string') return { ok: false, reason: 'invalid gear edit' };

    if (patch.remove) {
      const removed = removeGearItem(list, itemId);
      if (!removed.ok) return { ok: false, reason: removed.reason };
      if (!removed.changed || !removed.value) return { ok: false, reason: 'the gear row was not removed' };
      lastRemovedGear = { listId: list.id, listIndex, removed: removed.value };
      gear.dirty = true;
      scheduleGearRecovery();
      return { ok: true, gear: gearState(), undoAvailable: true };
    }

    const updated = updateGearItem(list, itemId, {
      checked: patch.checked,
      quantity: patch.quantity,
      description: patch.description,
    });
    if (!updated.ok) return { ok: false, reason: updated.reason };
    if (updated.changed) {
      gear.dirty = true;
      lastRemovedGear = null;
      scheduleGearRecovery();
    }
    return { ok: true, gear: gearState(), changed: updated.changed };
  });

  handle('gear:restore-last', () => {
    if (!gear || !lastRemovedGear) return { ok: false, reason: 'there is no deleted gear row to restore' };
    const list = gear.lists[lastRemovedGear.listIndex];
    if (!list || (lastRemovedGear.listId && list.id !== lastRemovedGear.listId)) {
      lastRemovedGear = null;
      return { ok: false, reason: 'the deleted row belongs to a different gear list' };
    }
    const restored = restoreGearItem(list, lastRemovedGear.removed);
    if (!restored.ok) return { ok: false, reason: restored.reason };
    if (!restored.changed || !restored.value) return { ok: false, reason: 'the gear row was not restored' };
    lastRemovedGear = null;
    gear.dirty = true;
    scheduleGearRecovery();
    return { ok: true, gear: gearState(), restoredId: restored.value.id };
  });

  handle(
    'gear:add',
    (_event, listIndex: number, departmentId: string, parentId: string | null, description: string) => {
      const list = gear?.lists[listIndex];
      if (!list || !gear) return { ok: false, reason: 'no gear list is open' };
      const department = list.departments.find((d) => d.id === departmentId);
      if (!department) return { ok: false, reason: 'department no longer exists' };

      const item = {
        id: nextId(),
        quantity: 1,
        description: description.trim() || 'New item',
        children: [],
      };
      if (parentId) {
        const parent = locateGearItem(list, parentId);
        if (!parent) return { ok: false, reason: 'package no longer exists' };
        parent.item.children.push(item);
      } else {
        department.items.push(item);
      }

      list.revision = (Number.isSafeInteger(list.revision) ? list.revision! : 0) + 1;
      gear.dirty = true;
      lastRemovedGear = null;
      scheduleGearRecovery();
      return { ok: true, gear: gearState(), createdId: item.id };
    },
  );

  handle('plan:place-gear', (_event, description: string, x: number, y: number) =>
    applyEdit((s) => placeGear(s.loaded.document, s.index, description, x, y)),
  );

  handle('plan:rotate', (_event, nodeId: number, degrees: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      return rotateNode(s.loaded.document, node, (degrees * Math.PI) / 180);
    }),
  );

  handle('plan:resize', (_event, nodeId: number, width: number, height: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      const current = measureNode(node);
      if (current.width <= 0 || current.height <= 0) {
        return { ok: false, reason: 'this item has no size to change' };
      }
      return resizeNode(s.loaded.document, node, width / current.width, height / current.height);
    }),
  );

  handle('plan:add-seating', (_event, request: SeatingRequest) =>
    applyEdit((s) => addSeating(s.loaded.document, s.index, request)),
  );

  handle('plan:add-label', (_event, text: string, x: number, y: number) =>
    applyEdit((s) => createLabel(s.loaded.document, s.index, text, x, y)),
  );

  handle(
    'plan:add-dimension',
    (
      _event,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      startNodeId?: number,
      endNodeId?: number,
    ) => {
      let registered = false;
      const reply = applyEdit((s) => {
        const created = createDimension(s.loaded.document, s.index, x1, y1, x2, y2);
        if (created.ok && created.created) {
          registered = registerDimensionAssociation(
            s.loaded.document,
            s.index,
            dimensionAssociations,
            created.created,
            { x: x1, y: y1, nodeId: startNodeId },
            { x: x2, y: y2, nodeId: endNodeId },
          );
        }
        return created;
      });
      if (reply.ok && registered && session) {
        persistDimensionAssociations(session.path);
      }
      return reply;
    },
  );


  // ---------------------------------------------------------------------
  // The plan model: room, seating, stage, report.
  //
  // Read calls return plain numbers and text the panel can display; write
  // calls go through `applyEdit`, so each is one undoable step and a failed
  // one leaves the document exactly as it was.
  // ---------------------------------------------------------------------

  handle('plan:model', () => (session ? planModelView(session, unitSystem()) : null), null);

  handle('plan:room-create', (_event, width: number, height: number) =>
    applyEdit((s) => createRectangularRoom(s, width, height, unitSystem())),
  );

  handle('plan:room-reshape', (
    _event,
    op: 'union' | 'difference',
    x: number,
    y: number,
    width: number,
    height: number,
  ) => applyEdit((s) => reshapeRoom(s, op, x, y, width, height, unitSystem())));

  handle('plan:room-curve', (_event, wallIndex: number, radius: number) =>
    applyEdit((s) => curveRoomWall(s, wallIndex, radius, unitSystem())),
  );

  handle('plan:room-dimension', () => applyEdit((s) => dimensionTheRoom(s, unitSystem())));

  handle('plan:drape-perimeter', () => applyEdit((s) => drapePerimeter(s)));

  /** Solves without drawing, so the panel can show the count as it is tuned. */
  handle(
    'plan:seating-preview',
    (_event, request: SeatingRequestView) => (session ? previewSeating(session, request) : null),
    null,
  );

  handle('plan:seating-apply', (_event, request: SeatingRequestView, chair: string, table?: string) =>
    applyEdit((s) => applySeatingModel(s, request, chair, table)),
  );

  handle('plan:seating-remove', (_event, regionId: string) =>
    applyEdit((s) => removeSeatingRegion(s, regionId)),
  );

  handle('plan:seating-region-of', (_event, ids: number[]) => seatingRegionOf(Array.isArray(ids) ? ids : []), null);

  handle(
    'plan:stage-add',
    (_event, x: number, y: number, width: number, depth: number, height: number) => {
      let extra: { buildList?: unknown; warnings?: string[] } = {};
      const reply = applyEdit((s) => {
        const result = addStage(s, x, y, width, depth, height);
        extra = { buildList: result.buildList, warnings: result.warnings };
        return result;
      });
      return { ...reply, ...extra };
    },
  );

  handle('plan:draw', (_event, tool: DrawTool, x1: number, y1: number, x2: number, y2: number) =>
    applyEdit((s) => drawShape(s, tool, x1, y1, x2, y2)),
  );

  handle('plan:stage-clear', () => {
    clearStage();
    return { ok: true };
  });

  handle(
    'plan:allocation',
    (_event, owned: Array<{ name: string; quantity: number }>) =>
      session ? planAllocation(session, Array.isArray(owned) ? owned : []) : null,
    null,
  );

  handle('plan:report-export', async (_event, options: ReportOptions) => {
    const s = session;
    if (!s) return { ok: false, reason: 'no plan is open' };

    const markdown = planReport(s, { ...options, units: unitSystem() });
    const suggested = `${basename(s.path).replace(/\.[^.]+$/, '')} report.md`;
    const target = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export plan report',
      defaultPath: suggested,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (target.canceled || !target.filePath) return { ok: false, cancelled: true };

    await writeFile(target.filePath, markdown, 'utf8');
    grantPath(target.filePath);
    return { ok: true, path: target.filePath };
  });


  /** Room sizes the new-plan dialog offers. */
  handle('plan:room-presets', () => ROOM_PRESETS, []);

  /**
   * Starts a new plan.
   *
   * The file is written before it is opened, so a new plan is a real document
   * from the first moment rather than something that only becomes one if the
   * user remembers to save. That keeps every other path — recovery, the
   * companion, recent files, the round-trip gate — working exactly as it does
   * for a plan that was opened.
   */
  handle('file:new', async (_event, options: { name?: string; width?: number; depth?: number }) => {
    const width = Number(options?.width) || 0;
    const depth = Number(options?.depth) || 0;

    const built = createBlankPlan({
      room: width > 0 && depth > 0 ? { width, depth } : undefined,
      roomName: typeof options?.name === 'string' && options.name.trim() ? options.name.trim() : undefined,
    });
    if (!built.ok || !built.file) return { ok: false, reason: built.reason };

    const suggested = `${(options?.name ?? 'Untitled plan').trim() || 'Untitled plan'}.rv4`;
    const target = await dialog.showSaveDialog(mainWindow!, {
      title: 'New plan',
      defaultPath: suggested,
      filters: [{ name: 'Room Viewer plan', extensions: ['rv4'] }],
    });
    if (target.canceled || !target.filePath) return { ok: false, cancelled: true };

    await writeFile(target.filePath, built.file);
    grantPath(target.filePath);
    return { ok: true, doc: await openPath(target.filePath) };
  });

  handle('plan:preview-gear', (_event, description: string) => parseDimensions(description));

  /**
   * Applies one operation to many objects as a single undoable step.
   *
   * Nudging forty chairs should be one entry in the history, not forty.
   */
  handle(
    'edit:batch',
    (
      _event,
      kind:
        | 'move'
        | 'delete'
        | 'duplicate'
        | 'rotate'
        | 'recolor'
        | 'flip-horizontal'
        | 'flip-vertical'
        | 'bring-to-front'
        | 'send-to-back',
      ids: number[],
      a = 0,
      b = 0,
    ) =>
      applyEdit((s) => {
        let touched = 0;
        const reasons: string[] = [];
        const created: number[] = [];

        const targets = ids
          .map((id) => s.index.byId.get(id))
          .filter((n): n is NonNullable<typeof n> => !!n);

        // Delete deepest-first so removing a parent does not leave a dangling
        // child id that deleteNode would then fail to locate.
        if (kind === 'delete') {
          const depthOf = (node: (typeof targets)[number]): number => {
            let depth = 0;
            let current: typeof node | undefined = node;
            while (current) {
              const parent = s.index.parentOf.get(current);
              if (!parent) break;
              depth++;
              current = parent;
            }
            return depth;
          };
          targets.sort((a, b) => depthOf(b) - depthOf(a));
        }

        for (const node of targets) {
          let result: { ok: boolean; reason?: string; created?: number[] };
          switch (kind) {
            case 'move':
              result = moveNode(s.loaded.document, node, a, b);
              break;
            case 'rotate':
              result = rotateNode(s.loaded.document, node, (a * Math.PI) / 180);
              break;
            case 'duplicate':
              result = duplicateNode(s.loaded.document, s.index, node, a, b);
              break;
            case 'recolor':
              result = recolorNode(s.loaded.document, node, a);
              break;
            case 'flip-horizontal':
              result = flipNode(s.loaded.document, node, 'horizontal');
              break;
            case 'flip-vertical':
              result = flipNode(s.loaded.document, node, 'vertical');
              break;
            case 'bring-to-front':
              result = reorderChild(s.loaded.document, s.index, node, 'front');
              break;
            case 'send-to-back':
              result = reorderChild(s.loaded.document, s.index, node, 'back');
              break;
            default:
              result = deleteNode(s.loaded.document, s.index, node);
          }
          if (result.ok) {
            touched++;
            if (result.created) created.push(...result.created);
          }
          else if (result.reason && !reasons.includes(result.reason)) reasons.push(result.reason);
        }

        if (touched === 0) {
          return { ok: false, reason: reasons[0] ?? 'nothing could be changed' };
        }
        return { ok: true, created: created.length ? created : undefined };
      }),
  );

  handle('edit:arrange', (_event, mode: ArrangeMode, ids: number[]) =>
    applyEdit((s) => {
      // Large production plans can contain thousands of primitives. Accumulate
      // all selected bounds in one scene pass rather than rescanning the scene
      // once per selected object.
      const selected = new Set(ids);
      const boundsById = new Map<number, ArrangeBounds>();
      for (const primitive of s.scene.primitives) {
        if (!selected.has(primitive.selectId)) continue;
        let bounds = boundsById.get(primitive.selectId);
        if (!bounds) {
          bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          boundsById.set(primitive.selectId, bounds);
        }
        for (let i = 0; i < primitive.pts.length; i += 2) {
          bounds.minX = Math.min(bounds.minX, primitive.pts[i]);
          bounds.minY = Math.min(bounds.minY, primitive.pts[i + 1]);
          bounds.maxX = Math.max(bounds.maxX, primitive.pts[i]);
          bounds.maxY = Math.max(bounds.maxY, primitive.pts[i + 1]);
        }
      }

      const items = ids.flatMap((id) => {
        const bounds = boundsById.get(id);
        return bounds && Number.isFinite(bounds.minX) ? [{ id, bounds }] : [];
      });
      const moves = arrangeMoves(items, mode);
      if (!moves.length) {
        return {
          ok: false,
          reason: mode.startsWith('distribute-')
            ? 'select at least three items to distribute'
            : 'select at least two items to align',
        };
      }

      let touched = 0;
      for (const move of moves) {
        if (move.dx === 0 && move.dy === 0) continue;
        const node = s.index.byId.get(move.id);
        if (!node) continue;
        if (moveNode(s.loaded.document, node, move.dx, move.dy).ok) touched++;
      }
      return touched
        ? { ok: true }
        : { ok: false, reason: 'the selected items are already arranged that way' };
    }),
  );

  handle('edit:undo', () => {
    if (!session) return null;
    const currentAssociations = cloneDimensionAssociations();
    const previousAssociations = dimensionUndoStack.pop();
    if (!session.undo()) {
      if (previousAssociations) dimensionUndoStack.push(previousAssociations);
      return null;
    }
    dimensionRedoStack.push(currentAssociations);
    if (dimensionRedoStack.length > 100) dimensionRedoStack.shift();
    if (previousAssociations) dimensionAssociations = previousAssociations;
    updateAssociativeDimensions(
      session.loaded.document,
      session.index,
      dimensionAssociations,
    );
    session.refresh();
    persistDimensionAssociations(session.path);
    schedulePlanRecovery(session);
    return describe(session);
  });

  handle('edit:redo', () => {
    if (!session) return null;
    const currentAssociations = cloneDimensionAssociations();
    const nextAssociations = dimensionRedoStack.pop();
    if (!session.redo()) {
      if (nextAssociations) dimensionRedoStack.push(nextAssociations);
      return null;
    }
    dimensionUndoStack.push(currentAssociations);
    if (dimensionUndoStack.length > 100) dimensionUndoStack.shift();
    if (nextAssociations) dimensionAssociations = nextAssociations;
    updateAssociativeDimensions(
      session.loaded.document,
      session.index,
      dimensionAssociations,
    );
    session.refresh();
    persistDimensionAssociations(session.path);
    schedulePlanRecovery(session);
    return describe(session);
  });

  handle('edit:selection', (_event, nodeId: number): SelectionInfo | null => {
    const node = session?.index.byId.get(nodeId);
    if (!node || !session) return null;
    const name = node.labels.find((s) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(s));
    const measured = measureNode(node);
    return {
      nodeId,
      cls: node.cls,
      name,
      text: node.cls === 'RVLabel' ? name : undefined,
      color: session.scene.primitives.find((primitive) => primitive.selectId === nodeId)?.color ?? node.color,
      canDelete: !session.index.shared.has(node),
      canRelabel: node.cls === 'RVLabel' && node.fields.textAt != null,
      widthUnits: measured.width,
      heightUnits: measured.height,
      x: (node.bounds.left + node.bounds.right) / 2,
      y: (node.bounds.top + node.bounds.bottom) / 2,
    };
  });

  // --- saving -------------------------------------------------------------

  handle('file:save', (_event, saveAs: boolean) => savePlanDocument(saveAs === true));

  handle(
    'dir:list',
    async (_event, path: string): Promise<DirectoryEntry[]> => {
    path = requireGrantedDirectory(path);
    const entries = await readdir(path, { withFileTypes: true });
    const out: DirectoryEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!ALL_EXTENSIONS.includes(ext) || isSidecar(entry.name)) continue;
      const full = grantPath(join(path, entry.name));
      try {
        const { size, mtimeMs } = await (await import('node:fs/promises')).stat(full);
        out.push({ path: full, name: entry.name, extension: ext, size, modified: mtimeMs });
      } catch {
        // Unreadable entries are skipped rather than failing the whole listing.
      }
    }
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    },
    [],
  );

  handle(
    'app:recent',
    async (): Promise<RecentFile[]> => {
      // Drop anything that has been moved or deleted since it was opened, and
      // return enough context for duplicate or long filenames to be useful.
      const alive: string[] = [];
      const entries: RecentFile[] = [];
      for (const path of recentFiles) {
        try {
          const info = await stat(path);
          alive.push(path);
          grantPath(path);
          entries.push({
            path,
            name: basename(path),
            folder: basename(dirname(path)),
            extension: extname(path).replace(/^\./, '').toUpperCase(),
            size: info.size,
            modified: info.mtimeMs,
            openedAt: recentOpenedAt.get(path) ?? 0,
          });
        } catch {
          // Missing and unreadable files simply fall out of the recent list.
          recentOpenedAt.delete(path);
        }
      }
      if (alive.length !== recentFiles.length) {
        recentFiles = alive;
        persistRecents();
        persistRecentTimes();
      }
      return entries;
    },
    [],
  );

  handle('export:svg', async (_event, payload: { suggestedName: string; svg: string }) => {
    if (
      !payload ||
      typeof payload.suggestedName !== 'string' ||
      typeof payload.svg !== 'string' ||
      payload.svg.length > 100 * 1024 * 1024
    ) {
      throw new Error('invalid or oversized SVG export');
    }
    const result = await dialog.showSaveDialog({
      title: 'Export plan as SVG',
      defaultPath: payload.suggestedName,
      filters: [{ name: 'SVG image', extensions: ['svg'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await atomicWriteFile(result.filePath, payload.svg);
    return grantPath(result.filePath);
  });

  handle('schedule:build', async (): Promise<Schedule | null> => {
    if (!session) return null;
    const stable = await buildStableSchedule(session.loaded.document, session.path);
    return Object.assign(stable.schedule, { warnings: stable.warnings });
  });

  handle('schedule:set-field', async (_event, key: string, field: string, value: string) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const stable = await setStableScheduleField(
      session.loaded.document,
      session.path,
      key,
      field,
      value,
    );
    grantPath(dataFileFor(session.path));
    return {
      ok: true,
      schedule: Object.assign(stable.schedule, { warnings: stable.warnings }),
    };
  });

  handle('schedule:key', (_event, name: string, x: number, y: number) => entryKey(name, x, y));

  handle('schedule:export', async (_event, summary: boolean) => {
    if (!session) return null;
    const { schedule } = await buildStableSchedule(session.loaded.document, session.path);
    const base = session.loaded.name.replace(/\.[^.]+$/, '');
    const result = await dialog.showSaveDialog({
      title: summary ? 'Export item counts' : 'Export schedule',
      defaultPath: `${base}${summary ? ' counts' : ' schedule'}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await atomicWriteFile(
      result.filePath,
      summary ? scheduleSummaryCsv(schedule) : scheduleToCsv(schedule),
    );
    return grantPath(result.filePath);
  });

  handle('print:scales', () => SCALES.map((s2) => ({ id: s2.id, label: s2.label })), []);

  /**
   * DXF for Vectorworks and other CAD.
   *
   * Written alongside the item schedule, because the pair is what makes the 3D
   * pass quick: the DXF brings the geometry across as reusable symbols, and the
   * CSV brings the counts and positions that a Vectorworks worksheet reads.
   */
  handle('export:dxf', async (_event, layers?: string[], includeSchedule = true) => {
    if (!session) return { ok: false, reason: 'no plan is open' };

    const base = session.loaded.name.replace(/\.[^.]+$/, '');
    const chosen = await dialog.showSaveDialog({
      title: 'Export DXF for CAD',
      defaultPath: `${base}.dxf`,
      filters: [{ name: 'DXF drawing', extensions: ['dxf'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };

    const visible = layers && layers.length > 0 ? new Set(layers as Scene['primitives'][number]['layer'][]) : undefined;
    const result = toDxf(session.loaded.document, session.scene, { visible });
    await atomicWriteFile(chosen.filePath, result.text);
    grantPath(chosen.filePath);

    // The schedule rides along unless asked not to; nobody wants to remember to
    // export it separately.
    const csvPath = chosen.filePath.replace(/\.dxf$/i, '') + ' schedule.csv';
    try {
      if (!includeSchedule) throw new Error('skipped by preference');
      const { schedule } = await buildStableSchedule(session.loaded.document, session.path);
      await atomicWriteFile(csvPath, scheduleToCsv(schedule));
      grantPath(csvPath);
    } catch {
      // A missing schedule should not fail the drawing export.
    }

    return {
      ok: true,
      path: chosen.filePath,
      blocks: result.blocks,
      inserts: result.inserts,
      loose: result.loose,
    };
  });

  handle(
    'print:pdf',
    async (_event, payload: Omit<PrintRequest, 'printedOn'> & { suggestedName: string }) => {
      const result = await dialog.showSaveDialog({
        title: 'Print plan to PDF',
        defaultPath: payload.suggestedName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

      let fit: { fits: boolean; overBy: number };
      try {
        fit = await printPlanToPdf(
          { ...payload, printedOn: new Date().toLocaleDateString() },
          result.filePath,
        );
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      // A fixed scale prints to size, so an oversized room crops rather than
      // shrinking. Say so — a silently cropped sheet is worse than no sheet.
      return { ok: true, path: grantPath(result.filePath), fits: fit.fits, overBy: fit.overBy };
    },
  );

  handle('settings:get', async () => {
    settings ??= await loadSettings(app.getPath('userData'));
    return settings;
  });

  /**
   * Applies a partial settings change.
   *
   * A patch rather than the whole object, so one panel cannot overwrite a field
   * another panel changed a moment earlier.
   */
  handle('settings:patch', async (_event, patch: Partial<Settings>) => {
    settings ??= await loadSettings(app.getPath('userData'));
    settings = applyPatch(settings, patch ?? {});
    await saveSettings(app.getPath('userData'), settings);
    return { ok: true, settings };
  });

  handle('app:check-update', async () => {
    await runAppUpdate(true);
    await runCatalogUpdate(true);
    return { ok: true };
  });

  handle('app:update-from-usb', async () => {
    await runUsbUpdate();
    return { ok: true };
  });

  handle('shell:reveal', (_event, path: string) => {
    shell.showItemInFolder(requireGrantedPath(path));
  });

  inventoryFile = inventoryPath(app.getPath('userData'));
  const loadedInventory = await loadInventoryWithStatus(inventoryFile);
  inventory = loadedInventory.inventory;
  const inventoryMessages = [...loadedInventory.warnings];
  if (loadedInventory.migration?.changed) {
    inventoryMessages.push('Updated the Equipment Library to the current safe format.');
  }
  inventoryNotice = inventoryMessages.length ? inventoryMessages.join(' ') : undefined;
  // Inventories saved before categories existed get them filled in on load.
  const filledCategories = ensureCategories(inventory);
  if (
    filledCategories > 0 ||
    (loadedInventory.migration?.changed && !loadedInventory.warnings.some((message) => message.includes('could not be read')))
  ) {
    await persistInventory();
  }
  recentsFile = join(app.getPath('userData'), 'recent-files.json');
  recentTimesFile = join(app.getPath('userData'), 'recent-opened.json');
  await loadRecents();
  planFoldersFile = join(app.getPath('userData'), 'plan-folders.json');
  const loadedPlanFolders = await loadPlanFolders(planFoldersFile);
  planFolders = loadedPlanFolders.library;
  planFolderNotice = loadedPlanFolders.warnings.length
    ? loadedPlanFolders.warnings.join(' ')
    : undefined;

  buildMenu();

  // Quiet check a little after launch — late enough not to compete with opening
  // a plan, and it says nothing unless there is an update. Off if asked.
  setTimeout(() => {
    void (async () => {
      settings ??= await loadSettings(app.getPath('userData'));
      if (settings.app.checkOnLaunch) await runAppUpdate(false);
      await runCatalogUpdate(false);
    })();
  }, 8000);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Opening a plan by double-click / "Open With" on macOS.
app.on('open-file', (event, path) => {
  event.preventDefault();
  dispatchOpenPath(path);
  if (!mainWindow) {
    void app.whenReady().then(() => {
      if (!mainWindow) createWindow();
    });
  }
});

export { PLAN_EXTENSIONS, LIBRARY_EXTENSIONS, basename, dirname };
