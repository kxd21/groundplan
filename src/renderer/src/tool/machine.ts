/**
 * What the pointer will do with its next click. One value, and only one.
 *
 * This replaces eleven parallel cells in `App.tsx` — `armed`, `armedItem`,
 * `armedSeating`, `armedAnnotation`, `armGeneration`, `armedRef`, `drawTool`,
 * `drawFrom`, `dimensioning`, `dimensionFrom`, `measuring`, `measureFrom`,
 * `measurement` — plus `handTool` in `PlanCanvas`. Thirteen booleans encode at
 * most twelve legal states, so most representable states were illegal and every
 * writer had to remember to clear every other writer. Nobody did, and each bug
 * this subsystem produced was one specific illegal state somebody forgot to
 * exclude: a label still "pressed" while a rectangle was being drawn, a late
 * reply putting away a tool that had already been replaced, a start point
 * consumed twice while its dimension was in flight.
 *
 * The fix is not another guard. It is that a stamp and a span cannot both be
 * live, because that is not a value this type can hold; and that the held start
 * point lives *inside* the span holding it, so it cannot be read for the wrong
 * tool.
 *
 * No React and no DOM in this file, so `tools/tool-machine-test.ts` can drive
 * the whole subsystem without a renderer.
 */

export type PlanPoint = { x: number; y: number; nodeId?: number };

export type DrawShape = 'line' | 'rect' | 'ellipse';

/** The seating block a "Place on plan" hands over, opaque to this module. */
export type SeatingRequest = Record<string, unknown>;

/** One click makes one object. */
export type Stamp =
  | { what: 'gear'; description: string }
  | { what: 'inventory'; id: string; name: string }
  | { what: 'label'; text: string; color?: number }
  | { what: 'seating'; request: SeatingRequest; description: string }
  | { what: 'av-pair' };

/** Two clicks make one object, or one readout. */
export type Span =
  | { what: 'measure' }
  | { what: 'dimension' }
  | { what: 'draw'; shape: DrawShape };

/** A run of corners that closes into one room when the user finishes it. */
export type Path = { what: 'room' } | { what: 'cable'; name: string };

/**
 * The tool in hand.
 *
 * `from` belongs to the span holding it. There is one held start point in the
 * whole application and it cannot outlive the tool that took it.
 */
export type Tool =
  | { kind: 'select' }
  | { kind: 'direct-select' }
  | { kind: 'hand' }
  | { kind: 'stamp'; stamp: Stamp }
  | { kind: 'span'; span: Span; from: PlanPoint | null }
  | { kind: 'path'; path: Path; points: PlanPoint[]; closing: boolean };

/** A tool as named by a button, a palette row or a shortcut — before it is held. */
export type ToolChoice =
  | { kind: 'select' }
  | { kind: 'direct-select' }
  | { kind: 'hand' }
  | { kind: 'stamp'; stamp: Stamp }
  | { kind: 'span'; span: Span }
  | { kind: 'path'; path: Path };

/** What the open document permits. Checked once, here, not at each button. */
export type Capability = { open: boolean; editable: boolean };

export type Readout = { from: PlanPoint; to: PlanPoint };

export type ToolState = {
  tool: Tool;
  /**
   * Bumped by every event that changes what is in hand.
   *
   * Every effect carries the epoch current when it was minted, and a `settled`
   * quoting a stale epoch is ignored. This is the whole rule about late
   * replies, and it lives here rather than at the call sites, so no future
   * async path can forget it.
   */
  epoch: number;
  /** The completed measure readout; survives until the tool is put down. */
  readout: Readout | null;
  can: Capability;
};

export type ToolEvent =
  /** A palette row, a toolbar button or a shortcut names a tool. */
  | { type: 'pick'; choice: ToolChoice }
  /** The same, but naming the tool already in hand puts it down. */
  | { type: 'toggle'; choice: ToolChoice }
  /** A click on the sheet, already snapped and hit-tested per `pointerSpec`. */
  | { type: 'click'; at: PlanPoint }
  /** Closes a multi-point path and creates its object. */
  | { type: 'finish' }
  /** Removes the most recently clicked path corner. */
  | { type: 'undo-point' }
  | { type: 'escape' }
  /** The label field changed. Not an act of tool selection — see below. */
  | { type: 'retext'; text: string }
  /** A plan opened, or the workspace left. Everything goes down. */
  | { type: 'reset' }
  /** The document's permissions changed. */
  | { type: 'capability'; can: Capability }
  /** An effect finished. `epoch` is the one it was minted with. */
  | { type: 'settled'; epoch: number; ok: boolean };

export type ToolEffect =
  | { do: 'placeGear'; description: string; at: PlanPoint }
  | { do: 'placeInventory'; id: string; name: string; at: PlanPoint }
  | { do: 'placeLabel'; text: string; color?: number; at: PlanPoint }
  | { do: 'placeSeating'; request: SeatingRequest; at: PlanPoint }
  | { do: 'draw'; shape: DrawShape; from: PlanPoint; to: PlanPoint }
  | { do: 'createRoom'; points: PlanPoint[] }
  | { do: 'placeCable'; name: string; points: PlanPoint[] }
  | { do: 'placeAvPair'; at: PlanPoint }
  | { do: 'addDimension'; from: PlanPoint; to: PlanPoint }
  /** Local only — the temporary readout, which never reaches the file. */
  | { do: 'showReadout'; from: PlanPoint; to: PlanPoint };

export type PendingEffect = ToolEffect & { epoch: number };

export type Transition = {
  state: ToolState;
  effect: PendingEffect | null;
  /** Set when the event was refused; the caller shows it and nothing changed. */
  refusal?: string;
};

export function initialToolState(can: Capability = { open: false, editable: false }): ToolState {
  return { tool: { kind: 'select' }, epoch: 0, readout: null, can };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The identity a button presses.
 *
 * Two label stamps with different text are the same tool as far as the T button
 * is concerned, so `text` is deliberately not part of the id; a gear line and an
 * inventory item are told apart by their payload so a palette row can highlight
 * itself.
 */
export function choiceId(choice: ToolChoice): string {
  switch (choice.kind) {
    case 'select':
      return 'select';
    case 'direct-select':
      return 'direct-select';
    case 'hand':
      return 'hand';
    case 'stamp':
      switch (choice.stamp.what) {
        case 'gear':
          return `stamp:gear:${choice.stamp.description}`;
        case 'inventory':
          return `stamp:inventory:${choice.stamp.id}`;
        case 'label':
          return 'stamp:label';
        case 'seating':
          return 'stamp:seating';
        case 'av-pair':
          return 'stamp:av-pair';
      }
      break;
    case 'span':
      return choice.span.what === 'draw' ? `span:draw:${choice.span.shape}` : `span:${choice.span.what}`;
    case 'path':
      return choice.path.what === 'cable' ? `path:cable:${choice.path.name}` : 'path:room';
  }
  /* c8 ignore next */
  return 'select';
}

/** The tool in hand, expressed as the choice that would name it. */
export function toolChoice(tool: Tool): ToolChoice {
  return tool.kind === 'span' ? { kind: 'span', span: tool.span } : tool;
}

/**
 * Whether a toolbar control reads as on.
 *
 * Every `aria-pressed` and every `is-on` comes from here. It used to be
 * computed five different ways — `!!armedAnnotation` among them, which is why
 * the T button stayed lit forever once a draw tool cleared `armed` and left
 * `armedAnnotation` behind.
 */
export function isPressed(state: ToolState, choice: ToolChoice): boolean {
  return choiceId(toolChoice(state.tool)) === choiceId(choice);
}

/** Human wording for what is in hand, for the banner and for status lines. */
export function stampDescription(stamp: Stamp): string {
  switch (stamp.what) {
    case 'gear':
      return stamp.description;
    case 'inventory':
      return stamp.name;
    case 'label':
      return `label “${stamp.text}”`;
    case 'seating':
      return stamp.description;
    case 'av-pair':
      return 'screen + projector';
  }
}

/**
 * Whether the tool stays in hand after it has been used.
 *
 * A run of the same thing is the normal case, not the exception: fifty drape
 * sections, a row of risers, the same "X4S" call-out ten times down a real
 * sheet, a wall of dimensions — and sixteen theatre banks across a ballroom.
 * Those all stay in hand so a run is one trip to the palette rather than fifty.
 *
 * Room outline (`path`) is the deliberate one-shot: finishing the polygon puts
 * the tool down so the next click selects rather than adding another corner.
 */
export function staysAfterUse(tool: Tool): boolean {
  return tool.kind !== 'path';
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/**
 * Why a tool cannot be picked up right now, or null if it can.
 *
 * Annotation was once gated on `annotationCapabilities`, flags that are false
 * on any plan drawn from scratch — which disabled the label field and both
 * dimension buttons outright, a deadlock the tool could never unlock itself
 * from. The only real gate is whether the document can be edited, and it is
 * asked once, here.
 */
export function refusalFor(can: Capability, choice: ToolChoice): string | null {
  if (choice.kind === 'select' || choice.kind === 'hand') return null;
  if (choice.kind === 'direct-select') return can.open ? null : 'Open a plan first.';
  if (!can.open) return 'Open a plan first.';
  if (choice.kind === 'stamp' && choice.stamp.what === 'label' && !choice.stamp.text.trim()) {
    return 'Enter label text first.';
  }
  const needsEdit = choice.kind === 'stamp' || choice.kind === 'path' || choice.span.what !== 'measure';
  if (needsEdit && !can.editable) return 'This plan is read-only, so nothing can be added to it.';
  return null;
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

function held(choice: ToolChoice): Tool {
  if (choice.kind === 'span') return { kind: 'span', span: choice.span, from: null };
  if (choice.kind === 'path') return { kind: 'path', path: choice.path, points: [], closing: false };
  return choice;
}

/** Everything goes down. The only way to reach `select` with nothing held. */
function putDown(state: ToolState): ToolState {
  return { ...state, tool: { kind: 'select' }, epoch: state.epoch + 1, readout: null };
}

function take(state: ToolState, choice: ToolChoice): Transition {
  const refusal = refusalFor(state.can, choice);
  if (refusal) return { state, effect: null, refusal };
  // Note what is NOT here: no clearing of siblings, because there are none.
  return {
    state: { ...state, tool: held(choice), epoch: state.epoch + 1, readout: null },
    effect: null,
  };
}

/**
 * The whole subsystem. Total, pure, and the only place that decides who cancels
 * whom — which it does by replacing the value outright, so there is no such
 * thing as a partial disarm.
 */
export function reduce(state: ToolState, event: ToolEvent): Transition {
  switch (event.type) {
    case 'pick':
      return take(state, event.choice);

    case 'toggle':
      return isPressed(state, event.choice)
        ? { state: putDown(state), effect: null }
        : take(state, event.choice);

    case 'reset':
      return { state: putDown(state), effect: null };

    case 'capability': {
      const can = event.can;
      const next = { ...state, can };
      // A tool that is no longer permitted goes down rather than waiting to
      // fail at the IPC boundary.
      if (refusalFor(can, toolChoice(state.tool))) return { state: putDown(next), effect: null };
      return { state: next, effect: null };
    }

    case 'escape': {
      const tool = state.tool;
      // A mis-clicked corner must not cost the tool: the first Escape drops the
      // half-made span, the second puts the tool down.
      if (tool.kind === 'span' && tool.from) {
        return { state: { ...state, tool: { ...tool, from: null } }, effect: null };
      }
      // While tracing a room, Escape walks back one corner at a time. Once the
      // path is empty, the same key puts the tool down.
      if (tool.kind === 'path' && tool.points.length && !tool.closing) {
        return {
          state: { ...state, tool: { ...tool, points: tool.points.slice(0, -1) } },
          effect: null,
        };
      }
      if (tool.kind === 'select') return { state, effect: null };
      return { state: putDown(state), effect: null };
    }

    case 'undo-point': {
      const tool = state.tool;
      if (tool.kind !== 'path' || tool.closing || !tool.points.length) return { state, effect: null };
      return {
        state: { ...state, tool: { ...tool, points: tool.points.slice(0, -1) } },
        effect: null,
      };
    }

    case 'finish': {
      const tool = state.tool;
      if (tool.kind !== 'path') return { state, effect: null };
      if (tool.closing) return { state, effect: null };
      if (tool.path.what === 'cable') {
        if (tool.points.length < 2) {
          return { state, effect: null, refusal: 'Click at least two points for a cable run.' };
        }
        return {
          state: { ...state, tool: { ...tool, closing: true } },
          effect: {
            do: 'placeCable',
            name: tool.path.name,
            points: tool.points.map((point) => ({ ...point })),
            epoch: state.epoch,
          },
        };
      }
      if (tool.points.length < 3) {
        return { state, effect: null, refusal: 'Click at least three corners before finishing the room.' };
      }
      return {
        state: { ...state, tool: { ...tool, closing: true } },
        effect: { do: 'createRoom', points: tool.points.map((point) => ({ ...point })), epoch: state.epoch },
      };
    }

    case 'retext': {
      // Typing is not an act of tool selection. Under the old shape a keystroke
      // re-armed the label without clearing `drawTool`, so `armed` and a draw
      // tool were both live and clicks drew rectangles while the banner
      // promised a label. Here, typing while anything else is in hand does
      // nothing at all.
      const tool = state.tool;
      if (tool.kind !== 'stamp' || tool.stamp.what !== 'label') return { state, effect: null };
      const text = event.text.trim();
      if (!text) return { state: putDown(state), effect: null };
      if (text === tool.stamp.text) return { state, effect: null };
      return {
        state: { ...state, tool: { kind: 'stamp', stamp: { ...tool.stamp, text } }, epoch: state.epoch + 1 },
        effect: null,
      };
    }

    case 'settled': {
      // The generalisation of `armGeneration`: a reply that has outlived its
      // tool keeps its hands off whatever is in hand now. This used to guard
      // one tool kind — the one that had been observed to break — and every
      // other async path went unguarded.
      if (event.epoch !== state.epoch) return { state, effect: null };
      if (!event.ok) {
        return state.tool.kind === 'path'
          ? { state: { ...state, tool: { ...state.tool, closing: false } }, effect: null }
          : { state, effect: null };
      }
      if (staysAfterUse(state.tool)) return { state, effect: null };
      return { state: putDown(state), effect: null };
    }

    case 'click': {
      const tool = state.tool;
      if (tool.kind === 'select' || tool.kind === 'direct-select' || tool.kind === 'hand') {
        return { state, effect: null };
      }

      if (tool.kind === 'stamp') {
        return { state, effect: { ...stampEffect(tool.stamp, event.at), epoch: state.epoch } };
      }

      if (tool.kind === 'path') {
        if (tool.closing) return { state, effect: null };
        const previous = tool.points.at(-1);
        if (previous && Math.hypot(previous.x - event.at.x, previous.y - event.at.y) <= 1) {
          return { state, effect: null };
        }
        // Click near the first corner (with enough points) closes the outline —
        // the same gesture CAD users expect for a polygon.
        //
        // ROOMS ONLY. This branch did not look at what was being drawn, and the
        // path tool draws cable runs too: routing a power run back past its own
        // start — a return leg, which is most of what cable routing is — fired
        // `createRoom`, threw the cable away and built a room out of it. Two
        // feet is also a normal gap between cable vertices, so it did not take
        // an unusual drawing to hit.
        const first = tool.points[0];
        // 2 feet — hittable when the room is fitted on screen, without stealing
        // ordinary far corners. createPolygonalRoom still collapses a near-duplicate end.
        const closeTol = 2 * 120;
        if (
          tool.path.what === 'room' &&
          first &&
          tool.points.length >= 3 &&
          Math.hypot(first.x - event.at.x, first.y - event.at.y) <= closeTol
        ) {
          return {
            state: { ...state, tool: { ...tool, closing: true } },
            effect: { do: 'createRoom', points: tool.points.map((point) => ({ ...point })), epoch: state.epoch },
          };
        }
        return {
          state: { ...state, tool: { ...tool, points: [...tool.points, event.at] } },
          effect: null,
        };
      }

      // The span. The held point is consumed in this one synchronous step, so
      // it is gone before the caller has an `await` to lose it across. Clicks
      // that arrive while the edit is in flight open a fresh pair; they cannot
      // draw a second thing from a start point that has already been used.
      if (!tool.from) {
        return { state: { ...state, tool: { ...tool, from: event.at } }, effect: null };
      }
      const from = tool.from;
      const to = event.at;
      const cleared: ToolState = { ...state, tool: { ...tool, from: null } };
      if (tool.span.what === 'measure') {
        return {
          state: { ...cleared, readout: { from, to } },
          effect: { do: 'showReadout', from, to, epoch: state.epoch },
        };
      }
      if (tool.span.what === 'dimension') {
        return { state: cleared, effect: { do: 'addDimension', from, to, epoch: state.epoch } };
      }
      return {
        state: cleared,
        effect: { do: 'draw', shape: tool.span.shape, from, to, epoch: state.epoch },
      };
    }
  }
  /* c8 ignore next */
  return { state, effect: null };
}

function stampEffect(stamp: Stamp, at: PlanPoint): ToolEffect {
  switch (stamp.what) {
    case 'gear':
      return { do: 'placeGear', description: stamp.description, at };
    case 'inventory':
      return { do: 'placeInventory', id: stamp.id, name: stamp.name, at };
    case 'label':
      return { do: 'placeLabel', text: stamp.text, color: stamp.color, at };
    case 'seating':
      return { do: 'placeSeating', request: stamp.request, at };
    case 'av-pair':
      return { do: 'placeAvPair', at };
  }
}

// ---------------------------------------------------------------------------
// Projections — the single source for everything rendered
// ---------------------------------------------------------------------------

export type PointerSpec = {
  mode: 'select' | 'direct-select' | 'pan' | 'stamp' | 'span' | 'path';
  /** Whether the click coordinate is rounded to the drawing's snap step. */
  snap: 'grid' | 'none';
  /** Whether the raw click is hit-tested for an object to associate with. */
  associate: boolean;
  /** What the canvas rubber-bands while a span is half-made. */
  preview: 'none' | 'measure' | 'room' | 'cable' | DrawShape;
  /** Which half of a pair the next click completes; spans only. */
  parity?: 'start' | 'end';
};

/**
 * How the canvas should read the next click.
 *
 * The snap/associate table is inherited from `PlanCanvas.onPointerDown` rather
 * than designed here: measure does not grid-snap while dimension does, and both
 * hit-test the raw click before snapping so an endpoint can follow the object
 * it was placed on. The first of those looks deliberate — a measurement should
 * report what is actually there — but it was asserted nowhere, so it is pinned
 * here as behaviour, not doctrine.
 */
export function pointerSpec(state: ToolState): PointerSpec {
  const tool = state.tool;
  switch (tool.kind) {
    case 'select':
      return { mode: 'select', snap: 'grid', associate: false, preview: 'none' };
    case 'direct-select':
      return { mode: 'direct-select', snap: 'none', associate: false, preview: 'none' };
    case 'hand':
      return { mode: 'pan', snap: 'none', associate: false, preview: 'none' };
    case 'stamp':
      return { mode: 'stamp', snap: 'grid', associate: false, preview: 'none' };
    case 'path':
      // A cable run is an open polyline. Previewing it as a room drew a filled
      // floor and a dashed leg closing back to the start, so routing a cable
      // looked like drawing a room and read as one.
      return {
        mode: 'path',
        snap: 'grid',
        associate: false,
        preview: tool.path.what === 'cable' ? 'cable' : 'room',
      };
    case 'span': {
      const parity = tool.from ? 'end' : 'start';
      if (tool.span.what === 'measure') {
        return { mode: 'span', snap: 'none', associate: true, preview: 'measure', parity };
      }
      if (tool.span.what === 'dimension') {
        return { mode: 'span', snap: 'grid', associate: true, preview: 'measure', parity };
      }
      return { mode: 'span', snap: 'grid', associate: true, preview: tool.span.shape, parity };
    }
  }
}

export type BannerAction =
  /** Put the tool down. */
  | { id: 'done'; label: string }
  /** Put down a stamp and hand off to edit / repeat. */
  | { id: 'finish-place'; label: string; primary: true }
  /** Remove the last corner from a multi-point room outline. */
  | { id: 'undo-point'; label: string }
  /** Close and create a multi-point room outline. */
  | { id: 'finish-room'; label: string; primary: true }
  /** Keep the temporary readout as a real plan dimension. */
  | { id: 'save-dimension'; label: string; primary: true };

export type Banner = {
  badge: { text: string; tone: 'temporary' | 'persistent' } | null;
  message: string;
  /** Rendered in `<strong>` after the message; the thing being placed. */
  emphasis?: string;
  actions: BannerAction[];
};

/**
 * The one overlay over the sheet.
 *
 * There used to be two, rendered from different cells, and both could be on
 * screen at once saying different things. Its container keeps
 * `pointer-events: none` with its own buttons opting back in — a click
 * swallowed by an informational overlay silently flips the parity of every
 * pair after it, and `tools/tool-machine-test.ts` guards that.
 */
export function banner(state: ToolState): Banner | null {
  const tool = state.tool;
  if (tool.kind === 'select' || tool.kind === 'hand') return null;
  if (tool.kind === 'direct-select') {
    return {
      badge: { text: 'Edit points', tone: 'persistent' },
      message: 'Select an item, then drag an anchor or enter exact point coordinates in Properties',
      actions: [{ id: 'done', label: 'Done' }],
    };
  }
  if (tool.kind === 'stamp') {
    return {
      badge: { text: 'Placing', tone: 'persistent' },
      message: 'Click the plan to place ',
      emphasis: stampDescription(tool.stamp),
      actions: [
        { id: 'finish-place', label: 'Done placing', primary: true },
        { id: 'done', label: 'Cancel' },
      ],
    };
  }
  if (tool.kind === 'path') {
    const count = tool.points.length;
    if (tool.path.what === 'cable') {
      return {
        badge: { text: tool.path.name, tone: 'persistent' },
        message: tool.closing
          ? 'Creating the run…'
          : count === 0
            ? 'Click the start of the cable / power run'
            : count === 1
              ? '1 point · click the next bend or end'
              : `${count} points · Enter or Finish to place`,
        actions: tool.closing
          ? []
          : [
              ...(count >= 2
                ? [{ id: 'finish-room' as const, label: 'Finish run', primary: true as const }]
                : []),
              ...(count ? [{ id: 'undo-point' as const, label: 'Undo point' }] : []),
              { id: 'done', label: 'Cancel' },
            ],
      };
    }
    return {
      badge: { text: 'Room outline', tone: 'persistent' },
      message: tool.closing
        ? 'Creating the room…'
        : count === 0
          ? 'Click the first corner of the room'
          : count < 3
            ? `${count} corner${count === 1 ? '' : 's'} · add ${3 - count} more`
            : `${count} corners · outline ready`,
      actions: tool.closing
        ? []
        : [
            ...(count >= 3 ? [{ id: 'finish-room' as const, label: 'Finish room', primary: true as const }] : []),
            ...(count ? [{ id: 'undo-point' as const, label: 'Undo point' }] : []),
            { id: 'done', label: 'Cancel' },
          ],
    };
  }
  const done: BannerAction = { id: 'done', label: 'Done' };
  if (tool.span.what === 'measure') {
    return {
      badge: { text: 'Temporary measure', tone: 'temporary' },
      message: tool.from
        ? 'Click the second point'
        : state.readout
          ? 'Review the distance, save it, or click to start another'
          : 'Click the first point to measure from',
      actions: state.readout
        ? [{ id: 'save-dimension', label: 'Save dimension', primary: true }, done]
        : [done],
    };
  }
  if (tool.span.what === 'dimension') {
    return {
      badge: { text: 'Saved dimension', tone: 'persistent' },
      message: tool.from ? 'Click the dimension end point' : 'Click the dimension start point',
      actions: [done],
    };
  }
  const shape = tool.span.shape;
  return {
    badge: { text: shape === 'rect' ? 'Rectangle' : shape === 'ellipse' ? 'Ellipse' : 'Line', tone: 'persistent' },
    message:
      shape === 'line'
        ? tool.from
          ? 'Click the end point'
          : 'Click the start point'
        : tool.from
          ? 'Click the opposite corner'
          : 'Click the first corner',
    actions: [done],
  };
}

/**
 * Whether a fresh selection should pull the inspector over to Properties.
 *
 * It should when you clicked an object — that is what you asked to look at. It
 * must not while a tool is in hand: the panel you are working in is the one you
 * are placing from, and yanking it away mid-run tears the text field out from
 * under whatever you were typing. The old rule tested only "is a stamp armed",
 * so drawing a rectangle still yanked the panel.
 */
export function opensProperties(selectedCount: number, state: ToolState): boolean {
  return selectedCount > 0 && (state.tool.kind === 'select' || state.tool.kind === 'direct-select');
}

/** With nothing in hand, Escape is about the selection instead. */
export function escapeAlsoClearsSelection(state: ToolState): boolean {
  return state.tool.kind === 'select';
}

// ---------------------------------------------------------------------------
// Shorthand for the choices named by fixed controls
// ---------------------------------------------------------------------------

export const SELECT: ToolChoice = { kind: 'select' };
export const DIRECT_SELECT: ToolChoice = { kind: 'direct-select' };
export const HAND: ToolChoice = { kind: 'hand' };
export const MEASURE: ToolChoice = { kind: 'span', span: { what: 'measure' } };
export const DIMENSION: ToolChoice = { kind: 'span', span: { what: 'dimension' } };
export const drawChoice = (shape: DrawShape): ToolChoice => ({ kind: 'span', span: { what: 'draw', shape } });
export const roomOutlineChoice: ToolChoice = { kind: 'path', path: { what: 'room' } };
export const powerCableChoice: ToolChoice = {
  kind: 'path',
  path: { what: 'cable', name: 'Power run' },
};
export const signalCableChoice: ToolChoice = {
  kind: 'path',
  path: { what: 'cable', name: 'Signal run' },
};
export const avPairChoice: ToolChoice = { kind: 'stamp', stamp: { what: 'av-pair' } };
export const labelChoice = (text: string, color?: number): ToolChoice => ({
  kind: 'stamp',
  stamp: { what: 'label', text, color },
});
