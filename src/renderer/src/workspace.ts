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
 * Here the mode is a single value, overlays are a separate small set, and every
 * panel is DERIVED. There is one place that decides what closes what: the
 * compatibility table below. React state is a reducer over this, so the rules
 * are testable without rendering anything.
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

export const OVERLAYS: readonly Overlay[] = ['wall-edit', 'seating', 'calculator'];

/** Which list the browse rail is showing. Sub-state of `browse`. */
export type BrowseSource = 'recent' | 'collections' | 'folder';

export interface WorkspaceState {
  mode: WorkspaceMode;
  /**
   * Open overlays, oldest first. Order is not decoration: Escape closes the
   * most recently opened one, which is the only unwinding a user can predict.
   */
  overlays: readonly Overlay[];
  browseSource: BrowseSource;
  roomFocus: 'walls' | 'room';
  /**
   * Where to land when the room workspace closes.
   *
   * This replaces a pair of functions that stashed `railOpen`/`inspectorOpen`
   * into a ref on the way in and put them back on the way out — a hand-rolled
   * undo for panel state that leaked whenever an exit path forgot to call it.
   */
  returnTo: WorkspaceMode;
}

export const INITIAL_WORKSPACE: WorkspaceState = {
  mode: 'canvas',
  overlays: [],
  browseSource: 'recent',
  roomFocus: 'room',
  returnTo: 'canvas',
};

/**
 * Where each overlay is allowed to stay open.
 *
 * Entering a mode drops every overlay not listed for it. This one table
 * replaces roughly forty scattered `setSeatingOpen(false)` calls, and it is the
 * only place to look when asking "why did that close?".
 */
const OVERLAY_MODES: Record<Overlay, readonly WorkspaceMode[]> = {
  // Wall edit deliberately survives Place and Inspect: nudging a wall while the
  // inventory rail is open is the common case, not an exotic one.
  'wall-edit': ['browse', 'place', 'inspect', 'canvas'],
  // Seating is a focused task. It does not belong over the setup dialog or the
  // drawing shelf, both of which own the same screen space.
  seating: ['place', 'inspect', 'canvas'],
  // The calculator is a read-only scratchpad, so it can sit over anything that
  // still shows the plan.
  calculator: ['browse', 'place', 'inspect', 'draw', 'canvas'],
};

export function overlayAllowedIn(overlay: Overlay, mode: WorkspaceMode): boolean {
  return OVERLAY_MODES[overlay].includes(mode);
}

export type WorkspaceAction =
  | { type: 'enter'; mode: WorkspaceMode }
  | { type: 'toggle-mode'; mode: WorkspaceMode }
  | { type: 'open-overlay'; overlay: Overlay }
  | { type: 'close-overlay'; overlay: Overlay }
  | { type: 'toggle-overlay'; overlay: Overlay }
  | { type: 'browse-source'; source: BrowseSource }
  | { type: 'room-focus'; focus: 'walls' | 'room' }
  | { type: 'escape' }
  | { type: 'reset' };

/** Drops overlays the target mode will not host. */
function keepOverlays(overlays: readonly Overlay[], mode: WorkspaceMode): readonly Overlay[] {
  const kept = overlays.filter((overlay) => overlayAllowedIn(overlay, mode));
  return kept.length === overlays.length ? overlays : kept;
}

function enter(state: WorkspaceState, mode: WorkspaceMode): WorkspaceState {
  if (mode === state.mode) return state;
  return {
    ...state,
    mode,
    overlays: keepOverlays(state.overlays, mode),
    // Only remember a return target on the way INTO the exclusive workspace,
    // and never remember the workspace itself, or closing it would reopen it.
    returnTo: mode === 'room-layout' && state.mode !== 'room-layout' ? state.mode : state.returnTo,
    roomFocus: mode === 'room-layout' ? 'room' : state.roomFocus,
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'enter':
      return enter(state, action.mode);

    case 'toggle-mode':
      // Pressing the mode you are already in returns to the bare canvas, which
      // is what every toolbar toggle in the app already implies.
      return enter(state, state.mode === action.mode ? 'canvas' : action.mode);

    case 'open-overlay': {
      if (state.overlays.includes(action.overlay)) return state;
      // An overlay that does not fit the current mode takes the workspace back
      // to the canvas rather than opening invisibly behind a dialog.
      const mode = overlayAllowedIn(action.overlay, state.mode) ? state.mode : 'canvas';
      const base = enter(state, mode);
      return { ...base, overlays: [...base.overlays, action.overlay] };
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
      // One ordered unwinding, so Escape is predictable from anywhere:
      // newest overlay, then the exclusive workspace, then the mode itself.
      if (state.overlays.length) {
        return { ...state, overlays: state.overlays.slice(0, -1) };
      }
      if (state.mode === 'room-layout') {
        return { ...state, mode: state.returnTo, returnTo: 'canvas' };
      }
      if (state.mode !== 'canvas') return { ...state, mode: 'canvas' };
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
  return state.overlays.length > 0 || state.mode !== 'canvas';
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
}

/**
 * Every panel, derived.
 *
 * Nothing else in the app may decide whether a panel is open. That is the rule
 * that makes the whole thing hold: a panel cannot be left behind by a code path
 * that forgot about it, because no code path sets one.
 */
export function panelsFor(state: WorkspaceState): WorkspacePanels {
  const { mode, overlays } = state;
  return {
    railOpen: mode === 'browse' || mode === 'place',
    railSource: mode === 'place' ? 'equipment' : state.browseSource,
    inspectorOpen: mode === 'inspect',
    toolDockOpen: mode === 'draw',
    createDialogOpen: mode === 'setup',
    refineRoomOpen: mode === 'room-layout',
    seatingOpen: overlays.includes('seating'),
    calculatorOpen: overlays.includes('calculator'),
    wallEditLive: mode === 'room-layout' || overlays.includes('wall-edit'),
    fullCanvas: mode === 'canvas' && overlays.length === 0,
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
      return 'Layouts · room-fitted kits and output';
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
  if (!facts.hasContent) return 'place';
  return 'canvas';
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
