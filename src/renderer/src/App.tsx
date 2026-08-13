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
import { createPortal } from 'react-dom';

import { formatLength, parseLength } from '../../format/units.js';
import { PlanCanvas } from './PlanCanvas.js';
import { GearView, GearSummary } from './GearView.js';
import { GearPalette } from './GearPalette.js';
import { InventoryView, type InventoryState } from './InventoryView.js';
import { InventoryPalette } from './InventoryPalette.js';
import { SettingsDialog, type SettingsAppPreferences } from './SettingsDialog.js';
import { toSvg } from './svg.js';
import {
  DIMENSION,
  DIRECT_SELECT,
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
  IconCopy,
  IconPaste,
  IconGroup,
  IconUngroup,
  IconEdit,
  IconExport,
  IconFile,
  IconFit,
  IconFolder,
  IconEye,
  IconChair,
  IconCalculator,
  IconDirectSelect,
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
  IconHand,
} from './icons.js';
import type { Layer, Scene } from '../../format/scene.js';
import type { PlanBackground } from '../../format/companion.js';
import RoomPanel from './RoomPanel.js';
import { countFurniture } from './furniture-counts.js';
import ObjectPalette from './ObjectPalette.js';
import PlanToolDock, { type PlanToolDockSide } from './PlanToolDock.js';
import InsertPicker from './InsertPicker.js';
import ShapeEditorWizard from './ShapeEditorWizard.js';
import BuildStageDialog from './BuildStageDialog.js';
import PointEditor, { type EditablePointPath } from './PointEditor.js';
import SpaceCalculator from './SpaceCalculator.js';
import RoomRefineWorkspace from './RoomRefineWorkspace.js';
import WallEditHud from './WallEditHud.js';
import WallEditToolbar from './WallEditToolbar.js';
import CreateDialog from './CreateDialog.js';
import InventoryItemEditor, { type EditableInventoryItem } from './InventoryItemEditor.js';
import BackgroundLayerPanel from './BackgroundLayerPanel.js';
import BackgroundImageDialog from './BackgroundImageDialog.js';
import PlanFolderWorkspace from './PlanFolderWorkspace.js';
import WelcomeHome from './WelcomeHome.js';
import { flattenInsertLeaves, matchInsertItem, type InsertGroupId } from '../../inventory/insert-catalog.js';
import { type PlanIdentityFields } from './ShowSetupPanel.js';
import NewPlanDialog from './NewPlanDialog.js';
import OpenPlanChooser from './OpenPlanChooser.js';
import { SnappySlider } from './SnappySlider.js';
import type { CustomRoomPrefs } from './custom-room.js';
import type { GearList, GearTotals } from '../../gear/model.js';
import type { GroundplanApi } from '../../preload/index.js';

declare global {
  interface Window {
    groundplan: GroundplanApi;
  }
}

const api = window.groundplan;

type LayerGroupId = 'structure' | 'content' | 'markup';
type SelectionScope =
  | { kind: 'layer'; id: Layer }
  | { kind: 'group'; id: LayerGroupId };

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
  identity?: { date: string; venue: string; event: string; contact: string };
  hasRoom?: boolean;
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
  textStyle?: {
    family: string;
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikeOut: boolean;
    angleDegrees: number;
  };
  pointPaths: EditablePointPath[];
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

function placeMethodStatus(method?: string, name?: string): string {
  const item = name ? ` ${name}` : '';
  switch (method) {
    case 'matched':
      return `Placed${item} from the plan's own shapes`;
    case 'library':
      return `Placed${item} from a shape library`;
    case 'symbol':
      return `Placed${item} from a harvested symbol`;
    case 'traced':
      return `Placed${item} from a traced outline`;
    case 'synthesized':
      return `Placed${item} with a drawn outline`;
    case 'box':
    default:
      return `Placed${item} as a sized box`;
  }
}

interface PlanTab {
  path: string;
  name: string;
  dirty: boolean;
  editable: boolean;
}

/** One foot in logical units — duplicate offset and coarse layout. */
const FOOT = 120;
const UNITS_PER_INCH = 10;

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
  const [planTabs, setPlanTabs] = useState<PlanTab[]>([]);
  const [activePlanPath, setActivePlanPath] = useState<string | null>(null);
  const [planClipboard, setPlanClipboard] = useState<{ count: number; sourceName: string } | null>(null);
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [openPlanChooserOpen, setOpenPlanChooserOpen] = useState(false);
  const [startNewRoomOutline, setStartNewRoomOutline] = useState(false);
  const [customRoomPrefs, setCustomRoomPrefs] = useState<CustomRoomPrefs | null>(null);
  /** Sticky custom-draw recovery until the outline exists or the empty plan is discarded. */
  const [awaitingRoomOutline, setAwaitingRoomOutline] = useState(false);
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
  const [planFolderWorkspaceOpen, setPlanFolderWorkspaceOpen] = useState(false);
  const [planFolderEditor, setPlanFolderEditor] = useState<
    { kind: 'create' | 'rename'; folderId?: string } | null
  >(null);
  const [planFolderDraft, setPlanFolderDraft] = useState('');
  const [recoveries, setRecoveries] = useState<RecoveryEntry[]>([]);
  const [visible, setVisible] = useState<Set<Layer>>(new Set(LAYERS.map((l) => l.id)));
  const [paper, setPaper] = useState(true);
  const [appearance, setAppearance] = useState<SettingsAppPreferences['appearance']>(() => {
    const saved = localStorage.getItem('groundplan:appearance');
    return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const darkMode = appearance === 'dark' || (appearance === 'system' && systemDark);
  const [density, setDensity] = useState<SettingsAppPreferences['density']>(
    () => localStorage.getItem('groundplan:density') === 'compact' ? 'compact' : 'comfortable',
  );
  const [showTooltips, setShowTooltips] = useState(
    () => localStorage.getItem('groundplan:tooltips') !== 'false',
  );
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('groundplan:rail-open') !== 'false');
  const [inspectorOpen, setInspectorOpen] = useState(
    () => localStorage.getItem('groundplan:inspector-open') !== 'false',
  );
  const [toolDockOpen, setToolDockOpen] = useState(
    () => localStorage.getItem('groundplan:tool-dock-open') !== 'false',
  );
  const [toolDockCompact, setToolDockCompact] = useState(
    () => localStorage.getItem('groundplan:tool-dock-compact') === 'true',
  );
  const [toolDockSide, setToolDockSide] = useState<PlanToolDockSide>(() => {
    const saved = localStorage.getItem('groundplan:tool-dock-side');
    return saved === 'right' || saved === 'floating' ? saved : 'left';
  });
  const [toolDockPosition, setToolDockPosition] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('groundplan:tool-dock-position') ?? 'null') as unknown;
      if (
        saved &&
        typeof saved === 'object' &&
        'x' in saved &&
        'y' in saved &&
        typeof saved.x === 'number' &&
        typeof saved.y === 'number'
      ) {
        return { x: Math.max(0, saved.x), y: Math.max(0, saved.y) };
      }
    } catch {
      // A malformed preference should never keep the editor from opening.
    }
    return { x: 12, y: 12 };
  });
  const [toolDockOrder, setToolDockOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('groundplan:tool-dock-order') ?? '[]') as unknown;
      return Array.isArray(saved)
        ? saved
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id === 'text' ? 'add-text' : id)
        : [];
    } catch {
      return [];
    }
  });
  const [toolDockHidden, setToolDockHidden] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('groundplan:tool-dock-hidden') ?? '[]') as unknown;
      // Add Text is a promoted core tool. A legacy hidden `text` preference
      // must not make the newly requested control disappear on first launch.
      return Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === 'string' && id !== 'text')
        : [];
    } catch {
      return [];
    }
  });
  const [fitToken, setFitToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectionScope, setSelectionScope] = useState<SelectionScope | null>(null);
  /** The details panel describes one object; with a group, that is the first. */
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [textEditingId, setTextEditingId] = useState<number | null>(null);
  const [textEditingOriginal, setTextEditingOriginal] = useState<string | null>(null);
  const commitTextEditingRef = useRef<(close?: boolean) => Promise<boolean>>(async () => true);
  const [textStyleDraft, setTextStyleDraft] = useState({
    family: 'Arial',
    size: 9,
    bold: false,
    italic: false,
    underline: false,
    strikeOut: false,
    angleDegrees: 0,
  });
  const [textSizeDraft, setTextSizeDraft] = useState('9');
  const [textRotationDraft, setTextRotationDraft] = useState('0');
  const [sizeDraft, setSizeDraft] = useState({ width: '', height: '' });
  const [positionDraft, setPositionDraft] = useState({ x: '', y: '' });
  const [showGrid, setShowGrid] = useState(true);
  const [planBackground, setPlanBackground] = useState<PlanBackground | null>(null);
  const [objectSnap, setObjectSnap] = useState(true);
  const [autoFitOnOpen, setAutoFitOnOpen] = useState(true);
  const [openPropertiesOnSelect, setOpenPropertiesOnSelect] = useState(true);
  const [nudgeStep, setNudgeStep] = useState(UNITS_PER_INCH);
  const [fineNudgeStep, setFineNudgeStep] = useState(1);
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
  const [seatingOpen, setSeatingOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [refineRoomOpen, setRefineRoomOpen] = useState(false);
  const [roomWorkspaceFocus, setRoomWorkspaceFocus] = useState<'walls' | 'room'>('room');
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [layoutKits, setLayoutKits] = useState<
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
  >([]);
  const [kitsBusy, setKitsBusy] = useState(false);
  const [bankPresets, setBankPresets] = useState<
    Array<{
      id: string;
      name: string;
      savedAt: string;
      block: Record<string, unknown>;
    }>
  >([]);
  const [newItemEditor, setNewItemEditor] = useState<EditableInventoryItem | null>(null);
  const [newItemProvisional, setNewItemProvisional] = useState(false);
  const [createMenuPos, setCreateMenuPos] = useState<{ top: number; left: number } | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const createMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState({
    stage: false,
    insert: false,
    repeat: false,
    seating: false,
    print: false,
  });
  const [dimLengthDraft, setDimLengthDraft] = useState('');
  const [dimAngleDraft, setDimAngleDraft] = useState('');
  const [dimScaleDraft, setDimScaleDraft] = useState('');
  const [armedInventoryId, setArmedInventoryId] = useState<string | null>(null);
  const [recentInventory, setRecentInventory] = useState<Array<{ id: string; name: string }>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('groundplan:recent-inventory') ?? '[]');
      return Array.isArray(saved)
        ? saved
            .filter(
              (row): row is { id: string; name: string } =>
                !!row && typeof row.id === 'string' && typeof row.name === 'string',
            )
            .slice(0, 8)
        : [];
    } catch {
      return [];
    }
  });
  const [rotationDraft, setRotationDraft] = useState('15');
  const [arrayCountDraft, setArrayCountDraft] = useState('7');
  const [arrayDirection, setArrayDirection] = useState<'right' | 'left' | 'down' | 'up'>('right');
  const [colorDraft, setColorDraft] = useState('#20252b');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(0.05);
  const [view, setView] = useState<Workspace>('plan');
  const [planRailSource, setPlanRailSource] = useState<PlanRailSource>('equipment');
  const [equipmentSource, setEquipmentSource] = useState<EquipmentSource>('inventory');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('layers');
  const [wallEdit, setWallEdit] = useState<import('./wall-edit.js').WallEditSession | null>(null);
  const [wallPickIndex, setWallPickIndex] = useState<number | null>(null);
  const [wallEditGesture, setWallEditGesture] = useState<'push' | 'curve' | 'length'>('push');
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
  /** Full inventory for Insert/ObjectPalette matching — never filtered by palette search. */
  const [catalogInventory, setCatalogInventory] = useState<InventoryState | null>(null);
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
  const [annotationColor, setAnnotationColor] = useState('#20252b');
  const annotationInputRef = useRef<HTMLTextAreaElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  /** Snap step in logical units; 0 is off. Object alignment always applies. */
  const [snapStep, setSnapStep] = useState(UNITS_PER_INCH);
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
  const [seatAngle, setSeatAngle] = useState(0);
  const [seatSpacingFt, setSeatSpacingFt] = useState(2);
  const [seatRowSpacingFt, setSeatRowSpacingFt] = useState(3);
  const [seatRowLengths, setSeatRowLengths] = useState('');
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
  const textEditDirty =
    textEditingId != null &&
    labelDraft !==
      (doc?.scene.primitives.find(
        (primitive) => primitive.type === 'text' && primitive.nodeId === textEditingId,
      )?.text ?? '');

  useEffect(() => {
    // Room layout mode forces a transient collapse — don't persist that.
    if (refineRoomOpen) return;
    localStorage.setItem('groundplan:rail-open', String(railOpen));
  }, [railOpen, refineRoomOpen]);

  useEffect(() => {
    if (refineRoomOpen) return;
    localStorage.setItem('groundplan:inspector-open', String(inspectorOpen));
  }, [inspectorOpen, refineRoomOpen]);

  const layoutBeforeRefineRef = useRef<{ rail: boolean; inspector: boolean } | null>(null);

  const beginRoomWorkspaceLayout = () => {
    if (!layoutBeforeRefineRef.current) {
      layoutBeforeRefineRef.current = { rail: railOpen, inspector: inspectorOpen };
    }
    setRailOpen(false);
    setInspectorOpen(false);
  };

  const restoreRoomWorkspaceLayout = () => {
    const prev = layoutBeforeRefineRef.current;
    if (prev) {
      setRailOpen(prev.rail);
      setInspectorOpen(prev.inspector);
      layoutBeforeRefineRef.current = null;
    }
  };

  const closeRoomWorkspace = () => {
    setRefineRoomOpen(false);
    setWallPickIndex(null);
    restoreRoomWorkspaceLayout();
  };

  useEffect(() => {
    if (!createMenuOpen) {
      setCreateMenuPos(null);
      return;
    }
    const place = () => {
      const button = createMenuButtonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;
      setCreateMenuPos({
        top: Math.round(rect.bottom + 6),
        left: Math.max(8, Math.round(rect.left)),
      });
    };
    place();
    const onPointerDown = (event: PointerEvent) => {
      const root = createMenuRef.current;
      const button = createMenuButtonRef.current;
      const target = event.target as Node;
      if (root?.contains(target) || button?.contains(target)) return;
      setCreateMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCreateMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
    };
  }, [createMenuOpen]);

  useEffect(() => {
    localStorage.setItem('groundplan:appearance', appearance);
  }, [appearance]);

  useEffect(() => {
    localStorage.setItem('groundplan:density', density);
  }, [density]);

  useEffect(() => {
    localStorage.setItem('groundplan:tooltips', String(showTooltips));
    if (!showTooltips) setToolbarTooltip(null);
  }, [showTooltips]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    localStorage.setItem('groundplan:tool-dock-open', String(toolDockOpen));
  }, [toolDockOpen]);

  useEffect(() => {
    localStorage.setItem('groundplan:recent-inventory', JSON.stringify(recentInventory));
  }, [recentInventory]);

  useEffect(() => {
    localStorage.setItem('groundplan:tool-dock-compact', String(toolDockCompact));
  }, [toolDockCompact]);

  useEffect(() => {
    localStorage.setItem('groundplan:tool-dock-side', toolDockSide);
  }, [toolDockSide]);

  useEffect(() => {
    localStorage.setItem('groundplan:tool-dock-position', JSON.stringify(toolDockPosition));
  }, [toolDockPosition]);

  useEffect(() => {
    localStorage.setItem('groundplan:tool-dock-order', JSON.stringify(toolDockOrder));
  }, [toolDockOrder]);

  useEffect(() => {
    localStorage.setItem('groundplan:tool-dock-hidden', JSON.stringify(toolDockHidden));
  }, [toolDockHidden]);

  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [doc?.path, inspectorTab, view]);

  useEffect(() => {
    localStorage.setItem('groundplan:open-layer-groups', JSON.stringify([...openLayerGroups]));
  }, [openLayerGroups]);

  const showToolbarTooltipFor = useCallback((target: EventTarget | null) => {
    if (!showTooltips) {
      setToolbarTooltip(null);
      return;
    }
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
  }, [showTooltips]);

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
        ? { path: doc.path, name: doc.name, dirty: doc.dirty || textEditDirty }
          : view === 'inventory'
            ? { name: 'Equipment inventory', dirty: false }
            : { name: 'Groundplan', dirty: false };
    document.title = active.name === 'Groundplan' ? active.name : `${active.name} — Groundplan`;
    void api.setDocumentState(active);
  }, [doc, gear, gearIndex, textEditDirty, view]);

  // A tab is a live navigation target, while the active document remains the
  // single byte-safe editing session owned by the main process. Every edit
  // refreshes its tab badge so unsaved state is never hidden by switching.
  // Inactive tabs cannot be dirty: open/new already saved or discarded the
  // previous session before adopt, so clear their badges instead of freezing them.
  useEffect(() => {
    if (!doc) return;
    setActivePlanPath(doc.path);
    setPlanTabs((current) => {
      const next: PlanTab = {
        path: doc.path,
        name: doc.name,
        dirty: doc.dirty || textEditDirty,
        editable: doc.editable,
      };
      const found = current.findIndex((tab) => tab.path === doc.path);
      const withActive =
        found === -1
          ? [...current, next]
          : current.map((tab, index) => (index === found ? next : tab));
      return withActive.map((tab) =>
        tab.path === doc.path ? tab : tab.dirty ? { ...tab, dirty: false } : tab,
      );
    });
  }, [doc, textEditDirty]);

  // The internal clipboard belongs to the main process so it can cross plan
  // sessions. Re-read its status whenever a different tab becomes active;
  // renderer reloads and tab adoption must not make a valid paste look empty.
  useEffect(() => {
    let current = true;
    void api.planClipboardStatus()
      .then((reply) => {
        if (!current) return;
        if (reply.ok && reply.count && reply.sourceName) {
          setPlanClipboard({ count: reply.count, sourceName: reply.sourceName });
        } else {
          setPlanClipboard(null);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [doc?.path]);

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
    setPlanBackground(null);
    setSaveConflict(null);
    setView('plan');
    setInspectorTab('layers');
    setSelectedIds([]);
    setSelection(null);
    setTextEditingId(null);
    setTextEditingOriginal(null);
    saveNewRoomOutlineRef.current = false;
    setAwaitingRoomOutline(false);
    setCustomRoomPrefs(null);
    setSetupCompleted({
      stage: false,
      insert: false,
      repeat: false,
      seating: false,
      print: false,
    });
    // One dispatch puts everything down. The old block cleared four armed cells
    // and the two measure/dimension pairs but never `drawTool`/`drawFrom`, so
    // opening a different plan left a draw tool in hand holding a half-consumed
    // start point against a document that no longer existed.
    dispatchTool({ type: 'reset' });
    setPrintOpen(false);
    setSeatingOpen(false);
    setCalculatorOpen(false);
    setBackgroundOpen(false);
    if (autoFitOnOpen) setFitToken((t) => t + 1);
  }, [autoFitOnOpen, dispatchTool]);

  const planIdentityFields = useMemo<PlanIdentityFields>(
    () => ({
      date: doc?.identity?.date ?? '',
      venue: doc?.identity?.venue ?? '',
      event: doc?.identity?.event ?? '',
      contact: doc?.identity?.contact ?? '',
    }),
    [doc?.identity?.date, doc?.identity?.venue, doc?.identity?.event, doc?.identity?.contact],
  );

  const loadGeneration = useRef(0);
  const load = useCallback(
    async (path: string): Promise<boolean> => {
      if (!(await commitTextEditingRef.current(false))) return false;
      const generation = ++loadGeneration.current;
      setBusy(true);
      setBusyMessage('Opening…');
      setError(null);
      try {
        const result = await api.openPath(path);
        if (generation !== loadGeneration.current) return false;
        if (result && 'scene' in result) {
          adopt(result as Doc);
          refreshRecent();
          return true;
        } else if (result && 'reason' in (result as object)) {
          setError(String((result as { reason?: string }).reason ?? 'Could not open that plan.'));
        }
      } catch (err) {
        if (generation !== loadGeneration.current) return false;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (generation === loadGeneration.current) {
          setBusy(false);
          setBusyMessage(null);
        }
      }
      return false;
    },
    [refreshRecent, adopt],
  );

  const openFile = useCallback(async () => {
    if (!(await commitTextEditingRef.current(false))) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setBusyMessage('Opening…');
    setError(null);
    try {
      const result = await api.openFileDialog();
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
  }, [refreshRecent, adopt]);

  const openNewPlanDialog = useCallback(async () => {
    if (!(await commitTextEditingRef.current(false))) return;
    setNewPlanOpen(true);
  }, []);

  const switchPlanTab = useCallback(
    async (path: string): Promise<boolean> => {
      setView('plan');
      if (doc?.path === path) return true;
      return load(path);
    },
    [doc?.path, load],
  );

  const closePlanTab = useCallback(
    async (path: string) => {
      const index = planTabs.findIndex((tab) => tab.path === path);
      if (index === -1) return;
      if (doc?.path !== path) {
        setPlanTabs((current) => current.filter((tab) => tab.path !== path));
        return;
      }

      const next = planTabs[index + 1] ?? planTabs[index - 1];
      if (next) {
        // Opening the neighbour runs the existing Save / Discard / Cancel
        // protection for an edited active tab. Only remove this tab after the
        // switch actually succeeds.
        if (await switchPlanTab(next.path)) {
          setPlanTabs((current) => current.filter((tab) => tab.path !== path));
        }
        return;
      }

      if (!(await commitTextEditingRef.current(false))) return;
      if (!(await api.closePlan())) return;
      setDoc(null);
      setActivePlanPath(null);
      setPlanTabs([]);
      setSelectedIds([]);
      setSelection(null);
      dispatchTool({ type: 'reset' });
    },
    [dispatchTool, doc?.path, planTabs, switchPlanTab],
  );

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
    const svg = toSvg(doc.scene, visible, printScale, planBackground);
    const saved = await api.exportSvg(doc.name.replace(/\.[^.]+$/, '') + '.svg', svg);
    if (saved) {
      setStatus(`Exported ${saved.split(/[\\/]/).pop()}`);
      window.setTimeout(() => setStatus(null), 2600);
    }
  }, [doc, planBackground, printScale, visible]);

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
            objectSnap?: boolean;
            paperSheet?: boolean;
            autoFitOnOpen?: boolean;
            openPropertiesOnSelect?: boolean;
            nudgeStep?: number;
            fineNudgeStep?: number;
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
        setObjectSnap(s.drawing.objectSnap !== false);
        setPaper(s.drawing.paperSheet !== false);
        setAutoFitOnOpen(s.drawing.autoFitOnOpen !== false);
        setOpenPropertiesOnSelect(s.drawing.openPropertiesOnSelect !== false);
        setNudgeStep(
          Number.isFinite(s.drawing.nudgeStep) && Number(s.drawing.nudgeStep) > 0
            ? Number(s.drawing.nudgeStep)
            : FOOT,
        );
        setFineNudgeStep(
          Number.isFinite(s.drawing.fineNudgeStep) && Number(s.drawing.fineNudgeStep) > 0
            ? Number(s.drawing.fineNudgeStep)
            : 10,
        );
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

  // Insert and ObjectPalette must see every inventory row, not the palette search filter.
  useEffect(() => {
    let live = true;
    // Drop the previous catalog immediately so Insert cannot arm a deleted id
    // or miss a just-added row while the unfiltered list is in flight.
    setCatalogInventory(null);
    api
      .inventoryList('', null, null)
      .then((state) => live && setCatalogInventory(state as InventoryState))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [inventoryVersion]);

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

  const toggleCreatePanel = useCallback(() => {
    setCreateDialogOpen((open) => {
      const next = !open;
      if (next) {
        setRefineRoomOpen(false);
        setWallPickIndex(null);
        setSeatingOpen(false);
        setCalculatorOpen(false);
        setInspectorOpen(false);
        setCreateMenuOpen(false);
        showStatus('Create · show setup, text, and quick seating', 3500);
      }
      return next;
    });
  }, [showStatus]);

  const openCreateDialog = useCallback(() => {
    setRefineRoomOpen(false);
    setWallPickIndex(null);
    setSeatingOpen(false);
    setCalculatorOpen(false);
    setInspectorOpen(false);
    setCreateMenuOpen(false);
    setCreateDialogOpen(true);
    void api.listLayoutKits().then(setLayoutKits).catch(() => undefined);
    void api.listBankPresets().then(setBankPresets).catch(() => undefined);
  }, []);

  const refreshLayoutKits = useCallback(() => {
    void api.listLayoutKits().then(setLayoutKits).catch(() => undefined);
  }, []);

  const openNewShapeDialog = useCallback(() => {
    setCreateMenuOpen(false);
    setCreateDialogOpen(false);
    setShapeWizardOpen(true);
  }, []);

  const openNewItemDialog = useCallback(async () => {
    setCreateMenuOpen(false);
    setCreateDialogOpen(false);
    try {
      const taken = new Set((inventory?.items ?? []).map((item) => item.name.trim().toLowerCase()));
      let name = 'New item';
      let suffix = 2;
      while (taken.has(name.toLowerCase())) {
        name = `New item ${suffix++}`;
      }
      const reply = await api.inventoryAdd(name);
      if (!reply.ok || !reply.id) {
        notify(reply.reason ?? 'That item could not be created');
        return;
      }
      inventoryChanged();
      setNewItemProvisional(true);
      setNewItemEditor({
        id: reply.id,
        name,
        sizeSource: 'unknown',
        timesSeen: 0,
        peakQuantity: 0,
        addedAt: new Date().toISOString(),
      });
      showStatus('New item — set the name, size, and icon', 4000);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [inventory, inventoryChanged, notify, showStatus]);

  const closeNewItemEditor = useCallback(
    async (saved: boolean) => {
      const pending = newItemEditor;
      const provisional = newItemProvisional;
      setNewItemEditor(null);
      setNewItemProvisional(false);
      if (!saved && provisional && pending?.id) {
        try {
          await api.inventoryRemove(pending.id);
          inventoryChanged();
          showStatus('New item cancelled', 2500);
        } catch {
          inventoryChanged();
        }
      }
    },
    [inventoryChanged, newItemEditor, newItemProvisional, showStatus],
  );

  const toggleEditWalls = useCallback(() => {
    if (!doc?.editable || !doc?.hasRoom) {
      notify(
        doc?.editable
          ? 'Open a plan with a room to edit walls'
          : 'Open an editable plan to edit walls',
      );
      return;
    }
    if (refineRoomOpen && roomWorkspaceFocus === 'walls') {
      closeRoomWorkspace();
      showStatus('Room layout workspace closed');
      return;
    }
    beginRoomWorkspaceLayout();
    setRoomWorkspaceFocus('walls');
    setRefineRoomOpen(true);
    setSeatingOpen(false);
    setCalculatorOpen(false);
    setSelectedIds([]);
    // Create lives in the top toolbar now — leave the side inspector closed.
    setInspectorOpen(false);
    const { refusal } = dispatchTool({ type: 'pick', choice: SELECT });
    if (refusal) notify(refusal);
    showStatus('Edit walls · click a wall, then Push / Curve / Length on the plan', 4500);
    setFitToken((t) => t + 1);
  }, [
    doc?.editable,
    doc?.hasRoom,
    refineRoomOpen,
    roomWorkspaceFocus,
    notify,
    showStatus,
    dispatchTool,
  ]);

  const savePlanIdentity = useCallback(
    async (next: PlanIdentityFields) => {
      if (!doc?.editable) return;
      setIdentityBusy(true);
      try {
        const reply = await api.identitySet(next);
        if (reply.ok && reply.doc) {
          setDoc(reply.doc as Doc);
          showStatus(reply.text ?? 'Show details saved');
        } else if (reply.reason) {
          notify(reply.reason);
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        setIdentityBusy(false);
      }
    },
    [doc?.editable, notify, showStatus],
  );

  const commitPlanBackground = useCallback(
    async (background: PlanBackground | null, message?: string) => {
      setPlanBackground(background);
      try {
        const reply = await api.backgroundSet(background);
        if (!reply.ok) {
          notify(reply.reason ?? 'The background image could not be saved.');
          return;
        }
        if (message) showStatus(message);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error));
      }
    },
    [notify, showStatus],
  );

  // Custom New Plan: arm the outline tool without opening Create/inspector —
  // the canvas banner is the guide until the room exists.
  useEffect(() => {
    if (!startNewRoomOutline || !doc?.editable) return;
    setStartNewRoomOutline(false);
    setCreateDialogOpen(false);
    setInspectorOpen(false);
    setSelectedIds([]);
    saveNewRoomOutlineRef.current = true;
    setAwaitingRoomOutline(true);
    const { refusal } = dispatchTool({ type: 'pick', choice: roomOutlineChoice });
    if (refusal) {
      notify(refusal);
      return;
    }
    const lock = customRoomPrefs?.angleLock ?? 'free';
    const lockHint =
      lock === 'ortho' ? ' · orthogonal walls' : lock === '45' ? ' · 45° snap' : ' · Shift for 90°';
    showStatus(
      `Click each room corner in order, then Enter to finish${lockHint}`,
      6200,
    );
  }, [
    customRoomPrefs?.angleLock,
    dispatchTool,
    doc?.editable,
    doc?.path,
    notify,
    showStatus,
    startNewRoomOutline,
  ]);

  useEffect(() => {
    if (doc?.hasRoom) setAwaitingRoomOutline(false);
  }, [doc?.hasRoom]);

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
        if (customRoomPrefs?.autoDimensions) {
          try {
            const dimmed = await api.roomDimension();
            if (dimmed.ok && dimmed.doc) {
              result.doc = dimmed.doc;
              result.status = `${result.status ?? 'Created custom room'} · walls dimensioned`;
            }
          } catch {
            /* dimension is a convenience — the room itself already exists */
          }
        }
        setCustomRoomPrefs(null);
        setAwaitingRoomOutline(false);
        openCreateDialog();
      }
      if (result.ok && result.doc) {
        setDoc(result.doc as Doc);
        setError(null);
        if (result.created?.length) {
          setSelectedIds(result.created);
          setSelection(null);
        }
        if (result.status) {
          const keepPlacing =
            effect.do === 'placeInventory' ||
            effect.do === 'placeGear' ||
            effect.do === 'placeLabel' ||
            effect.do === 'placeSeating';
          if (effect.do === 'placeInventory' || effect.do === 'placeGear') {
            setSetupCompleted((current) => ({ ...current, insert: true }));
          }
          if (effect.do === 'placeSeating') {
            setSetupCompleted((current) => ({ ...current, seating: true }));
          }
          showStatus(
            keepPlacing ? `${result.status} · click again or Done placing` : result.status,
          );
        }
      } else if (result.reason) {
        notify(result.reason);
      }
      dispatchTool({ type: 'settled', epoch: effect.epoch, ok: result.ok });
    },
    [dispatchTool, notify, openCreateDialog, persistNewRoomOutlineIfNeeded, showStatus, customRoomPrefs],
  );

  const finishRoomOutline = useCallback(() => {
    const { effect, refusal } = dispatchTool({ type: 'finish' });
    void applyToolEffect(effect, refusal);
  }, [applyToolEffect, dispatchTool]);

  const openRoomPanel = useCallback(() => {
    setCreateDialogOpen(false);
    setSeatingOpen(false);
    setRefineRoomOpen(false);
    setInspectorOpen(true);
    setInspectorTab('room');
  }, []);

  const finishPendingRoomAsRectangle = useCallback(async () => {
    if (!doc?.editable) return;
    const prefs = customRoomPrefs;
    const width = prefs?.guideWidth ?? 60 * 120;
    const depth = prefs?.guideDepth ?? 40 * 120;
    if (toolRef.current.tool.kind === 'path') {
      dispatchTool({ type: 'pick', choice: SELECT });
    }
    try {
      const reply = await api.roomCreate(width, depth);
      if (!reply.ok) {
        notify(reply.reason ?? 'Could not finish as a rectangle');
        return;
      }
      if (reply.doc) setDoc(reply.doc as Doc);
      saveNewRoomOutlineRef.current = false;
      setAwaitingRoomOutline(false);
      setCustomRoomPrefs(null);
      if (prefs?.autoDimensions) {
        try {
          const dimmed = await api.roomDimension();
          if (dimmed.ok && dimmed.doc) setDoc(dimmed.doc as Doc);
        } catch {
          /* optional */
        }
      }
      openCreateDialog();
      showStatus('Room ready — finished as a rectangle · next: build stage', 5200);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }, [customRoomPrefs, dispatchTool, doc?.editable, notify, openCreateDialog, showStatus, toolRef]);

  const discardEmptyPlan = useCallback(async () => {
    const reply = await api.discardEmptyPlan();
    if (reply.cancelled) return;
    if (!reply.ok) {
      notify(reply.reason ?? 'Could not discard the empty plan');
      return;
    }
    saveNewRoomOutlineRef.current = false;
    setAwaitingRoomOutline(false);
    setCustomRoomPrefs(null);
    setDoc(null);
    setActivePlanPath(null);
    setPlanTabs([]);
    setCreateDialogOpen(false);
    showStatus('Empty plan discarded', 3200);
    refreshRecent();
  }, [notify, refreshRecent, showStatus]);

  const cancelPlacement = useCallback(() => {
    const wasPath = toolRef.current.tool.kind === 'path';
    const abandonedNewOutline = saveNewRoomOutlineRef.current && wasPath;
    // Keep saveNewRoomOutlineRef + customRoomPrefs so finishing the outline
    // later still auto-saves / dimensions the New Plan file.
    setArmedInventoryId(null);
    dispatchTool({ type: 'pick', choice: SELECT });
    if (abandonedNewOutline) {
      setAwaitingRoomOutline(true);
      openCreateDialog();
      showStatus(
        'Outline cancelled — draw corners, finish as rectangle, or discard this empty plan',
        6400,
      );
    }
  }, [dispatchTool, openCreateDialog, showStatus, toolRef]);

  /** Leave stamp mode and open Properties so rotate / repeat are one click away. */
  const finishPlacement = useCallback(() => {
    const hadSelection = selectedIds.length > 0;
    setArmedInventoryId(null);
    dispatchTool({ type: 'pick', choice: SELECT });
    if (hadSelection) {
      setInspectorOpen(true);
      setInspectorTab('properties');
      showStatus('Ready to edit, rotate, or Repeat');
    }
  }, [dispatchTool, selectedIds.length, showStatus]);

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
      if (refusal) {
        notify(refusal);
        return;
      }
      setView('plan');
      showStatus(`Click the plan to place ${description} · stays armed until Done placing`);
    },
    [dispatchTool, notify, showStatus],
  );

  const rememberRecentInventory = useCallback((id: string, name: string) => {
    setRecentInventory((prev) => [{ id, name }, ...prev.filter((row) => row.id !== id)].slice(0, 8));
  }, []);

  const armInventory = useCallback(
    (id: string, name: string) => {
      setArmedInventoryId(id);
      rememberRecentInventory(id, name);
      const { refusal } = dispatchTool({
        type: 'pick',
        choice: { kind: 'stamp', stamp: { what: 'inventory', id, name } },
      });
      if (refusal) {
        notify(refusal);
        return;
      }
      setView('plan');
      showStatus(`Click the plan to place ${name} · stays armed until Done placing`);
    },
    [dispatchTool, notify, rememberRecentInventory, showStatus],
  );

  const inventoryRows = useMemo(
    () =>
      (catalogInventory?.items ?? inventory?.items ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category ?? null,
      })),
    [catalogInventory?.items, inventory?.items],
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
      if (match) {
        armInventory(match.id, match.name);
        return;
      }
      const stock = leaf.stockName ?? leaf.keywords.find((k) => /\d/.test(k)) ?? leaf.keywords[0];
      if (!stock) {
        notify(`Nothing in inventory matches “${leaf.label}”`);
        return;
      }
      armGear(stock);
    },
    [armGear, armInventory, inventoryRows, notify],
  );

  const armLabelText = useCallback(
    (text: string) => {
      const color = hexToColorRef(annotationColor) ?? undefined;
      const { refusal } = dispatchTool({ type: 'pick', choice: labelChoice(text, color) });
      if (refusal) notify(refusal);
    },
    [annotationColor, dispatchTool, notify],
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

  /**
   * One shared command for the top ribbon, side dock, and T shortcut.
   * A useful starter value makes Text a real one-click tool; the focused
   * inspector field can immediately replace it while the stamp stays armed.
   */
  const activateTextTool = useCallback(() => {
    if (!doc?.editable) return;
    const text = annotationDraft.trim() || 'Text';
    const choice = labelChoice(text, hexToColorRef(annotationColor) ?? undefined);
    const wasActive = isPressed(toolRef.current, choice);
    const { refusal } = dispatchTool({ type: 'toggle', choice });
    if (refusal) {
      notify(refusal);
      return;
    }
    if (wasActive) {
      showStatus('Text tool off');
      return;
    }
    if (!annotationDraft.trim()) setAnnotationDraft(text);
    openCreateDialog();
    showStatus('Text tool armed — edit the label, then click the plan to place it');
    window.setTimeout(() => {
      const input = annotationInputRef.current;
      input?.focus();
      if (!annotationDraft.trim()) input?.select();
    }, 0);
  }, [
    annotationColor,
    annotationDraft,
    dispatchTool,
    doc?.editable,
    notify,
    openCreateDialog,
    showStatus,
    toolRef,
  ]);

  const editAnnotationDraft = useCallback(
    (next: string) => {
      setAnnotationDraft(next);
      const { refusal } = dispatchTool({ type: 'retext', text: next });
      if (refusal) notify(refusal);
    },
    [dispatchTool, notify],
  );

  const editAnnotationColor = useCallback(
    (next: string) => {
      if (!/^#[0-9a-f]{6}$/i.test(next)) return;
      setAnnotationColor(next);
      const text = annotationDraft.trim();
      if (!text || !isPressed(toolRef.current, labelChoice(text))) return;
      const { refusal } = dispatchTool({
        type: 'pick',
        choice: labelChoice(text, hexToColorRef(next) ?? undefined),
      });
      if (refusal) notify(refusal);
    },
    [annotationDraft, dispatchTool, notify, toolRef],
  );

  const finishTextTool = useCallback(() => {
    dispatchTool({ type: 'pick', choice: SELECT });
    showStatus('Text placement finished');
  }, [dispatchTool, showStatus]);

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

  const startTextEditing = useCallback((nodeId: number) => {
    const primitive = doc?.scene.primitives.find(
      (candidate) => candidate.type === 'text' && candidate.nodeId === nodeId,
    );
    if (!primitive || !doc?.editable) return;
    setSelectionScope(null);
    setSelectedIds([nodeId]);
    setLabelDraft(primitive.text ?? '');
    setTextEditingOriginal(primitive.text ?? '');
    if (primitive.textStyle) {
      setTextStyleDraft(primitive.textStyle);
      setTextSizeDraft(String(Math.round(primitive.textStyle.size * 10) / 10));
      setTextRotationDraft(String(Math.round(primitive.textStyle.angleDegrees * 10) / 10));
    }
    setTextEditingId(nodeId);
    setInspectorOpen(true);
    setInspectorTab('properties');
    dispatchTool({ type: 'pick', choice: SELECT });
  }, [dispatchTool, doc]);

  const commitTextEditing = useCallback(async (close = true): Promise<boolean> => {
    const nodeId = textEditingId;
    if (nodeId == null) return true;
    const original =
      selection?.nodeId === nodeId
        ? selection.text ?? ''
        : doc?.scene.primitives.find(
            (candidate) => candidate.type === 'text' && candidate.nodeId === nodeId,
          )?.text ?? '';
    if (labelDraft !== original) {
      const reply = await api.relabel(nodeId, labelDraft);
      applied(reply as { ok: boolean; reason?: string; doc?: Doc });
      if (!reply.ok) return false;
    }
    if (close) {
      setTextEditingId(null);
      setTextEditingOriginal(null);
    }
    if (close) showStatus('Text updated');
    return true;
  }, [applied, doc?.scene.primitives, labelDraft, selection, showStatus, textEditingId]);
  commitTextEditingRef.current = commitTextEditing;

  useEffect(() => {
    if (!textEditDirty) return;
    const timer = window.setTimeout(() => {
      void commitTextEditingRef.current(false);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [labelDraft, textEditDirty]);

  const cancelTextEditing = useCallback(async () => {
    const nodeId = textEditingId;
    const original = textEditingOriginal;
    setTextEditingId(null);
    setTextEditingOriginal(null);
    if (nodeId != null && original != null) {
      setLabelDraft(original);
      const saved = doc?.scene.primitives.find(
        (candidate) => candidate.type === 'text' && candidate.nodeId === nodeId,
      )?.text ?? '';
      if (saved !== original) {
        const reply = await api.relabel(nodeId, original);
        applied(reply as { ok: boolean; reason?: string; doc?: Doc });
        if (!reply.ok) return;
      }
    }
    showStatus('Text edit cancelled');
  }, [applied, doc?.scene.primitives, showStatus, textEditingId, textEditingOriginal]);

  const applyTextStyle = useCallback(async (patch: Partial<typeof textStyleDraft>) => {
    const nodeId = textEditingId ?? (selection?.cls === 'RVLabel' ? selection.nodeId : null);
    if (nodeId == null || !doc?.editable) return;
    const reply = await api.setTextStyle(nodeId, patch);
    applied(reply as { ok: boolean; reason?: string; doc?: Doc });
    if (reply.ok) setTextStyleDraft((current) => ({ ...current, ...patch }));
  }, [applied, doc?.editable, selection, textEditingId]);

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
        svg: toSvg(doc.scene, visible, printScale, planBackground),
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
        setSetupCompleted((current) => ({ ...current, print: true }));
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
  }, [doc, printBusy, visible, printScale, printPaper, printLandscape, printSubtitle, gear, gearIndex, notify, showStatus, planBackground]);

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
        const name =
          inventoryRows.find((row) => row.id === id)?.name ??
          recentInventory.find((row) => row.id === id)?.name ??
          'item';
        rememberRecentInventory(id, name);
        setDoc(reply.doc as Doc);
        if (reply.created?.length) {
          setSelectedIds(reply.created);
          setSelection(null);
        }
        setInspectorOpen(true);
        setInspectorTab('properties');
        setSetupCompleted((current) => ({ ...current, insert: true }));
        // Keep the same SKU armed so drag and click share one keep-placing flow.
        setArmedInventoryId(id);
        dispatchTool({
          type: 'pick',
          choice: { kind: 'stamp', stamp: { what: 'inventory', id, name } },
        });
        showStatus(`${placeMethodStatus(reply.method)} · still armed — click or drag again`);
      } else {
        notify(reply.reason ?? 'Could not place that item');
      }
    },
    [dispatchTool, doc, inventoryRows, notify, recentInventory, rememberRecentInventory, showStatus],
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
        setDoc(reply.doc as Doc);
        if (reply.created?.length) {
          setSelectedIds(reply.created);
          setSelection(null);
        }
        setInspectorOpen(true);
        setInspectorTab('properties');
        setSetupCompleted((current) => ({ ...current, insert: true }));
        dispatchTool({
          type: 'pick',
          choice: { kind: 'stamp', stamp: { what: 'gear', description } },
        });
        showStatus(`${placeMethodStatus(reply.method, description)} · still armed — click or drag again`);
      } else {
        notify(reply.reason ?? `Could not place ${description}`);
      }
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

  const copyPlanSelection = useCallback(async () => {
    if (!selectedIds.length) return;
    const reply = await api.copyPlanObjects(selectedIds);
    if (!reply.ok) {
      if (reply.reason) notify(reply.reason);
      return;
    }
    const count = reply.count ?? selectedIds.length;
    const sourceName = reply.sourceName ?? doc?.name ?? 'plan';
    setPlanClipboard({ count, sourceName });
    showStatus(`Copied ${count} item${count === 1 ? '' : 's'} from ${sourceName}`);
  }, [doc?.name, notify, selectedIds, showStatus]);

  const pastePlanSelection = useCallback(async () => {
    if (!doc?.editable) return;
    const reply = await api.pastePlanObjects();
    applied(reply as { ok: boolean; reason?: string; doc?: Doc; created?: number[] });
    if (reply.ok) {
      if (!planClipboard && reply.text) {
        // Status may still be catching up after a tab switch — refresh badge.
        void api.planClipboardStatus().then((status) => {
          if (status.ok && status.count && status.sourceName) {
            setPlanClipboard({ count: status.count, sourceName: status.sourceName });
          }
        });
      }
      showStatus(`Pasted ${reply.text ?? 'copied items'}`);
    }
  }, [applied, doc?.editable, planClipboard, showStatus]);

  const groupPlanSelection = useCallback(async () => {
    if (!doc?.editable || selectedIds.length < 2) return;
    const reply = await api.groupPlanObjects(selectedIds);
    if (!reply.ok) {
      if (reply.reason) notify(reply.reason);
      return;
    }
    showStatus(reply.text ?? 'Grouped');
  }, [doc?.editable, notify, selectedIds, showStatus]);

  const ungroupPlanSelection = useCallback(async () => {
    if (!doc?.editable || !selectedIds.length) return;
    const reply = await api.ungroupPlanObjects(selectedIds);
    if (!reply.ok) {
      if (reply.reason) notify(reply.reason);
      return;
    }
    showStatus(reply.text ?? 'Ungrouped');
  }, [doc?.editable, notify, selectedIds, showStatus]);

  /** Places N copies of the selection in a row — one undo step. */
  const arraySelectionAcross = useCallback(async () => {
    if (selectedIds.length !== 1 || !selection) {
      notify('Select one item to repeat across');
      return;
    }
    if (selection.nodeId !== selectedIds[0]) return;
    const count = Math.floor(Number(arrayCountDraft));
    if (!(count >= 2 && count <= 40)) {
      notify('Enter a repeat count between 2 and 40');
      return;
    }
    const spacing =
      arrayDirection === 'right' || arrayDirection === 'left'
        ? selection.widthUnits
        : selection.heightUnits;
    if (!(spacing > 0)) {
      notify('That item has no size to space copies by');
      return;
    }
    const reply = (await api.repeatAcross(selection.nodeId, count, arrayDirection)) as {
      ok: boolean;
      reason?: string;
      doc?: Doc;
      created?: number[];
    };
    applied(reply);
    if (reply.ok) {
      setInspectorOpen(true);
      setInspectorTab('properties');
      setSetupCompleted((current) => ({ ...current, repeat: true }));
      const n = reply.created?.length ?? count;
      showStatus(`Repeated ${arrayDirection} ×${count} · ${n} selected`);
    }
  }, [selectedIds, selection, arrayCountDraft, arrayDirection, applied, notify, showStatus]);

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
      if (!(await commitTextEditing(false))) return;
      const reply = await api.save(saveAs);
      if (reply.cancelled) return;
      if (reply.ok && reply.doc) {
        const nextDoc = reply.doc as Doc;
        if (saveAs && nextDoc.path !== doc.path) {
          setPlanTabs((current) => current.filter((tab) => tab.path !== doc.path));
        }
        setDoc(nextDoc);
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
    [commitTextEditing, doc, notify, showStatus],
  );

  useEffect(() => {
    if (selectedId == null) {
      setSelection(null);
      return;
    }
    // Clear immediately so size/label commits cannot hit the previous node
    // while selectionInfo is still in flight.
    setSelection(null);
    let live = true;
    const wanted = selectedId;
    api
      .selectionInfo(selectedId)
      .then((info) => {
        if (!live || wanted !== selectedId) return;
        setSelection(info as Selection | null);
        // Typography changes refresh the document while the inline editor may
        // still hold uncommitted wording. Never replace that live draft with
        // the last saved text just because Bold/Size/Color was clicked.
        if (textEditingId !== wanted) setLabelDraft(info?.text ?? info?.name ?? '');
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
        if (info?.textStyle) {
          setTextStyleDraft(info.textStyle);
          setTextSizeDraft(String(Math.round(info.textStyle.size * 10) / 10));
          setTextRotationDraft(String(Math.round(info.textStyle.angleDegrees * 10) / 10));
        }
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
  }, [selectedId, doc, unitSystem, textEditingId]);

  useEffect(() => {
    // Clicking an object asks to see its properties. A placement selecting
    // what it just created does not: the panel being placed from is the one
    // in use, and pulling it away mid-run took the label field out from under
    // whatever was being typed into it.
    if (openPropertiesOnSelect && opensProperties(selectedIds.length, tool)) {
      setInspectorTab('properties');
    }
  }, [openPropertiesOnSelect, selectedIds, tool]);

  useEffect(() => {
    if (
      textEditingId != null &&
      (selectedIds.length !== 1 || selectedIds[0] !== textEditingId)
    ) {
      setTextEditingId(null);
      setTextEditingOriginal(null);
    }
  }, [selectedIds, textEditingId]);

  const commitSelectionSize = useCallback(async () => {
    if (!selection || selectedId == null || selection.nodeId !== selectedId || !doc?.editable) return;
    const width = parseLength(sizeDraft.width, unitSystem);
    const height = parseLength(sizeDraft.height, unitSystem);
    if (width == null || height == null || width <= 0 || height <= 0) {
      notify(unitSystem === 'metric' ? 'Enter a positive width and height (for example 1.2m).' : 'Enter a positive width and height (for example 4\' or 4\' 6").');
      return;
    }
    if (Math.abs(width - selection.widthUnits) < 1 && Math.abs(height - selection.heightUnits) < 1) return;
    applied((await api.resize(selection.nodeId, width, height)) as { ok: boolean; reason?: string; doc?: Doc });
  }, [selection, selectedId, doc?.editable, sizeDraft, unitSystem, notify, applied]);

  const commitSelectionPosition = useCallback(async () => {
    if (!selection || selectedId == null || selection.nodeId !== selectedId || !doc?.editable) return;
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
  }, [selection, selectedId, doc?.editable, positionDraft, unitSystem, notify, applied]);

  const moveSelectionPoint = useCallback(
    async (pathNodeId: number, pointIndex: number, x: number, y: number): Promise<boolean> => {
      if (!doc?.editable || selectedId == null) return false;
      const reply = (await api.movePoint(selectedId, pathNodeId, pointIndex, x, y)) as {
        ok: boolean;
        reason?: string;
        doc?: Doc;
      };
      if (!reply.ok) {
        if (reply.reason) notify(reply.reason);
        return false;
      }
      applied(reply);
      showStatus(`Moved point ${pointIndex + 1}`);
      return true;
    },
    [doc?.editable, selectedId, applied, notify, showStatus],
  );

  const setSelectionPathKind = useCallback(
    async (pathNodeId: number, kind: 'line' | 'curve'): Promise<boolean> => {
      if (!doc?.editable || selectedId == null) return false;
      const reply = (await api.setPointPathKind(selectedId, pathNodeId, kind)) as {
        ok: boolean;
        reason?: string;
        doc?: Doc;
      };
      if (!reply.ok) {
        if (reply.reason) notify(reply.reason);
        return false;
      }
      applied(reply);
      showStatus(kind === 'curve' ? 'Converted segment to a curve — drag either round handle' : 'Straightened segment');
      return true;
    },
    [doc?.editable, selectedId, applied, notify, showStatus],
  );

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
      else if (command === 'menu:new') void openNewPlanDialog();
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
      else if (command === 'menu:edit-walls' && view === 'plan') toggleEditWalls();
      else if (command === 'menu:group' && view === 'plan') void groupPlanSelection();
      else if (command === 'menu:ungroup' && view === 'plan') void ungroupPlanSelection();
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
    openNewPlanDialog,
    toggleEditWalls,
    groupPlanSelection,
    ungroupPlanSelection,
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
        if (createDialogOpen) {
          e.preventDefault();
          setCreateDialogOpen(false);
          return;
        }
        if (newItemEditor) {
          e.preventDefault();
          void closeNewItemEditor(false);
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
        if (seatingOpen) {
          e.preventDefault();
          setSeatingOpen(false);
          return;
        }
        if (refineRoomOpen) {
          e.preventDefault();
          closeRoomWorkspace();
          return;
        }
        if (calculatorOpen) {
          e.preventDefault();
          setCalculatorOpen(false);
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
      if (e.key.toLowerCase() === 'a' && !mod && doc) {
        e.preventDefault();
        dispatchTool({ type: 'pick', choice: DIRECT_SELECT });
        setInspectorOpen(true);
        setInspectorTab('properties');
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
        activateTextTool();
        return;
      }
      if (e.key.toLowerCase() === 'w' && !mod && doc) {
        e.preventDefault();
        toggleEditWalls();
        return;
      }
      if (e.key === 'Escape') {
        if (printOpen) {
          setPrintOpen(false);
          return;
        }
        if (toolRef.current.tool.kind === 'stamp') {
          e.preventDefault();
          cancelPlacement();
          return;
        }
        dispatchTool({ type: 'escape' });
        setArmedInventoryId(null);
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

      const wallStep = e.shiftKey ? 1 : UNITS_PER_INCH;
      const step = e.shiftKey ? fineNudgeStep : nudgeStep;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = delta[e.key];
      if (
        d &&
        doc?.editable &&
        (refineRoomOpen) &&
        wallEdit?.editable &&
        wallEdit.walls.length &&
        !selectedIds.length
      ) {
        e.preventDefault();
        const wall =
          wallEdit.walls.find((entry) => entry.index === wallEdit.selected) ?? wallEdit.walls[0]!;
        const dx = wall.endX - wall.startX;
        const dy = wall.endY - wall.startY;
        const chord = Math.hypot(dx, dy) || 1;
        const nx = dy / chord;
        const ny = -dx / chord;
        const tx = dx / chord;
        const ty = dy / chord;
        const wallDelta: Record<string, [number, number]> = {
          ArrowLeft: [-wallStep, 0],
          ArrowRight: [wallStep, 0],
          ArrowUp: [0, -wallStep],
          ArrowDown: [0, wallStep],
        };
        const wd = wallDelta[e.key]!;
        void (async () => {
          let reply;
          if (wallEditGesture === 'length' && !wall.curved) {
            const along = wd[0] * tx + wd[1] * ty;
            if (Math.abs(along) < wallStep * 0.2) {
              showStatus('Point along the wall to change length', 2000);
              return;
            }
            reply = await api.roomWallLength(
              wall.index,
              Math.max(UNITS_PER_INCH, wall.length + Math.sign(along) * wallStep),
            );
          } else if (wallEditGesture === 'push' && !wall.curved) {
            const along = wd[0] * nx + wd[1] * ny;
            if (Math.abs(along) < wallStep * 0.2) {
              showStatus('Point outward or inward to push the wall', 2000);
              return;
            }
            reply = await api.roomWallOffset(wall.index, Math.sign(along) * wallStep);
          } else if (wallEditGesture === 'curve') {
            const along = wd[0] * nx + wd[1] * ny;
            if (Math.abs(along) < wallStep * 0.2) {
              showStatus('Point outward or inward to curve the wall', 2000);
              return;
            }
            const bulge = wall.bulge ?? 0;
            const existing = bulge ? (bulge * chord) / 2 : 0;
            const next = existing + Math.sign(along) * wallStep;
            if (Math.abs(next) < 1) {
              reply = await api.roomCurve(wall.index, 0);
            } else {
              reply = await api.roomCurveThrough(wall.index, {
                x: (wall.startX + wall.endX) / 2 + nx * next,
                y: (wall.startY + wall.endY) / 2 + ny * next,
              });
            }
          } else {
            showStatus(
              wall.curved
                ? 'Straighten the wall before pushing or stretching'
                : 'Select Push, Curve, or Length',
              2500,
            );
            return;
          }
          if (!reply.ok) {
            notify(reply.reason ?? 'That wall could not be changed');
            return;
          }
          if (reply.doc) setDoc(reply.doc as Doc);
          showStatus(
            `Wall ${wall.index + 1} · ${formatLength(wallStep, unitSystem)} ${wallEditGesture}`,
            2000,
          );
        })();
        return;
      }
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
    createDialogOpen,
    newItemEditor,
    closeNewItemEditor,
    settingsOpen,
    shortcutsOpen,
    insertOpen,
    shapeWizardOpen,
    buildStageOpen,
    seatingOpen,
    calculatorOpen,
    refineRoomOpen,
    cancelPlacement,
    toggleMeasure,
    toggleDimension,
    activateTextTool,
    toggleEditWalls,
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
    nudgeStep,
    fineNudgeStep,
    refineRoomOpen,
    wallEdit,
    wallEditGesture,
    showStatus,
    unitSystem,
  ]);

  useEffect(() => {
    const isTextTarget = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      return !!element &&
        (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);
    };
    const onCopy = (event: ClipboardEvent) => {
      if (view !== 'plan' || !selectedIds.length || isTextTarget(event.target)) return;
      event.preventDefault();
      void copyPlanSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (view !== 'plan' || !doc?.editable || isTextTarget(event.target)) return;
      // Do not gate on renderer planClipboard — after a tab switch the main
      // clipboard is already valid while status IPC may still be in flight.
      event.preventDefault();
      void pastePlanSelection();
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [copyPlanSelection, doc?.editable, pastePlanSelection, selectedIds.length, view]);

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
      (planFolders?.folders ?? [])
        .filter((candidate) => candidate.parentId === (selectedPlanFolder?.id ?? null))
        .sort(
          (a, b) =>
            Number(!!b.favorite) - Number(!!a.favorite) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }),
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

  const selectLayerSet = useCallback(
    (layerIds: Layer[], scope: SelectionScope, label: string) => {
      if (!doc) return;
      const ids = [
        ...new Set(
          doc.scene.primitives
            .filter((primitive) => layerIds.includes(primitive.layer))
            .map((primitive) => primitive.selectId),
        ),
      ];
      if (!ids.length) {
        notify(`There are no objects in ${label.toLowerCase()} to select.`);
        return;
      }
      setVisible((current) => {
        const next = new Set(current);
        for (const layerId of layerIds) next.add(layerId);
        return next;
      });
      dispatchTool({ type: 'pick', choice: SELECT });
      setSelectionScope(scope);
      setSelectedIds(ids);
      setSelection(null);
      setInspectorOpen(true);
      setInspectorTab('properties');
      showStatus(`Selected ${ids.length.toLocaleString()} object${ids.length === 1 ? '' : 's'} in ${label}`);
    },
    [dispatchTool, doc, notify, showStatus],
  );

  const selectLayer = useCallback(
    (id: Layer) => {
      const layer = LAYERS.find((candidate) => candidate.id === id);
      selectLayerSet([id], { kind: 'layer', id }, layer?.label ?? id);
    },
    [selectLayerSet],
  );

  const selectLayerGroup = useCallback(
    (id: LayerGroupId) => {
      const group = LAYER_GROUPS.find((candidate) => candidate.id === id);
      selectLayerSet(
        LAYERS.filter((layer) => layer.group === id).map((layer) => layer.id),
        { kind: 'group', id },
        group?.label ?? id,
      );
    },
    [selectLayerSet],
  );

  const selectLayerItem = useCallback(
    (layer: Layer, item: LayerListItem) => {
      setVisible((current) => new Set(current).add(layer));
      dispatchTool({ type: 'pick', choice: SELECT });
      setSelectionScope(null);
      setSelection(null);
      setSelectedIds([item.selectId]);
      showStatus(`Selected ${item.label}`);
    },
    [dispatchTool, showStatus],
  );

  const selectionScopeMeta = useMemo(() => {
    if (!selectionScope) return null;
    const layers = selectionScope.kind === 'layer'
      ? LAYERS.filter((layer) => layer.id === selectionScope.id)
      : LAYERS.filter((layer) => layer.group === selectionScope.id);
    const group = selectionScope.kind === 'group'
      ? LAYER_GROUPS.find((candidate) => candidate.id === selectionScope.id)
      : null;
    const layer = selectionScope.kind === 'layer' ? layers[0] : null;
    return {
      label: layer?.label ?? group?.label ?? 'Layer selection',
      description: layer?.description ?? group?.description ?? 'Selected drawing scope',
      tint: layer?.tint ?? '#4d94ff',
      layers,
      allVisible: layers.every((candidate) => visible.has(candidate.id)),
      someVisible: layers.some((candidate) => visible.has(candidate.id)),
    };
  }, [selectionScope, visible]);

  useEffect(() => {
    if (!selectionScope || !doc) return;
    const layerIds = new Set(
      selectionScope.kind === 'layer'
        ? [selectionScope.id]
        : LAYERS.filter((layer) => layer.group === selectionScope.id).map((layer) => layer.id),
    );
    const expected = new Set(
      doc.scene.primitives
        .filter((primitive) => layerIds.has(primitive.layer))
        .map((primitive) => primitive.selectId),
    );
    if (expected.size !== selectedIds.length || selectedIds.some((id) => !expected.has(id))) {
      setSelectionScope(null);
    }
  }, [doc, selectedIds, selectionScope]);

  const setSelectedScopeVisible = useCallback(
    (show: boolean) => {
      if (!selectionScopeMeta) return;
      setVisible((current) => {
        const next = new Set(current);
        for (const layer of selectionScopeMeta.layers) {
          if (show) next.add(layer.id);
          else next.delete(layer.id);
        }
        return next;
      });
    },
    [selectionScopeMeta],
  );

  const showOnlySelectedScope = useCallback(() => {
    if (!selectionScopeMeta) return;
    setVisible(new Set(selectionScopeMeta.layers.map((layer) => layer.id)));
    showStatus(`Showing only ${selectionScopeMeta.label}`);
  }, [selectionScopeMeta, showStatus]);

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

  const applyShowKit = useCallback(
    async (kitId: string) => {
      if (!doc?.editable) {
        notify('Open an editable plan to apply a kit');
        return;
      }
      const chairs = furnitureCounts.chairs;
      let replaceExistingSeating = false;
      if (chairs > 0) {
        const ok = await api.confirm({
          title: 'Apply show kit?',
          message: `This plan already has ${chairs.toLocaleString()} chairs.`,
          detail:
            'Applying a kit adds the recipe layout. Prefer a blank or lightly filled plan. Continue only if you intend to stack or rebuild on top.',
          confirmLabel: 'Apply kit',
          danger: true,
        });
        if (ok !== true) return;
        replaceExistingSeating = true;
      }
      setKitsBusy(true);
      try {
        const reply = await api.applyLayoutRecipe(kitId, { replaceExistingSeating });
        if (reply.ok && reply.doc) {
          setDoc(reply.doc as Doc);
          setSetupCompleted((current) => ({
            ...current,
            stage: true,
            seating: true,
            insert: true,
          }));
          showStatus(reply.text ?? 'Show kit applied', 5000);
          setFitToken((t) => t + 1);
        } else {
          notify(reply.reason ?? 'Could not apply show kit');
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        setKitsBusy(false);
      }
    },
    [doc, furnitureCounts.chairs, notify, showStatus],
  );

  const [seatingClearances, setSeatingClearances] = useState<{
    front: number;
    side: number;
    wing: number;
    rear: number;
    centreAisle: number;
  } | null>(null);
  useEffect(() => {
    if (!doc) {
      setSeatingClearances(null);
      setPlanBackground(null);
      return;
    }
    if (view !== 'plan') {
      setSeatingClearances(null);
      return;
    }
    let cancelled = false;
    void api.planModel().then((model) => {
      if (cancelled) return;
      const c = model?.seatingStatus?.clearances;
      setPlanBackground(model?.background ?? null);
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
  const welcomeMode = view === 'plan' && !doc;

  return (
    <div
      className="app"
      data-platform={api.platform}
      data-theme={darkMode ? 'dark' : 'light'}
      data-density={density}
      aria-busy={busy}
    >
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
            setCustomRoomPrefs(options.customRoom ?? null);
            setStartNewRoomOutline(options.startRoomOutline);
            setAwaitingRoomOutline(options.startRoomOutline);
            if (options.startRoomOutline) {
              // Keep the canvas clear for tracing — open Show setup once the room exists.
              setCreateDialogOpen(false);
              setInspectorOpen(false);
              showStatus(
                'Click corners to finish the room · Enter closes · Esc cancels · Finish as rectangle on the banner',
                6400,
              );
            } else {
              openCreateDialog();
              showStatus('Room ready — next: build stage', 5200);
            }
            setFitToken((t) => t + 1);
            refreshRecent();
          }}
        />
      )}

      {openPlanChooserOpen && (
        <OpenPlanChooser
          recent={recent}
          currentPath={doc?.path}
          busy={busy}
          onClose={() => setOpenPlanChooserOpen(false)}
          onNewPlan={() => {
            setOpenPlanChooserOpen(false);
            void openNewPlanDialog();
          }}
          onBrowse={() => {
            setOpenPlanChooserOpen(false);
            void openFile();
          }}
          onOpenPath={(path) => {
            setOpenPlanChooserOpen(false);
            void load(path);
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
        }}
        onPickLeaf={(leafId) => {
          armInsertLeaf(leafId);
        }}
        onUnavailable={(label) => {
          notify(`“${label}” is not in inventory and has no stock size — add it under Inventory first`);
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

      {newItemEditor && (
        <InventoryItemEditor
          item={newItemEditor}
          units={unitSystem}
          onClose={() => void closeNewItemEditor(false)}
          onSaved={() => {
            setNewItemProvisional(false);
            inventoryChanged();
            setNewItemEditor(null);
            showStatus('Item saved to inventory', 3500);
          }}
          onError={notify}
          onStatus={showStatus}
        />
      )}

      <BuildStageDialog
        open={buildStageOpen}
        units={unitSystem}
        origin={stageOrigin}
        disabled={!doc?.editable}
        onClose={() => setBuildStageOpen(false)}
        onBuilt={(next, created) => {
          if (next) setDoc(next as Doc);
          setInspectorOpen(true);
          setInspectorTab('properties');
          if (created?.length) {
            setSelectedIds(created);
            setSelection(null);
          }
          setSetupCompleted((current) => ({ ...current, stage: true }));
          showStatus(
            created?.length
              ? 'Stage built — select a deck to rotate or Repeat, or Insert the next piece'
              : 'Stage built',
          );
          setFitToken((t) => t + 1);
        }}
        onError={notify}
        onStatus={showStatus}
      />

      {seatingOpen && doc && (
        <div
          className="seating-window-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSeatingOpen(false);
          }}
        >
          <section
            className="seating-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="seating-window-title"
          >
            <header className="seating-window-header">
              <span className="seating-window-mark" aria-hidden>
                <IconChair size={20} />
              </span>
              <span className="seating-window-title">
                <small>Event layout workspace</small>
                <strong id="seating-window-title">Seating planner</strong>
                <span title={doc.name}>{doc.name.replace(/\.[^.]+$/, '')}</span>
              </span>
              <span className={`inspector-access${doc.editable ? '' : ' is-readonly'}`}>
                {doc.editable ? 'Editable' : 'Read only'}
              </span>
              <button
                type="button"
                className="seating-window-close"
                onClick={() => setSeatingOpen(false)}
                aria-label="Close seating planner"
                title="Close seating planner (Esc)"
              >
                ×
              </button>
            </header>
            <div className="seating-window-body">
              <RoomPanel
                mode="seating"
                doc={doc}
                onDoc={setDoc}
                onStatus={showStatus}
                onError={notify}
                drawingRoomOutline={isPressed(tool, roomOutlineChoice)}
                onDrawRoomOutline={() => {
                  setSeatingOpen(false);
                  setInspectorOpen(true);
                  setInspectorTab('room');
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
                onSeatingApplied={() =>
                  setSetupCompleted((current) => ({ ...current, seating: true }))
                }
                onSelect={(ids) => {
                  setSelectedIds(ids);
                  setSelection(null);
                }}
              />
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog
          appPreferences={{
            appearance,
            density,
            showTooltips,
            railOpen,
            inspectorOpen,
            toolDockOpen,
            toolDockCompact,
            toolDockSide,
          }}
          onAppPreferences={(change) => {
            if (change.appearance) setAppearance(change.appearance);
            if (change.density) setDensity(change.density);
            if (change.showTooltips != null) setShowTooltips(change.showTooltips);
            if (change.railOpen != null) setRailOpen(change.railOpen);
            if (change.inspectorOpen != null) setInspectorOpen(change.inspectorOpen);
            if (change.toolDockOpen != null) setToolDockOpen(change.toolDockOpen);
            if (change.toolDockCompact != null) setToolDockCompact(change.toolDockCompact);
            if (change.toolDockSide) setToolDockSide(change.toolDockSide);
          }}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsVersion((v) => v + 1);
          }}
          onError={notify}
        />
      )}

      {backgroundOpen && doc && (
        <BackgroundImageDialog
          background={planBackground}
          extent={doc.scene.roomExtent ?? doc.scene.extent}
          units={unitSystem}
          onPreview={setPlanBackground}
          onCommit={(background, message) => void commitPlanBackground(background, message)}
          onError={notify}
          onClose={() => setBackgroundOpen(false)}
        />
      )}

      {planFolderWorkspaceOpen && planFolders && (
        <PlanFolderWorkspace
          state={planFolders}
          initialFolderId={selectedPlanFolderId}
          currentPath={doc?.path}
          onState={acceptPlanFolderState}
          onOpenPlan={(path) => void load(path)}
          onClose={() => setPlanFolderWorkspaceOpen(false)}
          onError={notify}
          onStatus={showStatus}
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
                      <kbd>{shortcut('C')}</kbd>
                    </dt>
                    <dd>Copy items between plan tabs</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('V')}</kbd>
                    </dt>
                    <dd>Paste copied plan items</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('G')}</kbd>
                    </dt>
                    <dd>Group selected items so they move together</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{shortcut('G', true)}</kbd>
                    </dt>
                    <dd>Ungroup</dd>
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
                      <kbd>W</kbd>
                    </dt>
                    <dd>Edit walls</dd>
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
        className={`toolbar${view === 'plan' ? ' is-plan-toolbar' : ''}${welcomeMode ? ' is-welcome-toolbar' : ''}${view === 'plan' && toolDockOpen ? ' is-tool-dock-open' : ''}`}
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
                disabled={view === 'gear' ? !gear?.dirty : !doc?.editable || (!doc?.dirty && !textEditDirty)}
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
          <div className="ribbon-create">
            <button
              ref={createMenuButtonRef}
              className={`icon-btn ribbon-action${
                createMenuOpen || createDialogOpen ? ' is-on' : ''
              }`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const nextOpen = !createMenuOpen;
                if (nextOpen) {
                  setCreateMenuPos({
                    top: Math.round(rect.bottom + 6),
                    left: Math.max(8, Math.round(rect.left)),
                  });
                }
                setCreateMenuOpen(nextOpen);
              }}
              disabled={busy}
              data-tooltip="Create a plan, shape, item, or open show setup"
              aria-label="Create"
              aria-haspopup="menu"
              aria-expanded={createMenuOpen}
            >
              <IconPlus />
              <span>Create</span>
            </button>
            {createMenuOpen &&
              createMenuPos &&
              createPortal(
                <div
                  ref={createMenuRef}
                  className="ribbon-create-menu"
                  role="menu"
                  aria-label="Create"
                  style={{ top: createMenuPos.top, left: createMenuPos.left }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      void openNewPlanDialog();
                    }}
                  >
                    <span>New plan…</span>
                    <kbd>{shortcut('N')}</kbd>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!doc}
                    onClick={() => {
                      setCreateMenuOpen(false);
                      toggleCreatePanel();
                    }}
                  >
                    <span>Show setup</span>
                    <small>Text, seating, stage</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openNewShapeDialog()}
                  >
                    <span>New shape…</span>
                    <small>Draw or trace an outline</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void openNewItemDialog()}
                  >
                    <span>New item…</span>
                    <small>Add to inventory</small>
                  </button>
                </div>,
                document.body,
              )}
          </div>
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
            className={`icon-btn ribbon-action${toolDockOpen ? ' is-on' : ''}`}
            onClick={() => setToolDockOpen((open) => !open)}
            disabled={view !== 'plan'}
            data-tooltip={`${toolDockOpen ? 'Hide' : 'Show'} plan tools`}
            aria-pressed={toolDockOpen}
            aria-label={`${toolDockOpen ? 'Hide' : 'Show'} plan tools`}
          >
            <IconPointer />
            <span>Tools</span>
          </button>
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
                <span>Sheet</span>
              </button>
              <button
                className={`icon-btn ribbon-action${planBackground?.visible ? ' is-on' : ''}`}
                onClick={() => setBackgroundOpen(true)}
                disabled={!doc}
                data-tooltip={planBackground ? 'Open Background Studio — align and style the image underlay' : 'Open Background Studio — upload an image under the plot'}
                aria-label={planBackground ? 'Open Background Studio' : 'Upload and configure a background image'}
                aria-pressed={!!planBackground?.visible}
              >
                <IconFile />
                <span>Background</span>
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
                    ? 'Snapping on — edits use 1″ (Shift = fine, Alt = free) (S)'
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

            {!(view === 'plan' && toolDockOpen) && (
            <div className="seg ribbon-group event-layout-controls" aria-label="Event layout">
              <button
                className={`icon-btn ribbon-action${seatingOpen ? ' is-on' : ''}`}
                onClick={() => {
                  setSeatingOpen((open) => {
                    const next = !open;
                    if (next) {
                      setRefineRoomOpen(false);
                      setWallPickIndex(null);
                      setCalculatorOpen(false);
                    }
                    return next;
                  });
                }}
                disabled={!doc}
                data-tooltip="Open the seating planner"
                data-tool-id="seating"
                aria-label="Open seating planner"
                aria-pressed={seatingOpen}
              >
                <IconChair />
                <span>Seating</span>
              </button>
              <button
                className="icon-btn ribbon-action"
                onClick={() => setBuildStageOpen(true)}
                disabled={!doc?.editable}
                data-tooltip="Build a stage from stock decks"
                data-tool-id="stage"
                aria-label="Build stage"
              >
                <IconPlus />
                <span>Stage</span>
              </button>
              <button
                className={`icon-btn ribbon-action${calculatorOpen ? ' is-on' : ''}`}
                onClick={() =>
                  setCalculatorOpen((open) => {
                    const next = !open;
                    if (next) {
                      setRefineRoomOpen(false);
                      setWallPickIndex(null);
                    }
                    return next;
                  })
                }
                data-tooltip="Calculate room area, seating capacity, spacing, stages, and unit conversions"
                data-tool-id="calculator"
                aria-label="Open space calculator"
                aria-pressed={calculatorOpen}
              >
                <IconCalculator />
                <span>Calculate</span>
              </button>
            </div>
            )}

            {!(view === 'plan' && toolDockOpen) && (
            <div className="seg ribbon-group plan-tool-controls" aria-label="Plan drawing tools">
              <button
                className={`tool-button add-text-tool${isPressed(tool, labelChoice(annotationDraft.trim() || 'Text')) ? ' is-on' : ''}`}
                onClick={activateTextTool}
                disabled={!doc?.editable}
                data-tooltip={
                  doc?.editable
                    ? 'Add text (T) — type the label, then click the plan to place it'
                    : 'Open an editable plan to add text'
                }
                data-tool-id="add-text"
                aria-label="Add text label"
                aria-pressed={isPressed(tool, labelChoice(annotationDraft.trim() || 'Text'))}
              >
                <IconText />
                <span>Add text</span>
              </button>
              <button
                className={`tool-button${isPressed(tool, MEASURE) ? ' is-on' : ''}`}
                onClick={toggleMeasure}
                disabled={!doc}
                data-tooltip="Measure a temporary distance (M)"
                data-tool-id="measure"
                aria-label="Measure"
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
                data-tool-id="dimension"
                aria-label="Dimension"
                aria-pressed={isPressed(tool, DIMENSION)}
              >
                <IconRuler />
                <span>Dimension</span>
              </button>
            </div>
            )}

            {!(view === 'plan' && toolDockOpen) && (
            <div className="seg ribbon-group draw-tools" aria-label="Draw">
              <button
                className={`icon-btn ribbon-action${isPressed(tool, SELECT) ? ' is-on' : ''}`}
                onClick={() => dispatchTool({ type: 'pick', choice: SELECT })}
                disabled={!doc}
                data-tooltip="Select and move shapes (Esc)"
                data-tool-id="select"
                aria-label="Select tool"
                aria-pressed={isPressed(tool, SELECT)}
              >
                <IconPointer />
                <span>Select</span>
              </button>
              <button
                className={`icon-btn ribbon-action${isPressed(tool, DIRECT_SELECT) ? ' is-on' : ''}`}
                onClick={() => {
                  const { refusal } = dispatchTool({ type: 'pick', choice: DIRECT_SELECT });
                  if (refusal) notify(refusal);
                  setInspectorOpen(true);
                  setInspectorTab('properties');
                }}
                disabled={!doc}
                data-tooltip="Direct Selection / Edit Points — move anchors and Bézier handles"
                data-tool-id="direct-select"
                aria-label="Direct Selection and Edit Points tool"
                aria-pressed={isPressed(tool, DIRECT_SELECT)}
              >
                <IconDirectSelect />
                <span>Points</span>
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
                  data-tool-id={shape}
                  aria-label={label}
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
                data-tool-id="room"
                aria-label="Draw custom room outline"
                aria-pressed={isPressed(tool, roomOutlineChoice)}
              >
                <IconDrawPolygon />
                <span>Room</span>
              </button>
            </div>
            )}

            {!(view === 'plan' && toolDockOpen) && (
            <div className="seg ribbon-group create-wall-controls" aria-label="Wall editing">
              <button
                className={`icon-btn ribbon-action${refineRoomOpen && roomWorkspaceFocus === 'walls' ? ' is-on' : ''}`}
                onClick={() => toggleEditWalls()}
                disabled={!doc?.editable || !doc?.hasRoom}
                data-tooltip={
                  doc?.editable && doc?.hasRoom
                    ? refineRoomOpen && roomWorkspaceFocus === 'walls'
                      ? `Close wall editing workspace (W)`
                      : `Edit walls — push, curve, or stretch length on the plan (W)`
                    : 'Open a plan with a room to edit walls'
                }
                data-tool-id="edit-walls"
                aria-label="Edit walls mode"
                aria-pressed={refineRoomOpen && roomWorkspaceFocus === 'walls'}
              >
                <IconEdit />
                <span>Edit walls</span>
              </button>
              <button
                className={`icon-btn ribbon-action${refineRoomOpen && roomWorkspaceFocus === 'room' ? ' is-on' : ''}`}
                onClick={() => {
                  if (refineRoomOpen && roomWorkspaceFocus === 'room') {
                    closeRoomWorkspace();
                    showStatus('Room layout workspace closed');
                    return;
                  }
                  beginRoomWorkspaceLayout();
                  setRoomWorkspaceFocus('room');
                  setRefineRoomOpen(true);
                  setSeatingOpen(false);
                  setCalculatorOpen(false);
                  setInspectorOpen(false);
                  setSelectedIds([]);
                  const { refusal } = dispatchTool({ type: 'pick', choice: SELECT });
                  if (refusal) notify(refusal);
                  showStatus(
                    'Room layout workspace · resize, add/cut, then drag walls on the plan',
                    4500,
                  );
                  setFitToken((t) => t + 1);
                }}
                disabled={!doc?.editable || !doc?.hasRoom}
                data-tooltip={
                  doc?.editable && doc?.hasRoom
                    ? refineRoomOpen && roomWorkspaceFocus === 'room'
                      ? 'Close room layout workspace'
                      : 'Open room layout workspace — refine the whole room on the plan'
                    : 'Open a plan with a room to refine its layout'
                }
                data-tool-id="refine-room"
                aria-label="Refine room layout workspace"
                aria-pressed={refineRoomOpen && roomWorkspaceFocus === 'room'}
              >
                <IconDrawRect />
                <span>Refine room</span>
              </button>
            </div>
            )}

            <div className={`ribbon-quickbar${textEditingId != null ? ' is-text-editing' : ''}${refineRoomOpen && textEditingId == null ? ' is-room-layout' : ''}`}>
            {textEditingId != null ? (
              <div className="text-context-toolbar" aria-label="Quick text formatting">
                <span className="text-context-mode"><IconText size={14} /><b>Editing text</b></span>
                <textarea
                  className="text-context-content"
                  value={labelDraft}
                  maxLength={254}
                  rows={1}
                  onChange={(event) => setLabelDraft(event.target.value)}
                  onBlur={() => void commitTextEditing(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void commitTextEditing(true);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelTextEditing();
                    }
                  }}
                  aria-label="Text content"
                />
                <label className="text-context-size">
                  <span>Size</span>
                  <input
                    type="number"
                    min={4}
                    max={144}
                    step={1}
                    value={textSizeDraft}
                    onChange={(event) => setTextSizeDraft(event.target.value)}
                    onBlur={() => {
                      const size = Number(textSizeDraft);
                      if (size >= 4 && size <= 144) void applyTextStyle({ size });
                      else notify('Text size must be between 4 and 144 points');
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                    }}
                    aria-label="Text size in points"
                  />
                  <span>pt</span>
                </label>
                <div className="text-context-styles" role="group" aria-label="Text style">
                  <button className={textStyleDraft.bold ? 'is-on' : ''} onClick={() => void applyTextStyle({ bold: !textStyleDraft.bold })} aria-pressed={textStyleDraft.bold} title="Bold"><b>B</b></button>
                  <button className={textStyleDraft.italic ? 'is-on' : ''} onClick={() => void applyTextStyle({ italic: !textStyleDraft.italic })} aria-pressed={textStyleDraft.italic} title="Italic"><i>I</i></button>
                  <button className={textStyleDraft.underline ? 'is-on' : ''} onClick={() => void applyTextStyle({ underline: !textStyleDraft.underline })} aria-pressed={textStyleDraft.underline} title="Underline"><u>U</u></button>
                </div>
                <input
                  className="text-context-colour"
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(colorDraft) ? colorDraft : '#20252b'}
                  onChange={(event) => {
                    const hex = event.target.value;
                    setColorDraft(hex);
                    void applyColor(hex);
                  }}
                  aria-label="Text color"
                  title="Text color"
                />
                <button className="text-context-advanced" onClick={() => { setInspectorOpen(true); setInspectorTab('properties'); }}>
                  Advanced…
                </button>
                <span className="spacer" />
                <button onClick={cancelTextEditing}>Cancel</button>
                <button className="primary" onClick={() => void commitTextEditing(true)}>Done</button>
              </div>
            ) : refineRoomOpen ? (
              <WallEditToolbar
                focus={roomWorkspaceFocus}
                onFocus={setRoomWorkspaceFocus}
                gesture={wallEditGesture}
                onGesture={setWallEditGesture}
                wallLabel={
                  wallPickIndex != null
                    ? `Wall ${wallPickIndex + 1}`
                    : wallEdit?.selected != null
                      ? `Wall ${wallEdit.selected + 1}`
                      : null
                }
                wallLengthText={(() => {
                  const index = wallPickIndex ?? wallEdit?.selected ?? null;
                  const wall =
                    index != null ? wallEdit?.walls.find((entry) => entry.index === index) : null;
                  return wall ? formatLength(wall.length, unitSystem) : null;
                })()}
                curved={(() => {
                  const index = wallPickIndex ?? wallEdit?.selected ?? null;
                  const wall =
                    index != null ? wallEdit?.walls.find((entry) => entry.index === index) : null;
                  return Boolean(wall?.curved);
                })()}
                editable={Boolean(doc?.editable)}
                onNudgeIn={() => {
                  const index = wallPickIndex ?? wallEdit?.selected;
                  const wall =
                    index != null ? wallEdit?.walls.find((entry) => entry.index === index) : null;
                  if (index == null || !wall) return;
                  void (async () => {
                    let reply;
                    if (wallEditGesture === 'length') {
                      reply = await api.roomWallLength(
                        index,
                        Math.max(UNITS_PER_INCH, wall.length - UNITS_PER_INCH),
                      );
                    } else if (wallEditGesture === 'push') {
                      reply = await api.roomWallOffset(index, -UNITS_PER_INCH);
                    } else {
                      const dx = wall.endX - wall.startX;
                      const dy = wall.endY - wall.startY;
                      const chord = Math.hypot(dx, dy) || 1;
                      const nx = dy / chord;
                      const ny = -dx / chord;
                      const bulge = wall.bulge ?? 0;
                      const existing = bulge ? (bulge * chord) / 2 : 0;
                      const next = existing - UNITS_PER_INCH;
                      if (Math.abs(next) < 1) reply = await api.roomCurve(index, 0);
                      else {
                        reply = await api.roomCurveThrough(index, {
                          x: (wall.startX + wall.endX) / 2 + nx * next,
                          y: (wall.startY + wall.endY) / 2 + ny * next,
                        });
                      }
                    }
                    if (!reply.ok) {
                      notify(reply.reason ?? 'That wall could not be changed');
                      return;
                    }
                    if (reply.doc) setDoc(reply.doc as Doc);
                    showStatus(`Wall ${index + 1} · −1″`);
                  })();
                }}
                onNudgeOut={() => {
                  const index = wallPickIndex ?? wallEdit?.selected;
                  const wall =
                    index != null ? wallEdit?.walls.find((entry) => entry.index === index) : null;
                  if (index == null || !wall) return;
                  void (async () => {
                    let reply;
                    if (wallEditGesture === 'length') {
                      reply = await api.roomWallLength(index, wall.length + UNITS_PER_INCH);
                    } else if (wallEditGesture === 'push') {
                      reply = await api.roomWallOffset(index, UNITS_PER_INCH);
                    } else {
                      const dx = wall.endX - wall.startX;
                      const dy = wall.endY - wall.startY;
                      const chord = Math.hypot(dx, dy) || 1;
                      const nx = dy / chord;
                      const ny = -dx / chord;
                      const bulge = wall.bulge ?? 0;
                      const existing = bulge ? (bulge * chord) / 2 : 0;
                      const next = existing + UNITS_PER_INCH;
                      if (Math.abs(next) < 1) reply = await api.roomCurve(index, 0);
                      else {
                        reply = await api.roomCurveThrough(index, {
                          x: (wall.startX + wall.endX) / 2 + nx * next,
                          y: (wall.startY + wall.endY) / 2 + ny * next,
                        });
                      }
                    }
                    if (!reply.ok) {
                      notify(reply.reason ?? 'That wall could not be changed');
                      return;
                    }
                    if (reply.doc) setDoc(reply.doc as Doc);
                    showStatus(`Wall ${index + 1} · +1″`);
                  })();
                }}
                onStraighten={() => {
                  const index = wallPickIndex ?? wallEdit?.selected;
                  if (index == null) return;
                  void (async () => {
                    const reply = await api.roomCurve(index, 0);
                    if (!reply.ok) {
                      notify(reply.reason ?? 'That wall could not be straightened');
                      return;
                    }
                    if (reply.doc) setDoc(reply.doc as Doc);
                    showStatus(`Wall ${index + 1} straightened`);
                  })();
                }}
                onAddCorner={() => {
                  const index = wallPickIndex ?? wallEdit?.selected;
                  if (index == null) return;
                  void (async () => {
                    const reply = await api.roomCornerAdd(index);
                    if (!reply.ok) {
                      notify(reply.reason ?? 'Corner could not be added');
                      return;
                    }
                    if (reply.doc) setDoc(reply.doc as Doc);
                    showStatus(`Corner added on wall ${index + 1}`);
                  })();
                }}
                onRoundCorner={() => {
                  const index = wallPickIndex ?? wallEdit?.selected;
                  if (index == null) return;
                  void (async () => {
                    const reply = await api.roomCornerRound(index, 2 * 120);
                    if (!reply.ok) {
                      notify(reply.reason ?? 'Corner could not be rounded');
                      return;
                    }
                    if (reply.doc) setDoc(reply.doc as Doc);
                    showStatus(`Corner on wall ${index + 1} rounded`);
                  })();
                }}
                onDone={() => {
                  closeRoomWorkspace();
                  showStatus('Room layout workspace closed');
                }}
              />
            ) : (
              <>
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
                onClick={() => void copyPlanSelection()}
                disabled={!selectedIds.length}
                data-tooltip={`Copy selected shapes (${shortcut('C')})`}
                aria-label="Copy selected shapes"
              >
                <IconCopy />
              </button>
              <button
                className="icon-btn"
                onClick={() => void pastePlanSelection()}
                disabled={!doc?.editable}
                data-tooltip={planClipboard ? `Paste ${planClipboard.count} copied item${planClipboard.count === 1 ? '' : 's'} (${shortcut('V')})` : `Paste copied shapes (${shortcut('V')})`}
                aria-label="Paste copied shapes"
              >
                <IconPaste />
              </button>
              <button
                className="icon-btn"
                onClick={() => void groupPlanSelection()}
                disabled={!doc?.editable || selectedIds.length < 2}
                data-tooltip={`Group selected shapes (${shortcut('G')})`}
                aria-label="Group selected shapes"
              >
                <IconGroup />
              </button>
              <button
                className="icon-btn"
                onClick={() => void ungroupPlanSelection()}
                disabled={!doc?.editable || !selectedIds.length}
                data-tooltip={`Ungroup selected shapes (${shortcut('G', true)})`}
                aria-label="Ungroup selected shapes"
              >
                <IconUngroup />
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
              </>
            )}
            </div>
          </>
        )}

        <div className="seg ribbon-group utility-controls" aria-label="Help and settings">
          <button
            className={`icon-btn ribbon-action${darkMode ? ' is-on' : ''}`}
            onClick={() => setAppearance(darkMode ? 'light' : 'dark')}
            data-tooltip={darkMode ? 'Use light interface' : 'Use dark interface'}
            aria-label={darkMode ? 'Use light interface' : 'Use dark interface'}
            aria-pressed={darkMode}
          >
            {darkMode ? <IconSun /> : <IconMoon />}
            <span>{darkMode ? 'Light UI' : 'Dark UI'}</span>
          </button>
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

      {view === 'plan' && planTabs.length > 0 && (
        <nav className="plan-document-tabs" aria-label="Open plans">
          <div className="plan-document-tabs-scroll" role="tablist">
            {planTabs.map((tab) => {
              const active = activePlanPath === tab.path;
              return (
                <div className={`plan-document-tab${active ? ' is-active' : ''}`} key={tab.path}>
                  <button
                    type="button"
                    className="plan-document-tab-main"
                    role="tab"
                    aria-selected={active}
                    onClick={() => void switchPlanTab(tab.path)}
                    title={tab.path}
                    disabled={busy}
                  >
                    {tab.dirty ? <span className="plan-tab-dirty" title="Unsaved changes" /> : <IconFile size={13} />}
                    <span>{tab.name.replace(/\.[^.]+$/, '')}</span>
                    {!tab.editable && <IconLock size={11} />}
                  </button>
                  <button
                    type="button"
                    className="plan-document-tab-close"
                    onClick={() => void closePlanTab(tab.path)}
                    aria-label={`Close ${tab.name}`}
                    title={`Close ${tab.name}`}
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="plan-document-tab-actions">
            <button
              type="button"
              onClick={() => void copyPlanSelection()}
              disabled={!selectedIds.length}
              title={`Copy selection (${shortcut('C')})`}
              aria-label="Copy selected items"
            >
              <IconCopy size={14} />
              <span>Copy</span>
            </button>
            <button
              type="button"
              className={planClipboard ? 'has-clipboard' : ''}
              onClick={() => void pastePlanSelection()}
              disabled={!doc?.editable}
              title={planClipboard ? `Paste ${planClipboard.count} item${planClipboard.count === 1 ? '' : 's'} from ${planClipboard.sourceName} (${shortcut('V')})` : `Paste copied plan items (${shortcut('V')})`}
              aria-label="Paste copied plan items"
            >
              <IconPaste size={14} />
              <span>Paste</span>
              {planClipboard && <small className="num">{planClipboard.count}</small>}
            </button>
            <button
              type="button"
              onClick={() => setOpenPlanChooserOpen(true)}
              disabled={busy}
              title="New plan, browse, or open a recent show"
              aria-label="New plan, browse, or open a recent show"
            >
              <IconPlus size={14} />
            </button>
          </div>
        </nav>
      )}

      <div
        className={`body${
          railOpen && !welcomeMode && !refineRoomOpen ? '' : ' is-rail-hidden'
        }${
          inspectorOpen && !welcomeMode && !refineRoomOpen && !createDialogOpen ? '' : ' is-inspector-hidden'
        }${createDialogOpen && doc && !welcomeMode ? ' is-create-open' : ''}${welcomeMode ? ' is-welcome' : ''}${calculatorOpen ? ' is-calculator-open' : ''}${
          refineRoomOpen ? ' is-refine-open' : ''
        }`}
      >
        <aside className="rail" aria-hidden={!railOpen || refineRoomOpen}>
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
                  className={planRailSource === 'equipment' ? 'active' : ''}
                  onClick={() => setPlanRailSource('equipment')}
                  aria-pressed={planRailSource === 'equipment'}
                >
                  Equipment
                </button>
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
                      ? selectedPlanFolder.description || 'Plans stay in their original locations. A plan can be filed in more than one folder.'
                      : 'Organize by client, venue, quarter, or year without moving the original files.'}
                  </p>

                  <button
                    type="button"
                    className="plan-folder-workspace-launch"
                    onClick={() => setPlanFolderWorkspaceOpen(true)}
                    disabled={!planFolders || busy}
                  >
                    <span className="plan-folder-workspace-launch-icon"><IconFolder size={15} /></span>
                    <span>
                      <strong>Open Folder Workspace</strong>
                      <small>Virtual folders — search, notes, status; files stay on disk</small>
                    </span>
                    <span aria-hidden="true">↗</span>
                  </button>

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
                              <span
                                className="plan-folder-entry-colour"
                                style={{ background: candidate.color ?? 'var(--ink-3)' }}
                                aria-hidden="true"
                              />
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
                              {candidate.favorite && <span className="plan-folder-favorite" title="Favorite folder">★</span>}
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
                                    <span className={`plan-folder-status is-${plan.status}`}>
                                      {plan.status === 'review'
                                        ? 'In review'
                                        : plan.status[0].toUpperCase() + plan.status.slice(1)}
                                    </span>
                                  </span>
                                </span>
                                {plan.starred && <span className="plan-folder-plan-star" title="Starred">★</span>}
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
                      title={`Inventory (${inventory?.total ?? 0})`}
                    >
                      <span className="tab-label">Inventory</span>
                      <span className="num">{inventory?.total ?? 0}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={equipmentSource === 'gear' ? 'active' : ''}
                      aria-selected={equipmentSource === 'gear'}
                      onClick={() => setEquipmentSource('gear')}
                      title={gear ? `Gear list (${gear.totals[gearIndex]?.pieces ?? 0})` : 'Gear list'}
                    >
                      <span className="tab-label">Gear list</span>
                      {gear && <span className="num">{gear.totals[gearIndex]?.pieces ?? 0}</span>}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={equipmentSource === 'plan' ? 'active' : ''}
                      aria-selected={equipmentSource === 'plan'}
                      onClick={() => setEquipmentSource('plan')}
                      title={`On plan (${inventoryTotal.toLocaleString()})`}
                    >
                      <span className="tab-label">On plan</span>
                      <span className="num">{inventoryTotal.toLocaleString()}</span>
                    </button>
                  </div>
                  <div className="equipment-gesture-hint" role="note">
                    <span><strong>Click</strong> or <strong>drag</strong> — stays armed</span>
                    <span><kbd>Esc</kbd> / Done placing ends</span>
                  </div>
                  {recentInventory.length > 0 && equipmentSource === 'inventory' ? (
                    <div className="equipment-recent" aria-label="Recently placed inventory">
                      <div className="section-title">
                        <span>Recent</span>
                      </div>
                      <div className="equipment-recent-chips">
                        {recentInventory.map((row) => (
                          <button
                            key={row.id}
                            type="button"
                            className={`equipment-recent-chip${armedInventoryId === row.id ? ' is-armed' : ''}`}
                            disabled={!doc?.editable}
                            title={`Place ${row.name}`}
                            onClick={() => armInventory(row.id, row.name)}
                          >
                            {row.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
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
          onPointerOver={handleToolbarPointerOver}
          onPointerOut={handleToolbarPointerOut}
          onFocusCapture={handleToolbarFocus}
          onBlurCapture={handleToolbarBlur}
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
              {toolDockOpen && (
                <PlanToolDock
                  compact={toolDockCompact}
                  foreground={colorDraft}
                  paper={paper}
                  side={toolDockSide}
                  position={toolDockPosition}
                  order={toolDockOrder}
                  hidden={toolDockHidden}
                  onSide={setToolDockSide}
                  onPosition={setToolDockPosition}
                  onOrder={setToolDockOrder}
                  onHidden={setToolDockHidden}
                  onToggleCompact={() => setToolDockCompact((compact) => !compact)}
                  onClose={() => setToolDockOpen(false)}
                  onForeground={() => {
                    setInspectorOpen(true);
                    setInspectorTab('properties');
                  }}
                  onBackground={() => setPaper((current) => !current)}
                  groups={[
                    [
                      {
                        id: 'select',
                        label: 'Select / move',
                        shortcut: 'Esc',
                        icon: <IconPointer />,
                        active: isPressed(tool, SELECT),
                        disabled: !doc,
                        onClick: () => dispatchTool({ type: 'pick', choice: SELECT }),
                      },
                      {
                        id: 'direct-select',
                        label: 'Direct selection / edit points',
                        shortcut: 'A',
                        icon: <IconDirectSelect />,
                        active: isPressed(tool, DIRECT_SELECT),
                        disabled: !doc,
                        onClick: () => {
                          const { refusal } = dispatchTool({ type: 'pick', choice: DIRECT_SELECT });
                          if (refusal) notify(refusal);
                          setInspectorOpen(true);
                          setInspectorTab('properties');
                        },
                      },
                      {
                        id: 'hand',
                        label: 'Hand / pan',
                        shortcut: 'H',
                        icon: <IconHand />,
                        active: isPressed(tool, HAND),
                        disabled: !doc,
                        onClick: () => {
                          const { refusal } = dispatchTool({ type: 'toggle', choice: HAND });
                          if (refusal) notify(refusal);
                        },
                      },
                      {
                        id: 'properties',
                        label: 'Properties',
                        icon: <IconEdit />,
                        active: inspectorOpen && inspectorTab === 'properties',
                        disabled: !doc,
                        onClick: () => {
                          setInspectorOpen(true);
                          setInspectorTab('properties');
                        },
                      },
                      {
                        id: 'layers',
                        label: 'Layers',
                        icon: <IconLayers />,
                        active: inspectorOpen && inspectorTab === 'layers',
                        disabled: !doc,
                        onClick: () => {
                          setInspectorOpen(true);
                          setInspectorTab('layers');
                        },
                      },
                    ],
                    [
                      {
                        id: 'room',
                        label: 'Room outline',
                        icon: <IconDrawPolygon />,
                        active: isPressed(tool, roomOutlineChoice),
                        disabled: !doc.editable,
                        onClick: () => {
                          setInspectorOpen(true);
                          setInspectorTab('room');
                          const { refusal } = dispatchTool({ type: 'toggle', choice: roomOutlineChoice });
                          if (refusal) notify(refusal);
                          else setSelectedIds([]);
                        },
                      },
                      {
                        id: 'edit-walls',
                        label: 'Edit walls',
                        shortcut: 'W',
                        icon: <IconEdit />,
                        active: refineRoomOpen && roomWorkspaceFocus === 'walls',
                        disabled: !doc.editable || !doc.hasRoom,
                        onClick: () => toggleEditWalls(),
                      },
                      {
                        id: 'refine-room',
                        label: 'Refine room',
                        icon: <IconDrawRect />,
                        active: refineRoomOpen && roomWorkspaceFocus === 'room',
                        disabled: !doc.editable || !doc.hasRoom,
                        onClick: () => {
                          if (refineRoomOpen && roomWorkspaceFocus === 'room') {
                            closeRoomWorkspace();
                            showStatus('Room layout workspace closed');
                            return;
                          }
                          beginRoomWorkspaceLayout();
                          setRoomWorkspaceFocus('room');
                          setRefineRoomOpen(true);
                          setSeatingOpen(false);
                          setCalculatorOpen(false);
                          setInspectorOpen(false);
                          setSelectedIds([]);
                          const { refusal } = dispatchTool({ type: 'pick', choice: SELECT });
                          if (refusal) notify(refusal);
                          showStatus(
                            'Room layout workspace · resize, add/cut, then drag walls on the plan',
                            4500,
                          );
                          setFitToken((t) => t + 1);
                        },
                      },
                      {
                        id: 'create',
                        label: 'Show setup',
                        icon: <IconPlus />,
                        active: createDialogOpen,
                        disabled: !doc,
                        onClick: () => toggleCreatePanel(),
                      },
                      ...(
                        [
                          ['line', 'Line', IconDrawLine],
                          ['rect', 'Rectangle', IconDrawRect],
                          ['ellipse', 'Ellipse', IconDrawEllipse],
                        ] as const
                      ).map(([shape, label, Icon]) => ({
                        id: shape,
                        label,
                        icon: <Icon />,
                        active: isPressed(tool, drawChoice(shape)),
                        disabled: !doc.editable,
                        onClick: () => {
                          const { refusal } = dispatchTool({ type: 'toggle', choice: drawChoice(shape) });
                          if (refusal) notify(refusal);
                        },
                      })),
                    ],
                    [
                      {
                        id: 'add-text',
                        label: 'Add text',
                        shortcut: 'T',
                        icon: <IconText />,
                        active: isPressed(tool, labelChoice(annotationDraft.trim() || 'Text')),
                        disabled: !doc.editable,
                        onClick: activateTextTool,
                      },
                      {
                        id: 'measure',
                        label: 'Measure',
                        shortcut: 'M',
                        icon: <IconRuler />,
                        active: isPressed(tool, MEASURE),
                        disabled: !doc,
                        onClick: toggleMeasure,
                      },
                      {
                        id: 'dimension',
                        label: 'Dimension',
                        shortcut: 'D',
                        icon: <IconRuler />,
                        active: isPressed(tool, DIMENSION),
                        disabled: !canCreateDimension,
                        onClick: toggleDimension,
                      },
                      {
                        id: 'seating',
                        label: 'Seating planner',
                        icon: <IconChair />,
                        active: seatingOpen,
                        disabled: !doc,
                        onClick: () => setSeatingOpen((open) => !open),
                      },
                      {
                        id: 'stage',
                        label: 'Build stage',
                        icon: <IconPlus />,
                        disabled: !doc.editable,
                        onClick: () => setBuildStageOpen(true),
                      },
                      {
                        id: 'calculator',
                        label: 'Space calculator',
                        icon: <IconCalculator />,
                        active: calculatorOpen,
                        onClick: () => setCalculatorOpen((open) => !open),
                      },
                    ],
                    [
                      {
                        id: 'fit',
                        label: 'Zoom to fit',
                        shortcut: '0',
                        icon: <IconFit />,
                        disabled: !doc,
                        onClick: () => setFitToken((token) => token + 1),
                      },
                      {
                        id: 'grid',
                        label: showGrid ? 'Hide grid' : 'Show grid',
                        shortcut: 'G',
                        icon: <IconGrid />,
                        active: showGrid,
                        disabled: !doc,
                        onClick: () => void toggleGrid(),
                      },
                      {
                        id: 'snap',
                        label: snapStep ? 'Snap on' : 'Snap off',
                        shortcut: 'S',
                        icon: <IconMagnet />,
                        active: !!snapStep,
                        disabled: !doc,
                        onClick: toggleSnap,
                      },
                      {
                        id: 'sheet',
                        label: paper ? 'Dark sheet' : 'Paper sheet',
                        icon: paper ? <IconMoon /> : <IconSun />,
                        disabled: !doc,
                        onClick: () => setPaper((current) => !current),
                      },
                    ],
                    [
                      {
                        id: 'undo',
                        label: 'Undo',
                        shortcut: '⌘Z',
                        icon: <IconUndo />,
                        disabled: !doc.canUndo,
                        onClick: undo,
                      },
                      {
                        id: 'redo',
                        label: 'Redo',
                        shortcut: '⇧⌘Z',
                        icon: <IconRedo />,
                        disabled: !doc.canRedo,
                        onClick: redo,
                      },
                      {
                        id: 'select-all',
                        label: 'Select all',
                        shortcut: '⌘A',
                        icon: <IconPointer />,
                        disabled: !doc,
                        onClick: selectAll,
                      },
                      {
                        id: 'duplicate',
                        label: 'Duplicate',
                        shortcut: '⌘D',
                        icon: <IconDuplicate />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: duplicateSelection,
                      },
                      {
                        id: 'delete',
                        label: 'Delete',
                        shortcut: '⌫',
                        icon: <IconTrash />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: deleteSelection,
                      },
                    ],
                    [
                      {
                        id: 'rotate-left',
                        label: 'Rotate left',
                        shortcut: '[',
                        icon: <IconRotateLeft />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: () => void rotateSelection(-90),
                      },
                      {
                        id: 'rotate-right',
                        label: 'Rotate right',
                        shortcut: ']',
                        icon: <IconRotateRight />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: () => void rotateSelection(90),
                      },
                      {
                        id: 'flip-horizontal',
                        label: 'Flip across',
                        icon: <IconFlipHorizontal />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: () => void flipSelection('horizontal'),
                      },
                      {
                        id: 'flip-vertical',
                        label: 'Flip down',
                        icon: <IconFlipVertical />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: () => void flipSelection('vertical'),
                      },
                      {
                        id: 'bring-front',
                        label: 'Bring front',
                        icon: <IconBringFront />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: () => void reorderSelection('bring-to-front'),
                      },
                      {
                        id: 'send-back',
                        label: 'Send back',
                        icon: <IconSendBack />,
                        disabled: !doc.editable || !selectedIds.length,
                        onClick: () => void reorderSelection('send-to-back'),
                      },
                    ],
                    [
                      ...(
                        [
                          ['align-left', 'Align left', IconAlignLeft],
                          ['align-center', 'Align centre', IconAlignCenter],
                          ['align-right', 'Align right', IconAlignRight],
                          ['align-top', 'Align top', IconAlignTop],
                          ['align-middle', 'Align middle', IconAlignMiddle],
                          ['align-bottom', 'Align bottom', IconAlignBottom],
                        ] as const
                      ).map(([action, label, Icon]) => ({
                        id: action,
                        label,
                        icon: <Icon />,
                        disabled: !doc.editable || selectedIds.length < 2,
                        onClick: () => void arrangeSelection(action),
                      })),
                      {
                        id: 'distribute-horizontal',
                        label: 'Space across',
                        icon: <IconDistributeHorizontal />,
                        disabled: !doc.editable || selectedIds.length < 3,
                        onClick: () => void arrangeSelection('distribute-horizontal'),
                      },
                      {
                        id: 'distribute-vertical',
                        label: 'Space down',
                        icon: <IconDistributeVertical />,
                        disabled: !doc.editable || selectedIds.length < 3,
                        onClick: () => void arrangeSelection('distribute-vertical'),
                      },
                    ],
                    [
                      {
                        id: 'insert-object',
                        label: 'Insert object',
                        icon: <IconPlus />,
                        disabled: !doc.editable,
                        onClick: () => {
                          setInsertGroup(null);
                          setInsertOpen(true);
                        },
                      },
                      {
                        id: 'shape-builder',
                        label: 'Shape builder',
                        icon: <IconDrawPolygon />,
                        disabled: !doc.editable,
                        onClick: () => setShapeWizardOpen(true),
                      },
                      {
                        id: 'equipment-browser',
                        label: 'Equipment',
                        icon: <IconLayers />,
                        disabled: !doc,
                        onClick: () => {
                          setPlanRailSource('equipment');
                          setEquipmentSource('inventory');
                          setRailOpen(true);
                        },
                      },
                      {
                        id: 'print-plan',
                        label: 'Print setup',
                        shortcut: '⌘P',
                        icon: <IconPrint />,
                        disabled: !doc,
                        onClick: () => setPrintOpen(true),
                      },
                    ],
                  ]}
                />
              )}
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
              objectSnap={objectSnap}
              background={planBackground}
              fitToken={fitToken}
              selection={selectedIds}
              onSelect={(ids) => {
                if (
                  textEditingId != null &&
                  (ids.length !== 1 || ids[0] !== textEditingId)
                ) {
                  void commitTextEditing(true);
                }
                setSelectionScope(null);
                setSelectedIds(ids);
                if (ids.length > 1) {
                  showStatus(
                    `${ids.length.toLocaleString()} selected · Align, nudge, or drag together`,
                    2800,
                  );
                }
              }}
              onMoveSelection={moveSelection}
              editable={doc.editable}
              onCursor={setCursor}
              onZoom={setZoom}
              onDropItem={dropItem}
              onDropGear={dropGear}
              snapStep={snapStep}
              units={unitSystem}
              pointerMode={pointerMode}
              directPaths={tool.tool.kind === 'direct-select' ? selection?.pointPaths ?? [] : []}
              onMovePoint={(pathNodeId, pointIndex, x, y) => {
                void moveSelectionPoint(pathNodeId, pointIndex, x, y);
              }}
              textEditor={
                textEditingId != null
                  ? { nodeId: textEditingId, value: labelDraft }
                  : null
              }
              onEditText={startTextEditing}
              onTextEditorChange={setLabelDraft}
              onTextEditorCommit={() => void commitTextEditing(true)}
              onTextEditorBlur={() => void commitTextEditing(false)}
              onTextEditorCancel={cancelTextEditing}
              wallEdit={refineRoomOpen ? wallEdit : null}
              onPickWall={(index) => {
                setWallPickIndex(index);
                if (!refineRoomOpen) {
                  beginRoomWorkspaceLayout();
                  setRoomWorkspaceFocus('walls');
                  setRefineRoomOpen(true);
                  setSeatingOpen(false);
                  setCalculatorOpen(false);
                } else if (roomWorkspaceFocus !== 'walls') {
                  setRoomWorkspaceFocus('walls');
                }
                showStatus(
                  `Wall ${index + 1} selected · drag to ${wallEditGesture}`,
                  3200,
                );
              }}
              onWallGesture={(index, gesture, amount) => {
                void (async () => {
                  let reply;
                  if (gesture === 'push') {
                    reply = await api.roomWallOffset(index, amount);
                  } else if (gesture === 'length') {
                    const wall = wallEdit?.walls.find((entry) => entry.index === index);
                    if (!wall) {
                      notify('Select a wall first');
                      return;
                    }
                    reply = await api.roomWallLength(index, wall.length + amount);
                  } else {
                    // Curve through the dragged handle so the bow cannot invert.
                    const wall = wallEdit?.walls.find((entry) => entry.index === index);
                    if (!wall) {
                      notify('Select a wall first');
                      return;
                    }
                    const dx = wall.endX - wall.startX;
                    const dy = wall.endY - wall.startY;
                    const chord = Math.hypot(dx, dy) || 1;
                    const nx = dy / chord;
                    const ny = -dx / chord;
                    const midX = (wall.startX + wall.endX) / 2;
                    const midY = (wall.startY + wall.endY) / 2;
                    if (Math.abs(amount) <= 1) {
                      reply = await api.roomCurve(index, 0);
                    } else {
                      reply = await api.roomCurveThrough(index, {
                        x: midX + nx * amount,
                        y: midY + ny * amount,
                      });
                    }
                  }
                  if (!reply.ok) {
                    notify(reply.reason ?? 'That wall could not be changed');
                    return;
                  }
                  if (reply.doc) setDoc(reply.doc as Doc);
                  showStatus(
                    gesture === 'push'
                      ? `Wall ${index + 1} pushed`
                      : gesture === 'length'
                        ? `Wall ${index + 1} length set`
                        : `Wall ${index + 1} curved`,
                  );
                })();
              }}
              spanFrom={tool.tool.kind === 'span' ? tool.tool.from : null}
              pathPoints={tool.tool.kind === 'path' ? tool.tool.points : []}
              pathGuide={
                tool.tool.kind === 'path' && customRoomPrefs?.showGuide
                  ? { width: customRoomPrefs.guideWidth, depth: customRoomPrefs.guideDepth }
                  : null
              }
              pathAngleLock={
                tool.tool.kind === 'path' ? customRoomPrefs?.angleLock ?? 'free' : 'free'
              }
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
              {(awaitingRoomOutline && !doc.hasRoom) || isPressed(tool, roomOutlineChoice) ? (
                <div className="room-outline-banner" role="status">
                  <IconDrawPolygon size={16} />
                  <span>
                    <strong>
                      {isPressed(tool, roomOutlineChoice)
                        ? 'Click corners to finish the room'
                        : 'Room outline still needed'}
                    </strong>
                    <small>
                      {isPressed(tool, roomOutlineChoice)
                        ? 'Click near the start or press Enter · Esc cancels'
                        : 'Draw corners, finish as a rectangle, or discard this empty plan'}
                    </small>
                  </span>
                  <div className="room-outline-banner-actions">
                    {!isPressed(tool, roomOutlineChoice) && (
                      <button
                        type="button"
                        className="btn-solid"
                        onClick={() => {
                          const { refusal } = dispatchTool({ type: 'toggle', choice: roomOutlineChoice });
                          if (refusal) notify(refusal);
                          else setSelectedIds([]);
                        }}
                      >
                        Draw outline
                      </button>
                    )}
                    {isPressed(tool, roomOutlineChoice) && (
                      <button type="button" className="btn-solid" onClick={finishRoomOutline}>
                        Finish
                      </button>
                    )}
                    {(awaitingRoomOutline || !doc.hasRoom) && (
                      <button type="button" className="btn-outline" onClick={() => void finishPendingRoomAsRectangle()}>
                        Finish as rectangle
                      </button>
                    )}
                    {awaitingRoomOutline && !doc.hasRoom && (
                      <button type="button" className="link-btn is-danger" onClick={() => void discardEmptyPlan()}>
                        Discard plan
                      </button>
                    )}
                  </div>
                </div>
              ) : null}
              <WallEditHud
                open={refineRoomOpen}
                wallLabel={
                  wallPickIndex != null
                    ? `Wall ${wallPickIndex + 1}`
                    : wallEdit?.selected != null
                      ? `Wall ${wallEdit.selected + 1}`
                      : null
                }
                wallLengthText={(() => {
                  const index = wallPickIndex ?? wallEdit?.selected ?? null;
                  const wall =
                    index != null ? wallEdit?.walls.find((entry) => entry.index === index) : null;
                  return wall ? formatLength(wall.length, unitSystem) : null;
                })()}
                curved={(() => {
                  const index = wallPickIndex ?? wallEdit?.selected ?? null;
                  const wall =
                    index != null ? wallEdit?.walls.find((entry) => entry.index === index) : null;
                  return Boolean(wall?.curved);
                })()}
                wallIndex={wallPickIndex ?? wallEdit?.selected ?? null}
                wallCount={wallEdit?.walls.length ?? 0}
                onPrevWall={() => {
                  const walls = wallEdit?.walls ?? [];
                  if (!walls.length) return;
                  const current = wallPickIndex ?? wallEdit?.selected ?? walls[0]!.index;
                  const at = walls.findIndex((wall) => wall.index === current);
                  const prev = walls[(at - 1 + walls.length) % walls.length]!;
                  setWallPickIndex(prev.index);
                }}
                onNextWall={() => {
                  const walls = wallEdit?.walls ?? [];
                  if (!walls.length) return;
                  const current = wallPickIndex ?? wallEdit?.selected ?? walls[0]!.index;
                  const at = walls.findIndex((wall) => wall.index === current);
                  const next = walls[(at + 1) % walls.length]!;
                  setWallPickIndex(next.index);
                }}
              />
            </div>
          ) : (
            <WelcomeHome
              recent={recent}
              folders={planFolders}
              onNewPlan={() => void openNewPlanDialog()}
              onOpenPlan={() => void openFile()}
              onOpenFolder={() => void openFolder()}
              onOpenPath={(path) => void load(path)}
              onOpenFolderWorkspace={(folderId) => {
                if (folderId) setSelectedPlanFolderId(folderId);
                setPlanFolderWorkspaceOpen(true);
              }}
              onOpenShortcuts={() => setShortcutsOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
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
                ) : action.id === 'finish-place' ? (
                  <button key={action.id} className="btn-primary" onClick={finishPlacement}>
                    {action.label}
                  </button>
                ) : action.id === 'undo-point' ? (
                  <button key={action.id} onClick={() => dispatchTool({ type: 'undo-point' })}>
                    {action.label}
                  </button>
                ) : (
                  <button key={action.id} onClick={cancelPlacement}>
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

      {doc && (
        <CreateDialog
          open={createDialogOpen}
          docked
          editable={!!doc.editable}
          hasRoom={Boolean(doc.hasRoom)}
          drawingRoomOutline={isPressed(tool, roomOutlineChoice)}
          identity={planIdentityFields}
          selectedCount={selectedIds.length}
          identityBusy={identityBusy}
          completed={setupCompleted}
          canCreateLabel={canCreateLabel}
          canCreateDimension={canCreateDimension}
          textActive={isPressed(tool, labelChoice(annotationDraft.trim() || 'Text'))}
          annotationDraft={annotationDraft}
          annotationColor={annotationColor}
          platform={api.platform}
          styleHint={annotationStyleHint}
          annotationInputRef={annotationInputRef}
          dimensionActive={isPressed(tool, DIMENSION)}
          inventory={catalogInventory?.items ?? inventory?.items ?? doc.scene.inventory}
          seatKind={seatKind}
          seatTable={seatTable}
          seatChair={seatChair}
          seatCount={seatCount}
          seatRows={seatRows}
          seatPerRow={seatPerRow}
          seatAngle={seatAngle}
          seatSpacingFt={seatSpacingFt}
          seatRowSpacingFt={seatRowSpacingFt}
          seatRowLengths={seatRowLengths}
          seatingArmed={
            tool.tool.kind === 'stamp' && tool.tool.stamp.what === 'seating'
          }
          onClose={() => setCreateDialogOpen(false)}
          onSaveIdentity={savePlanIdentity}
          onOpenRoom={openRoomPanel}
          onDrawRoomOutline={() => {
            setAwaitingRoomOutline(true);
            const { refusal } = dispatchTool({ type: 'toggle', choice: roomOutlineChoice });
            if (refusal) notify(refusal);
            else {
              setSelectedIds([]);
              showStatus('Click each room corner on the plan, then press Enter', 4500);
            }
          }}
          onFinishRoomAsRectangle={
            awaitingRoomOutline && !doc.hasRoom ? () => void finishPendingRoomAsRectangle() : undefined
          }
          onDiscardEmptyPlan={
            awaitingRoomOutline && !doc.hasRoom ? () => void discardEmptyPlan() : undefined
          }
          onBuildStage={() => {
            setBuildStageOpen(true);
          }}
          onInsert={() => {
            setInsertGroup(null);
            setInsertOpen(true);
          }}
          onRepeat={() => {
            if (selectedIds.length !== 1) {
              showStatus('Select one item first, then Repeat');
              return;
            }
            setCreateDialogOpen(false);
            setInspectorOpen(true);
            setInspectorTab('properties');
            showStatus('Set direction and count in Properties, then Repeat', 4500);
          }}
          onSeating={() => {
            setSeatingOpen(true);
          }}
          onPrint={() => {
            setPrintOpen(true);
          }}
          onText={editAnnotationDraft}
          onColor={editAnnotationColor}
          onStartText={armLabel}
          onDoneText={finishTextTool}
          onToggleDimension={() => {
            toggleDimension();
          }}
          onSeatKind={setSeatKind}
          onSeatTable={setSeatTable}
          onSeatChair={setSeatChair}
          onSeatCount={setSeatCount}
          onSeatRows={setSeatRows}
          onSeatPerRow={setSeatPerRow}
          onSeatAngle={setSeatAngle}
          onSeatSpacingFt={setSeatSpacingFt}
          onSeatRowSpacingFt={setSeatRowSpacingFt}
          onSeatRowLengths={setSeatRowLengths}
          onDonePlacing={cancelPlacement}
          onPlaceSeating={() => {
            const lengths = seatRowLengths
              .split(/[,;\s]+/)
              .map((part) => Number(part.trim()))
              .filter((n) => Number.isFinite(n) && n >= 1);
            const anglePart = seatAngle ? ` @ ${seatAngle > 0 ? '+' : ''}${seatAngle}°` : '';
            const description =
              seatKind === 'round'
                ? `${seatTable} with ${seatCount} seats`
                : lengths.length
                  ? `${lengths.length} irregular rows (${lengths.reduce((a, b) => a + b, 0)} seats)${anglePart}`
                  : `${seatRows} × ${seatPerRow} ${seatKind}${anglePart}`;
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
                    rowLengths: lengths.length ? lengths : undefined,
                    angle: seatAngle || undefined,
                    seatSpacing:
                      seatKind !== 'round' && seatSpacingFt > 0
                        ? seatSpacingFt * FOOT
                        : undefined,
                    rowSpacing:
                      seatKind !== 'round' && seatRowSpacingFt > 0
                        ? seatRowSpacingFt * FOOT
                        : undefined,
                  },
                },
              },
            });
            if (refusal) notify(refusal);
            else {
              showStatus(
                'Click the plan to stamp · change settings here and click again · Done placing when finished',
                4200,
              );
            }
          }}
          onNewShape={openNewShapeDialog}
          onNewItem={() => void openNewItemDialog()}
          kits={layoutKits}
          kitsBusy={kitsBusy}
          onRefreshKits={refreshLayoutKits}
          onApplyKit={(kitId) => void applyShowKit(kitId)}
          onImportKit={() => {
            void (async () => {
              const reply = await api.importLayoutKit();
              if (reply.cancelled) return;
              if (!reply.ok) {
                notify(reply.reason ?? 'Could not import recipe');
                return;
              }
              refreshLayoutKits();
              showStatus('Layout recipe imported', 3500);
            })();
          }}
          onExportRecipe={() => {
            void (async () => {
              const reply = await api.exportLayoutRecipe();
              if (reply.cancelled) return;
              if (!reply.ok) {
                notify(reply.reason ?? 'Could not export recipe');
                return;
              }
              refreshLayoutKits();
              showStatus(`Exported recipe${reply.path ? ` · ${reply.path.split(/[\\/]/).pop()}` : ''}`, 4500);
            })();
          }}
          bankPresets={bankPresets as never}
          onSaveBankPreset={() => {
            void (async () => {
              const lengths = seatRowLengths
                .split(/[,;\s]+/)
                .map((part) => Number(part.trim()))
                .filter((n) => Number.isFinite(n) && n >= 1);
              const name = lengths.length
                ? `${lengths.length} rows @ ${seatAngle || 0}°`
                : `${seatRows}×${seatPerRow} @ ${seatAngle || 0}°`;
              const reply = await api.saveBankPreset({
                name,
                block: {
                  chair: seatChair,
                  angleDeg: seatAngle || undefined,
                  seatSpacingFt: seatSpacingFt || undefined,
                  rowSpacingFt: seatRowSpacingFt || undefined,
                  rowLengths: lengths.length ? lengths : undefined,
                  rows: lengths.length ? undefined : seatRows,
                  perRow: lengths.length ? undefined : seatPerRow,
                },
              });
              if (!reply.ok) {
                notify(reply.reason ?? 'Could not save bank preset');
                return;
              }
              const next = await api.listBankPresets();
              setBankPresets(next);
              showStatus(`Saved bank preset “${name}”`, 3000);
            })();
          }}
          onLoadBankPreset={(preset) => {
            const block = preset.block;
            if (typeof block.chair === 'string') setSeatChair(block.chair);
            if (typeof block.angleDeg === 'number') setSeatAngle(block.angleDeg);
            if (typeof block.seatSpacingFt === 'number') setSeatSpacingFt(block.seatSpacingFt);
            if (typeof block.rowSpacingFt === 'number') setSeatRowSpacingFt(block.rowSpacingFt);
            if (Array.isArray(block.rowLengths) && block.rowLengths.length) {
              setSeatRowLengths(block.rowLengths.join(','));
            } else {
              setSeatRowLengths('');
              if (typeof block.rows === 'number') setSeatRows(block.rows);
              if (typeof block.perRow === 'number') setSeatPerRow(block.perRow);
            }
            setSeatKind('theatre');
            showStatus(`Loaded bank preset “${preset.name}” — Place on plan to stamp`, 3500);
          }}
          onDeleteBankPreset={(id) => {
            void api.deleteBankPreset(id).then(() => api.listBankPresets().then(setBankPresets));
          }}
        />
      )}

        <aside
          ref={inspectorRef}
          className="inspector"
          aria-hidden={!(inspectorOpen && !welcomeMode)}
          aria-label="Properties and layers inspector"
          tabIndex={inspectorOpen && !welcomeMode ? 0 : -1}
        >
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
                    if (reply.ok) {
                      inventoryChanged();
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
                    if (reply.ok) {
                      inventoryChanged();
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
                    { id: 'layers', label: 'Layers', icon: <IconLayers size={14} /> },
                    { id: 'properties', label: 'Properties', icon: <IconEdit size={14} /> },
                    { id: 'room', label: 'Room', icon: <IconDrawRect size={14} /> },
                  ] as const).map(({ id, label, icon }) => (
                    <button
                      key={id}
                      className={inspectorTab === id ? 'active' : ''}
                      onClick={() => setInspectorTab(id)}
                      aria-current={inspectorTab === id ? 'page' : undefined}
                    >
                      <span className="inspector-tab-icon" aria-hidden>
                        {icon}
                      </span>
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
                          : tool.tool.kind === 'direct-select'
                            ? 'Edit points active'
                          : tool.tool.kind === 'hand'
                            ? 'Hand tool active'
                            : selectedIds.length
                              ? selectionScopeMeta
                                ? `${selectionScopeMeta.label} selected`
                                : `${selectedIds.length.toLocaleString()} selected`
                              : 'Nothing selected'}
                    </strong>
                    <small>
                      {tool.tool.kind === 'stamp'
                        ? 'Click the plan to place more · Done placing to edit or Repeat'
                        : tool.tool.kind === 'span'
                          ? toolBannerState?.message ?? 'Follow the prompt over the plan'
                        : tool.tool.kind === 'path'
                            ? toolBannerState?.message ?? 'Click around the room boundary'
                          : tool.tool.kind === 'direct-select'
                            ? selectedIds.length
                              ? 'Drag blue anchors on the plan or enter exact coordinates below'
                              : 'Select an item to reveal its anchors and Bézier handles'
                          : tool.tool.kind === 'hand'
                            ? 'Drag the plan to pan · press H to finish'
                            : selectedIds.length
                              ? selectionScopeMeta
                                ? `${selectedIds.length.toLocaleString()} objects will change together`
                                : selection?.name ?? selection?.cls.replace(/^RV/, '') ?? 'Use the controls below to edit the selection'
                              : 'Select a shape on the plan to edit it here'}
                    </small>
                  </span>
                  {(tool.tool.kind !== 'select' || selectedIds.length > 0) && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        if (tool.tool.kind === 'stamp') {
                          finishPlacement();
                          return;
                        }
                        // Leaving the path tool mid-outline must not drop the
                        // New Plan "save once the room exists" promise.
                        dispatchTool({ type: 'pick', choice: SELECT });
                        if (tool.tool.kind === 'select') setSelectedIds([]);
                      }}
                    >
                      {tool.tool.kind === 'select'
                        ? 'Clear'
                        : tool.tool.kind === 'stamp'
                          ? 'Done placing'
                          : 'Done'}
                    </button>
                  )}
                </div>
              </div>

              {inspectorTab === 'properties' && (
                <>
              <div className={`section selected-item-section${selectedIds.length ? ' has-selection' : ''}`}>
                <div className="section-title">
                  <span>{selectedIds.length > 1 ? 'Selection' : 'Selected item'}</span>
                  {selectedIds.length > 0 && (
                    <span className="section-count">{selectedIds.length}</span>
                  )}
                </div>

                {selectionScopeMeta && selectedIds.length > 0 && (
                  <div className="layer-selection-scope-block">
                    <div
                      className="layer-selection-scope"
                      style={{ '--layer-scope-tint': selectionScopeMeta.tint } as React.CSSProperties}
                    >
                      <span className="layer-selection-scope-icon" aria-hidden>
                        <IconLayers size={16} />
                      </span>
                      <span className="layer-selection-scope-copy">
                        <small>{selectionScope?.kind === 'group' ? 'Layer group selected' : 'Whole layer selected'}</small>
                        <strong>{selectionScopeMeta.label}</strong>
                        <span>{selectedIds.length.toLocaleString()} objects · {selectionScopeMeta.description}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setInspectorTab('layers')}
                        title="Return to the layer list"
                      >
                        Layers
                      </button>
                    </div>
                    <div className="layer-selection-scope-toolbar" aria-label="Selected layer controls">
                      <button
                        type="button"
                        onClick={() => setSelectedScopeVisible(!selectionScopeMeta.allVisible)}
                      >
                        {selectionScopeMeta.allVisible ? 'Hide scope' : 'Show scope'}
                      </button>
                      <button type="button" onClick={showOnlySelectedScope}>Show only</button>
                      <button type="button" onClick={() => setSelectedIds([])}>Clear</button>
                    </div>
                  </div>
                )}

                {selectedIds.length === 0 ? (
                  <div className="selected-item-empty">
                    <span className="selected-item-empty-icon" aria-hidden>
                      <IconPointer size={18} />
                    </span>
                    <div className="selected-item-empty-copy">
                      <strong>
                        {tool.tool.kind === 'direct-select' ? 'Pick a path' : 'Nothing selected'}
                      </strong>
                      <span>
                        {tool.tool.kind === 'direct-select'
                          ? 'Click a line, room edge, drawn shape, or symbol to reveal its editable anchors.'
                          : doc.editable
                            ? 'Click an item on the plan to edit size, position, colour, and repeats here.'
                            : 'This plan is read-only — select an item to inspect it.'}
                      </span>
                    </div>
                  </div>
                ) : selectedIds.length > 1 ? (
                  <>
                    <div className="selection-multi-banner" role="status">
                      <strong>{selectedIds.length.toLocaleString()} objects</strong>
                      <span>Drag together · Shift-click to add · Align below</span>
                    </div>

                    <div className="selection-action-strip" aria-label="Selection actions">
                      <button
                        type="button"
                        onClick={() => arrangeSelection('align-left')}
                        disabled={!doc.editable}
                        title="Align left"
                        aria-label="Align left"
                      >
                        <IconAlignLeft size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => arrangeSelection('align-center')}
                        disabled={!doc.editable}
                        title="Align centre"
                        aria-label="Align centre"
                      >
                        <IconAlignCenter size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => arrangeSelection('align-right')}
                        disabled={!doc.editable}
                        title="Align right"
                        aria-label="Align right"
                      >
                        <IconAlignRight size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => arrangeSelection('align-top')}
                        disabled={!doc.editable}
                        title="Align top"
                        aria-label="Align top"
                      >
                        <IconAlignTop size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => arrangeSelection('align-middle')}
                        disabled={!doc.editable}
                        title="Align middle"
                        aria-label="Align middle"
                      >
                        <IconAlignMiddle size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => arrangeSelection('align-bottom')}
                        disabled={!doc.editable}
                        title="Align bottom"
                        aria-label="Align bottom"
                      >
                        <IconAlignBottom size={15} />
                      </button>
                      <span className="selection-action-strip-rule" aria-hidden />
                      <button
                        type="button"
                        onClick={() => arrangeSelection('distribute-horizontal')}
                        disabled={!doc.editable || selectedIds.length < 3}
                        title="Space evenly across"
                        aria-label="Space evenly across"
                      >
                        <IconDistributeHorizontal size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => arrangeSelection('distribute-vertical')}
                        disabled={!doc.editable || selectedIds.length < 3}
                        title="Space evenly down"
                        aria-label="Space evenly down"
                      >
                        <IconDistributeVertical size={15} />
                      </button>
                      <span className="selection-action-strip-rule" aria-hidden />
                      <button
                        type="button"
                        onClick={() => void copyPlanSelection()}
                        title="Copy selection"
                        aria-label="Copy selection"
                      >
                        <IconCopy size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void pastePlanSelection()}
                        disabled={!doc.editable}
                        title="Paste"
                        aria-label="Paste"
                      >
                        <IconPaste size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void groupPlanSelection()}
                        disabled={!doc.editable || selectedIds.length < 2}
                        title={`Group (${shortcut('G')})`}
                        aria-label="Group"
                      >
                        <IconGroup size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void ungroupPlanSelection()}
                        disabled={!doc.editable || !selectedIds.length}
                        title={`Ungroup (${shortcut('G', true)})`}
                        aria-label="Ungroup"
                      >
                        <IconUngroup size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={duplicateSelection}
                        disabled={!doc.editable}
                        title="Duplicate (⌘D)"
                        aria-label="Duplicate"
                      >
                        <IconDuplicate size={15} />
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={deleteSelection}
                        disabled={!doc.editable}
                        title="Delete"
                        aria-label="Delete"
                      >
                        <IconTrash size={15} />
                      </button>
                    </div>

                    <div className="tool-group layer-scope-move">
                      <span className="tool-label">Nudge</span>
                      <div className="layer-nudge-control" aria-label="Move selected group">
                        <span />
                        <button type="button" onClick={() => void moveSelection(0, -nudgeStep)} disabled={!doc.editable} aria-label="Move up">↑</button>
                        <span />
                        <button type="button" onClick={() => void moveSelection(-nudgeStep, 0)} disabled={!doc.editable} aria-label="Move left">←</button>
                        <strong>{formatLength(nudgeStep, unitSystem)}</strong>
                        <button type="button" onClick={() => void moveSelection(nudgeStep, 0)} disabled={!doc.editable} aria-label="Move right">→</button>
                        <span />
                        <button type="button" onClick={() => void moveSelection(0, nudgeStep)} disabled={!doc.editable} aria-label="Move down">↓</button>
                        <span />
                      </div>
                      <p className="hint">Arrow keys also nudge · Shift for fine step</p>
                    </div>
                    {canTransformSelection && (
                      <div className="tool-group">
                        <span className="tool-label">Rotate &amp; mirror</span>
                        <div className="text-action-row selection-rotate-row">
                          <button type="button" className="text-action" onClick={() => rotateSelection(-90)} disabled={!doc.editable}>
                            Rotate left 90°
                          </button>
                          <button type="button" className="text-action" onClick={() => rotateSelection(90)} disabled={!doc.editable}>
                            Rotate right 90°
                          </button>
                          <button type="button" className="text-action" onClick={() => flipSelection('horizontal')} disabled={!doc.editable}>
                            Flip horizontal
                          </button>
                          <button type="button" className="text-action" onClick={() => flipSelection('vertical')} disabled={!doc.editable}>
                            Flip vertical
                          </button>
                        </div>
                        <SnappySlider
                          label="Rotate by"
                          values={[-180, -90, -45, -30, -15, 15, 30, 45, 90, 180]}
                          defaultValue={15}
                          min={-180}
                          max={180}
                          step={1}
                          suffix="°"
                          compact
                          disabled={!doc.editable}
                          value={Number(rotationDraft) || 15}
                          onChange={(next) => setRotationDraft(String(next))}
                          onChangeEnd={() => rotateByDraft()}
                        />
                        <p className="hint">Turns the whole selection about its centre — use ±30° for angled seating banks.</p>
                      </div>
                    )}
                    <div className="tool-group repeat-group">
                      <span className="tool-label">Repeat</span>
                      <p className="hint selection-repeat-hint">
                        Repeat works on one object. Keep the first selected item, then set count and direction.
                      </p>
                      <button
                        type="button"
                        className="text-action selection-keep-first"
                        disabled={!doc.editable}
                        onClick={() => {
                          const first = selectedIds[0];
                          if (first == null) return;
                          setSelectedIds([first]);
                          setSelectionScope(null);
                          showStatus('One item kept — set Repeat count and direction');
                        }}
                      >
                        Keep first · enable Repeat
                      </button>
                    </div>
                    <div className="tool-group">
                      <span className="tool-label">Order</span>
                      <div className="text-action-row">
                        <button type="button" className="text-action" onClick={() => void reorderSelection('bring-to-front')} disabled={!doc.editable}>
                          Bring to front
                        </button>
                        <button type="button" className="text-action" onClick={() => void reorderSelection('send-to-back')} disabled={!doc.editable}>
                          Send to back
                        </button>
                      </div>
                    </div>
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
                    </div>
                    <button type="button" className="link-btn selection-clear-link" onClick={() => setSelectedIds([])}>
                      Clear selection
                    </button>
                  </>
                ) : selection ? (
                  <>
                    <dl className="facts selected-item-facts">
                      <div>
                        <dt>Name</dt>
                        <dd>{selection.name ?? selection.cls.replace(/^RV/, '')}</dd>
                      </div>
                      <div>
                        <dt>Type</dt>
                        <dd>{selection.cls.replace(/^RV/, '')}</dd>
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

                    {tool.tool.kind === 'direct-select' && (
                      <div className="tool-group point-editor-group">
                        <PointEditor
                          paths={selection.pointPaths}
                          units={unitSystem}
                          editable={doc.editable}
                          onMovePoint={moveSelectionPoint}
                          onSetPathKind={setSelectionPathKind}
                          onError={notify}
                        />
                      </div>
                    )}

                    {selection.dimension && (
                      <div className="tool-group">
                        <span className="tool-label">Dimension</span>
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
                              if (
                                !selection ||
                                selectedId == null ||
                                selection.nodeId !== selectedId ||
                                labelDraft === (selection.text ?? '')
                              ) {
                                return;
                              }
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
                              if (
                                !selection ||
                                selectedId == null ||
                                selection.nodeId !== selectedId ||
                                labelDraft.trim() === (selection.name ?? '').trim()
                              ) {
                                return;
                              }
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

                    {selection.cls === 'RVLabel' && selection.textStyle && (
                      <div className="tool-group text-format-inspector">
                        <div className="text-format-heading">
                          <span>
                            <small>Typography</small>
                            <strong>Advanced text formatting</strong>
                          </span>
                          {textEditingId === selection.nodeId ? (
                            <button className="primary" onClick={() => void commitTextEditing(true)}>Done editing</button>
                          ) : (
                            <button onClick={() => startTextEditing(selection.nodeId)}>Edit on canvas</button>
                          )}
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor="text-font-family">Font</label>
                            <input
                              id="text-font-family"
                              list="text-font-family-options"
                              value={textStyleDraft.family}
                              disabled={!doc.editable}
                              onChange={(event) => setTextStyleDraft((current) => ({ ...current, family: event.target.value }))}
                              onBlur={(event) => void applyTextStyle({ family: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                              }}
                            />
                            <datalist id="text-font-family-options">
                              {['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana', 'Tahoma'].map((family) => (
                                  <option key={family} value={family}>{family}</option>
                              ))}
                            </datalist>
                          </div>
                          <div className="field text-format-size-field">
                            <label htmlFor="text-font-size">Size</label>
                            <div className="text-format-number">
                              <input
                                id="text-font-size"
                                className="num"
                                type="number"
                                min={4}
                                max={144}
                                step={1}
                                value={textSizeDraft}
                                disabled={!doc.editable}
                                onChange={(event) => setTextSizeDraft(event.target.value)}
                                onBlur={() => {
                                  const size = Number(textSizeDraft);
                                  if (size >= 4 && size <= 144) void applyTextStyle({ size });
                                  else notify('Text size must be between 4 and 144 points');
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                                }}
                              />
                              <span>pt</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-format-toggle-grid" role="group" aria-label="Text styles">
                          <button className={textStyleDraft.bold ? 'is-on' : ''} onClick={() => void applyTextStyle({ bold: !textStyleDraft.bold })} aria-pressed={textStyleDraft.bold}><b>B</b><span>Bold</span></button>
                          <button className={textStyleDraft.italic ? 'is-on' : ''} onClick={() => void applyTextStyle({ italic: !textStyleDraft.italic })} aria-pressed={textStyleDraft.italic}><i>I</i><span>Italic</span></button>
                          <button className={textStyleDraft.underline ? 'is-on' : ''} onClick={() => void applyTextStyle({ underline: !textStyleDraft.underline })} aria-pressed={textStyleDraft.underline}><u>U</u><span>Underline</span></button>
                          <button className={textStyleDraft.strikeOut ? 'is-on' : ''} onClick={() => void applyTextStyle({ strikeOut: !textStyleDraft.strikeOut })} aria-pressed={textStyleDraft.strikeOut}><s>S</s><span>Strike</span></button>
                        </div>
                        <div className="field">
                          <label htmlFor="text-rotation">Text rotation</label>
                          <div className="rotation-row">
                            <input
                              id="text-rotation"
                              className="num"
                              type="number"
                              min={-3600}
                              max={3600}
                              step={5}
                              value={textRotationDraft}
                              disabled={!doc.editable}
                              onChange={(event) => setTextRotationDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  const angleDegrees = Number(textRotationDraft);
                                  if (Number.isFinite(angleDegrees)) void applyTextStyle({ angleDegrees });
                                }
                              }}
                            />
                            <span>°</span>
                            <button
                              disabled={!doc.editable}
                              onClick={() => {
                                const angleDegrees = Number(textRotationDraft);
                                if (Number.isFinite(angleDegrees)) void applyTextStyle({ angleDegrees });
                              }}
                            >Apply</button>
                          </div>
                          <div className="text-angle-presets">
                            {[0, -45, 45, 90].map((angleDegrees) => (
                              <button
                                key={angleDegrees}
                                disabled={!doc.editable}
                                onClick={() => {
                                  setTextRotationDraft(String(angleDegrees));
                                  void applyTextStyle({ angleDegrees });
                                }}
                              >{angleDegrees}°</button>
                            ))}
                          </div>
                        </div>
                        <p className="hint">Double-click any label to edit it in place. Use {api.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter to apply or Esc to cancel.</p>
                      </div>
                    )}

                    {(canResizeSelection || canPositionSelection) && (
                      <div className="field">
                        <label htmlFor="drawing-units">Measurements</label>
                        <select
                          id="drawing-units"
                          value={unitSystem}
                          onChange={(e) => setDrawingUnits(e.target.value === 'metric' ? 'metric' : 'imperial')}
                          title="How lengths are shown and how bare numbers are read."
                        >
                          <option value="imperial">Feet &amp; inches</option>
                          <option value="metric">Metres &amp; centimetres</option>
                        </select>
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
                      </div>
                    )}

                    {canTransformSelection && (
                      <div className="tool-group">
                        <span className="tool-label">Rotate &amp; mirror</span>
                        <div className="text-action-row">
                          <button type="button" className="text-action" onClick={() => rotateSelection(-90)} disabled={!doc.editable} title="Rotate left 90° ( [ )">
                            Rotate left 90°
                          </button>
                          <button type="button" className="text-action" onClick={() => rotateSelection(90)} disabled={!doc.editable} title="Rotate right 90° ( ] )">
                            Rotate right 90°
                          </button>
                        </div>
                        <SnappySlider
                          label="Rotate by"
                          values={[-180, -90, -45, -30, -15, 15, 30, 45, 90, 180]}
                          defaultValue={15}
                          min={-180}
                          max={180}
                          step={1}
                          suffix="°"
                          compact
                          disabled={!doc.editable}
                          value={Number(rotationDraft) || 15}
                          onChange={(next) => setRotationDraft(String(next))}
                          onChangeEnd={() => rotateByDraft()}
                        />
                        <div className="text-action-row">
                          <button type="button" className="text-action" onClick={() => flipSelection('horizontal')} disabled={!doc.editable} title="Mirror left to right">
                            Flip horizontal
                          </button>
                          <button type="button" className="text-action" onClick={() => flipSelection('vertical')} disabled={!doc.editable} title="Mirror top to bottom">
                            Flip vertical
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="tool-group">
                      <span className="tool-label">{selection.cls === 'RVLabel' ? 'Text colour' : 'Line colour'}</span>
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

                    <div className="tool-group repeat-group">
                      <span className="tool-label">Repeat</span>
                      <SnappySlider
                        label="Count"
                        values={[2, 4, 7, 10, 16, 24, 40]}
                        defaultValue={7}
                        min={2}
                        max={40}
                        step={1}
                        prefix="×"
                        compact
                        disabled={!doc.editable || selectedIds.length !== 1}
                        value={Math.max(2, Math.floor(Number(arrayCountDraft)) || 7)}
                        onChange={(next) => setArrayCountDraft(String(next))}
                      />
                      <div className="repeat-row">
                        <div className="seg repeat-dirs" role="group" aria-label="Repeat direction">
                          {(
                            [
                              ['left', '←'],
                              ['up', '↑'],
                              ['down', '↓'],
                              ['right', '→'],
                            ] as const
                          ).map(([dir, glyph]) => (
                            <button
                              key={dir}
                              type="button"
                              className={arrayDirection === dir ? 'is-on' : ''}
                              aria-pressed={arrayDirection === dir}
                              aria-label={dir}
                              disabled={!doc.editable || selectedIds.length !== 1}
                              onClick={() => setArrayDirection(dir)}
                            >
                              {glyph}
                            </button>
                          ))}
                        </div>
                        <button
                          className="btn-solid repeat-go"
                          onClick={() => void arraySelectionAcross()}
                          disabled={!doc.editable || selectedIds.length !== 1}
                          title="Duplicate this item in a row, spaced by its size"
                        >
                          ×{arrayCountDraft || '…'}
                        </button>
                      </div>
                      <p className="hint">
                        House riser: place one 6′×8′ deck, face right, then ×7.
                      </p>
                    </div>

                    <div className="text-action-row">
                      <button type="button" className="text-action" onClick={duplicateSelection} disabled={!doc.editable} title="Duplicate (Cmd/Ctrl+D)">
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="text-action is-danger"
                        onClick={deleteSelection}
                        disabled={!doc.editable || !selection.canDelete}
                        title={selection.canDelete ? 'Delete (Del)' : 'Shared with other items'}
                      >
                        Delete
                      </button>
                    </div>
                    <p className="hint">Drag to move. Arrows nudge a foot, Shift an inch.</p>
                  </>
                ) : null}
              </div>

              {selectedIds.length === 0 && (
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
              )}
                </>
              )}

              {inspectorTab === 'room' && (
                <RoomPanel
                  mode="room"
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
                  onSeatingApplied={() =>
                    setSetupCompleted((current) => ({ ...current, seating: true }))
                  }
                  onSelect={(ids) => {
                    setSelectedIds(ids);
                    setSelection(null);
                  }}
                  onWallEditChange={setWallEdit}
                  wallPickIndex={wallPickIndex}
                  preferredWallAction={undefined}
                  onPreferredWallActionChange={setWallEditGesture}
                />
              )}

              {inspectorTab === 'layers' && (
                <>
              <div className="section background-layer-section">
                <BackgroundLayerPanel
                  background={planBackground}
                  extent={doc.scene.roomExtent ?? doc.scene.extent}
                  units={unitSystem}
                  onPreview={setPlanBackground}
                  onCommit={(background, message) => void commitPlanBackground(background, message)}
                  onError={notify}
                />
              </div>
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
                    const groupObjectCount = groupLayers.reduce(
                      (total, layer) => total + (layerCounts.get(layer.id) ?? 0),
                      0,
                    );
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
                            className="layer-group-select"
                            onClick={() => selectLayerGroup(group.id)}
                            disabled={!doc || groupObjectCount === 0}
                            title={`Select all ${groupObjectCount.toLocaleString()} objects in ${group.label}`}
                          >
                            Select
                            <span className="num">{groupObjectCount.toLocaleString()}</span>
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
                                      className="layer-eye"
                                      onClick={() => toggleLayer(layer.id)}
                                      aria-pressed={isVisible}
                                      title={`${isVisible ? 'Hide' : 'Show'} ${layer.label}`}
                                      aria-label={`${isVisible ? 'Hide' : 'Show'} ${layer.label}`}
                                    >
                                      <span className="layer-check" aria-hidden>
                                        {isVisible && <IconEye size={14} />}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      className="layer-select-surface"
                                      onClick={() => selectLayer(layer.id)}
                                      disabled={!doc || count === 0}
                                      title={`Select all ${count.toLocaleString()} objects on ${layer.label}`}
                                    >
                                      <span className="layer-thumbnail" style={{ color: layer.tint }} aria-hidden>
                                        {layer.id === 'annotation' ? (
                                          <IconText size={15} />
                                        ) : layer.id === 'walls' || layer.id === 'region' ? (
                                          <IconDrawPolygon size={15} />
                                        ) : layer.id === 'other' ? (
                                          <IconDrawRect size={15} />
                                        ) : (
                                          <IconLayers size={15} />
                                        )}
                                      </span>
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
                                      Select layer
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
        <SpaceCalculator
          open={calculatorOpen}
          units={unitSystem}
          roomWidth={doc?.scene.roomExtent ? doc.scene.roomExtent.maxX - doc.scene.roomExtent.minX : undefined}
          roomHeight={doc?.scene.roomExtent ? doc.scene.roomExtent.maxY - doc.scene.roomExtent.minY : undefined}
          onClose={() => setCalculatorOpen(false)}
        />
        {doc && (
          <RoomRefineWorkspace
            open={refineRoomOpen}
            focus={roomWorkspaceFocus}
            doc={doc}
            onDoc={setDoc}
            onStatus={showStatus}
            onError={notify}
            onSelect={(ids) => {
              setSelectedIds(ids);
              setSelection(null);
            }}
            drawingRoomOutline={isPressed(tool, roomOutlineChoice)}
            onDrawRoomOutline={() => {
              closeRoomWorkspace();
              setInspectorOpen(true);
              setInspectorTab('room');
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
            onWallEditChange={setWallEdit}
            wallPickIndex={wallPickIndex}
            wallEditGesture={wallEditGesture}
            onWallEditGestureChange={setWallEditGesture}
            onClose={() => {
              closeRoomWorkspace();
            }}
          />
        )}
      </div>

      <footer className={`statusbar${welcomeMode ? ' is-welcome-hidden' : ''}`}>
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
