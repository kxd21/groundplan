/**
 * Show Setup dock — brief, room, kits, and deep-links to generators.
 * Seating stamps live in the Seating overlay (see docs/ui-ownership.md).
 */

import type { RefObject } from 'react';

import DockTitlebar from './DockTitlebar.js';
import ShowSetupPanel, { type ShowKitInfo } from './ShowSetupPanel.js';
import type { ShowBrief } from '../../format/show-brief.js';

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
  docked?: boolean;
  editable: boolean;
  hasRoom: boolean;
  drawingRoomOutline: boolean;
  selectedCount: number;
  roomSizeText?: string | null;
  completed: {
    stage?: boolean;
    insert?: boolean;
    repeat?: boolean;
    seating?: boolean;
    print?: boolean;
  };
  /** @deprecated Kept optional for callers that still pass annotation chrome. */
  canCreateLabel?: boolean;
  canCreateDimension?: boolean;
  textActive?: boolean;
  annotationDraft?: string;
  annotationColor?: string;
  platform?: string;
  styleHint?: string | null;
  annotationInputRef?: RefObject<HTMLTextAreaElement | null>;
  dimensionActive?: boolean;
  onClose: () => void;
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
  onOpenGear?: () => void;
  onText?: (next: string) => void;
  onColor?: (next: string) => void;
  onStartText?: () => void;
  onDoneText?: () => void;
  onToggleDimension?: () => void;
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
  onExportHangPlot?: () => void;
  allocationSummary?: { short: number; ok: number; untracked: number } | null;
  brief?: ShowBrief | null;
  briefBusy?: boolean;
  onSaveBrief?: (patch: Partial<ShowBrief>) => void | Promise<void>;
  hasScreens?: boolean;
  stageSize?: { widthFt: number; depthFt: number; heightIn?: number } | null;
  accessibleSeats?: number;
  revision?: string;
  drawnBy?: string;
  onRevision?: (next: string) => void;
  onDrawnBy?: (next: string) => void;
}

export default function CreateDialog({
  open,
  docked = true,
  editable,
  hasRoom,
  drawingRoomOutline,
  selectedCount,
  roomSizeText = null,
  completed,
  onClose,
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
  onOpenGear,
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
  onExportHangPlot,
  allocationSummary,
  brief = null,
  briefBusy,
  onSaveBrief,
  hasScreens,
  stageSize,
  accessibleSeats,
  revision,
  drawnBy,
  onRevision,
  onDrawnBy,
}: Props) {
  if (!open) return null;

  const layoutDone = !!(completed.stage && completed.seating);
  const headline = drawingRoomOutline
    ? 'Drawing room boundary'
    : !hasRoom
      ? 'Describe the show, then build the room'
      : 'Brief, layout, and what the plan still needs';
  const guidance =
    !hasRoom || drawingRoomOutline
      ? 'Fill in as much of the brief as you know, then import a site plan or draw the room.'
      : layoutDone
        ? 'Check the plan against the brief, adjust it, then issue the sheet.'
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
        <DockTitlebar title="Show Setup" sub={headline} onClose={onClose} closeLabel="Close Show Setup" />
      ) : (
        <header className="create-dialog-head">
          <div>
            <small>Show Setup</small>
            <h2 id="create-dialog-title">{headline}</h2>
            <p>{guidance}</p>
          </div>
          <button type="button" className="create-dialog-close" onClick={onClose} aria-label="Close Show Setup">
            ×
          </button>
        </header>
      )}
      {docked && (
        <p className="create-dialog-guidance" id="create-dialog-title">
          {guidance}
        </p>
      )}

      <div className="create-dialog-body">
        <ShowSetupPanel
          editable={editable}
          hasRoom={hasRoom}
          drawingRoomOutline={drawingRoomOutline}
          selectedCount={selectedCount}
          roomSizeText={roomSizeText}
          completed={completed}
          brief={brief}
          briefBusy={briefBusy}
          onSaveBrief={onSaveBrief}
          hasScreens={hasScreens}
          stageSize={stageSize}
          accessibleSeats={accessibleSeats}
          revision={revision}
          drawnBy={drawnBy}
          onRevision={onRevision}
          onDrawnBy={onDrawnBy}
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
          onOpenGear={onOpenGear}
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
          onExportHangPlot={onExportHangPlot}
          allocationSummary={allocationSummary}
        />

        {hasRoom && !drawingRoomOutline && (
          <div className="create-more-tools create-seating-launcher">
            <p className="hint" style={{ margin: '12px 0 8px' }}>
              Whole-floor fill and click-to-stamp banks live in the Seating planner — one place for both.
            </p>
            <button
              type="button"
              className="btn-outline"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={!editable}
              onClick={onSeating}
            >
              Open Seating planner
            </button>
          </div>
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
