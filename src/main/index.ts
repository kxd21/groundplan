/**
 * Electron main process.
 *
 * All file parsing happens here, in Node, and only the flattened scene crosses
 * the IPC boundary — a large ballroom plan is tens of thousands of objects, and
 * shipping the raw object tree to the renderer would cost far more than the
 * draw list it turns into.
 */

import { isBrokenPipe } from './ignore-epipe.js';
import type { CableKind } from '../format/cable.js';
import {
  deleteVersion,
  listVersions,
  readVersion,
  renameVersion,
  saveVersion,
} from './version-store.js';
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, type MenuItemConstructorOptions } from 'electron';
import { join, dirname, basename, extname } from 'node:path';
import { readdir, readFile, stat, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { COMMAND_LIST, isCommandId } from '../shell/command-ids.js';

// Electron shows a modal for every main-process uncaughtException. EPIPE from a
// closed stdout/stderr is harmless — hide that dialog if one still slips through.
{
  const showErrorBox = dialog.showErrorBox.bind(dialog);
  dialog.showErrorBox = (title, content) => {
    if (/\bEPIPE\b/.test(content) || /\bEPIPE\b/.test(title)) return;
    showErrorBox(title, content);
  };
  process.on('uncaughtException', (err) => {
    if (isBrokenPipe(err)) return;
  });
}

import { buildScene, type Scene } from '../format/scene.js';
import { symbolThumbnail, type Thumbnail } from '../format/thumbnail.js';
import { toDxf } from '../format/dxf.js';
import { applyPatch, loadSettings, saveSettings, type Settings } from './settings.js';
import {
  checkForAppUpdate,
  cleanStaging,
  installAppUpdate,
  stageAppUpdate,
  type StagedUpdate,
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
import {
  clearReminder,
  formatReminderTime,
  loadReminder,
  msUntilReminder,
  reminderAfterLater,
  reminderAfterSchedule,
  saveReminder,
  scheduleOptions,
  shouldOfferUpdate,
} from '../update/reminder.js';
import {
  canRevert,
  clearRollback,
  loadRollback,
  planRevert,
  saveRollback,
} from '../update/rollback.js';
import { loadBuffer } from '../format/index.js';
import { findCatalogPath, loadCatalog, lookup, type Catalog } from '../format/catalog.js';
import {
  moveNode,
  deleteNode,
  duplicateNode,
  indexDocument,
  recolorNode,
  renameNode,
  rotateNode,
  rotateNodeAbout,
  nodeCentre,
  resizeNode,
  measureNode,
  orientedExtent,
  setPoints,
  flipNode,
  setLabelStyle,
  reorderChild,
  scalePlanUniform,
  type LabelStylePatch,
} from '../format/edit.js';
import { convertSegmentKind, type EditableSegmentKind } from '../format/path-edit.js';
import { arrangeMoves, type ArrangeBounds, type ArrangeMode } from '../format/arrange.js';
import { addSeating, type SeatingRequest } from '../format/seating.js';
import {
  annotationCapabilities,
  createLabel,
  createDimension,
  formatDistance,
  setDimensionLengthAngle,
  type AnnotationCapabilities,
} from '../format/annotate.js';
import { type UnitSystem } from '../format/units.js';
import { INSERT_TREE, isInsertLeaf, type InsertBranch, type InsertLeaf } from '../inventory/insert-catalog.js';
import { walk, type RVDocument, type RVNode } from '../format/rv.js';
import { importDetachedObject, listSymbols, importSymbol } from '../format/symbol.js';
import { snapshotPlanSelection } from '../format/plan-clipboard.js';
import { placeFromLibrary, placeGear, placeTracedIcon, parseDimensions, findMatchingShape } from '../format/place.js';
import { nearestWallSnap, wallSetback, wantsWallSnap } from '../format/wall-snap.js';
import { arrayGrid } from '../format/array-grid.js';
import { deriveRoom } from '../format/room.js';
import { isLibrary } from '../format/library.js';
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
  createBlankGearList,
  cloneGearItem,
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
import { parseSpotlightInventoryXml } from '../inventory/spotlight-xml.js';
import { mapSymbols, chooseSymbol } from '../inventory/match.js';
import { resolveInventoryQuery, resolveFailureMessage } from '../inventory/resolve.js';
import {
  classify,
  CATEGORY_LABELS,
  LAYER_LABELS,
  LAYER_ORDER,
  type Category,
} from '../inventory/classify.js';
import { loadInventoryWithStatus, saveInventory, inventoryPath } from '../inventory/store.js';
import { exportInventoryPack, importInventoryPack } from '../inventory/share.js';
import { seedStarterInventory } from '../inventory/seed.js';
import { applyFullLayoutRecipe, clearGearShapes, clearSeatingShapes } from '../inventory/apply-layout.js';
import { exportLayoutRecipe } from '../inventory/export-layout-recipe.js';
import {
  deleteBankPreset,
  importLayoutKitFile,
  listLayoutKits,
  loadBankPresets,
  loadLayoutKit,
  saveBankPreset,
  saveLayoutKit,
} from '../inventory/layout-kits.js';
import { isLayoutRecipe, validateLayoutRecipe } from '../inventory/layout-recipe.js';
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
  readPlanRecoverySidecar,
  readRecovery,
  recoveryId,
  removeRecovery,
  writePlanRecoverySidecars,
  writeRecovery,
  type RecoveryEntry,
} from './recovery.js';
import { buildStableSchedule, setStableScheduleField } from './schedule-metadata.js';
import { createBlankPlan, ROOM_PRESETS } from '../format/blank.js';
import { buildNewRoom, type NewRoomSpec } from '../format/new-room.js';
import { planIdentity, setPlanIdentity } from '../format/plan-skeleton.js';
import { companionPathFor } from './companion-store.js';
import {
  addRoomCorner,
  addCablePath,
  addStage,
  adoptAuthoredRoom,
  adoptCompanionSnapshot,
  applySeating as applySeatingModel,
  avSummary,
  clearStage,
  companionSnapshot,
  createCircularRoom,
  createPolygonalRoom,
  createRectangularRoom,
  createRoomFromSpec,
  curveRoomWall,
  curveRoomWallThrough,
  drawShape,
  dimensionOneWall,
  dimensionTheRoom,
  type WallDimensionKind,
  lengthenRoomWall,
  moveRoomCorner,
  offsetRoomWall,
  openPlanModel,
  placeScreenProjectorPair,
  placementElevations,
  planAllocation,
  addLedWall,
  comparePlanWith,
  planShowBrief,
  setShowBrief,
  persistShowBrief,
  planCableSchedule,
  planLegend,
  planLoad,
  planModelView,
  resolvePlanRoom,
  planReport,
  previewSeating,
  removeRoomCorner,
  reshapeRoom,
  roundAllRoomCorners,
  roundRoomCorner,
  resetPlanModel,
  savePlanModel,
  scaleCompanionBackground,
  selectionElevation,
  setInstanceElevation,
  setPendingCeilingHeight,
  sightlineMarkers,
  updatePlanBackground,
  updateRoomMeta,
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
  applyObjectLinkFile,
  loadObjectLinks,
  objectLinkPairKey,
  objectLinksFromMap,
  objectLinksPath,
  saveObjectLinks,
  type ObjectLinkFile,
  type ObjectLinkKind,
} from './object-links.js';
import { parseCompanion } from '../format/companion.js';
import {
  addPlansToFolder,
  clonePlanFolders,
  createPlanFolder,
  emptyPlanFolders,
  loadPlanFolders,
  movePlanFolder,
  removePlanFolder,
  removePlanFromFolder,
  renamePlanFolder,
  savePlanFolders,
  transferPlans,
  updatePlanFolder,
  updatePlanMembership,
  type PlanFolder,
  type PlanFolderLibrary,
  type PlanWorkflowStatus,
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
 *
 * Automation (CDP / `GROUNDPLAN_E2E_*`) can also grant paths under an explicit
 * root so tests do not have to drive native open sheets.
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

/** True when Electron was started for UI automation / CDP scripts. */
function e2eAutomationEnabled(): boolean {
  return (
    process.env.GROUNDPLAN_E2E === '1' ||
    Boolean(process.env.GROUNDPLAN_E2E_SAVE_PATH?.trim()) ||
    Boolean(process.env.GROUNDPLAN_E2E_SAVE_DIR?.trim()) ||
    Boolean(process.env.GROUNDPLAN_E2E_IMPORT_PATH?.trim()) ||
    Boolean(process.env.GROUNDPLAN_E2E_GRANT_ROOT?.trim())
  );
}

/**
 * Roots where automation may grant paths without a native dialog.
 * Defaults to the E2E save directory / Downloads when E2E mode is on.
 */
function e2eGrantRoots(): string[] {
  const roots: string[] = [];
  const explicit = process.env.GROUNDPLAN_E2E_GRANT_ROOT?.trim();
  if (explicit) roots.push(canonicalPath(explicit));
  const saveDir = process.env.GROUNDPLAN_E2E_SAVE_DIR?.trim();
  if (saveDir) roots.push(canonicalPath(saveDir));
  const savePath = resolveE2eSavePath();
  if (savePath) roots.push(canonicalPath(dirname(savePath)));
  const importPath = process.env.GROUNDPLAN_E2E_IMPORT_PATH?.trim();
  if (importPath) roots.push(canonicalPath(dirname(importPath)));
  if (e2eAutomationEnabled() && roots.length === 0) {
    try {
      roots.push(canonicalPath(join(app.getPath('downloads'))));
    } catch {
      /* app not ready yet */
    }
  }
  return [...new Set(roots)];
}

function e2ePathAllowed(candidate: string): boolean {
  if (process.env.GROUNDPLAN_E2E_ALLOW_ANY === '1') return true;
  const listed = process.env.GROUNDPLAN_E2E_GRANT_PATHS?.trim();
  if (listed) {
    for (const entry of listed.split(/[:\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (pathIdentity(canonicalPath(entry)) === pathIdentity(candidate)) return true;
    }
  }
  if (!e2eAutomationEnabled()) return false;
  const id = pathIdentity(candidate);
  return e2eGrantRoots().some((root) => {
    const rootId = pathIdentity(root);
    return id === rootId || id.startsWith(`${rootId}/`) || id.startsWith(`${rootId}\\`);
  });
}

/** Grant a path when E2E policy allows it; otherwise require a prior grant. */
const requireGrantedPath = (path: unknown, extensions?: readonly string[]): string => {
  if (typeof path !== 'string' || !path.trim()) throw new Error('a valid file path is required');
  const candidate = canonicalPath(path);
  let granted = grantedPaths.get(pathIdentity(candidate));
  if (!granted && e2ePathAllowed(candidate) && existsSync(candidate)) {
    granted = grantPath(candidate);
  }
  if (!granted) throw new Error('that file was not selected in Groundplan');
  if (extensions && !extensions.includes(extname(granted).toLowerCase())) {
    // `.gear.json` reports ext `.json` — also accept when the full suffix matches.
    const lower = granted.toLowerCase();
    const ok = extensions.some(
      (ext) => lower.endsWith(ext.toLowerCase()) || extname(granted).toLowerCase() === ext.toLowerCase(),
    );
    if (!ok) throw new Error('that file type is not supported for this action');
  }
  return granted;
};
const requireGrantedDirectory = (path: unknown): string => {
  if (typeof path !== 'string' || !path.trim()) throw new Error('a valid folder is required');
  const candidate = canonicalPath(path);
  let granted = grantedDirectories.get(pathIdentity(candidate));
  if (!granted && e2ePathAllowed(candidate)) {
    granted = grantDirectory(candidate);
  }
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
  /** Trailer show identity (venue / event / date / contact), when present. */
  identity?: { date: string; venue: string; event: string; contact: string };
  /** True when an authored room outline with at least three walls exists. */
  hasRoom: boolean;
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
  /**
   * Absolute placement angle in degrees when the file stores one (RVShape).
   * Null for free geometry that only supports relative rotate-by.
   */
  angleDegrees: number | null;
  /** Saved typography for an RVLabel. */
  textStyle?: {
    family: string;
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikeOut: boolean;
    angleDegrees: number;
  };
  /** Writable geometry belonging to this object, expressed in plan coordinates. */
  pointPaths: Array<{
    nodeId: number;
    cls: string;
    closed: boolean;
    canEdit: boolean;
    reason?: string;
    points: Array<{
      index: number;
      x: number;
      y: number;
      role: 'anchor' | 'control';
    }>;
  }>;
  /** Present when the selection is a dimension line. */
  dimension?: {
    length: number;
    angleDegrees: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
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
/** Fires when a previously scheduled application update is due. */
let scheduledUpdateTimer: ReturnType<typeof setTimeout> | null = null;
/** Prevents overlapping update prompts while one is already on screen. */
let appUpdatePromptOpen = false;
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
  status: PlanWorkflowStatus;
  starred: boolean;
  note?: string;
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
        status: membership.status ?? 'active',
        starred: membership.starred === true,
        note: membership.note,
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
        status: membership.status ?? 'active',
        starred: membership.starred === true,
        note: membership.note,
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
    .then(() =>
      atomicWriteJson(path, value, {
        backupPath: existsSync(path) ? `${path}.bak` : undefined,
      }),
    )
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

/** The document currently active. Other open plans are represented by renderer tabs. */
let session: Session | null = null;
/**
 * True when the plan file reached disk but a Groundplan sidecar (companion,
 * dimensions, object links, or schedule) did not. Treated as dirty for
 * discard/quit so that data is not silently lost.
 */
let planSidecarPending = false;
/** Stage↔stairs and grouped items so move/delete/duplicate keep them together. */
const objectLinks = new Map<number, number[]>();
const objectLinkKinds = new Map<string, ObjectLinkKind>();

function snapshotObjectLinks(): ObjectLinkFile {
  return objectLinksFromMap(objectLinks, objectLinkKinds);
}

function linkObjects(a: number, b: number, kind: ObjectLinkKind = 'stage-stairs'): void {
  const add = (from: number, to: number) => {
    const list = objectLinks.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    objectLinks.set(from, list);
  };
  add(a, b);
  add(b, a);
  const key = objectLinkPairKey(a, b);
  const existing = objectLinkKinds.get(key);
  // Stage↔stairs is the stronger bond; do not overwrite it with a furniture group.
  if (existing === 'stage-stairs') return;
  if (existing === 'stack-on' && kind === 'group') return;
  objectLinkKinds.set(key, kind);
  scheduleObjectLinkPersist();
}

function unlinkObjects(a: number, b: number, kind?: ObjectLinkKind): boolean {
  const key = objectLinkPairKey(a, b);
  if (kind && objectLinkKinds.get(key) !== kind) return false;
  const drop = (from: number, to: number) => {
    const list = (objectLinks.get(from) ?? []).filter((id) => id !== to);
    if (list.length) objectLinks.set(from, list);
    else objectLinks.delete(from);
  };
  drop(a, b);
  drop(b, a);
  objectLinkKinds.delete(key);
  return true;
}

function expandLinkedIds(ids: number[]): number[] {
  const out = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop()!;
    for (const partner of objectLinks.get(id) ?? []) {
      if (out.has(partner)) continue;
      out.add(partner);
      queue.push(partner);
    }
  }
  return [...out];
}

/** Only follow furniture `group` links — not stage↔stairs or stack-on. */
function expandGroupIds(ids: number[]): number[] {
  const out = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop()!;
    for (const partner of objectLinks.get(id) ?? []) {
      if (out.has(partner)) continue;
      const kind = objectLinkKinds.get(objectLinkPairKey(id, partner));
      if (kind !== 'group') continue;
      out.add(partner);
      queue.push(partner);
    }
  }
  return [...out];
}

/** Persist a bank/section as one selectable unit without touching the .rv4. */
function groupCreatedIds(ids: number[] | undefined): void {
  const s = session;
  if (!s || !ids || ids.length < 2) return;
  const members = ids.filter((id) => s.index.byId.has(id));
  if (members.length < 2) return;
  const hub = [...members].sort((a, b) => a - b)[0]!;
  for (const id of members) {
    if (id === hub) continue;
    linkObjects(hub, id, 'group');
  }
}

function clearObjectLinks(): void {
  objectLinks.clear();
  objectLinkKinds.clear();
}

function pruneObjectLinks(removed: Iterable<number>): void {
  for (const id of removed) {
    const partners = objectLinks.get(id) ?? [];
    objectLinks.delete(id);
    for (const partner of partners) {
      objectLinkKinds.delete(objectLinkPairKey(id, partner));
      const list = (objectLinks.get(partner) ?? []).filter((x) => x !== id);
      if (list.length) objectLinks.set(partner, list);
      else objectLinks.delete(partner);
    }
  }
  scheduleObjectLinkPersist();
}

let objectLinkWrite: Promise<void> = Promise.resolve();

function scheduleObjectLinkPersist(): void {
  const s = session;
  if (!s) return;
  const snapshot = snapshotObjectLinks();
  objectLinkWrite = objectLinkWrite
    .catch(() => undefined)
    .then(async () => {
      await saveObjectLinks(s.path, snapshot);
      // A successful flush clears only the links half of a pending state when
      // the session is otherwise clean — full clears happen on plan save.
    })
    .catch((error) => {
      planSidecarPending = true;
      if (session === s) schedulePlanRecovery(s);
      console.error('[groundplan] could not save object links:', error);
    });
}

async function restoreObjectLinks(planPath: string): Promise<string | undefined> {
  const loaded = await loadObjectLinks(planPath);
  applyObjectLinkFile(loaded.file, objectLinks, objectLinkKinds);
  // Drop pairs whose objects no longer exist in the open document.
  if (session) {
    const alive = new Set(session.index.byId.keys());
    const stale: number[] = [];
    for (const id of objectLinks.keys()) {
      if (!alive.has(id)) stale.push(id);
    }
    if (stale.length) pruneObjectLinks(stale);
  }
  return loaded.warning;
}

interface PlanObjectClipboard {
  source: RVDocument;
  nodes: RVNode[];
  sourcePath: string;
  sourceName: string;
  /** Consecutive pastes into one plan staircase instead of landing on top of each other. */
  pasteTarget?: string;
  pasteCount: number;
}

/** Exact source-object snapshots used for copy/paste between plan tabs. */
let planObjectClipboard: PlanObjectClipboard | null = null;

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
    .catch((error) => {
      planSidecarPending = true;
      if (session) schedulePlanRecovery(session);
      console.error('[groundplan] could not save dimension associations:', error);
    });
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
  items: Array<Omit<InventoryItem, 'photoDataUrl'> & { hasPhoto?: boolean; photoDataUrl?: never }>;
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

/** Slim mutate replies — the renderer re-lists; do not ship every photo again. */
function inventoryMutateOk(extra: Record<string, unknown> = {}): { ok: true } & Record<string, unknown> {
  return { ok: true, ...extra };
}

function inventoryBusyReason(): string | null {
  if (harvestRunning) return 'wait for the symbol scan to finish';
  return null;
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

  // Photos stay on the main-process inventory; list payloads only flag that one
  // exists so the UI can fetch it for visible rows.
  const items = searchInventory(inventory, query, department, category).map((item) => {
    const { photoDataUrl, ...rest } = item;
    return photoDataUrl ? { ...rest, hasPhoto: true as const } : rest;
  });

  return {
    items,
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

function stampForPack(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Folds every open gear list into the company inventory. */
async function absorbOpenGearIntoInventory(): Promise<{ added: number; updated: number } | null> {
  if (!gear) return null;

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
  return { added, updated };
}

async function maybeAutoAbsorbGear(): Promise<string | undefined> {
  settings ??= await loadSettings(app.getPath('userData'));
  if (!settings.inventory.autoAbsorbGear) return undefined;
  const summary = await absorbOpenGearIntoInventory();
  if (!summary) return undefined;
  if (!summary.added && !summary.updated) return 'Company inventory already had these lines.';
  return `Pushed to company inventory. ${summary.added} new, ${summary.updated} updated. Share an inventory pack so other computers get them.`;
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

function planNeedsRecovery(s: Session): boolean {
  return s.dirty || planSidecarPending;
}

function schedulePlanRecovery(s: Session): void {
  if (!recoveryRoot) return;
  // Never journal a lossy rewrite of a read-only / non-round-trip open.
  if (!s.editable) return;
  if (planRecoveryTimer) clearTimeout(planRecoveryTimer);
  const generation = planRecoveryGeneration;
  planRecoveryTimer = setTimeout(() => {
    planRecoveryTimer = null;
    planRecoveryWrite = planRecoveryWrite
      .catch(() => undefined)
      .then(async () => {
        if (generation !== planRecoveryGeneration || session !== s) return;
        if (!s.editable) return;
        const id = recoveryId('plan', canonicalPath(s.path));
        if (!planNeedsRecovery(s)) {
          await removeRecovery(recoveryRoot, id);
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
          // Journal every sidecar so room/meta/links survive a crash after the
          // plan body landed but a companion write failed (any plan extension).
          const companion = companionSnapshot();
          await writePlanRecoverySidecars(recoveryRoot, id, {
            companion: companion ?? undefined,
            dimensions: cloneDimensionAssociations(),
            links: snapshotObjectLinks(),
          });
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
    dirty: s.dirty || planSidecarPending,
    canUndo: s.canUndo(),
    canRedo: s.canRedo(),
    revision: s.revision,
    recovered: s.recovered,
    dimensionWarning: dimensionAssociationWarning,
    annotationCapabilities: annotationCapabilities(s.loaded.document),
    identity: (() => {
      const found = planIdentity(s.loaded.document);
      if (!found) return undefined;
      return {
        date: found.date,
        venue: found.venue,
        event: found.event,
        contact: found.contact,
      };
    })(),
    hasRoom: (() => {
      // Avoid planModelView on every edit reply — that walks the whole seating
      // model. A quick wall-ish primitive count is enough for chrome gating.
      if (!s.scene.roomExtent) return false;
      const wallish = s.scene.primitives.filter((p) => p.layer === 'walls' || p.layer === 'region').length;
      return wallish >= 3;
    })(),
  };
}

function restoreDimensionLinks(s: Session): void {
  if (!s.editable) return;
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
  clearObjectLinks();
  resetPlanModel();
  planSidecarPending = false;
  session = new Session(path, buf);
  const associations = await loadDimensionAssociations(path);
  dimensionAssociations = associations.file;
  dimensionAssociationWarning = associations.warning;
  restoreDimensionLinks(session);
  resetDimensionHistory();
  await openPlanModel(path, session.loaded.document, unitSystem());
  const linkWarning = await restoreObjectLinks(path);
  if (linkWarning && !dimensionAssociationWarning) {
    dimensionAssociationWarning = linkWarning;
  }
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
  'plan-folders:update',
  'plan-folders:move',
  'plan-folders:remove',
  'plan-folders:add-files',
  'plan-folders:add-current',
  'plan-folders:remove-plan',
  'plan-folders:transfer-plans',
  'plan-folders:update-plan',
  'plan-folders:cleanup-missing',
  'edit:move',
  'edit:move-to',
  'edit:delete',
  'edit:duplicate',
  'edit:recolor',
  'edit:relabel',
  'edit:text-style',
  'edit:batch',
  'edit:repeat-across',
  'edit:array-grid',
  'edit:setback-from-wall',
  'edit:arrange',
  'edit:clipboard-copy',
  'edit:clipboard-paste',
  'edit:clipboard-status',
  'edit:group',
  'edit:ungroup',
  'edit:attach-stack',
  'edit:detach-stack',
  'edit:point-kind',
  'inventory:map-symbols',
  'inventory:absorb-gear',
  'inventory:harvest',
  'inventory:cancel-harvest',
  'inventory:import',
  'inventory:export-pack',
  'inventory:import-pack',
  'inventory:add',
  'inventory:update',
  'inventory:duplicate',
  'inventory:remove',
  'inventory:restore-last',
  'inventory:place',
  'gear:save',
  'gear:new',
  'gear:update',
  'gear:restore-last',
  'gear:add',
  'gear:duplicate',
  'gear:add-department',
  'show:link-current',
  'plan:place-gear',
  'plan:rotate',
  'plan:resize',
  'plan:add-seating',
  'plan:apply-layout-recipe',
  'plan:save-layout-kit',
  'plan:save-open-as-kit',
  'plan:clear-furniture',
  'plan:import-layout-kit',
  'plan:export-layout-recipe',
  'plan:save-bank-preset',
  'plan:delete-bank-preset',
  'plan:add-label',
  'plan:add-dimension',
  'file:save',
  'file:duplicate-path',
  'schedule:set-field',
  'export:dxf',
  'print:pdf',
  'plan:room-create',
  'plan:room-create-circle',
  'plan:room-create-from-spec',
  'plan:room-create-polygon',
  'plan:room-corner-move',
  'plan:room-corner-add',
  'plan:room-corner-remove',
  'plan:room-corner-round',
  'plan:room-corners-round-all',
  'plan:room-reshape',
  'plan:room-curve',
  'plan:room-curve-through',
  'plan:room-wall-length',
  'plan:room-wall-offset',
  'plan:room-dimension',
  'plan:wall-dimension',
  'plan:load-summary',
  'plan:cable-schedule',
  'plan:show-brief',
  'plan:show-brief-set',
  'plan:led-wall',
  'versions:list',
  'versions:save',
  'versions:restore',
  'versions:compare',
  'versions:rename',
  'versions:delete',
  'plan:identity-set',
  'plan:seating-apply',
  'plan:stage-add',
  'plan:report-export',
  'plan:pull-sheet-export',
  'plan:draw',
  'plan:add-cable-path',
  'plan:place-av-pair',
  'plan:set-elevation',
  'plan:selection-elevation',
  'plan:selection-elevations',
  'plan:linked-set',
  'plan:sightline-markers',
  'plan:background-set',
  'file:new',
  'file:discard-empty-plan',
  'command:run',
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

function applyEdit(
  run: (s: Session) => {
    ok: boolean;
    reason?: string;
    text?: string;
    created?: number[];
    placed?: number;
    method?: 'matched' | 'library' | 'symbol' | 'traced' | 'synthesized' | 'box';
  },
  options?: {
    /**
     * Skip the full serialize/parse round-trip check for known-safe transforms
     * of existing shapes (move / rotate / orient / flip). Still refreshes the
     * scene and schedules recovery. Create/delete/relabel keep full verify.
     */
    skipRoundTripVerify?: boolean;
  },
): {
  ok: boolean;
  reason?: string;
  text?: string;
  created?: number[];
  placed?: number;
  method?: 'matched' | 'library' | 'symbol' | 'traced' | 'synthesized' | 'box';
  doc?: OpenResult;
} {
  const s = session;
  if (!s) return { ok: false, reason: 'no plan is open' };
  if (!s.editable) {
    return { ok: false, reason: 'this file is open read-only because it does not reproduce exactly' };
  }

  const associationsBefore = cloneDimensionAssociations();
  s.checkpoint();
  let result: {
    ok: boolean;
    reason?: string;
    text?: string;
    created?: number[];
    placed?: number;
    method?: 'matched' | 'library' | 'symbol' | 'traced' | 'synthesized' | 'box';
  };
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
    if (!options?.skipRoundTripVerify) {
      const verdict = verifyWritable(s.loaded.document);
      if (!verdict.ok) {
        s.rollback();
        dimensionAssociations = associationsBefore;
        return { ok: false, reason: verdict.reason };
      }
    }

    s.refresh();
    commitDimensionHistory(associationsBefore);
    if (associatedUpdates > 0) persistDimensionAssociations(s.path);
    schedulePlanRecovery(s);
    return {
      ok: true,
      text: result.text,
      created: result.created,
      placed: result.placed,
      method: result.method,
      doc: describe(s),
    };
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

  // Carved/repaired compounds must not be rewritten in place — Save As builds a
  // clean OLE container instead of re-packing the damaged original.
  if (s.loaded.repaired && overwritingSource) {
    return {
      ok: false,
      reason:
        'This plan was repaired when opened. Use Save As to write a clean file instead of overwriting the damaged original.',
    };
  }

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
      // Always keep a last-good .bak when replacing any existing file (Save and
      // Save As overwrite), matching companion / dimension / schedule writers.
      backupPath: existsSync(target) ? `${target}.bak` : undefined,
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
  let sidecarsOk = true;
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
        sidecarsOk = false;
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
        sidecarsOk = false;
        addWarning(`Its associative dimensions could not be copied: ${String(error)}`);
      }
    }
    const sourceLinks = objectLinksPath(source);
    const linksAtSave = snapshotObjectLinks();
    if (existsSync(sourceLinks) || linksAtSave.pairs.length > 0) {
      try {
        await objectLinkWrite;
        if (linksAtSave.pairs.length > 0) {
          await saveObjectLinks(target, linksAtSave);
        } else if (existsSync(sourceLinks)) {
          await atomicWriteFile(objectLinksPath(target), await readFile(sourceLinks), {
            backupPath: existsSync(objectLinksPath(target))
              ? `${objectLinksPath(target)}.bak`
              : undefined,
          });
        }
        grantPath(objectLinksPath(target));
      } catch (error) {
        sidecarsOk = false;
        addWarning(`Its object links could not be copied: ${String(error)}`);
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
    sidecarsOk = false;
    addWarning(
      `Its Groundplan data could not be saved: ${String(error)} Save again when the folder is writable so room and seating data are not lost.`,
    );
  }
  try {
    await dimensionWrite;
    await saveDimensionAssociations(target, associationsAtSave);
    grantPath(dimensionAssociationPath(target));
  } catch (error) {
    sidecarsOk = false;
    addWarning(`Its associative dimensions could not be saved: ${String(error)}`);
  }
  try {
    await objectLinkWrite;
    await saveObjectLinks(target, snapshotObjectLinks());
    grantPath(objectLinksPath(target));
  } catch (error) {
    sidecarsOk = false;
    addWarning(`Its object links could not be saved: ${String(error)}`);
  }
  planSidecarPending = !sidecarsOk;

  if (recoveryRoot) {
    cancelPlanRecoverySchedule();
    await planRecoveryWrite;
    if (sidecarsOk) {
      const ids = new Set([
        recoveryId('plan', canonicalPath(source)),
        recoveryId('plan', canonicalPath(target)),
        ...(activePlanRecoveryId ? [activePlanRecoveryId] : []),
      ]);
      await Promise.all([...ids].map((id) => removeRecovery(recoveryRoot, id)));
      activePlanRecoveryId = null;
      notifyRecoveryChanged();
    }
  }
  // A newer edit may have landed while the snapshot was being written. It is
  // intentionally still dirty and needs a fresh crash-recovery checkpoint.
  // Sidecar failure also keeps a journal until every sidecar lands.
  if (planNeedsRecovery(s)) {
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
    const e2eGear =
      process.env.GROUNDPLAN_E2E_GEAR_SAVE_PATH?.trim() ||
      (resolveE2eSavePath()
        ? resolveE2eSavePath()!.replace(/\.rv4$/i, GEAR_EXTENSION)
        : undefined);
    if (e2eGear && e2eAutomationEnabled()) {
      target = grantPath(e2eGear.endsWith(GEAR_EXTENSION) ? e2eGear : `${e2eGear}${GEAR_EXTENSION}`);
    } else {
      // Suggested name ends with `.gear.json`. macOS appends the filter extension,
      // so the filter must be `gear.json` — not `json` — or we get `.gear.json.json`.
      const base =
        (state.lists[0]?.jobNumber ? `Job ${state.lists[0].jobNumber}` : 'Gear list').replace(
          /[\\/:*?"<>|]/g,
          '-',
        ) || 'Gear list';
      const suggested = state.path ?? `${base}${GEAR_EXTENSION}`;
      const result = await dialog.showSaveDialog({
        title: 'Save gear list',
        defaultPath: suggested,
        filters: [{ name: 'Groundplan gear list', extensions: ['gear.json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      let chosen = result.filePath;
      // Defend against hosts that still double-suffix.
      if (/\.gear\.json\.json$/i.test(chosen)) {
        chosen = chosen.replace(/\.json$/i, '');
      } else if (!chosen.toLowerCase().endsWith(GEAR_EXTENSION)) {
        chosen = chosen.endsWith('.json') ? chosen.replace(/\.json$/i, GEAR_EXTENSION) : `${chosen}${GEAR_EXTENSION}`;
      }
      target = grantPath(chosen);
    }
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

/**
 * Resolve an automation save path without relying on a single env var that
 * may be truncated when it contains spaces (shell / Electron argv quirks).
 */
function resolveE2eSavePath(): string | undefined {
  const direct = process.env.GROUNDPLAN_E2E_SAVE_PATH?.trim();
  if (direct) return direct;
  const dir = process.env.GROUNDPLAN_E2E_SAVE_DIR?.trim();
  const name = process.env.GROUNDPLAN_E2E_SAVE_NAME?.trim();
  if (dir && name) return join(dir, name);
  const pathFile = process.env.GROUNDPLAN_E2E_SAVE_PATH_FILE?.trim();
  if (pathFile && existsSync(pathFile)) {
    const contents = readFileSync(pathFile, 'utf8').trim();
    if (contents) return contents;
  }
  return undefined;
}

const pendingDiscardPrompts = new Map<string, (choice: 'cancel' | 'save' | 'discard') => void>();
const acknowledgedDiscardPrompts = new Map<string, () => void>();
let discardPromptSeq = 0;

ipcMain.on('dialog:confirm-discard-ack', (_event, id: string) => {
  acknowledgedDiscardPrompts.get(id)?.();
});

ipcMain.on(
  'dialog:confirm-discard-result',
  (_event, id: string, choice: 'cancel' | 'save' | 'discard') => {
    const resolve = pendingDiscardPrompts.get(id);
    if (!resolve) return;
    pendingDiscardPrompts.delete(id);
    resolve(choice);
  },
);

/**
 * Ask the renderer to show the unsaved-changes prompt.
 *
 * Resolves `null` when the renderer cannot answer — no window, a destroyed
 * window, or no reply inside the timeout — so the caller falls back to the
 * native sheet rather than hanging. Without that fallback a crashed renderer
 * would leave the app unquittable.
 */
async function askRendererDiscard(work: string): Promise<'cancel' | 'save' | 'discard' | null> {
  const target = mainWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return null;
  const id = `discard-${++discardPromptSeq}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: 'cancel' | 'save' | 'discard' | null) => {
      if (settled) return;
      settled = true;
      pendingDiscardPrompts.delete(id);
      acknowledgedDiscardPrompts.delete(id);
      clearTimeout(ackTimer);
      resolve(choice);
    };

    // Only the ACK is on a clock. Once the renderer says the prompt is on
    // screen we wait for the person as long as it takes: a deadline here is
    // what produced a native sheet stacking on top of a perfectly good in-app
    // prompt when nobody answered within the window.
    const ackTimer = setTimeout(() => finish(null), 4_000);
    acknowledgedDiscardPrompts.set(id, () => clearTimeout(ackTimer));
    pendingDiscardPrompts.set(id, (choice) => finish(choice));

    try {
      if (target.isMinimized()) target.restore();
      target.focus();
      target.webContents.send('dialog:confirm-discard', { id, work });
    } catch {
      finish(null);
    }
  });
}

async function confirmDiscard(kind: 'plan' | 'gear' | 'all'): Promise<boolean> {
  const dirtyPlan = !!(session && (session.dirty || planSidecarPending));
  const dirtyGear = !!gear?.dirty;
  const needsPlan = kind !== 'gear' && dirtyPlan;
  const needsGear = kind !== 'plan' && dirtyGear;
  if (!needsPlan && !needsGear) return true;

  // Opt-in, not default.
  //
  // This existed because the unsaved-changes prompt was a native sheet and CDP
  // cannot click one, so automation had no way past it. The prompt is in-app
  // now and a harness answers it with an ordinary click — which means the
  // bypass had stopped being a workaround and become a hazard: every automated
  // run silently threw away dirty documents, and no run ever exercised the
  // dialog it was avoiding.
  //
  // Set GROUNDPLAN_E2E_AUTO_DISCARD=1 to bring it back for a harness that
  // genuinely cannot answer.
  if (e2eAutomationEnabled() && process.env.GROUNDPLAN_E2E_AUTO_DISCARD === '1') {
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
  const inApp = await askRendererDiscard(work);
  const response =
    inApp != null
      ? { response: inApp === 'discard' ? 2 : inApp === 'save' ? 1 : 0 }
      : mainWindow
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

function appBundlePath(): string {
  // macOS replaces the .app bundle, so the path has to be the bundle rather
  // than the executable buried inside it. Windows hands off to the installer
  // and never reads this.
  return process.platform === 'darwin'
    ? app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]*$/, '')
    : app.getPath('exe');
}

function clearScheduledUpdateTimer(): void {
  if (scheduledUpdateTimer) {
    clearTimeout(scheduledUpdateTimer);
    scheduledUpdateTimer = null;
  }
}

/** Arms an in-session timer when the user scheduled an update for later today. */
async function armScheduledUpdateTimer(latestVersion?: string): Promise<void> {
  clearScheduledUpdateTimer();
  const reminder = await loadReminder(app.getPath('userData'));
  const version = latestVersion ?? reminder.version;
  if (!version) return;
  const wait = msUntilReminder(reminder, version);
  if (wait == null) return;
  // Cap at ~24 days — setTimeout is 32-bit; longer waits re-arm on next launch.
  const delay = Math.min(wait, 2_000_000_000);
  scheduledUpdateTimer = setTimeout(() => {
    scheduledUpdateTimer = null;
    void runAppUpdate(true);
  }, delay);
}

/**
 * Lets the user save open work before an update restarts the app.
 *
 * Returns false when they cancel. Clean sessions skip the question.
 */
async function confirmSaveBeforeUpdate(latestVersion: string): Promise<boolean> {
  const dirtyPlan = !!(session && (session.dirty || planSidecarPending));
  const dirtyGear = !!gear?.dirty;
  if (!dirtyPlan && !dirtyGear) return true;

  const work =
    dirtyPlan && dirtyGear
      ? 'the open plan and gear list'
      : dirtyPlan
        ? `“${session?.loaded.name ?? 'the open plan'}”`
        : 'the open gear list';

  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Save before updating',
    message: `Save ${work} before updating to Groundplan ${latestVersion}?`,
    detail:
      'Groundplan will restart to finish installing. Saving keeps your latest edits; updating without saving discards them.',
    buttons: ['Save and update', 'Update without saving', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const response = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);

  if (response.response === 2) return false;
  if (response.response === 1) return true;

  if (dirtyPlan) {
    const saved = await savePlanDocument(false);
    if (!saved.ok) {
      if (!saved.cancelled) await showSaveFailure(saved);
      return false;
    }
  }
  if (dirtyGear) {
    const saved = await saveGearDocument(false);
    if (!saved.ok) {
      if (!saved.cancelled) await showSaveFailure(saved);
      return false;
    }
  }
  return true;
}

/** Follow-up dialog that picks when to ask about the update again. */
async function chooseUpdateSchedule(latestVersion: string): Promise<boolean> {
  const choices = scheduleOptions();
  const labels = choices.map((choice) => choice.label);
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Schedule update',
    message: `When should Groundplan ask about version ${latestVersion}?`,
    detail: 'You can still update sooner from Help → Check for Updates…',
    buttons: [...labels, 'Cancel'],
    defaultId: 0,
    cancelId: labels.length,
    noLink: true,
  };
  const response = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (response.response < 0 || response.response >= choices.length) return false;

  const picked = choices[response.response];
  await saveReminder(app.getPath('userData'), reminderAfterSchedule(latestVersion, picked.at));
  await armScheduledUpdateTimer(latestVersion);

  await dialog.showMessageBox({
    type: 'info',
    message: 'Update scheduled',
    detail: `Groundplan will remind you about version ${latestVersion} around ${formatReminderTime(picked.at)}.`,
    buttons: ['OK'],
  });
  return true;
}

/**
 * Downloads (or uses a staged package) and installs, quitting only after the
 * user has had a chance to save.
 */
async function installStagedAppUpdate(
  staged: StagedUpdate,
  currentVersion: string,
): Promise<void> {
  await clearReminder(app.getPath('userData'));
  clearScheduledUpdateTimer();
  closeConfirmed = true;
  /*
   * Note which version this replaces BEFORE the swap.
   *
   * Once `installAppUpdate` succeeds this process is on its way out — on macOS
   * a detached script is already waiting for it to exit — so there is no "after"
   * in which to write anything down. If the install then fails, the note is
   * cleared below; a rollback offer pointing at a hop that never happened is
   * worse than no offer.
   */
  if (staged.version && staged.version !== currentVersion) {
    await saveRollback(app.getPath('userData'), {
      from: currentVersion,
      to: staged.version,
      at: new Date().toISOString(),
    }).catch(() => undefined);
  }
  const installed = await installAppUpdate(staged, appBundlePath(), () => app.quit());
  if (!installed.ok) {
    closeConfirmed = false;
    await clearRollback(app.getPath('userData')).catch(() => undefined);
    await dialog.showMessageBox({
      type: 'error',
      message: 'The update could not be installed',
      detail: `${installed.reason ?? 'Unknown problem.'}\n\nGroundplan ${currentVersion} is unchanged.`,
      buttons: ['OK'],
    });
  }
}

/**
 * Offers an application update, downloads it, and restarts into it.
 *
 * First open after a release (and every quiet launch check that is not snoozed)
 * gets a clear choice: update now, later, or schedule a reminder. Work can be
 * saved before the restart. Uses the system dialog so the prompt still appears
 * while a plan is mid-edit.
 */
async function runAppUpdate(interactive: boolean): Promise<void> {
  if (appUpdatePromptOpen) return;
  appUpdatePromptOpen = true;
  try {
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

    const latestVersion = plan.latestVersion ?? 'the new version';
    const reminder = await loadReminder(app.getPath('userData'));
    const offer = shouldOfferUpdate(reminder, latestVersion, new Date(), interactive);
    if (!offer.offer) {
      // Keep an in-session timer armed for a scheduled remind time.
      if (offer.reason === 'scheduled') await armScheduledUpdateTimer(latestVersion);
      return;
    }

    const size = plan.package ? `${(plan.package.bytes / 1024 / 1024).toFixed(1)} MB` : 'unknown size';
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Groundplan ${latestVersion} is available`,
      detail:
        `${plan.notes ? `${plan.notes}\n\n` : ''}` +
        `You are on ${plan.currentVersion}. Download size: ${size}.\n\n` +
        'Choose Update Now to install and restart, Update Later to be asked again tomorrow, or Schedule… to pick a time.',
      buttons: ['Update Now', 'Update Later', 'Schedule…'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (answer.response === 1) {
      await saveReminder(app.getPath('userData'), reminderAfterLater(latestVersion));
      clearScheduledUpdateTimer();
      return;
    }
    if (answer.response === 2) {
      await chooseUpdateSchedule(latestVersion);
      return;
    }
    if (answer.response !== 0) return;

    if (!(await confirmSaveBeforeUpdate(latestVersion))) return;

    mainWindow?.webContents.send('app:update-progress', {
      phase: 'downloading',
      received: 0,
      total: plan.package?.bytes,
    });

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

    await installStagedAppUpdate(staged, plan.currentVersion);
  } finally {
    appUpdatePromptOpen = false;
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
 * Goes back to the version this copy replaced.
 *
 * Reuses the update pipeline unchanged — fetch a signed manifest, verify the
 * signature, verify the hash, swap — pointed at the older release rather than
 * the newest. Nothing is kept on disk for this; every release still publishes
 * its own manifest, so the way back is always describable.
 *
 * The offer only stands while the running version is the one the note says was
 * installed. After a second update, or a manual reinstall, it is withdrawn
 * rather than pointing somewhere the user did not come from.
 */
async function runAppRevert(): Promise<void> {
  if (appUpdatePromptOpen) return;
  appUpdatePromptOpen = true;
  try {
    const record = await loadRollback(app.getPath('userData'));
    if (!canRevert(record, app.getVersion())) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'There is nothing to go back to',
        detail:
          record
            ? `This note describes going from ${record.from} to ${record.to}, and you are running ` +
              `${app.getVersion()}. Only the most recent update can be undone.`
            : 'Groundplan has not updated itself on this computer, so there is no earlier version to return to.',
        buttons: ['OK'],
      });
      return;
    }

    const target = record!.from;
    const plan = await planRevert(target, {
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    });

    if (!plan.available) {
      await dialog.showMessageBox({
        type: 'error',
        message: `Groundplan ${target} could not be prepared`,
        detail: `${plan.reason ?? 'Unknown problem.'}\n\nGroundplan ${app.getVersion()} is unchanged and still works.`,
        buttons: ['OK'],
      });
      return;
    }

    const size = plan.package ? `${(plan.package.bytes / 1024 / 1024).toFixed(1)} MB` : 'unknown size';
    const answer = await dialog.showMessageBox({
      type: 'warning',
      title: 'Go back a version',
      message: `Replace Groundplan ${app.getVersion()} with ${target}?`,
      detail:
        `${size} will be downloaded and checked against its signature before anything is replaced. ` +
        `Groundplan will restart into ${target}.\n\n` +
        'Your plans, gear lists and inventory are not touched — they live outside the application. ' +
        `A plan saved by ${app.getVersion()} still opens in ${target}.\n\n` +
        `Groundplan will offer ${plan.currentVersion} again the next time it checks for updates.`,
      buttons: [`Install ${target}`, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return;

    if (!(await confirmSaveBeforeUpdate(target))) return;

    const staging = join(app.getPath('userData'), 'updates');
    await cleanStaging(staging);
    mainWindow?.webContents.send('app:update-progress', {
      phase: 'downloading',
      received: 0,
      total: plan.package?.bytes,
    });

    const staged = await stageAppUpdate(plan, staging, (received, total) => {
      mainWindow?.webContents.send('app:update-progress', { phase: 'downloading', received, total });
      if (total > 0) mainWindow?.setProgressBar(received / total);
    });
    mainWindow?.setProgressBar(-1);

    if (!staged.ok) {
      mainWindow?.webContents.send('app:update-progress', { phase: 'failed', message: staged.reason });
      await dialog.showMessageBox({
        type: 'error',
        message: `Groundplan ${target} could not be downloaded`,
        detail: `${staged.reason ?? 'The download did not finish.'}\n\nGroundplan ${app.getVersion()} is unchanged and still works.`,
        buttons: ['OK'],
      });
      return;
    }

    // Going back closes the loop the note described: there is no longer an
    // update to undo, and the next check treats the newer release as an
    // ordinary offer rather than something being forced back on.
    await clearRollback(app.getPath('userData')).catch(() => undefined);
    await clearReminder(app.getPath('userData')).catch(() => undefined);
    clearScheduledUpdateTimer();
    closeConfirmed = true;
    const installed = await installAppUpdate(staged, appBundlePath(), () => app.quit());
    if (!installed.ok) {
      closeConfirmed = false;
      await dialog.showMessageBox({
        type: 'error',
        message: `Groundplan ${target} could not be installed`,
        detail: `${installed.reason ?? 'Unknown problem.'}\n\nGroundplan ${app.getVersion()} is unchanged.`,
        buttons: ['OK'],
      });
    }
  } finally {
    appUpdatePromptOpen = false;
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

  const latestVersion = plan.latestVersion ?? 'the new version';
  const size = plan.package ? `${(plan.package.bytes / 1024 / 1024).toFixed(1)} MB` : 'unknown size';
  const answer = await dialog.showMessageBox({
    type: 'info',
    message: `Install Groundplan ${latestVersion} from this drive?`,
    detail:
      `${plan.notes ? `${plan.notes}\n\n` : ''}You are on ${plan.currentVersion}. ${size} will be copied off the drive ` +
      `and checked against its signature before anything is replaced.\n\nGroundplan will restart to finish installing.`,
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  if (!(await confirmSaveBeforeUpdate(latestVersion))) return;

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

  await installStagedAppUpdate(staged, plan.currentVersion);
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
    if (closeConfirmed || (!(session && (session.dirty || planSidecarPending)) && !gear?.dirty))
      return;
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
    clearObjectLinks();
    gear = null;
    lastRemovedGear = null;
    resetPlanModel();
    planSidecarPending = false;
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

function insertMenuFromTree(nodes: Array<InsertBranch | InsertLeaf>): MenuItemConstructorOptions[] {
  return nodes.map((node) => {
    if (isInsertLeaf(node)) {
      return {
        label: node.label,
        click: () => mainWindow?.webContents.send('menu:insert-leaf', node.id),
      };
    }
    return {
      label: node.label,
      submenu: insertMenuFromTree(node.children),
    };
  });
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
              { label: 'Go Back a Version…', click: () => void runAppRevert() },
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
          label: 'Group',
          accelerator: 'CmdOrCtrl+G',
          click: () => mainWindow?.webContents.send('menu:group'),
        },
        {
          label: 'Ungroup',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => mainWindow?.webContents.send('menu:ungroup'),
        },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => mainWindow?.webContents.send('menu:select-all'),
        },
        { type: 'separator' },
        {
          label: 'Edit Walls',
          click: () => mainWindow?.webContents.send('menu:edit-walls'),
        },
      ],
    },
    {
      label: '&Insert',
      submenu: [
        {
          label: 'Browse Insert Catalog…',
          accelerator: 'CmdOrCtrl+I',
          click: () => mainWindow?.webContents.send('menu:insert'),
        },
        { type: 'separator' },
        ...insertMenuFromTree(INSERT_TREE),
        { type: 'separator' },
        {
          label: 'Shape Editor Wizard…',
          click: () => mainWindow?.webContents.send('menu:shape-wizard'),
        },
        {
          label: 'Build a Stage…',
          click: () => mainWindow?.webContents.send('menu:build-stage'),
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.send('menu:fit') },
        { type: 'separator' },
        {
          label: 'Panels & Tools',
          submenu: [
            { label: 'Files', click: () => mainWindow?.webContents.send('menu:mode-browse') },
            { label: 'Assets', click: () => mainWindow?.webContents.send('menu:mode-place') },
            { label: 'Properties', click: () => mainWindow?.webContents.send('menu:mode-inspect') },
            { label: 'Show Setup', click: () => mainWindow?.webContents.send('menu:mode-setup') },
            { label: 'All Canvas Tools', click: () => mainWindow?.webContents.send('menu:mode-draw') },
          ],
        },
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
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => mainWindow?.webContents.send('menu:palette'),
        },
        {
          label: 'Keyboard Shortcuts…',
          click: () => mainWindow?.webContents.send('menu:shortcuts'),
        },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void runAppUpdate(true) },
        { label: 'Install Update from USB…', click: () => void runUsbUpdate() },
        { label: 'Go Back a Version…', click: () => void runAppRevert() },
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

  handle('recovery:list', async (): Promise<RecoveryEntry[]> => listRecoveries(recoveryRoot), []);

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
      clearObjectLinks();
      resetPlanModel();
      planSidecarPending = false;
      session = new Session(planPath, recovered.data);
      const associations = await loadDimensionAssociations(planPath);
      dimensionAssociations = associations.file;
      dimensionAssociationWarning = associations.warning;
      resetDimensionHistory();
      session.markRecovered(recovered.entry.sourceDigest);
      // Prefer journaled sidecars over disk — they hold work that never landed
      // beside the plan (any of .rv4 / .rs4 / .se4 / .ds4 / .rsd).
      const journaledDimensions = await readPlanRecoverySidecar(
        recoveryRoot,
        recovered.entry.id,
        'dimensions',
      );
      if (
        journaledDimensions &&
        typeof journaledDimensions === 'object' &&
        (journaledDimensions as DimensionAssociationFile).format ===
          'groundplan-dimension-associations'
      ) {
        dimensionAssociations = journaledDimensions as DimensionAssociationFile;
        dimensionAssociationWarning = undefined;
      }
      restoreDimensionLinks(session);
      await openPlanModel(planPath, session.loaded.document, unitSystem());
      const journaledCompanion = await readPlanRecoverySidecar(
        recoveryRoot,
        recovered.entry.id,
        'companion',
      );
      const parsedCompanion = parseCompanion(journaledCompanion);
      if (parsedCompanion) adoptCompanionSnapshot(parsedCompanion);
      const linkWarning = await restoreObjectLinks(planPath);
      const journaledLinks = await readPlanRecoverySidecar(
        recoveryRoot,
        recovered.entry.id,
        'links',
      );
      if (
        journaledLinks &&
        typeof journaledLinks === 'object' &&
        (journaledLinks as { format?: string }).format === 'groundplan-object-links'
      ) {
        clearObjectLinks();
        applyObjectLinkFile(journaledLinks as ObjectLinkFile, objectLinks, objectLinkKinds);
      }
      if (linkWarning && !dimensionAssociationWarning) {
        dimensionAssociationWarning = linkWarning;
      }
      activePlanRecoveryId = recovered.entry.id;
      planSidecarPending = true;
      schedulePlanRecovery(session);
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
    // Usability / CDP: hang then cancel so the renderer busy-release timer can fire
    // without leaving a real macOS folder picker open.
    const e2eDelayMs = Number(process.env.GROUNDPLAN_E2E_FOLDER_DELAY_MS || 0);
    if (Number.isFinite(e2eDelayMs) && e2eDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, e2eDelayMs));
      return null;
    }
    if (process.env.GROUNDPLAN_E2E_FOLDER_CANCEL === '1') return null;

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

  handle('plan-folders:update', async (_event, id: string, patch: unknown) => {
    if (typeof id !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('a valid folder update is required');
    }
    await mutatePlanFolders((next) => updatePlanFolder(next, id, patch as never));
    return { ok: true, state: await planFolderState() };
  });

  handle('plan-folders:move', async (_event, id: string, parentId: string | null) => {
    if (typeof id !== 'string' || (parentId !== null && typeof parentId !== 'string')) {
      throw new Error('a valid folder destination is required');
    }
    await mutatePlanFolders((next) => movePlanFolder(next, id, parentId));
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

  handle(
    'plan-folders:transfer-plans',
    async (_event, sourceFolderId: string, targetFolderId: string, paths: string[], mode: 'copy' | 'move') => {
      if (
        typeof sourceFolderId !== 'string' ||
        typeof targetFolderId !== 'string' ||
        !Array.isArray(paths) ||
        !paths.every((path) => typeof path === 'string') ||
        (mode !== 'copy' && mode !== 'move')
      ) {
        throw new Error('a valid batch folder operation is required');
      }
      const changed = await mutatePlanFolders((next) =>
        transferPlans(next, sourceFolderId, targetFolderId, paths, mode),
      );
      return { ok: true, changed, state: await planFolderState() };
    },
  );

  handle('plan-folders:update-plan', async (_event, folderId: string, path: string, patch: unknown) => {
    if (
      typeof folderId !== 'string' ||
      typeof path !== 'string' ||
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch)
    ) {
      throw new Error('a valid plan update is required');
    }
    await mutatePlanFolders((next) => updatePlanMembership(next, folderId, path, patch as never));
    return { ok: true, state: await planFolderState() };
  });

  handle('plan-folders:cleanup-missing', async (_event, folderId: string | null) => {
    if (folderId !== null && typeof folderId !== 'string') throw new Error('a valid folder is required');
    const removed = await mutatePlanFolders((next) => {
      const before = next.memberships.length;
      next.memberships = next.memberships.filter(
        (membership) =>
          (folderId != null && membership.folderId !== folderId) || existsSync(membership.path),
      );
      return before - next.memberships.length;
    });
    return { ok: true, removed, state: await planFolderState() };
  });

  handle('file:open', async (_event, path: string) => {
    if (!(await confirmDiscard('plan'))) return null;
    return openPath(requireGrantedPath(path, ALL_EXTENSIONS));
  });

  handle('file:close-plan', async () => {
    if (!session) return true;
    if (!(await confirmDiscard('plan'))) return false;
    cancelPlanRecoverySchedule();
    session = null;
    clearObjectLinks();
    resetPlanModel();
    planSidecarPending = false;
    activePlanRecoveryId = null;
    dimensionAssociations = {
      format: 'groundplan-dimension-associations',
      version: 1,
      entries: [],
    };
    dimensionAssociationWarning = undefined;
    resetDimensionHistory();
    return true;
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

  handle('edit:clipboard-copy', (_event, ids: number[]) => {
    const s = session;
    if (!s) return { ok: false, reason: 'open a plan first' };
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: 'select one or more items first' };
    if (ids.length > 2_000) return { ok: false, reason: 'copy up to 2,000 items at a time' };
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return { ok: false, reason: 'the selection is invalid' };
    }

    // Serialize and parse once so the clipboard is a snapshot. Continuing to
    // move the source objects after Copy must not silently change what Paste
    // will insert into another show.
    const source = loadBuffer(s.file(), s.path).document;
    const nodes = snapshotPlanSelection(s.loaded.document, s.index, ids, source);
    if (!nodes.length) return { ok: false, reason: 'none of the selected items can be copied' };

    planObjectClipboard = {
      source,
      nodes,
      sourcePath: s.path,
      sourceName: s.loaded.name,
      pasteCount: 0,
    };
    return { ok: true, count: nodes.length, sourceName: s.loaded.name, sourcePath: s.path };
  });

  handle('edit:clipboard-status', () => {
    const clipboard = planObjectClipboard;
    return clipboard
      ? {
          ok: true,
          count: clipboard.nodes.length,
          sourceName: clipboard.sourceName,
          sourcePath: clipboard.sourcePath,
        }
      : { ok: false };
  });

  handle('edit:clipboard-paste', () => {
    const clipboard = planObjectClipboard;
    if (!clipboard) return { ok: false, reason: 'copy items from a plan first' };
    if (!session) return { ok: false, reason: 'open the destination plan first' };
    if (clipboard.pasteTarget === session.path) clipboard.pasteCount++;
    else {
      clipboard.pasteTarget = session.path;
      clipboard.pasteCount = 1;
    }
    const offset = 120 * Math.min(clipboard.pasteCount, 10);
    const reply = applyEdit((s) => {
      const created: number[] = [];
      for (const node of clipboard.nodes) {
        const imported = importDetachedObject(s.loaded.document, clipboard.source, node, offset, offset);
        if (!imported.ok) return imported;
        if (imported.created) created.push(...imported.created);
      }
      return {
        ok: true,
        created,
        text: `${clipboard.nodes.length} item${clipboard.nodes.length === 1 ? '' : 's'} from ${clipboard.sourceName}`,
      };
    });
    if (!reply.ok) clipboard.pasteCount = Math.max(0, clipboard.pasteCount - 1);
    return reply;
  });

  handle('edit:group', (_event, ids: number[]) => {
    const s = session;
    if (!s) return { ok: false, reason: 'open a plan first' };
    if (!s.editable) return { ok: false, reason: 'this plan is read-only' };
    const requested = (Array.isArray(ids) ? ids : []).filter((id) => Number.isFinite(id) && s.index.byId.has(id));
    const members = expandLinkedIds(requested).filter((id) => s.index.byId.has(id));
    if (members.length < 2) return { ok: false, reason: 'select two or more items to group' };
    const hub = [...members].sort((a, b) => a - b)[0]!;
    for (const id of members) {
      if (id === hub) continue;
      linkObjects(hub, id, 'group');
    }
    return { ok: true, text: `Grouped ${members.length} items` };
  });

  handle('edit:expand-group', (_event, ids: number[]) => {
    const s = session;
    if (!s) return [] as number[];
    const requested = (Array.isArray(ids) ? ids : []).filter((id) => Number.isFinite(id) && s.index.byId.has(id));
    if (!requested.length) return [] as number[];
    return expandGroupIds(requested).filter((id) => s.index.byId.has(id));
  });

  /** All furniture `group` banks — for semantic-zoom block footprints. */
  handle('edit:list-object-groups', () => {
    const s = session;
    if (!s) return [] as Array<{ hubId: number; memberIds: number[] }>;
    const visited = new Set<number>();
    const groups: Array<{ hubId: number; memberIds: number[] }> = [];
    for (const id of objectLinks.keys()) {
      if (visited.has(id) || !s.index.byId.has(id)) continue;
      let hasGroup = false;
      for (const partner of objectLinks.get(id) ?? []) {
        if (objectLinkKinds.get(objectLinkPairKey(id, partner)) === 'group') {
          hasGroup = true;
          break;
        }
      }
      if (!hasGroup) continue;
      const members = expandGroupIds([id]).filter((member) => s.index.byId.has(member));
      if (members.length < 2) continue;
      for (const member of members) visited.add(member);
      const hub = [...members].sort((a, b) => a - b)[0]!;
      groups.push({ hubId: hub, memberIds: members });
    }
    return groups;
  });

  handle('edit:ungroup', (_event, ids: number[]) => {
    const s = session;
    if (!s) return { ok: false, reason: 'open a plan first' };
    if (!s.editable) return { ok: false, reason: 'this plan is read-only' };
    const requested = (Array.isArray(ids) ? ids : []).filter((id) => Number.isFinite(id) && s.index.byId.has(id));
    if (!requested.length) return { ok: false, reason: 'select a group to ungroup' };
    const members = expandLinkedIds(requested);
    let removed = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (unlinkObjects(members[i]!, members[j]!, 'group')) removed++;
      }
    }
    if (!removed) return { ok: false, reason: 'those items are not grouped' };
    scheduleObjectLinkPersist();
    return { ok: true, text: `Ungrouped ${removed} link${removed === 1 ? '' : 's'}` };
  });

  /**
   * Stacks a child on a parent surface: link for move/rotate together, and
   * copy the parent's height above floor onto the child.
   */
  handle('edit:attach-stack', (_event, parentId: number, childId: number) => {
    const s = session;
    if (!s) return { ok: false, reason: 'open a plan first' };
    if (!s.editable) return { ok: false, reason: 'this plan is read-only' };
    const parent = Number(parentId);
    const child = Number(childId);
    if (!(Number.isFinite(parent) && Number.isFinite(child)) || parent === child) {
      return { ok: false, reason: 'pick a parent and a different child' };
    }
    if (!s.index.byId.has(parent) || !s.index.byId.has(child)) {
      return { ok: false, reason: 'object no longer exists' };
    }
    linkObjects(parent, child, 'stack-on');
    const parentElev = selectionElevation(s, parent);
    const childElev = selectionElevation(s, child);
    let note = 'Stacked: moves with parent';
    if (parentElev && childElev && parentElev.elevation >= 0) {
      const elevResult = setInstanceElevation(s, childElev.key, parentElev.elevation, unitSystem());
      if (elevResult.ok && elevResult.note) note = `${elevResult.note} · stacked on parent`;
      void savePlanModel(s.path, s.savedArchiveBody()).catch((error) => {
        planSidecarPending = true;
        console.error('[groundplan] could not save stack elevation:', error);
      });
    }
    scheduleObjectLinkPersist();
    return { ok: true, text: note, doc: describe(s) };
  });

  handle('edit:detach-stack', (_event, ids: number[]) => {
    const s = session;
    if (!s) return { ok: false, reason: 'open a plan first' };
    if (!s.editable) return { ok: false, reason: 'this plan is read-only' };
    const requested = (Array.isArray(ids) ? ids : []).filter((id) => Number.isFinite(id) && s.index.byId.has(id));
    if (!requested.length) return { ok: false, reason: 'select stacked items to detach' };
    const members = expandLinkedIds(requested);
    let removed = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (unlinkObjects(members[i]!, members[j]!, 'stack-on')) removed++;
      }
    }
    if (!removed) return { ok: false, reason: 'those items are not stacked together' };
    scheduleObjectLinkPersist();
    return { ok: true, text: `Detached ${removed} stack link${removed === 1 ? '' : 's'}` };
  });

  /**
   * Puts an object at a stated position, rather than nudging it by an offset.
   *
   * `edit:move` is relative, which is the right primitive for a drag but the
   * wrong one for a drawing: a plan says "the podium is at 32ft, 18ft", never
   * "the podium is 4ft left of wherever it happens to be". The centre is
   * already reported by `edit:selection`, so this closes the loop — the same
   * number a user reads back is the one they can type.
   *
   * The delta is computed here rather than in the renderer so the whole thing
   * is one undoable step and cannot drift if the selection moved in between.
   */
  handle('edit:move-to', (_event, nodeId: number, x: number | null, y: number | null) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      const centreX = (node.bounds.left + node.bounds.right) / 2;
      const centreY = (node.bounds.top + node.bounds.bottom) / 2;
      // A null axis is "leave this one alone", so X and Y can be committed
      // independently as the user tabs between the two fields.
      const dx = x == null ? 0 : x - centreX;
      const dy = y == null ? 0 : y - centreY;
      if (dx === 0 && dy === 0) return { ok: true };
      const partners = expandLinkedIds([nodeId]).filter((id) => id !== nodeId);
      const moved = moveNode(s.loaded.document, node, dx, dy);
      if (!moved.ok) return moved;
      for (const id of partners) {
        const partner = s.index.byId.get(id);
        if (!partner) continue;
        const next = moveNode(s.loaded.document, partner, dx, dy);
        if (!next.ok) return next;
      }
      return { ok: true };
    }),
  );

  handle('edit:move', (_event, nodeId: number, dx: number, dy: number) =>
    applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      // Keep stack / stage partners with a solo nudge from older callers.
      const partners = expandLinkedIds([nodeId]).filter((id) => id !== nodeId);
      const moved = moveNode(s.loaded.document, node, dx, dy);
      if (!moved.ok) return moved;
      for (const id of partners) {
        const partner = s.index.byId.get(id);
        if (!partner) continue;
        const next = moveNode(s.loaded.document, partner, dx, dy);
        if (!next.ok) return next;
      }
      return { ok: true };
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
      return renameNode(s.loaded.document, node, text);
    }),
  );

  handle('edit:text-style', (_event, nodeId: number, patch: LabelStylePatch) =>
    applyEdit((s) => {
      if (!Number.isSafeInteger(nodeId) || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, reason: 'the text formatting is invalid' };
      }
      const node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'text label no longer exists' };
      return setLabelStyle(s.loaded.document, node, patch);
    }),
  );

  // --- equipment inventory --------------------------------------------------

  handle(
    'inventory:list',
    (_event, query: string, department: string | null, category: string | null) =>
      inventoryState(query ?? '', department ?? null, (category as Category) ?? null),
  );

  handle('inventory:get-photo', (_event, id: string) => {
    const item = locateInventoryItem(inventory, id);
    if (!item) return { ok: false, reason: 'item no longer exists' };
    if (!item.photoDataUrl) return { ok: true, photoDataUrl: null };
    return { ok: true, photoDataUrl: item.photoDataUrl };
  });

  /**
   * Gives every unshaped item the best drawn symbol available.
   *
   * A gear list carries names and sizes but no geometry, so those items place
   * as plain boxes. Mapping them by hand is impractical on a list of several
   * hundred, so each description is classified — projector, speaker, truss —
   * and matched to a symbol harvested from the shop's own plans.
   */
  handle('inventory:map-symbols', async () => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const summary = mapSymbols(inventory);
    await persistInventory();
    return inventoryMutateOk({ ...summary });
  });

  /** Folds the gear lists currently open into the inventory. */
  handle('inventory:absorb-gear', async () => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const summary = await absorbOpenGearIntoInventory();
    if (!summary) return { ok: false, reason: 'no gear list is open' };
    return inventoryMutateOk({ ...summary });
  });

  /** Writes the company inventory to a folder other machines can import. */
  handle('inventory:export-pack', async () => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const result = await dialog.showOpenDialog({
      title: 'Export inventory pack for other computers',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Export here',
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const parent = grantDirectory(result.filePaths[0]);
    const destination = join(parent, `Groundplan-inventory-${stampForPack()}`);
    const exported = await exportInventoryPack(inventoryFile, inventory, destination);
    return exported;
  });

  /** Merges an inventory pack from USB / shared folder into this install. */
  handle('inventory:import-pack', async () => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const result = await dialog.showOpenDialog({
      title: 'Import inventory pack',
      properties: ['openDirectory'],
      buttonLabel: 'Import from here',
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const source = grantDirectory(result.filePaths[0]);
    const imported = await importInventoryPack(source, inventoryFile, inventory);
    if (!imported.ok) return imported;
    inventoryNotice = `Imported inventory pack: ${imported.added} new, ${imported.updated} updated.`;
    return inventoryMutateOk({ ...imported });
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
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const result = await dialog.showOpenDialog({
      title: 'Add to the equipment inventory',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Gear list, spreadsheet, Spotlight inventory or shapes',
          extensions: ['pdf', 'csv', 'xml', 'rv4', 'rs4', 'se4', 'add', 'stk', 'lib'],
        },
        { name: 'Gear list PDF', extensions: ['pdf'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Vectorworks Spotlight inventory', extensions: ['xml'] },
        { name: 'Plans and shape libraries', extensions: ['rv4', 'rs4', 'se4', 'add', 'stk', 'lib'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    let added = 0;
    let updated = 0;
    const inventoryLabels: string[] = [];
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

      if (lower.endsWith('.xml')) {
        const parsed = parseSpotlightInventoryXml(await readFile(source, 'utf8'));
        if (!parsed.ok) return { ok: false, reason: parsed.reason };
        const label = parsed.meta.name?.trim() || basename(source);
        if (parsed.meta.name?.trim()) inventoryLabels.push(parsed.meta.name.trim());
        const summary = mergeItems(inventory, parsed.items, new Date(), {
          type: 'spotlight-xml',
          sourcePath: source,
          label,
        });
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
    return inventoryMutateOk({
      added,
      updated,
      files: result.filePaths.length,
      inventoryName: inventoryLabels.length === 1 ? inventoryLabels[0] : undefined,
      inventoryNames: inventoryLabels.length > 0 ? inventoryLabels : undefined,
    });
  });

  handle('inventory:add', async (_event, name: string, department?: string) => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const summary = mergeItems(inventory, [{ name, department }], new Date(), {
      id: `manual:${normaliseName(name)}`,
      type: 'manual',
      label: name.trim(),
    });
    if (summary.added > 0) await persistInventory();
    const created = inventory.items.find((i) => normaliseName(i.name) === normaliseName(name));
    return summary.added > 0
      ? inventoryMutateOk({ id: created?.id })
      : { ok: false, reason: 'already in the inventory' };
  });

  handle(
    'inventory:update',
    async (
      _event,
      id: string,
      patch: {
        name?: string;
        department?: string;
        width?: number;
        height?: number;
        notes?: string;
        quantityOwned?: number | null;
        tracedIcon?: {
          paths: Array<{ points: number[]; closed: boolean }>;
          width: number;
          height: number;
        } | null;
        photoDataUrl?: string | null;
      },
    ) => {
      const busy = inventoryBusyReason();
      if (busy) return { ok: false, reason: busy };
      if (!patch || typeof id !== 'string') return { ok: false, reason: 'invalid equipment edit' };
      if (patch.tracedIcon) {
        if (!patch.tracedIcon.paths?.length) return { ok: false, reason: 'the traced outline is empty' };
        for (const path of patch.tracedIcon.paths) {
          if (typeof path.closed !== 'boolean' || !Array.isArray(path.points)) {
            return { ok: false, reason: 'the traced outline is malformed' };
          }
          for (const value of path.points) {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              return { ok: false, reason: 'the traced outline is malformed' };
            }
          }
        }
      }
      if (typeof patch.photoDataUrl === 'string') {
        // Cap stored photos so the inventory JSON stays portable.
        if (patch.photoDataUrl.length > 350_000) {
          return { ok: false, reason: 'that photo is too large. Try a smaller image' };
        }
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(patch.photoDataUrl)) {
          return { ok: false, reason: 'photo must be a PNG or JPEG' };
        }
      }
      const updated = updateInventoryItem(inventory, id, patch);
      if (!updated.ok) return { ok: false, reason: updated.reason };
      if (updated.changed) {
        await persistInventory();
        lastRemovedInventory = null;
      }
      return inventoryMutateOk({ changed: updated.changed, id });
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
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const item = locateInventoryItem(inventory, id);
    if (!item) return { ok: false, reason: 'item no longer exists' };

    let wanted = name?.trim() || `${item.name} (copy)`;
    if (inventory.items.some((i) => normaliseName(i.name) === normaliseName(wanted))) {
      let n = 2;
      while (inventory.items.some((i) => normaliseName(i.name) === normaliseName(`${wanted} ${n}`))) n++;
      wanted = `${wanted} ${n}`;
    }

    const beforeIds = new Set(inventory.items.map((i) => i.id));
    mergeItems(
      inventory,
      [
        {
          name: wanted,
          department: item.department,
          width: item.width,
          height: item.height,
          sizeSource: item.sizeSource,
          symbolPath: item.symbolPath,
          symbolName: item.symbolName,
          symbolAsset: item.symbolAsset,
          mappedBy: item.mappedBy,
          mapReason: item.mapReason,
          tracedIcon: item.tracedIcon,
          photoDataUrl: item.photoDataUrl,
          notes: item.notes,
        },
      ],
      new Date(),
      { id: `manual-copy:${item.id}:${normaliseName(wanted)}`, type: 'manual', label: wanted },
    );

    const copy = inventory.items.find((i) => !beforeIds.has(i.id) && normaliseName(i.name) === normaliseName(wanted));
    if (!copy) return { ok: false, reason: 'could not create the copy' };
    // A copy starts unused rather than inheriting the original's history.
    copy.timesSeen = 1;
    copy.peakQuantity = 0;
    copy.category = item.category;

    await persistInventory();
    return inventoryMutateOk({ id: copy.id });
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
      payload: {
        name: string;
        width: number;
        height: number;
        paths: Array<{ points: number[]; closed: boolean }>;
        category?: string;
        notes?: string;
        department?: string;
      },
    ) => {
      const busy = inventoryBusyReason();
      if (busy) return { ok: false, reason: busy };
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
        {
          name,
          width: payload.width,
          height: payload.height,
          sizeSource: 'user',
          department: payload.department?.trim() || undefined,
          notes: payload.notes?.trim() || undefined,
        },
      ]);
      const created = inventory.items.find((i) => normaliseName(i.name) === normaliseName(name));
      if (created) {
        const forced = payload.category?.trim();
        const chosen = forced && forced in CATEGORY_LABELS;
        created.category = chosen
          ? (forced as keyof typeof CATEGORY_LABELS)
          : classify(name).category;
        // A category somebody picked is a decision, not a guess, and must
        // survive every future improvement to the classifier.
        created.categoryBy = chosen ? 'user' : 'auto';
        created.tracedIcon = { paths: payload.paths, width: payload.width, height: payload.height };
        if (payload.notes?.trim()) created.notes = payload.notes.trim();
        if (payload.department?.trim()) created.department = payload.department.trim();
      }

      await persistInventory();
      return inventoryMutateOk({ id: created?.id });
    },
  );

  handle('inventory:remove', async (_event, id: string) => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
    const removed = removeInventoryItem(inventory, id);
    if (!removed.ok) return { ok: false, reason: removed.reason };
    if (!removed.changed || !removed.value) return { ok: false, reason: 'the equipment item was not removed' };
    lastRemovedInventory = removed.value;
    await persistInventory();
    return inventoryMutateOk({ undoAvailable: true });
  });

  handle('inventory:restore-last', async () => {
    const busy = inventoryBusyReason();
    if (busy) return { ok: false, reason: busy };
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
    return inventoryMutateOk({ restoredId: restored.value.id });
  });

  /** Places a inventory item, using its remembered footprint when it has one. */
  handle('inventory:place', async (_event, id: string, x: number, y: number) => {
    const item = locateInventoryItem(inventory, id);
    if (!item) return { ok: false, reason: 'item no longer exists' };

    let atX = x;
    let atY = y;
    let alignAngle: number | null = null;
    if (wantsWallSnap(item.name) && session) {
      try {
        const derived = deriveRoom(session.loaded.document);
        const snap = nearestWallSnap(derived.room.walls, x, y);
        if (snap) {
          atX = snap.x;
          atY = snap.y;
          alignAngle = snap.angle;
        }
      } catch {
        // Keep free placement.
      }
    }

    const finish = (reply: {
      ok: boolean;
      reason?: string;
      created?: number[];
      method?: string;
      doc?: OpenResult;
    }) => {
      if (!reply.ok || alignAngle == null || !reply.created?.length) return reply;
      const rotated = applyEdit((s) => {
        const node = s.index.byId.get(reply.created![0]);
        if (!node) return { ok: false, reason: 'placed item missing' };
        return rotateNode(s.loaded.document, node, alignAngle!);
      });
      if (!rotated.ok) return reply;
      return { ...reply, doc: rotated.doc, created: reply.created, method: reply.method };
    };

    const placeAsBox = () =>
      finish(
        applyEdit((s) =>
          placeGear(
            s.loaded.document,
            s.index,
            item.name,
            atX,
            atY,
            item.width && item.height ? { width: item.width, height: item.height } : undefined,
          ),
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
      if (!from) {
        // Prefer the item's own traced silhouette over a generic box when the
        // harvested symbol file is missing.
        if (item.tracedIcon?.paths?.length) {
          return finish(
            applyEdit((s) =>
              placeTracedIcon(s.loaded.document, s.index, item.name, atX, atY, item.tracedIcon!),
            ),
          );
        }
        return placeAsBox();
      }
      // A matched item borrows a shape drawn under a different name — the gear
      // list says "Panasonic PT-RZ21KU", the drawing says "LCD Projector".
      const lookFor = item.symbolName ?? item.name;
      // A shape library holds definitions — an `RVChair`, an `RVAVItem` — not
      // placements. Copying one across brings its drawing but not its identity:
      // it lands as an `RVChair`, so the plan cannot name it, count it, or list
      // it in the inventory. Rebuilding it as a placement is what makes an item
      // put down from the palette the same kind of object as everything else on
      // the drawing.
      if (isLibrary(from)) {
        const built = applyEdit((s) => placeFromLibrary(s.loaded.document, from, lookFor, atX, atY));
        if (built.ok) return finish({ ...built, method: built.method ?? 'library' });
      }
      const imported = applyEdit((s) => importSymbol(s.loaded.document, s.index, from, lookFor, atX, atY));
      // Fall through to a drawn box only if the symbol could not be brought in.
      if (imported.ok) return finish({ ...imported, method: imported.method ?? 'symbol' });
    }

    if (item.tracedIcon?.paths?.length) {
      return finish(
        applyEdit((s) =>
          placeTracedIcon(s.loaded.document, s.index, item.name, atX, atY, item.tracedIcon!),
        ),
      );
    }

    return placeAsBox();
  });

  // --- gear lists ---------------------------------------------------------

  handle('gear:import', async () => {
    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    const e2eImport = process.env.GROUNDPLAN_E2E_IMPORT_PATH?.trim();
    let source: string | undefined;
    if (e2eImport) {
      if (!(await confirmDiscard('gear'))) return null;
      source = grantPath(requireGrantedPath(e2eImport, ['.pdf']));
    } else {
      const result = await dialog.showOpenDialog({
        title: 'Import a gear list',
        properties: ['openFile'],
        filters: [{ name: 'Gear list PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      if (!(await confirmDiscard('gear'))) return null;
      source = grantPath(result.filePaths[0]);
    }
    await enforceFileSize(source, MAX_IMPORT_BYTES);
    const lists = await importGearPdf(new Uint8Array(await readFile(source)), source);
    gear = { lists, dirty: true };
    lastRemovedGear = null;
    activeGearRecoveryId = null;
    scheduleGearRecovery();
    const absorbed = await maybeAutoAbsorbGear();
    if (absorbed) gear.notice = absorbed;
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
    const absorbed = await maybeAutoAbsorbGear();
    if (absorbed) gear.notice = absorbed;
    return gearState();
  });

  handle('gear:new', async () => {
    if (gearSaving) throw new Error('wait for the current gear-list save to finish');
    if (!(await confirmDiscard('gear'))) return null;
    gear = { lists: [createBlankGearList()], dirty: true };
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
    await atomicWriteFile(result.filePath, toCsv(list), {
      backupPath: existsSync(result.filePath) ? `${result.filePath}.bak` : undefined,
    });
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
    (
      _event,
      listIndex: number,
      departmentId: string,
      parentId: string | null,
      description: string,
      quantity = 1,
    ) => {
      const list = gear?.lists[listIndex];
      if (!list || !gear) return { ok: false, reason: 'no gear list is open' };
      const department = list.departments.find((d) => d.id === departmentId);
      if (!department) return { ok: false, reason: 'department no longer exists' };

      const qty = Number.isInteger(quantity) && quantity >= 0 ? quantity : 1;
      const item = {
        id: nextId(),
        quantity: qty,
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

  handle('gear:duplicate', (_event, listIndex: number, itemId: string) => {
    const list = gear?.lists[listIndex];
    if (!list || !gear) return { ok: false, reason: 'no gear list is open' };
    const located = locateGearItem(list, itemId);
    if (!located) return { ok: false, reason: 'item no longer exists' };
    const copy = cloneGearItem(located.item, `${located.item.description} (copy)`);
    located.siblings.splice(located.index + 1, 0, copy);
    list.revision = (Number.isSafeInteger(list.revision) ? list.revision! : 0) + 1;
    gear.dirty = true;
    lastRemovedGear = null;
    scheduleGearRecovery();
    return { ok: true, gear: gearState(), createdId: copy.id };
  });

  handle('gear:add-department', (_event, listIndex: number, name: string) => {
    const list = gear?.lists[listIndex];
    if (!list || !gear) return { ok: false, reason: 'no gear list is open' };
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'enter a department name' };
    if (list.departments.some((d) => normaliseName(d.name) === normaliseName(trimmed))) {
      return { ok: false, reason: 'that department already exists' };
    }
    const department = { id: nextId('dept'), name: trimmed, items: [] };
    list.departments.push(department);
    list.revision = (Number.isSafeInteger(list.revision) ? list.revision! : 0) + 1;
    gear.dirty = true;
    lastRemovedGear = null;
    scheduleGearRecovery();
    return { ok: true, gear: gearState(), createdId: department.id };
  });

  handle('plan:place-gear', async (_event, description: string, x: number, y: number) => {
    // Prefer the company inventory when this description is already sized or
    // has a real silhouette — absorb and harvest are wasted if gear placement
    // always synthesizes a bare box.
    const desc = description.trim();
    let atX = x;
    let atY = y;
    let alignAngle: number | null = null;
    // Doors belong on the room perimeter — free-floating swings never match a print.
    if (wantsWallSnap(desc) && session) {
      try {
        const derived = deriveRoom(session.loaded.document);
        const snap = nearestWallSnap(derived.room.walls, x, y);
        if (snap) {
          atX = snap.x;
          atY = snap.y;
          alignAngle = snap.angle;
        }
      } catch {
        // Leave the click where it was if the room cannot be derived.
      }
    }

    const alignIfDoor = (reply: {
      ok: boolean;
      reason?: string;
      created?: number[];
      method?: string;
      doc?: OpenResult;
    }) => {
      if (!reply.ok || alignAngle == null || !reply.created?.length) return reply;
      const rotated = applyEdit((s) => {
        const node = s.index.byId.get(reply.created![0]);
        if (!node) return { ok: false, reason: 'placed item missing' };
        return rotateNode(s.loaded.document, node, alignAngle!);
      });
      if (!rotated.ok) return reply;
      return {
        ...reply,
        doc: rotated.doc,
        created: reply.created,
        method: reply.method,
      };
    };

    const match = inventory.items.find(
      (item) => normaliseName(item.name) === normaliseName(desc),
    );

    const placeMatched = async (item: InventoryItem) => {
      const known =
        item.width && item.height ? { width: item.width, height: item.height } : undefined;
      if (item.symbolPath && existsSync(item.symbolPath)) {
        try {
          let source = symbolCache.get(item.symbolPath);
          if (!source) {
            source = loadBuffer(await readFile(item.symbolPath), item.symbolPath).document;
            symbolCache.set(item.symbolPath, source);
          }
          const lookFor = item.symbolName ?? item.name;
          if (isLibrary(source)) {
            const built = applyEdit((s) =>
              placeFromLibrary(s.loaded.document, source!, lookFor, atX, atY),
            );
            if (built.ok) return alignIfDoor({ ...built, method: built.method ?? 'library' });
          }
          const imported = applyEdit((s) =>
            importSymbol(s.loaded.document, s.index, source!, lookFor, atX, atY),
          );
          if (imported.ok) return alignIfDoor({ ...imported, method: imported.method ?? 'symbol' });
        } catch {
          // Fall through to traced / sized box.
        }
      }
      if (item.tracedIcon?.paths?.length) {
        return alignIfDoor(
          applyEdit((s) =>
            placeTracedIcon(s.loaded.document, s.index, item.name, atX, atY, item.tracedIcon!),
          ),
        );
      }
      return alignIfDoor(
        applyEdit((s) => placeGear(s.loaded.document, s.index, item.name, atX, atY, known)),
      );
    };

    if (match) return placeMatched(match);

    // Exact miss — resolve under the fidelity contract. Ambiguous names
    // (Mixer vs Bottle - Mixer, Fastfold sizes) must not silently pick first.
    const resolved = resolveInventoryQuery(inventory, desc);
    if (resolved.status === 'exact' || resolved.status === 'unique') {
      return placeMatched(resolved.item);
    }
    if (resolved.status === 'ambiguous') {
      return { ok: false, reason: resolveFailureMessage(resolved) ?? 'ambiguous inventory name' };
    }

    // Exact name miss — still try a classified symbol so gear lines like
    // "Panasonic PT-RZ21KU" can place as the shop's LCD projector silhouette.
    const choice = chooseSymbol(inventory, desc);
    if (choice?.symbolPath && existsSync(choice.symbolPath)) {
      try {
        let source = symbolCache.get(choice.symbolPath);
        if (!source) {
          source = loadBuffer(await readFile(choice.symbolPath), choice.symbolPath).document;
          symbolCache.set(choice.symbolPath, source);
        }
        const lookFor = choice.symbolName;
        if (isLibrary(source)) {
          const built = applyEdit((s) =>
            placeFromLibrary(s.loaded.document, source!, lookFor, atX, atY),
          );
          if (built.ok) return alignIfDoor({ ...built, method: built.method ?? 'library' });
        }
        const imported = applyEdit((s) =>
          importSymbol(s.loaded.document, s.index, source!, lookFor, atX, atY),
        );
        if (imported.ok) return alignIfDoor({ ...imported, method: imported.method ?? 'symbol' });
      } catch {
        // Fall through to synthesis.
      }
    }

    return alignIfDoor(
      applyEdit((s) => placeGear(s.loaded.document, s.index, description, atX, atY)),
    );
  });

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
      // Measure the same rectangle Properties reports, or the scale is taken
      // against a different number than the one the user edited: a chair shown
      // as 20.5in wide but divided by its 30.4in box grows by 1.35x when asked
      // for 2x. `resizeNode` scales on the object's own axes to match.
      // (`repeat-across` deliberately keeps the axis-aligned box — it spaces
      // copies along world directions, where the footprint is what matters.)
      const own = node.cls === 'RVShape' ? orientedExtent(node) : null;
      const current = own ?? measureNode(node);
      if (current.width <= 0 || current.height <= 0) {
        return { ok: false, reason: 'this item has no size to change' };
      }
      return resizeNode(s.loaded.document, node, width / current.width, height / current.height);
    }),
  );

  handle('plan:add-seating', async (_event, request: SeatingRequest) => {
    // Create → Place seating must land real inventory silhouettes on a blank
    // plan, not labelled boxes. Equipment placement already resolves symbols;
    // seating used to call placeGear alone, so the first chair synthesized a
    // box and every later clone copied that box. Seed the chair/table from the
    // inventory once (off-plan), let addSeating clone them, then drop the seeds.
    const byName = (name: string) =>
      inventory.items.find((item) => normaliseName(item.name) === normaliseName(name));

    const loadSymbolDoc = async (symbolPath: string | undefined) => {
      if (!symbolPath || !existsSync(symbolPath)) return undefined;
      try {
        let source = symbolCache.get(symbolPath);
        if (!source) {
          source = loadBuffer(await readFile(symbolPath), symbolPath).document;
          symbolCache.set(symbolPath, source);
        }
        return source;
      } catch {
        return undefined;
      }
    };

    const chairItem = byName(request.chair);
    const tableItem = request.table ? byName(request.table) : undefined;
    const chairChoice =
      chairItem?.symbolPath ? null : chooseSymbol(inventory, request.chair);
    const tableChoice =
      request.table && !tableItem?.symbolPath
        ? chooseSymbol(inventory, request.table)
        : null;

    const chairSource = await loadSymbolDoc(chairItem?.symbolPath ?? chairChoice?.symbolPath);
    const tableSource = await loadSymbolDoc(tableItem?.symbolPath ?? tableChoice?.symbolPath);

    const enriched: SeatingRequest = {
      ...request,
      chairSize:
        chairItem?.width && chairItem?.height
          ? { width: chairItem.width, height: chairItem.height }
          : request.chairSize,
      tableSize:
        tableItem?.width && tableItem?.height
          ? { width: tableItem.width, height: tableItem.height }
          : request.tableSize,
    };

    return applyEdit((s) => {
      // Far outside any real room so the seed never collides with the stamp.
      const PARK = 500_000;
      const seeds: number[] = [];
      let live = s.index;

      const placeSeed = (
        name: string,
        item: InventoryItem | undefined,
        source: ReturnType<typeof loadBuffer>['document'] | undefined,
        symbolName?: string,
      ) => {
        if (findMatchingShape(s.loaded.document, name)) return;
        const known =
          item?.width && item?.height ? { width: item.width, height: item.height } : undefined;
        const lookFor = item?.symbolName ?? symbolName ?? name;
        let placed:
          | { ok: boolean; reason?: string; created?: number[]; method?: string }
          | undefined;

        if (source) {
          if (isLibrary(source)) {
            placed = placeFromLibrary(s.loaded.document, source, lookFor, PARK, PARK);
          }
          if (!placed?.ok) {
            placed = importSymbol(s.loaded.document, live, source, lookFor, PARK, PARK);
          }
        }
        if (!placed?.ok && item?.tracedIcon?.paths?.length) {
          placed = placeTracedIcon(
            s.loaded.document,
            live,
            item.name,
            PARK,
            PARK,
            item.tracedIcon,
          );
        }
        if (!placed?.ok) {
          placed = placeGear(s.loaded.document, live, name, PARK, PARK, known);
        }
        if (placed.ok && placed.created?.length) {
          const seedId = placed.created[0];
          live = indexDocument(s.loaded.document);
          const seedNode = live.byId.get(seedId);
          // Catalogue name on the stamp must match the Create dialog chair —
          // library symbols often ship under a shorter name ("Chair").
          if (seedNode) renameNode(s.loaded.document, seedNode, name);
          seeds.push(seedId);
          live = indexDocument(s.loaded.document);
        }
      };

      placeSeed(request.chair, chairItem, chairSource, chairChoice?.symbolName);
      if (request.table) {
        placeSeed(request.table, tableItem, tableSource, tableChoice?.symbolName);
      }

      const result = addSeating(s.loaded.document, live, enriched);
      if (!result.ok) return result;

      live = indexDocument(s.loaded.document);
      for (const id of seeds) {
        const node = live.byId.get(id);
        if (!node) continue;
        deleteNode(s.loaded.document, live, node);
        live = indexDocument(s.loaded.document);
      }

      const seedSet = new Set(seeds);
      const created = result.created?.filter((id) => !seedSet.has(id));
      groupCreatedIds(created);
      return {
        ...result,
        created,
      };
    });
  });

  handle('plan:add-label', (_event, text: string, x: number, y: number, color?: number) =>
    applyEdit((s) => createLabel(
      s.loaded.document,
      s.index,
      text,
      x,
      y,
      Number.isSafeInteger(color) && color! >= 0 && color! <= 0xffffff ? { color } : {},
    )),
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

  handle('plan:background-set', async (_event, background: unknown) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    try {
      const reply = await updatePlanBackground(session, background, unitSystem());
      if (reply.ok) {
        grantPath(companionPathFor(session.path));
        planSidecarPending = false;
      }
      return reply;
    } catch (err) {
      planSidecarPending = true;
      schedulePlanRecovery(session);
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'the background image could not be saved',
      };
    }
  });

  handle('plan:room-create', (_event, width: number, height: number) =>
    applyEdit((s) => createRectangularRoom(s, width, height, unitSystem())),
  );

  handle('plan:room-create-circle', (_event, diameter: number) =>
    applyEdit((s) => createCircularRoom(s, diameter, unitSystem())),
  );

  handle('plan:room-create-from-spec', (_event, room: NewRoomSpec) =>
    applyEdit((s) => createRoomFromSpec(s, room, unitSystem())),
  );

  handle('plan:room-create-polygon', (_event, points: Array<{ x: number; y: number }>) =>
    applyEdit((s) => createPolygonalRoom(s, points, unitSystem())),
  );

  handle('plan:room-corner-move', (_event, index: number, x: number, y: number) =>
    applyEdit((s) => moveRoomCorner(s, index, x, y, unitSystem())),
  );

  handle('plan:room-corner-add', (_event, wallIndex: number) =>
    applyEdit((s) => addRoomCorner(s, wallIndex, unitSystem())),
  );

  handle('plan:room-corner-remove', (_event, index: number) =>
    applyEdit((s) => removeRoomCorner(s, index, unitSystem())),
  );

  handle('plan:room-corner-round', (_event, index: number, radius: number) =>
    applyEdit((s) => roundRoomCorner(s, index, radius, unitSystem())),
  );

  handle('plan:room-corners-round-all', (_event, radius: number) =>
    applyEdit((s) => roundAllRoomCorners(s, radius, unitSystem())),
  );

  handle('plan:room-reshape', (
    _event,
    op: 'union' | 'difference',
    x: number,
    y: number,
    width: number,
    height: number,
  ) => applyEdit((s) => reshapeRoom(s, op, x, y, width, height, unitSystem())));

  handle(
    'plan:room-curve',
    (
      _event,
      wallIndex: number,
      value: number,
      options?: boolean | { major?: boolean; method?: string; outward?: boolean },
    ) =>
      applyEdit((s) => {
        // Legacy callers passed a signed radius and an optional major boolean.
        if (typeof options === 'boolean' || options == null) {
          const signed = Number(value);
          return curveRoomWall(s, wallIndex, Math.abs(signed), unitSystem(), {
            major: options === true,
            method: 'radius',
            outward: signed < 0,
          });
        }
        const method =
          options.method === 'sagitta' || options.method === 'angle' || options.method === 'arc-length'
            ? options.method
            : 'radius';
        return curveRoomWall(s, wallIndex, Number(value), unitSystem(), {
          major: options.major === true,
          method,
          outward: options.outward === true,
        });
      }),
  );

  handle(
    'plan:room-curve-through',
    (_event, wallIndex: number, through: { x: number; y: number }) =>
      applyEdit((s) => curveRoomWallThrough(s, wallIndex, through, unitSystem())),
  );

  handle('plan:room-wall-length', (_event, wallIndex: number, length: number) =>
    applyEdit((s) => lengthenRoomWall(s, wallIndex, length, unitSystem())),
  );

  handle('plan:room-wall-offset', (_event, wallIndex: number, distance: number) =>
    applyEdit((s) => offsetRoomWall(s, wallIndex, Number(distance), unitSystem())),
  );

  handle('plan:room-dimension', (_event, options?: { corners?: boolean }) =>
    applyEdit((s) => dimensionTheRoom(s, unitSystem(), options ?? {})),
  );

  handle(
    'plan:led-wall',
    (_event, x: number, y: number, request: { panel: string; columns: number; rows: number; name?: string }) => {
      let extra: { wall?: unknown; buildList?: unknown; warnings?: string[] } = {};
      const reply = applyEdit((s) => {
        const result = addLedWall(s, x, y, request);
        extra = { wall: result.wall, buildList: result.buildList, warnings: result.warnings };
        return result;
      });
      return { ...reply, ...extra };
    },
  );

  /* ── Named versions ───────────────────────────────────────────────────── */

  handle('versions:list', () => (session ? listVersions(session.path) : []));

  handle('versions:save', (_event, name: string) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    // The snapshot is the plan as it stands, including unsaved edits: a version
    // you have to save the file to take is a version you will forget to take.
    const result = saveVersion(session.path, session.file(), String(name ?? ''));
    return result.ok ? { ok: true, version: result.version } : result;
  });

  handle('versions:restore', async (_event, id: string) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const bytes = readVersion(session.path, String(id));
    if (!bytes) return { ok: false, reason: 'that version is no longer on disk' };
    // Restoring is an edit, not a file swap: it goes on the undo stack like
    // anything else, so a restore can be taken back.
    return applyEdit((s) => {
      const ok = s.restoreFrom(bytes);
      return ok ? { ok: true } : { ok: false, reason: 'that version could not be opened' };
    });
  });

  handle('versions:compare', (_event, id: string) => {
    if (!session) return null;
    const bytes = readVersion(session.path, String(id));
    if (!bytes) return null;
    try {
      return comparePlanWith(session, bytes);
    } catch {
      return null;
    }
  });

  handle('versions:rename', (_event, id: string, name: string) =>
    session ? renameVersion(session.path, String(id), String(name ?? '')) : false,
  );

  handle('versions:delete', (_event, id: string) =>
    session ? deleteVersion(session.path, String(id)) : false,
  );

  /* ── Show brief ───────────────────────────────────────────────────────── */

  handle('plan:show-brief', () => (session ? planShowBrief() : null));

  handle('plan:show-brief-set', async (_event, patch: Record<string, unknown>) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    let brief: unknown = null;
    // The brief lives in the sidecar, so this is a companion write rather than
    // a document edit — but the trailer sync inside it IS a document edit, so
    // it goes through applyEdit to stay undoable and to mark the plan dirty.
    const reply = applyEdit(
      (s) => {
        const result = setShowBrief(s, (patch ?? {}) as never, unitSystem());
        brief = result.brief ?? null;
        return result;
      },
      // A trailer-only patch must not be refused because an unrelated wall
      // fails a strict census — same reasoning as plan:identity-set.
      { skipRoundTripVerify: true },
    );
    // Straight to disk. The sidecar is the brief's only home, and waiting for
    // a document save meant a brief typed at plan creation never reached it.
    if (reply.ok) await persistShowBrief(session);
    return { ...reply, brief };
  });

  handle('plan:cable-schedule', () => (session ? planCableSchedule(session) : null));

  handle('plan:load-summary', () => {
    if (!session) return null;
    return planLoad(session);
  });

  handle('plan:wall-dimension', (_event, index: number, kind: WallDimensionKind) =>
    applyEdit((s) => dimensionOneWall(s, index, kind, unitSystem())),
  );

  handle('plan:room-meta', async (_event, patch: { name?: string; ceilingHeight?: number }) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const result = updateRoomMeta(session, patch ?? {}, unitSystem());
    if (!result.ok) return result;
    // Companion-only: persist immediately so name/ceiling survive quit without a
    // plan-body edit marking the session dirty. Fingerprint the last-saved
    // archive so a dirty RV body cannot make the sidecar look fresher than disk.
    try {
      await savePlanModel(session.path, session.savedArchiveBody());
      grantPath(companionPathFor(session.path));
      planSidecarPending = false;
    } catch (err) {
      planSidecarPending = true;
      schedulePlanRecovery(session);
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'the room details could not be saved',
      };
    }
    return { ok: true, note: 'Room details saved' };
  });

  handle(
    'plan:identity-set',
    (
      _event,
      patch: { date?: string; venue?: string; event?: string; contact?: string },
    ) =>
      applyEdit(
        (s) => {
          const next = {
            date: typeof patch?.date === 'string' ? patch.date : undefined,
            venue: typeof patch?.venue === 'string' ? patch.venue : undefined,
            event: typeof patch?.event === 'string' ? patch.event : undefined,
            contact: typeof patch?.contact === 'string' ? patch.contact : undefined,
          };
          const cleaned: Partial<{ date: string; venue: string; event: string; contact: string }> =
            {};
          if (next.date !== undefined) cleaned.date = next.date.trim();
          if (next.venue !== undefined) cleaned.venue = next.venue.trim();
          if (next.event !== undefined) cleaned.event = next.event.trim();
          if (next.contact !== undefined) cleaned.contact = next.contact.trim();
          const result = setPlanIdentity(s.loaded.document, cleaned);
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, text: 'Show details saved' };
        },
        // Trailer-only patch — do not refuse show details because an unrelated
        // wall segment fails a strict census (see locateSegmentPoints fallback).
        { skipRoundTripVerify: true },
      ),
  );

  handle('plan:av-summary', () => (session ? avSummary(session, unitSystem()) : null), null);

  /** Solves without drawing, so the panel can show the count as it is tuned. */
  handle(
    'plan:seating-preview',
    (_event, request: SeatingRequestView) => (session ? previewSeating(session, request) : null),
    null,
  );

  handle('plan:seating-apply', (_event, request: SeatingRequestView, chair: string, table?: string) => {
    const reply = applyEdit((s) => applySeatingModel(s, request, chair, table));
    if (reply.ok) groupCreatedIds((reply as { created?: number[] }).created);
    return reply;
  });

  handle('plan:list-layout-kits', () => listLayoutKits(app.getPath('userData')));

  handle('plan:load-layout-kit', (_event, kitId: string) => {
    const recipe = loadLayoutKit(app.getPath('userData'), kitId);
    if (!recipe) return { ok: false, reason: 'kit not found' };
    return { ok: true, recipe };
  });

  handle(
    'plan:apply-layout-recipe',
    (
      _event,
      recipeOrKitId: unknown,
      options?: {
        replaceExistingSeating?: boolean;
        replaceExistingGear?: boolean;
        kitId?: string;
        fitToExistingRoom?: boolean;
        includeStage?: boolean;
        includeSeating?: boolean;
        includeGear?: boolean;
        includeAnnotations?: boolean;
      },
    ) => {
      let recipe = recipeOrKitId;
      if (typeof options?.kitId === 'string') {
        recipe = loadLayoutKit(app.getPath('userData'), options.kitId);
        if (!recipe) return { ok: false, reason: 'kit not found' };
      } else if (typeof recipeOrKitId === 'string') {
        recipe = loadLayoutKit(app.getPath('userData'), recipeOrKitId);
        if (!recipe) return { ok: false, reason: 'kit not found' };
      }
      if (!isLayoutRecipe(recipe)) return { ok: false, reason: 'not a valid layout recipe' };
      const layout = recipe;
      const validated = validateLayoutRecipe(layout, inventory);
      if (!validated.ok) return { ok: false, reason: validated.reason };

      return applyEdit((s) => {
        const result = applyFullLayoutRecipe(s, layout, {
          inventory,
          replaceExistingSeating: Boolean(options?.replaceExistingSeating),
          replaceExistingGear: Boolean(options?.replaceExistingGear),
          createRoomIfMissing: true,
          fitToExistingRoom: options?.fitToExistingRoom !== false,
          includeStage: options?.includeStage,
          includeSeating: options?.includeSeating,
          includeGear: options?.includeGear,
          includeAnnotations: options?.includeAnnotations,
          units: unitSystem(),
        });
        if (!result.ok) return { ok: false, reason: result.reason };
        // Each seating block becomes one selectable bank (sidecar links only).
        for (const block of result.seating ?? []) {
          if (block.ok) groupCreatedIds(block.created);
        }
        return {
          ok: true,
          text: result.status,
          created: result.created,
          placed: result.chairsPlaced,
        };
      });
    },
  );

  handle('plan:save-open-as-kit', (_event, fileName?: string) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const recipe = exportLayoutRecipe(session.loaded.document);
    if (fileName?.trim()) {
      recipe.identity = { ...recipe.identity, event: fileName.trim() };
    }
    return saveLayoutKit(app.getPath('userData'), recipe, fileName?.trim());
  });

  handle('plan:clear-furniture', (_event, kind: 'seating' | 'gear' | 'all' = 'seating') =>
    applyEdit((s) => {
      let removed = 0;
      if (kind === 'seating' || kind === 'all') removed += clearSeatingShapes(s);
      if (kind === 'gear' || kind === 'all') removed += clearGearShapes(s);
      return {
        ok: true,
        text: removed
          ? `Cleared ${removed.toLocaleString()} object${removed === 1 ? '' : 's'}`
          : 'Nothing to clear',
        placed: removed,
      };
    }),
  );

  handle('file:duplicate-path', async (_event, sourcePath: string) => {
    if (!sourcePath || !existsSync(sourcePath)) {
      return { ok: false, reason: 'that plan could not be found' };
    }
    try {
      const dir = dirname(sourcePath);
      const base = basename(sourcePath, '.rv4');
      let target = join(dir, `${base} copy.rv4`);
      let n = 2;
      while (existsSync(target)) {
        target = join(dir, `${base} copy ${n}.rv4`);
        n += 1;
      }
      copyFileSync(sourcePath, target);
      const companionSrc = `${sourcePath}.groundplan.json`;
      if (existsSync(companionSrc)) {
        try {
          copyFileSync(companionSrc, `${target}.groundplan.json`);
        } catch {
          /* companion is optional */
        }
      }
      return openPath(target);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  handle('plan:save-layout-kit', (_event, recipe: unknown, fileName?: string) => {
    if (!isLayoutRecipe(recipe)) return { ok: false, reason: 'not a valid layout recipe' };
    return saveLayoutKit(app.getPath('userData'), recipe, fileName);
  });

  handle('plan:import-layout-kit', async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import layout recipe',
      filters: [{ name: 'Layout recipe', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    return importLayoutKitFile(app.getPath('userData'), picked.filePaths[0]);
  });

  handle('plan:export-layout-recipe', async () => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const recipe = exportLayoutRecipe(session.loaded.document);
    const defaultName = `${recipe.identity?.event ?? 'show-kit'}.json`.replace(/[^\w.\- ]+/g, '');
    const picked = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export layout recipe',
      defaultPath: defaultName,
      filters: [{ name: 'Layout recipe', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    writeFileSync(picked.filePath, JSON.stringify(recipe, null, 2));
    const saved = saveLayoutKit(app.getPath('userData'), recipe, defaultName.replace(/\.json$/i, ''));
    return { ok: true, path: picked.filePath, kitId: saved.ok ? saved.id : undefined, recipe };
  });

  handle('plan:list-bank-presets', () => loadBankPresets(app.getPath('userData')));

  handle('plan:save-bank-preset', (_event, preset: { name: string; block: unknown; id?: string }) => {
    if (!preset?.name || !preset.block) return { ok: false, reason: 'name and block required' };
    const saved = saveBankPreset(app.getPath('userData'), {
      id: preset.id,
      name: preset.name,
      block: preset.block as never,
    });
    return { ok: true, preset: saved };
  });

  handle('plan:delete-bank-preset', (_event, id: string) => {
    deleteBankPreset(app.getPath('userData'), id);
    return { ok: true };
  });

  handle(
    'plan:stage-add',
    (
      _event,
      x: number,
      y: number,
      width: number,
      depth: number,
      height: number,
      back?: { depth: number; height: number },
      stairs?: Array<'front' | 'back' | 'left' | 'right'>,
      more?: {
        levels?: Array<{ depth: number; height: number; label?: string }>;
        ramps?: Array<'front' | 'back' | 'left' | 'right'>;
        rails?: Array<'front' | 'back' | 'left' | 'right'>;
        deckSize?: string;
        skirted?: boolean;
      },
    ) => {
      let extra: { buildList?: unknown; warnings?: string[] } = {};
      const reply = applyEdit((s) => {
        const result = addStage(s, x, y, width, depth, height, {
          back: back && back.depth > 0 && back.height > 0 ? back : undefined,
          stairs: Array.isArray(stairs) ? stairs : undefined,
          levels: Array.isArray(more?.levels) ? more.levels : undefined,
          ramps: Array.isArray(more?.ramps) ? more.ramps : undefined,
          rails: Array.isArray(more?.rails) ? more.rails : undefined,
          deckSize: typeof more?.deckSize === 'string' ? more.deckSize : undefined,
          skirted: more?.skirted,
        });
        extra = { buildList: result.buildList, warnings: result.warnings };
        return result;
      });
      if (reply.ok && reply.created && reply.created.length >= 2) {
        linkObjects(reply.created[0]!, reply.created[1]!);
      }
      return { ...reply, ...extra };
    },
  );

  handle('plan:draw', (_event, tool: DrawTool, x1: number, y1: number, x2: number, y2: number) =>
    applyEdit((s) => drawShape(s, tool, x1, y1, x2, y2)),
  );

  handle('plan:add-cable-path', (_event, name: string, points: Array<{ x: number; y: number }>, kind?: CableKind) =>
    applyEdit((s) =>
      addCablePath(
        s,
        typeof name === 'string' ? name : 'Power run',
        Array.isArray(points) ? points : [],
        typeof kind === 'string' ? kind : undefined,
      ),
    ),
  );

  handle('plan:place-av-pair', (_event, x: number, y: number) =>
    applyEdit((s) => placeScreenProjectorPair(s, { x: Number(x) || 0, y: Number(y) || 0 })),
  );

  handle('plan:set-elevation', async (_event, key: string, elevation: number | null) => {
    const s = session;
    if (!s) return { ok: false, reason: 'no plan is open' };
    if (!s.editable) return { ok: false, reason: 'this plan is read-only' };
    const result = setInstanceElevation(
      s,
      typeof key === 'string' ? key : '',
      elevation == null ? null : Number(elevation),
      unitSystem(),
    );
    if (!result.ok) return result;
    try {
      await savePlanModel(s.path, s.savedArchiveBody());
      planSidecarPending = false;
    } catch (error) {
      planSidecarPending = true;
      schedulePlanRecovery(s);
      console.error('[groundplan] could not save elevation:', error);
    }
    return { ok: true, note: result.note, doc: describe(s) };
  });

  handle('plan:selection-elevation', (_event, nodeId: number) =>
    session ? selectionElevation(session, Number(nodeId)) : null,
  );

  handle('plan:selection-elevations', (_event, ids: number[]) => {
    if (!session || !Array.isArray(ids)) return [];
    return ids.map((id) => {
      const info = selectionElevation(session!, Number(id));
      return {
        id: Number(id),
        key: info?.key ?? '',
        elevation: info?.elevation ?? 0,
        inferred: info?.inferred ?? true,
      };
    });
  });

  /**
   * Linked stack / group members for canvas overlays and the Properties coach.
   * Only returns a set when real stack-on / stage-stairs links exist — a plain
   * multi-select of chairs is not a digital stack.
   */
  handle('plan:linked-set', (_event, ids: number[]) => {
    if (!session || !Array.isArray(ids) || !ids.length) return [];
    const seed = ids.map(Number).filter((id) => Number.isFinite(id) && session!.index.byId.has(id));
    if (!seed.length) return [];

    const stackPartners = new Set<number>(seed);
    const queue = [...seed];
    let foundLink = false;
    while (queue.length) {
      const id = queue.pop()!;
      for (const partner of objectLinks.get(id) ?? []) {
        const kind = objectLinkKinds.get(objectLinkPairKey(id, partner));
        if (kind !== 'stack-on' && kind !== 'stage-stairs') continue;
        foundLink = true;
        if (stackPartners.has(partner)) continue;
        stackPartners.add(partner);
        queue.push(partner);
      }
    }
    if (!foundLink) return [];

    const members = [...stackPartners];
    const primary = seed[0]!;
    return members.map((id) => {
      const node = session!.index.byId.get(id);
      const elev = selectionElevation(session!, id);
      const name =
        node?.labels.find((s) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(s)) ??
        node?.cls.replace(/^RV/, '') ??
        `Object ${id}`;
      const kind =
        id === primary
          ? 'focus'
          : objectLinkKinds.get(objectLinkPairKey(primary, id)) === 'stack-on'
            ? 'stacked'
            : 'linked';
      return {
        id,
        name,
        elevation: elev?.elevation ?? 0,
        kind,
      };
    });
  });

  handle('plan:sightline-markers', () => (session ? sightlineMarkers(session) : []), []);

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

    await atomicWriteFile(target.filePath, markdown, {
      backupPath: existsSync(target.filePath) ? `${target.filePath}.bak` : undefined,
    });
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
  handle(
    'file:new',
    async (
      _event,
      options: {
        name?: string;
        width?: number;
        depth?: number;
        ceilingHeight?: number;
        room?: NewRoomSpec;
        sheetSize?: { width: number; depth: number };
        autoDimensions?: boolean;
        autosave?: boolean;
        identity?: { date?: string; venue?: string; event?: string; contact?: string };
      },
    ) => {
    const width = Number(options?.width) || 0;
    const depth = Number(options?.depth) || 0;
    const ceilingHeight =
      typeof options?.ceilingHeight === 'number' && options.ceilingHeight > 0
        ? options.ceilingHeight
        : undefined;
    const roomName =
      typeof options?.name === 'string' && options.name.trim() ? options.name.trim() : undefined;

    const sheet =
      options?.sheetSize &&
      Number(options.sheetSize.width) > 0 &&
      Number(options.sheetSize.depth) > 0
        ? { width: Number(options.sheetSize.width), depth: Number(options.sheetSize.depth) }
        : undefined;

    const built = createBlankPlan({
      roomSpec: options?.room,
      room: !options?.room && width > 0 && depth > 0 ? { width, depth } : undefined,
      sheetSize: !options?.room ? sheet : undefined,
      roomName,
      identity: options?.identity,
      autoDimensions: options?.autoDimensions ? unitSystem() : undefined,
    });
    if (!built.ok || !built.file) return { ok: false, reason: built.reason };

    // CDP / UI automation cannot click macOS native sheets.
    // Prefer GROUNDPLAN_E2E_SAVE_PATH; if it may contain spaces, use
    // GROUNDPLAN_E2E_SAVE_DIR + GROUNDPLAN_E2E_SAVE_NAME, or a path file.
    const e2eSavePath = resolveE2eSavePath();
    if (!e2eSavePath) {
      const dirtyPlan = !!(session && (session.dirty || planSidecarPending));
      const dirtyGear = !!gear?.dirty;
      // Autosave "New plan" should not trap behind a native Save/Discard sheet.
      // Persist the open plan quietly when that is the only dirty document.
      if (options?.autosave && dirtyPlan && !dirtyGear) {
        const saved = await savePlanDocument(false);
        if (!saved.ok) {
          if (!saved.cancelled) await showSaveFailure(saved);
          return {
            ok: false,
            cancelled: saved.cancelled,
            reason: saved.reason ?? 'could not save the open plan before creating a new one',
          };
        }
      } else if (!(await confirmDiscard('plan'))) {
        return { ok: false, cancelled: true };
      }
    }

    const safeBase = (roomName || 'Untitled plan').replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled plan';
    const suggested = `${safeBase}.rv4`;
    let targetPath: string | undefined;
    if (e2eSavePath) {
      targetPath = e2eSavePath;
    } else if (options?.autosave) {
      const folder = join(app.getPath('documents'), 'Groundplan');
      await mkdir(folder, { recursive: true });
      let candidate = join(folder, suggested);
      if (existsSync(candidate)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        candidate = join(folder, `${safeBase} ${stamp}.rv4`);
      }
      targetPath = candidate;
    } else {
      const picked = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save new plan',
        defaultPath: suggested,
        filters: [
          {
            name: 'Room Viewer plan',
            extensions: PLAN_EXTENSIONS.map((extension) => extension.slice(1)),
          },
        ],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      targetPath = picked.filePath;
    }

    await atomicWriteFile(targetPath, built.file, {
      backupPath: existsSync(targetPath) ? `${targetPath}.bak` : undefined,
    });
    grantPath(targetPath);
    await openPath(targetPath);

    // RV4 stores arcs as faithful polylines. The companion keeps the exact
    // radius/bulge model so the Room panel can reopen and continue editing the
    // curve by its original measurement rather than an approximation.
    if (options?.room && session) {
      const exact = buildNewRoom(options.room, roomName ?? 'Room');
      if (exact.ok && exact.room) {
        if (ceilingHeight) exact.room.ceilingHeight = ceilingHeight;
        adoptAuthoredRoom(session, exact.room, unitSystem());
        try {
          await savePlanModel(session.path, session.savedArchiveBody());
          planSidecarPending = false;
        } catch (error) {
          planSidecarPending = true;
          schedulePlanRecovery(session);
          console.error('[groundplan] could not save new-plan companion:', error);
        }
      }
    } else if (ceilingHeight && session) {
      const applied = updateRoomMeta(session, { ceilingHeight }, unitSystem());
      if (!applied.ok) {
        // Custom / site-plan path: walls come later — hold ceiling until then.
        setPendingCeilingHeight(ceilingHeight);
      }
      try {
        await savePlanModel(session.path, session.savedArchiveBody());
        planSidecarPending = false;
      } catch (error) {
        planSidecarPending = true;
        schedulePlanRecovery(session);
        console.error('[groundplan] could not save new-plan ceiling:', error);
      }
    }

    if (!session) return { ok: false, reason: 'the new plan could not be opened' };
    return { ok: true, doc: describe(session) };
  });

  handle('file:discard-empty-plan', async () => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const path = session.path;
    const model = planModelView(session, unitSystem());
    const walls = model?.room?.walls ?? 0;
    const hasRoom = walls >= 3 && model?.room?.source !== 'extent' && model?.room?.source !== 'none';
    if (hasRoom) {
      return { ok: false, reason: 'this plan already has a room. Close it normally instead' };
    }
    if (session.dirty) {
      const confirmed = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Discard', 'Keep'],
        defaultId: 1,
        cancelId: 1,
        title: 'Discard empty plan?',
        message: 'Delete this empty plan file and close it?',
        detail: basename(path),
      });
      if (confirmed.response !== 0) return { ok: false, cancelled: true };
    }
    cancelPlanRecoverySchedule();
    session = null;
    clearObjectLinks();
    resetPlanModel();
    planSidecarPending = false;
    activePlanRecoveryId = null;
    dimensionAssociations = {
      format: 'groundplan-dimension-associations',
      version: 1,
      entries: [],
    };
    dimensionAssociationWarning = undefined;
    resetDimensionHistory();
    try {
      if (existsSync(path)) await unlink(path);
    } catch (error) {
      console.error('[groundplan] could not delete empty plan:', error);
      return { ok: false, reason: 'the empty plan was closed but the file could not be deleted' };
    }
    return { ok: true };
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
        | 'rotate-each'
        | 'orient'
        | 'recolor'
        | 'flip-horizontal'
        | 'flip-vertical'
        | 'bring-to-front'
        | 'send-to-back',
      ids: number[],
      a = 0,
      b = 0,
    ) => {
      const skipRoundTripVerify =
        kind === 'move' ||
        kind === 'rotate' ||
        kind === 'rotate-each' ||
        kind === 'orient' ||
        kind === 'flip-horizontal' ||
        kind === 'flip-vertical' ||
        kind === 'bring-to-front' ||
        kind === 'send-to-back' ||
        kind === 'recolor';
      return applyEdit((s) => {
        let touched = 0;
        const reasons: string[] = [];
        const created: number[] = [];

        // Linked sets (stage↔stairs, stack-on, groups) travel together on
        // move / rotate / delete / duplicate. rotate-each and orient spin only
        // the ids you picked (straighten a bank of chairs without orbiting).
        const expanded =
          kind === 'move' || kind === 'delete' || kind === 'duplicate' || kind === 'rotate'
            ? expandLinkedIds(ids)
            : ids;

        const targets = expanded
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
          targets.sort((left, right) => depthOf(right) - depthOf(left));
        }

        const duplicatePairs: Array<{ from: number; to: number }> = [];
        if (kind === 'duplicate') {
          for (const id of ids) {
            for (const partner of objectLinks.get(id) ?? []) {
              if (id < partner) duplicatePairs.push({ from: id, to: partner });
            }
          }
        }
        const newByOld = new Map<number, number>();

        // Multi-select rotate orbits the selection about its collective centre
        // so a bank of chairs turns as one piece (angled wings), not each icon
        // spinning on a fixed grid. Single-item rotate still spins in place.
        let rotatePivot: { x: number; y: number } | null = null;
        if (kind === 'rotate' && targets.length > 1) {
          let sx = 0;
          let sy = 0;
          let n = 0;
          for (const target of targets) {
            const centre = nodeCentre(target);
            if (!centre) continue;
            sx += centre.x;
            sy += centre.y;
            n++;
          }
          if (n > 0) rotatePivot = { x: sx / n, y: sy / n };
        }

        for (const node of targets) {
          let result: { ok: boolean; reason?: string; created?: number[] };
          switch (kind) {
            case 'move':
              result = moveNode(s.loaded.document, node, a, b);
              break;
            case 'rotate': {
              const radians = (a * Math.PI) / 180;
              result = rotatePivot
                ? rotateNodeAbout(s.loaded.document, node, radians, rotatePivot)
                : rotateNode(s.loaded.document, node, radians);
              break;
            }
            case 'rotate-each': {
              result = rotateNode(s.loaded.document, node, (a * Math.PI) / 180);
              break;
            }
            case 'orient': {
              // Absolute facing in degrees — spin each piece in place to that angle.
              const target = (a * Math.PI) / 180;
              const current = node.angle != null && Number.isFinite(node.angle) ? node.angle : 0;
              let delta = target - current;
              while (delta > Math.PI) delta -= Math.PI * 2;
              while (delta < -Math.PI) delta += Math.PI * 2;
              result = rotateNode(s.loaded.document, node, delta);
              break;
            }
            case 'duplicate':
              result = duplicateNode(s.loaded.document, s.index, node, a, b);
              if (result.ok && result.created?.[0] != null) {
                newByOld.set(node.id, result.created[0]);
                s.index = indexDocument(s.loaded.document);
              }
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
              result = { ok: false, reason: `unknown edit: ${String(kind)}` };
          }
          if (result.ok) {
            touched++;
            if (result.created) created.push(...result.created);
          } else if (result.reason && !reasons.includes(result.reason)) reasons.push(result.reason);
        }

        if (kind === 'delete' && touched > 0) {
          pruneObjectLinks(targets.map((n) => n.id));
        }
        if (kind === 'duplicate' && touched > 0) {
          for (const pair of duplicatePairs) {
            const na = newByOld.get(pair.from);
            const nb = newByOld.get(pair.to);
            if (na != null && nb != null) {
              linkObjects(na, nb, objectLinkKinds.get(objectLinkPairKey(pair.from, pair.to)) ?? 'stage-stairs');
            }
          }
        }

        if (touched === 0) {
          return { ok: false, reason: reasons[0] ?? 'nothing could be changed' };
        }
        return { ok: true, created: created.length ? created : undefined };
      }, { skipRoundTripVerify });
    },
  );

  handle('edit:repeat-across', (_event, nodeId: number, count: number, direction = 'right') =>
    applyEdit((s) => {
      const n = Math.floor(Number(count));
      if (!(n >= 2 && n <= 40)) {
        return { ok: false, reason: 'enter a repeat count between 2 and 40' };
      }
      let node = s.index.byId.get(nodeId);
      if (!node) return { ok: false, reason: 'object no longer exists' };
      const size = measureNode(node);
      const dir = direction === 'left' || direction === 'up' || direction === 'down' ? direction : 'right';
      const spacing = dir === 'right' || dir === 'left' ? size.width : size.height;
      if (!(spacing > 0)) {
        return { ok: false, reason: 'that item has no size to space copies by' };
      }
      const dx = dir === 'right' ? spacing : dir === 'left' ? -spacing : 0;
      const dy = dir === 'down' ? spacing : dir === 'up' ? -spacing : 0;
      const created: number[] = [nodeId];
      for (let i = 1; i < n; i++) {
        const result = duplicateNode(s.loaded.document, s.index, node, dx, dy);
        if (!result.ok) return result;
        if (result.created) created.push(...result.created);
        s.index = indexDocument(s.loaded.document);
        const nextId = result.created?.[0];
        const next = nextId != null ? s.index.byId.get(nextId) : undefined;
        if (!next) return { ok: false, reason: 'the copy could not be located' };
        node = next;
      }
      return { ok: true, created };
    }),
  );

  handle(
    'edit:array-grid',
    (
      _event,
      nodeId: number,
      columns: number,
      rows: number,
      gapX?: number | null,
      gapY?: number | null,
    ) =>
      applyEdit((s) => {
        const node = s.index.byId.get(nodeId);
        if (!node) return { ok: false, reason: 'object no longer exists' };
        const result = arrayGrid(s.loaded.document, s.index, node, {
          columns,
          rows,
          gapX: gapX != null && Number(gapX) > 0 ? Number(gapX) : undefined,
          gapY: gapY != null && Number(gapY) > 0 ? Number(gapY) : undefined,
        });
        if (result.ok) s.index = indexDocument(s.loaded.document);
        return result;
      }),
  );

  handle(
    'edit:setback-from-wall',
    (
      _event,
      ids: number[],
      distance: number,
      options?: { mode?: 'each' | 'group'; faceWall?: boolean },
    ) =>
      applyEdit((s) => {
        const dist = Number(distance);
        if (!(dist >= 0) || !Number.isFinite(dist)) {
          return { ok: false, reason: 'enter a distance from the wall' };
        }
        if (!ids.length) return { ok: false, reason: 'select at least one item' };
        const { room } = resolvePlanRoom(s.loaded.document);
        if (room.walls.length < 3) {
          return { ok: false, reason: 'draw a room outline before setting wall distance' };
        }

        const mode = options?.mode === 'group' ? 'group' : 'each';
        const faceWall = options?.faceWall !== false && ids.length === 1;

        type Target = { id: number; fromX: number; fromY: number };
        const targets: Target[] = [];
        for (const id of ids) {
          const node = s.index.byId.get(id);
          if (!node) continue;
          const centre = nodeCentre(node);
          if (!centre) continue;
          targets.push({ id, fromX: centre.x, fromY: centre.y });
        }
        if (!targets.length) return { ok: false, reason: 'could not locate the selection' };

        if (mode === 'group') {
          const cx = targets.reduce((sum, t) => sum + t.fromX, 0) / targets.length;
          const cy = targets.reduce((sum, t) => sum + t.fromY, 0) / targets.length;
          const setback = wallSetback(room.walls, cx, cy, dist, room);
          if (!setback) return { ok: false, reason: 'no wall found near the selection' };
          const dx = setback.x - cx;
          const dy = setback.y - cy;
          for (const t of targets) {
            const node = s.index.byId.get(t.id);
            if (!node) continue;
            const moved = moveNode(s.loaded.document, node, dx, dy);
            if (!moved.ok) return moved;
          }
          if (faceWall && targets.length === 1) {
            const node = s.index.byId.get(targets[0]!.id);
            if (node && node.angle != null) {
              let delta = setback.angle - node.angle;
              while (delta > Math.PI) delta -= Math.PI * 2;
              while (delta < -Math.PI) delta += Math.PI * 2;
              if (Math.abs(delta) > 1e-6) {
                const turned = rotateNode(s.loaded.document, node, delta);
                if (!turned.ok) return turned;
              }
            }
          }
          return { ok: true };
        }

        let movedCount = 0;
        for (const t of targets) {
          const setback = wallSetback(room.walls, t.fromX, t.fromY, dist, room);
          if (!setback) continue;
          const node = s.index.byId.get(t.id);
          if (!node) continue;
          const moved = moveNode(s.loaded.document, node, setback.x - t.fromX, setback.y - t.fromY);
          if (!moved.ok) return moved;
          if (faceWall && targets.length === 1 && node.angle != null) {
            let delta = setback.angle - node.angle;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            if (Math.abs(delta) > 1e-6) {
              const turned = rotateNode(s.loaded.document, node, delta);
              if (!turned.ok) return turned;
            }
          }
          movedCount += 1;
        }
        if (!movedCount) return { ok: false, reason: 'no wall found near the selection' };
        return { ok: true };
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
    // A label stores [font family, text]. Font names are user-editable, so
    // guessing which string is a font by a short allow-list makes Georgia or
    // a custom face appear as the label's wording in Properties.
    const name =
      node.cls === 'RVLabel' && node.labels.length >= 2
        ? node.labels[1]
        : node.labels.find((s) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(s));
    const measured = measureNode(node);
    // Prefer the object's own rectangle. `measureNode` returns the axis-aligned
    // box, and `node.angle` is a running total of turns applied rather than an
    // absolute facing, so a 20.5x23.2in chair drawn at -120 degrees reported
    // "0 degrees, 30.4 x 29.4in" — three numbers, none of them the ones on screen.
    const own = node.cls === 'RVShape' ? orientedExtent(node) : null;
    /** Degrees clockwise, normalised to [-180, 180) so nothing shows "512". */
    const normalise = (degrees: number): number =>
      Math.round(((((degrees + 180) % 360) + 360) % 360 - 180) * 10) / 10;
    const facing = own
      ? normalise((own.angleRadians * 180) / Math.PI)
      : node.angle != null && Number.isFinite(node.angle)
        ? normalise((node.angle * 180) / Math.PI)
        : null;
    const info: SelectionInfo = {
      nodeId,
      cls: node.cls,
      name,
      text: node.cls === 'RVLabel' ? name : undefined,
      color: session.scene.primitives.find((primitive) => primitive.selectId === nodeId)?.color ?? node.color,
      canDelete: !session.index.shared.has(node),
      canRelabel:
        (node.cls === 'RVLabel' && node.fields.textAt != null) || node.fields.nameAt != null,
      widthUnits: own?.width ?? measured.width,
      heightUnits: own?.height ?? measured.height,
      x: (node.bounds.left + node.bounds.right) / 2,
      y: (node.bounds.top + node.bounds.bottom) / 2,
      angleDegrees: facing,
      textStyle:
        node.cls === 'RVLabel'
          ? {
              family: node.font?.family || 'Arial',
              size: Math.max(4, Math.abs(node.font?.height ?? -90) / 10),
              bold: (node.font?.weight ?? (node.bold ? 700 : 400)) >= 600,
              italic: node.font?.italic ?? false,
              underline: node.font?.underline ?? false,
              strikeOut: node.font?.strikeOut ?? false,
              angleDegrees: ((node.angle ?? 0) * 180) / Math.PI,
            }
          : undefined,
      pointPaths: session.scene.primitives
        .filter((primitive) => primitive.selectId === nodeId || primitive.nodeId === nodeId)
        .map((primitive) => {
          const source = session!.index.byId.get(primitive.nodeId);
          if (!source) return null;
          const firstIndex = source.cls === 'RVSegmentArc' && source.points.length >= 4
            ? source.points.length - 4
            : 0;
          const points = Array.from({ length: primitive.pts.length / 2 }, (_, pointIndex) => ({
            index: firstIndex + pointIndex,
            x: primitive.pts[pointIndex * 2]!,
            y: primitive.pts[pointIndex * 2 + 1]!,
            role:
              primitive.type === 'bezier' && (pointIndex === 1 || pointIndex === 2)
                ? ('control' as const)
                : ('anchor' as const),
          }));
          const shared = session!.index.shared.has(source);
          const writable = source.fields.pointsAt != null && !!source.fields.pointCount;
          return {
            nodeId: source.id,
            cls: source.cls,
            closed: primitive.type === 'polygon',
            canEdit: writable && !shared,
            reason: shared
              ? 'This path is shared by more than one symbol instance.'
              : writable
                ? undefined
                : 'This path has no writable point array.',
            points,
          };
        })
        .filter((path): path is NonNullable<typeof path> => path != null)
        .filter((path, index, paths) => paths.findIndex((candidate) => candidate.nodeId === path.nodeId) === index),
    };
    if (node.cls === 'RVDimensionLine' && node.points.length >= 2) {
      const a = node.points[0]!;
      const b = node.points[1]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      info.dimension = {
        length,
        angleDegrees: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      };
    }
    return info;
  });

  handle(
    'edit:point-move',
    (_event, ownerId: number, pathNodeId: number, pointIndex: number, x: number, y: number) =>
      applyEdit((s) => {
        if (![ownerId, pathNodeId, pointIndex, x, y].every(Number.isFinite)) {
          return { ok: false, reason: 'the point coordinates are invalid' };
        }
        const node = s.index.byId.get(pathNodeId);
        if (!node) return { ok: false, reason: 'that path no longer exists' };
        if (s.index.shared.has(node)) {
          return { ok: false, reason: 'this path is shared by more than one symbol instance' };
        }
        if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= node.points.length) {
          return { ok: false, reason: 'that point no longer exists' };
        }

        const primitive = s.scene.primitives.find(
          (candidate) =>
            candidate.nodeId === pathNodeId &&
            (candidate.selectId === ownerId || candidate.nodeId === ownerId),
        );
        if (!primitive) return { ok: false, reason: 'that path does not belong to the selection' };

        const visibleFirst = node.cls === 'RVSegmentArc' && node.points.length >= 4
          ? node.points.length - 4
          : 0;
        const renderedIndex = pointIndex - visibleFirst;
        if (renderedIndex < 0 || renderedIndex * 2 + 1 >= primitive.pts.length) {
          return { ok: false, reason: 'that construction point is not directly editable' };
        }

        // Placed catalogue geometry is local to its RVShape. The flattened
        // scene is in plan coordinates, so recover the instance translation
        // from the current point instead of trusting coordinates from the UI.
        const current = node.points[pointIndex]!;
        const offsetX = primitive.pts[renderedIndex * 2]! - current.x;
        const offsetY = primitive.pts[renderedIndex * 2 + 1]! - current.y;
        const next = node.points.map((point) => ({ ...point }));
        next[pointIndex] = { x: x - offsetX, y: y - offsetY };
        return setPoints(s.loaded.document, node, next);
      }),
  );

  handle(
    'edit:point-kind',
    (_event, ownerId: number, pathNodeId: number, kind: EditableSegmentKind) =>
      applyEdit((s) => {
        if (![ownerId, pathNodeId].every(Number.isFinite) || (kind !== 'line' && kind !== 'curve')) {
          return { ok: false, reason: 'the path type request is invalid' };
        }
        const node = s.index.byId.get(pathNodeId);
        if (!node) return { ok: false, reason: 'that path no longer exists' };
        if (s.index.shared.has(node)) {
          return { ok: false, reason: 'this path is shared by more than one symbol instance' };
        }
        const belongsToSelection = s.scene.primitives.some(
          (candidate) =>
            candidate.nodeId === pathNodeId &&
            (candidate.selectId === ownerId || candidate.nodeId === ownerId),
        );
        if (!belongsToSelection) return { ok: false, reason: 'that path does not belong to the selection' };
        return convertSegmentKind(s.loaded.document, node, kind);
      }),
  );

  handle(
    'edit:dimension-props',
    (_event, nodeId: number, length: number, angleDegrees: number) =>
      applyEdit((s) => {
        const node = s.index.byId.get(nodeId);
        if (!node) return { ok: false, reason: 'that object is gone' };
        const oldA = node.points[0];
        const oldB = node.points[1];
        if (!oldA || !oldB) return { ok: false, reason: 'the dimension line has no writable geometry' };
        const oldMidX = (oldA.x + oldB.x) / 2;
        const oldMidY = (oldA.y + oldB.y) / 2;

        const geometry = setDimensionLengthAngle(s.loaded.document, node, length, angleDegrees);
        if (!geometry.ok) return geometry;

        const newA = node.points[0]!;
        const newB = node.points[1]!;
        const newMidX = (newA.x + newB.x) / 2;
        const newMidY = (newA.y + newB.y) / 2;
        const text = formatDistance(length, unitSystem());

        // Prefer the label that was beside the old midpoint — large length
        // changes move the new midpoint too far for a naive search.
        let best: (typeof node) | null = null;
        let bestDist = Infinity;
        for (const candidate of walk(s.loaded.document)) {
          if (candidate.cls !== 'RVLabel') continue;
          const cx = (candidate.bounds.left + candidate.bounds.right) / 2;
          const cy = (candidate.bounds.top + candidate.bounds.bottom) / 2;
          const dist = Math.hypot(cx - oldMidX, cy - oldMidY);
          if (dist < bestDist) {
            best = candidate;
            bestDist = dist;
          }
        }
        if (best && bestDist < 720) {
          renameNode(s.loaded.document, best, text);
          const cx = (best.bounds.left + best.bounds.right) / 2;
          const cy = (best.bounds.top + best.bounds.bottom) / 2;
          moveNode(s.loaded.document, best, newMidX - cx, newMidY - cy);
        }
        return { ok: true };
      }),
  );

  handle('edit:scale-to-dimension', async (_event, nodeId: number, knownLength: number) => {
    let scaleFactor = 1;
    const result = applyEdit((s) => {
      const node = s.index.byId.get(nodeId);
      if (!node || node.cls !== 'RVDimensionLine' || node.points.length < 2) {
        return { ok: false, reason: 'select a dimension line first' };
      }
      const a = node.points[0]!;
      const b = node.points[1]!;
      const measured = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(measured > 0)) return { ok: false, reason: 'that dimension has no length' };
      if (!(knownLength > 0)) return { ok: false, reason: 'enter the known real length' };
      scaleFactor = knownLength / measured;
      return scalePlanUniform(s.loaded.document, scaleFactor);
    });
    if (result.ok && Math.abs(scaleFactor - 1) > 1e-9 && session) {
      const background = scaleCompanionBackground(scaleFactor);
      if (background) {
        try {
          const { saveCompanion } = await import('./companion-store.js');
          const snap = companionSnapshot();
          if (snap) {
            await saveCompanion(session.path, session.savedArchiveBody(), snap);
            grantPath(companionPathFor(session.path));
          }
        } catch {
          /* companion write is best-effort; geometry already scaled */
        }
      }
    }
    return result;
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
    await atomicWriteFile(result.filePath, payload.svg, {
      backupPath: existsSync(result.filePath) ? `${result.filePath}.bak` : undefined,
    });
    return grantPath(result.filePath);
  });

  handle('schedule:build', async (): Promise<Schedule | null> => {
    if (!session) return null;
    const stable = await buildStableSchedule(session.loaded.document, session.path);
    return Object.assign(stable.schedule, { warnings: stable.warnings });
  });

  handle('schedule:set-field', async (_event, key: string, field: string, value: string) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    try {
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
    } catch (error) {
      planSidecarPending = true;
      schedulePlanRecovery(session);
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'the schedule could not be saved',
      };
    }
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
      {
        backupPath: existsSync(result.filePath) ? `${result.filePath}.bak` : undefined,
      },
    );
    return grantPath(result.filePath);
  });

  handle('plan:pull-sheet-export', async (_event, owned: Array<{ name: string; quantity: number }>) => {
    if (!session) return { ok: false, reason: 'no plan is open' };
    const { buildPullSheet } = await import('../format/report.js');
    const { lines } = planAllocation(session, Array.isArray(owned) ? owned : []);
    const csv = buildPullSheet(lines);
    const base = session.loaded.name.replace(/\.[^.]+$/, '');
    const result = await dialog.showSaveDialog({
      title: 'Export pull sheet',
      defaultPath: `${base} pull sheet.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    await atomicWriteFile(result.filePath, csv, {
      backupPath: existsSync(result.filePath) ? `${result.filePath}.bak` : undefined,
    });
    return { ok: true, path: grantPath(result.filePath) };
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
    const elevations = placementElevations(session);
    const result = toDxf(session.loaded.document, session.scene, { visible, elevations });
    await atomicWriteFile(chosen.filePath, result.text, {
      backupPath: existsSync(chosen.filePath) ? `${chosen.filePath}.bak` : undefined,
    });
    grantPath(chosen.filePath);

    // The schedule rides along unless asked not to; nobody wants to remember to
    // export it separately.
    const csvPath = chosen.filePath.replace(/\.dxf$/i, '') + ' schedule.csv';
    try {
      if (!includeSchedule) throw new Error('skipped by preference');
      const { schedule } = await buildStableSchedule(session.loaded.document, session.path);
      await atomicWriteFile(csvPath, scheduleToCsv(schedule), {
        backupPath: existsSync(csvPath) ? `${csvPath}.bak` : undefined,
      });
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
          {
            ...payload,
            // The legend comes from the drawing, not from the window: the main
            // process is the one holding the document, so it is the one that
            // can answer "what is on this sheet".
            legend: session ? planLegend(session) : undefined,
            printedOn: new Date().toLocaleDateString(),
          },
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

  /**
   * Agent / automation command bus.
   * `command:list` returns stable IDs; `command:run` forwards to the renderer
   * shell (same path as ⌘K) and waits for an ack.
   */
  handle('command:list', async () => COMMAND_LIST);

  handle('command:run', async (_event, id: string) => {
    if (!isCommandId(id)) return { ok: false, reason: `Unknown command: ${id}` };
    const win = mainWindow;
    if (!win || win.isDestroyed()) {
      return { ok: false, reason: 'No plan window' };
    }
    const requestId = randomUUID();
    return await new Promise<{ ok: boolean; id?: string; reason?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        ipcMain.removeListener('command:run-result', onResult);
        resolve({ ok: false, reason: 'Command timed out waiting for the UI' });
      }, 10_000);
      const onResult = (
        event: Electron.IpcMainEvent,
        payload: { requestId?: string; ok?: boolean; id?: string; reason?: string },
      ) => {
        if (event.sender !== win.webContents) return;
        if (!payload || payload.requestId !== requestId) return;
        clearTimeout(timeout);
        ipcMain.removeListener('command:run-result', onResult);
        resolve({
          ok: Boolean(payload.ok),
          id: payload.id,
          reason: payload.reason,
        });
      };
      ipcMain.on('command:run-result', onResult);
      win.webContents.send('command:run', { id, requestId });
    });
  });

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

  /** What the settings panel needs to show, or hide, the way back. */
  handle('app:revert-info', async () => {
    const record = await loadRollback(app.getPath('userData'));
    return canRevert(record, app.getVersion())
      ? { available: true, from: record!.from, to: record!.to, at: record!.at }
      : { available: false };
  });

  handle('app:revert-update', async () => {
    await runAppRevert();
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

  // First launch (or an empty unused library from an older build): fill the
  // private inventory from the bundled starter pack so the palette already has
  // placeable shapes. Libraries with any import history are left alone.
  const starter = await seedStarterInventory({
    inventoryFile,
    inventory,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (starter.seeded) {
    inventoryMessages.push(
      `Loaded ${starter.items} starter equipment items with shapes ready to place.`,
    );
  } else if (!starter.ok && inventory.items.length === 0) {
    inventoryMessages.push(starter.reason ?? 'The starter equipment pack could not be loaded.');
  }

  inventoryNotice = inventoryMessages.length ? inventoryMessages.join(' ') : undefined;
  // Inventories saved before categories existed get them filled in on load.
  const filledCategories = ensureCategories(inventory);
  if (
    filledCategories > 0 ||
    starter.seeded ||
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
  // A previously scheduled reminder is also re-armed here so it still fires if
  // the app was quit and reopened before the chosen time.
  setTimeout(() => {
    void (async () => {
      settings ??= await loadSettings(app.getPath('userData'));
      if (settings.app.checkOnLaunch) await runAppUpdate(false);
      else await armScheduledUpdateTimer();
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
