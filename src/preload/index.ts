import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type {
  OpenResult,
  DirectoryEntry,
  SelectionInfo,
  GearState,
  GearItemPatch,
  InventoryState,
  PlanFolderState,
  RecentFile,
} from '../main/index.js';
import type { ShowLinkState } from '../main/show-project.js';
import type { RecoveryEntry } from '../main/recovery.js';
import type {
  PlanModelView,
  ReportOptions as ReportOptionsView,
  SeatingPreview,
  SeatingRequestView,
} from '../main/plan-model.js';
import type { Allocation as AllocationLine } from '../format/allocation.js';
import type { AllocationSummary as AllocationSummaryView } from '../format/allocation.js';
import type { PlanBackground } from '../format/companion.js';
import type { NewRoomSpec } from '../format/new-room.js';

export interface EditReply {
  ok: boolean;
  reason?: string;
  text?: string;
  /** IDs created by duplicate/place/annotation operations. */
  created?: number[];
  doc?: OpenResult;
}

export interface LabelStylePatch {
  family?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeOut?: boolean;
  angleDegrees?: number;
}

export interface PlanClipboardReply extends EditReply {
  count?: number;
  sourceName?: string;
  sourcePath?: string;
}

export interface SaveReply {
  ok: boolean;
  reason?: string;
  warning?: string;
  conflict?: boolean;
  cancelled?: boolean;
  path?: string;
  doc?: OpenResult;
}

export interface PlanFolderReply {
  ok: boolean;
  reason?: string;
  cancelled?: boolean;
  id?: string;
  added?: number;
  removed?: boolean | number | { folders: number; memberships: number };
  changed?: number;
  state?: PlanFolderState;
}

/**
 * The renderer gets a narrow, explicitly enumerated surface — no `fs`, no
 * arbitrary IPC channel names — so a bug in the UI cannot reach the filesystem
 * beyond the operations listed here. Editing is expressed as intents ("move
 * object 42") rather than byte writes; the main process owns the file model.
 */
const api = {
  openFileDialog: (): Promise<OpenResult | null> => ipcRenderer.invoke('dialog:open-file'),
  /** Creates a plan, optionally autosaves to Documents/Groundplan, and opens it. */
  newPlan: (options: {
    name?: string;
    width?: number;
    depth?: number;
    /** Ceiling / clear height in logical units. */
    ceilingHeight?: number;
    room?: NewRoomSpec;
    /** Empty-sheet fit bounds for custom room tracing (no walls drawn). */
    sheetSize?: { width: number; depth: number };
    autoDimensions?: boolean;
    /** Skip the Save dialog and write under Documents/Groundplan. */
    autosave?: boolean;
    identity?: { date?: string; venue?: string; event?: string; contact?: string };
  }): Promise<{ ok: boolean; cancelled?: boolean; reason?: string; doc?: OpenResult }> =>
    ipcRenderer.invoke('file:new', options),
  /** Close and delete an empty new plan that never got a room outline. */
  discardEmptyPlan: (): Promise<{ ok: boolean; cancelled?: boolean; reason?: string }> =>
    ipcRenderer.invoke('file:discard-empty-plan'),
  roomPresets: (): Promise<Array<{ label: string; width: number; depth: number; ceilingFt?: number }>> =>
    ipcRenderer.invoke('plan:room-presets'),
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  openPath: (path: string): Promise<OpenResult | null> => ipcRenderer.invoke('file:open', path),
  closePlan: (): Promise<boolean> => ipcRenderer.invoke('file:close-plan'),
  listDirectory: (path: string): Promise<DirectoryEntry[]> => ipcRenderer.invoke('dir:list', path),
  recentFiles: (): Promise<RecentFile[]> => ipcRenderer.invoke('app:recent'),
  planFoldersList: (): Promise<PlanFolderState> => ipcRenderer.invoke('plan-folders:list'),
  planFolderCreate: (name: string, parentId: string | null): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:create', name, parentId),
  planFolderRename: (id: string, name: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:rename', id, name),
  planFolderUpdate: (
    id: string,
    patch: { name?: string; description?: string; color?: string; favorite?: boolean },
  ): Promise<PlanFolderReply> => ipcRenderer.invoke('plan-folders:update', id, patch),
  planFolderMove: (id: string, parentId: string | null): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:move', id, parentId),
  planFolderRemove: (id: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:remove', id),
  planFolderAddFiles: (folderId: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:add-files', folderId),
  planFolderAddCurrent: (folderId: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:add-current', folderId),
  planFolderRemovePlan: (folderId: string, path: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:remove-plan', folderId, path),
  planFolderTransferPlans: (
    sourceFolderId: string,
    targetFolderId: string,
    paths: string[],
    mode: 'copy' | 'move',
  ): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:transfer-plans', sourceFolderId, targetFolderId, paths, mode),
  planFolderUpdatePlan: (
    folderId: string,
    path: string,
    patch: { status?: 'active' | 'review' | 'approved' | 'archived'; starred?: boolean; note?: string },
  ): Promise<PlanFolderReply> => ipcRenderer.invoke('plan-folders:update-plan', folderId, path, patch),
  planFolderCleanupMissing: (folderId: string | null): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:cleanup-missing', folderId),
  exportSvg: (suggestedName: string, svg: string): Promise<string | null> =>
    ipcRenderer.invoke('export:svg', { suggestedName, svg }),
  scheduleBuild: (): Promise<unknown | null> => ipcRenderer.invoke('schedule:build'),
  scheduleSetField: (key: string, field: string, value: string): Promise<{ ok: boolean; reason?: string; schedule?: unknown }> =>
    ipcRenderer.invoke('schedule:set-field', key, field, value),
  scheduleKey: (name: string, x: number, y: number): Promise<string> =>
    ipcRenderer.invoke('schedule:key', name, x, y),
  scheduleExport: (summary: boolean): Promise<string | null> => ipcRenderer.invoke('schedule:export', summary),
  pullSheetExport: (
    owned: Array<{ name: string; quantity: number }>,
  ): Promise<{ ok: boolean; cancelled?: boolean; reason?: string; path?: string }> =>
    ipcRenderer.invoke('plan:pull-sheet-export', owned),
  exportDxf: (
    layers?: string[],
    includeSchedule?: boolean,
  ): Promise<{
    ok: boolean;
    cancelled?: boolean;
    reason?: string;
    path?: string;
    blocks?: number;
    inserts?: number;
    loose?: number;
  }> => ipcRenderer.invoke('export:dxf', layers, includeSchedule),
  printScales: (): Promise<Array<{ id: string; label: string }>> => ipcRenderer.invoke('print:scales'),
  printPdf: (payload: {
    svg: string;
    title: string;
    subtitle?: string;
    venue?: string;
    event?: string;
    contact?: string;
    roomWidth?: number;
    /** Floor-plan depth (Y extent), not ceiling. */
    roomHeight?: number;
    /** Clear / ceiling height when known. */
    ceilingHeight?: number;
    scale: string;
    paper: string;
    landscape: boolean;
    tilePages?: boolean;
    suggestedName: string;
  }): Promise<{
    ok: boolean;
    cancelled?: boolean;
    reason?: string;
    path?: string;
    /** False when a fixed scale makes the drawing larger than the sheet. */
    fits?: boolean;
    overBy?: number;
    pages?: number;
  }> => ipcRenderer.invoke('print:pdf', payload),
  checkAppUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:check-update'),
  /** Installs a release from a folder on a USB stick, signature checked. */
  updateFromUsb: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:update-from-usb'),
  settingsGet: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  settingsPatch: (patch: unknown): Promise<{ ok: boolean; settings?: unknown }> =>
    ipcRenderer.invoke('settings:patch', patch),
  revealInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  confirm: (options: {
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    danger?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke('app:confirm', options),
  setDocumentState: (state: { path?: string; name?: string; dirty?: boolean }): Promise<void> =>
    ipcRenderer.invoke('app:set-document-state', state),
  recoveryList: (): Promise<RecoveryEntry[]> => ipcRenderer.invoke('recovery:list'),
  recoveryOpen: (
    id: string,
  ): Promise<{ kind: 'plan'; doc: OpenResult } | { kind: 'gear'; gear: GearState } | null> =>
    ipcRenderer.invoke('recovery:open', id),
  recoveryDismiss: (id: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('recovery:dismiss', id),
  onRecoveryChanged: (fn: () => void): (() => void) => {
    const handler = () => fn();
    ipcRenderer.on('recovery:changed', handler);
    return () => ipcRenderer.removeListener('recovery:changed', handler);
  },
  /**
   * Main asks the renderer to put the unsaved-changes prompt on screen.
   *
   * This used to be `dialog.showMessageBox`, a native sheet. Two problems with
   * that: UI automation cannot click a native sheet at all (the main process
   * carried a test-only auto-discard branch to work around it), and on the
   * paths that open a file it could end up behind the window, where it silently
   * blocked everything — the app shipped a "look for a Save or Discard dialog
   * behind this window" message because of it. In-app, it is always visible,
   * always operable, and looks like the rest of the product.
   */
  onConfirmDiscard: (
    fn: (request: { id: string; work: string }) => void,
  ): (() => void) => {
    const handler = (_event: unknown, request: { id: string; work: string }) => fn(request);
    ipcRenderer.on('dialog:confirm-discard', handler);
    return () => ipcRenderer.removeListener('dialog:confirm-discard', handler);
  },
  /**
   * Sent once the prompt is actually painted. Main waits a few seconds for this
   * and only falls back to the native sheet if it never arrives — i.e. the
   * renderer is wedged or gone. Without an ack, main could only guess with a
   * timeout, and a user who took longer than the timeout to answer got the
   * in-app prompt AND a native sheet on top of it.
   */
  ackConfirmDiscard: (id: string): void => {
    ipcRenderer.send('dialog:confirm-discard-ack', id);
  },
  resolveConfirmDiscard: (id: string, choice: 'cancel' | 'save' | 'discard'): void => {
    ipcRenderer.send('dialog:confirm-discard-result', id, choice);
  },
  platform: process.platform,

  move: (nodeId: number, dx: number, dy: number): Promise<EditReply> =>
    ipcRenderer.invoke('edit:move', nodeId, dx, dy),
  remove: (nodeId: number): Promise<EditReply> => ipcRenderer.invoke('edit:delete', nodeId),
  duplicate: (nodeId: number, dx: number, dy: number): Promise<EditReply> =>
    ipcRenderer.invoke('edit:duplicate', nodeId, dx, dy),
  recolor: (nodeId: number, color: number): Promise<EditReply> =>
    ipcRenderer.invoke('edit:recolor', nodeId, color),
  relabel: (nodeId: number, text: string): Promise<EditReply> =>
    ipcRenderer.invoke('edit:relabel', nodeId, text),
  setTextStyle: (nodeId: number, patch: LabelStylePatch): Promise<EditReply> =>
    ipcRenderer.invoke('edit:text-style', nodeId, patch),
  batch: (
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
    a?: number,
    b?: number,
  ): Promise<EditReply> => ipcRenderer.invoke('edit:batch', kind, ids, a, b),
  repeatAcross: (
    nodeId: number,
    count: number,
    direction?: 'right' | 'left' | 'down' | 'up',
  ): Promise<EditReply> => ipcRenderer.invoke('edit:repeat-across', nodeId, count, direction ?? 'right'),
  arrayGrid: (
    nodeId: number,
    columns: number,
    rows: number,
    gapX?: number | null,
    gapY?: number | null,
  ): Promise<EditReply> => ipcRenderer.invoke('edit:array-grid', nodeId, columns, rows, gapX, gapY),
  setbackFromWall: (
    ids: number[],
    distance: number,
    options?: { mode?: 'each' | 'group'; faceWall?: boolean },
  ): Promise<EditReply> => ipcRenderer.invoke('edit:setback-from-wall', ids, distance, options ?? {}),
  arrange: (
    mode:
      | 'align-left'
      | 'align-center'
      | 'align-right'
      | 'align-top'
      | 'align-middle'
      | 'align-bottom'
      | 'distribute-horizontal'
      | 'distribute-vertical',
    ids: number[],
  ): Promise<EditReply> => ipcRenderer.invoke('edit:arrange', mode, ids),
  copyPlanObjects: (ids: number[]): Promise<PlanClipboardReply> =>
    ipcRenderer.invoke('edit:clipboard-copy', ids),
  planClipboardStatus: (): Promise<PlanClipboardReply> => ipcRenderer.invoke('edit:clipboard-status'),
  pastePlanObjects: (): Promise<EditReply> => ipcRenderer.invoke('edit:clipboard-paste'),
  groupPlanObjects: (ids: number[]): Promise<EditReply> => ipcRenderer.invoke('edit:group', ids),
  ungroupPlanObjects: (ids: number[]): Promise<EditReply> => ipcRenderer.invoke('edit:ungroup', ids),
  attachStack: (parentId: number, childId: number): Promise<EditReply> =>
    ipcRenderer.invoke('edit:attach-stack', parentId, childId),
  detachStack: (ids: number[]): Promise<EditReply> => ipcRenderer.invoke('edit:detach-stack', ids),
  undo: (): Promise<OpenResult | null> => ipcRenderer.invoke('edit:undo'),
  redo: (): Promise<OpenResult | null> => ipcRenderer.invoke('edit:redo'),
  selectionInfo: (nodeId: number): Promise<SelectionInfo | null> =>
    ipcRenderer.invoke('edit:selection', nodeId),
  movePoint: (
    ownerId: number,
    pathNodeId: number,
    pointIndex: number,
    x: number,
    y: number,
  ): Promise<EditReply> => ipcRenderer.invoke('edit:point-move', ownerId, pathNodeId, pointIndex, x, y),
  setPointPathKind: (
    ownerId: number,
    pathNodeId: number,
    kind: 'line' | 'curve',
  ): Promise<EditReply> => ipcRenderer.invoke('edit:point-kind', ownerId, pathNodeId, kind),
  save: (saveAs: boolean): Promise<SaveReply> => ipcRenderer.invoke('file:save', saveAs),

  placeGear: (description: string, x: number, y: number): Promise<EditReply & { method?: string }> =>
    ipcRenderer.invoke('plan:place-gear', description, x, y),
  rotate: (nodeId: number, degrees: number): Promise<EditReply> =>
    ipcRenderer.invoke('plan:rotate', nodeId, degrees),
  resize: (nodeId: number, width: number, height: number): Promise<EditReply> =>
    ipcRenderer.invoke('plan:resize', nodeId, width, height),
  addLabel: (text: string, x: number, y: number, color?: number): Promise<EditReply> =>
    ipcRenderer.invoke('plan:add-label', text, x, y, color),
  addDimension: (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    startNodeId?: number,
    endNodeId?: number,
  ): Promise<EditReply & { text?: string }> =>
    ipcRenderer.invoke(
      'plan:add-dimension',
      x1,
      y1,
      x2,
      y2,
      startNodeId,
      endNodeId,
    ),
  setDimensionProps: (
    nodeId: number,
    length: number,
    angleDegrees: number,
  ): Promise<EditReply> => ipcRenderer.invoke('edit:dimension-props', nodeId, length, angleDegrees),
  scaleToDimension: (nodeId: number, knownLength: number): Promise<EditReply> =>
    ipcRenderer.invoke('edit:scale-to-dimension', nodeId, knownLength),
  addSeating: (request: unknown): Promise<EditReply & { placed?: number }> =>
    ipcRenderer.invoke('plan:add-seating', request),
  previewGear: (description: string): Promise<{ width: number; height: number; source: string }> =>
    ipcRenderer.invoke('plan:preview-gear', description),

  /**
   * The plan model: the room, what it seats, what is built on it.
   *
   * `planModel` and the two preview calls are reads and change nothing, so the
   * panel can call them freely as values are typed. Everything else is an edit
   * and comes back as an `EditReply` with a refreshed document.
   */
  planModel: (): Promise<PlanModelView | null> => ipcRenderer.invoke('plan:model'),
  backgroundSet: (
    background: PlanBackground | null,
  ): Promise<{ ok: boolean; reason?: string; background?: PlanBackground | null }> =>
    ipcRenderer.invoke('plan:background-set', background),
  roomCreate: (width: number, height: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-create', width, height),
  roomCreateCircle: (diameter: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-create-circle', diameter),
  roomCreateFromSpec: (room: NewRoomSpec): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-create-from-spec', room),
  roomCreatePolygon: (points: Array<{ x: number; y: number }>): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-create-polygon', points),
  roomCornerMove: (index: number, x: number, y: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-corner-move', index, x, y),
  roomCornerAdd: (wallIndex: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-corner-add', wallIndex),
  roomCornerRemove: (index: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-corner-remove', index),
  roomCornerRound: (index: number, radius: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-corner-round', index, radius),
  roomCornersRoundAll: (radius: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-corners-round-all', radius),
  roomReshape: (
    op: 'union' | 'difference',
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-reshape', op, x, y, width, height),
  roomCurve: (
    wallIndex: number,
    value: number,
    options?: boolean | { major?: boolean; method?: 'radius' | 'sagitta' | 'angle' | 'arc-length'; outward?: boolean },
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-curve', wallIndex, value, options),
  roomCurveThrough: (
    wallIndex: number,
    through: { x: number; y: number },
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-curve-through', wallIndex, through),
  roomWallLength: (wallIndex: number, length: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-wall-length', wallIndex, length),
  roomWallOffset: (wallIndex: number, distance: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-wall-offset', wallIndex, distance),
  roomDimension: (): Promise<EditReply & { note?: string }> => ipcRenderer.invoke('plan:room-dimension'),
  roomMeta: (patch: {
    name?: string;
    ceilingHeight?: number;
  }): Promise<{ ok: boolean; reason?: string; note?: string }> => ipcRenderer.invoke('plan:room-meta', patch),
  identitySet: (
    patch: { date?: string; venue?: string; event?: string; contact?: string },
  ): Promise<EditReply & { text?: string }> => ipcRenderer.invoke('plan:identity-set', patch),
  avSummary: (): Promise<{
    screens: number;
    seatsGraded: number;
    clear: number;
    blocked: number;
    tooFar: number;
    tooClose: number;
    offAxis: number;
    notes: string[];
    recommendWidthText: string;
  } | null> => ipcRenderer.invoke('plan:av-summary'),

  seatingPreview: (request: SeatingRequestView): Promise<SeatingPreview | null> =>
    ipcRenderer.invoke('plan:seating-preview', request),
  seatingApply: (
    request: SeatingRequestView,
    chair: string,
    table?: string,
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:seating-apply', request, chair, table),

  listLayoutKits: (): Promise<
    Array<{
      id: string;
      name: string;
      source: 'bundled' | 'user';
      chairs: number;
      banks: number;
      gear: number;
      event?: string;
      venue?: string;
    }>
  > => ipcRenderer.invoke('plan:list-layout-kits'),
  loadLayoutKit: (
    kitId: string,
  ): Promise<{ ok: boolean; reason?: string; recipe?: unknown }> =>
    ipcRenderer.invoke('plan:load-layout-kit', kitId),
  applyLayoutRecipe: (
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
  ): Promise<EditReply & { placed?: number }> =>
    ipcRenderer.invoke('plan:apply-layout-recipe', recipeOrKitId, options),
  saveLayoutKit: (
    recipe: unknown,
    fileName?: string,
  ): Promise<{ ok: boolean; reason?: string; path?: string; id?: string }> =>
    ipcRenderer.invoke('plan:save-layout-kit', recipe, fileName),
  saveOpenPlanAsKit: (
    fileName?: string,
  ): Promise<{ ok: boolean; reason?: string; path?: string; id?: string }> =>
    ipcRenderer.invoke('plan:save-open-as-kit', fileName),
  clearFurniture: (
    kind?: 'seating' | 'gear' | 'all',
  ): Promise<EditReply & { placed?: number }> =>
    ipcRenderer.invoke('plan:clear-furniture', kind ?? 'seating'),
  duplicatePlanPath: (
    path: string,
  ): Promise<{ ok: boolean; reason?: string; doc?: unknown; path?: string }> =>
    ipcRenderer.invoke('file:duplicate-path', path),
  importLayoutKit: (): Promise<{
    ok: boolean;
    cancelled?: boolean;
    reason?: string;
    path?: string;
    id?: string;
  }> => ipcRenderer.invoke('plan:import-layout-kit'),
  exportLayoutRecipe: (): Promise<{
    ok: boolean;
    cancelled?: boolean;
    reason?: string;
    path?: string;
    kitId?: string;
    recipe?: unknown;
  }> => ipcRenderer.invoke('plan:export-layout-recipe'),
  listBankPresets: (): Promise<
    Array<{
      id: string;
      name: string;
      savedAt: string;
      block: Record<string, unknown>;
    }>
  > => ipcRenderer.invoke('plan:list-bank-presets'),
  saveBankPreset: (preset: {
    name: string;
    block: unknown;
    id?: string;
  }): Promise<{ ok: boolean; reason?: string; preset?: unknown }> =>
    ipcRenderer.invoke('plan:save-bank-preset', preset),
  deleteBankPreset: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('plan:delete-bank-preset', id),

  stageAdd: (
    x: number,
    y: number,
    width: number,
    depth: number,
    height: number,
    back?: { depth: number; height: number },
    stairs?: Array<'front' | 'back' | 'left' | 'right'>,
  ): Promise<
    EditReply & {
      note?: string;
      buildList?: Array<{ item: string; quantity: number; detail?: string }>;
      warnings?: string[];
    }
  > => ipcRenderer.invoke('plan:stage-add', x, y, width, depth, height, back, stairs),
  stageClear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('plan:stage-clear'),

  /** Draws a line, rectangle or ellipse between two plan points. */
  draw: (
    tool: 'line' | 'rect' | 'ellipse',
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<EditReply> => ipcRenderer.invoke('plan:draw', tool, x1, y1, x2, y2),

  placeCablePath: (
    name: string,
    points: Array<{ x: number; y: number }>,
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:add-cable-path', name, points),

  placeAvPair: (x: number, y: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:place-av-pair', x, y),

  setElevation: (
    key: string,
    elevation: number | null,
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:set-elevation', key, elevation),

  selectionElevation: (
    nodeId: number,
  ): Promise<{ key: string; elevation: number; inferred: boolean } | null> =>
    ipcRenderer.invoke('plan:selection-elevation', nodeId),

  selectionElevations: (
    ids: number[],
  ): Promise<Array<{ id: number; key: string; elevation: number; inferred: boolean }>> =>
    ipcRenderer.invoke('plan:selection-elevations', ids),

  linkedSet: (
    ids: number[],
  ): Promise<Array<{ id: number; name: string; elevation: number; kind: string }>> =>
    ipcRenderer.invoke('plan:linked-set', ids),

  sightlineMarkers: (): Promise<
    Array<{ x: number; y: number; verdict: string }>
  > => ipcRenderer.invoke('plan:sightline-markers'),

  allocation: (
    owned: Array<{ name: string; quantity: number }>,
  ): Promise<{ lines: AllocationLine[]; summary: AllocationSummaryView } | null> =>
    ipcRenderer.invoke('plan:allocation', owned),

  reportExport: (
    options: ReportOptionsView,
  ): Promise<{ ok: boolean; cancelled?: boolean; reason?: string; path?: string }> =>
    ipcRenderer.invoke('plan:report-export', options),

  inventoryList: (
    query: string,
    department: string | null,
    category?: string | null,
  ): Promise<InventoryState> =>
    ipcRenderer.invoke('inventory:list', query, department, category ?? null),
  inventoryGetPhoto: (id: string): Promise<{ ok: boolean; reason?: string; photoDataUrl?: string | null }> =>
    ipcRenderer.invoke('inventory:get-photo', id),
  inventoryMapSymbols: (): Promise<{
    ok: boolean;
    reason?: string;
    mapped: number;
    alreadyHad: number;
    noSymbol: number;
    notDrawn: number;
    examples: Array<{ item: string; symbol: string; reason: string }>;
  }> => ipcRenderer.invoke('inventory:map-symbols'),
  inventoryImport: (): Promise<{
    ok: boolean;
    reason?: string;
    added: number;
    updated: number;
    files: number;
    inventoryName?: string;
    inventoryNames?: string[];
  } | null> => ipcRenderer.invoke('inventory:import'),
  inventoryAbsorbGear: (): Promise<{
    ok: boolean;
    reason?: string;
    added?: number;
    updated?: number;
  }> => ipcRenderer.invoke('inventory:absorb-gear'),
  inventoryExportPack: (): Promise<{
    ok: boolean;
    reason?: string;
    cancelled?: boolean;
    path?: string;
    items?: number;
    assets?: number;
  }> => ipcRenderer.invoke('inventory:export-pack'),
  inventoryImportPack: (): Promise<{
    ok: boolean;
    reason?: string;
    cancelled?: boolean;
    added?: number;
    updated?: number;
    assets?: number;
    items?: number;
  }> => ipcRenderer.invoke('inventory:import-pack'),
  inventoryAdd: (
    name: string,
    department?: string,
  ): Promise<{ ok: boolean; reason?: string; id?: string }> =>
    ipcRenderer.invoke('inventory:add', name, department),
  inventoryUpdate: (
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
  ): Promise<{ ok: boolean; reason?: string; changed?: boolean; id?: string }> =>
    ipcRenderer.invoke('inventory:update', id, patch),
  inventoryDuplicate: (
    id: string,
    name?: string,
  ): Promise<{ ok: boolean; reason?: string; id?: string }> =>
    ipcRenderer.invoke('inventory:duplicate', id, name),
  inventoryThumbnails: (
    ids: string[],
  ): Promise<Record<string, { paths: string[]; closed: boolean[]; width: number; height: number } | null>> =>
    ipcRenderer.invoke('inventory:thumbnails', ids),
  inventoryAddTraced: (payload: {
    name: string;
    width: number;
    height: number;
    paths: Array<{ points: number[]; closed: boolean }>;
    category?: string;
    notes?: string;
    department?: string;
  }): Promise<{ ok: boolean; reason?: string; id?: string }> =>
    ipcRenderer.invoke('inventory:add-traced', payload),
  inventoryRemove: (id: string): Promise<{
    ok: boolean;
    reason?: string;
    undoAvailable?: boolean;
  }> => ipcRenderer.invoke('inventory:remove', id),
  inventoryRestoreLast: (): Promise<{
    ok: boolean;
    reason?: string;
    restoredId?: string;
  }> => ipcRenderer.invoke('inventory:restore-last'),
  inventoryHarvest: (): Promise<{
    ok: boolean;
    reason?: string;
    added: number;
    updated: number;
    scanned: number;
    processed?: number;
    failed: number;
    cancelled?: boolean;
    plans: number;
    inventory: unknown;
  } | null> => ipcRenderer.invoke('inventory:harvest'),
  cancelInventoryHarvest: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('inventory:cancel-harvest'),
  onHarvestProgress: (
    fn: (p: {
      scanned: number;
      processed?: number;
      total: number;
      added: number;
      failed?: number;
      cancelled?: boolean;
    }) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      payload: {
        scanned: number;
        processed?: number;
        total: number;
        added: number;
        failed?: number;
        cancelled?: boolean;
      },
    ) => fn(payload);
    ipcRenderer.on('inventory:harvest-progress', handler);
    return () => ipcRenderer.removeListener('inventory:harvest-progress', handler);
  },

  inventoryPlace: (id: string, x: number, y: number): Promise<EditReply> =>
    ipcRenderer.invoke('inventory:place', id, x, y),

  gearImport: (): Promise<GearState | null> => ipcRenderer.invoke('gear:import'),
  gearOpen: (): Promise<GearState | null> => ipcRenderer.invoke('gear:open'),
  gearNew: (): Promise<GearState | null> => ipcRenderer.invoke('gear:new'),
  gearImportPath: (path: string): Promise<GearState | null> => ipcRenderer.invoke('gear:import-path', path),
  gearOpenPath: (path: string): Promise<GearState | null> => ipcRenderer.invoke('gear:open-path', path),
  gearSave: (saveAs: boolean): Promise<{ ok: boolean; reason?: string; cancelled?: boolean; path?: string; gear?: GearState }> =>
    ipcRenderer.invoke('gear:save', saveAs),
  showGet: (): Promise<ShowLinkState> => ipcRenderer.invoke('show:get'),
  showLinkCurrent: (
    listIndex: number,
  ): Promise<{ ok: boolean; reason?: string; show?: ShowLinkState }> =>
    ipcRenderer.invoke('show:link-current', listIndex),
  gearReconcile: (listIndex: number): Promise<unknown | null> => ipcRenderer.invoke('gear:reconcile', listIndex),
  gearExportCsv: (listIndex: number): Promise<string | null> => ipcRenderer.invoke('gear:export-csv', listIndex),
  gearUpdate: (
    listIndex: number,
    itemId: string,
    patch: GearItemPatch,
  ): Promise<{ ok: boolean; reason?: string; gear?: GearState; changed?: boolean; undoAvailable?: boolean }> =>
    ipcRenderer.invoke('gear:update', listIndex, itemId, patch),
  gearRestoreLast: (): Promise<{
    ok: boolean;
    reason?: string;
    gear?: GearState;
    restoredId?: string;
  }> => ipcRenderer.invoke('gear:restore-last'),
  gearAdd: (
    listIndex: number,
    departmentId: string,
    parentId: string | null,
    description: string,
    quantity?: number,
  ): Promise<{ ok: boolean; reason?: string; gear?: GearState; createdId?: string }> =>
    ipcRenderer.invoke('gear:add', listIndex, departmentId, parentId, description, quantity ?? 1),
  gearDuplicate: (
    listIndex: number,
    itemId: string,
  ): Promise<{ ok: boolean; reason?: string; gear?: GearState; createdId?: string }> =>
    ipcRenderer.invoke('gear:duplicate', listIndex, itemId),
  gearAddDepartment: (
    listIndex: number,
    name: string,
  ): Promise<{ ok: boolean; reason?: string; gear?: GearState; createdId?: string }> =>
    ipcRenderer.invoke('gear:add-department', listIndex, name),

  onMenu: (handler: (command: string, arg?: string) => void): (() => void) => {
    const channels = [
      'menu:new',
      'menu:open',
      'menu:open-folder',
      'menu:fit',
      'menu:export-svg',
      'menu:export-dxf',
      'menu:select-all',
      'menu:settings',
      'menu:open-path',
      'menu:save',
      'menu:save-as',
      'menu:print',
      'menu:undo',
      'menu:redo',
      'menu:insert',
      'menu:insert-leaf',
      'menu:shape-wizard',
      'menu:build-stage',
      'menu:edit-walls',
      'menu:group',
      'menu:ungroup',
      'menu:palette',
      'menu:shortcuts',
      'menu:mode-browse',
      'menu:mode-place',
      'menu:mode-inspect',
      'menu:mode-setup',
      'menu:mode-draw',
    ];
    const listeners = channels.map((channel) => {
      const listener = (_event: IpcRendererEvent, arg?: string) => handler(channel, arg);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => listeners.forEach((off) => off());
  },

  /** Stable command catalog for agents and automation. */
  commandsList: (): Promise<
    Array<{ id: string; title: string; section: string; shortcut?: string }>
  > => ipcRenderer.invoke('command:list'),

  /** Run a structured command ID (same path as ⌘K). */
  commandsRun: (
    id: string,
  ): Promise<{ ok: boolean; id?: string; reason?: string }> =>
    ipcRenderer.invoke('command:run', id),

  /** Renderer listens for main-forwarded command invocations. */
  onCommandRun: (
    handler: (payload: { id: string; requestId: string }) => void,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { id?: string; requestId?: string },
    ) => {
      if (!payload?.id || !payload?.requestId) return;
      handler({ id: payload.id, requestId: payload.requestId });
    };
    ipcRenderer.on('command:run', listener);
    return () => ipcRenderer.removeListener('command:run', listener);
  },

  replyCommandRun: (result: {
    requestId: string;
    ok: boolean;
    id?: string;
    reason?: string;
  }): void => {
    ipcRenderer.send('command:run-result', result);
  },
};

contextBridge.exposeInMainWorld('groundplan', api);

export type GroundplanApi = typeof api;
