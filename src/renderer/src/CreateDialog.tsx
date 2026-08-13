import type { RefObject } from 'react';

import ShowSetupPanel, { type PlanIdentityFields, type ShowKitInfo } from './ShowSetupPanel.js';
import TextToolPanel from './TextToolPanel.js';
import { IconDrawPolygon, IconPlus, IconRuler } from './icons.js';

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
  completed: {
    stage?: boolean;
    insert?: boolean;
    repeat?: boolean;
    seating?: boolean;
    print?: boolean;
  };
  canCreateLabel: boolean;
  canCreateDimension: boolean;
  textActive: boolean;
  annotationDraft: string;
  annotationColor: string;
  platform: string;
  styleHint?: string | null;
  annotationInputRef: RefObject<HTMLTextAreaElement | null>;
  dimensionActive: boolean;
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
  onFinishRoomAsRectangle?: () => void;
  onDiscardEmptyPlan?: () => void;
  onBuildStage: () => void;
  onInsert: () => void;
  onRepeat: () => void;
  onSeating: () => void;
  onPrint: () => void;
  onText: (next: string) => void;
  onColor: (next: string) => void;
  onStartText: () => void;
  onDoneText: () => void;
  onToggleDimension: () => void;
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
  onNewShape: () => void;
  onNewItem: () => void;
  kits?: ShowKitInfo[];
  kitsBusy?: boolean;
  onRefreshKits?: () => void;
  onApplyKit?: (kitId: string) => void;
  onImportKit?: () => void;
  onExportRecipe?: () => void;
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
  completed,
  canCreateLabel,
  canCreateDimension,
  textActive,
  annotationDraft,
  annotationColor,
  platform,
  styleHint,
  annotationInputRef,
  dimensionActive,
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
  onFinishRoomAsRectangle,
  onDiscardEmptyPlan,
  onBuildStage,
  onInsert,
  onRepeat,
  onSeating,
  onPrint,
  onText,
  onColor,
  onStartText,
  onDoneText,
  onToggleDimension,
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
  onNewShape,
  onNewItem,
  kits,
  kitsBusy,
  onRefreshKits,
  onApplyKit,
  onImportKit,
  onExportRecipe,
  bankPresets = [],
  onSaveBankPreset,
  onLoadBankPreset,
  onDeleteBankPreset,
}: Props) {
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

  const sheet = (
      <div
        className={`sheet create-dialog-sheet${docked ? ' is-docked' : ''}`}
        role="dialog"
        aria-modal={docked ? undefined : 'true'}
        aria-labelledby="create-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="create-dialog-head">
          <div>
            <small>Create</small>
            <h2 id="create-dialog-title">
              {!hasRoom || drawingRoomOutline ? 'Finish the room' : 'Show setup'}
            </h2>
            <p>
              {!hasRoom || drawingRoomOutline
                ? 'Click corners on the plan to close the outline — then stage, seating, and print unlock here.'
                : docked
                  ? 'Next steps for this plan — stage, objects, seating, then print.'
                  : 'Set up the show, add shapes or items, then place on the plan.'}
            </p>
          </div>
          <button type="button" className="create-dialog-close" onClick={onClose} aria-label="Close Create">
            ×
          </button>
        </header>

        <div className="create-dialog-body">
          <ShowSetupPanel
            editable={editable}
            hasRoom={hasRoom}
            drawingRoomOutline={drawingRoomOutline}
            identity={identity}
            selectedCount={selectedCount}
            identityBusy={identityBusy}
            completed={completed}
            onSaveIdentity={onSaveIdentity}
            onOpenRoom={onOpenRoom}
            onDrawRoomOutline={onDrawRoomOutline}
            onFinishRoomAsRectangle={onFinishRoomAsRectangle}
            onDiscardEmptyPlan={onDiscardEmptyPlan}
            onBuildStage={onBuildStage}
            onInsert={onInsert}
            onRepeat={onRepeat}
            onSeating={onSeating}
            onPrint={onPrint}
            kits={kits}
            kitsBusy={kitsBusy}
            onRefreshKits={onRefreshKits}
            onApplyKit={onApplyKit}
            onImportKit={onImportKit}
            onExportRecipe={onExportRecipe}
          />

          {hasRoom && !drawingRoomOutline && (
          <div className="section create-library-section">
            <div className="section-title">
              <span>Library</span>
            </div>
            <p className="hint" style={{ marginBottom: 10 }}>
              Build a custom shape or inventory item — each opens its own editor.
            </p>
            <div className="create-library-actions">
              <button type="button" className="btn-outline create-library-action" onClick={onNewShape}>
                <IconDrawPolygon size={16} />
                <span>
                  <strong>New shape</strong>
                  <small>Draw or trace a custom outline</small>
                </span>
              </button>
              <button type="button" className="btn-outline create-library-action" onClick={onNewItem}>
                <IconPlus size={16} />
                <span>
                  <strong>New item</strong>
                  <small>Name, size, and icon for inventory</small>
                </span>
              </button>
            </div>
          </div>
          )}

          {hasRoom && !drawingRoomOutline && (
          <>
          <div className="section text-tool-section">
            <TextToolPanel
              active={textActive}
              editable={canCreateLabel}
              text={annotationDraft}
              color={annotationColor}
              platform={platform}
              styleHint={styleHint}
              inputRef={annotationInputRef as RefObject<HTMLTextAreaElement>}
              onText={onText}
              onColor={onColor}
              onStart={onStartText}
              onDone={onDoneText}
            />
            <div className="text-tool-related">
              <span>
                <strong>Need a measurement?</strong>
                <small>
                  {canCreateDimension
                    ? 'Draw a linked dimension that follows objects.'
                    : 'Open an editable plan to save dimensions.'}
                </small>
              </span>
              <button
                type="button"
                className={dimensionActive ? 'is-on' : ''}
                onClick={onToggleDimension}
                disabled={!canCreateDimension}
                title={canCreateDimension ? 'Draw an object-linked dimension (D)' : 'This plan is read-only'}
              >
                <IconRuler size={14} />
                Dimension
              </button>
            </div>
          </div>

          <div className="section">
            <div className="section-title">
              <span>Add seating</span>
            </div>
            <p className="hint" style={{ marginBottom: 10 }}>
              Stamp quick blocks from a boardroom (~20) to a full house. For U-shape, conference, hollow
              square, aisles, and live fill counts, open the seating planner.
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
                    },
                  },
                  {
                    id: 'banquet',
                    label: 'Banquet',
                    title: 'Round banquet tables',
                    apply: () => {
                      onSeatKind('round');
                      onSeatCount(10);
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
            <button
              type="button"
              className="btn-outline"
              style={{ width: '100%', justifyContent: 'center', marginBottom: 12 }}
              onClick={onSeating}
            >
              Open seating planner
            </button>
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
                  value={seatCount}
                  onChange={(event) => onSeatCount(Number(event.target.value))}
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
                      value={seatRows}
                      onChange={(event) => onSeatRows(Number(event.target.value))}
                      disabled={!editable}
                    />
                    <span className="inv-x">×</span>
                    <input
                      className="num"
                      type="number"
                      min={1}
                      max={80}
                      value={seatPerRow}
                      onChange={(event) => onSeatPerRow(Number(event.target.value))}
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
                      value={seatAngle}
                      onChange={(event) => onSeatAngle(Number(event.target.value) || 0)}
                      disabled={!editable}
                    />
                    <span className="inv-x">°</span>
                    {([-30, 0, 30] as const).map((deg) => (
                      <button
                        key={deg}
                        type="button"
                        className={seatAngle === deg ? 'is-on' : ''}
                        disabled={!editable}
                        onClick={() => onSeatAngle(deg)}
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
                      value={seatSpacingFt}
                      onChange={(event) => onSeatSpacingFt(Number(event.target.value) || 0)}
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
                      value={seatRowSpacingFt}
                      onChange={(event) => onSeatRowSpacingFt(Number(event.target.value) || 0)}
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
              onClick={onPlaceSeating}
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
                : 'Rows centre on each click. Keep this panel open — adjust angle or row lengths, then click the plan again.'}
            </p>
          </div>
          </>
          )}
        </div>
      </div>
  );

  if (docked) {
    return (
      <aside className="create-setup-pane" aria-label="Show setup">
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
