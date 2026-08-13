/**
 * Show Setup — room first, then production steps, then optional kits / details.
 * Lives on the Create inspector tab and stays available after New Plan.
 */

import { useEffect, useState } from 'react';

import { IconDrawPolygon, IconPrint, IconRuler } from './icons.js';

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
}

interface Props {
  editable: boolean;
  hasRoom: boolean;
  drawingRoomOutline: boolean;
  identity: PlanIdentityFields;
  selectedCount: number;
  onSaveIdentity: (next: PlanIdentityFields) => void | Promise<void>;
  identityBusy?: boolean;
  onOpenRoom: () => void;
  onDrawRoomOutline: () => void;
  onFinishRoomAsRectangle?: () => void;
  onDiscardEmptyPlan?: () => void;
  onBuildStage: () => void;
  onInsert: () => void;
  onRepeat: () => void;
  onSeating: () => void;
  onPrint: () => void;
  kits?: ShowKitInfo[];
  kitsBusy?: boolean;
  onRefreshKits?: () => void;
  onApplyKit?: (kitId: string) => void;
  onImportKit?: () => void;
  onExportRecipe?: () => void;
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

export default function ShowSetupPanel({
  editable,
  hasRoom,
  drawingRoomOutline,
  identity,
  selectedCount,
  onSaveIdentity,
  identityBusy,
  onOpenRoom,
  onDrawRoomOutline,
  onFinishRoomAsRectangle,
  onDiscardEmptyPlan,
  onBuildStage,
  onInsert,
  onRepeat,
  onSeating,
  onPrint,
  kits = [],
  kitsBusy,
  onRefreshKits,
  onApplyKit,
  onImportKit,
  onExportRecipe,
  completed = {},
}: Props) {
  const [draft, setDraft] = useState<PlanIdentityFields>(identity);
  const [selectedKit, setSelectedKit] = useState<string>('');
  const [kitsOpen, setKitsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    setDraft(identity);
  }, [identity.date, identity.venue, identity.event, identity.contact]);

  useEffect(() => {
    if (!selectedKit && kits[0]) setSelectedKit(kits[0].id);
  }, [kits, selectedKit]);

  const dirty = !sameIdentity(draft, identity);
  const roomStatus = drawingRoomOutline ? 'drawing' : hasRoom ? 'ready' : 'needed';
  const selected = kits.find((k) => k.id === selectedKit);
  const identityFilled = Boolean(identity.venue.trim() || identity.event.trim());

  const setField = (key: keyof PlanIdentityFields, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = () => void onSaveIdentity(draft);

  const nextStep = !hasRoom
    ? 'room'
    : !completed.stage
      ? 'stage'
      : !completed.seating
        ? 'seating'
        : !completed.print
          ? 'print'
          : 'done';

  return (
    <div className="section show-setup-section">
      <div className="section-title">
        <span>Show setup</span>
        <span className={`show-setup-chip is-${roomStatus}`}>
          {roomStatus === 'ready' ? 'Room ready' : roomStatus === 'drawing' ? 'Drawing room' : 'Room needed'}
        </span>
      </div>

      <ol className="show-setup-progress" aria-label="Show progress">
        <li className={hasRoom ? 'is-done' : nextStep === 'room' ? 'is-current' : undefined}>
          <span>1</span>
          Room
        </li>
        <li className={completed.stage ? 'is-done' : nextStep === 'stage' ? 'is-current' : undefined}>
          <span>2</span>
          Stage
        </li>
        <li className={completed.seating ? 'is-done' : nextStep === 'seating' ? 'is-current' : undefined}>
          <span>3</span>
          Seating
        </li>
        <li className={completed.print ? 'is-done' : nextStep === 'print' ? 'is-current' : undefined}>
          <span>4</span>
          Print
        </li>
      </ol>

      <div className="show-setup-phase">
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">{hasRoom && !drawingRoomOutline ? '✓' : '1'}</span>
          <div>
            <strong>Build the room</strong>
            <small>
              {hasRoom && !drawingRoomOutline
                ? 'Boundary is in place.'
                : 'Click corners on the plan, or finish as a rectangle.'}
            </small>
          </div>
        </div>
        {hasRoom && !drawingRoomOutline ? (
          <div className="show-setup-ready">
            <div className="show-setup-actions">
              <button type="button" className="link-btn" onClick={onOpenRoom}>
                Open Room panel
              </button>
            </div>
          </div>
        ) : (
          <div className="show-setup-actions">
            <button type="button" className="btn-solid" disabled={!editable} onClick={onDrawRoomOutline}>
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
                : 'Optional — venue, event, date for print'}
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
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">2</span>
          <div>
            <strong>Set up the show</strong>
            <small>
              {hasRoom
                ? nextStep === 'stage'
                  ? 'Next: build the stage.'
                  : nextStep === 'seating'
                    ? 'Next: place seating.'
                    : nextStep === 'print'
                      ? 'Next: print setup.'
                      : 'Build piece by piece — stage, objects, seating, then print.'
                : 'Finish the room outline first.'}
            </small>
          </div>
        </div>
        <div className="create-flow-steps">
          <button
            type="button"
            className={`create-flow-step${completed.stage ? ' is-done' : ''}${nextStep === 'stage' ? ' is-next' : ''}`}
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
            <strong>Insert objects</strong>
            <span>Screens, tables, chairs — then Done placing</span>
          </button>
          <button
            type="button"
            className={`create-flow-step${completed.repeat ? ' is-done' : ''}`}
            disabled={!editable || !hasRoom || selectedCount !== 1}
            onClick={onRepeat}
            title={selectedCount === 1 ? 'Open Properties to Repeat' : 'Select one item first'}
          >
            <strong>Repeat across</strong>
            <span>Tile one deck or riser from Properties</span>
          </button>
          <button
            type="button"
            className={`create-flow-step${completed.seating ? ' is-done' : ''}${nextStep === 'seating' ? ' is-next' : ''}`}
            disabled={!editable || !hasRoom}
            onClick={onSeating}
          >
            <strong>Seating</strong>
            <span>Theatre, classroom, or banquet layout</span>
          </button>
          <button
            type="button"
            className={`create-flow-step${completed.print ? ' is-done' : ''}${nextStep === 'print' ? ' is-next' : ''}`}
            disabled={!hasRoom}
            onClick={onPrint}
          >
            <strong className="show-setup-print-label">
              <IconPrint size={12} /> Print setup
            </strong>
            <span>Scale, sheet, and PDF export</span>
          </button>
        </div>
        {!hasRoom && (
          <p className="hint">
            <IconRuler size={12} /> Production steps unlock once the room boundary is drawn.
          </p>
        )}
      </div>

      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        <button
          type="button"
          className={`show-setup-collapse${kitsOpen ? ' is-open' : ''}`}
          aria-expanded={kitsOpen}
          onClick={() => setKitsOpen((open) => !open)}
        >
          <span className="show-setup-phase-index">·</span>
          <span>
            <strong>Show kits</strong>
            <small>Optional — boardroom (~20) through arena / Card Party recipes</small>
          </span>
        </button>
        {kitsOpen && (
          <>
            <div className="field">
              <label htmlFor="show-kit-select">Kit</label>
              <select
                id="show-kit-select"
                value={selectedKit}
                disabled={!editable || kitsBusy || !kits.length}
                onChange={(e) => setSelectedKit(e.target.value)}
              >
                {!kits.length ? <option value="">No kits yet</option> : null}
                {kits.map((kit) => (
                  <option key={kit.id} value={kit.id}>
                    {kit.name} · {kit.chairs.toLocaleString()} chairs · {kit.banks} banks
                    {kit.source === 'bundled' ? ' (bundled)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {selected ? (
              <p className="hint" style={{ marginBottom: 8 }}>
                {selected.venue ? `${selected.venue} · ` : ''}
                {selected.gear} gear spots · {selected.source}
              </p>
            ) : null}
            <div className="show-setup-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className="btn-solid"
                disabled={!editable || !hasRoom || !selectedKit || kitsBusy}
                onClick={() => selectedKit && onApplyKit?.(selectedKit)}
              >
                {kitsBusy ? 'Applying…' : 'Apply kit'}
              </button>
              <button type="button" className="btn-outline" disabled={kitsBusy} onClick={() => onImportKit?.()}>
                Import recipe…
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={!hasRoom || kitsBusy}
                onClick={() => onExportRecipe?.()}
              >
                Export recipe…
              </button>
              <button type="button" className="link-btn" disabled={kitsBusy} onClick={() => onRefreshKits?.()}>
                Refresh
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
