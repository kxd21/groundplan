/**
 * Show Setup — describe the show, build the room, lay it out, check it, issue it.
 *
 * The panel used to be a layout library with four identity fields hidden at the
 * bottom, so the only thing it knew about a job was what printed on the title
 * block. It now runs the intake in four sections that follow the order the work
 * actually happens in, each one a compact summary that opens when somebody needs
 * it rather than one long form:
 *
 *   Brief          what the show needs
 *   Venue & room   the boundary everything else is measured inside
 *   Layout         kits and the generators that fill it
 *   Review & issue whether the drawing satisfies the brief, then print
 *
 * Nothing here wraps the existing tools. Every route, kit operation, generator,
 * export and advanced action that was reachable before is still reachable, in
 * the section it belongs to.
 */

import { useEffect, useMemo, useState } from 'react';

import { assessReadiness, type IssueTarget } from '../../format/readiness.js';
import { suggestKit } from '../../format/kit-fit.js';
import type { ShowBrief } from '../../format/show-brief.js';
import { ShowBriefCard, ReviewCard, type BriefGroup } from './ShowBriefSection.js';
import {
  IconChair,
  IconDrawPolygon,
  IconFile,
  IconLayers,
  IconPlus,
  IconRuler,
} from './icons.js';

export interface PlanIdentityFields {
  date: string;
  venue: string;
  event: string;
  contact: string;
}

export interface ShowKitInfo {
  id: string;
  name: string;
  source: 'bundled' | 'user';
  chairs: number;
  banks: number;
  gear: number;
  event?: string;
  venue?: string;
  capacityGuests?: number;
  /** What the kit's seating really is — see `suggestKit`. */
  seatingKinds?: Array<'theatre' | 'schoolroom' | 'round'>;
  hasStage?: boolean;
  extentFt?: { width: number; depth: number };
  variantOf?: string;
}

interface Props {
  editable: boolean;
  hasRoom: boolean;
  drawingRoomOutline: boolean;
  selectedCount?: number;

  /* The brief ------------------------------------------------------------ */
  brief?: ShowBrief | null;
  briefBusy?: boolean;
  onSaveBrief?: (patch: Partial<ShowBrief>) => void | Promise<void>;

  roomSizeText?: string | null;
  onOpenRoom: () => void;
  onDrawRoomOutline: () => void;
  onOpenBackground?: () => void;
  hasBackground?: boolean;
  onFinishRoomAsRectangle?: () => void;
  onDiscardEmptyPlan?: () => void;
  onBuildStage: () => void;
  onInsert: () => void;
  onRepeat?: () => void;
  onSeating: () => void;
  onPrint: () => void;
  onOpenGear?: () => void;
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

  /* Plan facts the readiness check needs beyond seats and tables. --------- */
  hasScreens?: boolean;
  /** The drawn stage's size, so a brief that named one can be checked. */
  stageSize?: { widthFt: number; depthFt: number; heightIn?: number } | null;
  accessibleSeats?: number;

  /* Title block, edited where the sheet is issued. ------------------------ */
  revision?: string;
  drawnBy?: string;
  onRevision?: (next: string) => void;
  onDrawnBy?: (next: string) => void;

  onExportSchedule?: () => void;
  onExportReport?: () => void;
  onExportPullSheet?: () => void;
  onExportHangPlot?: () => void;
  allocationSummary?: { short: number; ok: number; untracked: number } | null;
  completed?: {
    stage?: boolean;
    insert?: boolean;
    repeat?: boolean;
    seating?: boolean;
    print?: boolean;
  };
}

export default function ShowSetupPanel({
  editable,
  hasRoom,
  drawingRoomOutline,
  brief = null,
  briefBusy,
  onSaveBrief,
  roomSizeText = null,
  onOpenRoom,
  onDrawRoomOutline,
  onOpenBackground,
  hasBackground,
  onFinishRoomAsRectangle,
  onDiscardEmptyPlan,
  onBuildStage,
  onInsert,
  onSeating,
  onPrint,
  onOpenGear,
  kits = [],
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
  chairCount = 0,
  tableCount = 0,
  hasScreens = false,
  stageSize = null,
  accessibleSeats = 0,
  revision = '',
  drawnBy = '',
  onRevision,
  onDrawnBy,
  onExportSchedule,
  onExportReport,
  onExportPullSheet,
  onExportHangPlot,
  allocationSummary = null,
  completed = {},
}: Props) {
  const [selectedKit, setSelectedKit] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [briefGroup, setBriefGroup] = useState<BriefGroup | null>(null);

  /*
   * The recommendation reads the brief, not the kit's name. When the brief is
   * still empty this falls back to fitting the room, and returns nothing at all
   * when there is neither — an unjustifiable suggestion gets trusted.
   */
  const suggestion = useMemo(
    () => suggestKit(kits, brief, { widthFt: roomWidthFt, depthFt: roomDepthFt }),
    [kits, brief, roomWidthFt, roomDepthFt],
  );
  const suggestedKit = suggestion?.kitId;

  useEffect(() => {
    setSelectedKit((current) => {
      if (current && kits.some((kit) => kit.id === current)) return current;
      return suggestedKit ?? kits[0]?.id ?? '';
    });
  }, [kits, suggestedKit]);

  const selected = kits.find((kit) => kit.id === selectedKit);
  const roomStatus = drawingRoomOutline ? 'drawing' : hasRoom ? 'ready' : 'needed';

  /*
   * Read from the plan as it stands, never from steps that were visited. An
   * undone kit leaves no stage behind, and this has to notice.
   */
  const readiness = useMemo(
    () =>
      assessReadiness(brief, {
        hasRoom,
        seats: chairCount,
        tables: tableCount,
        hasStage: completed.stage === true,
        ...(stageSize ? { stageSize } : {}),
        hasScreens,
        accessibleSeats,
        ...(allocationSummary
          ? { gearShort: allocationSummary.short, gearUntracked: allocationSummary.untracked }
          : {}),
      }),
    [brief, hasRoom, chairCount, tableCount, completed.stage, stageSize, hasScreens, accessibleSeats, allocationSummary],
  );

  /** Every warning goes somewhere. A warning with no route is a complaint. */
  const goTo = (target: IssueTarget) => {
    switch (target) {
      case 'brief':
        setBriefGroup('layout');
        break;
      case 'venue':
        setBriefGroup('venue');
        break;
      case 'room':
        if (hasRoom) onOpenRoom();
        else onDrawRoomOutline();
        break;
      case 'seating':
        onSeating();
        break;
      case 'stage':
        onBuildStage();
        break;
      case 'objects':
        onInsert();
        break;
      case 'gear':
        (onOpenGear ?? onExportPullSheet)?.();
        break;
      case 'issue':
        setAdvancedOpen(true);
        break;
    }
  };

  return (
    <div className="section show-setup-section is-guided">
      {/*
        No "Show setup" heading here — the dock's own titlebar already says it,
        and repeating it in a 300px panel costs a line for nothing. The room's
        state moved to the room section, which is where it is acted on.
      */}

      {/* 1 — Brief. Reachable before there is anything to draw. */}
      <ShowBriefCard
        brief={brief}
        busy={briefBusy}
        editable={editable}
        onSave={(patch) => onSaveBrief?.(patch)}
        openGroup={briefGroup}
        onOpenGroupHandled={() => setBriefGroup(null)}
      />

      {/* 2 — Venue & room. */}
      {!hasRoom && (
        <section className="show-setup-next-card">
          <div className="show-setup-card-head">
            <h3>{drawingRoomOutline ? 'Finish the room boundary' : 'Create the room boundary'}</h3>
            <span className={`show-setup-chip is-${roomStatus}`}>
              {roomStatus === 'drawing' ? 'Drawing room' : 'Room needed'}
            </span>
          </div>
          <p>
            {drawingRoomOutline
              ? 'Click each corner on the plan, then press Enter to close the room.'
              : 'Start from a site plan when you have one, or draw directly on a blank sheet.'}
          </p>
          <div className="show-setup-route-grid">
            {onOpenBackground && (
              <button type="button" className="show-setup-route" disabled={!editable} onClick={onOpenBackground}>
                <IconFile size={20} />
                <span><strong>{hasBackground ? 'Edit site plan' : 'Import site plan'}</strong><small>PDF or image · scale, align, then trace</small></span>
              </button>
            )}
            <button type="button" className="show-setup-route is-primary" disabled={!editable} onClick={onDrawRoomOutline}>
              <IconDrawPolygon size={20} />
              <span><strong>{drawingRoomOutline ? 'Cancel drawing' : 'Draw room'}</strong><small>Click the corners · Enter closes the outline</small></span>
            </button>
          </div>
          {drawingRoomOutline && onFinishRoomAsRectangle && (
            <button type="button" className="btn-outline show-setup-wide-action" disabled={!editable} onClick={onFinishRoomAsRectangle}>
              Finish with the guide rectangle
            </button>
          )}
          {onDiscardEmptyPlan && !hasRoom && (
            <button type="button" className="link-btn is-danger" onClick={onDiscardEmptyPlan}>Discard empty plan</button>
          )}
        </section>
      )}

      {hasRoom && (
        <section className="show-setup-compact-card">
          <div className="show-setup-card-head">
            <div>
              <strong>{brief?.roomName || 'Room'}</strong>
              <small>{roomSizeText ?? 'Boundary ready'}{brief?.venue ? ` · ${brief.venue}` : ''}</small>
            </div>
            <span className={`show-setup-chip is-${roomStatus}`}>Room ready</span>
          </div>
          <div className="show-setup-compact-actions">
            <button type="button" onClick={onOpenRoom}>Open room layout</button>
            {onOpenBackground && <button type="button" onClick={onOpenBackground}>{hasBackground ? 'Site plan' : 'Add site plan'}</button>}
            {onPlaceDoor && <button type="button" disabled={!editable} onClick={onPlaceDoor}>Door</button>}
            {onPlaceOpening && <button type="button" disabled={!editable} onClick={onPlaceOpening}>Opening</button>}
          </div>
        </section>
      )}

      {/* 3 — Layout. */}
      {hasRoom && (
        <section className="show-setup-next-card">
          <h3>Layout</h3>
          <p>Apply a complete starting point, then edit every object directly on the plan.</p>

          <div className="show-setup-kit-hero">
            <div className="show-setup-kit-hero-head">
              <span><IconLayers size={18} /></span>
              <div>
                <strong>Start from a layout kit</strong>
                <small>
                  {suggestion && suggestion.kitId === selectedKit
                    ? suggestion.reason
                    : brief?.targetAttendance || brief?.layoutType
                      ? 'Matched against the brief'
                      : 'Set a headcount in the brief for a better match'}
                </small>
              </div>
            </div>
            <select
              id="show-kit-select"
              className="show-setup-kit-select"
              value={selectedKit}
              disabled={!editable || kitsBusy || !kits.length}
              onChange={(event) => setSelectedKit(event.target.value)}
            >
              {!kits.length && <option value="">No kits available</option>}
              {kits.map((kit) => (
                <option key={kit.id} value={kit.id}>
                  {kit.name}{kit.capacityGuests ? ` · ${kit.capacityGuests.toLocaleString()} guests` : ''}{kit.id === suggestedKit ? ' · best fit' : ''}
                </option>
              ))}
            </select>
            {selected && (
              <div className="show-setup-kit-facts">
                <span><b>{selected.chairs.toLocaleString()}</b> chairs</span>
                <span><b>{selected.banks}</b> banks</span>
                <span><b>{selected.gear}</b> gear</span>
              </div>
            )}
            {suggestion?.oversize && suggestion.kitId === selectedKit && (
              <p className="show-setup-kit-warning">This kit is larger than the room as drawn.</p>
            )}
            <button
              type="button"
              className="btn-primary show-setup-wide-action"
              disabled={!editable || !selectedKit || kitsBusy}
              onClick={() => selectedKit && onApplyKit?.(selectedKit)}
            >
              {kitsBusy ? 'Applying layout…' : 'Apply complete layout'}
            </button>
          </div>

          <div className="show-setup-or"><span>custom generators</span></div>
          <div className="show-setup-specialists">
            <button type="button" className={completed.stage ? 'is-done' : ''} disabled={!editable} onClick={onBuildStage}>
              <IconPlus size={16} /><span><strong>Stage</strong><small>Decks &amp; stairs</small></span>
            </button>
            <button type="button" className={completed.insert ? 'is-done' : ''} disabled={!editable} onClick={onInsert}>
              <IconLayers size={16} /><span><strong>Objects</strong><small>Gear &amp; furniture</small></span>
            </button>
            <button type="button" className={completed.seating ? 'is-done' : ''} disabled={!editable} onClick={onSeating}>
              <IconChair size={16} /><span><strong>Seating</strong><small>Banks &amp; aisles</small></span>
            </button>
          </div>
        </section>
      )}

      {/* 4 — Review & issue. */}
      <ReviewCard
        report={readiness}
        onGoTo={goTo}
        revision={revision}
        drawnBy={drawnBy}
        onRevision={(next) => onRevision?.(next)}
        onDrawnBy={(next) => onDrawnBy?.(next)}
        onPrint={onPrint}
        printDisabled={!hasRoom}
      />

      <section className="show-setup-disclosure">
        <button
          type="button"
          className={`show-setup-collapse${advancedOpen ? ' is-open' : ''}`}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span className="show-setup-phase-index">·</span>
          <span><strong>Advanced &amp; reports</strong><small>Partial kits, recipe files, clearing, and schedules</small></span>
        </button>
        {advancedOpen && (
          <div className="show-setup-advanced-body">
            <div className="field">
              <label htmlFor="show-kit-advanced-select">Layout kit</label>
              <select id="show-kit-advanced-select" value={selectedKit} disabled={kitsBusy || !kits.length} onChange={(event) => setSelectedKit(event.target.value)}>
                {!kits.length && <option value="">No kits available</option>}
                {kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
              </select>
            </div>
            <div className="show-setup-advanced-grid">
              <button type="button" disabled={!editable || !hasRoom || !selectedKit || kitsBusy} onClick={() => selectedKit && onApplyKit?.(selectedKit, { includeStage: false, includeSeating: true, includeGear: false })}>Replace seating</button>
              <button type="button" disabled={!editable || !hasRoom || !selectedKit || kitsBusy} onClick={() => selectedKit && onApplyKit?.(selectedKit, { includeStage: true, includeSeating: false, includeGear: false })}>Add stage only</button>
              <button type="button" disabled={!editable || !hasRoom || kitsBusy} onClick={() => onSaveAsKit?.()}>Save as kit…</button>
              <button type="button" disabled={kitsBusy} onClick={() => onImportKit?.()}>Import kit…</button>
              <button type="button" disabled={!hasRoom || kitsBusy} onClick={() => onExportRecipe?.()}>Export recipe…</button>
              <button type="button" disabled={kitsBusy} onClick={() => onRefreshKits?.()}>Refresh kits</button>
              <button type="button" disabled={!editable || !hasRoom || kitsBusy} onClick={() => onClearSeating?.()}>Clear seating</button>
              <button type="button" disabled={!editable || !hasRoom || kitsBusy} onClick={() => onClearGear?.()}>Clear gear</button>
            </div>

            <div className="show-setup-report-summary">
              <IconRuler size={14} />
              <span>{chairCount.toLocaleString()} chairs · {tableCount.toLocaleString()} tables{allocationSummary ? ` · ${allocationSummary.short} short · ${allocationSummary.untracked} untracked` : ''}</span>
            </div>
            <div className="show-setup-advanced-grid">
              <button type="button" disabled={!hasRoom} onClick={() => onExportSchedule?.()}>Schedule…</button>
              <button type="button" disabled={!hasRoom} onClick={() => onExportHangPlot?.()}>Hang plot…</button>
              <button type="button" disabled={!hasRoom} onClick={() => onExportPullSheet?.()}>Pull sheet…</button>
              <button type="button" disabled={!hasRoom} onClick={() => onExportReport?.()}>Full report…</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
