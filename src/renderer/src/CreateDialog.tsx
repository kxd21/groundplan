import { useEffect, useRef, useState, type RefObject } from 'react';

import DockTitlebar from './DockTitlebar.js';
import ShowSetupPanel, { type PlanIdentityFields, type ShowKitInfo } from './ShowSetupPanel.js';
import { IconPlus } from './icons.js';

type SeatKind = 'round' | 'theatre' | 'schoolroom';

interface InventoryItem {
  name: string;
  category?: string | null;
}

export interface BankPresetInfo {
  id: string;
  name: string;
  savedAt: string;
  block: {
    chair?: string;
    angleDeg?: number;
    seatSpacingFt?: number;
    rowSpacingFt?: number;
    rowLengths?: number[];
    rows?: number;
    perRow?: number;
  };
}

interface Props {
  open: boolean;
  /** Side panel that leaves the canvas clickable (stamp seating without closing). */
  docked?: boolean;
  editable: boolean;
  hasRoom: boolean;
  drawingRoomOutline: boolean;
  identity: PlanIdentityFields;
  selectedCount: number;
  identityBusy: boolean;
  /** Live room size including ceiling when known. */
  roomSizeText?: string | null;
  completed: {
    stage?: boolean;
    insert?: boolean;
    repeat?: boolean;
    seating?: boolean;
    print?: boolean;
  };
  /** @deprecated Drawing chrome moved to Draw mode — kept optional for callers. */
  canCreateLabel?: boolean;
  canCreateDimension?: boolean;
  textActive?: boolean;
  annotationDraft?: string;
  annotationColor?: string;
  platform?: string;
  styleHint?: string | null;
  annotationInputRef?: RefObject<HTMLTextAreaElement | null>;
  dimensionActive?: boolean;
  inventory: InventoryItem[];
  seatKind: SeatKind;
  seatTable: string;
  seatChair: string;
  seatCount: number;
  seatRows: number;
  seatPerRow: number;
  /** Block rotation in degrees for theatre / classroom stamps (e.g. ±30 for wings). */
  seatAngle: number;
  /** Centre-to-centre seat spacing in feet (theatre / classroom). */
  seatSpacingFt: number;
  /** Front-to-back row spacing in feet (theatre / classroom). */
  seatRowSpacingFt: number;
  /**
   * Optional comma-separated seats-per-row for irregular theatre banks
   * (e.g. `13,13,14,14,14,14,13,13,13,13,13`). Empty = uniform per-row.
   */
  seatRowLengths: string;
  seatingArmed?: boolean;
  onClose: () => void;
  onSaveIdentity: (next: PlanIdentityFields) => void | Promise<void>;
  onOpenRoom: () => void;
  onDrawRoomOutline: () => void;
  onOpenBackground?: () => void;
  hasBackground?: boolean;
  onFinishRoomAsRectangle?: () => void;
  onDiscardEmptyPlan?: () => void;
  onBuildStage: () => void;
  onInsert: () => void;
  onRepeat: () => void;
  onSeating: () => void;
  onPrint: () => void;
  onText?: (next: string) => void;
  onColor?: (next: string) => void;
  onStartText?: () => void;
  onDoneText?: () => void;
  onToggleDimension?: () => void;
  onSeatKind: (kind: SeatKind) => void;
  onSeatTable: (value: string) => void;
  onSeatChair: (value: string) => void;
  onSeatCount: (value: number) => void;
  onSeatRows: (value: number) => void;
  onSeatPerRow: (value: number) => void;
  onSeatAngle: (value: number) => void;
  onSeatSpacingFt: (value: number) => void;
  onSeatRowSpacingFt: (value: number) => void;
  onSeatRowLengths: (value: string) => void;
  onPlaceSeating: () => void;
  onDonePlacing?: () => void;
  onNewShape?: () => void;
  onNewItem?: () => void;
  kits?: ShowKitInfo[];
  kitsBusy?: boolean;
  roomWidthFt?: number;
  roomDepthFt?: number;
  onRefreshKits?: () => void;
  onApplyKit?: (
    kitId: string,
    parts?: { includeStage?: boolean; includeSeating?: boolean; includeGear?: boolean },
  ) => void;
  onImportKit?: () => void;
  onExportRecipe?: () => void;
  onSaveAsKit?: () => void;
  onClearSeating?: () => void;
  onClearGear?: () => void;
  onPlaceDoor?: () => void;
  onPlaceOpening?: () => void;
  chairCount?: number;
  tableCount?: number;
  onExportSchedule?: () => void;
  onExportReport?: () => void;
  onExportPullSheet?: () => void;
  allocationSummary?: { short: number; ok: number; untracked: number } | null;
  bankPresets?: BankPresetInfo[];
  onSaveBankPreset?: () => void;
  onLoadBankPreset?: (preset: BankPresetInfo) => void;
  onDeleteBankPreset?: (id: string) => void;
}

/**
 * Create / show-setup workspace. Docked mode sits beside the plan so the user
 * can stamp seating and still change block settings without reopening.
 */
export default function CreateDialog({
  open,
  docked = true,
  editable,
  hasRoom,
  drawingRoomOutline,
  identity,
  selectedCount,
  identityBusy,
  roomSizeText = null,
  completed,
  inventory,
  seatKind,
  seatTable,
  seatChair,
  seatCount,
  seatRows,
  seatPerRow,
  seatAngle,
  seatSpacingFt,
  seatRowSpacingFt,
  seatRowLengths,
  seatingArmed = false,
  onClose,
  onSaveIdentity,
  onOpenRoom,
  onDrawRoomOutline,
  onOpenBackground,
  hasBackground,
  onFinishRoomAsRectangle,
  onDiscardEmptyPlan,
  onBuildStage,
  onInsert,
  onRepeat,
  onSeating,
  onPrint,
  onSeatKind,
  onSeatTable,
  onSeatChair,
  onSeatCount,
  onSeatRows,
  onSeatPerRow,
  onSeatAngle,
  onSeatSpacingFt,
  onSeatRowSpacingFt,
  onSeatRowLengths,
  onPlaceSeating,
  onDonePlacing,
  kits,
  kitsBusy,
  roomWidthFt,
  roomDepthFt,
  onRefreshKits,
  onApplyKit,
  onImportKit,
  onExportRecipe,
  onSaveAsKit,
  onClearSeating,
  onClearGear,
  onPlaceDoor,
  onPlaceOpening,
  chairCount,
  tableCount,
  onExportSchedule,
  onExportReport,
  onExportPullSheet,
  allocationSummary,
  bankPresets = [],
  onSaveBankPreset,
  onLoadBankPreset,
  onDeleteBankPreset,
}: Props) {
  const [banksOpen, setBanksOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const [seatCountDraft, setSeatCountDraft] = useState(String(seatCount));
  const [seatRowsDraft, setSeatRowsDraft] = useState(String(seatRows));
  const [seatPerRowDraft, setSeatPerRowDraft] = useState(String(seatPerRow));
  const [seatAngleDraft, setSeatAngleDraft] = useState(String(seatAngle));
  const [seatSpacingDraft, setSeatSpacingDraft] = useState(String(seatSpacingFt));
  const [seatRowSpacingDraft, setSeatRowSpacingDraft] = useState(String(seatRowSpacingFt));
  const seatFieldsEditingRef = useRef(false);

  useEffect(() => {
    if (seatFieldsEditingRef.current) return;
    setSeatCountDraft(String(seatCount));
    setSeatRowsDraft(String(seatRows));
    setSeatPerRowDraft(String(seatPerRow));
    setSeatAngleDraft(String(seatAngle));
    setSeatSpacingDraft(String(seatSpacingFt));
    setSeatRowSpacingDraft(String(seatRowSpacingFt));
  }, [seatCount, seatRows, seatPerRow, seatAngle, seatSpacingFt, seatRowSpacingFt]);

  const flushSeatNumbers = () => {
    const count = Number(seatCountDraft);
    const rows = Number(seatRowsDraft);
    const perRow = Number(seatPerRowDraft);
    const angle = Number(seatAngleDraft);
    const spacing = Number(seatSpacingDraft);
    const rowSpacing = Number(seatRowSpacingDraft);
    if (Number.isFinite(count)) onSeatCount(Math.max(1, Math.min(24, Math.round(count))));
    if (Number.isFinite(rows)) onSeatRows(Math.max(1, Math.min(60, Math.round(rows))));
    if (Number.isFinite(perRow)) onSeatPerRow(Math.max(1, Math.min(80, Math.round(perRow))));
    if (Number.isFinite(angle)) onSeatAngle(angle);
    if (Number.isFinite(spacing) && spacing > 0) onSeatSpacingFt(spacing);
    if (Number.isFinite(rowSpacing) && rowSpacing > 0) onSeatRowSpacingFt(rowSpacing);
  };

  const placeSeating = () => {
    seatFieldsEditingRef.current = false;
    flushSeatNumbers();
    onPlaceSeating();
  };
  const layoutDone = !!(completed.stage && completed.seating);

  useEffect(() => {
    if (seatingArmed) {
      setBanksOpen(true);
      setMoreToolsOpen(true);
    }
  }, [seatingArmed]);

  useEffect(() => {
    if (layoutDone && !seatingArmed) setMoreToolsOpen(false);
  }, [layoutDone, seatingArmed]);

  if (!open) return null;

  const chairOptions = inventory.filter(
    (item) => item.category === 'chair' || (!item.category && /chair/i.test(item.name)),
  );
  const tableOptions = inventory.filter(
    (item) =>
      item.category === 'table-round' ||
      item.category === 'table-rect' ||
      (!item.category && /table/i.test(item.name)),
  );
  // Fall back to the full list when the catalog has no category tags yet.
  const chairs = chairOptions.length ? chairOptions : inventory;
  const tables = tableOptions.length ? tableOptions : inventory;

  const headline =
    drawingRoomOutline ? 'Drawing room boundary' : !hasRoom ? 'Create room boundary' : 'Room-fitted kits and generators';
  const guidance =
    !hasRoom || drawingRoomOutline
      ? 'Import a site plan or draw the room directly on the canvas.'
      : layoutDone
        ? 'Apply another room-fitted layout, tune the plan directly, or export it.'
        : 'Apply a room-fitted layout or launch a custom generator.';

  const sheet = (
      <div
        className={`sheet create-dialog-sheet${docked ? ' is-docked' : ''}`}
        role="dialog"
        aria-modal={docked ? undefined : 'true'}
        aria-labelledby="create-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {docked ? (
          <DockTitlebar title={hasRoom ? 'Layouts' : 'Room'} sub={headline} onClose={onClose} closeLabel={`Close ${hasRoom ? 'Layouts' : 'Room'}`} />
        ) : (
          <header className="create-dialog-head">
            <div>
              <small>{hasRoom ? 'Layouts' : 'Room'}</small>
              <h2 id="create-dialog-title">{headline}</h2>
              <p>{guidance}</p>
            </div>
            <button type="button" className="create-dialog-close" onClick={onClose} aria-label={`Close ${hasRoom ? 'Layouts' : 'Room'}`}>
              ×
            </button>
          </header>
        )}
        {docked && <p className="create-dialog-guidance" id="create-dialog-title">{guidance}</p>}

        <div className="create-dialog-body">
          <ShowSetupPanel
            editable={editable}
            hasRoom={hasRoom}
            drawingRoomOutline={drawingRoomOutline}
            identity={identity}
            selectedCount={selectedCount}
            identityBusy={identityBusy}
            roomSizeText={roomSizeText}
            completed={completed}
            onSaveIdentity={onSaveIdentity}
            onOpenRoom={onOpenRoom}
            onDrawRoomOutline={onDrawRoomOutline}
            onOpenBackground={onOpenBackground}
            hasBackground={hasBackground}
            onFinishRoomAsRectangle={onFinishRoomAsRectangle}
            onDiscardEmptyPlan={onDiscardEmptyPlan}
            onBuildStage={onBuildStage}
            onInsert={onInsert}
            onRepeat={onRepeat}
            onSeating={onSeating}
            onPrint={onPrint}
            kits={kits}
            kitsBusy={kitsBusy}
            roomWidthFt={roomWidthFt}
            roomDepthFt={roomDepthFt}
            onRefreshKits={onRefreshKits}
            onApplyKit={onApplyKit}
            onImportKit={onImportKit}
            onExportRecipe={onExportRecipe}
            onSaveAsKit={onSaveAsKit}
            onClearSeating={onClearSeating}
            onClearGear={onClearGear}
            onPlaceDoor={onPlaceDoor}
            onPlaceOpening={onPlaceOpening}
            chairCount={chairCount}
            tableCount={tableCount}
            onExportSchedule={onExportSchedule}
            onExportReport={onExportReport}
            onExportPullSheet={onExportPullSheet}
            allocationSummary={allocationSummary}
          />

          {hasRoom && !drawingRoomOutline && (
          <details
            className="create-more-tools"
            open={moreToolsOpen || seatingArmed}
            onToggle={(event) => {
              if (seatingArmed) return;
              setMoreToolsOpen((event.target as HTMLDetailsElement).open);
            }}
          >
            <summary>Stamp a seating bank</summary>
            <p className="hint" style={{ margin: '8px 0 10px' }}>
              One block per click. Use Seating planner above for a whole-floor fill. Text and drawing tools live in Draw mode.
            </p>
          <div className="section">
            <details
              className="create-stamp-banks"
              open={banksOpen || seatingArmed}
              onToggle={(event) => {
                if (seatingArmed) return;
                setBanksOpen((event.target as HTMLDetailsElement).open);
              }}
            >
              <summary>Add a bank (stamp)</summary>
              <p className="hint" style={{ margin: '8px 0 10px' }}>
                Not a whole-room fill — stamp one bank at a time.
              </p>
              <div
                className="seg tabs seat-scale"
                role="group"
                aria-label="Event scale defaults"
                style={{ marginBottom: 12 }}
              >
                {(
                  [
                    {
                      id: 'intimate',
                      label: '~20',
                      title: 'Intimate / boardroom rows',
                      apply: () => {
                        onSeatKind('theatre');
                        onSeatRows(3);
                        onSeatPerRow(6);
                        onSeatAngle(0);
                        onSeatRowLengths('');
                        setSeatRowsDraft('3');
                        setSeatPerRowDraft('6');
                        setSeatAngleDraft('0');
                      },
                    },
                    {
                      id: 'banquet',
                      label: 'Banquet',
                      title: 'Round banquet tables',
                      apply: () => {
                        onSeatKind('round');
                        onSeatCount(10);
                        setSeatCountDraft('10');
                      },
                    },
                    {
                      id: 'theatre',
                      label: 'Theatre',
                      title: 'Theatre banks',
                      apply: () => {
                        onSeatKind('theatre');
                        onSeatRows(8);
                        onSeatPerRow(12);
                        onSeatAngle(0);
                        onSeatRowLengths('');
                      },
                    },
                    {
                      id: 'arena',
                      label: 'Arena',
                      title: 'Large concert / arena banks',
                      apply: () => {
                        onSeatKind('theatre');
                        onSeatRows(15);
                        onSeatPerRow(24);
                        onSeatAngle(0);
                        onSeatRowLengths('');
                      },
                    },
                  ] as const
                ).map((scale) => (
                  <button
                    key={scale.id}
                    type="button"
                    title={scale.title}
                    disabled={!editable}
                    onClick={scale.apply}
                  >
                    {scale.label}
                  </button>
                ))}
              </div>
              {seatKind === 'theatre' ? (
                <div className="bank-presets" style={{ marginBottom: 12 }}>
                  <div className="field">
                    <label htmlFor="bank-preset-select">Bank presets</label>
                    <select
                      id="bank-preset-select"
                      disabled={!editable || !bankPresets.length}
                      defaultValue=""
                      onChange={(event) => {
                        const preset = bankPresets.find((p) => p.id === event.target.value);
                        if (preset) onLoadBankPreset?.(preset);
                        event.target.value = '';
                      }}
                    >
                      <option value="">Load a saved bank…</option>
                      {bankPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="show-setup-actions" style={{ gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="btn-outline"
                      disabled={!editable || !seatChair}
                      onClick={() => onSaveBankPreset?.()}
                    >
                      Save current as preset
                    </button>
                    {bankPresets[0] ? (
                      <button
                        type="button"
                        className="link-btn"
                        disabled={!editable}
                        onClick={() => onDeleteBankPreset?.(bankPresets[0]!.id)}
                        title={`Delete “${bankPresets[0].name}”`}
                      >
                        Delete latest
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="seg tabs seat-kinds" role="tablist" aria-label="Seating layout kind">
                {(['round', 'theatre', 'schoolroom'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="tab"
                    data-seat-kind={kind}
                    className={seatKind === kind ? 'active' : ''}
                    aria-selected={seatKind === kind}
                    aria-pressed={seatKind === kind}
                    onClick={() => onSeatKind(kind)}
                  >
                    {kind === 'round' ? 'Banquet' : kind === 'theatre' ? 'Theatre' : 'Classroom'}
                  </button>
                ))}
              </div>

              {seatKind !== 'theatre' && (
                <div className="field">
                  <label htmlFor="create-seat-table">Table</label>
                  <select
                    id="create-seat-table"
                    value={seatTable}
                    onChange={(event) => onSeatTable(event.target.value)}
                    disabled={!editable}
                  >
                    <option value="">Choose…</option>
                    {tables.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field">
                <label htmlFor="create-seat-chair">Chair</label>
                <select
                  id="create-seat-chair"
                  value={seatChair}
                  onChange={(event) => onSeatChair(event.target.value)}
                  disabled={!editable}
                >
                  <option value="">Choose…</option>
                  {chairs.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>

              {seatKind === 'round' ? (
                <div className="field">
                  <label htmlFor="create-seat-count">Seats per table</label>
                  <input
                    id="create-seat-count"
                    className="num"
                    type="number"
                    min={1}
                    max={24}
                    value={seatCountDraft}
                    onFocus={() => {
                      seatFieldsEditingRef.current = true;
                    }}
                    onChange={(event) => setSeatCountDraft(event.target.value)}
                    onBlur={() => {
                      seatFieldsEditingRef.current = false;
                      flushSeatNumbers();
                    }}
                    disabled={!editable}
                  />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>Rows × per row</label>
                    <div className="size-row">
                      <input
                        className="num"
                        type="number"
                        min={1}
                        max={60}
                        value={seatRowsDraft}
                        onFocus={() => {
                          seatFieldsEditingRef.current = true;
                        }}
                        onChange={(event) => setSeatRowsDraft(event.target.value)}
                        onBlur={() => {
                          seatFieldsEditingRef.current = false;
                          flushSeatNumbers();
                        }}
                        disabled={!editable}
                      />
                      <span className="inv-x">×</span>
                      <input
                        className="num"
                        type="number"
                        min={1}
                        max={80}
                        value={seatPerRowDraft}
                        onFocus={() => {
                          seatFieldsEditingRef.current = true;
                        }}
                        onChange={(event) => setSeatPerRowDraft(event.target.value)}
                        onBlur={() => {
                          seatFieldsEditingRef.current = false;
                          flushSeatNumbers();
                        }}
                        disabled={!editable}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="create-seat-angle">Block angle</label>
                    <div className="size-row">
                      <input
                        id="create-seat-angle"
                        className="num"
                        type="number"
                        min={-180}
                        max={180}
                        step={1}
                        value={seatAngleDraft}
                        onFocus={() => {
                          seatFieldsEditingRef.current = true;
                        }}
                        onChange={(event) => setSeatAngleDraft(event.target.value)}
                        onBlur={() => {
                          seatFieldsEditingRef.current = false;
                          flushSeatNumbers();
                        }}
                        disabled={!editable}
                      />
                      <span className="inv-x">°</span>
                      {([-30, 0, 30] as const).map((deg) => (
                        <button
                          key={deg}
                          type="button"
                          className={Number(seatAngleDraft) === deg ? 'is-on' : ''}
                          disabled={!editable}
                          onClick={() => {
                            setSeatAngleDraft(String(deg));
                            onSeatAngle(deg);
                          }}
                          title={`Set block angle to ${deg}°`}
                        >
                          {deg > 0 ? `+${deg}°` : `${deg}°`}
                        </button>
                      ))}
                    </div>
                    <p className="hint" style={{ marginTop: 6 }}>
                      Use ±30° for angled side banks; 0° for centre blocks.
                    </p>
                  </div>
                  <div className="field">
                    <label>Seat × row spacing</label>
                    <div className="size-row">
                      <input
                        id="create-seat-spacing"
                        className="num"
                        type="number"
                        min={0.5}
                        max={10}
                        step={0.01}
                        value={seatSpacingDraft}
                        onFocus={() => {
                          seatFieldsEditingRef.current = true;
                        }}
                        onChange={(event) => setSeatSpacingDraft(event.target.value)}
                        onBlur={() => {
                          seatFieldsEditingRef.current = false;
                          flushSeatNumbers();
                        }}
                        disabled={!editable}
                        title="Centre-to-centre spacing along a row, in feet"
                      />
                      <span className="inv-x">′</span>
                      <span className="inv-x">×</span>
                      <input
                        id="create-seat-row-spacing"
                        className="num"
                        type="number"
                        min={0.5}
                        max={20}
                        step={0.01}
                        value={seatRowSpacingDraft}
                        onFocus={() => {
                          seatFieldsEditingRef.current = true;
                        }}
                        onChange={(event) => setSeatRowSpacingDraft(event.target.value)}
                        onBlur={() => {
                          seatFieldsEditingRef.current = false;
                          flushSeatNumbers();
                        }}
                        disabled={!editable}
                        title="Front-to-back spacing between rows, in feet"
                      />
                      <span className="inv-x">′</span>
                    </div>
                    <p className="hint" style={{ marginTop: 6 }}>
                      Card Party banks use ~1.79′ seat and ~3.5′ row spacing — tighter than the 2′ × 3′
                      comfort default.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="create-seat-row-lengths">Row lengths (optional)</label>
                    <input
                      id="create-seat-row-lengths"
                      value={seatRowLengths}
                      onChange={(event) => onSeatRowLengths(event.target.value)}
                      disabled={!editable}
                      placeholder="e.g. 12,13,14,14,13,12"
                      title="Comma-separated seats per row, front to back. Leave blank for a uniform rectangle."
                    />
                    <p className="hint" style={{ marginTop: 6 }}>
                      Use when a bank is not a full rectangle — each number is one row’s seat count.
                    </p>
                  </div>
                  <p className="hint" style={{ marginTop: 4 }} id="create-seat-count-preview">
                    {(() => {
                      const lengths = seatRowLengths
                        .split(/[,;\s]+/)
                        .map((part) => Number(part.trim()))
                        .filter((n) => Number.isFinite(n) && n >= 1);
                      const n = lengths.length
                        ? lengths.reduce((a, b) => a + b, 0)
                        : Math.max(1, seatRows) * Math.max(1, seatPerRow);
                      return `Will place ${n.toLocaleString()} chair${n === 1 ? '' : 's'} per click`;
                    })()}
                  </p>
                </>
              )}

              <button
                type="button"
                className="btn-outline"
                style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                disabled={!editable || !seatChair || (seatKind !== 'theatre' && !seatTable)}
                onClick={placeSeating}
              >
                <IconPlus size={14} />
                {seatingArmed ? 'Update stamp' : 'Place on plan'}
              </button>
              {seatingArmed && onDonePlacing ? (
                <button
                  type="button"
                  className="btn-outline"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  onClick={onDonePlacing}
                >
                  Done placing
                </button>
              ) : null}
              <p className="hint">
                {seatKind === 'round'
                  ? 'Chairs face the table. Click the plan for each table group; change settings here and stamp again.'
                  : 'Rows centre on each click. Keep this panel open to adjust angle or row lengths, then click the plan again.'}
              </p>
            </details>
          </div>
          </details>
          )}
        </div>
      </div>
  );

  if (docked) {
    return (
      <aside className="create-setup-pane" aria-label="Setup">
        {sheet}
      </aside>
    );
  }

  return (
    <div className="sheet-backdrop create-setup-backdrop" role="presentation" onMouseDown={onClose}>
      {sheet}
    </div>
  );
}
