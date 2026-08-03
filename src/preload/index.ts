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

export interface EditReply {
  ok: boolean;
  reason?: string;
  /** IDs created by duplicate/place/annotation operations. */
  created?: number[];
  doc?: OpenResult;
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
  removed?: boolean | { folders: number; memberships: number };
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
  /** Creates a plan, asks where to put it, and opens it. */
  newPlan: (options: {
    name?: string;
    width?: number;
    depth?: number;
  }): Promise<{ ok: boolean; cancelled?: boolean; reason?: string; doc?: OpenResult }> =>
    ipcRenderer.invoke('file:new', options),
  roomPresets: (): Promise<Array<{ label: string; width: number; depth: number }>> =>
    ipcRenderer.invoke('plan:room-presets'),
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  openPath: (path: string): Promise<OpenResult | null> => ipcRenderer.invoke('file:open', path),
  listDirectory: (path: string): Promise<DirectoryEntry[]> => ipcRenderer.invoke('dir:list', path),
  recentFiles: (): Promise<RecentFile[]> => ipcRenderer.invoke('app:recent'),
  planFoldersList: (): Promise<PlanFolderState> => ipcRenderer.invoke('plan-folders:list'),
  planFolderCreate: (name: string, parentId: string | null): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:create', name, parentId),
  planFolderRename: (id: string, name: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:rename', id, name),
  planFolderRemove: (id: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:remove', id),
  planFolderAddFiles: (folderId: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:add-files', folderId),
  planFolderAddCurrent: (folderId: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:add-current', folderId),
  planFolderRemovePlan: (folderId: string, path: string): Promise<PlanFolderReply> =>
    ipcRenderer.invoke('plan-folders:remove-plan', folderId, path),
  exportSvg: (suggestedName: string, svg: string): Promise<string | null> =>
    ipcRenderer.invoke('export:svg', { suggestedName, svg }),
  scheduleBuild: (): Promise<unknown | null> => ipcRenderer.invoke('schedule:build'),
  scheduleSetField: (key: string, field: string, value: string): Promise<{ ok: boolean; reason?: string; schedule?: unknown }> =>
    ipcRenderer.invoke('schedule:set-field', key, field, value),
  scheduleKey: (name: string, x: number, y: number): Promise<string> =>
    ipcRenderer.invoke('schedule:key', name, x, y),
  scheduleExport: (summary: boolean): Promise<string | null> => ipcRenderer.invoke('schedule:export', summary),
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
    roomWidth?: number;
    roomHeight?: number;
    scale: string;
    paper: string;
    landscape: boolean;
    suggestedName: string;
  }): Promise<{
    ok: boolean;
    cancelled?: boolean;
    reason?: string;
    path?: string;
    /** False when a fixed scale makes the drawing larger than the sheet. */
    fits?: boolean;
    overBy?: number;
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
  batch: (
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
    a?: number,
    b?: number,
  ): Promise<EditReply> => ipcRenderer.invoke('edit:batch', kind, ids, a, b),
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
  undo: (): Promise<OpenResult | null> => ipcRenderer.invoke('edit:undo'),
  redo: (): Promise<OpenResult | null> => ipcRenderer.invoke('edit:redo'),
  selectionInfo: (nodeId: number): Promise<SelectionInfo | null> =>
    ipcRenderer.invoke('edit:selection', nodeId),
  save: (saveAs: boolean): Promise<SaveReply> => ipcRenderer.invoke('file:save', saveAs),

  placeGear: (description: string, x: number, y: number): Promise<EditReply & { method?: string }> =>
    ipcRenderer.invoke('plan:place-gear', description, x, y),
  rotate: (nodeId: number, degrees: number): Promise<EditReply> =>
    ipcRenderer.invoke('plan:rotate', nodeId, degrees),
  resize: (nodeId: number, width: number, height: number): Promise<EditReply> =>
    ipcRenderer.invoke('plan:resize', nodeId, width, height),
  addLabel: (text: string, x: number, y: number): Promise<EditReply> =>
    ipcRenderer.invoke('plan:add-label', text, x, y),
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
  roomCreate: (width: number, height: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-create', width, height),
  roomReshape: (
    op: 'union' | 'difference',
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-reshape', op, x, y, width, height),
  roomCurve: (wallIndex: number, radius: number): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:room-curve', wallIndex, radius),
  roomDimension: (): Promise<EditReply & { note?: string }> => ipcRenderer.invoke('plan:room-dimension'),
  drapePerimeter: (): Promise<EditReply & { note?: string }> => ipcRenderer.invoke('plan:drape-perimeter'),

  seatingPreview: (request: SeatingRequestView): Promise<SeatingPreview | null> =>
    ipcRenderer.invoke('plan:seating-preview', request),
  seatingApply: (
    request: SeatingRequestView,
    chair: string,
    table?: string,
  ): Promise<EditReply & { note?: string }> =>
    ipcRenderer.invoke('plan:seating-apply', request, chair, table),

  stageAdd: (
    x: number,
    y: number,
    width: number,
    depth: number,
    height: number,
  ): Promise<
    EditReply & {
      note?: string;
      buildList?: Array<{ item: string; quantity: number; detail?: string }>;
      warnings?: string[];
    }
  > => ipcRenderer.invoke('plan:stage-add', x, y, width, depth, height),
  stageClear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('plan:stage-clear'),

  /** Draws a line, rectangle or ellipse between two plan points. */
  draw: (
    tool: 'line' | 'rect' | 'ellipse',
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<EditReply> => ipcRenderer.invoke('plan:draw', tool, x1, y1, x2, y2),

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
  inventoryMapSymbols: (): Promise<{
    ok: boolean;
    reason?: string;
    mapped: number;
    alreadyHad: number;
    noSymbol: number;
    notDrawn: number;
    examples: Array<{ item: string; symbol: string; reason: string }>;
    inventory: InventoryState;
  }> => ipcRenderer.invoke('inventory:map-symbols'),
  inventoryImport: (): Promise<{ ok: boolean; reason?: string; added: number; updated: number; files: number; inventory: InventoryState } | null> =>
    ipcRenderer.invoke('inventory:import'),
  inventoryAbsorbGear: (): Promise<{ ok: boolean; reason?: string; added?: number; updated?: number; inventory?: InventoryState }> =>
    ipcRenderer.invoke('inventory:absorb-gear'),
  inventoryAdd: (name: string, department?: string): Promise<{ ok: boolean; reason?: string; inventory?: InventoryState }> =>
    ipcRenderer.invoke('inventory:add', name, department),
  inventoryUpdate: (
    id: string,
    patch: { name?: string; department?: string; width?: number; height?: number; notes?: string },
  ): Promise<{ ok: boolean; reason?: string; changed?: boolean; inventory?: InventoryState }> =>
    ipcRenderer.invoke('inventory:update', id, patch),
  inventoryDuplicate: (
    id: string,
    name?: string,
  ): Promise<{ ok: boolean; reason?: string; id?: string; inventory?: InventoryState }> =>
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
  }): Promise<{ ok: boolean; reason?: string; id?: string; inventory?: InventoryState }> =>
    ipcRenderer.invoke('inventory:add-traced', payload),
  inventoryRemove: (id: string): Promise<{
    ok: boolean;
    reason?: string;
    undoAvailable?: boolean;
    inventory?: InventoryState;
  }> =>
    ipcRenderer.invoke('inventory:remove', id),
  inventoryRestoreLast: (): Promise<{
    ok: boolean;
    reason?: string;
    restoredId?: string;
    inventory?: InventoryState;
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
  gearPlaceAll: (listIndex: number): Promise<EditReply & { note?: string; placed?: number }> =>
    ipcRenderer.invoke('gear:place-all', listIndex),
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
  ): Promise<{ ok: boolean; reason?: string; gear?: GearState; createdId?: string }> =>
    ipcRenderer.invoke('gear:add', listIndex, departmentId, parentId, description),

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
    ];
    const listeners = channels.map((channel) => {
      const listener = (_event: IpcRendererEvent, arg?: string) => handler(channel, arg);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => listeners.forEach((off) => off());
  },
};

contextBridge.exposeInMainWorld('groundplan', api);

export type GroundplanApi = typeof api;
