import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { formatLength, parseLength } from '../../format/units.js';
import { PlanCanvas } from './PlanCanvas.js';
import { GearView, GearSummary } from './GearView.js';
import { InventoryView, type InventoryState } from './InventoryView.js';
import { InventoryPalette } from './InventoryPalette.js';
import { SettingsDialog } from './SettingsDialog.js';
import { toSvg } from './svg.js';
import {
  IconDuplicate,
  IconEdit,
  IconExport,
  IconFile,
  IconFit,
  IconFolder,
  IconLock,
  IconPlus,
  IconMoon,
  IconRedo,
  IconRuler,
  IconMagnet,
  IconPrint,
  IconSave,
  IconSearch,
  IconSidebarLeft,
  IconSidebarRight,
  IconSun,
  IconTrash,
  IconUndo,
  IconWarning,
  Mark,
  IconDrawLine,
  IconDrawRect,
  IconDrawEllipse,
  IconPointer,
  IconText,
  IconRotateLeft,
  IconRotateRight,
  IconBringFront,
  IconSendBack,
} from './icons.js';
import type { Layer, Scene } from '../../format/scene.js';
import { selectableIds } from './selection.js';
import RoomPanel from './RoomPanel.js';
import NewPlanDialog from './NewPlanDialog.js';
import type { GearList, GearTotals } from '../../gear/model.js';
import type { GroundplanApi } from '../../preload/index.js';

declare global {
  interface Window {
    groundplan: GroundplanApi;
  }
}

const api = window.groundplan;

const LAYERS: Array<{ id: Layer; label: string; tint: string }> = [
  { id: 'walls', label: 'Walls & structure', tint: '#c9d1dc' },
  { id: 'furniture', label: 'Tables & equipment', tint: '#7fb3ff' },
  { id: 'region', label: 'Regions', tint: '#8fd6a8' },
  { id: 'annotation', label: 'Dimensions & labels', tint: '#e6c06a' },
  { id: 'other', label: 'Other geometry', tint: '#a99ad6' },
];

export interface Doc {
  path: string;
  name: string;
  container: string;
  repaired: boolean;
  byteLength: number;
  warnings: number;
  warningSamples: string[];
  scene: Scene;
  editable: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  revision: number;
  /** True until a crash-journal version is deliberately saved. */
  recovered: boolean;
  /** Persistent warning when an association sidecar could not be applied safely. */
  dimensionWarning?: string;
  annotationCapabilities: {
    label: boolean;
    dimension: boolean;
    dimensionLine: boolean;
  };
}

interface Selection {
  nodeId: number;
  cls: string;
  name?: string;
  text?: string;
  color?: number;
  canDelete: boolean;
  canRelabel: boolean;
  widthUnits: number;
  heightUnits: number;
  x: number;
  y: number;
}

interface FileEntry {
  path: string;
  name: string;
  extension: string;
  size: number;
}

type ArrangeMode = Parameters<GroundplanApi['arrange']>[0];
type RecentFile = Awaited<ReturnType<GroundplanApi['recentFiles']>>[number];
type RecoveryEntry = Awaited<ReturnType<GroundplanApi['recoveryList']>>[number];
type PlanFolderState = Awaited<ReturnType<GroundplanApi['planFoldersList']>>;
type Workspace = 'plan' | 'gear' | 'inventory';
type PlanRailSource = 'recent' | 'collections' | 'folder' | 'equipment';
type InspectorTab = 'properties' | 'room' | 'create' | 'layers';

/** One foot in logical units — the arrow-key nudge and duplicate offset. */
const FOOT = 120;

function formatFeet(units: number): string {
  return `${(units / FOOT).toFixed(1)}′`;
}

/** Feet and inches, the unit these plans are dimensioned in. */
function formatFeetInches(units: number): string {
  const totalInches = units / 10;
  const sign = totalInches < 0 ? '−' : '';
  const abs = Math.abs(totalInches);
  const feet = Math.floor(abs / 12);
  const inches = Math.round(abs - feet * 12);
  return inches === 12 ? `${sign}${feet + 1}′ 0″` : `${sign}${feet}′ ${inches}″`;
}

function formatBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function formatRecentTime(timestamp: number): string {
  if (!timestamp) return 'Previously opened';
  const then = new Date(timestamp);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((startToday - startThen) / 86_400_000);
  if (days === 0) {
    return `Today, ${then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return then.toLocaleDateString([], { weekday: 'long' });
  return then.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Legacy COLORREF stores bytes as BGR; CSS colours are written as RGB. */
function colorRefToHex(color: number): string {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

function hexToColorRef(hex: string): number | null {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return r | (g << 8) | (b << 16);
}

export function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  /** How lengths are shown and typed. Mirrors the drawing setting. */
  const [unitSystem, setUnitSystem] = useState<'imperial' | 'metric'>('imperial');
  const [folder, setFolder] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [planFolders, setPlanFolders] = useState<PlanFolderState | null>(null);
  const [selectedPlanFolderId, setSelectedPlanFolderId] = useState<string | null>(null);
  const [planFolderEditor, setPlanFolderEditor] = useState<
    { kind: 'create' | 'rename'; folderId?: string } | null
  >(null);
  const [planFolderDraft, setPlanFolderDraft] = useState('');
  const [recoveries, setRecoveries] = useState<RecoveryEntry[]>([]);
  const [visible, setVisible] = useState<Set<Layer>>(new Set(LAYERS.map((l) => l.id)));
  const [paper, setPaper] = useState(true);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('groundplan:rail-open') !== 'false');
  const [inspectorOpen, setInspectorOpen] = useState(
    () => localStorage.getItem('groundplan:inspector-open') !== 'false',
  );
  const [fitToken, setFitToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** The details panel describes one object; with a group, that is the first. */
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [sizeDraft, setSizeDraft] = useState({ width: '', height: '' });
  const [positionDraft, setPositionDraft] = useState({ x: '', y: '' });
  const [showGrid, setShowGrid] = useState(true);
  const [bulkDeleteWarning, setBulkDeleteWarning] = useState(25);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [rotationDraft, setRotationDraft] = useState('15');
  const [colorDraft, setColorDraft] = useState('#20252b');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(0.05);
  const [view, setView] = useState<Workspace>('plan');
  const [planRailSource, setPlanRailSource] = useState<PlanRailSource>('recent');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('properties');
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const [libQuery, setLibQuery] = useState('');
  const [invQuery, setInvQuery] = useState('');
  /** Two clicked points make a measurement; the first is held here. */
  const [measureFrom, setMeasureFrom] = useState<{ x: number; y: number; nodeId?: number } | null>(null);
  const [measurement, setMeasurement] = useState<{
    from: { x: number; y: number; nodeId?: number };
    to: { x: number; y: number; nodeId?: number };
  } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [dimensioning, setDimensioning] = useState(false);
  /**
   * The draw tool in hand, or null for the pointer.
   *
   * Picking the two corners is the same interaction as a dimension, so it runs
   * through the same handler; only what gets created at the end differs.
   */
  const [drawTool, setDrawTool] = useState<'line' | 'rect' | 'ellipse' | null>(null);
  const [drawFrom, setDrawFrom] = useState<{ x: number; y: number } | null>(null);
  const [dimensionFrom, setDimensionFrom] = useState<{
    x: number;
    y: number;
    nodeId?: number;
  } | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState('');
  const annotationInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Snap step in logical units; 0 is off. Object alignment always applies. */
  const [snapStep, setSnapStep] = useState(FOOT);
  const [printOpen, setPrintOpen] = useState(false);
  const [printScale, setPrintScale] = useState('1/8');
  const [printPaper, setPrintPaper] = useState('Tabloid');
  const [printLandscape, setPrintLandscape] = useState(true);
  const [printSubtitle, setPrintSubtitle] = useState('');
  const [dxfIncludeSchedule, setDxfIncludeSchedule] = useState(true);
  const [dxfVisibleOnly, setDxfVisibleOnly] = useState(true);
  const [libDept, setLibDept] = useState<string | null>(null);
  const [libCategory, setLibCategory] = useState<string | null>(null);
  const [libGrouping, setLibGrouping] = useState<'category' | 'department'>('category');
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteCategory, setPaletteCategory] = useState<string | null>(null);
  const [inventoryUndoNotice, setInventoryUndoNotice] = useState<string | null>(null);
  /**
   * Bumped after any inventory change.
   *
   * Mutation handlers answer with the whole inventory, unfiltered, so applying
   * their reply directly threw away whatever search or category the user was
   * working in. Re-running the query instead keeps the view where they left it.
   */
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Bumped when settings are closed, so the defaults below are re-read.
   *
   * Without this a preference changed mid-session would not apply until the
   * next launch, which reads as the setting having done nothing.
   */
  const [settingsVersion, setSettingsVersion] = useState(0);
  const inventoryChanged = useCallback(() => {
    setInventoryUndoNotice(null);
    setInventoryVersion((v) => v + 1);
  }, []);
  /** A inventory item armed for placement, kept apart from gear-line arming. */
  const [armedItem, setArmedItem] = useState<{ id: string; name: string } | null>(null);
  /** A seating layout waiting to be dropped. */
  const [armedSeating, setArmedSeating] = useState<Record<string, unknown> | null>(null);
  const [seatKind, setSeatKind] = useState<'round' | 'theatre' | 'schoolroom'>('round');
  const [seatTable, setSeatTable] = useState('');
  const [seatChair, setSeatChair] = useState('');
  const [seatCount, setSeatCount] = useState(10);
  const [seatRows, setSeatRows] = useState(6);
  const [seatPerRow, setSeatPerRow] = useState(10);
  const [gear, setGear] = useState<{
    path?: string;
    dirty: boolean;
    notice?: string;
    lists: GearList[];
    totals: GearTotals[];
  } | null>(null);
  const [gearIndex, setGearIndex] = useState(0);
  const [gearQuery, setGearQuery] = useState('');
  /** A gear line waiting to be dropped onto the plan. */
  const [armed, setArmed] = useState<string | null>(null);
  const [armedAnnotation, setArmedAnnotation] = useState<{ kind: 'label'; text: string } | null>(null);
  const statusTimer = useRef<number | null>(null);
  const errorTimer = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem('groundplan:rail-open', String(railOpen));
  }, [railOpen]);

  useEffect(() => {
    localStorage.setItem('groundplan:inspector-open', String(inspectorOpen));
  }, [inspectorOpen]);

  useEffect(() => {
    const active =
      view === 'gear' && gear
        ? { path: gear.path, name: gear.lists[gearIndex]?.title ?? 'Gear list', dirty: gear.dirty }
        : view === 'plan' && doc
          ? { path: doc.path, name: doc.name, dirty: doc.dirty }
          : view === 'inventory'
            ? { name: 'Equipment inventory', dirty: false }
            : { name: 'Groundplan', dirty: false };
    document.title = active.name === 'Groundplan' ? active.name : `${active.name} — Groundplan`;
    void api.setDocumentState(active);
  }, [doc, gear, gearIndex, view]);

  const refreshRecent = useCallback(() => {
    api.recentFiles().then(setRecent).catch(() => undefined);
  }, []);

  useEffect(refreshRecent, [refreshRecent]);

  const refreshPlanFolders = useCallback(() => {
    api
      .planFoldersList()
      .then((state) => {
        setPlanFolders(state);
        setSelectedPlanFolderId((selected) =>
          selected && !state.folders.some((folder) => folder.id === selected) ? null : selected,
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refreshPlanFolders, [refreshPlanFolders]);

  const refreshRecoveries = useCallback(() => {
    api.recoveryList().then(setRecoveries).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshRecoveries();
    return api.onRecoveryChanged(refreshRecoveries);
  }, [refreshRecoveries]);

  const adopt = useCallback((result: Doc) => {
    setDoc(result);
    setSaveConflict(null);
    setView('plan');
    setInspectorTab('properties');
    setSelectedIds([]);
    setSelection(null);
    setArmed(null);
    setArmedItem(null);
    setArmedSeating(null);
    setArmedAnnotation(null);
    setMeasuring(false);
    setMeasureFrom(null);
    setMeasurement(null);
    setDimensioning(false);
    setDimensionFrom(null);
    setPrintOpen(false);
    setFitToken((t) => t + 1);
  }, []);

  const loadGeneration = useRef(0);
  const load = useCallback(
    async (path: string) => {
      const generation = ++loadGeneration.current;
      setBusy(true);
      setBusyMessage('Opening…');
      setError(null);
      try {
        const result = await api.openPath(path);
        if (generation !== loadGeneration.current) return;
        if (result && 'scene' in result) {
          adopt(result as Doc);
          refreshRecent();
        } else if (result && 'reason' in (result as object)) {
          setError(String((result as { reason?: string }).reason ?? 'Could not open that plan.'));
        }
      } catch (err) {
        if (generation !== loadGeneration.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (generation === loadGeneration.current) {
          setBusy(false);
          setBusyMessage(null);
        }
      }
    },
    [refreshRecent, adopt],
  );

  const openFile = useCallback(async () => {
    setBusy(true);
    setBusyMessage('Opening…');
    setError(null);
    try {
      const result = await api.openFileDialog();
      if (result && 'scene' in result) {
        adopt(result as Doc);
        refreshRecent();
      } else if (result && 'reason' in (result as object)) {
        setError(String((result as { reason?: string }).reason ?? 'Could not open that plan.'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }, [refreshRecent, adopt]);

  const openFolder = useCallback(async () => {
    setBusy(true);
    setBusyMessage('Opening folder…');
    setError(null);
    try {
      const dir = await api.openFolderDialog();
      if (!dir) return;
      setFolder(dir);
      setEntries(await api.listDirectory(dir));
      setPlanRailSource('folder');
      setView('plan');
      setRailOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }, []);

  const exportSvg = useCallback(async () => {
    if (!doc) return;
    const svg = toSvg(doc.scene, visible);
    const saved = await api.exportSvg(doc.name.replace(/\.[^.]+$/, '') + '.svg', svg);
    if (saved) {
      setStatus(`Exported ${saved.split(/[\\/]/).pop()}`);
      window.setTimeout(() => setStatus(null), 2600);
    }
  }, [doc, visible]);

  // Preferences seed the export and drawing defaults, and are re-read whenever
  // the settings window closes.
  useEffect(() => {
    let live = true;
    void api
      .settingsGet()
      .then((value) => {
        if (!live || !value) return;
        const s = value as {
          print: { scale: string; paper: string; landscape: boolean; subtitle: string };
          dxf: { includeSchedule: boolean; visibleLayersOnly: boolean };
          drawing: {
            snapStep: number;
            units: 'imperial' | 'metric';
            showGrid: boolean;
            bulkDeleteWarning: number;
          };
        };
        setPrintScale(s.print.scale);
        setPrintPaper(s.print.paper);
        setPrintLandscape(s.print.landscape);
        setPrintSubtitle(s.print.subtitle);
        setDxfIncludeSchedule(s.dxf.includeSchedule);
        setDxfVisibleOnly(s.dxf.visibleLayersOnly);
        setSnapStep(s.drawing.snapStep);
        setUnitSystem(s.drawing.units === 'metric' ? 'metric' : 'imperial');
        setShowGrid(s.drawing.showGrid !== false);
        setBulkDeleteWarning(
          Number.isFinite(s.drawing.bulkDeleteWarning) ? s.drawing.bulkDeleteWarning : 25,
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [settingsVersion]);

  useEffect(() => {
    if (view === 'gear') return;
    let live = true;
    api
      .inventoryList(
        view === 'inventory' ? libQuery : paletteQuery,
        view === 'inventory' ? libDept : null,
        view === 'inventory' ? libCategory : paletteCategory,
      )
      .then((state) => live && setInventory(state as InventoryState))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [view, libQuery, libDept, libCategory, paletteQuery, paletteCategory, inventoryVersion]);

  // --- gear lists ---------------------------------------------------------

  const notify = useCallback((message: string) => {
    if (!message) return;
    if (errorTimer.current != null) window.clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = window.setTimeout(() => {
      setError(null);
      errorTimer.current = null;
    }, 5200);
  }, []);

  const showStatus = useCallback((message: string, duration = 3000) => {
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
    setStatus(message);
    statusTimer.current = window.setTimeout(() => {
      setStatus(null);
      statusTimer.current = null;
    }, duration);
  }, []);

  const acceptPlanFolderState = useCallback(
    (state: PlanFolderState | undefined) => {
      if (!state) return;
      setPlanFolders(state);
      if (state.notice) notify(state.notice);
      setSelectedPlanFolderId((selected) =>
        selected && !state.folders.some((folder) => folder.id === selected) ? null : selected,
      );
    },
    [notify],
  );

  const submitPlanFolder = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!planFolderEditor || !planFolderDraft.trim()) return;
      setBusy(true);
      setBusyMessage('Working…');
      try {
        const reply =
          planFolderEditor.kind === 'rename' && planFolderEditor.folderId
            ? await api.planFolderRename(planFolderEditor.folderId, planFolderDraft)
            : await api.planFolderCreate(planFolderDraft, selectedPlanFolderId);
        if (!reply.ok) {
          notify(reply.reason ?? 'Could not save that folder.');
          return;
        }
        acceptPlanFolderState(reply.state);
        if (planFolderEditor.kind === 'create' && reply.id) setSelectedPlanFolderId(reply.id);
        setPlanFolderEditor(null);
        setPlanFolderDraft('');
        showStatus(planFolderEditor.kind === 'rename' ? 'Folder renamed' : 'Plan folder created');
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      setBusyMessage(null);
      }
    },
    [
      acceptPlanFolderState,
      notify,
      planFolderDraft,
      planFolderEditor,
      selectedPlanFolderId,
      showStatus,
    ],
  );

  const deletePlanFolder = useCallback(async () => {
    if (!selectedPlanFolderId || !planFolders) return;
    const target = planFolders.folders.find((folder) => folder.id === selectedPlanFolderId);
    if (!target) return;
    const accepted = await api.confirm({
      title: 'Remove plan folder?',
      message: `Remove “${target.name}” from Groundplan?`,
      detail:
        'Its subfolders will also be removed from this panel. Original plan files, Show links, dimensions, and other companion files will not be deleted or moved.',
      confirmLabel: 'Remove Folder',
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    setBusyMessage('Working…');
    try {
      const reply = await api.planFolderRemove(target.id);
      if (!reply.ok) {
        notify(reply.reason ?? 'Could not remove that folder.');
        return;
      }
      acceptPlanFolderState(reply.state);
      setSelectedPlanFolderId(target.parentId);
      setPlanFolderEditor(null);
      showStatus('Folder removed — original plans were left untouched');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    setBusyMessage(null);
    }
  }, [acceptPlanFolderState, notify, planFolders, selectedPlanFolderId, showStatus]);

  const addPlansToSelectedFolder = useCallback(async () => {
    if (!selectedPlanFolderId) return;
    setBusy(true);
    setBusyMessage('Working…');
    try {
      const reply = await api.planFolderAddFiles(selectedPlanFolderId);
      if (!reply.ok) {
        notify(reply.reason ?? 'Could not add those plans.');
        return;
      }
      acceptPlanFolderState(reply.state);
      if (!reply.cancelled) {
        showStatus(reply.added ? `Added ${reply.added} plan${reply.added === 1 ? '' : 's'}` : 'Those plans are already in this folder');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    setBusyMessage(null);
    }
  }, [acceptPlanFolderState, notify, selectedPlanFolderId, showStatus]);

  const addCurrentPlanToSelectedFolder = useCallback(async () => {
    if (!selectedPlanFolderId) return;
    setBusy(true);
    setBusyMessage('Working…');
    try {
      const reply = await api.planFolderAddCurrent(selectedPlanFolderId);
      if (!reply.ok) {
        notify(reply.reason ?? 'Could not add the open plan.');
        return;
      }
      acceptPlanFolderState(reply.state);
      showStatus(reply.added ? 'Added the open plan' : 'The open plan is already in this folder');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    setBusyMessage(null);
    }
  }, [acceptPlanFolderState, notify, selectedPlanFolderId, showStatus]);

  const removePlanFromSelectedFolder = useCallback(
    async (path: string) => {
      if (!selectedPlanFolderId) return;
      try {
        const reply = await api.planFolderRemovePlan(selectedPlanFolderId, path);
        if (!reply.ok) {
          notify(reply.reason ?? 'Could not remove that plan from the folder.');
          return;
        }
        acceptPlanFolderState(reply.state);
        showStatus('Removed from folder — original file was left untouched');
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    },
    [acceptPlanFolderState, notify, selectedPlanFolderId, showStatus],
  );

  const restoreInventoryItem = useCallback(async () => {
    try {
      const reply = await api.inventoryRestoreLast();
      setInventoryUndoNotice(null);
      if (reply.ok) {
        setInventoryVersion((version) => version + 1);
        showStatus('Restored inventory item');
      } else if (reply.reason) {
        notify(reply.reason);
      }
    } catch (err) {
      setInventoryUndoNotice(null);
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify, showStatus]);

  const cancelPlacement = useCallback(() => {
    setArmed(null);
    setArmedItem(null);
    setArmedSeating(null);
    setArmedAnnotation(null);
  }, []);

  const showWorkspace = useCallback(
    (next: Workspace) => {
      if (next !== 'plan') {
        cancelPlacement();
        setMeasuring(false);
        setMeasureFrom(null);
        setMeasurement(null);
        setDimensioning(false);
        setDimensionFrom(null);
        setPrintOpen(false);
      }
      setView(next);
    },
    [cancelPlacement],
  );

  const openRecovery = useCallback(
    async (entry: RecoveryEntry) => {
      setBusy(true);
      setBusyMessage('Recovering…');
      setError(null);
      try {
        const recovered = await api.recoveryOpen(entry.id);
        if (!recovered) return;
        if (recovered.kind === 'plan') {
          adopt(recovered.doc as Doc);
          showStatus(`Recovered unsaved plan “${entry.displayName}”`);
        } else {
          setGear(recovered.gear);
          setGearIndex(0);
          showWorkspace('gear');
          showStatus(`Recovered unsaved gear work “${entry.displayName}”`);
        }
        refreshRecoveries();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setBusyMessage(null);
      }
    },
    [adopt, notify, refreshRecoveries, showStatus, showWorkspace],
  );

  const dismissRecovery = useCallback(
    async (entry: RecoveryEntry) => {
      const approved = await api.confirm({
        title: 'Discard recovered work',
        message: `Discard the recovered ${entry.kind} “${entry.displayName}”?`,
        detail: 'This removes the unsaved recovery copy and cannot be undone. Any previously saved file is unchanged.',
        confirmLabel: 'Discard Recovery',
        danger: true,
      });
      if (approved !== true) return;
      try {
        const reply = await api.recoveryDismiss(entry.id);
        if (reply.ok) {
          refreshRecoveries();
          showStatus('Discarded recovery copy');
        } else if (reply.reason) {
          notify(reply.reason);
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    },
    [notify, refreshRecoveries, showStatus],
  );

  const armGear = useCallback((description: string) => {
    setArmedItem(null);
    setArmedSeating(null);
    setArmedAnnotation(null);
    setMeasuring(false);
    setMeasureFrom(null);
    setDimensioning(false);
    setDimensionFrom(null);
    setArmed(description);
  }, []);

  const armInventory = useCallback((id: string, name: string) => {
    setArmedItem({ id, name });
    setArmedSeating(null);
    setArmedAnnotation(null);
    setMeasuring(false);
    setMeasureFrom(null);
    setDimensioning(false);
    setDimensionFrom(null);
    setArmed(name);
  }, []);

  const armLabel = useCallback(() => {
    if (!doc?.editable) return;
    const text = annotationDraft.trim();
    if (!text) {
      notify('Enter label text first.');
      annotationInputRef.current?.focus();
      return;
    }
    setArmedItem(null);
    setArmedSeating(null);
    setArmedAnnotation({ kind: 'label', text });
    setMeasuring(false);
    setMeasureFrom(null);
    setDimensioning(false);
    setDimensionFrom(null);
    setArmed(`label “${text}”`);
  }, [annotationDraft, doc?.editable, notify]);

  const toggleMeasure = useCallback(() => {
    cancelPlacement();
    setDimensioning(false);
    setDimensionFrom(null);
    setMeasuring((active) => {
      if (active) {
        setMeasureFrom(null);
        setMeasurement(null);
      }
      return !active;
    });
  }, [cancelPlacement]);

  const toggleDimension = useCallback(() => {
    if (!doc?.editable) return;
    cancelPlacement();
    setMeasuring(false);
    setMeasureFrom(null);
    setMeasurement(null);
    setDimensioning((active) => {
      if (active) setDimensionFrom(null);
      return !active;
    });
  }, [cancelPlacement, doc?.editable]);

  const importGear = useCallback(async () => {
    setBusy(true);
    setBusyMessage('Importing gear…');
    try {
      const state = await api.gearImport();
      if (state && Array.isArray(state.lists)) {
        setGear(state);
        setGearIndex(0);
        showWorkspace('gear');
        showStatus(`Imported ${state.lists.length} list${state.lists.length === 1 ? '' : 's'}`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }, [notify, showStatus, showWorkspace]);

  const openGear = useCallback(async () => {
    try {
      const state = await api.gearOpen();
      if (state && Array.isArray(state.lists)) {
        setGear(state);
        setGearIndex(0);
        showWorkspace('gear');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify, showWorkspace]);

  const saveGear = useCallback(
    async (saveAs: boolean) => {
      const reply = await api.gearSave(saveAs);
      if (reply.cancelled) return;
      if (reply.ok && reply.gear) {
        setGear(reply.gear);
        showStatus(`Saved ${reply.path?.split(/[\\/]/).pop()}`);
      } else if (reply.reason) notify(reply.reason);
    },
    [notify, showStatus],
  );

  const placeArmed = useCallback(
    async (x: number, y: number) => {
      if (!armed) return;
      const reply = armedAnnotation
        ? await api.addLabel(armedAnnotation.text, x, y)
        : armedSeating
        ? ((await api.addSeating({ ...armedSeating, x, y })) as {
            ok: boolean;
            reason?: string;
            doc?: Doc;
            method?: string;
            placed?: number;
            created?: number[];
          })
        : armedItem
          ? ((await api.inventoryPlace(armedItem.id, x, y)) as {
              ok: boolean;
              reason?: string;
              doc?: Doc;
              method?: string;
              created?: number[];
            })
          : await api.placeGear(armed, x, y);
      if (reply.ok && reply.doc) {
        setDoc(reply.doc as Doc);
        if (reply.created?.length) {
          setSelectedIds(selectableIds(reply.created, (reply.doc as Doc).scene));
          setSelection(null);
        }
        const placedCount = (reply as { placed?: number }).placed;
        const method = (reply as { method?: string }).method;
        showStatus(
          armedAnnotation
            ? `Added ${armedAnnotation.text}`
            : placedCount
              ? `Placed ${placedCount} items`
              : method === 'matched'
                ? `Placed ${armed} from the plan's own shapes`
                : `Placed ${armed} as a sized box`,
        );
      } else if (reply.reason) {
        notify(reply.reason);
      }
      cancelPlacement();
    },
    [armed, armedAnnotation, armedItem, armedSeating, cancelPlacement, notify, showStatus],
  );

  // --- editing ------------------------------------------------------------

  const applied = useCallback(
    (reply: { ok: boolean; reason?: string; doc?: Doc; created?: number[] }) => {
      if (reply.ok && reply.doc) {
        setDoc(reply.doc);
        setError(null);
        if (reply.created?.length) {
          setSelectedIds(selectableIds(reply.created, reply.doc.scene));
          setSelection(null);
        }
      } else if (reply.reason) {
        notify(reply.reason);
      }
    },
    [notify],
  );

  /** Turns the temporary two-point readout into real plan annotation. */
  const keepMeasurement = useCallback(async () => {
    if (!measurement || !doc?.editable) return;
    const reply = await api.addDimension(
      measurement.from.x,
      measurement.from.y,
      measurement.to.x,
      measurement.to.y,
      measurement.from.nodeId,
      measurement.to.nodeId,
    );
    applied(reply);
    if (!reply.ok) return;
    setMeasurement(null);
    setMeasureFrom(null);
    showStatus(reply.text ? `Saved ${reply.text} as a dimension` : 'Saved dimension on the plan');
  }, [measurement, doc?.editable, applied, showStatus]);

  /**
   * Hands the drawing to CAD as reusable symbols.
   *
   * The count of blocks is the number worth reporting: it is how many symbols
   * have to be swapped for 3D on the other side, however many are placed.
   */
  const exportDxf = useCallback(async () => {
    if (!doc) return;
    const reply = await api.exportDxf(dxfVisibleOnly ? [...visible] : undefined, dxfIncludeSchedule);
    if (reply.cancelled) return;
    if (reply.ok) {
      showStatus(
        `Exported ${reply.blocks} symbols and ${reply.inserts?.toLocaleString()} placements, plus the schedule`,
        4200,
      );
    } else if (reply.reason) notify(reply.reason);
  }, [doc, visible, notify, showStatus]);

  /**
   * Select All, which means two different things.
   *
   * In a text field it selects the text; on the drawing it selects every
   * object. The menu owns the shortcut on macOS, so the decision has to be made
   * here rather than left to whichever handler happens to see the key first.
   */
  const selectAll = useCallback(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (
      focused &&
      (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable)
    ) {
      (focused as HTMLInputElement).select?.();
      return;
    }
    if (!doc) return;
    setSelectedIds([
      ...new Set(doc.scene.primitives.filter((p) => visible.has(p.layer)).map((p) => p.selectId)),
    ]);
  }, [doc, visible]);

  const printPdf = useCallback(async () => {
    if (!doc) return;
    const extent = doc.scene.roomExtent ?? doc.scene.extent;
    const reply = await api.printPdf({
      svg: toSvg(doc.scene, visible),
      title: doc.scene.title ?? doc.name.replace(/\.[^.]+$/, ''),
      subtitle: gear?.lists[gearIndex]?.jobNumber
        ? `Job ${gear.lists[gearIndex].jobNumber}`
        : printSubtitle || undefined,
      roomWidth: extent ? extent.maxX - extent.minX : undefined,
      roomHeight: extent ? extent.maxY - extent.minY : undefined,
      scale: printScale,
      paper: printPaper,
      landscape: printLandscape,
      suggestedName: doc.name.replace(/\.[^.]+$/, '') + '.pdf',
    });
    setPrintOpen(false);
    if (reply.cancelled) return;
    if (reply.ok) {
      const name = reply.path?.split(/[\\/]/).pop();
      if (reply.fits === false) {
        // Better to be told the sheet crops than to find out at the venue.
        notify(
          `Printed ${name}, but the room is ${Math.round(((reply.overBy ?? 1) - 1) * 100)}% larger than ` +
            `this sheet at that scale — use a bigger sheet or a smaller scale to see all of it.`,
        );
      } else {
        showStatus(`Printed ${name}`);
      }
    } else if (reply.reason) notify(reply.reason);
  }, [doc, visible, printScale, printPaper, printLandscape, printSubtitle, gear, gearIndex, notify, showStatus]);

  /** Places a inventory item where it was dropped on the drawing. */
  const dropItem = useCallback(
    async (id: string, x: number, y: number) => {
      if (!doc?.editable) {
        notify('This plan is read-only, so items cannot be placed on it.');
        return;
      }
      const reply = (await api.inventoryPlace(id, x, y)) as {
        ok: boolean;
        reason?: string;
        doc?: Doc;
        method?: string;
        created?: number[];
      };
      if (reply.ok && reply.doc) {
        setDoc(reply.doc as Doc);
        if (reply.created?.length) {
          setSelectedIds(selectableIds(reply.created, (reply.doc as Doc).scene));
          setSelection(null);
        }
        showStatus(
          reply.method === 'matched'
            ? "Placed from the plan's own shapes"
            : 'Placed as a sized box',
        );
      } else if (reply.reason) notify(reply.reason);
    },
    [doc, notify, showStatus],
  );

  const moveSelection = useCallback(
    async (dx: number, dy: number) => {
      if (!selectedIds.length) return;
      applied((await api.batch('move', selectedIds, dx, dy)) as { ok: boolean; reason?: string; doc?: Doc });
    },
    [selectedIds, applied],
  );

  const deleteSelection = useCallback(async () => {
    if (!selectedIds.length) return;
    if (bulkDeleteWarning > 0 && selectedIds.length >= bulkDeleteWarning) {
      const confirmed = await api.confirm({
        title: 'Delete selection?',
        message: `Delete ${selectedIds.length} selected items?`,
        detail: 'This can be undone with Undo, but large deletions are hard to put back by hand.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (confirmed !== true) return;
    }
    const reply = (await api.batch('delete', selectedIds)) as { ok: boolean; reason?: string; doc?: Doc };
    applied(reply);
    if (reply.ok) {
      setSelectedIds([]);
      setSelection(null);
    }
  }, [selectedIds, applied, bulkDeleteWarning]);

  const duplicateSelection = useCallback(async () => {
    if (!selectedIds.length) return;
    const reply = (await api.batch('duplicate', selectedIds, FOOT, FOOT)) as {
      ok: boolean;
      reason?: string;
      doc?: Doc;
      created?: number[];
    };
    applied(reply);
  }, [selectedIds, applied]);

  const reorderSelection = useCallback(
    async (to: 'bring-to-front' | 'send-to-back') => {
      if (!selectedIds.length) return;
      applied((await api.batch(to, selectedIds)) as { ok: boolean; reason?: string; doc?: Doc });
    },
    [selectedIds, applied],
  );

  const rotateSelection = useCallback(
    async (degrees: number) => {
      if (!selectedIds.length) return;
      applied((await api.batch('rotate', selectedIds, degrees)) as { ok: boolean; reason?: string; doc?: Doc });
    },
    [selectedIds, applied],
  );

  const rotateByDraft = useCallback(() => {
    const degrees = Number(rotationDraft);
    if (!Number.isFinite(degrees) || degrees === 0 || Math.abs(degrees) > 3600) {
      notify('Enter a rotation between −3600° and 3600°, excluding zero.');
      return;
    }
    void rotateSelection(degrees);
  }, [rotationDraft, rotateSelection, notify]);

  const flipSelection = useCallback(
    async (axis: 'horizontal' | 'vertical') => {
      if (!selectedIds.length) return;
      applied(
        (await api.batch(axis === 'horizontal' ? 'flip-horizontal' : 'flip-vertical', selectedIds)) as {
          ok: boolean;
          reason?: string;
          doc?: Doc;
        },
      );
    },
    [selectedIds, applied],
  );

  const arrangeSelection = useCallback(
    async (mode: ArrangeMode) => {
      if (selectedIds.length < 2) return;
      applied((await api.arrange(mode, selectedIds)) as { ok: boolean; reason?: string; doc?: Doc });
    },
    [selectedIds, applied],
  );

  const applyColor = useCallback(
    async (hex = colorDraft) => {
      if (!selectedIds.length) return;
      const color = hexToColorRef(hex);
      if (color == null) {
        notify('Choose a valid six-digit colour.');
        return;
      }
      setColorDraft(hex);
      applied(
        (await api.batch('recolor', selectedIds, color)) as {
          ok: boolean;
          reason?: string;
          doc?: Doc;
        },
      );
    },
    [selectedIds, colorDraft, applied, notify],
  );

  const undo = useCallback(async () => {
    const next = (await api.undo()) as Doc | null;
    if (next) {
      setDoc(next);
      setSelectedIds([]);
      setSelection(null);
    }
  }, []);

  const redo = useCallback(async () => {
    const next = (await api.redo()) as Doc | null;
    if (next) {
      setDoc(next);
      setSelectedIds([]);
      setSelection(null);
    }
  }, []);

  const save = useCallback(
    async (saveAs: boolean) => {
      if (!doc?.editable) {
        setError('This file is open read-only, so it cannot be saved.');
        window.setTimeout(() => setError(null), 4200);
        return;
      }
      const reply = await api.save(saveAs);
      if (reply.cancelled) return;
      if (reply.ok && reply.doc) {
        setDoc(reply.doc as Doc);
        setSaveConflict(null);
        showStatus(`Saved ${reply.path?.split(/[\\/]/).pop()}`);
        if (reply.warning) notify(reply.warning);
      } else if (reply.conflict) {
        setError(null);
        setSaveConflict(
          reply.reason ?? 'The plan changed outside Groundplan. Your version was not overwritten.',
        );
      } else if (reply.reason) {
        notify(reply.reason);
      }
    },
    [doc, notify, showStatus],
  );

  useEffect(() => {
    if (selectedId == null) {
      setSelection(null);
      return;
    }
    let live = true;
    api
      .selectionInfo(selectedId)
      .then((info) => {
        if (!live) return;
        setSelection(info as Selection | null);
        setLabelDraft(info?.text ?? '');
        setSizeDraft(
          info
            ? {
                width: formatLength(info.widthUnits, unitSystem),
                height: formatLength(info.heightUnits, unitSystem),
              }
            : { width: '', height: '' },
        );
        setPositionDraft(
          info
            ? {
                x: formatLength(info.x, unitSystem),
                y: formatLength(info.y, unitSystem),
              }
            : { x: '', y: '' },
        );
        if (info?.color != null) setColorDraft(colorRefToHex(info.color));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [selectedId, doc, unitSystem]);

  useEffect(() => {
    if (selectedIds.length > 0) setInspectorTab('properties');
  }, [selectedIds]);

  const commitSelectionSize = useCallback(async () => {
    if (!selection || !doc?.editable) return;
    const width = parseLength(sizeDraft.width, unitSystem);
    const height = parseLength(sizeDraft.height, unitSystem);
    if (width == null || height == null || width <= 0 || height <= 0) {
      notify(unitSystem === 'metric' ? 'Enter a positive width and height (for example 1.2m).' : 'Enter a positive width and height (for example 4\' or 4\' 6").');
      return;
    }
    if (Math.abs(width - selection.widthUnits) < 1 && Math.abs(height - selection.heightUnits) < 1) return;
    applied((await api.resize(selection.nodeId, width, height)) as { ok: boolean; reason?: string; doc?: Doc });
  }, [selection, doc?.editable, sizeDraft, unitSystem, notify, applied]);

  const commitSelectionPosition = useCallback(async () => {
    if (!selection || !doc?.editable) return;
    const x = parseLength(positionDraft.x, unitSystem);
    const y = parseLength(positionDraft.y, unitSystem);
    if (x == null || y == null) {
      notify(unitSystem === 'metric' ? 'Enter X and Y as lengths (for example 3.6m).' : 'Enter X and Y as lengths (for example 12\' 6").');
      return;
    }
    const dx = x - selection.x;
    const dy = y - selection.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    applied((await api.batch('move', [selection.nodeId], dx, dy)) as { ok: boolean; reason?: string; doc?: Doc });
  }, [selection, doc?.editable, positionDraft, unitSystem, notify, applied]);

  /** Routes a path to the plan reader or the gear importer by extension. */
  const openAnyPath = useCallback(
    async (path: string) => {
      const lower = path.toLowerCase();
      try {
        if (lower.endsWith('.pdf')) {
          const state = await api.gearImportPath(path);
          if (state && Array.isArray(state.lists)) {
            setGear(state);
            setGearIndex(0);
            showWorkspace('gear');
          }
          return;
        }
        if (lower.endsWith('.json')) {
          const state = await api.gearOpenPath(path);
          if (state && Array.isArray(state.lists)) {
            setGear(state);
            setGearIndex(0);
            showWorkspace('gear');
          }
          return;
        }
        await load(path);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    },
    [load, notify, showWorkspace],
  );

  useEffect(() => {
    return api.onMenu((command, arg) => {
      // Settings first and unconditionally: it is the one command that must
      // work whatever view is showing, including with no plan open.
      if (command === 'menu:settings') setSettingsOpen(true);
      else if (command === 'menu:new') setNewPlanOpen(true);
      else if (command === 'menu:open') void openFile();
      else if (command === 'menu:open-folder') void openFolder();
      else if (command === 'menu:fit' && view === 'plan') setFitToken((t) => t + 1);
      else if (command === 'menu:export-svg' && view === 'plan') void exportSvg();
      else if (command === 'menu:export-dxf' && view === 'plan') void exportDxf();
      else if (command === 'menu:select-all' && view === 'plan') selectAll();
      else if (command === 'menu:print' && view === 'plan' && doc) setPrintOpen(true);
      else if (command === 'menu:undo' && view === 'plan') void undo();
      else if (command === 'menu:redo' && view === 'plan') void redo();
      else if (command === 'menu:open-path' && arg) void openAnyPath(arg);
      else if (command === 'menu:save' && view === 'gear') void saveGear(false);
      else if (command === 'menu:save' && view === 'plan') void save(false);
      else if (command === 'menu:save-as' && view === 'gear') void saveGear(true);
      else if (command === 'menu:save-as' && view === 'plan') void save(true);
    });
  }, [openFile, openFolder, exportSvg, exportDxf, openAnyPath, save, saveGear, view, doc, undo, redo, selectAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (newPlanOpen) {
          e.preventDefault();
          setNewPlanOpen(false);
          return;
        }
        if (settingsOpen) {
          e.preventDefault();
          setSettingsOpen(false);
          return;
        }
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (e.shiftKey) setInspectorOpen((open) => !open);
        else setRailOpen((open) => !open);
        return;
      }
      // Editing shortcuts apply only to the visible Plan workspace. This avoids
      // changing a document hidden behind Gear or Inventory.
      if (view !== 'plan') return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'd' && doc?.editable && selectedIds.length) {
        e.preventDefault();
        void duplicateSelection();
        return;
      }
      if (e.key === 'Enter' && measuring && measurement) {
        e.preventDefault();
        void keepMeasurement();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (doc?.editable && selectedIds.length) {
          e.preventDefault();
          void deleteSelection();
        }
        return;
      }
      if (e.key.toLowerCase() === 's' && !mod && doc) {
        e.preventDefault();
        setSnapStep((v) => (v ? 0 : FOOT));
        return;
      }
      if (e.key.toLowerCase() === 'm' && !mod && doc) {
        e.preventDefault();
        toggleMeasure();
        return;
      }
      if (e.key.toLowerCase() === 'd' && !mod && doc?.editable) {
        e.preventDefault();
        toggleDimension();
        return;
      }
      if (e.key.toLowerCase() === 't' && !mod && doc?.editable) {
        e.preventDefault();
        setInspectorOpen(true);
        setInspectorTab('create');
        window.setTimeout(() => annotationInputRef.current?.focus(), 0);
        return;
      }
      if (e.key === 'Escape') {
        if (printOpen) {
          setPrintOpen(false);
          return;
        }
        if (drawTool) {
          // First Escape abandons the shape in progress, second puts the tool
          // down — so a mis-clicked corner does not cost you the tool.
          if (drawFrom) setDrawFrom(null);
          else setDrawTool(null);
          return;
        }
        if (dimensioning) {
          setDimensioning(false);
          setDimensionFrom(null);
          return;
        }
        if (measuring) {
          setMeasuring(false);
          setMeasureFrom(null);
          setMeasurement(null);
          return;
        }
        if (armed) {
          cancelPlacement();
        } else setSelectedIds([]);
        return;
      }

      if ((e.key === '[' || e.key === ']') && doc?.editable && selectedIds.length) {
        e.preventDefault();
        void rotateSelection(e.key === '[' ? -90 : 90);
        return;
      }

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }

      const step = e.shiftKey ? 10 : FOOT;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = delta[e.key];
      if (d && doc?.editable && selectedIds.length) {
        e.preventDefault();
        void moveSelection(d[0], d[1]);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selectedIds,
    undo,
    redo,
    duplicateSelection,
    deleteSelection,
    moveSelection,
    rotateSelection,
    armed,
    measuring,
    measurement,
    dimensioning,
    drawTool,
    drawFrom,
    printOpen,
    newPlanOpen,
    settingsOpen,
    cancelPlacement,
    toggleMeasure,
    toggleDimension,
    keepMeasurement,
    selectAll,
    view,
    doc,
    notify,
  ]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);

  const selectedPlanFolder = useMemo(
    () => planFolders?.folders.find((folder) => folder.id === selectedPlanFolderId) ?? null,
    [planFolders, selectedPlanFolderId],
  );
  const planFolderBreadcrumbs = useMemo(() => {
    if (!planFolders || !selectedPlanFolder) return [];
    const trail = [selectedPlanFolder];
    let parentId = selectedPlanFolder.parentId;
    while (parentId) {
      const parent = planFolders.folders.find((folder) => folder.id === parentId);
      if (!parent) break;
      trail.unshift(parent);
      parentId = parent.parentId;
    }
    return trail;
  }, [planFolders, selectedPlanFolder]);
  const visiblePlanFolders = useMemo(
    () =>
      (planFolders?.folders ?? []).filter(
        (candidate) => candidate.parentId === (selectedPlanFolder?.id ?? null),
      ),
    [planFolders, selectedPlanFolder],
  );
  const visibleFolderPlans = useMemo(
    () =>
      selectedPlanFolder
        ? (planFolders?.plans ?? []).filter((plan) => plan.folderId === selectedPlanFolder.id)
        : [],
    [planFolders, selectedPlanFolder],
  );

  const toggleLayer = (id: Layer) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const extent = doc?.scene.roomExtent ?? doc?.scene.extent ?? null;
  const inventoryTotal = doc?.scene.inventory.reduce((sum, i) => sum + i.count, 0) ?? 0;
  const singleIsAnnotation = !!selection && /dimension|text|label/i.test(selection.cls);
  const canTransformSelection = selectedIds.length > 1 || (!!selection && !singleIsAnnotation);
  const canResizeSelection =
    !!selection && !singleIsAnnotation && selection.widthUnits > 0 && selection.heightUnits > 0;
  /** Absolute X/Y is single-selection only — multi-select keeps stale drafts otherwise. */
  const canPositionSelection = !!selection && selectedIds.length === 1 && !singleIsAnnotation;
  // Annotation is always available on an editable plan: when the plan has no
  // label or dimension of its own to clone, Groundplan synthesizes one from
  // scratch. The capability flags now only decide whether new annotation
  // matches the sheet's existing styling or falls back to the built-in default.
  const canCreateLabel = !!doc?.editable;
  const canCreateDimension = !!doc?.editable;
  const annotationCapabilityHint =
    doc?.editable && (!doc.annotationCapabilities?.label || !doc.annotationCapabilities?.dimension)
      ? !doc.annotationCapabilities?.label && !doc.annotationCapabilities?.dimension
        ? 'This plan has no labels or dimensions to match, so new ones use Groundplan’s default styling.'
        : !doc.annotationCapabilities?.label
          ? 'This plan has no label to match, so new labels use Groundplan’s default styling.'
          : 'This plan has no dimension to match, so new dimensions use Groundplan’s default styling.'
      : null;
  const shortcut = (key: string, shift = false) =>
    api.platform === 'darwin' ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;

  return (
    <div className="app" data-platform={api.platform} aria-busy={busy}>
      {newPlanOpen && (
        <NewPlanDialog
          units={unitSystem}
          onCancel={() => setNewPlanOpen(false)}
          onError={notify}
          onCreated={(created) => {
            setNewPlanOpen(false);
            // The same path an opened plan takes, so nothing is left over from
            // whatever was on screen before.
            adopt(created as Doc);
            setInspectorTab('room');
            setFitToken((t) => t + 1);
            refreshRecent();
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            setSettingsOpen(false);
            setSettingsVersion((v) => v + 1);
          }}
          onError={notify}
        />
      )}
      <header className="toolbar">
        <div className="brand">
          <Mark />
          <span>Groundplan</span>
        </div>

        <div className="seg">
          <button
            className="icon-btn"
            onClick={() => setNewPlanOpen(true)}
            disabled={busy}
            title={`New plan (${shortcut('N')})`}
            aria-label="New plan"
          >
            <IconPlus />
          </button>
          <button
            className="icon-btn"
            onClick={openFile}
            disabled={busy}
            title={`Open plan (${shortcut('O')})`}
            aria-label="Open plan"
          >
            <IconFile />
          </button>
          <button
            className="icon-btn"
            onClick={openFolder}
            disabled={busy}
            title={`Open folder (${shortcut('O', true)})`}
            aria-label="Open plan folder"
          >
            <IconFolder />
          </button>
        </div>

        <div className="seg panel-toggles">
          <button
            className={`icon-btn${railOpen ? ' is-on' : ''}`}
            onClick={() => setRailOpen((open) => !open)}
            title={`${railOpen ? 'Hide' : 'Show'} browser (${shortcut('B')})`}
            aria-pressed={railOpen}
            aria-label={`${railOpen ? 'Hide' : 'Show'} browser`}
          >
            <IconSidebarLeft />
          </button>
          <button
            className={`icon-btn${inspectorOpen ? ' is-on' : ''}`}
            onClick={() => setInspectorOpen((open) => !open)}
            title={`${inspectorOpen ? 'Hide' : 'Show'} inspector (${shortcut('B', true)})`}
            aria-pressed={inspectorOpen}
            aria-label={`${inspectorOpen ? 'Hide' : 'Show'} inspector`}
          >
            <IconSidebarRight />
          </button>
        </div>

        <div className="seg tabs workspace-tabs" role="tablist" aria-label="Workspace">
          <button
            role="tab"
            aria-selected={view === 'plan'}
            className={view === 'plan' ? 'active' : ''}
            onClick={() => showWorkspace('plan')}
          >
            Plan
          </button>
          <button
            role="tab"
            aria-selected={view === 'gear'}
            className={view === 'gear' ? 'active' : ''}
            onClick={() => showWorkspace('gear')}
          >
            Gear
            {gear && <span className="num">{gear.totals[gearIndex]?.pieces ?? 0}</span>}
          </button>
          <button
            role="tab"
            aria-selected={view === 'inventory'}
            className={view === 'inventory' ? 'active' : ''}
            onClick={() => showWorkspace('inventory')}
          >
            Inventory
            {inventory && inventory.total > 0 && <span className="num">{inventory.total}</span>}
          </button>
        </div>

        {view === 'plan' && (
          <>
            <div className="seg" aria-label="Plan history">
              <button
                className="icon-btn"
                onClick={undo}
                disabled={!doc?.canUndo}
                title={`Undo (${shortcut('Z')})`}
                aria-label="Undo plan edit"
              >
                <IconUndo />
              </button>
              <button
                className="icon-btn"
                onClick={redo}
                disabled={!doc?.canRedo}
                title={`Redo (${shortcut('Z', true)})`}
                aria-label="Redo plan edit"
              >
                <IconRedo />
              </button>
            </div>

            <div className="seg plan-view-controls" aria-label="Plan view controls">
              <button
                className="icon-btn"
                onClick={() => setFitToken((t) => t + 1)}
                disabled={!doc}
                title={`Zoom to fit (${shortcut('0')})`}
                aria-label="Zoom plan to fit"
              >
                <IconFit />
              </button>
              <button
                className="icon-btn"
                onClick={() => setPaper((p) => !p)}
                disabled={!doc}
                title={paper ? 'Switch to dark sheet' : 'Switch to paper sheet'}
                aria-label={paper ? 'Use dark plan sheet' : 'Use light plan sheet'}
              >
                {paper ? <IconMoon /> : <IconSun />}
              </button>
              <button
                className={`icon-btn${snapStep ? ' is-on' : ''}`}
                onClick={() => setSnapStep((v) => (v ? 0 : FOOT))}
                disabled={!doc}
                title={snapStep ? 'Snapping on — 1ft grid and object alignment (S)' : 'Snapping off (S)'}
                aria-label={snapStep ? 'Disable snapping' : 'Enable snapping'}
                aria-pressed={!!snapStep}
              >
                <IconMagnet />
              </button>
            </div>

            <div className="seg plan-tool-controls" aria-label="Plan drawing tools">
              <button
                className={`tool-button${measuring ? ' is-on' : ''}`}
                onClick={toggleMeasure}
                disabled={!doc}
                title="Temporary measurement (M). It is not saved unless you choose Save dimension."
                aria-pressed={measuring}
              >
                <IconRuler />
                <span>Measure</span>
              </button>
              <button
                className={`tool-button${dimensioning ? ' is-on' : ''}`}
                onClick={toggleDimension}
                disabled={!canCreateDimension}
                title={
                  canCreateDimension
                    ? 'Saved dimension (D). Draws a persistent annotation on the plan.'
                    : doc
                      ? 'Unavailable: this plan is read-only. Use Measure for a temporary distance.'
                      : 'Open an editable plan to draw a saved dimension.'
                }
                aria-pressed={dimensioning}
              >
                <IconRuler />
                <span>Dimension</span>
              </button>
            </div>

            <div className="seg draw-tools" aria-label="Draw">
              <button
                className={`icon-btn${!drawTool && !armed && !measuring && !dimensioning ? ' is-on' : ''}`}
                onClick={() => {
                  setDrawTool(null);
                  setDrawFrom(null);
                  setMeasuring(false);
                  setDimensioning(false);
                  cancelPlacement();
                }}
                disabled={!doc}
                title="Select (Esc)"
                aria-label="Select tool"
                aria-pressed={!drawTool && !armed && !measuring && !dimensioning}
              >
                <IconPointer />
              </button>
              {(
                [
                  ['line', 'Line', IconDrawLine],
                  ['rect', 'Rectangle', IconDrawRect],
                  ['ellipse', 'Ellipse', IconDrawEllipse],
                ] as const
              ).map(([tool, label, Icon]) => (
                <button
                  key={tool}
                  className={`icon-btn${drawTool === tool ? ' is-on' : ''}`}
                  onClick={() => {
                    setDrawFrom(null);
                    setDrawTool((current) => (current === tool ? null : tool));
                    setMeasuring(false);
                    setDimensioning(false);
                    setArmed(null);
                  }}
                  disabled={!doc?.editable}
                  title={
                    doc?.editable
                      ? `Draw a ${label.toLowerCase()} — click two corners, Esc to cancel`
                      : 'Open an editable plan to draw'
                  }
                  aria-label={`Draw ${label.toLowerCase()}`}
                  aria-pressed={drawTool === tool}
                >
                  <Icon />
                </button>
              ))}
              <button
                className={`icon-btn${armedAnnotation ? ' is-on' : ''}`}
                onClick={() => {
                  setInspectorTab('create');
                  setInspectorOpen(true);
                  annotationInputRef.current?.focus();
                }}
                disabled={!doc?.editable}
                title="Text label (T)"
                aria-label="Text label"
                aria-pressed={!!armedAnnotation}
              >
                <IconText />
              </button>
            </div>

            <div className="seg object-tools" aria-label="Arrange">
              <button
                className="icon-btn"
                onClick={() => void rotateSelection(-90)}
                disabled={!doc?.editable || !selectedIds.length}
                title="Rotate 90° anticlockwise"
                aria-label="Rotate anticlockwise"
              >
                <IconRotateLeft />
              </button>
              <button
                className="icon-btn"
                onClick={() => void rotateSelection(90)}
                disabled={!doc?.editable || !selectedIds.length}
                title="Rotate 90° clockwise"
                aria-label="Rotate clockwise"
              >
                <IconRotateRight />
              </button>
              <button
                className="icon-btn"
                onClick={() => void reorderSelection('bring-to-front')}
                disabled={!doc?.editable || !selectedIds.length}
                title="Bring to front"
                aria-label="Bring to front"
              >
                <IconBringFront />
              </button>
              <button
                className="icon-btn"
                onClick={() => void reorderSelection('send-to-back')}
                disabled={!doc?.editable || !selectedIds.length}
                title="Send to back"
                aria-label="Send to back"
              >
                <IconSendBack />
              </button>
              <button
                className="icon-btn"
                onClick={duplicateSelection}
                disabled={!doc?.editable || !selectedIds.length}
                title={`Duplicate (${shortcut('D')})`}
                aria-label="Duplicate"
              >
                <IconDuplicate />
              </button>
              <button
                className="icon-btn"
                onClick={deleteSelection}
                disabled={!doc?.editable || !selectedIds.length}
                title="Delete (Backspace)"
                aria-label="Delete"
              >
                <IconTrash />
              </button>
            </div>

            <div className="seg plan-output-controls" aria-label="Plan output">
              <button
                className={`icon-btn${printOpen ? ' is-on' : ''}`}
                onClick={() => setPrintOpen((v) => !v)}
                disabled={!doc}
                title={`Print to PDF (${shortcut('P')})`}
                aria-label="Print plan to PDF"
              >
                <IconPrint />
              </button>
              <button
                className="icon-btn"
                onClick={exportSvg}
                disabled={!doc}
                title={`Export SVG (${shortcut('E')})`}
                aria-label="Export plan as SVG"
              >
                <IconExport />
              </button>
              <button
                className="icon-btn"
                onClick={() => void exportDxf()}
                disabled={!doc}
                title="Export DXF for CAD"
                aria-label="Export plan as DXF"
              >
                <IconFile />
              </button>
            </div>
          </>
        )}

        <div className="spacer" />

        {view === 'gear' && gear && (
          <div className="doc-title">
            {gear.dirty && <span className="dot" title="Unsaved changes" />}
            <strong>{gear.lists[gearIndex]?.title.replace(/^\d{8}-\d{2}_/, '') ?? 'Gear list'}</strong>
          </div>
        )}
        {view === 'plan' && doc && (
          <div className="doc-title">
            {doc.dirty && <span className="dot" title="Unsaved changes" />}
            <strong>{doc.name}</strong>
            {!doc.editable && (
              <span className="badge" title="This file does not reproduce byte for byte, so it cannot be saved">
                <IconLock />
                Read-only
              </span>
            )}
          </div>
        )}

        {view === 'inventory' ? (
          <span className="autosave-label" role="status">Changes save automatically</span>
        ) : (
          <button
            className="btn-primary"
            onClick={() => (view === 'gear' ? saveGear(false) : save(false))}
            disabled={view === 'gear' ? !gear?.dirty : !doc?.editable || !doc?.dirty}
            title={`Save ${view === 'gear' ? 'gear list' : 'plan'} (${shortcut('S')})`}
          >
            <IconSave />
            Save
          </button>
        )}
      </header>

      <div className={`body${railOpen ? '' : ' is-rail-hidden'}${inspectorOpen ? '' : ' is-inspector-hidden'}`}>
        <aside className="rail" aria-hidden={!railOpen}>
          {view === 'inventory' ? (
            <>
              <div className="search">
                <IconSearch size={13} />
                <input
                  aria-label="Search inventory"
                  placeholder="Search inventory…"
                  value={libQuery}
                  onChange={(e) => setLibQuery(e.target.value)}
                />
              </div>
              <div className="seg seg-wide">
                <button
                  className={libGrouping === 'category' ? 'is-on' : ''}
                  onClick={() => {
                    setLibGrouping('category');
                    setLibDept(null);
                  }}
                >
                  Category
                </button>
                <button
                  className={libGrouping === 'department' ? 'is-on' : ''}
                  onClick={() => {
                    setLibGrouping('department');
                    setLibCategory(null);
                  }}
                >
                  Department
                </button>
              </div>

              <ul className="file-list">
                <li>
                  <button
                    className={libDept === null && libCategory === null ? 'active' : ''}
                    onClick={() => {
                      setLibDept(null);
                      setLibCategory(null);
                    }}
                  >
                    <span className="fname">All items</span>
                    <span className="num" style={{ color: 'var(--ink-3)' }}>{inventory?.total ?? 0}</span>
                  </button>
                </li>

                {libGrouping === 'department'
                  ? inventory?.departments.map((d) => (
                      <li key={d.name}>
                        <button className={libDept === d.name ? 'active' : ''} onClick={() => setLibDept(d.name)}>
                          <span className="fname">{d.name}</span>
                          <span className="num" style={{ color: 'var(--ink-3)' }}>{d.count}</span>
                        </button>
                      </li>
                    ))
                  : inventory?.groups.map((group) => (
                      <li key={group.layer} className="rail-group">
                        <span className="rail-group-title">{group.label}</span>
                        <ul>
                          {group.categories.map((c) => (
                            <li key={c.id}>
                              <button
                                className={libCategory === c.id ? 'active' : ''}
                                onClick={() => setLibCategory(libCategory === c.id ? null : c.id)}
                              >
                                <span className="fname">{c.label}</span>
                                <span className="num" style={{ color: 'var(--ink-3)' }}>{c.count}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
              </ul>
            </>
          ) : view === 'gear' ? (
            <>
              <div className="search">
                <IconSearch size={13} />
                <input
                  aria-label="Search gear list"
                  placeholder="Search gear…"
                  value={gearQuery}
                  onChange={(e) => setGearQuery(e.target.value)}
                />
              </div>
              {gear ? (
                <ul className="file-list">
                  {gear.lists[gearIndex]?.departments.map((d) => (
                    <li key={d.id}>
                      <button
                        onClick={() => {
                          const el = document.getElementById(`dept-${d.id}`);
                          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <span className="fname">{d.name}</span>
                        <span className="num" style={{ color: 'var(--ink-3)' }}>
                          {d.items.filter((i) => !i.note).length}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="file-list">
                  <li className="empty">
                    Import a gear list PDF from your rental system, or open one you have already saved.
                  </li>
                  <li style={{ padding: '8px 2px', display: 'grid', gap: 6 }}>
                    <button className="btn-outline" onClick={importGear} style={{ justifyContent: 'center' }}>
                      Import PDF…
                    </button>
                    <button className="btn-outline" onClick={openGear} style={{ justifyContent: 'center' }}>
                      Open gear list…
                    </button>
                  </li>
                </ul>
              )}
            </>
          ) : (
            <>
              <nav className="rail-source-tabs" aria-label="Plan browser source">
                <button
                  className={planRailSource === 'recent' ? 'active' : ''}
                  onClick={() => setPlanRailSource('recent')}
                  aria-pressed={planRailSource === 'recent'}
                >
                  Recent
                </button>
                <button
                  className={planRailSource === 'collections' ? 'active' : ''}
                  onClick={() => setPlanRailSource('collections')}
                  aria-pressed={planRailSource === 'collections'}
                  title="Organize plans without moving their files"
                >
                  Folders
                </button>
                <button
                  className={planRailSource === 'folder' ? 'active' : ''}
                  onClick={() => {
                    if (folder) setPlanRailSource('folder');
                    else void openFolder();
                  }}
                  aria-pressed={planRailSource === 'folder'}
                >
                  Browse
                </button>
                <button
                  className={planRailSource === 'equipment' ? 'active' : ''}
                  onClick={() => setPlanRailSource('equipment')}
                  aria-pressed={planRailSource === 'equipment'}
                >
                  Equipment
                </button>
              </nav>

              {planRailSource === 'collections' ? (
                <section className="plan-folders-panel" aria-label="Organized plan folders">
                  <div className="plan-folder-heading">
                    <nav className="plan-folder-breadcrumbs" aria-label="Plan folder location">
                      <button
                        className={!selectedPlanFolder ? 'current' : ''}
                        onClick={() => {
                          setSelectedPlanFolderId(null);
                          setPlanFolderEditor(null);
                        }}
                      >
                        Plan folders
                      </button>
                      {planFolderBreadcrumbs.map((crumb) => (
                        <span className="plan-folder-crumb" key={crumb.id}>
                          <span aria-hidden="true">›</span>
                          <button
                            className={crumb.id === selectedPlanFolder?.id ? 'current' : ''}
                            onClick={() => {
                              setSelectedPlanFolderId(crumb.id);
                              setPlanFolderEditor(null);
                            }}
                          >
                            {crumb.name}
                          </button>
                        </span>
                      ))}
                    </nav>
                    <button
                      className="icon-btn"
                      onClick={() => {
                        setPlanFolderDraft('');
                        setPlanFolderEditor({ kind: 'create' });
                      }}
                      title={selectedPlanFolder ? 'Create subfolder' : 'Create plan folder'}
                      aria-label={selectedPlanFolder ? 'Create subfolder' : 'Create plan folder'}
                      disabled={busy}
                    >
                      <IconPlus size={14} />
                    </button>
                  </div>

                  <p className="plan-folder-note">
                    {selectedPlanFolder
                      ? 'Plans stay in their original locations. A plan can be filed in more than one folder.'
                      : 'Organize by client, venue, quarter, or year without moving the original files.'}
                  </p>

                  {planFolders?.notice && (
                    <div className="plan-folder-warning" role="status">
                      <IconWarning size={13} />
                      <span>{planFolders.notice}</span>
                    </div>
                  )}

                  {planFolderEditor && (
                    <form className="plan-folder-editor" onSubmit={submitPlanFolder}>
                      <label htmlFor="plan-folder-name">
                        {planFolderEditor.kind === 'rename'
                          ? 'Rename folder'
                          : selectedPlanFolder
                            ? `New folder inside ${selectedPlanFolder.name}`
                            : 'New top-level folder'}
                      </label>
                      <input
                        id="plan-folder-name"
                        autoFocus
                        maxLength={80}
                        placeholder={
                          selectedPlanFolder ? 'Example: Q1 or Main Ballroom' : 'Example: 2026 or Acme Events'
                        }
                        value={planFolderDraft}
                        onChange={(event) => setPlanFolderDraft(event.target.value)}
                      />
                      <span className="plan-folder-editor-actions">
                        <button
                          className="btn-primary"
                          type="submit"
                          disabled={!planFolderDraft.trim() || busy}
                        >
                          {planFolderEditor.kind === 'rename' ? 'Rename' : 'Create'}
                        </button>
                        <button
                          className="btn-outline"
                          type="button"
                          onClick={() => {
                            setPlanFolderEditor(null);
                            setPlanFolderDraft('');
                          }}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </span>
                    </form>
                  )}

                  {selectedPlanFolder && (
                    <>
                      <div className="plan-folder-actions">
                        <button className="btn-outline" onClick={addPlansToSelectedFolder} disabled={busy}>
                          <IconPlus size={13} />
                          Add plans…
                        </button>
                        <button
                          className="btn-outline"
                          onClick={addCurrentPlanToSelectedFolder}
                          disabled={!doc || busy}
                          title={doc ? `Add ${doc.name}` : 'Open a plan first'}
                        >
                          <IconFile size={13} />
                          Add open plan
                        </button>
                      </div>
                      <div className="plan-folder-manage">
                        <button
                          className="link-btn"
                          onClick={() => {
                            setPlanFolderDraft(selectedPlanFolder.name);
                            setPlanFolderEditor({
                              kind: 'rename',
                              folderId: selectedPlanFolder.id,
                            });
                          }}
                          disabled={busy}
                        >
                          <IconEdit size={12} />
                          Rename
                        </button>
                        <button className="link-btn is-danger" onClick={deletePlanFolder} disabled={busy}>
                          <IconTrash size={12} />
                          Remove
                        </button>
                      </div>
                    </>
                  )}

                  <div className="plan-folder-content">
                    <div className="section-title">
                      <span>{selectedPlanFolder ? 'Subfolders' : 'Folders'}</span>
                      {visiblePlanFolders.length > 0 && <span className="num">{visiblePlanFolders.length}</span>}
                    </div>
                    <ul className="file-list plan-folder-list">
                      {visiblePlanFolders.map((candidate) => {
                        const childCount =
                          planFolders?.folders.filter((folder) => folder.parentId === candidate.id).length ?? 0;
                        const planCount =
                          planFolders?.plans.filter((plan) => plan.folderId === candidate.id).length ?? 0;
                        return (
                          <li key={candidate.id}>
                            <button
                              className="plan-folder-entry"
                              onClick={() => {
                                setSelectedPlanFolderId(candidate.id);
                                setPlanFolderEditor(null);
                              }}
                              title={`Open ${candidate.name}`}
                            >
                              <IconFolder size={15} />
                              <span className="plan-folder-copy">
                                <span className="fname">{candidate.name}</span>
                                <span className="plan-folder-meta">
                                  {childCount
                                    ? `${childCount} subfolder${childCount === 1 ? '' : 's'}`
                                    : `${planCount} plan${planCount === 1 ? '' : 's'}`}
                                  {childCount > 0 && planCount > 0
                                    ? ` · ${planCount} plan${planCount === 1 ? '' : 's'}`
                                    : ''}
                                </span>
                              </span>
                              <span className="plan-folder-chevron" aria-hidden="true">›</span>
                            </button>
                          </li>
                        );
                      })}
                      {visiblePlanFolders.length === 0 && (
                        <li className="empty">
                          {selectedPlanFolder
                            ? 'No subfolders here. Use + to create one.'
                            : 'No folders yet. Create one for a client, venue, quarter, or year.'}
                        </li>
                      )}
                    </ul>

                    {selectedPlanFolder && (
                      <>
                        <div className="section-title plan-folder-plans-title">
                          <span>Plans</span>
                          {visibleFolderPlans.length > 0 && <span className="num">{visibleFolderPlans.length}</span>}
                        </div>
                        <ul className="file-list plan-folder-plan-list">
                          {visibleFolderPlans.map((plan) => (
                            <li className={`plan-folder-plan${plan.missing ? ' is-missing' : ''}`} key={plan.path}>
                              <button
                                className={doc?.path === plan.path ? 'active' : ''}
                                onClick={() => load(plan.path)}
                                disabled={plan.missing || busy}
                                title={
                                  plan.missing
                                    ? `Original file not found:\n${plan.path}`
                                    : `${plan.path}\n${formatBytes(plan.size)}`
                                }
                              >
                                {plan.missing ? <IconWarning size={14} /> : <IconFile size={14} />}
                                <span className="recent-copy">
                                  <span className="recent-name">{plan.name.replace(/\.[^.]+$/, '')}</span>
                                  <span className="recent-meta">
                                    <span>{plan.missing ? 'Original file missing' : plan.sourceFolder}</span>
                                    <span aria-hidden="true">·</span>
                                    <span>{plan.extension}</span>
                                  </span>
                                </span>
                              </button>
                              <button
                                className="plan-folder-remove-plan"
                                onClick={() => void removePlanFromSelectedFolder(plan.path)}
                                title="Remove from this folder (does not delete the file)"
                                aria-label={`Remove ${plan.name} from ${selectedPlanFolder.name}`}
                                disabled={busy}
                              >
                                <IconTrash size={12} />
                              </button>
                            </li>
                          ))}
                          {visibleFolderPlans.length === 0 && (
                            <li className="empty">No plans filed here yet. Add files or the plan currently open.</li>
                          )}
                        </ul>
                      </>
                    )}
                  </div>
                </section>
              ) : planRailSource === 'folder' && folder ? (
                <>
                  <div className="folder-context">
                    <span className="folder-name" title={folder}>{folder.split(/[\\/]/).pop() || folder}</span>
                    <button
                      className="link-btn"
                      onClick={() => {
                        void api
                          .listDirectory(folder)
                          .then(setEntries)
                          .catch((err) => notify(err instanceof Error ? err.message : String(err)));
                      }}
                    >
                      Refresh
                    </button>
                    <button className="link-btn" onClick={openFolder}>Change…</button>
                  </div>
                  <div className="search">
                    <IconSearch size={13} />
                    <input
                      aria-label="Filter plans in folder"
                      placeholder="Filter plans…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </div>
                  <ul className="file-list">
                    {filtered.map((entry) => (
                      <li key={entry.path}>
                        <button
                          className={doc?.path === entry.path ? 'active' : ''}
                          onClick={() => load(entry.path)}
                          title={entry.path}
                        >
                          <IconFile size={13} />
                          <span className="fname">{entry.name.replace(/\.[^.]+$/, '')}</span>
                        </button>
                      </li>
                    ))}
                    {filtered.length === 0 && <li className="empty">No plans match that filter.</li>}
                  </ul>
                </>
              ) : planRailSource === 'folder' ? (
                <div className="rail-empty-action">
                  <p className="empty">Choose a folder to browse its plans. Recent plans remain available in the Recent tab.</p>
                  <button className="btn-outline" onClick={openFolder}>
                    <IconFolder size={14} />
                    Choose folder…
                  </button>
                </div>
              ) : planRailSource === 'equipment' ? (
                <InventoryPalette
                  inventory={inventory}
                  query={paletteQuery}
                  onQuery={setPaletteQuery}
                  category={paletteCategory}
                  onCategory={setPaletteCategory}
                  canPlace={!!doc?.editable}
                  onPlace={(id, name) => {
                    armInventory(id, name);
                  }}
                  onChanged={inventoryChanged}
                  onRemoved={(name) => setInventoryUndoNotice(`Removed “${name}” from inventory`)}
                  onError={notify}
                  onStatus={showStatus}
                />
              ) : (
                <>
                  {recoveries.length > 0 && (
                    <section className="recovery-panel" aria-label="Recover unsaved work">
                      <div className="section-title">
                        <span>Recover unsaved work</span>
                        <span className="num">{recoveries.length}</span>
                      </div>
                      <ul className="recovery-list">
                        {recoveries.map((entry) => {
                          const updatedAt = Date.parse(entry.updatedAt);
                          return (
                            <li className="recovery-item" key={entry.id} title={entry.sourcePath}>
                              <IconWarning size={14} />
                              <span className="recovery-copy">
                                <strong>{entry.displayName}</strong>
                                <span>
                                  {entry.kind === 'plan' ? 'Plan' : 'Gear'} ·{' '}
                                  {Number.isFinite(updatedAt) ? formatRecentTime(updatedAt) : 'Recovered work'} ·{' '}
                                  {formatBytes(entry.byteLength)}
                                </span>
                              </span>
                              <span className="recovery-actions">
                                <button
                                  className="btn-outline"
                                  onClick={() => void openRecovery(entry)}
                                  disabled={busy}
                                  aria-label={`Open recovered ${entry.kind} ${entry.displayName}`}
                                >
                                  Open
                                </button>
                                <button
                                  className="btn-danger"
                                  onClick={() => void dismissRecovery(entry)}
                                  disabled={busy}
                                  aria-label={`Discard recovered ${entry.kind} ${entry.displayName}`}
                                >
                                  Dismiss
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}
                  <section className="recent-panel" aria-label="Recent plans">
                    <div className="section-title">
                      <span>Recent plans</span>
                      {recent.length > 0 && <span className="num">{recent.length}</span>}
                    </div>
                    <ul className="file-list recent-list">
                      {recent.map((entry) => (
                        <li key={entry.path}>
                          <button
                            className={`recent-file${doc?.path === entry.path ? ' active' : ''}`}
                            onClick={() => load(entry.path)}
                            title={`${entry.path}\n${formatBytes(entry.size)} · Opened ${formatRecentTime(entry.openedAt).toLowerCase()}`}
                          >
                            <IconFile size={14} />
                            <span className="recent-copy">
                              <span className="recent-name">{entry.name.replace(/\.[^.]+$/, '')}</span>
                              <span className="recent-meta">
                                <span>{entry.folder}</span>
                                <span aria-hidden="true">·</span>
                                <span>{formatRecentTime(entry.openedAt)}</span>
                              </span>
                            </span>
                            <span className="recent-ext">{entry.extension}</span>
                          </button>
                        </li>
                      ))}
                      {recent.length === 0 && (
                        <li className="empty">Nothing opened yet. Choose a plan or a folder to begin.</li>
                      )}
                    </ul>
                  </section>
                </>
              )}
            </>
          )}
        </aside>

        <main
          className={
            `stage${view === 'plan' && doc?.recovered ? ' has-recovery' : ''}` +
            `${view === 'plan' && doc?.dimensionWarning ? ' has-dimension-warning' : ''}`
          }
        >
          {view === 'inventory' ? (
            <InventoryView
              inventory={inventory}
              query={libQuery}
              department={libDept}
              onChanged={inventoryChanged}
              onRemoved={(name) => setInventoryUndoNotice(`Removed “${name}” from inventory`)}
              canPlace={!!doc?.editable}
              onPlace={(id, name) => {
                armInventory(id, name);
                setView('plan');
              }}
              onError={notify}
              onStatus={showStatus}
            />
          ) : view === 'gear' ? (
            gear ? (
              <GearView
                lists={gear.lists}
                totals={gear.totals}
                activeIndex={gearIndex}
                onActiveIndex={setGearIndex}
                query={gearQuery}
                onApplied={(next) => setGear(next as typeof gear)}
                onError={notify}
                canPlace={!!doc?.editable}
                notice={gear.notice}
                onPlace={(description) => {
                  armGear(description);
                  setView('plan');
                }}
              />
            ) : (
              <div className="placeholder">
                <Mark size={34} className="placeholder-mark" />
                <h1>No gear list open</h1>
                <p>
                  Import the gear list your rental system prints and Groundplan rebuilds it as an inventory —
                  departments, packages and every piece inside them.
                </p>
                <div className="placeholder-actions">
                  <button className="btn-outline" onClick={importGear}>
                    <IconFile />
                    Import PDF…
                  </button>
                  <button className="btn-outline" onClick={openGear}>
                    <IconFolder />
                    Open gear list…
                  </button>
                </div>
              </div>
            )
          ) : doc ? (
            <PlanCanvas
              scene={doc.scene}
              visibleLayers={visible}
              paper={paper}
              showGrid={showGrid}
              fitToken={fitToken}
              selection={selectedIds}
              onSelect={setSelectedIds}
              onMoveSelection={moveSelection}
              editable={doc.editable}
              onCursor={setCursor}
              onZoom={setZoom}
              armed={armed}
              onPlaceAt={placeArmed}
              onDropItem={dropItem}
              snapStep={snapStep}
              measuring={measuring}
              measureFrom={measureFrom}
              measurement={measurement}
              dimensioning={dimensioning || drawTool !== null}
              dimensionFrom={drawTool ? drawFrom : dimensionFrom}
              drawTool={drawTool}
              onMeasurePoint={async (p) => {
                if (drawTool) {
                  if (!drawFrom) {
                    setDrawFrom({ x: p.x, y: p.y });
                    return;
                  }
                  const reply = await api.draw(drawTool, drawFrom.x, drawFrom.y, p.x, p.y);
                  applied(reply);
                  if (reply.ok) showStatus(`Drew a ${drawTool === 'rect' ? 'rectangle' : drawTool}`);
                  // The tool stays in hand, the way a drawing app works: one
                  // click of the button, several shapes.
                  setDrawFrom(null);
                  return;
                }
                if (dimensioning) {
                  if (!dimensionFrom) {
                    setDimensionFrom(p);
                    return;
                  }
                  const reply = await api.addDimension(
                    dimensionFrom.x,
                    dimensionFrom.y,
                    p.x,
                    p.y,
                    dimensionFrom.nodeId,
                    p.nodeId,
                  );
                  applied(reply);
                  if (reply.ok) showStatus('Added dimension');
                  setDimensionFrom(null);
                  setDimensioning(false);
                  return;
                }
                if (!measureFrom) {
                  setMeasureFrom(p);
                  setMeasurement(null);
                } else {
                  setMeasurement({ from: measureFrom, to: p });
                  setMeasureFrom(null);
                }
              }}
            />
          ) : (
            <div className="placeholder">
              <Mark size={34} className="placeholder-mark" />
              <h1>Start a plan</h1>
              <p>
                Create one from nothing, or open an existing Room Viewer file — <code>.rv4</code>,{' '}
                <code>.rs4</code>, <code>.se4</code>, <code>.rsd</code> — plus <code>.add</code>,{' '}
                <code>.stk</code> and <code>.lib</code> shape libraries. Nothing is converted.
              </p>
              <div className="placeholder-actions">
                <button className="btn-solid" onClick={() => setNewPlanOpen(true)}>
                  <IconPlus />
                  New plan
                </button>
                <button className="btn-outline" onClick={openFile}>
                  <IconFile />
                  Open plan
                </button>
                <button className="btn-outline" onClick={openFolder}>
                  <IconFolder />
                  Open folder
                </button>
              </div>
              <p style={{ marginTop: 4 }}>
                <kbd>{shortcut('N')}</kbd> for a new plan, <kbd>{shortcut('O')}</kbd> to open one,{' '}
                <kbd>{shortcut('O', true)}</kbd> for a folder
              </p>
            </div>
          )}
          {view === 'plan' && doc?.recovered && (
            <div className="recovered-plan-banner" role="alert">
              <IconWarning size={14} />
              <span>
                <strong>Recovered unsaved plan.</strong> Review this version, then save it to keep the work.
              </span>
              <button className="btn-outline" onClick={() => void save(true)}>
                Save a copy…
              </button>
            </div>
          )}
          {view === 'plan' && doc?.dimensionWarning && (
            <div className="dimension-warning-banner" role="alert">
              <IconWarning size={14} />
              <span>
                <strong>Dimension links need attention.</strong> {doc.dimensionWarning}
              </span>
            </div>
          )}
          {printOpen && doc && (
            <div className="print-panel">
              <div className="section-title">
                <span>Print to PDF</span>
              </div>
              <div className="field">
                <label htmlFor="p-scale">Scale</label>
                <select id="p-scale" value={printScale} onChange={(e) => setPrintScale(e.target.value)}>
                  <option value="1/16">1/16″ = 1′-0″</option>
                  <option value="3/32">3/32″ = 1′-0″</option>
                  <option value="1/8">1/8″ = 1′-0″</option>
                  <option value="3/16">3/16″ = 1′-0″</option>
                  <option value="1/4">1/4″ = 1′-0″</option>
                  <option value="fit">Fit to page</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="p-paper">Paper</label>
                <select id="p-paper" value={printPaper} onChange={(e) => setPrintPaper(e.target.value)}>
                  <option value="Letter">Letter</option>
                  <option value="Legal">Legal</option>
                  <option value="Tabloid">Tabloid 11×17</option>
                  <option value="A4">A4</option>
                  <option value="A3">A3</option>
                </select>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={printLandscape}
                  onChange={(e) => setPrintLandscape(e.target.checked)}
                />
                <span>Landscape</span>
              </label>
              <div className="actions-row">
                <button onClick={() => setPrintOpen(false)}>Cancel</button>
                <button className="btn-primary" onClick={printPdf}>
                  Print
                </button>
              </div>
              <p className="hint">
                A fixed scale prints to size and may crop a large room; the title block records which scale was
                used.
              </p>
            </div>
          )}
          {(measuring || dimensioning) && (
            <div className="arming" role="status" aria-live="polite">
              <span className={`tool-state-badge ${dimensioning ? 'is-persistent' : 'is-temporary'}`}>
                {dimensioning ? 'Saved dimension' : 'Temporary measure'}
              </span>
              <span>
                {dimensioning
                  ? dimensionFrom
                    ? 'Click the dimension end point'
                    : 'Click the dimension start point'
                  : measureFrom
                    ? 'Click the second point'
                    : measurement
                      ? 'Review the distance, save it, or click to start another'
                      : 'Click the first point to measure from'}
              </span>
              {measuring && measurement && (
                <button
                  className="btn-primary"
                  onClick={keepMeasurement}
                  disabled={!canCreateDimension}
                  title={
                    canCreateDimension
                      ? 'Keep this distance as an object-linked plan dimension'
                      : 'This plan is read-only'
                  }
                >
                  Save dimension
                </button>
              )}
              <button
                onClick={() => {
                  setMeasuring(false);
                  setMeasureFrom(null);
                  setMeasurement(null);
                  setDimensioning(false);
                  setDimensionFrom(null);
                }}
              >
                Done
              </button>
            </div>
          )}
          {armed && (
            <div className="arming">
              <span>
                Click the plan to place <strong>{armed}</strong>
              </span>
              <button onClick={cancelPlacement}>Cancel</button>
            </div>
          )}
          {busy && <div className="toast" role="status">{busyMessage ?? 'Working…'}</div>}
          {status && <div className="toast toast-ok" role="status">{status}</div>}
          {inventoryUndoNotice && (
            <div className="toast toast-ok toast-action" role="status">
              <span>{inventoryUndoNotice}</span>
              <button className="btn-outline" onClick={() => void restoreInventoryItem()}>
                Undo
              </button>
              <button onClick={() => setInventoryUndoNotice(null)}>Dismiss</button>
            </div>
          )}
          {saveConflict && (
            <div className="toast toast-error toast-action" role="alert">
              <IconWarning />
              <span>{saveConflict}</span>
              <button className="btn-outline" onClick={() => void save(true)}>
                Save a copy…
              </button>
              <button onClick={() => setSaveConflict(null)}>Dismiss</button>
            </div>
          )}
          {error && (
            <div className="toast toast-error" role="alert">
              <IconWarning />
              {error}
            </div>
          )}
        </main>

        <aside className="inspector" aria-hidden={!inspectorOpen}>
          {view === 'inventory' ? (
            <>
              <div className="section">
                <div className="section-title">
                  <span>Equipment inventory</span>
                </div>
                <dl className="facts">
                  <div>
                    <dt>Items</dt>
                    <dd className="num">{(inventory?.total ?? 0).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Departments</dt>
                    <dd className="num">{inventory?.departments.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Showing</dt>
                    <dd className="num">{(inventory?.items.length ?? 0).toLocaleString()}</dd>
                  </div>
                </dl>
                <p className="hint">
                  Kept for the company, not the job — it builds up as you import gear lists.
                </p>
              </div>

              <div className="section">
                <div className="section-title">
                  <span>Add to inventory</span>
                </div>
                <button
                  className="btn-outline"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={!gear}
                  title={gear ? 'Add every line of the open gear list' : 'Open a gear list first'}
                  onClick={async () => {
                    const reply = await api.inventoryAbsorbGear();
                    if (reply.ok && reply.inventory) {
                      setInventory(reply.inventory as InventoryState);
                      showStatus(`Added ${reply.added} new, updated ${reply.updated}`);
                    } else if (reply.reason) notify(reply.reason);
                  }}
                >
                  <IconPlus size={14} />
                  Add the open gear list
                </button>
                <p className="hint">
                  Or use <strong>Upload…</strong> for gear-list PDFs, spreadsheets, and existing plans or shape
                  libraries — those bring their drawn symbols with them.
                </p>
              </div>

              <div className="section">
                <div className="section-title">
                  <span>Sizes</span>
                </div>
                <p className="hint">
                  A size in blue was set by you and is used exactly when placing. Anything else was guessed from
                  the item name — click it to correct it once and it sticks.
                </p>
              </div>
            </>
          ) : view === 'gear' ? (
            gear && gear.lists[gearIndex] ? (
              <GearSummary
                list={gear.lists[gearIndex]}
                totals={gear.totals[gearIndex]}
                listIndex={gearIndex}
                onError={notify}
                hasPlan={!!doc}
                planName={doc?.name}
                planRevision={doc?.revision}
                planPath={doc?.path}
                gearPath={gear.path}
                gearDirty={gear.dirty}
                onDoc={(next) => setDoc(next as Doc)}
                onStatus={showStatus}
              />
            ) : (
              <div className="section">
                <div className="section-title">
                  <span>No gear list</span>
                </div>
                <p className="hint">Totals and prep progress appear here once a list is loaded.</p>
              </div>
            )
          ) : doc ? (
            <>
              <nav className="inspector-tabs" aria-label="Plan inspector">
                {([
                  ['properties', 'Properties'],
                  ['room', 'Room'],
                  ['create', 'Create'],
                  ['layers', 'Layers'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    className={inspectorTab === id ? 'active' : ''}
                    onClick={() => setInspectorTab(id)}
                    aria-current={inspectorTab === id ? 'page' : undefined}
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {inspectorTab === 'properties' && (
                <>
              <div className="section">
                <div className="section-title">
                  <span>{doc.scene.title ?? 'Plan'}</span>
                </div>
                <dl className="facts">
                  <div>
                    <dt>Room</dt>
                    <dd className="num">
                      {extent
                        ? `${formatFeet(extent.maxX - extent.minX)} × ${formatFeet(extent.maxY - extent.minY)}`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Objects</dt>
                    <dd className="num">{doc.scene.primitives.length.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>File</dt>
                    <dd className="num">{formatBytes(doc.byteLength)}</dd>
                  </div>
                </dl>

                {(doc.repaired || doc.warnings > 0 || !doc.editable) && (
                  <div className="notice" style={{ marginTop: 12 }}>
                    <IconWarning size={14} />
                    <div>
                      {doc.repaired && <p>Recovered from a damaged file — some geometry may be missing.</p>}
                      {doc.warnings > 0 && (
                        <p>
                          {doc.warnings} object{doc.warnings === 1 ? '' : 's'} could not be decoded.
                        </p>
                      )}
                      {!doc.editable && <p>Read-only: this file does not reproduce byte for byte.</p>}
                    </div>
                  </div>
                )}
              </div>

              {selectedIds.length > 0 && (
                <div className="section edit-tools">
                  <div className="section-title">
                    <span>Edit tools</span>
                    <span className="num">{selectedIds.length}</span>
                  </div>

                  {canTransformSelection && (
                    <div className="tool-group">
                      <span className="tool-label">Rotate & mirror</span>
                      <div className="rotation-row">
                        <input
                          className="num"
                          type="number"
                          min={-3600}
                          max={3600}
                          step={15}
                          value={rotationDraft}
                          onChange={(event) => setRotationDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') rotateByDraft();
                          }}
                          aria-label="Rotation in degrees"
                          disabled={!doc.editable}
                        />
                        <span>°</span>
                        <button onClick={rotateByDraft} disabled={!doc.editable}>
                          Rotate
                        </button>
                      </div>
                      <div className="arrange-grid two">
                        <button onClick={() => flipSelection('horizontal')} disabled={!doc.editable} title="Mirror left to right">
                          ↔ Flip horizontal
                        </button>
                        <button onClick={() => flipSelection('vertical')} disabled={!doc.editable} title="Mirror top to bottom">
                          ↕ Flip vertical
                        </button>
                      </div>
                    </div>
                  )}

                  {selectedIds.length > 1 && (
                    <div className="tool-group">
                      <span className="tool-label">Align selection</span>
                      <div className="arrange-grid three">
                        <button onClick={() => arrangeSelection('align-left')} disabled={!doc.editable}>Left</button>
                        <button onClick={() => arrangeSelection('align-center')} disabled={!doc.editable}>Center</button>
                        <button onClick={() => arrangeSelection('align-right')} disabled={!doc.editable}>Right</button>
                        <button onClick={() => arrangeSelection('align-top')} disabled={!doc.editable}>Top</button>
                        <button onClick={() => arrangeSelection('align-middle')} disabled={!doc.editable}>Middle</button>
                        <button onClick={() => arrangeSelection('align-bottom')} disabled={!doc.editable}>Bottom</button>
                      </div>
                      <div className="arrange-grid two">
                        <button
                          onClick={() => arrangeSelection('distribute-horizontal')}
                          disabled={!doc.editable || selectedIds.length < 3}
                          title="Give selected items equal horizontal spacing"
                        >
                          Space across
                        </button>
                        <button
                          onClick={() => arrangeSelection('distribute-vertical')}
                          disabled={!doc.editable || selectedIds.length < 3}
                          title="Give selected items equal vertical spacing"
                        >
                          Space down
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="tool-group">
                    <span className="tool-label">Line colour</span>
                    <div className="colour-row">
                      <input
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(colorDraft) ? colorDraft : '#000000'}
                        onChange={(event) => setColorDraft(event.target.value)}
                        aria-label="Line colour"
                        disabled={!doc.editable}
                      />
                      <input
                        value={colorDraft}
                        onChange={(event) => setColorDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void applyColor();
                        }}
                        aria-label="Hex line colour"
                        disabled={!doc.editable}
                      />
                      <button onClick={() => void applyColor()} disabled={!doc.editable}>
                        Apply
                      </button>
                    </div>
                    <div className="colour-presets" aria-label="Colour presets">
                      {['#20252b', '#ffffff', '#4d94ff', '#e05252', '#e6a73d', '#4fb879', '#9b7bd8'].map((hex) => (
                        <button
                          key={hex}
                          className={colorDraft.toLowerCase() === hex ? 'active' : ''}
                          style={{ '--swatch-colour': hex } as React.CSSProperties}
                          onClick={() => void applyColor(hex)}
                          disabled={!doc.editable}
                          aria-label={`Apply ${hex}`}
                          title={hex}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="section">
                <div className="section-title">
                  <span>Selection</span>
                </div>
                {selectedIds.length > 1 ? (
                  <>
                    <dl className="facts">
                      <div>
                        <dt>Selected</dt>
                        <dd className="num">{selectedIds.length} items</dd>
                      </div>
                    </dl>
                    <div className="actions-row">
                      <button onClick={() => rotateSelection(-90)} disabled={!doc.editable} title="Rotate left 90° ( [ )">
                        ⟲ 90°
                      </button>
                      <button onClick={() => rotateSelection(90)} disabled={!doc.editable} title="Rotate right 90° ( ] )">
                        ⟳ 90°
                      </button>
                    </div>
                    <div className="actions-row">
                      <button onClick={duplicateSelection} disabled={!doc.editable} title="Duplicate (Cmd/Ctrl+D)">
                        <IconDuplicate size={14} />
                        Duplicate
                      </button>
                      <button className="btn-danger" onClick={deleteSelection} disabled={!doc.editable} title="Delete (Del)">
                        <IconTrash size={14} />
                        Delete
                      </button>
                    </div>
                    <p className="hint">
                      Drag any one to move them together. Shift-click to add or remove; drag empty space to band-select.
                    </p>
                  </>
                ) : selection ? (
                  <>
                    <dl className="facts">
                      <div>
                        <dt>Item</dt>
                        <dd>{selection.name ?? selection.cls.replace(/^RV/, '')}</dd>
                      </div>
                      <div>
                        <dt>Size</dt>
                        <dd className="num">
                          {formatLength(selection.widthUnits, unitSystem)} ×{' '}
                          {formatLength(selection.heightUnits, unitSystem)}
                        </dd>
                      </div>
                      <div>
                        <dt>Centre</dt>
                        <dd className="num">
                          {formatLength(selection.x, unitSystem)}, {formatLength(selection.y, unitSystem)}
                        </dd>
                      </div>
                    </dl>

                    {selection.canRelabel && (
                      <div className="field">
                        <label htmlFor="label-text">Text</label>
                        <textarea
                          id="label-text"
                          rows={3}
                          value={labelDraft}
                          onChange={(e) => setLabelDraft(e.target.value)}
                          onBlur={async () => {
                            if (!selection || labelDraft === (selection.text ?? '')) return;
                            applied(
                              (await api.relabel(selection.nodeId, labelDraft)) as {
                                ok: boolean;
                                reason?: string;
                                doc?: Doc;
                              },
                            );
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              (e.target as HTMLTextAreaElement).blur();
                            }
                          }}
                          disabled={!doc.editable}
                        />
                        <span className="field-help">Press {api.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter to apply.</span>
                      </div>
                    )}

                    {canTransformSelection && (
                      <div className="actions-row">
                        <button
                          onClick={() => rotateSelection(-90)}
                          disabled={!doc.editable}
                          title="Rotate left 90° ( [ )"
                        >
                          ⟲ 90°
                        </button>
                        <button
                          onClick={() => rotateSelection(90)}
                          disabled={!doc.editable}
                          title="Rotate right 90° ( ] )"
                        >
                          ⟳ 90°
                        </button>
                      </div>
                    )}

                    {canResizeSelection && (
                      <div className="field">
                        <label htmlFor="size-w">
                          Size ({unitSystem === 'metric' ? 'metric' : 'ft / in'})
                        </label>
                        <div className="size-row">
                          <input
                            id="size-w"
                            className="num"
                            value={sizeDraft.width}
                            onChange={(event) => setSizeDraft((current) => ({ ...current, width: event.target.value }))}
                            disabled={!doc.editable}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitSelectionSize();
                            }}
                            aria-label="Selection width"
                            placeholder={unitSystem === 'metric' ? '1.2m' : "4'"}
                          />
                          <span className="inv-x">×</span>
                          <input
                            className="num"
                            value={sizeDraft.height}
                            onChange={(event) => setSizeDraft((current) => ({ ...current, height: event.target.value }))}
                            disabled={!doc.editable}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitSelectionSize();
                            }}
                            aria-label="Selection height"
                            placeholder={unitSystem === 'metric' ? '0.8m' : "3'"}
                          />
                          <button
                            onClick={() => void commitSelectionSize()}
                            disabled={!doc.editable}
                            title="Apply width and height together"
                          >
                            Apply
                          </button>
                        </div>
                      </div>
                    )}

                    {canPositionSelection && (
                      <div className="field">
                        <label htmlFor="pos-x">Position (centre)</label>
                        <div className="size-row">
                          <input
                            id="pos-x"
                            className="num"
                            value={positionDraft.x}
                            onChange={(event) =>
                              setPositionDraft((current) => ({ ...current, x: event.target.value }))
                            }
                            disabled={!doc.editable}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitSelectionPosition();
                            }}
                            aria-label="Selection centre X"
                            placeholder="X"
                          />
                          <span className="inv-x">,</span>
                          <input
                            className="num"
                            value={positionDraft.y}
                            onChange={(event) =>
                              setPositionDraft((current) => ({ ...current, y: event.target.value }))
                            }
                            disabled={!doc.editable}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitSelectionPosition();
                            }}
                            aria-label="Selection centre Y"
                            placeholder="Y"
                          />
                          <button
                            onClick={() => void commitSelectionPosition()}
                            disabled={!doc.editable}
                            title="Move the selection centre to these coordinates"
                          >
                            Move
                          </button>
                        </div>
                        <span className="field-help">
                          Type exact plan coordinates. Drag and arrow keys still work.
                        </span>
                      </div>
                    )}

                    <div className="actions-row">
                      <button onClick={duplicateSelection} disabled={!doc.editable} title="Duplicate (Cmd/Ctrl+D)">
                        <IconDuplicate size={14} />
                        Duplicate
                      </button>
                      <button
                        className="btn-danger"
                        onClick={deleteSelection}
                        disabled={!doc.editable || !selection.canDelete}
                        title={selection.canDelete ? 'Delete (Del)' : 'Shared with other items'}
                      >
                        <IconTrash size={14} />
                        Delete
                      </button>
                    </div>
                    <p className="hint">Drag to move. Arrows nudge a foot, Shift an inch.</p>
                  </>
                ) : (
                  <p className="hint">
                    {doc.editable
                      ? 'Click an item to select it. Shift-click to add more, or drag across empty space to band-select.'
                      : 'This plan is read-only, so items cannot be changed.'}
                  </p>
                )}
              </div>
                </>
              )}

              {inspectorTab === 'room' && (
                <RoomPanel
                  doc={doc}
                  onDoc={setDoc}
                  onStatus={showStatus}
                  onError={setError}
                  onSelect={(ids) => {
                    setSelectedIds(ids);
                    setSelection(null);
                  }}
                />
              )}

              {inspectorTab === 'create' && (
                <>
              <div className="section">
                <div className="section-title">
                  <span>Annotate</span>
                </div>
                <div className="field annotation-field">
                  <label htmlFor="annotation-text">Label text</label>
                  <textarea
                    id="annotation-text"
                    ref={annotationInputRef}
                    rows={3}
                    value={annotationDraft}
                    placeholder="Stage, screen, room note…"
                    onChange={(e) => setAnnotationDraft(e.target.value)}
                    disabled={!canCreateLabel}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        armLabel();
                      }
                    }}
                  />
                </div>
                {annotationCapabilityHint && (
                  <div className="notice annotation-capability-notice" role="status">
                    <IconWarning size={14} />
                    <span>{annotationCapabilityHint}</span>
                  </div>
                )}
                <div className="actions-row">
                  <button
                    onClick={armLabel}
                    disabled={!canCreateLabel || !annotationDraft.trim()}
                    title={
                      canCreateLabel
                        ? 'Place this label on the plan'
                        : 'Unavailable: this plan is read-only'
                    }
                  >
                    <IconPlus size={14} />
                    Place label
                  </button>
                  <button
                    className={dimensioning ? 'is-on' : ''}
                    onClick={toggleDimension}
                    disabled={!canCreateDimension}
                    title={
                      canCreateDimension
                        ? 'Draw an object-linked dimension (D)'
                        : 'Unavailable: this plan is read-only'
                    }
                  >
                    <IconRuler size={14} />
                    Dimension
                  </button>
                </div>
                <p className="hint">
                  {canCreateDimension ? (
                    <>
                      <kbd>M</kbd> measures temporarily; choose <strong>Save dimension</strong> to keep it, or press{' '}
                      <kbd>D</kbd> to draw one directly. An endpoint clicked on an object follows that object when it
                      moves or rotates; an empty-space endpoint stays fixed.
                    </>
                  ) : (
                    <>
                      Use <kbd>M</kbd> for a temporary distance. This plan is read-only, so it cannot store new dimensions.
                    </>
                  )}{' '}
                  {canCreateLabel ? (
                    <>
                      Press <kbd>T</kbd> to place a label.
                    </>
                  ) : (
                    'New labels need an editable plan.'
                  )}
                </p>
              </div>

              <div className="section">
                <div className="section-title">
                  <span>Add seating</span>
                </div>
                <p className="hint" style={{ marginBottom: 10 }}>
                  Quick blocks placed where you click. For a full room layout with aisles, splay, and a live seat
                  count, use the <strong>Room</strong> tab.
                </p>
                <button
                  type="button"
                  className="btn-outline"
                  style={{ width: '100%', justifyContent: 'center', marginBottom: 12 }}
                  onClick={() => setInspectorTab('room')}
                >
                  Open Room seating
                </button>
                <div className="seg tabs seat-kinds">
                  {(['round', 'theatre', 'schoolroom'] as const).map((k) => (
                    <button key={k} className={seatKind === k ? 'active' : ''} onClick={() => setSeatKind(k)}>
                      {k === 'round' ? 'Round' : k === 'theatre' ? 'Theatre' : 'Classroom'}
                    </button>
                  ))}
                </div>

                {seatKind !== 'theatre' && (
                  <div className="field">
                    <label htmlFor="seat-table">Table</label>
                    <select
                      id="seat-table"
                      value={seatTable}
                      onChange={(e) => setSeatTable(e.target.value)}
                      disabled={!doc.editable}
                    >
                      <option value="">Choose…</option>
                      {doc.scene.inventory.map((i) => (
                        <option key={i.name} value={i.name}>
                          {i.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="field">
                  <label htmlFor="seat-chair">Chair</label>
                  <select
                    id="seat-chair"
                    value={seatChair}
                    onChange={(e) => setSeatChair(e.target.value)}
                    disabled={!doc.editable}
                  >
                    <option value="">Choose…</option>
                    {doc.scene.inventory.map((i) => (
                      <option key={i.name} value={i.name}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </div>

                {seatKind === 'round' ? (
                  <div className="field">
                    <label htmlFor="seat-count">Seats per table</label>
                    <input
                      id="seat-count"
                      className="num"
                      type="number"
                      min={1}
                      max={24}
                      value={seatCount}
                      onChange={(e) => setSeatCount(Number(e.target.value))}
                      disabled={!doc.editable}
                    />
                  </div>
                ) : (
                  <div className="field">
                    <label>Rows × per row</label>
                    <div className="size-row">
                      <input
                        className="num"
                        type="number"
                        min={1}
                        max={60}
                        value={seatRows}
                        onChange={(e) => setSeatRows(Number(e.target.value))}
                        disabled={!doc.editable}
                      />
                      <span className="inv-x">×</span>
                      <input
                        className="num"
                        type="number"
                        min={1}
                        max={80}
                        value={seatPerRow}
                        onChange={(e) => setSeatPerRow(Number(e.target.value))}
                        disabled={!doc.editable}
                      />
                    </div>
                  </div>
                )}

                <button
                  className="btn-outline"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                  disabled={!doc.editable || !seatChair || (seatKind !== 'theatre' && !seatTable)}
                  onClick={() => {
                    cancelPlacement();
                    setMeasuring(false);
                    setMeasureFrom(null);
                    setMeasurement(null);
                    setDimensioning(false);
                    setDimensionFrom(null);
                    setArmedSeating({
                      kind: seatKind,
                      chair: seatChair,
                      table: seatTable || undefined,
                      seats: seatCount,
                      rows: seatRows,
                      perRow: seatPerRow,
                    });
                    setArmed(
                      seatKind === 'round'
                        ? `${seatTable} with ${seatCount} seats`
                        : `${seatRows} × ${seatPerRow} ${seatKind}`,
                    );
                  }}
                >
                  <IconPlus size={14} />
                  Place on plan
                </button>
                <p className="hint">
                  {seatKind === 'round'
                    ? 'Chairs are turned to face the table.'
                    : 'Rows are centred on where you click.'}
                </p>
              </div>
                </>
              )}

              {inspectorTab === 'layers' && (
                <>
              <div className="section">
                <div className="section-title">
                  <span>Layers</span>
                </div>
                <ul className="layers">
                  {LAYERS.map((l) => (
                    <li key={l.id}>
                      <label>
                        <input type="checkbox" checked={visible.has(l.id)} onChange={() => toggleLayer(l.id)} />
                        <span className="swatch" style={{ background: l.tint }} />
                        <span>{l.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>

              {doc.scene.inventory.length > 0 && (
                <div className="section">
                  <div className="section-title">
                    <span>In this plan</span>
                    <span className="num">{inventoryTotal.toLocaleString()}</span>
                  </div>
                  <div className="search inv-search">
                    <IconSearch size={13} />
                    <input
                      aria-label="Search items in this plan"
                      placeholder="Search items…"
                      value={invQuery}
                      onChange={(e) => setInvQuery(e.target.value)}
                    />
                  </div>
                  <p className="hint" style={{ margin: '0 0 8px' }}>
                    Click an item to place another one.
                  </p>
                  <ul className="inventory">
                    {doc.scene.inventory
                      .filter((i) =>
                        invQuery.trim()
                          ? i.name.toLowerCase().includes(invQuery.trim().toLowerCase()) ||
                            (i.category ?? '').toLowerCase().includes(invQuery.trim().toLowerCase())
                          : true,
                      )
                      .map((item) => (
                      <li key={item.name}>
                        <button
                          className="inv-add"
                          disabled={!doc.editable}
                          title={doc.editable ? `Place another ${item.name}` : 'This plan is read-only'}
                          onClick={() => armGear(item.name)}
                        >
                          <span className="iname">
                            {item.name}
                            {item.category && <em className="icat">{item.category}</em>}
                          </span>
                          <span className="icount num">{item.count}</span>
                          <IconPlus size={12} className="inv-plus" />
                        </button>
                      </li>
                      ))}
                  </ul>
                  <div className="actions-row">
                    <button
                      onClick={async () => {
                        const saved = await api.scheduleExport(true);
                        if (saved) {
                          showStatus(`Exported ${saved.split(/[\\/]/).pop()}`);
                        }
                      }}
                    >
                      Counts CSV
                    </button>
                    <button
                      onClick={async () => {
                        const saved = await api.scheduleExport(false);
                        if (saved) {
                          showStatus(`Exported ${saved.split(/[\\/]/).pop()}`);
                        }
                      }}
                    >
                      Full schedule
                    </button>
                  </div>
                  <p className="hint">
                    The full schedule lists every placed item with its position and rotation.
                  </p>
                </div>
              )}
                </>
              )}
            </>
          ) : (
            <div className="section">
              <div className="section-title">
                <span>No plan open</span>
              </div>
              <p className="hint">Details, layers and the item inventory appear here once a plan is open.</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="statusbar">
        <span className="status-context">
          {view === 'plan'
            ? doc?.path ?? 'No plan open'
            : view === 'gear'
              ? gear?.path ?? gear?.lists[gearIndex]?.title ?? 'No gear list open'
              : `${inventory?.total ?? 0} equipment items · saved automatically`}
        </span>
        <div className="spacer" />
        {view === 'plan' && cursor && (
          <>
            <span className="num">
              {formatFeetInches(cursor.x)}, {formatFeetInches(cursor.y)}
            </span>
            <span className="status-sep" />
          </>
        )}
        {view === 'plan' && selection && (
          <>
            <span>{selection.name ?? selection.cls.replace(/^RV/, '')} selected</span>
            <span className="status-sep" />
          </>
        )}
        {view === 'plan' && doc && <span className="num">{Math.round(zoom * 1000) / 10}%</span>}
      </footer>
    </div>
  );
}
