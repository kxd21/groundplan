import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { formatLength, parseLength } from '../../format/units.js';
import { PlanCanvas } from './PlanCanvas.js';
import { GearView, GearSummary } from './GearView.js';
import { GearPalette } from './GearPalette.js';
import { InventoryView, type InventoryState } from './InventoryView.js';
import { InventoryPalette } from './InventoryPalette.js';
import { SettingsDialog } from './SettingsDialog.js';
import { toSvg } from './svg.js';
import {
  DIMENSION,
  HAND,
  MEASURE,
  SELECT,
  banner as toolBanner,
  drawChoice,
  escapeAlsoClearsSelection,
  isPressed,
  labelChoice,
  opensProperties,
  pointerSpec,
  roomOutlineChoice,
  type PendingEffect,
} from './tool/machine.js';
import { runEffect } from './tool/effects.js';
import { useTool } from './tool/use-tool.js';
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
  IconGrid,
  IconLayers,
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
  IconDrawPolygon,
  IconPointer,
  IconText,
  IconRotateLeft,
  IconRotateRight,
  IconBringFront,
  IconSendBack,
  IconFlipHorizontal,
  IconFlipVertical,
  IconAlignLeft,
  IconAlignCenter,
  IconAlignRight,
  IconAlignTop,
  IconAlignMiddle,
  IconAlignBottom,
  IconDistributeHorizontal,
  IconDistributeVertical,
  IconHelp,
} from './icons.js';
import type { Layer, Scene } from '../../format/scene.js';
import RoomPanel from './RoomPanel.js';
import { countFurniture } from './furniture-counts.js';
import ObjectPalette from './ObjectPalette.js';
import InsertPicker from './InsertPicker.js';
import ShapeEditorWizard from './ShapeEditorWizard.js';
import BuildStageDialog from './BuildStageDialog.js';
import { flattenInsertLeaves, matchInsertItem, type InsertGroupId } from '../../inventory/insert-catalog.js';
import NewPlanDialog from './NewPlanDialog.js';
import type { GearList, GearTotals } from '../../gear/model.js';
import type { GroundplanApi } from '../../preload/index.js';

declare global {
  interface Window {
    groundplan: GroundplanApi;
  }
}

const api = window.groundplan;

type LayerGroupId = 'structure' | 'content' | 'markup';

interface LayerListItem {
  selectId: number;
  label: string;
  kind: string;
  x?: number;
  y?: number;
  searchText: string;
}

const LAYER_ITEM_KINDS: Record<string, string> = {
  RVSegmentLine: 'Line',
  RVSegmentRect: 'Rectangle',
  RVSegmentPoly: 'Polyline',
  RVSegmentArc: 'Curve',
  RVSegmentOle: 'Embedded object',
  RVDimensionLine: 'Dimension',
  RVLabel: 'Label',
};

const LAYER_GROUPS: Array<{
  id: LayerGroupId;
  label: string;
  description: string;
}> = [
  { id: 'structure', label: 'Plan structure', description: 'Room boundaries and zones' },
  { id: 'content', label: 'Placed content', description: 'Equipment and free geometry' },
  { id: 'markup', label: 'Markup', description: 'Dimensions and plan notes' },
];

const LAYERS: Array<{
  id: Layer;
  label: string;
  description: string;
  tint: string;
  group: LayerGroupId;
}> = [
  {
    id: 'walls',
    label: 'Walls & structure',
    description: 'Walls, doors, columns, and room edges',
    tint: '#8796a8',
    group: 'structure',
  },
  {
    id: 'region',
    label: 'Regions',
    description: 'Named areas and planning zones',
    tint: '#51b879',
    group: 'structure',
  },
  {
    id: 'furniture',
    label: 'Tables & equipment',
    description: 'Placed inventory and gear items',
    tint: '#438fe8',
    group: 'content',
  },
  {
    id: 'other',
    label: 'Other geometry',
    description: 'Imported and free-drawn shapes',
    tint: '#9173cf',
    group: 'content',
  },
  {
    id: 'annotation',
    label: 'Dimensions & labels',
    description: 'Measurements, dimensions, and text',
    tint: '#d99a29',
    group: 'markup',
  },
];

const PRINT_PAPERS: Record<string, { width: number; height: number; label: string }> = {
  Letter: { width: 8.5, height: 11, label: 'Letter · 8.5 × 11 in' },
  Legal: { width: 8.5, height: 14, label: 'Legal · 8.5 × 14 in' },
  Tabloid: { width: 11, height: 17, label: 'Tabloid · 11 × 17 in' },
  A4: { width: 8.27, height: 11.69, label: 'A4 · 210 × 297 mm' },
  A3: { width: 11.69, height: 16.54, label: 'A3 · 297 × 420 mm' },
};

const PRINT_SCALES: Array<{ id: string; label: string; inchesPerFoot: number }> = [
  { id: '1/16', label: '1/16″ = 1′-0″', inchesPerFoot: 1 / 16 },
  { id: '3/32', label: '3/32″ = 1′-0″', inchesPerFoot: 3 / 32 },
  { id: '1/8', label: '1/8″ = 1′-0″', inchesPerFoot: 1 / 8 },
  { id: '3/16', label: '3/16″ = 1′-0″', inchesPerFoot: 3 / 16 },
  { id: '1/4', label: '1/4″ = 1′-0″', inchesPerFoot: 1 / 4 },
  { id: 'fit', label: 'Fit to page · not to scale', inchesPerFoot: 0 },
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
  dimension?: {
    length: number;
    angleDegrees: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
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
type EquipmentSource = 'inventory' | 'gear' | 'plan';
type InspectorTab = 'properties' | 'room' | 'create' | 'layers';

/** One foot in logical units — the arrow-key nudge and duplicate offset. */
const FOOT = 120;

/** Same steps as Settings → Drawing → Snap. Values are logical units (0.1"). */
const SNAP_STEPS = [
  [0, 'Off'],
  [10, '1″'],
  [30, '3″'],
  [60, '6″'],
  [FOOT, '1′'],
  [FOOT * 5, '5′'],
] as const;

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
  const [startNewRoomOutline, setStartNewRoomOutline] = useState(false);
  /**
   * New Plan → Custom writes an empty file first, then the user traces walls.
   * Kept in a ref so cancelling/re-arming the outline tool cannot drop the
   * "save once the room exists" promise before createRoom runs.
   */
  const saveNewRoomOutlineRef = useRef(false);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toolbarTooltip, setToolbarTooltip] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertGroup, setInsertGroup] = useState<InsertGroupId | null>(null);
  const [shapeWizardOpen, setShapeWizardOpen] = useState(false);
  const [buildStageOpen, setBuildStageOpen] = useState(false);
  const [dimLengthDraft, setDimLengthDraft] = useState('');
  const [dimAngleDraft, setDimAngleDraft] = useState('');
  const [dimScaleDraft, setDimScaleDraft] = useState('');
  const [armedInventoryId, setArmedInventoryId] = useState<string | null>(null);
  const [rotationDraft, setRotationDraft] = useState('15');
  const [colorDraft, setColorDraft] = useState('#20252b');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(0.05);
  const [view, setView] = useState<Workspace>('plan');
  const [planRailSource, setPlanRailSource] = useState<PlanRailSource>('recent');
  const [equipmentSource, setEquipmentSource] = useState<EquipmentSource>('inventory');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('properties');
  const [layerQuery, setLayerQuery] = useState('');
  const [openLayerGroups, setOpenLayerGroups] = useState<Set<LayerGroupId>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('groundplan:open-layer-groups') ?? '[]');
      const valid = Array.isArray(saved)
        ? saved.filter((id): id is LayerGroupId => LAYER_GROUPS.some((group) => group.id === id))
        : [];
      return new Set(valid.length ? valid : ['structure']);
    } catch {
      return new Set<LayerGroupId>(['structure']);
    }
  });
  const [openItemLayers, setOpenItemLayers] = useState<Set<Layer>>(new Set());
  const [layerItemLimits, setLayerItemLimits] = useState<Partial<Record<Layer, number>>>({});
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const [libQuery, setLibQuery] = useState('');
  const [invQuery, setInvQuery] = useState('');
  /**
   * What the pointer will do with its next click. One value, and only one.
   *
   * This is the whole of the tool state: gear, inventory, labels and seating
   * waiting to be stamped; measure, dimension and the draw tools waiting for
   * their two clicks; the held start point; the Hand tool; the temporary
   * readout. Eleven `useState` cells plus two refs used to live here, and
   * `PlanCanvas` kept two more of its own. See `tool/machine.ts` for why that
   * shape kept producing bugs and what replaced it.
   */
  const { state: tool, ref: toolRef, dispatch: dispatchTool } = useTool({
    open: !!doc,
    editable: !!doc?.editable,
  });
  const pointerMode = useMemo(() => pointerSpec(tool), [tool]);
  const toolBannerState = useMemo(() => toolBanner(tool), [tool]);
  const armedGearDescription =
    tool.tool.kind === 'stamp' && tool.tool.stamp.what === 'gear' ? tool.tool.stamp.description : null;
  const [annotationDraft, setAnnotationDraft] = useState('');
  const annotationInputRef = useRef<HTMLTextAreaElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  /** Snap step in logical units; 0 is off. Object alignment always applies. */
  const [snapStep, setSnapStep] = useState(FOOT);
  /** Last non-zero snap, so the magnet toggle can restore Off ↔ step. */
  const lastSnapStepRef = useRef(FOOT);
  const [printOpen, setPrintOpen] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
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
  const statusTimer = useRef<number | null>(null);
  const errorTimer = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem('groundplan:rail-open', String(railOpen));
  }, [railOpen]);

  useEffect(() => {
    localStorage.setItem('groundplan:inspector-open', String(inspectorOpen));
  }, [inspectorOpen]);

  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [doc?.path, inspectorTab, view]);

  useEffect(() => {
    localStorage.setItem('groundplan:open-layer-groups', JSON.stringify([...openLayerGroups]));
  }, [openLayerGroups]);

  const showToolbarTooltipFor = useCallback((target: EventTarget | null) => {
    const control = target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
    const text = control?.dataset.tooltip?.trim();
    if (!control || !text) {
      setToolbarTooltip(null);
      return;
    }
    const bounds = control.getBoundingClientRect();
    const toolbarBottom = control.closest('.toolbar')?.getBoundingClientRect().bottom ?? bounds.bottom;
    setToolbarTooltip({
      text,
      left: Math.max(130, Math.min(window.innerWidth - 130, bounds.left + bounds.width / 2)),
      top: Math.min(window.innerHeight - 46, toolbarBottom + 8),
    });
  }, []);

  const handleToolbarPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => showToolbarTooltipFor(event.target),
    [showToolbarTooltipFor],
  );

  const handleToolbarPointerOut = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const from = event.target instanceof Element ? event.target.closest('[data-tooltip]') : null;
      const to = event.relatedTarget instanceof Element ? event.relatedTarget.closest('[data-tooltip]') : null;
      if (from === to) return;
      if (to) showToolbarTooltipFor(to);
      else setToolbarTooltip(null);
    },
    [showToolbarTooltipFor],
  );

  const handleToolbarFocus = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => showToolbarTooltipFor(event.target),
    [showToolbarTooltipFor],
  );

  const handleToolbarBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest('[data-tooltip]') : null;
      if (next) showToolbarTooltipFor(next);
      else setToolbarTooltip(null);
    },
    [showToolbarTooltipFor],
  );

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
    saveNewRoomOutlineRef.current = false;
    // One dispatch puts everything down. The old block cleared four armed cells
    // and the two measure/dimension pairs but never `drawTool`/`drawFrom`, so
    // opening a different plan left a draw tool in hand holding a half-consumed
    // start point against a document that no longer existed.
    dispatchTool({ type: 'reset' });
    setPrintOpen(false);
    setFitToken((t) => t + 1);
  }, [dispatchTool]);

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
    const svg = toSvg(doc.scene, visible, printScale);
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
        if (s.drawing.snapStep > 0) lastSnapStepRef.current = s.drawing.snapStep;
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

  // A Custom room chosen in New Plan starts where that choice promises: on the
  // plan, with the Room inspector open and the multi-point outline tool ready.
  // Waiting for the adopted document to render also lets the tool machine see
  // the new file's editable capability before it receives the pick.
  useEffect(() => {
    if (!startNewRoomOutline || !doc?.editable) return;
    setStartNewRoomOutline(false);
    setInspectorOpen(true);
    setInspectorTab('room');
    setSelectedIds([]);
    saveNewRoomOutlineRef.current = true;
    const { refusal } = dispatchTool({ type: 'pick', choice: roomOutlineChoice });
    if (refusal) notify(refusal);
    else showStatus('Click each room corner in order, then press Enter to finish.', 5200);
  }, [dispatchTool, doc?.editable, doc?.path, notify, showStatus, startNewRoomOutline]);

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


  const persistNewRoomOutlineIfNeeded = useCallback(async (): Promise<{
    doc?: Doc;
    statusSuffix?: string;
    failed?: string;
  }> => {
    if (!saveNewRoomOutlineRef.current) return {};
    saveNewRoomOutlineRef.current = false;
    const saved = await api.save(false);
    if (saved.ok && saved.doc) {
      if (saved.warning) notify(saved.warning);
      return { doc: saved.doc as Doc, statusSuffix: ' · Saved' };
    }
    if (!saved.cancelled) {
      return { failed: `The room was created but could not be saved: ${saved.reason ?? 'unknown error'}` };
    }
    return {};
  }, [notify]);

  const applyToolEffect = useCallback(
    async (effect: PendingEffect | null, refusal?: string) => {
      if (refusal) {
        notify(refusal);
        return;
      }
      if (!effect) return;
      if (effect.do === 'showReadout') {
        dispatchTool({ type: 'settled', epoch: effect.epoch, ok: true });
        return;
      }
      const result = await runEffect(effect, api);
      if (effect.do === 'createRoom' && result.ok) {
        // New Plan already asked where the file should live. Finishing its
        // promised custom outline should persist it there immediately instead
        // of leaving the brand-new file as the empty sheet first written.
        const persisted = await persistNewRoomOutlineIfNeeded();
        if (persisted.doc) {
          result.doc = persisted.doc;
          result.status = `${result.status ?? 'Created custom room'}${persisted.statusSuffix ?? ''}`;
        } else if (persisted.failed) {
          notify(persisted.failed);
        }
      }
      if (result.ok && result.doc) {
        setDoc(result.doc as Doc);
        setError(null);
        if (result.created?.length) {
          setSelectedIds(result.created);
          setSelection(null);
        }
        if (result.status) showStatus(result.status);
      } else if (result.reason) {
        notify(result.reason);
      }
      dispatchTool({ type: 'settled', epoch: effect.epoch, ok: result.ok });
    },
    [dispatchTool, notify, persistNewRoomOutlineIfNeeded, showStatus],
  );

  const finishRoomOutline = useCallback(() => {
    const { effect, refusal } = dispatchTool({ type: 'finish' });
    void applyToolEffect(effect, refusal);
  }, [applyToolEffect, dispatchTool]);

  const cancelPlacement = useCallback(() => {
    dispatchTool({ type: 'pick', choice: SELECT });
  }, [dispatchTool]);

  const showWorkspace = useCallback(
    (next: Workspace) => {
      if (next !== 'plan') {
        dispatchTool({ type: 'reset' });
        setPrintOpen(false);
      }
      setView(next);
    },
    [dispatchTool],
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

  const armGear = useCallback(
    (description: string) => {
      setArmedInventoryId(null);
      const { refusal } = dispatchTool({
        type: 'pick',
        choice: { kind: 'stamp', stamp: { what: 'gear', description } },
      });
      if (refusal) notify(refusal);
    },
    [dispatchTool, notify],
  );

  const armInventory = useCallback(
    (id: string, name: string) => {
      setArmedInventoryId(id);
      const { refusal } = dispatchTool({
        type: 'pick',
        choice: { kind: 'stamp', stamp: { what: 'inventory', id, name } },
      });
      if (refusal) notify(refusal);
    },
    [dispatchTool, notify],
  );

  const inventoryRows = useMemo(
    () =>
      (inventory?.items ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category ?? null,
      })),
    [inventory?.items],
  );

  const stageOrigin = useMemo(() => {
    const extent = doc?.scene.roomExtent;
    if (!extent) return { x: 0, y: 0 };
    return { x: (extent.minX + extent.maxX) / 2, y: extent.minY };
  }, [doc?.scene.roomExtent]);

  const armInsertLeaf = useCallback(
    (leafId: string) => {
      const leaf = flattenInsertLeaves().find((row) => row.id === leafId);
      if (!leaf) {
        notify('That Insert item is unknown');
        return;
      }
      const match = matchInsertItem(leaf, inventoryRows);
      if (!match) {
        notify(`Nothing in inventory matches “${leaf.label}”`);
        return;
      }
      armInventory(match.id, match.name);
      showStatus(`Armed ${match.name}`);
    },
    [armInventory, inventoryRows, notify, showStatus],
  );

  const armLabelText = useCallback(
    (text: string) => {
      const { refusal } = dispatchTool({ type: 'pick', choice: labelChoice(text) });
      if (refusal) notify(refusal);
    },
    [dispatchTool, notify],
  );

  const armLabel = useCallback(() => {
    const text = annotationDraft.trim();
    if (!text) {
      notify('Enter label text first.');
      annotationInputRef.current?.focus();
      return;
    }
    armLabelText(text);
  }, [annotationDraft, armLabelText, notify]);

  const editAnnotationDraft = useCallback(
    (next: string) => {
      setAnnotationDraft(next);
      const { refusal } = dispatchTool({ type: 'retext', text: next });
      if (refusal) notify(refusal);
    },
    [dispatchTool, notify],
  );

  const toggleMeasure = useCallback(() => {
    const { refusal } = dispatchTool({ type: 'toggle', choice: MEASURE });
    if (refusal) notify(refusal);
  }, [dispatchTool, notify]);

  const toggleDimension = useCallback(() => {
    const { refusal } = dispatchTool({ type: 'toggle', choice: DIMENSION });
    if (refusal) notify(refusal);
  }, [dispatchTool, notify]);

  const toggleGrid = useCallback(() => {
    setShowGrid((current) => {
      const next = !current;
      void api.settingsPatch({ drawing: { showGrid: next } }).catch(() => undefined);
      return next;
    });
  }, []);

  const commitSnapStep = useCallback((next: number) => {
    const step = Number.isFinite(next) && next > 0 ? next : 0;
    if (step > 0) lastSnapStepRef.current = step;
    setSnapStep(step);
    void api.settingsPatch({ drawing: { snapStep: step } }).catch(() => undefined);
  }, []);

  const toggleSnap = useCallback(() => {
    setSnapStep((current) => {
      const next = current ? 0 : lastSnapStepRef.current || FOOT;
      if (current > 0) lastSnapStepRef.current = current;
      void api.settingsPatch({ drawing: { snapStep: next } }).catch(() => undefined);
      return next;
    });
  }, []);

  const setDrawingUnits = useCallback((next: 'imperial' | 'metric') => {
    setUnitSystem(next);
    void api.settingsPatch({ drawing: { units: next } }).catch(() => undefined);
  }, []);

  const importGear = useCallback(async () => {
    setBusy(true);
    setBusyMessage('Importing gear…');
    try {
      const state = await api.gearImport();
      if (state && Array.isArray(state.lists)) {
        setGear(state);
        setGearIndex(0);
        showWorkspace('gear');
        showStatus(
          state.notice ??
            `Imported ${state.lists.length} list${state.lists.length === 1 ? '' : 's'}`,
        );
        inventoryChanged();
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }, [notify, showStatus, showWorkspace, inventoryChanged]);

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

  const newGear = useCallback(async () => {
    try {
      const state = await api.gearNew();
      if (state && Array.isArray(state.lists)) {
        setGear(state);
        setGearIndex(0);
        showWorkspace('gear');
        showStatus('Started a blank gear list');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify, showStatus, showWorkspace]);

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

  // --- editing ------------------------------------------------------------

  const applied = useCallback(
    (reply: { ok: boolean; reason?: string; doc?: Doc; created?: number[] }) => {
      if (reply.ok && reply.doc) {
        setDoc(reply.doc);
        setError(null);
        if (reply.created?.length) {
          setSelectedIds(reply.created);
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
    const readout = toolRef.current.readout;
    if (!readout || !doc?.editable) return;
    const reply = await api.addDimension(
      readout.from.x,
      readout.from.y,
      readout.to.x,
      readout.to.y,
      readout.from.nodeId,
      readout.to.nodeId,
    );
    applied(reply);
    if (!reply.ok) return;
    dispatchTool({ type: 'pick', choice: MEASURE });
    showStatus(reply.text ? `Saved ${reply.text} as a dimension` : 'Saved dimension on the plan');
  }, [doc?.editable, applied, showStatus, dispatchTool, toolRef]);

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
    if (!doc || printBusy || visible.size === 0) return;
    setPrintBusy(true);
    try {
      const extent = doc.scene.roomExtent ?? doc.scene.extent;
      const reply = await api.printPdf({
        svg: toSvg(doc.scene, visible, printScale),
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
      if (reply.cancelled) return;
      if (reply.ok) {
        setPrintOpen(false);
        void api.settingsPatch({
          print: {
            scale: printScale,
            paper: printPaper,
            landscape: printLandscape,
            subtitle: printSubtitle,
          },
        });
        const name = reply.path?.split(/[\\/]/).pop();
        if (reply.fits === false) {
          // Better to be told the sheet crops than to find out at the venue.
          notify(
            `Saved ${name}, but the drawing is ${Math.round(((reply.overBy ?? 1) - 1) * 100)}% larger than ` +
              `this sheet at that scale — use a bigger sheet or a smaller scale to see all of it.`,
          );
        } else {
          showStatus(`Saved ${name}`);
        }
      } else if (reply.reason) notify(reply.reason);
    } finally {
      setPrintBusy(false);
    }
  }, [doc, printBusy, visible, printScale, printPaper, printLandscape, printSubtitle, gear, gearIndex, notify, showStatus]);

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
        dispatchTool({ type: 'pick', choice: SELECT });
        setArmedInventoryId(null);
        setDoc(reply.doc as Doc);
        if (reply.created?.length) {
          setSelectedIds(reply.created);
          setSelection(null);
        }
        showStatus(
          reply.method === 'matched'
            ? "Placed from the plan's own shapes"
            : 'Placed as a sized box',
        );
      } else if (reply.reason) notify(reply.reason);
    },
    [dispatchTool, doc, notify, showStatus],
  );

  /** Places one gear-list line at the drop point without arming repeat placement. */
  const dropGear = useCallback(
    async (description: string, x: number, y: number) => {
      if (!doc?.editable) {
        notify('This plan is read-only, so gear cannot be placed on it.');
        return;
      }
      const reply = (await api.placeGear(description, x, y)) as {
        ok: boolean;
        reason?: string;
        doc?: Doc;
        method?: string;
        created?: number[];
      };
      if (reply.ok && reply.doc) {
        dispatchTool({ type: 'pick', choice: SELECT });
        setArmedInventoryId(null);
        setDoc(reply.doc as Doc);
        if (reply.created?.length) {
          setSelectedIds(reply.created);
          setSelection(null);
        }
        showStatus(
          reply.method === 'matched'
            ? `Placed ${description} from the plan's own shapes`
            : `Placed ${description} as a sized box`,
        );
      } else if (reply.reason) notify(reply.reason);
    },
    [dispatchTool, doc, notify, showStatus],
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
        setLabelDraft(info?.text ?? info?.name ?? '');
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
        const dim = (info as Selection | null)?.dimension;
        if (dim) {
          setDimLengthDraft(formatLength(dim.length, unitSystem));
          setDimAngleDraft(String(Math.round(dim.angleDegrees * 10) / 10));
          setDimScaleDraft('');
        } else {
          setDimLengthDraft('');
          setDimAngleDraft('');
          setDimScaleDraft('');
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [selectedId, doc, unitSystem]);

  useEffect(() => {
    // Clicking an object asks to see its properties. A placement selecting
    // what it just created does not: the panel being placed from is the one
    // in use, and pulling it away mid-run took the label field out from under
    // whatever was being typed into it.
    if (opensProperties(selectedIds.length, tool)) {
      setInspectorTab('properties');
    }
  }, [selectedIds, tool]);

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
      else if (command === 'menu:insert') {
        setInsertGroup(null);
        setInsertOpen(true);
      } else if (command === 'menu:insert-leaf' && arg) armInsertLeaf(arg);
      else if (command === 'menu:shape-wizard') setShapeWizardOpen(true);
      else if (command === 'menu:build-stage') setBuildStageOpen(true);
    });
  }, [
    openFile,
    openFolder,
    exportSvg,
    exportDxf,
    openAnyPath,
    save,
    saveGear,
    view,
    doc,
    undo,
    redo,
    selectAll,
    armInsertLeaf,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (shortcutsOpen) {
          e.preventDefault();
          setShortcutsOpen(false);
          return;
        }
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
        if (insertOpen) {
          e.preventDefault();
          setInsertOpen(false);
          return;
        }
        if (shapeWizardOpen) {
          e.preventDefault();
          setShapeWizardOpen(false);
          return;
        }
        if (buildStageOpen) {
          e.preventDefault();
          setBuildStageOpen(false);
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
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
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
      if (e.key === 'Enter' && toolRef.current.tool.kind === 'path') {
        e.preventDefault();
        finishRoomOutline();
        return;
      }
      if (e.key === 'Enter' && toolRef.current.readout) {
        e.preventDefault();
        void keepMeasurement();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (toolRef.current.tool.kind === 'path' && toolRef.current.tool.points.length) {
          e.preventDefault();
          dispatchTool({ type: 'undo-point' });
          return;
        }
        if (doc?.editable && selectedIds.length) {
          e.preventDefault();
          void deleteSelection();
        }
        return;
      }
      if (e.key.toLowerCase() === 's' && !mod && doc) {
        e.preventDefault();
        toggleSnap();
        return;
      }
      if (e.key.toLowerCase() === 'g' && !mod && doc) {
        e.preventDefault();
        void toggleGrid();
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
        dispatchTool({ type: 'escape' });
        if (escapeAlsoClearsSelection(toolRef.current)) setSelectedIds([]);
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
    printOpen,
    newPlanOpen,
    settingsOpen,
    shortcutsOpen,
    insertOpen,
    shapeWizardOpen,
    buildStageOpen,
    cancelPlacement,
    toggleMeasure,
    toggleDimension,
    toggleGrid,
    toggleSnap,
    finishRoomOutline,
    keepMeasurement,
    selectAll,
    view,
    doc,
    notify,
    dispatchTool,
    toolRef,
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

  const setAllLayersVisible = useCallback((show: boolean) => {
    setVisible(show ? new Set(LAYERS.map((layer) => layer.id)) : new Set());
  }, []);

  const setLayerGroupVisible = useCallback((group: LayerGroupId, show: boolean) => {
    setVisible((current) => {
      const next = new Set(current);
      for (const layer of LAYERS) {
        if (layer.group !== group) continue;
        if (show) next.add(layer.id);
        else next.delete(layer.id);
      }
      return next;
    });
  }, []);

  const toggleLayerGroupOpen = useCallback((group: LayerGroupId) => {
    setOpenLayerGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const toggleLayerItemsOpen = useCallback((layer: Layer) => {
    setOpenItemLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
    setLayerItemLimits((current) => (current[layer] ? current : { ...current, [layer]: 50 }));
  }, []);

  const showOnlyLayer = useCallback(
    (id: Layer) => {
      const layer = LAYERS.find((candidate) => candidate.id === id);
      setVisible(new Set([id]));
      showStatus(`Showing only ${layer?.label ?? id}`);
    },
    [showStatus],
  );

  const layerCounts = useMemo(() => {
    const idsByLayer = new Map<Layer, Set<number>>(LAYERS.map((layer) => [layer.id, new Set()]));
    for (const primitive of doc?.scene.primitives ?? []) {
      idsByLayer.get(primitive.layer)?.add(primitive.selectId);
    }
    return new Map(LAYERS.map((layer) => [layer.id, idsByLayer.get(layer.id)?.size ?? 0]));
  }, [doc?.scene.primitives]);

  const layerItems = useMemo(() => {
    const itemsByLayer = new Map<Layer, Map<number, LayerListItem>>(
      LAYERS.map((layer) => [layer.id, new Map()]),
    );
    for (const primitive of doc?.scene.primitives ?? []) {
      const items = itemsByLayer.get(primitive.layer);
      if (!items || items.has(primitive.selectId)) continue;
      const kind = LAYER_ITEM_KINDS[primitive.cls] ?? primitive.cls.replace(/^RV/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
      const owner = primitive.owner?.trim();
      const text = primitive.text?.trim();
      const label = owner || text || kind || `Object ${primitive.selectId}`;
      const x = primitive.pts.length >= 2 ? primitive.pts[0] : undefined;
      const y = primitive.pts.length >= 2 ? primitive.pts[1] : undefined;
      items.set(primitive.selectId, {
        selectId: primitive.selectId,
        label,
        kind,
        x,
        y,
        searchText: `${label} ${kind}`.toLowerCase(),
      });
    }
    return new Map(
      LAYERS.map((layer) => [
        layer.id,
        [...(itemsByLayer.get(layer.id)?.values() ?? [])].sort(
          (left, right) => left.label.localeCompare(right.label) || left.selectId - right.selectId,
        ),
      ]),
    );
  }, [doc?.scene.primitives]);

  const layerObjectTotal = useMemo(
    () => LAYERS.reduce((total, layer) => total + (layerCounts.get(layer.id) ?? 0), 0),
    [layerCounts],
  );

  const visibleLayerObjectTotal = useMemo(
    () =>
      LAYERS.reduce(
        (total, layer) => total + (visible.has(layer.id) ? (layerCounts.get(layer.id) ?? 0) : 0),
        0,
      ),
    [layerCounts, visible],
  );

  const organizedLayers = useMemo(() => {
    const query = layerQuery.trim().toLowerCase();
    return LAYER_GROUPS.map((group) => ({
      ...group,
      layers: LAYERS.filter(
        (layer) =>
          layer.group === group.id &&
          (!query ||
            layer.label.toLowerCase().includes(query) ||
            layer.description.toLowerCase().includes(query) ||
            group.label.toLowerCase().includes(query) ||
            (layerItems.get(layer.id) ?? []).some((item) => item.searchText.includes(query))),
      ),
    })).filter((group) => group.layers.length > 0);
  }, [layerItems, layerQuery]);

  const selectLayer = useCallback(
    (id: Layer) => {
      if (!doc) return;
      const ids = [
        ...new Set(
          doc.scene.primitives
            .filter((primitive) => primitive.layer === id)
            .map((primitive) => primitive.selectId),
        ),
      ];
      if (!ids.length) {
        notify(`There are no ${LAYERS.find((layer) => layer.id === id)?.label.toLowerCase() ?? id} objects to select.`);
        return;
      }
      setVisible((current) => new Set(current).add(id));
      dispatchTool({ type: 'pick', choice: SELECT });
      setSelectedIds(ids);
      setInspectorOpen(true);
      setInspectorTab('properties');
      showStatus(`Selected ${ids.length.toLocaleString()} object${ids.length === 1 ? '' : 's'} on the layer`);
    },
    [dispatchTool, doc, notify, showStatus],
  );

  const selectLayerItem = useCallback(
    (layer: Layer, item: LayerListItem) => {
      setVisible((current) => new Set(current).add(layer));
      dispatchTool({ type: 'pick', choice: SELECT });
      setSelection(null);
      setSelectedIds([item.selectId]);
      showStatus(`Selected ${item.label}`);
    },
    [dispatchTool, showStatus],
  );

  const extent = doc?.scene.roomExtent ?? doc?.scene.extent ?? null;
  const inventoryTotal = doc?.scene.inventory.reduce((sum, i) => sum + i.count, 0) ?? 0;
  const printPreview = useMemo(() => {
    if (!doc) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const visibleIds = new Set<number>();
    for (const primitive of doc.scene.primitives) {
      if (!visible.has(primitive.layer)) continue;
      visibleIds.add(primitive.selectId);
      for (let index = 0; index + 1 < primitive.pts.length; index += 2) {
        const x = primitive.pts[index];
        const y = primitive.pts[index + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const fallback = doc.scene.roomExtent ?? doc.scene.extent;
    const drawingWidth = Number.isFinite(maxX - minX) && maxX > minX
      ? maxX - minX
      : fallback
        ? fallback.maxX - fallback.minX
        : 1;
    const drawingHeight = Number.isFinite(maxY - minY) && maxY > minY
      ? maxY - minY
      : fallback
        ? fallback.maxY - fallback.minY
        : 1;
    const paper = PRINT_PAPERS[printPaper] ?? PRINT_PAPERS.Tabloid;
    const scale = PRINT_SCALES.find((candidate) => candidate.id === printScale) ?? PRINT_SCALES[2];

    const calculate = (landscape: boolean) => {
      const pageWidth = landscape ? paper.height : paper.width;
      const pageHeight = landscape ? paper.width : paper.height;
      const frameWidth = Math.max(0.1, pageWidth - 1);
      const frameHeight = Math.max(0.1, pageHeight - 1.85);
      const inchesPerFoot = scale.inchesPerFoot || 1 / 8;
      const naturalWidth = (drawingWidth / 120) * inchesPerFoot;
      const naturalHeight = (drawingHeight / 120) * inchesPerFoot;
      const fitFactor = Math.min(frameWidth / naturalWidth, frameHeight / naturalHeight);
      const displayFactor = scale.inchesPerFoot ? 1 : fitFactor;
      const overBy = scale.inchesPerFoot
        ? Math.max(naturalWidth / frameWidth, naturalHeight / frameHeight)
        : 1;
      return {
        pageWidth,
        pageHeight,
        frameWidth,
        frameHeight,
        fits: overBy <= 1.001,
        overBy,
        footprintWidth: Math.min(170, (naturalWidth * displayFactor / frameWidth) * 100),
        footprintHeight: Math.min(170, (naturalHeight * displayFactor / frameHeight) * 100),
      };
    };

    const current = calculate(printLandscape);
    const alternate = calculate(!printLandscape);
    return {
      ...current,
      drawingWidth,
      drawingHeight,
      visibleObjects: visibleIds.size,
      scaleLabel: scale.label,
      paperLabel: paper.label,
      alternateFits: alternate.fits,
      alternateOrientation: printLandscape ? 'Portrait' : 'Landscape',
    };
  }, [doc, printLandscape, printPaper, printScale, visible]);
  const furnitureCounts = useMemo(
    () => countFurniture(doc?.scene.inventory ?? []),
    [doc?.scene.inventory],
  );
  const [seatingClearances, setSeatingClearances] = useState<{
    front: number;
    side: number;
    wing: number;
    rear: number;
    centreAisle: number;
  } | null>(null);
  useEffect(() => {
    if (!doc || view !== 'plan') {
      setSeatingClearances(null);
      return;
    }
    let cancelled = false;
    void api.planModel().then((model) => {
      if (cancelled) return;
      const c = model?.seatingStatus?.clearances;
      setSeatingClearances(
        c
          ? {
              front: c.front,
              side: c.side,
              wing: c.wing,
              rear: c.rear,
              centreAisle: c.centreAisle,
            }
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [doc?.revision, doc?.path, view]);
  const singleIsAnnotation = !!selection && /dimension|text|label/i.test(selection.cls);
  const canTransformSelection = selectedIds.length > 1 || (!!selection && !singleIsAnnotation);
  const canResizeSelection =
    !!selection && !singleIsAnnotation && selection.widthUnits > 0 && selection.heightUnits > 0;
  /** Absolute X/Y is single-selection only — multi-select keeps stale drafts otherwise. */
  const canPositionSelection = !!selection && selectedIds.length === 1 && !singleIsAnnotation;
  /**
   * Annotation is available in every editable plan.
   *
   * `annotationCapabilities` used to gate these buttons, back when a label or a
   * dimension could only be made by cloning one the file already contained. It
   * no longer means that: anything without a template is synthesized, so the
   * flags report whether new annotation will *match the sheet's styling*. Left
   * as a gate they made the tools permanently unusable in any plan drawn from
   * scratch — a blank plan has neither template, so the first label and every
   * dimension were refused, and the dimension tool could never unlock itself.
   */
  const canCreateLabel = !!doc?.editable;
  const canCreateDimension = !!doc?.editable;
  const annotationStyleHint =
    doc && (!doc.annotationCapabilities?.label || !doc.annotationCapabilities?.dimension)
      ? 'This plan has no annotation to copy styling from, so new labels and dimensions use the default font and pen.'
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
          onCreated={(created, options) => {
            setNewPlanOpen(false);
            // The same path an opened plan takes, so nothing is left over from
            // whatever was on screen before.
            adopt(created as Doc);
            setInspectorTab('room');
            setInspectorOpen(true);
            setStartNewRoomOutline(options.startRoomOutline);
            setFitToken((t) => t + 1);
            refreshRecent();
          }}
        />
      )}

      <InsertPicker
        open={insertOpen}
        items={inventoryRows}
        initialGroup={insertGroup}
        onClose={() => setInsertOpen(false)}
        onPick={(id, name) => {
          armInventory(id, name);
          showStatus(`Armed ${name}`);
        }}
      />

      <ShapeEditorWizard
        open={shapeWizardOpen}
        units={unitSystem}
        onClose={() => setShapeWizardOpen(false)}
        onCreated={(id, name) => {
          void inventoryChanged();
          armInventory(id, name);
        }}
        onError={notify}
        onStatus={showStatus}
      />

      <BuildStageDialog
        open={buildStageOpen}
        units={unitSystem}
        origin={stageOrigin}
        disabled={!doc?.editable}
        onClose={() => setBuildStageOpen(false)}
        onBuilt={(next, created) => {
          if (next) setDoc(next as Doc);
          setInspectorOpen(true);
          setInspectorTab('room');
          if (created?.length) {
            setSelectedIds(created);
            setSelection(null);
          }
          setFitToken((t) => t + 1);
        }}
        onError={notify}
        onStatus={showStatus}
      />

      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            setSettingsOpen(false);
            setSettingsVersion((v) => v + 1);
          }}
          onError={notify}
        />
      )}

      {shortcutsOpen && (
        <div className="sheet-backdrop" onClick={() => setShortcutsOpen(false)} role="presentation">
          <div
            className="sheet shortcuts-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-title" id="shortcuts-title">
              Keyboard shortcuts
            </div>
            <div className="shortcuts-body">
              <section>
                <h3>File</h3>
                <dl>
                  <div>
                    <dt>
                      <kbd>{shortcut('N')}</kbd>
                    </dt>
                    <dd>New plan</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('O')}</kbd>
                    </dt>
                    <dd>Open plan</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('O', true)}</kbd>
                    </dt>
                    <dd>Open folder</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('S')}</kbd>
                    </dt>
                    <dd>Save</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('P')}</kbd>
                    </dt>
                    <dd>Print to PDF</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('E')}</kbd>
                    </dt>
                    <dd>Export SVG</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3>Edit</h3>
                <dl>
                  <div>
                    <dt>
                      <kbd>{shortcut('Z')}</kbd>
                    </dt>
                    <dd>Undo</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('Z', true)}</kbd>
                    </dt>
                    <dd>Redo</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('D')}</kbd>
                    </dt>
                    <dd>Duplicate</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('A')}</kbd>
                    </dt>
                    <dd>Select all</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Delete</kbd>
                    </dt>
                    <dd>Delete selection</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>[</kbd> <kbd>]</kbd>
                    </dt>
                    <dd>Rotate 90°</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Arrow keys</kbd>
                    </dt>
                    <dd>Nudge selection</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3>Drawing</h3>
                <dl>
                  <div>
                    <dt>
                      <kbd>S</kbd>
                    </dt>
                    <dd>Toggle snap</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>G</kbd>
                    </dt>
                    <dd>Toggle grid</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>M</kbd>
                    </dt>
                    <dd>Measure</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>D</kbd>
                    </dt>
                    <dd>Dimension</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>T</kbd>
                    </dt>
                    <dd>Place label</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>0</kbd>
                    </dt>
                    <dd>Zoom to fit</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Esc</kbd>
                    </dt>
                    <dd>Cancel tool / clear</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3>Layout</h3>
                <dl>
                  <div>
                    <dt>
                      <kbd>{shortcut('B')}</kbd>
                    </dt>
                    <dd>Toggle browser</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('B', true)}</kbd>
                    </dt>
                    <dd>Toggle inspector</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>?</kbd>
                    </dt>
                    <dd>This cheat sheet</dd>
                  </div>
                </dl>
              </section>
            </div>
            <div className="sheet-actions">
              <button type="button" onClick={() => setShortcutsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      <header
        className="toolbar"
        onPointerOver={handleToolbarPointerOver}
        onPointerOut={handleToolbarPointerOut}
        onFocusCapture={handleToolbarFocus}
        onBlurCapture={handleToolbarBlur}
      >
        <div className="ribbon-titlebar">
          <div className="brand">
            <Mark />
            <span>Groundplan</span>
          </div>

          <div className="seg tabs workspace-tabs" role="tablist" aria-label="Workspace">
            <button
              role="tab"
              data-tooltip="Plan workspace"
              aria-selected={view === 'plan'}
              className={view === 'plan' ? 'active' : ''}
              onClick={() => showWorkspace('plan')}
            >
              Plan
            </button>
            <button
              role="tab"
              data-tooltip="Gear workspace"
              aria-selected={view === 'gear'}
              className={view === 'gear' ? 'active' : ''}
              onClick={() => showWorkspace('gear')}
            >
              Gear
              {gear && <span className="num">{gear.totals[gearIndex]?.pieces ?? 0}</span>}
            </button>
            <button
              role="tab"
              data-tooltip="Inventory workspace"
              aria-selected={view === 'inventory'}
              className={view === 'inventory' ? 'active' : ''}
              onClick={() => showWorkspace('inventory')}
            >
              Inventory
              {inventory && inventory.total > 0 && <span className="num">{inventory.total}</span>}
            </button>
          </div>

          <div className="ribbon-title-actions">
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
                data-tooltip={`Save ${view === 'gear' ? 'gear list' : 'plan'} (${shortcut('S')})`}
              >
                <IconSave />
                Save
              </button>
            )}
          </div>
        </div>

        <div className="ribbon-panel">
        <div className="seg ribbon-group file-controls" aria-label="File">
          <button
            className="icon-btn ribbon-action"
            onClick={() => setNewPlanOpen(true)}
            disabled={busy}
            data-tooltip={`New plan (${shortcut('N')})`}
            aria-label="New plan"
          >
            <IconPlus />
            <span>New</span>
          </button>
          <button
            className="icon-btn ribbon-action"
            onClick={openFile}
            disabled={busy}
            data-tooltip={`Open plan (${shortcut('O')})`}
            aria-label="Open plan"
          >
            <IconFile />
            <span>Open</span>
          </button>
          <button
            className="icon-btn ribbon-action"
            onClick={openFolder}
            disabled={busy}
            data-tooltip={`Open folder (${shortcut('O', true)})`}
            aria-label="Open plan folder"
          >
            <IconFolder />
            <span>Browse</span>
          </button>
        </div>

        <div className="seg ribbon-group panel-toggles" aria-label="Panels">
          <button
            className={`icon-btn ribbon-action${railOpen ? ' is-on' : ''}`}
            onClick={() => setRailOpen((open) => !open)}
            data-tooltip={`${railOpen ? 'Hide' : 'Show'} browser (${shortcut('B')})`}
            aria-pressed={railOpen}
            aria-label={`${railOpen ? 'Hide' : 'Show'} browser`}
          >
            <IconSidebarLeft />
            <span>Browser</span>
          </button>
          <button
            className={`icon-btn ribbon-action${inspectorOpen ? ' is-on' : ''}`}
            onClick={() => setInspectorOpen((open) => !open)}
            data-tooltip={`${inspectorOpen ? 'Hide' : 'Show'} inspector (${shortcut('B', true)})`}
            aria-pressed={inspectorOpen}
            aria-label={`${inspectorOpen ? 'Hide' : 'Show'} inspector`}
          >
            <IconSidebarRight />
            <span>Inspector</span>
          </button>
        </div>

        {view === 'plan' && (
          <>
            <div className="seg ribbon-group history-controls" aria-label="Plan history">
              <button
                className="icon-btn ribbon-action"
                onClick={undo}
                disabled={!doc?.canUndo}
                data-tooltip={`Undo (${shortcut('Z')})`}
                aria-label="Undo plan edit"
              >
                <IconUndo />
                <span>Undo</span>
              </button>
              <button
                className="icon-btn ribbon-action"
                onClick={redo}
                disabled={!doc?.canRedo}
                data-tooltip={`Redo (${shortcut('Z', true)})`}
                aria-label="Redo plan edit"
              >
                <IconRedo />
                <span>Redo</span>
              </button>
            </div>

            <div className="seg ribbon-group plan-view-controls" aria-label="Plan view controls">
              <button
                className="icon-btn ribbon-action"
                onClick={() => setFitToken((t) => t + 1)}
                disabled={!doc}
                data-tooltip={`Zoom to fit (${shortcut('0')})`}
                aria-label="Zoom plan to fit"
              >
                <IconFit />
                <span>Fit</span>
              </button>
              <button
                className="icon-btn ribbon-action"
                onClick={() => setPaper((p) => !p)}
                disabled={!doc}
                data-tooltip={paper ? 'Switch to dark sheet' : 'Switch to paper sheet'}
                aria-label={paper ? 'Use dark plan sheet' : 'Use light plan sheet'}
              >
                {paper ? <IconMoon /> : <IconSun />}
                <span>Theme</span>
              </button>
              <button
                className={`icon-btn ribbon-action${showGrid ? ' is-on' : ''}`}
                onClick={() => void toggleGrid()}
                disabled={!doc}
                data-tooltip={showGrid ? 'Hide grid (G)' : 'Show grid (G)'}
                aria-label={showGrid ? 'Hide grid' : 'Show grid'}
                aria-pressed={showGrid}
              >
                <IconGrid />
                <span>Grid</span>
              </button>
            </div>

            <div className="seg ribbon-group plan-snap-controls" aria-label="Snap">
              <button
                className={`icon-btn ribbon-action${snapStep ? ' is-on' : ''}`}
                onClick={() => toggleSnap()}
                disabled={!doc}
                data-tooltip={
                  snapStep
                    ? 'Snapping on — grid and object alignment (S)'
                    : 'Snapping off (S)'
                }
                aria-label={snapStep ? 'Disable snapping' : 'Enable snapping'}
                aria-pressed={!!snapStep}
              >
                <IconMagnet />
                <span>Snap</span>
              </button>
              <select
                className="toolbar-select"
                value={SNAP_STEPS.some(([value]) => value === snapStep) ? snapStep : snapStep || 0}
                onChange={(e) => commitSnapStep(Number(e.target.value))}
                disabled={!doc}
                data-tooltip="Snap spacing"
                aria-label="Snap step"
              >
                {SNAP_STEPS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {!SNAP_STEPS.some(([value]) => value === snapStep) && snapStep > 0 && (
                  <option value={snapStep}>Custom</option>
                )}
              </select>
            </div>

            <div className="seg ribbon-group plan-tool-controls" aria-label="Plan drawing tools">
              <button
                className={`tool-button${isPressed(tool, MEASURE) ? ' is-on' : ''}`}
                onClick={toggleMeasure}
                disabled={!doc}
                data-tooltip="Measure a temporary distance (M)"
                aria-pressed={isPressed(tool, MEASURE)}
              >
                <IconRuler />
                <span>Measure</span>
              </button>
              <button
                className={`tool-button${isPressed(tool, DIMENSION) ? ' is-on' : ''}`}
                onClick={toggleDimension}
                disabled={!canCreateDimension}
                data-tooltip={
                  canCreateDimension
                    ? 'Saved dimension (D). Draws a persistent annotation on the plan.'
                    : doc
                      ? 'This plan is read-only. Use Measure for a temporary distance.'
                      : 'Open an editable plan to draw a saved dimension.'
                }
                aria-pressed={isPressed(tool, DIMENSION)}
              >
                <IconRuler />
                <span>Dimension</span>
              </button>
            </div>

            <div className="seg ribbon-group draw-tools" aria-label="Draw">
              <button
                className={`icon-btn ribbon-action${isPressed(tool, SELECT) ? ' is-on' : ''}`}
                onClick={() => dispatchTool({ type: 'pick', choice: SELECT })}
                disabled={!doc}
                data-tooltip="Select and move shapes (Esc)"
                aria-label="Select tool"
                aria-pressed={isPressed(tool, SELECT)}
              >
                <IconPointer />
                <span>Select</span>
              </button>
              {(
                [
                  ['line', 'Line', IconDrawLine],
                  ['rect', 'Rectangle', IconDrawRect],
                  ['ellipse', 'Ellipse', IconDrawEllipse],
                ] as const
              ).map(([shape, label, Icon]) => (
                <button
                  key={shape}
                  className={`icon-btn ribbon-action${isPressed(tool, drawChoice(shape)) ? ' is-on' : ''}`}
                  onClick={() => {
                    const { refusal } = dispatchTool({ type: 'toggle', choice: drawChoice(shape) });
                    if (refusal) notify(refusal);
                  }}
                  disabled={!doc?.editable}
                  data-tooltip={
                    doc?.editable
                      ? `Draw a ${label.toLowerCase()} — click two corners, Esc to cancel`
                      : 'Open an editable plan to draw'
                  }
                  aria-label={`Draw ${label.toLowerCase()}`}
                  aria-pressed={isPressed(tool, drawChoice(shape))}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
              <button
                className={`icon-btn ribbon-action${isPressed(tool, roomOutlineChoice) ? ' is-on' : ''}`}
                onClick={() => {
                  setInspectorOpen(true);
                  setInspectorTab('room');
                  const { refusal } = dispatchTool({ type: 'toggle', choice: roomOutlineChoice });
                  if (refusal) notify(refusal);
                  else setSelectedIds([]);
                }}
                disabled={!doc?.editable}
                data-tooltip={
                  doc?.editable
                    ? 'Draw a custom room — click each corner, then press Enter'
                    : 'Open an editable plan to draw a room'
                }
                aria-label="Draw custom room outline"
                aria-pressed={isPressed(tool, roomOutlineChoice)}
              >
                <IconDrawPolygon />
                <span>Room</span>
              </button>
              <button
                className={`icon-btn ribbon-action${isPressed(tool, labelChoice(annotationDraft.trim() || ' ')) ? ' is-on' : ''}`}
                onClick={() => {
                  setInspectorTab('create');
                  setInspectorOpen(true);
                  window.setTimeout(() => annotationInputRef.current?.focus(), 0);
                }}
                disabled={!doc?.editable}
                data-tooltip="Place a text label (T)"
                aria-label="Text label"
                aria-pressed={isPressed(tool, labelChoice(annotationDraft.trim() || ' '))}
              >
                <IconText />
                <span>Text</span>
              </button>
            </div>

            <div className="ribbon-quickbar">
            <div className="seg object-tools" aria-label="Arrange and transform">
              <button
                className="icon-btn"
                onClick={selectAll}
                disabled={!doc}
                data-tooltip={`Select all visible shapes (${shortcut('A')})`}
                aria-label="Select all visible shapes"
              >
                <IconPointer />
              </button>
              <button
                className="icon-btn"
                onClick={() => {
                  setInspectorOpen(true);
                  setInspectorTab('properties');
                }}
                disabled={!doc}
                data-tooltip="Open shape properties"
                aria-label="Open shape properties"
              >
                <IconEdit />
              </button>
              <span className="seg-divider" aria-hidden />
              <button
                className="icon-btn"
                onClick={() => void rotateSelection(-90)}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Rotate left 90° ([)"
                aria-label="Rotate anticlockwise"
              >
                <IconRotateLeft />
              </button>
              <button
                className="icon-btn"
                onClick={() => void rotateSelection(90)}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Rotate right 90° (])"
                aria-label="Rotate clockwise"
              >
                <IconRotateRight />
              </button>
              <button
                className="icon-btn"
                onClick={() => void flipSelection('horizontal')}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Flip shapes horizontally"
                aria-label="Flip horizontal"
              >
                <IconFlipHorizontal />
              </button>
              <button
                className="icon-btn"
                onClick={() => void flipSelection('vertical')}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Flip shapes vertically"
                aria-label="Flip vertical"
              >
                <IconFlipVertical />
              </button>
              <span className="seg-divider" aria-hidden />
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('align-left')}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip="Align selected shapes left"
                aria-label="Align left"
              >
                <IconAlignLeft />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('align-center')}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip="Align selected shapes to horizontal centre"
                aria-label="Align centre"
              >
                <IconAlignCenter />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('align-right')}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip="Align selected shapes right"
                aria-label="Align right"
              >
                <IconAlignRight />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('align-top')}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip="Align selected shapes to top"
                aria-label="Align top"
              >
                <IconAlignTop />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('align-middle')}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip="Align selected shapes to vertical middle"
                aria-label="Align middle"
              >
                <IconAlignMiddle />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('align-bottom')}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip="Align selected shapes to bottom"
                aria-label="Align bottom"
              >
                <IconAlignBottom />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('distribute-horizontal')}
                disabled={!doc?.editable || selectedIds.length < 3}
                data-tooltip="Distribute three or more shapes horizontally"
                aria-label="Distribute horizontally"
              >
                <IconDistributeHorizontal />
              </button>
              <button
                className="icon-btn"
                onClick={() => void arrangeSelection('distribute-vertical')}
                disabled={!doc?.editable || selectedIds.length < 3}
                data-tooltip="Distribute three or more shapes vertically"
                aria-label="Distribute vertically"
              >
                <IconDistributeVertical />
              </button>
              <span className="seg-divider" aria-hidden />
              <button
                className="icon-btn"
                onClick={() => void reorderSelection('bring-to-front')}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Bring selected shapes to front"
                aria-label="Bring to front"
              >
                <IconBringFront />
              </button>
              <button
                className="icon-btn"
                onClick={() => void reorderSelection('send-to-back')}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Send selected shapes to back"
                aria-label="Send to back"
              >
                <IconSendBack />
              </button>
              <button
                className="icon-btn"
                onClick={duplicateSelection}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip={`Duplicate selected shapes (${shortcut('D')})`}
                aria-label="Duplicate"
              >
                <IconDuplicate />
              </button>
              <button
                className="icon-btn"
                onClick={deleteSelection}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip="Delete selected shapes (Backspace)"
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
                data-tooltip={`Print plan to PDF (${shortcut('P')})`}
                aria-label="Print plan to PDF"
              >
                <IconPrint />
              </button>
              <button
                className="icon-btn"
                onClick={exportSvg}
                disabled={!doc}
                data-tooltip={`Export plan as SVG (${shortcut('E')})`}
                aria-label="Export plan as SVG"
              >
                <IconExport />
              </button>
              <button
                className="icon-btn"
                onClick={() => void exportDxf()}
                disabled={!doc}
                data-tooltip="Export visible layers as DXF for CAD"
                aria-label="Export plan as DXF"
              >
                <IconFile />
              </button>
            </div>
            <div className="seg layer-tools" aria-label="Layer visibility">
              <button
                className={`icon-btn layer-overview${visible.size === LAYERS.length ? ' is-on' : ''}`}
                onClick={() => setAllLayersVisible(visible.size !== LAYERS.length)}
                disabled={!doc}
                data-tooltip={visible.size === LAYERS.length ? 'Hide all layers' : 'Show all layers'}
                aria-label={visible.size === LAYERS.length ? 'Hide all layers' : 'Show all layers'}
                aria-pressed={visible.size === LAYERS.length}
              >
                <IconLayers />
                <span className="layer-count">{visible.size}/{LAYERS.length}</span>
              </button>
              {LAYERS.map((layer) => (
                <button
                  key={layer.id}
                  className={`icon-btn layer-toggle${visible.has(layer.id) ? ' is-on' : ''}`}
                  onClick={() => toggleLayer(layer.id)}
                  disabled={!doc}
                  data-tooltip={`${visible.has(layer.id) ? 'Hide' : 'Show'} ${layer.label} layer · ${layerCounts.get(layer.id) ?? 0} objects`}
                  aria-label={`${visible.has(layer.id) ? 'Hide' : 'Show'} ${layer.label} layer`}
                  aria-pressed={visible.has(layer.id)}
                >
                  <span className="layer-dot" style={{ background: layer.tint }} />
                </button>
              ))}
            </div>
            <div className="spacer" />
            <label className="ribbon-check">
              <input
                type="checkbox"
                checked={showGrid}
                disabled={!doc}
                onChange={() => void toggleGrid()}
              />
              Show grid
            </label>
            <button
              className="ribbon-advanced"
              type="button"
              onClick={() => setSettingsOpen(true)}
              data-tooltip="Open advanced drawing settings"
            >
              Advanced…
            </button>
            </div>
          </>
        )}

        <div className="seg ribbon-group utility-controls" aria-label="Help and settings">
          <button
            className="icon-btn ribbon-action"
            onClick={() => setSettingsOpen(true)}
            data-tooltip="Open settings"
            aria-label="Settings"
          >
            <IconEdit />
            <span>Settings</span>
          </button>
          <button
            className="icon-btn ribbon-action"
            onClick={() => setShortcutsOpen(true)}
            data-tooltip="Show keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <IconHelp />
            <span>Help</span>
          </button>
        </div>

        </div>
        {toolbarTooltip && (
          <div
            className="toolbar-tooltip"
            role="tooltip"
            style={{ left: toolbarTooltip.left, top: toolbarTooltip.top }}
          >
            {toolbarTooltip.text}
          </div>
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
                    <button className="btn-outline" onClick={() => void newGear()} style={{ justifyContent: 'center' }}>
                      New blank list…
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
                <div className="equipment-panel">
                  <div className="equipment-source-tabs" role="tablist" aria-label="Equipment source">
                    <button
                      type="button"
                      role="tab"
                      className={equipmentSource === 'inventory' ? 'active' : ''}
                      aria-selected={equipmentSource === 'inventory'}
                      onClick={() => setEquipmentSource('inventory')}
                    >
                      Inventory
                      <span className="num">{inventory?.total ?? 0}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={equipmentSource === 'gear' ? 'active' : ''}
                      aria-selected={equipmentSource === 'gear'}
                      onClick={() => setEquipmentSource('gear')}
                    >
                      Gear list
                      {gear && <span className="num">{gear.totals[gearIndex]?.pieces ?? 0}</span>}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={equipmentSource === 'plan' ? 'active' : ''}
                      aria-selected={equipmentSource === 'plan'}
                      onClick={() => setEquipmentSource('plan')}
                    >
                      On plan
                      <span className="num">{inventoryTotal.toLocaleString()}</span>
                    </button>
                  </div>
                  <div className="equipment-gesture-hint" role="note">
                    <span><strong>Drag</strong> to place once</span>
                    <span><strong>Click</strong> for repeat placement</span>
                    <span><kbd>Esc</kbd> cancels</span>
                  </div>
                  {equipmentSource === 'inventory' ? (
                    <InventoryPalette
                      inventory={inventory}
                      query={paletteQuery}
                      onQuery={setPaletteQuery}
                      category={paletteCategory}
                      onCategory={setPaletteCategory}
                      units={unitSystem}
                      canPlace={!!doc?.editable}
                      onPlace={(id, name) => armInventory(id, name)}
                      onChanged={inventoryChanged}
                      onRemoved={(name) => setInventoryUndoNotice(`Removed “${name}” from inventory`)}
                      onError={notify}
                      onStatus={showStatus}
                    />
                  ) : equipmentSource === 'gear' ? (
                    <GearPalette
                      lists={gear?.lists ?? []}
                      activeIndex={gearIndex}
                      query={gearQuery}
                      onQuery={setGearQuery}
                      canPlace={!!doc?.editable}
                      armedDescription={armedGearDescription}
                      onPlace={armGear}
                      onManage={() => showWorkspace('gear')}
                    />
                  ) : (
                    <div className="plan-items-palette">
                      <div className="section-title">
                        <span>Items placed on this plan</span>
                        <span className="num">{inventoryTotal.toLocaleString()}</span>
                      </div>
                      <div className="search inv-search">
                        <IconSearch size={13} />
                        <input
                          aria-label="Search items in this plan"
                          placeholder="Search placed items…"
                          value={invQuery}
                          onChange={(event) => setInvQuery(event.target.value)}
                        />
                      </div>
                      {(doc?.scene.inventory.length ?? 0) > 0 ? (
                        <ul className="inventory">
                          {doc?.scene.inventory
                            .filter((item) =>
                              invQuery.trim()
                                ? item.name.toLowerCase().includes(invQuery.trim().toLowerCase()) ||
                                  (item.category ?? '').toLowerCase().includes(invQuery.trim().toLowerCase())
                                : true,
                            )
                            .map((item) => (
                              <li key={item.name}>
                                <button
                                  className="inv-add"
                                  disabled={!doc?.editable}
                                  draggable={!!doc?.editable}
                                  title={doc?.editable ? `Place another ${item.name}` : 'This plan is read-only'}
                                  onClick={() => armGear(item.name)}
                                  onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = 'copy';
                                    event.dataTransfer.setData('application/x-groundplan-gear', item.name);
                                    event.dataTransfer.setData('application/x-groundplan-label', item.name);
                                    event.dataTransfer.setData('text/plain', item.name);
                                  }}
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
                      ) : (
                        <div className="layer-no-results">
                          <strong>No placed items yet</strong>
                          <span>Use Inventory or Gear list to add the first item.</span>
                        </div>
                      )}
                      <div className="plan-items-exports">
                        <button
                          type="button"
                          onClick={async () => {
                            const saved = await api.scheduleExport(true);
                            if (saved) showStatus(`Exported ${saved.split(/[\\/]/).pop()}`);
                          }}
                        >
                          Counts CSV
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const saved = await api.scheduleExport(false);
                            if (saved) showStatus(`Exported ${saved.split(/[\\/]/).pop()}`);
                          }}
                        >
                          Full schedule
                        </button>
                      </div>
                    </div>
                  )}
                </div>
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
              units={unitSystem}
              onChanged={inventoryChanged}
              onRemoved={(name) => setInventoryUndoNotice(`Removed “${name}” from inventory`)}
              canPlace={!!doc?.editable}
              onPlace={(id, name) => {
                armInventory(id, name);
                setPlanRailSource('equipment');
                setEquipmentSource('inventory');
                setRailOpen(true);
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
                onStatus={showStatus}
                canPlace={!!doc?.editable}
                notice={gear.notice}
                onInventoryChanged={inventoryChanged}
                onPlace={(description) => {
                  armGear(description);
                  setPlanRailSource('equipment');
                  setEquipmentSource('gear');
                  setRailOpen(true);
                  setView('plan');
                }}
              />
            ) : (
              <div className="placeholder">
                <Mark size={34} className="placeholder-mark" />
                <h1>No gear list open</h1>
                <p>
                  Import the gear list your rental system prints — or start a blank list and type lines by hand /
                  pull them from the company inventory.
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
                  <button className="btn-outline" onClick={() => void newGear()}>
                    <IconPlus />
                    New blank list…
                  </button>
                </div>
              </div>
            )
          ) : doc ? (
            <div className="canvas-with-palette">
              {(!railOpen || planRailSource !== 'equipment') && (
                <ObjectPalette
                  items={inventoryRows}
                  armedId={armedInventoryId}
                  disabled={!doc.editable}
                  onArm={armInventory}
                  onBrowse={(group) => {
                    setInsertGroup(group);
                    setInsertOpen(true);
                  }}
                />
              )}
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
              onDropItem={dropItem}
              onDropGear={dropGear}
              snapStep={snapStep}
              units={unitSystem}
              pointerMode={pointerMode}
              spanFrom={tool.tool.kind === 'span' ? tool.tool.from : null}
              pathPoints={tool.tool.kind === 'path' ? tool.tool.points : []}
              readout={tool.readout}
              onCanvasClick={(at) => {
                const { effect, refusal } = dispatchTool({ type: 'click', at });
                void applyToolEffect(effect, refusal);
              }}
              onToggleHand={() => {
                const { refusal } = dispatchTool({ type: 'toggle', choice: HAND });
                if (refusal) notify(refusal);
              }}
            />
            </div>
          ) : (
            <div className="placeholder">
              <Mark size={34} className="placeholder-mark" />
              <h1>Start a plan</h1>
              <p>
                Create one from nothing, or open an existing plan file — <code>.rv4</code>,{' '}
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
          {printOpen && doc && printPreview && (
            <div
              className="print-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !printBusy) setPrintOpen(false);
              }}
            >
              <section className="print-dialog" role="dialog" aria-modal="true" aria-labelledby="print-dialog-title">
                <header className="print-dialog-header">
                  <span className="print-dialog-icon" aria-hidden><IconPrint size={18} /></span>
                  <span className="print-dialog-title">
                    <strong id="print-dialog-title">Print plan to PDF</strong>
                    <small title={doc.name}>{doc.name.replace(/\.[^.]+$/, '')}</small>
                  </span>
                  <button
                    type="button"
                    className="print-close"
                    onClick={() => setPrintOpen(false)}
                    disabled={printBusy}
                    aria-label="Close print setup"
                    title="Close print setup (Esc)"
                  >
                    ×
                  </button>
                </header>

                <div className="print-dialog-body">
                  <section className="print-preview-pane" aria-label="Sheet preview">
                    <div className="print-preview-heading">
                      <span>
                        <strong>Sheet preview</strong>
                        <small>Visible layers · {printPreview.visibleObjects.toLocaleString()} objects</small>
                      </span>
                      <span className="print-preview-sheet-badge">{printPaper} · {printLandscape ? 'Landscape' : 'Portrait'}</span>
                    </div>
                    <div className="print-preview-stage">
                      <div
                        className="print-sheet"
                        style={{ aspectRatio: `${printPreview.pageWidth} / ${printPreview.pageHeight}` }}
                      >
                        <div className="print-sheet-frame">
                          <div
                            className={`print-plan-footprint${printPreview.fits ? '' : ' is-cropped'}`}
                            style={{
                              width: `${printPreview.footprintWidth}%`,
                              height: `${printPreview.footprintHeight}%`,
                            }}
                          >
                            <span>PLAN</span>
                          </div>
                        </div>
                        <div className="print-title-block">
                          <span className="print-title-plan">
                            <small>Plan</small>
                            <strong>{doc.scene.title ?? doc.name.replace(/\.[^.]+$/, '')}</strong>
                          </span>
                          <span>
                            <small>Scale</small>
                            <strong>{printPreview.scaleLabel}</strong>
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="print-preview-meta">
                      <span>
                        <small>Drawing</small>
                        <strong>
                          {formatLength(printPreview.drawingWidth, unitSystem)} ×{' '}
                          {formatLength(printPreview.drawingHeight, unitSystem)}
                        </strong>
                      </span>
                      <span>
                        <small>Paper</small>
                        <strong>{printPreview.paperLabel}</strong>
                      </span>
                    </div>
                    <div
                      className={`print-fit-callout${
                        printScale === 'fit' ? ' is-info' : printPreview.fits ? ' is-ok' : ' is-warning'
                      }`}
                      role="status"
                    >
                      <span className="print-fit-icon" aria-hidden>
                        {printScale !== 'fit' && !printPreview.fits ? <IconWarning size={15} /> : <IconFit size={15} />}
                      </span>
                      <span className="print-fit-copy">
                        <strong>
                          {printScale === 'fit'
                            ? 'Fits on one sheet — not to scale'
                            : printPreview.fits
                              ? 'Fits on one sheet at the selected scale'
                              : `Drawing will crop by about ${Math.max(1, Math.round((printPreview.overBy - 1) * 100))}%`}
                        </strong>
                        <small>
                          {printScale === 'fit'
                            ? 'Best for overview sheets; do not measure this print with an architectural scale.'
                            : printPreview.fits
                              ? 'The PDF remains measurable and the scale is recorded in its title block.'
                              : 'Choose a smaller scale, a larger sheet, or Fit to page before saving.'}
                        </small>
                      </span>
                      {printScale !== 'fit' && !printPreview.fits && (
                        <span className="print-fit-actions">
                          {printPreview.alternateFits && (
                            <button type="button" onClick={() => setPrintLandscape((current) => !current)}>
                              Use {printPreview.alternateOrientation.toLowerCase()}
                            </button>
                          )}
                          <button type="button" onClick={() => setPrintScale('fit')}>Fit to page</button>
                        </span>
                      )}
                    </div>
                  </section>

                  <section className="print-settings-pane" aria-label="Print settings">
                    <div className="print-settings-section">
                      <div className="print-settings-title">
                        <span className="num">1</span>
                        <span><strong>Sheet</strong><small>Choose a page and orientation</small></span>
                      </div>
                      <div className="field">
                        <label htmlFor="p-paper">Paper size</label>
                        <select id="p-paper" value={printPaper} onChange={(event) => setPrintPaper(event.target.value)}>
                          {Object.entries(PRINT_PAPERS).map(([id, paper]) => (
                            <option value={id} key={id}>{paper.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="print-orientation" role="group" aria-label="Page orientation">
                        {([false, true] as const).map((landscape) => (
                          <button
                            type="button"
                            key={String(landscape)}
                            className={printLandscape === landscape ? 'active' : ''}
                            aria-pressed={printLandscape === landscape}
                            onClick={() => setPrintLandscape(landscape)}
                          >
                            <span className={`print-orientation-page${landscape ? ' is-landscape' : ''}`} aria-hidden />
                            <span>{landscape ? 'Landscape' : 'Portrait'}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="print-settings-section">
                      <div className="print-settings-title">
                        <span className="num">2</span>
                        <span><strong>Drawing scale</strong><small>Fixed scales remain measurable</small></span>
                      </div>
                      <div className="field">
                        <label htmlFor="p-scale">Scale</label>
                        <select id="p-scale" value={printScale} onChange={(event) => setPrintScale(event.target.value)}>
                          {PRINT_SCALES.map((scale) => (
                            <option value={scale.id} key={scale.id}>{scale.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="print-settings-section">
                      <div className="print-settings-title">
                        <span className="num">3</span>
                        <span><strong>Title block</strong><small>Add an optional job or issue note</small></span>
                      </div>
                      <div className="field">
                        <label htmlFor="p-subtitle">Subtitle</label>
                        <input
                          id="p-subtitle"
                          value={printSubtitle}
                          onChange={(event) => setPrintSubtitle(event.target.value)}
                          placeholder="Job number, issue, or revision"
                          maxLength={80}
                        />
                      </div>
                    </div>

                    <div className="print-layer-summary">
                      <span className="print-layer-summary-copy">
                        <IconLayers size={14} />
                        <span>
                          <strong>{visible.size} of {LAYERS.length} layers included</strong>
                          <small>{LAYERS.filter((layer) => visible.has(layer.id)).map((layer) => layer.label).join(' · ') || 'No visible layers'}</small>
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setPrintOpen(false);
                          setInspectorOpen(true);
                          setInspectorTab('layers');
                        }}
                      >
                        Manage
                      </button>
                    </div>
                  </section>
                </div>

                <footer className="print-dialog-footer">
                  <span>
                    {visible.size === 0
                      ? 'Show at least one layer before printing.'
                      : 'Creates a sharp, single-page vector PDF.'}
                  </span>
                  <div>
                    <button type="button" onClick={() => setPrintOpen(false)} disabled={printBusy}>Cancel</button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void printPdf()}
                      disabled={printBusy || visible.size === 0}
                    >
                      <IconPrint size={14} />
                      {printBusy ? 'Preparing PDF…' : 'Save PDF…'}
                    </button>
                  </div>
                </footer>
              </section>
            </div>
          )}
          {toolBannerState && (
            <div
              className={`arming${tool.tool.kind === 'path' ? ' is-path' : ''}`}
              role="status"
              aria-live="polite"
            >
              {toolBannerState.badge && (
                <span
                  className={`tool-state-badge ${
                    toolBannerState.badge.tone === 'temporary' ? 'is-temporary' : 'is-persistent'
                  }`}
                >
                  {toolBannerState.badge.text}
                </span>
              )}
              <span className="tool-state-message">
                {toolBannerState.message}
                {toolBannerState.emphasis && <strong>{toolBannerState.emphasis}</strong>}
              </span>
              {toolBannerState.actions.map((action) =>
                action.id === 'save-dimension' ? (
                  <button
                    key={action.id}
                    className="btn-primary"
                    onClick={() => void keepMeasurement()}
                    disabled={!canCreateDimension}
                    title={
                      canCreateDimension
                        ? 'Keep this distance as an object-linked plan dimension'
                        : 'This plan is read-only'
                    }
                  >
                    {action.label}
                  </button>
                ) : action.id === 'finish-room' ? (
                  <button key={action.id} className="btn-primary" onClick={finishRoomOutline}>
                    {action.label}
                  </button>
                ) : action.id === 'undo-point' ? (
                  <button key={action.id} onClick={() => dispatchTool({ type: 'undo-point' })}>
                    {action.label}
                  </button>
                ) : (
                  <button key={action.id} onClick={() => dispatchTool({ type: 'pick', choice: SELECT })}>
                    {action.label}
                  </button>
                ),
              )}
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

        <aside ref={inspectorRef} className="inspector" aria-hidden={!inspectorOpen}>
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
                <button
                  className="btn-outline"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  title="Write a folder you can put on a USB stick or shared drive for other Groundplan installs"
                  onClick={async () => {
                    const reply = await api.inventoryExportPack();
                    if (reply.cancelled) return;
                    if (reply.ok) {
                      showStatus(
                        `Exported ${reply.items ?? 0} items to ${reply.path?.split(/[\\/]/).pop() ?? 'folder'}`,
                      );
                    } else if (reply.reason) notify(reply.reason);
                  }}
                >
                  <IconExport size={14} />
                  Export pack for other computers…
                </button>
                <button
                  className="btn-outline"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  title="Merge an inventory pack from USB or a shared folder into this computer"
                  onClick={async () => {
                    const reply = await api.inventoryImportPack();
                    if (reply.cancelled) return;
                    if (reply.ok && reply.inventory) {
                      setInventory(reply.inventory as InventoryState);
                      showStatus(`Imported pack — ${reply.added} new, ${reply.updated} updated`);
                    } else if (reply.reason) notify(reply.reason);
                  }}
                >
                  <IconFolder size={14} />
                  Import pack from USB / folder…
                </button>
                <p className="hint">
                  Company inventory lives on this computer. To push new items to the shop, export a pack and import
                  it on each machine. Upload… still works for PDFs, spreadsheets, and shape libraries.
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
              <div className="inspector-chrome">
                <header className="inspector-heading">
                  <span className="inspector-heading-icon" aria-hidden>
                    <IconSidebarRight size={16} />
                  </span>
                  <span className="inspector-heading-copy">
                    <small>Inspector</small>
                    <strong title={doc.name}>{doc.name.replace(/\.[^.]+$/, '') || 'Untitled plan'}</strong>
                  </span>
                  <span className={`inspector-access${doc.editable ? '' : ' is-readonly'}`}>
                    {doc.editable ? 'Editable' : 'Read only'}
                  </span>
                </header>

                <nav className="inspector-tabs" aria-label="Plan inspector">
                  {([
                    { id: 'properties', label: 'Properties', icon: <IconEdit size={14} /> },
                    { id: 'room', label: 'Room', icon: <IconDrawRect size={14} /> },
                    { id: 'create', label: 'Create', icon: <IconPlus size={14} /> },
                    { id: 'layers', label: 'Layers', icon: <IconLayers size={14} /> },
                  ] as const).map(({ id, label, icon }) => (
                  <button
                    key={id}
                    className={inspectorTab === id ? 'active' : ''}
                    onClick={() => setInspectorTab(id)}
                    aria-current={inspectorTab === id ? 'page' : undefined}
                  >
                    <span className="inspector-tab-icon" aria-hidden>{icon}</span>
                    <span>{label}</span>
                  </button>
                ))}
                </nav>

                <div
                  className={`inspector-context${tool.tool.kind !== 'select' ? ' is-tool-active' : ''}`}
                  aria-live="polite"
                >
                  <span className="inspector-context-marker" aria-hidden />
                  <span className="inspector-context-copy">
                    <strong>
                      {tool.tool.kind === 'stamp'
                        ? 'Placement active'
                        : tool.tool.kind === 'span'
                          ? 'Drawing tool active'
                          : tool.tool.kind === 'path'
                            ? 'Room outline active'
                          : tool.tool.kind === 'hand'
                            ? 'Hand tool active'
                            : selectedIds.length
                              ? `${selectedIds.length.toLocaleString()} selected`
                              : 'Nothing selected'}
                    </strong>
                    <small>
                      {tool.tool.kind === 'stamp'
                        ? toolBannerState?.emphasis ?? 'Click the plan to place'
                        : tool.tool.kind === 'span'
                          ? toolBannerState?.message ?? 'Follow the prompt over the plan'
                          : tool.tool.kind === 'path'
                            ? toolBannerState?.message ?? 'Click around the room boundary'
                          : tool.tool.kind === 'hand'
                            ? 'Drag the plan to pan · press H to finish'
                            : selectedIds.length
                              ? selection?.name ?? selection?.cls.replace(/^RV/, '') ?? 'Use the controls below to edit the selection'
                              : 'Select a shape on the plan to edit it here'}
                    </small>
                  </span>
                  {(tool.tool.kind !== 'select' || selectedIds.length > 0) && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        dispatchTool({ type: 'pick', choice: SELECT });
                        if (tool.tool.kind === 'select') setSelectedIds([]);
                      }}
                    >
                      {tool.tool.kind === 'select' ? 'Clear' : 'Done'}
                    </button>
                  )}
                </div>
              </div>

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
                        ? `${formatLength(extent.maxX - extent.minX, unitSystem)} × ${formatLength(extent.maxY - extent.minY, unitSystem)}`
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

                    {selection.dimension && (
                      <div className="section" style={{ padding: 0, marginBottom: 12 }}>
                        <div className="section-title">
                          <span>Dimension</span>
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor="dim-length">Length</label>
                            <input
                              id="dim-length"
                              value={dimLengthDraft}
                              disabled={!doc.editable}
                              onChange={(e) => setDimLengthDraft(e.target.value)}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="dim-angle">Angle °</label>
                            <input
                              id="dim-angle"
                              value={dimAngleDraft}
                              disabled={!doc.editable}
                              onChange={(e) => setDimAngleDraft(e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="actions-row">
                          <button
                            type="button"
                            disabled={!doc.editable}
                            onClick={async () => {
                              const length = parseLength(dimLengthDraft, unitSystem);
                              const angle = Number(dimAngleDraft);
                              if (!(length && length > 0) || !Number.isFinite(angle)) {
                                notify('Enter a length and angle');
                                return;
                              }
                              applied(
                                (await api.setDimensionProps(selection.nodeId, length, angle)) as {
                                  ok: boolean;
                                  reason?: string;
                                  doc?: Doc;
                                },
                              );
                            }}
                          >
                            Apply length / angle
                          </button>
                        </div>
                        <div className="field">
                          <label htmlFor="dim-scale">Scale drawing to dimension</label>
                          <input
                            id="dim-scale"
                            value={dimScaleDraft}
                            disabled={!doc.editable}
                            onChange={(e) => setDimScaleDraft(e.target.value)}
                            placeholder="Known real length"
                          />
                        </div>
                        <div className="actions-row">
                          <button
                            type="button"
                            disabled={!doc.editable}
                            title="Uniformly scale the whole plan so this dimension matches the known length"
                            onClick={async () => {
                              const known = parseLength(dimScaleDraft, unitSystem);
                              if (!(known && known > 0)) {
                                notify('Enter the known real length');
                                return;
                              }
                              applied(
                                (await api.scaleToDimension(selection.nodeId, known)) as {
                                  ok: boolean;
                                  reason?: string;
                                  doc?: Doc;
                                },
                              );
                            }}
                          >
                            Scale drawing to dimension
                          </button>
                        </div>
                      </div>
                    )}

                    {selection.canRelabel && (
                      <div className="field">
                        <label htmlFor="label-text">
                          {selection.cls === 'RVLabel' ? 'Text' : 'Name'}
                        </label>
                        {selection.cls === 'RVLabel' ? (
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
                        ) : (
                          <input
                            id="label-text"
                            type="text"
                            value={labelDraft}
                            onChange={(e) => setLabelDraft(e.target.value)}
                            onBlur={async () => {
                              if (!selection || labelDraft.trim() === (selection.name ?? '').trim()) return;
                              applied(
                                (await api.relabel(selection.nodeId, labelDraft)) as {
                                  ok: boolean;
                                  reason?: string;
                                  doc?: Doc;
                                },
                              );
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            disabled={!doc.editable}
                          />
                        )}
                        <span className="field-help">
                          {selection.cls === 'RVLabel'
                            ? `Press ${api.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter to apply.`
                            : 'Shown in the inventory and on the drawing.'}
                        </span>
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

                    {(canResizeSelection || canPositionSelection) && (
                      <div className="field">
                        <label htmlFor="drawing-units">Measurements</label>
                        <select
                          id="drawing-units"
                          value={unitSystem}
                          onChange={(e) => setDrawingUnits(e.target.value === 'metric' ? 'metric' : 'imperial')}
                          title="How lengths are shown and how bare numbers are read. You can still type cm, m, ft, or inches on any field."
                        >
                          <option value="imperial">Feet &amp; inches</option>
                          <option value="metric">Metres &amp; centimetres</option>
                        </select>
                        <span className="field-help">
                          Type {unitSystem === 'metric' ? '120cm or 1.2m' : "4' or 48\""} — or use a suffix in either system.
                        </span>
                      </div>
                    )}

                    {canResizeSelection && (
                      <div className="field">
                        <label htmlFor="size-w">
                          Size ({unitSystem === 'metric' ? 'cm / m' : 'ft / in'})
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
                            placeholder={unitSystem === 'metric' ? '120cm' : "4'"}
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
                            placeholder={unitSystem === 'metric' ? '80cm' : "3'"}
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
                  onError={notify}
                  drawingRoomOutline={isPressed(tool, roomOutlineChoice)}
                  onDrawRoomOutline={() => {
                    const { refusal } = dispatchTool({ type: 'toggle', choice: roomOutlineChoice });
                    if (refusal) notify(refusal);
                    else setSelectedIds([]);
                  }}
                  onRoomAuthored={async () => {
                    const persisted = await persistNewRoomOutlineIfNeeded();
                    if (persisted.doc) {
                      setDoc(persisted.doc);
                      showStatus('Room saved');
                    } else if (persisted.failed) {
                      notify(persisted.failed);
                    }
                  }}
                  onSeatingStatus={setSeatingClearances}
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
                    onChange={(e) => editAnnotationDraft(e.target.value)}
                    disabled={!canCreateLabel}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        armLabel();
                      }
                    }}
                  />
                </div>
                {annotationStyleHint && (
                  <div className="notice annotation-capability-notice" role="status">
                    <IconWarning size={14} />
                    <span>{annotationStyleHint}</span>
                  </div>
                )}
                <div className="actions-row">
                  <button
                    onClick={armLabel}
                    disabled={!canCreateLabel || !annotationDraft.trim()}
                    title={
                      canCreateLabel ? 'Place this label on the plan' : 'This plan is read-only'
                    }
                  >
                    <IconPlus size={14} />
                    Place label
                  </button>
                  <button
                    className={isPressed(tool, DIMENSION) ? 'is-on' : ''}
                    onClick={toggleDimension}
                    disabled={!canCreateDimension}
                    title={
                      canCreateDimension
                        ? 'Draw an object-linked dimension (D)'
                        : 'This plan is read-only'
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
                      Use <kbd>M</kbd> for a temporary distance. This plan is read-only, so nothing can be saved
                      onto it.
                    </>
                  )}{' '}
                  {canCreateLabel ? (
                    <>
                      Press <kbd>T</kbd> to place a label.
                    </>
                  ) : (
                    'Open an editable plan to add labels.'
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
                    const description =
                      seatKind === 'round'
                        ? `${seatTable} with ${seatCount} seats`
                        : `${seatRows} × ${seatPerRow} ${seatKind}`;
                    const { refusal } = dispatchTool({
                      type: 'pick',
                      choice: {
                        kind: 'stamp',
                        stamp: {
                          what: 'seating',
                          description,
                          request: {
                            kind: seatKind,
                            chair: seatChair,
                            table: seatTable || undefined,
                            seats: seatCount,
                            rows: seatRows,
                            perRow: seatPerRow,
                          },
                        },
                      },
                    });
                    if (refusal) notify(refusal);
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
              <div className="section layer-manager">
                <div className="section-title">
                  <span>Drawing layers</span>
                  <span className="layer-summary">{visible.size}/{LAYERS.length} visible</span>
                </div>
                <div className="layer-stats" aria-label="Layer summary">
                  <div>
                    <strong>{visible.size}/{LAYERS.length}</strong>
                    <span>Visible layers</span>
                  </div>
                  <div>
                    <strong>{visibleLayerObjectTotal.toLocaleString()}</strong>
                    <span>of {layerObjectTotal.toLocaleString()} objects shown</span>
                  </div>
                </div>
                <div className="layer-bulk-actions" aria-label="Layer visibility controls">
                  <button type="button" onClick={() => setAllLayersVisible(true)} disabled={!doc}>
                    <IconLayers size={14} />
                    Show all
                  </button>
                  <button type="button" onClick={() => setAllLayersVisible(false)} disabled={!doc || visible.size === 0}>
                    Hide all
                  </button>
                </div>
                <div className="search layer-search">
                  <IconSearch size={13} />
                  <input
                    aria-label="Search layers"
                    placeholder="Find a layer or item…"
                    value={layerQuery}
                    onChange={(event) => setLayerQuery(event.target.value)}
                  />
                </div>
                <div className="layer-groups">
                  {organizedLayers.map((group) => {
                    const groupLayers = LAYERS.filter((layer) => layer.group === group.id);
                    const visibleInGroup = groupLayers.filter((layer) => visible.has(layer.id)).length;
                    const allGroupVisible = visibleInGroup === groupLayers.length;
                    const groupOpen = !!layerQuery.trim() || openLayerGroups.has(group.id);
                    const groupPanelId = `layer-group-${group.id}`;
                    return (
                      <section className={`layer-group${groupOpen ? ' is-open' : ''}`} key={group.id}>
                        <header className="layer-group-heading">
                          <button
                            type="button"
                            className="layer-group-disclosure"
                            aria-expanded={groupOpen}
                            aria-controls={groupPanelId}
                            onClick={() => toggleLayerGroupOpen(group.id)}
                          >
                            <span className="layer-group-chevron" aria-hidden>›</span>
                            <span className="layer-group-copy">
                              <strong>{group.label}</strong>
                              <small>{group.description}</small>
                            </span>
                            <span className="layer-group-count num">
                              {groupLayers.length} layer{groupLayers.length === 1 ? '' : 's'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="layer-group-visibility"
                            onClick={() => setLayerGroupVisible(group.id, !allGroupVisible)}
                            title={`${allGroupVisible ? 'Hide' : 'Show'} every layer in ${group.label}`}
                          >
                            {allGroupVisible ? 'Hide' : 'Show'}
                            <span className="num">{visibleInGroup}/{groupLayers.length}</span>
                          </button>
                        </header>
                        <div className="layer-group-panel" id={groupPanelId} hidden={!groupOpen}>
                          <ul className="layers">
                            {group.layers.map((layer) => {
                              const count = layerCounts.get(layer.id) ?? 0;
                              const isVisible = visible.has(layer.id);
                              const query = layerQuery.trim().toLowerCase();
                              const items = layerItems.get(layer.id) ?? [];
                              const matchingItems = query
                                ? items.filter((item) => item.searchText.includes(query))
                                : items;
                              const hasItemSearchMatch = !!query && matchingItems.length > 0;
                              const displayedItems = hasItemSearchMatch ? matchingItems : items;
                              const itemsOpen = openItemLayers.has(layer.id) || hasItemSearchMatch;
                              const itemLimit = layerItemLimits[layer.id] ?? 50;
                              const shownItems = displayedItems.slice(0, itemLimit);
                              const itemPanelId = `layer-items-${layer.id}`;
                              return (
                                <li
                                  key={layer.id}
                                  className={`${isVisible ? 'is-visible' : 'is-hidden'}${count === 0 ? ' is-empty' : ''}${itemsOpen ? ' has-items-open' : ''}`}
                                >
                                  <div className="layer-row-main">
                                    <button
                                      type="button"
                                      className="layer-visibility"
                                      onClick={() => toggleLayer(layer.id)}
                                      aria-pressed={isVisible}
                                      title={`${isVisible ? 'Hide' : 'Show'} ${layer.label}`}
                                    >
                                      <span className="layer-check" aria-hidden>{isVisible ? '✓' : ''}</span>
                                      <span className="swatch" style={{ background: layer.tint }} />
                                      <span className="layer-copy">
                                        <strong>{layer.label}</strong>
                                        <small>{layer.description}</small>
                                      </span>
                                      <span className="layer-object-count num" title={`${count} objects`}>{count}</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="layer-only"
                                      onClick={() => showOnlyLayer(layer.id)}
                                      disabled={!doc || count === 0}
                                      title={`Hide every layer except ${layer.label}`}
                                    >
                                      Only
                                    </button>
                                  </div>
                                  <div className="layer-row-actions">
                                    <button
                                      type="button"
                                      className="layer-items-disclosure"
                                      onClick={() => toggleLayerItemsOpen(layer.id)}
                                      disabled={!doc || items.length === 0}
                                      aria-expanded={itemsOpen}
                                      aria-controls={itemPanelId}
                                    >
                                      <span className="layer-items-chevron" aria-hidden>›</span>
                                      Items line by line
                                      <span className="num">{items.length.toLocaleString()}</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="layer-select"
                                      onClick={() => selectLayer(layer.id)}
                                      disabled={!doc || count === 0}
                                      title={`Select every object on the ${layer.label.toLowerCase()} layer`}
                                    >
                                      Select all
                                    </button>
                                  </div>
                                  <div className="layer-item-panel" id={itemPanelId} hidden={!itemsOpen}>
                                    <div className="layer-item-panel-heading">
                                      <span>
                                        <strong>{hasItemSearchMatch ? 'Matching items' : 'Every item'}</strong>
                                        <small>Choose a row to select it on the plan</small>
                                      </span>
                                      <span className="num">{displayedItems.length.toLocaleString()}</span>
                                    </div>
                                    <div className="layer-item-list" role="list" aria-label={`Items on ${layer.label}`}>
                                      {shownItems.map((item, index) => (
                                        <div role="listitem" key={item.selectId}>
                                          <button
                                            type="button"
                                            className={selectedIds.includes(item.selectId) ? 'is-selected' : ''}
                                            onClick={() => selectLayerItem(layer.id, item)}
                                            aria-current={selectedIds.includes(item.selectId) ? 'true' : undefined}
                                          >
                                            <span className="layer-item-index num">{index + 1}</span>
                                            <span className="layer-item-copy">
                                              <strong>{item.label}</strong>
                                              <small>
                                                {item.kind}
                                                {item.x !== undefined && item.y !== undefined
                                                  ? ` · ${formatLength(item.x, unitSystem)}, ${formatLength(item.y, unitSystem)}`
                                                  : ''}
                                              </small>
                                            </span>
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                    {shownItems.length < displayedItems.length && (
                                      <button
                                        type="button"
                                        className="layer-items-more"
                                        onClick={() =>
                                          setLayerItemLimits((current) => ({
                                            ...current,
                                            [layer.id]: Math.min(displayedItems.length, itemLimit + 100),
                                          }))
                                        }
                                      >
                                        Show next {Math.min(100, displayedItems.length - shownItems.length).toLocaleString()}
                                        <span className="num">
                                          {(displayedItems.length - shownItems.length).toLocaleString()} remaining
                                        </span>
                                      </button>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      </section>
                    );
                  })}
                  {organizedLayers.length === 0 && (
                    <div className="layer-no-results">
                      <strong>No matching layers</strong>
                      <span>Try walls, equipment, dimensions, or geometry.</span>
                    </div>
                  )}
                </div>
              </div>

                </>
              )}
            </>
          ) : (
            <div className="inspector-empty">
              <span className="inspector-empty-icon" aria-hidden>
                <IconSidebarRight size={22} />
              </span>
              <div>
                <small>Inspector</small>
                <strong>Ready when your plan is</strong>
              </div>
              <p>Open or create a plan to edit selections, room settings, drawing tools, and layers here.</p>
              <ul>
                <li>Select an object to see exact controls</li>
                <li>Choose a tool to see its active state</li>
                <li>Manage visibility from Layers</li>
              </ul>
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
        {view === 'plan' && doc && (
          <>
            <span className="num">
              Chairs: {furnitureCounts.chairs} · Tables: {furnitureCounts.tables}
            </span>
            <span className="status-sep" />
          </>
        )}
        {view === 'plan' && seatingClearances && (
          <>
            <span className="num" title="Clearances from the last seating preview or place">
              Aisle C {formatLength(seatingClearances.centreAisle, unitSystem)} · S{' '}
              {formatLength(seatingClearances.side, unitSystem)} · W{' '}
              {formatLength(seatingClearances.wing, unitSystem)} · F{' '}
              {formatLength(seatingClearances.front, unitSystem)} · R{' '}
              {formatLength(seatingClearances.rear, unitSystem)}
            </span>
            <span className="status-sep" />
          </>
        )}
        {view === 'plan' && cursor && (
          <>
            <span className="num">
              {formatLength(cursor.x, unitSystem)}, {formatLength(cursor.y, unitSystem)}
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
