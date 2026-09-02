/**
 * What the plan workspace is doing, as one value.
 *
 * The workspace used to be ten independent booleans — `railOpen`,
 * `inspectorOpen`, `toolDockOpen`, `createDialogOpen`, `refineRoomOpen`,
 * `wallsEditArmed`, `seatingOpen`, `calculatorOpen` and two sub-selections —
 * written from 135 places. They were meant to be mutually exclusive, but
 * nothing enforced it: every entry point had to remember to close the other
 * nine by hand, and the mode the user was in was then *inferred back* out of
 * five of those flags. The mode was therefore stored twice, imperatively and
 * derivatively, and the two could disagree.
 *
 * That shape is why panels open and close under you. Adding "wall edit can stay
 * on while Place is open" meant touching twelve call sites, and missing one is
 * invisible until a user finds it.
 *
 * Phase 1 keeps the compatibility `mode` for commands while moving visible
 * surfaces into independent layers. The canvas is always present; a left
 * browser/insert rail, the inspector, drawing tools, and room editing wrap it
 * without replacing one another.
 */

export type WorkspaceMode =
  /** Recent plans and folders in the side rail. */
  | 'browse'
  /** Inventory and gear rail, armed for stamping. */
  | 'place'
  /** Layers and properties. */
  | 'inspect'
  /** Room / kit / print setup dialog. */
  | 'setup'
  /** Drawing tools shelf. */
  | 'draw'
  /** The exclusive room resize workspace. */
  | 'room-layout'
  /** Full canvas, nothing open. */
  | 'canvas';

/**
 * Things that ride ON TOP of a mode rather than replacing it.
 *
 * The distinction is the whole point. Wall editing is an overlay because a user
 * genuinely wants to nudge a wall while the inventory rail stays open; the room
 * resize workspace is a mode because it takes the canvas over.
 */
export type Overlay = 'wall-edit' | 'seating' | 'calculator';
export type LeftPanel = 'none' | 'files' | 'assets';
export type Interaction = 'idle' | 'insert' | 'drawing' | 'room-edit';

export const OVERLAYS: readonly Overlay[] = ['wall-edit', 'seating', 'calculator'];

/** Which list the browse rail is showing. Sub-state of `browse`. */
export type BrowseSource = 'recent' | 'collections' | 'folder';

export interface WorkspaceState {
  /** Compatibility projection for command/menu callers during migration. */
  mode: WorkspaceMode;
  left: LeftPanel;
  inspectorOpen: boolean;
  setupOpen: boolean;
  drawDockOpen: boolean;
  interaction: Interaction;
  /**
   * Open overlays, oldest first. Order is not decoration: Escape closes the
   * most recently opened one, which is the only unwinding a user can predict.
   */
  overlays: readonly Overlay[];
  browseSource: BrowseSource;
  roomFocus: 'walls' | 'room';
}

export const INITIAL_WORKSPACE: WorkspaceState = {
  mode: 'inspect',
  left: 'none',
  inspectorOpen: true,
  setupOpen: false,
  drawDockOpen: false,
  interaction: 'idle',
  overlays: [],
  browseSource: 'recent',
  roomFocus: 'room',
};

/**
 * Where each overlay is allowed to stay open.
 *
 * Entering a mode drops every overlay not listed for it. This one table
 * replaces roughly forty scattered `setSeatingOpen(false)` calls, and it is the
 * only place to look when asking "why did that close?".
 */
export function overlayAllowedIn(_overlay: Overlay, _mode: WorkspaceMode): boolean {
  return true;
}

export type WorkspaceAction =
  | { type: 'enter'; mode: WorkspaceMode }
  | { type: 'toggle-mode'; mode: WorkspaceMode }
  | { type: 'focus-plan' }
  | { type: 'open-overlay'; overlay: Overlay }
  | { type: 'close-overlay'; overlay: Overlay }
  | { type: 'toggle-overlay'; overlay: Overlay }
  | { type: 'browse-source'; source: BrowseSource }
  | { type: 'room-focus'; focus: 'walls' | 'room' }
  | { type: 'escape' }
  | { type: 'reset' };

function enter(state: WorkspaceState, mode: WorkspaceMode): WorkspaceState {
  switch (mode) {
    case 'browse':
      return { ...state, mode, left: 'files', setupOpen: false };
    case 'place':
      return { ...state, mode, left: 'assets', setupOpen: false, interaction: 'insert' };
    case 'inspect':
      return {
        ...state,
        mode,
        inspectorOpen: true,
        setupOpen: false,
        interaction: state.interaction === 'room-edit' ? 'idle' : state.interaction,
      };
    case 'setup':
      // Setup is plan content inside the Inspector, not a second right dock.
      return { ...state, mode, setupOpen: true, inspectorOpen: true, drawDockOpen: false };
    case 'draw':
      return { ...state, mode, drawDockOpen: true, setupOpen: false, interaction: 'drawing' };
    case 'room-layout':
      return { ...state, mode, interaction: 'room-edit', setupOpen: false, roomFocus: 'room' };
    case 'canvas':
      return {
        ...state,
        mode,
        setupOpen: false,
        drawDockOpen: false,
        interaction: state.interaction === 'room-edit' ? 'idle' : state.interaction,
      };
  }
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'enter':
      return enter(state, action.mode);

    case 'toggle-mode':
      switch (action.mode) {
        case 'browse':
          return { ...state, mode: 'browse', left: state.left === 'files' ? 'none' : 'files', setupOpen: false };
        case 'place':
          return {
            ...state,
            mode: 'place',
            left: state.left === 'assets' ? 'none' : 'assets',
            setupOpen: false,
            interaction: state.left === 'assets' ? 'idle' : 'insert',
          };
        case 'inspect':
          if (state.setupOpen || state.interaction === 'room-edit') return enter(state, 'inspect');
          return { ...state, mode: 'inspect', inspectorOpen: !state.inspectorOpen };
        case 'setup':
          if (state.setupOpen) {
            return { ...state, setupOpen: false, mode: state.inspectorOpen ? 'inspect' : 'canvas' };
          }
          return { ...state, mode: 'setup', setupOpen: true, inspectorOpen: true, drawDockOpen: false };
        case 'draw':
          return {
            ...state,
            mode: 'draw',
            drawDockOpen: !state.drawDockOpen,
            setupOpen: false,
            interaction: state.drawDockOpen ? 'idle' : 'drawing',
          };
        case 'room-layout':
          return {
            ...state,
            mode: 'room-layout',
            interaction: state.interaction === 'room-edit' ? 'idle' : 'room-edit',
            setupOpen: false,
            roomFocus: 'room',
          };
        case 'canvas':
          return workspaceReducer(state, { type: 'focus-plan' });
      }

    case 'focus-plan':
      return {
        ...state,
        mode: 'canvas',
        left: 'none',
        inspectorOpen: false,
        setupOpen: false,
        drawDockOpen: false,
        interaction: 'idle',
        overlays: [],
      };

    case 'open-overlay': {
      if (state.overlays.includes(action.overlay)) return state;
      return { ...state, overlays: [...state.overlays, action.overlay] };
    }

    case 'close-overlay': {
      if (!state.overlays.includes(action.overlay)) return state;
      return { ...state, overlays: state.overlays.filter((o) => o !== action.overlay) };
    }

    case 'toggle-overlay':
      return workspaceReducer(state, {
        type: state.overlays.includes(action.overlay) ? 'close-overlay' : 'open-overlay',
        overlay: action.overlay,
      });

    case 'browse-source':
      return { ...state, browseSource: action.source };

    case 'room-focus':
      return { ...state, roomFocus: action.focus };

    case 'escape': {
      // Inspector is persistent. Focus Plan, not Escape, hides it.
      if (state.overlays.length) {
        return { ...state, overlays: state.overlays.slice(0, -1) };
      }
      if (state.setupOpen) return { ...state, setupOpen: false, mode: 'inspect' };
      if (state.drawDockOpen) {
        return { ...state, drawDockOpen: false, interaction: 'idle', mode: 'inspect' };
      }
      if (state.interaction === 'room-edit') {
        return { ...state, interaction: 'idle', mode: state.left === 'assets' ? 'place' : 'inspect' };
      }
      if (state.left !== 'none') {
        return { ...state, left: 'none', interaction: 'idle', mode: state.inspectorOpen ? 'inspect' : 'canvas' };
      }
      return state;
    }

    case 'reset':
      return INITIAL_WORKSPACE;

    default:
      return state;
  }
}

/** True when Escape would change the workspace, so callers know who owns the key. */
export function escapeConsumed(state: WorkspaceState): boolean {
  return (
    state.overlays.length > 0 ||
    state.setupOpen ||
    state.drawDockOpen ||
    state.interaction === 'room-edit' ||
    state.left !== 'none'
  );
}

export interface WorkspacePanels {
  railOpen: boolean;
  railSource: BrowseSource | 'equipment';
  inspectorOpen: boolean;
  toolDockOpen: boolean;
  createDialogOpen: boolean;
  refineRoomOpen: boolean;
  seatingOpen: boolean;
  calculatorOpen: boolean;
  /** Wall handles are live in the exclusive workspace or under the overlay. */
  wallEditLive: boolean;
  /** The exclusive workspace is the only mode that hides the plan chrome. */
  fullCanvas: boolean;
  inspectorVisible: boolean;
  drawDockFloat: boolean;
}

/**
 * Every panel, derived.
 *
 * Nothing else in the app may decide whether a panel is open. That is the rule
 * that makes the whole thing hold: a panel cannot be left behind by a code path
 * that forgot about it, because no code path sets one.
 */
export function panelsFor(state: WorkspaceState): WorkspacePanels {
  const { overlays } = state;
  const refineRoomOpen = state.interaction === 'room-edit';
  // Setup content lives inside the Inspector (plan surface). The flag still
  // means "Show Setup is the active plan focus" for commands and the rail.
  const createDialogOpen = state.setupOpen;
  const inspectorVisible = state.inspectorOpen && !refineRoomOpen;
  return {
    railOpen: state.left !== 'none',
    railSource: state.left === 'assets' ? 'equipment' : state.browseSource,
    inspectorOpen: state.inspectorOpen,
    inspectorVisible,
    toolDockOpen: state.drawDockOpen,
    createDialogOpen,
    refineRoomOpen,
    seatingOpen: overlays.includes('seating'),
    calculatorOpen: overlays.includes('calculator'),
    wallEditLive: refineRoomOpen || overlays.includes('wall-edit'),
    fullCanvas:
      state.left === 'none' &&
      !state.inspectorOpen &&
      !state.drawDockOpen &&
      !refineRoomOpen &&
      overlays.length === 0,
    drawDockFloat: state.drawDockOpen && (inspectorVisible || refineRoomOpen),
  };
}

/** The status line for a transition, so every entry point says the same thing. */
export function workspaceStatus(state: WorkspaceState): string {
  const wallEdit = state.overlays.includes('wall-edit');
  switch (state.mode) {
    case 'browse':
      return 'Files · recent plans and folders';
    case 'place':
      return wallEdit ? 'Assets · inventory and gear · wall edit still on' : 'Assets · stamp inventory and gear';
    case 'inspect':
      return wallEdit ? 'Properties · layers and properties · wall edit still on' : 'Properties · layers and properties';
    case 'setup':
      return 'Show Setup · brief, layout, and readiness in the Inspector';
    case 'draw':
      return 'All tools · drawing, annotation, and measurement';
    case 'room-layout':
      return 'Room layout · resize, add/cut, then drag walls on the plan';
    case 'canvas':
      return wallEdit ? 'Full canvas · wall edit on' : 'Full canvas';
  }
}

/** Derived panel visibility for the permanent editor rail and contextual dock. */
export const MODE_STRIP: readonly WorkspaceMode[] = ['browse', 'place', 'inspect', 'setup', 'draw'];

export interface LandingFacts {
  /** The plan has a closed room outline to work inside. */
  hasRoom: boolean;
  /** The plan has anything in it BESIDES the room itself. */
  hasContent: boolean;
}

/**
 * Layers that count as content.
 *
 * `walls` and `region` are the room, and the room is not content: a plan with
 * four walls and nothing else is an empty room waiting to be filled, not a
 * drawing waiting to be read. Counting every primitive would send that plan to
 * the canvas with nothing on it to look at.
 */
const CONTENT_LAYERS = new Set(['furniture', 'annotation', 'other']);

export function isContentLayer(layer: string): boolean {
  return CONTENT_LAYERS.has(layer);
}

/**
 * Where a freshly opened plan should land.
 *
 * This used to be "wherever the app happened to be", which in practice meant
 * Place with the inventory rail armed. That is the worst available default for
 * the commonest action in the app. Opening a plan is a READ: you open a show
 * file to see the room, count the chairs, find the projector, print it. Adding
 * gear is real work, but it is never the first thing, because you have to see
 * what is there before you add to it. Landing in Place made a passive intent
 * destructive — the first click stamped inventory onto a finished client
 * plan — covered a third of the sheet the user opened in order to look at it,
 * and handed over a stamp tool when every drawing application this audience
 * knows opens with a selection tool.
 *
 * The opposite rule is just as wrong. A blank plan has nothing to read, so
 * dropping the user on an empty sheet with no panel is a dead end.
 *
 * So the landing follows the document, not a fixed default and not a sticky
 * preference:
 *
 *   - no room yet        → `setup`, because nothing else can happen first
 *   - a room, but empty  → `place`, because filling it is the only next task
 *   - anything drawn     → `canvas`, because you opened it to look at it
 *
 * A plan already open in a tab is deliberately NOT passed through here; see
 * the per-tab memory at the call site.
 */
export function landingModeFor(facts: LandingFacts): WorkspaceMode {
  if (!facts.hasRoom) return 'setup';
  return 'inspect';
}

export interface LandingRequest {
  /**
   * The caller already knows where this plan must land.
   *
   * New Plan is the case that needs it: the dialog has just asked the user what
   * they want, so the flow that follows — trace the outline, calibrate a
   * background, apply a kit — dictates the mode. Deriving one and letting the
   * flow override it a statement later is how the Create dialog came to flash
   * open and shut on the tracing path.
   */
  explicit?: WorkspaceMode;
  /** Where this plan was last left, if it has been open before this session. */
  remembered?: WorkspaceMode;
  facts: LandingFacts;
}

/**
 * The one landing decision, with its precedence written down.
 *
 * explicit ▸ remembered ▸ derived. A caller that knows beats a memory, and a
 * memory beats a guess. New Plan takes the first rung because the file is new:
 * any memory at that path belongs to a document that no longer exists.
 */
export function resolveLanding(request: LandingRequest): WorkspaceMode {
  return request.explicit ?? request.remembered ?? landingModeFor(request.facts);
}
