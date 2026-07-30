/**
 * The Room tab: the room, what it seats, what is built on it.
 *
 * Everything here is driven by the model in the main process, and the split is
 * deliberate. Solving a seating layout is cheap and changes nothing, so the
 * count updates as the numbers are typed and the user sees what a six-foot
 * cross aisle costs *before* four hundred chairs land on the drawing. Only
 * "Place" mutates anything.
 *
 * Measurements are typed, not spun. People say `40'`, `12' 6"`, `3.6m` — a
 * numeric stepper in tenths of an inch would be useless — so every size field
 * takes text and parses it, and holds its last good value when the text is
 * mid-edit and does not parse yet.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PlanModelView, SeatingPreview } from '../../main/plan-model.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import type { Doc } from './App.js';
import { IconPlus, IconRuler, IconWarning } from './icons.js';

const api = window.groundplan;

interface Props {
  doc: Doc;
  onDoc: (doc: Doc) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onSelect: (ids: number[]) => void;
}

/**
 * A text field holding a measurement.
 *
 * Keeps the raw text so a half-typed `12'` is not fought with, and reports the
 * parsed value only when there is one.
 */
function useLength(initial: number, units: UnitSystem): {
  text: string;
  setText: (value: string) => void;
  value: number | null;
  /** The text is a measurement. Zero counts — "no centre aisle" is an answer. */
  valid: boolean;
  /** It is also a size, which is what a width or a depth has to be. */
  positive: boolean;
} {
  const [text, setText] = useState(() => formatLength(initial, units));

  // Switching the unit system rewrites the box, which is the whole point of
  // the toggle: the same measurement, said the other way.
  useEffect(() => {
    setText((current) => {
      const parsed = parseLength(current, units === 'metric' ? 'imperial' : 'metric');
      return parsed == null ? current : formatLength(parsed, units);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  const value = parseLength(text, units);
  return { text, setText, value, valid: value != null, positive: value != null && value > 0 };
}

function LengthField({
  id,
  label,
  field,
  disabled,
}: {
  id: string;
  label: string;
  field: ReturnType<typeof useLength>;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="text"
        value={field.text}
        disabled={disabled}
        aria-invalid={field.text.trim() !== '' && !field.valid}
        onChange={(e) => field.setText(e.target.value)}
      />
    </div>
  );
}

export default function RoomPanel({ doc, onDoc, onStatus, onError, onSelect }: Props) {
  const [model, setModel] = useState<PlanModelView | null>(null);
  const [busy, setBusy] = useState(false);
  const units: UnitSystem = model?.units ?? 'imperial';

  const refresh = useCallback(async () => {
    setModel(await api.planModel());
  }, []);

  // The model is derived from the document, so it is re-read whenever the
  // document changes rather than kept in step by hand.
  useEffect(() => {
    let cancelled = false;
    void api.planModel().then((next) => {
      if (!cancelled) setModel(next);
    });
    return () => {
      cancelled = true;
    };
  }, [doc.revision, doc.path]);

  /** Runs an edit, folds the new document back in, and reports the outcome. */
  const run = useCallback(
    async (
      what: string,
      call: () => Promise<{ ok: boolean; reason?: string; note?: string; doc?: unknown; created?: number[] }>,
    ) => {
      setBusy(true);
      try {
        const reply = await call();
        if (!reply.ok) {
          onError(reply.reason ?? `${what} failed`);
          return false;
        }
        if (reply.doc) onDoc(reply.doc as Doc);
        if (reply.created?.length) onSelect(reply.created);
        onStatus(reply.note ? `${what}. ${reply.note}` : what);
        await refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [onDoc, onError, onSelect, onStatus, refresh],
  );

  const room = model?.room ?? null;
  const editable = doc.editable && !busy;

  // ---- Room ---------------------------------------------------------------
  const width = useLength(40 * 120, units);
  const depth = useLength(30 * 120, units);

  // ---- Reshape / curve ----------------------------------------------------
  const [reshapeOp, setReshapeOp] = useState<'union' | 'difference'>('union');
  const reshapeX = useLength(0, units);
  const reshapeY = useLength(0, units);
  const reshapeW = useLength(10 * 120, units);
  const reshapeD = useLength(10 * 120, units);
  const [curveWall, setCurveWall] = useState(0);
  const curveRadius = useLength(20 * 120, units);
  const wallLengthField = useLength(40 * 120, units);
  const [curveOtherWay, setCurveOtherWay] = useState(false);
  const [curveMajor, setCurveMajor] = useState(false);

  // Seed reshape origin from the room once per open plan, so "Add area"
  // starts beside the current outline rather than at the origin.
  const [reshapeSeeded, setReshapeSeeded] = useState(false);
  useEffect(() => {
    setReshapeSeeded(false);
  }, [doc.path]);
  useEffect(() => {
    if (!room || reshapeSeeded) return;
    reshapeX.setText(formatLength(room.x + room.width, units));
    reshapeY.setText(formatLength(room.y, units));
    setReshapeSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, units, reshapeSeeded]);

  useEffect(() => {
    const detail = room?.wallDetails?.[curveWall];
    if (!detail) return;
    wallLengthField.setText(detail.lengthText);
    if (detail.curved && detail.radius > 0) {
      curveRadius.setText(detail.radiusText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curveWall, room?.wallDetails]);

  // After reshape, wall count can shrink — keep the picker on a real wall.
  useEffect(() => {
    const count = room?.wallDetails?.length ?? 0;
    if (count === 0) return;
    if (curveWall >= count) setCurveWall(0);
  }, [room?.wallDetails, curveWall]);

  // ---- Seating ------------------------------------------------------------
  const [style, setStyle] = useState('theatre');
  const [chair, setChair] = useState('');
  const [table, setTable] = useState('');
  const [stagger, setStagger] = useState(true);
  const [splay, setSplay] = useState(0);
  const [rowsPerBlock, setRowsPerBlock] = useState(0);
  const seatSpacing = useLength(20 * 10, units);
  const rowSpacing = useLength(36 * 10, units);
  const frontClearance = useLength(8 * 120, units);
  const centreAisle = useLength(0, units);
  const [preview, setPreview] = useState<SeatingPreview | null>(null);

  const styleInfo = model?.seatingStyles.find((s) => s.id === style);
  const needsTable = styleInfo?.needsTable ?? false;

  // The stage is where the audience looks; default it to the middle of the
  // room's front edge, which is where one goes nine times out of ten.
  const focus = useMemo(() => {
    const extent = doc.scene.roomExtent;
    if (!extent) return { x: 0, y: 0 };
    return { x: (extent.minX + extent.maxX) / 2, y: extent.minY - 6 * 120 };
  }, [doc.scene.roomExtent]);

  const seatingRequest = useMemo(
    () => ({
      style: style as never,
      focusX: focus.x,
      focusY: focus.y,
      seatSpacing: seatSpacing.value ?? undefined,
      rowSpacing: rowSpacing.value ?? undefined,
      front: frontClearance.value ?? undefined,
      centreAisle: centreAisle.value ?? 0,
      rowsPerBlock,
      stagger,
      splay,
    }),
    [style, focus.x, focus.y, seatSpacing.value, rowSpacing.value, frontClearance.value, centreAisle.value, rowsPerBlock, stagger, splay],
  );

  // Live count. Solving is pure and cheap, so this runs on every change —
  // seeing the cost of a wider aisle is the point of the panel.
  useEffect(() => {
    let cancelled = false;
    if (!room) {
      setPreview(null);
      return;
    }
    void api.seatingPreview(seatingRequest).then((result) => {
      if (!cancelled) setPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [room, seatingRequest]);

  // ---- Stage --------------------------------------------------------------
  const stageWidth = useLength(24 * 120, units);
  const stageDepth = useLength(16 * 120, units);
  const stageHeight = useLength(24 * 10, units);

  const names = doc.scene.inventory.map((i) => i.name);

  if (!model) {
    return (
      <div className="section">
        <p className="hint">Open a plan to see its room.</p>
      </div>
    );
  }

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Room</span>
        </div>

        {room ? (
          <>
            <dl className="prop-grid">
              <dt>Size</dt>
              <dd>{room.sizeText}</dd>
              <dt>Floor area</dt>
              <dd>{room.areaText}</dd>
              <dt>Perimeter</dt>
              <dd>{room.perimeterText}</dd>
              <dt>Walls</dt>
              <dd>
                {room.walls}
                {room.curved > 0 && `, ${room.curved} curved`}
                {room.holes > 0 && `, ${room.holes} cut-out${room.holes === 1 ? '' : 's'}`}
              </dd>
            </dl>

            {room.source === 'extent' && (
              <div className="notice" role="status">
                <IconWarning size={14} />
                <span>
                  No wall outline could be traced, so this is the extent of the drawing. Treat the area as an
                  over-estimate.
                </span>
              </div>
            )}
            {room.problems.map((problem) => (
              <div className="notice" role="status" key={problem}>
                <IconWarning size={14} />
                <span>{problem}</span>
              </div>
            ))}
          </>
        ) : (
          <p className="hint">This plan has no room outline yet. Draw one below and everything else follows from it.</p>
        )}

        {model.companion.freshness === 'stale' && model.companion.reason && (
          <div className="notice" role="status">
            <IconWarning size={14} />
            <span>{model.companion.reason}</span>
          </div>
        )}

        <div className="field-row">
          <LengthField id="room-width" label="Width" field={width} disabled={!editable} />
          <LengthField id="room-depth" label="Depth" field={depth} disabled={!editable} />
        </div>
        <div className="actions-row">
          <button
            onClick={() =>
              void run('Room drawn', () => api.roomCreate(width.value!, depth.value!))
            }
            disabled={!editable || !width.positive || !depth.positive}
            title={doc.editable ? 'Draw a rectangular room' : 'This plan is open read-only'}
          >
            <IconPlus size={14} />
            {room && room.source === 'companion' ? 'Redraw room' : 'Draw room'}
          </button>
          <button
            onClick={() => void run('Room dimensioned', () => api.roomDimension())}
            disabled={!editable || !room}
            title="Add a dimension to every wall"
          >
            <IconRuler size={14} />
            Dimension
          </button>
        </div>
        <p className="hint">
          Drawing a room again moves the walls it drew before rather than adding a second set. Curved walls are drawn
          as polylines a hundredth of an inch off the true arc.
        </p>
      </div>

      {room && (
        <div className="section">
          <div className="section-title">
            <span>Shape</span>
          </div>

          <div className="seg tabs seat-kinds" role="tablist" aria-label="Reshape operation">
            <button
              type="button"
              className={reshapeOp === 'union' ? 'active' : ''}
              onClick={() => setReshapeOp('union')}
              disabled={!editable}
            >
              Add area
            </button>
            <button
              type="button"
              className={reshapeOp === 'difference' ? 'active' : ''}
              onClick={() => setReshapeOp('difference')}
              disabled={!editable}
            >
              Cut out
            </button>
          </div>

          <div className="field-row">
            <LengthField id="reshape-x" label="X" field={reshapeX} disabled={!editable} />
            <LengthField id="reshape-y" label="Y" field={reshapeY} disabled={!editable} />
          </div>
          <div className="field-row">
            <LengthField id="reshape-w" label="Width" field={reshapeW} disabled={!editable} />
            <LengthField id="reshape-d" label="Depth" field={reshapeD} disabled={!editable} />
          </div>
          <div className="actions-row">
            <button
              type="button"
              onClick={() =>
                void run(reshapeOp === 'union' ? 'Area added' : 'Cut-out applied', () =>
                  api.roomReshape(
                    reshapeOp,
                    reshapeX.value!,
                    reshapeY.value!,
                    reshapeW.value!,
                    reshapeD.value!,
                  ),
                )
              }
              disabled={
                !editable ||
                !reshapeX.valid ||
                !reshapeY.valid ||
                !reshapeW.positive ||
                !reshapeD.positive
              }
              title={
                reshapeOp === 'union'
                  ? 'Union a rectangle into the room outline'
                  : 'Subtract a rectangle (corridor, column pocket, L-cut)'
              }
            >
              <IconPlus size={14} />
              {reshapeOp === 'union' ? 'Add to room' : 'Cut from room'}
            </button>
          </div>

          <div className="field-row" style={{ marginTop: 12 }}>
            <div className="field">
              <label htmlFor="curve-wall">Wall</label>
              <select
                id="curve-wall"
                value={curveWall}
                onChange={(e) => setCurveWall(Number(e.target.value))}
                disabled={!editable || !(room.wallDetails?.length)}
              >
                {(room.wallDetails ?? []).map((wall) => (
                  <option key={wall.index} value={wall.index}>
                    Wall {wall.index + 1} · {wall.lengthText}
                    {wall.curved ? ` · R ${wall.radiusText}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <LengthField id="wall-length" label="Length" field={wallLengthField} disabled={!editable} />
          </div>
          <div className="actions-row">
            <button
              type="button"
              onClick={() =>
                void run('Wall length set', () => api.roomWallLength(curveWall, wallLengthField.value!))
              }
              disabled={!editable || !wallLengthField.positive || !(room.wallDetails?.length)}
              title="Set this wall's length, keeping its start corner fixed"
            >
              Set length
            </button>
          </div>

          <div className="field-row" style={{ marginTop: 12 }}>
            <LengthField id="curve-radius" label="Radius" field={curveRadius} disabled={!editable} />
          </div>
          <label className="setting-check">
            <input
              type="checkbox"
              checked={curveOtherWay}
              disabled={!editable}
              onChange={(e) => setCurveOtherWay(e.target.checked)}
            />
            <span>Bow the other way</span>
          </label>
          <label className="setting-check">
            <input
              type="checkbox"
              checked={curveMajor}
              disabled={!editable}
              onChange={(e) => setCurveMajor(e.target.checked)}
            />
            <span>Long way round (major arc)</span>
          </label>
          <div className="actions-row">
            <button
              type="button"
              onClick={() => {
                const radius = curveRadius.value!;
                const signed = curveOtherWay ? -Math.abs(radius) : Math.abs(radius);
                void run('Wall curved', () => api.roomCurve(curveWall, signed, curveMajor));
              }}
              disabled={!editable || !curveRadius.positive || !(room.wallDetails?.length)}
              title="Bow the selected wall to this radius"
            >
              Curve wall
            </button>
            <button
              type="button"
              onClick={() => void run('Wall straightened', () => api.roomCurve(curveWall, 0))}
              disabled={!editable || !(room.wallDetails?.length)}
              title="Remove the curve from this wall"
            >
              Straighten
            </button>
          </div>
          <p className="hint">
            Add or cut rectangles to make L-shapes and corridors. Set a wall length before curving it.
            Radius must be at least half the wall length for a gentle bay.
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {room && (
        <div className="section">
          <div className="section-title">
            <span>Capacity</span>
          </div>
          <table className="capacity-table">
            <thead>
              <tr>
                <th>Layout</th>
                <th>People</th>
                <th>Each</th>
              </tr>
            </thead>
            <tbody>
              {room.capacities.map((c) => (
                <tr key={c.layout}>
                  <td>{c.layout}</td>
                  <td>{c.low === c.high ? c.low : `${c.low}–${c.high}`}</td>
                  <td>{c.squareFeetEach} sq ft</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Estimated from usable floor area. This is not an occupancy figure — that depends on exits and local code.
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Seating</span>
          {preview && (
            <span className="section-count">
              {preview.seats} seat{preview.seats === 1 ? '' : 's'}
              {preview.tables > 0 && `, ${preview.tables} table${preview.tables === 1 ? '' : 's'}`}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="seat-style">Layout</label>
          <select id="seat-style" value={style} onChange={(e) => setStyle(e.target.value)} disabled={!editable}>
            {model.seatingStyles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field-row">
          <LengthField id="seat-spacing" label="Seat spacing" field={seatSpacing} disabled={!editable} />
          <LengthField id="row-spacing" label="Row spacing" field={rowSpacing} disabled={!editable} />
        </div>
        <div className="field-row">
          <LengthField id="front-clearance" label="Front clearance" field={frontClearance} disabled={!editable} />
          <LengthField id="centre-aisle" label="Centre aisle" field={centreAisle} disabled={!editable} />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="rows-per-block">Rows per block</label>
            <input
              id="rows-per-block"
              type="number"
              min={0}
              max={60}
              value={rowsPerBlock}
              disabled={!editable}
              onChange={(e) => setRowsPerBlock(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div className="field">
            <label htmlFor="splay">Bank splay °</label>
            <input
              id="splay"
              type="number"
              min={0}
              max={60}
              value={splay}
              disabled={!editable}
              onChange={(e) => setSplay(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
            />
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={stagger} disabled={!editable} onChange={(e) => setStagger(e.target.checked)} />
          Stagger alternate rows
        </label>

        <div className="field">
          <label htmlFor="seat-chair-name">Chair</label>
          <select id="seat-chair-name" value={chair} onChange={(e) => setChair(e.target.value)} disabled={!editable}>
            <option value="">Choose…</option>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {needsTable && (
          <div className="field">
            <label htmlFor="seat-table-name">Table</label>
            <select id="seat-table-name" value={table} onChange={(e) => setTable(e.target.value)} disabled={!editable}>
              <option value="">Choose…</option>
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}

        {preview?.notes.map((note) => (
          <p className="hint" key={note}>
            {note}
          </p>
        ))}

        <div className="actions-row">
          <button
            onClick={() =>
              void run(`Seating placed`, () => api.seatingApply(seatingRequest, chair, table || undefined))
            }
            disabled={!editable || !room || !chair || (needsTable && !table) || !preview?.seats}
            title={
              !room
                ? 'Draw a room first'
                : !chair
                  ? 'Choose a chair to place'
                  : 'Place this layout, replacing the last one'
            }
          >
            <IconPlus size={14} />
            Place seating
          </button>
        </div>
        <p className="hint">
          The count above is what the room will actually take — seats that fall outside the walls, inside a column or on
          reserved floor are left out. Placing again replaces the previous layout.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Stage</span>
        </div>
        <div className="field-row">
          <LengthField id="stage-width" label="Width" field={stageWidth} disabled={!editable} />
          <LengthField id="stage-depth" label="Depth" field={stageDepth} disabled={!editable} />
        </div>
        <LengthField id="stage-height" label="Deck height" field={stageHeight} disabled={!editable} />

        <div className="actions-row">
          <button
            onClick={() =>
              void run('Stage added', () =>
                api.stageAdd(
                  focus.x - (stageWidth.value ?? 0) / 2,
                  focus.y,
                  stageWidth.value!,
                  stageDepth.value!,
                  stageHeight.value!,
                ),
              )
            }
            disabled={!editable || !stageWidth.positive || !stageDepth.positive}
            title="Build a stage from stock decks"
          >
            <IconPlus size={14} />
            Add stage
          </button>
        </div>

        {model.stage && (
          <>
            <table className="capacity-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {model.stage.buildList.map((line) => (
                  <tr key={line.item}>
                    <td>
                      {line.item}
                      {line.detail && <span className="muted"> — {line.detail}</span>}
                    </td>
                    <td>{line.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {model.stage.warnings.map((warning) => (
              <div className="notice" role="status" key={warning}>
                <IconWarning size={14} />
                <span>{warning}</span>
              </div>
            ))}
          </>
        )}
        <p className="hint">
          The stage is drawn as one object whose outline shows every deck, so the layout is visible and it still moves
          and counts as a single item. Its floor is taken out of the seating count.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Report</span>
        </div>
        <p className="hint">
          The room, its capacity, the seating, the stage build list and the legend, as one document.
        </p>
        <div className="actions-row">
          <button
            onClick={async () => {
              const reply = await api.reportExport({
                units,
                scale: '1/8" = 1\'',
                seating: room ? seatingRequest : undefined,
              });
              if (reply.cancelled) return;
              if (!reply.ok) onError(reply.reason ?? 'the report could not be written');
              else onStatus(`Report saved to ${reply.path}`);
            }}
            disabled={busy}
          >
            Export report…
          </button>
        </div>
      </div>
    </>
  );
}
