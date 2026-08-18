/**
 * Show Setup — room first, then apply a matching kit (or build by hand), then print.
 * Lives on the Create inspector tab and stays available after New Plan.
 */

import { useEffect, useRef, useState } from 'react';

import { IconCheck, IconDrawPolygon, IconFile, IconPrint, IconRuler } from './icons.js';

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
  variantOf?: string;
}

interface Props {
  editable: boolean;
  hasRoom: boolean;
  drawingRoomOutline: boolean;
  identity: PlanIdentityFields;
  selectedCount?: number;
  onSaveIdentity: (next: PlanIdentityFields) => void | Promise<void>;
  identityBusy?: boolean;
  /** Room size summary from the plan model (includes ceiling when set). */
  roomSizeText?: string | null;
  onOpenRoom: () => void;
  onDrawRoomOutline: () => void;
  /** Open Background Studio for site plan / CAD underlay. */
  onOpenBackground?: () => void;
  hasBackground?: boolean;
  onFinishRoomAsRectangle?: () => void;
  onDiscardEmptyPlan?: () => void;
  onBuildStage: () => void;
  onInsert: () => void;
  onRepeat?: () => void;
  onSeating: () => void;
  onPrint: () => void;
  kits?: ShowKitInfo[];
  kitsBusy?: boolean;
  /** Room size in feet — used to pick a matching kit. */
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
  /** Arm door / opening stamp (snaps to walls). */
  onPlaceDoor?: () => void;
  onPlaceOpening?: () => void;
  /** Live furniture tallies for the report strip. */
  chairCount?: number;
  tableCount?: number;
  onExportSchedule?: () => void;
  onExportReport?: () => void;
  onExportPullSheet?: () => void;
  allocationSummary?: { short: number; ok: number; untracked: number } | null;
  completed?: {
    stage?: boolean;
    insert?: boolean;
    repeat?: boolean;
    seating?: boolean;
    print?: boolean;
  };
}

function sameIdentity(a: PlanIdentityFields, b: PlanIdentityFields): boolean {
  return a.date === b.date && a.venue === b.venue && a.event === b.event && a.contact === b.contact;
}

/** Pick the bundled kit that matches this room, so Apply is one click. */
export function suggestKitForRoom(
  kits: ShowKitInfo[],
  widthFt?: number,
  depthFt?: number,
): string | undefined {
  if (!kits.length) return undefined;
  const w = widthFt ?? 0;
  const d = depthFt ?? 0;
  const area = w * d;
  const by = (re: RegExp) => kits.find((k) => re.test(`${k.name} ${k.id}`));
  if (w > 0 && w <= 24 && d <= 20) return by(/boardroom/i)?.id;
  if (area > 0 && area <= 2800) return by(/banquet/i)?.id;
  if (area > 0 && area <= 28000) return by(/arena|concert/i)?.id;
  return by(/card.?party/i)?.id ?? kits[kits.length - 1]?.id;
}

export default function ShowSetupPanel({
  editable,
  hasRoom,
  drawingRoomOutline,
  identity,
  onSaveIdentity,
  identityBusy,
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
  kits = [],
  kitsBusy,
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
  onExportSchedule,
  onExportReport,
  onExportPullSheet,
  allocationSummary = null,
  completed = {},
  roomWidthFt,
  roomDepthFt,
}: Props) {
  const suggestedKit = suggestKitForRoom(kits, roomWidthFt, roomDepthFt);
  const [draft, setDraft] = useState<PlanIdentityFields>(identity);
  const [selectedKit, setSelectedKit] = useState<string>('');
  const identityDirtyRef = useRef(false);
  const layoutDone = !!(completed.stage && completed.seating);
  // Open while there is still a layout to make; closed once there is one. The
  // kit chooser was always expanded, so a finished show opened onto controls
  // for work it had already done.
  const [kitsOpen, setKitsOpen] = useState(true);
  const [buildOpen, setBuildOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (layoutDone) setKitsOpen(false);
  }, [layoutDone]);

  useEffect(() => {
    if (identityDirtyRef.current) return;
    setDraft(identity);
  }, [identity.date, identity.venue, identity.event, identity.contact]);

  useEffect(() => {
    setSelectedKit((current) => {
      if (current && kits.some((k) => k.id === current)) return current;
      return suggestedKit ?? kits[0]?.id ?? '';
    });
  }, [suggestedKit, kits]);

  const dirty = !sameIdentity(draft, identity);
  const roomStatus = drawingRoomOutline ? 'drawing' : hasRoom ? 'ready' : 'needed';
  const selected = kits.find((k) => k.id === selectedKit);
  const identityFilled = Boolean(identity.venue.trim() || identity.event.trim());

  const setField = (key: keyof PlanIdentityFields, value: string) => {
    identityDirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = () => {
    identityDirtyRef.current = false;
    void onSaveIdentity(draft);
  };

  const nextStep = !hasRoom ? 'room' : !layoutDone ? 'layout' : !completed.print ? 'print' : 'done';

  const settledRef = useRef(false);
  useEffect(() => {
    // Fold the layout tools away the moment a layout exists, once, so a later
    // manual re-open is not fought on the next render.
    if (layoutDone && !settledRef.current) {
      settledRef.current = true;
      setKitsOpen(false);
      setBuildOpen(false);
    }
    if (!layoutDone) settledRef.current = false;
  }, [layoutDone]);

  return (
    <div className="section show-setup-section">
      <div className="section-title">
        <span>Setup</span>
        {/* The chip is the room's state in one word. Once the summary card below
            is showing "60' x 40' x 18' ceiling · 120 seats", it is saying the
            same thing twice, so it stands down. */}
        {!layoutDone && (
          <span className={`show-setup-chip is-${roomStatus}`}>
            {roomStatus === 'ready' ? 'Room ready' : roomStatus === 'drawing' ? 'Drawing room' : 'Room needed'}
          </span>
        )}
      </div>

      {layoutDone ? (
        /* What the show IS, and the only thing left to do with it. A finished
           banquet used to be met by a 1-2-3 ladder with every rung ticked. */
        <div className="show-setup-summary">
          <div className="show-setup-summary-facts">
            <strong>{roomSizeText ?? 'Room ready'}</strong>
            <span>
              {chairCount.toLocaleString()} {chairCount === 1 ? 'seat' : 'seats'}
              {tableCount > 0
                ? ` · ${tableCount.toLocaleString()} ${tableCount === 1 ? 'table' : 'tables'}`
                : ''}
              {completed.stage ? ' · stage' : ''}
            </span>
          </div>
          <button
            type="button"
            className="btn-primary show-setup-summary-print"
            disabled={!hasRoom}
            onClick={onPrint}
          >
            <IconPrint size={13} />
            {completed.print ? 'Print again' : 'Print to PDF'}
          </button>
        </div>
      ) : (
        <ol className="show-setup-progress" aria-label="Show progress">
          <li className={hasRoom ? 'is-done' : nextStep === 'room' ? 'is-current' : undefined}>
            <span>1</span>
            Room
          </li>
          <li className={hasRoom ? 'is-current' : undefined}>
            <span>2</span>
            Layout
          </li>
          <li>
            <span>3</span>
            Print
          </li>
        </ol>
      )}

      <div className="show-setup-phase">
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">{hasRoom && !drawingRoomOutline ? <IconCheck size={12} /> : '1'}</span>
          <div>
            <strong>Build the room</strong>
            <small>
              {hasRoom && !drawingRoomOutline
                ? roomSizeText
                  ? `Boundary in place · ${roomSizeText}`
                  : 'Boundary is in place.'
                : hasBackground
                  ? 'Site plan is under the plot. Click corners to trace walls.'
                  : 'Trace on a blank sheet, or add a site plan / CAD PDF first.'}
            </small>
          </div>
        </div>
        {hasRoom && !drawingRoomOutline ? (
          <div className="show-setup-ready">
            <div className="show-setup-actions">
              <button type="button" className="link-btn" onClick={onOpenRoom}>
                Edit room
              </button>
              {onOpenBackground && (
                <button type="button" className="link-btn" onClick={onOpenBackground}>
                  {hasBackground ? 'Edit site plan' : 'Add site plan'}
                </button>
              )}
              {onPlaceDoor && (
                <button type="button" className="link-btn" disabled={!editable} onClick={onPlaceDoor}>
                  Door
                </button>
              )}
              {onPlaceOpening && (
                <button type="button" className="link-btn" disabled={!editable} onClick={onPlaceOpening}>
                  Opening
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="show-setup-actions">
            {onOpenBackground && (
              <button
                type="button"
                className={hasBackground ? 'btn-outline' : 'btn-solid'}
                disabled={!editable}
                onClick={onOpenBackground}
              >
                <IconFile size={14} />
                {hasBackground ? 'Edit site plan' : 'Add site plan / PDF'}
              </button>
            )}
            <button
              type="button"
              className={hasBackground || !onOpenBackground ? 'btn-solid is-next' : 'btn-outline'}
              disabled={!editable}
              onClick={onDrawRoomOutline}
            >
              <IconDrawPolygon size={14} />
              {drawingRoomOutline ? 'Cancel outline' : 'Draw room outline'}
            </button>
            {onFinishRoomAsRectangle && (
              <button type="button" className="btn-outline" disabled={!editable} onClick={onFinishRoomAsRectangle}>
                Finish as rectangle
              </button>
            )}
            {onDiscardEmptyPlan && !hasRoom && (
              <button type="button" className="link-btn is-danger" onClick={onDiscardEmptyPlan}>
                Discard empty plan
              </button>
            )}
          </div>
        )}
      </div>

      <div className="show-setup-phase">
        <button
          type="button"
          className={`show-setup-collapse${detailsOpen || identityFilled ? ' is-open' : ''}`}
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span className="show-setup-phase-index">·</span>
          <span>
            <strong>Show details</strong>
            <small>
              {identityFilled
                ? [identity.venue, identity.event].filter(Boolean).join(' · ')
                : 'Optional: venue, event, date for print'}
            </small>
          </span>
        </button>
        {detailsOpen && (
          <>
            <div className="show-setup-identity">
              <div className="field">
                <label htmlFor="show-setup-venue">Venue</label>
                <input
                  id="show-setup-venue"
                  value={draft.venue}
                  disabled={!editable || identityBusy}
                  onChange={(e) => setField('venue', e.target.value)}
                  onBlur={() => {
                    if (dirty) save();
                  }}
                  placeholder="Venue or building"
                />
              </div>
              <div className="field">
                <label htmlFor="show-setup-event">Event</label>
                <input
                  id="show-setup-event"
                  value={draft.event}
                  disabled={!editable || identityBusy}
                  onChange={(e) => setField('event', e.target.value)}
                  onBlur={() => {
                    if (dirty) save();
                  }}
                  placeholder="Show or event name"
                />
              </div>
              <div className="field">
                <label htmlFor="show-setup-date">Event date</label>
                <input
                  id="show-setup-date"
                  value={draft.date}
                  disabled={!editable || identityBusy}
                  onChange={(e) => setField('date', e.target.value)}
                  onBlur={() => {
                    if (dirty) save();
                  }}
                  placeholder="Optional"
                />
              </div>
              <div className="field">
                <label htmlFor="show-setup-contact">Client / contact</label>
                <input
                  id="show-setup-contact"
                  value={draft.contact}
                  disabled={!editable || identityBusy}
                  onChange={(e) => setField('contact', e.target.value)}
                  onBlur={() => {
                    if (dirty) save();
                  }}
                  placeholder="Optional"
                />
              </div>
            </div>
            {dirty && (
              <div className="show-setup-actions">
                <button
                  type="button"
                  className="btn-solid"
                  disabled={!editable || identityBusy}
                  onClick={save}
                >
                  {identityBusy ? 'Saving…' : 'Save show details'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        <button
          type="button"
          className={`show-setup-collapse${kitsOpen ? ' is-open' : ''}`}
          aria-expanded={kitsOpen}
          onClick={() => setKitsOpen((open) => !open)}
        >
          <span className="show-setup-phase-index">{layoutDone ? <IconCheck size={12} /> : '2'}</span>
          <span>
            <strong>Start from a kit</strong>
            <small>
              {layoutDone
                ? 'Layout applied: tweak on the plan or apply another kit'
                : selected
                  ? `Fast path: ${selected.name}${
                      selected.id === suggestedKit ? ' · fits this room' : ' · will fit to this room'
                    }`
                  : 'Drop in a matching layout (fitted to this room), then tweak'}
            </small>
          </span>
        </button>
        {kitsOpen && (
          <>
            <div className="field">
              <label htmlFor="show-kit-select">Kit</label>
              <select
                id="show-kit-select"
                className="show-setup-kit-select"
                value={selectedKit}
                disabled={!editable || kitsBusy || !kits.length}
                title={
                  selected
                    ? `${selected.name} · ${selected.chairs.toLocaleString()} chairs · ${selected.banks} banks${
                        selected.id === suggestedKit ? ' · matches this room' : ''
                      }`
                    : undefined
                }
                onChange={(e) => setSelectedKit(e.target.value)}
              >
                {!kits.length ? <option value="">No kits yet</option> : null}
                {kits.map((kit) => {
                  const variantLabel = kit.capacityGuests
                    ? ` · ${kit.capacityGuests.toLocaleString()} guests`
                    : kit.variantOf
                      ? ' · variant'
                      : '';
                  return (
                    <option
                      key={kit.id}
                      value={kit.id}
                      title={`${kit.name}${variantLabel} · ${kit.chairs.toLocaleString()} chairs · ${kit.banks} banks`}
                    >
                      {kit.name}
                      {variantLabel}
                      {kit.id === suggestedKit ? ' · fits room' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
            {selected ? (
              <p className="hint show-setup-kit-meta" style={{ marginBottom: 8 }}>
                {selected.chairs.toLocaleString()} chairs · {selected.banks} banks
                {selected.venue ? ` · ${selected.venue}` : ''}
                {selected.gear ? ` · ${selected.gear} gear` : ''}
                {` · ${selected.source}`}
                {selected.id === suggestedKit ? ' · sized for this room' : ''}
              </p>
            ) : null}
            <div className="show-setup-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className={`btn-solid${hasRoom && !layoutDone ? ' is-next' : ''}`}
                disabled={!editable || !hasRoom || !selectedKit || kitsBusy}
                onClick={() => selectedKit && onApplyKit?.(selectedKit)}
              >
                {kitsBusy ? 'Applying…' : 'Apply kit'}
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={!editable || !hasRoom || !selectedKit || kitsBusy}
                onClick={() =>
                  selectedKit &&
                  onApplyKit?.(selectedKit, {
                    includeStage: false,
                    includeSeating: true,
                    includeGear: false,
                  })
                }
                title="Replace chairs and tables only: keep stage and gear"
              >
                Seating only
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={!editable || !hasRoom || !selectedKit || kitsBusy}
                onClick={() =>
                  selectedKit &&
                  onApplyKit?.(selectedKit, {
                    includeStage: true,
                    includeSeating: false,
                    includeGear: false,
                  })
                }
                title="Add the kit stage without changing seating"
              >
                Stage only
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={!editable || !hasRoom || kitsBusy}
                onClick={() => onSaveAsKit?.()}
                title="Save this plan’s layout as a reusable kit"
              >
                Save kit…
              </button>
              <button type="button" className="btn-outline" disabled={kitsBusy} onClick={() => onImportKit?.()}>
                Import…
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={!hasRoom || kitsBusy}
                onClick={() => onExportRecipe?.()}
              >
                Export…
              </button>
              <button type="button" className="link-btn" disabled={kitsBusy} onClick={() => onRefreshKits?.()}>
                Refresh
              </button>
            </div>
            <div className="show-setup-actions" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                className="link-btn"
                disabled={!editable || !hasRoom || kitsBusy}
                onClick={() => onClearSeating?.()}
              >
                Clear seating
              </button>
              <button
                type="button"
                className="link-btn"
                disabled={!editable || !hasRoom || kitsBusy}
                onClick={() => onClearGear?.()}
              >
                Clear gear
              </button>
            </div>
          </>
        )}
      </div>

      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        {/* A disclosure now: on a finished plan these are not steps to take,
            they are ways to change what is already there — and the heading says
            which of the two situations you are in. */}
        <button
          type="button"
          className={`show-setup-collapse${buildOpen ? ' is-open' : ''}`}
          aria-expanded={buildOpen}
          disabled={!hasRoom}
          onClick={() => setBuildOpen((open) => !open)}
        >
          <span className="show-setup-phase-index">·</span>
          <span>
            <strong>{layoutDone ? 'Change the layout' : 'Or build it yourself'}</strong>
            <small>
              {hasRoom
                ? layoutDone
                  ? 'Stage, objects, and seating on the plan you have.'
                  : 'Stage, objects, and seating if you are not using a kit.'
                : 'Finish the room outline first.'}
            </small>
          </span>
        </button>
        {buildOpen && (
        <div className="create-flow-steps">
          <button
            type="button"
            className={`create-flow-step${completed.stage ? ' is-done' : ''}`}
            disabled={!editable || !hasRoom}
            onClick={onBuildStage}
          >
            <strong>Build a stage</strong>
            <span>House risers, deck tiling, and stairs</span>
          </button>
          <button
            type="button"
            className={`create-flow-step${completed.insert ? ' is-done' : ''}`}
            disabled={!editable || !hasRoom}
            onClick={onInsert}
          >
            <strong>Place objects</strong>
            <span>Screens, tables, chairs from Place mode</span>
          </button>
          <button
            type="button"
            className={`create-flow-step${completed.seating ? ' is-done' : ''}`}
            disabled={!editable || !hasRoom}
            onClick={onSeating}
          >
            <strong>Seating planner</strong>
            <span>Refill the whole floor with aisles and a live count</span>
          </button>
        </div>
        )}
        {!hasRoom && (
          <p className="hint">
            <IconRuler size={12} /> Production steps unlock once the room boundary is drawn.
          </p>
        )}
      </div>

      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">·</span>
          <div>
            <strong>Counts &amp; reports</strong>
            <small>
              {hasRoom
                ? `${chairCount.toLocaleString()} chairs · ${tableCount.toLocaleString()} tables${
                    allocationSummary
                      ? ` · ${allocationSummary.short} short · ${allocationSummary.untracked} untracked`
                      : ''
                  }`
                : 'Available once the room and layout exist.'}
            </small>
          </div>
        </div>
        <div className="show-setup-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="btn-outline" disabled={!hasRoom} onClick={() => onExportSchedule?.()}>
            Export schedule…
          </button>
          <button type="button" className="btn-outline" disabled={!hasRoom} onClick={() => onExportPullSheet?.()}>
            Export pull sheet…
          </button>
          <button type="button" className="btn-outline" disabled={!hasRoom} onClick={() => onExportReport?.()}>
            Export report…
          </button>
        </div>
      </div>

      {/* Only while there is no summary card. Once the layout is done the card
          at the top carries Print, and two of them on one panel is one too
          many. */}
      {!layoutDone && (
      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        <div className="create-flow-steps">
          <button
            type="button"
            className={`create-flow-step${completed.print ? ' is-done' : ''}`}
            disabled={!hasRoom}
            onClick={onPrint}
          >
            <strong className="show-setup-print-label">
              <IconPrint size={12} /> Print to PDF
            </strong>
            <span>Title block, multi-sheet at scale, export</span>
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
