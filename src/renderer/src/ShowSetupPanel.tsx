/**
 * Show Setup — room first, then show identity, then production steps.
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
  onBuildStage: () => void;
  onInsert: () => void;
  onRepeat: () => void;
  onSeating: () => void;
  onPrint: () => void;
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
  onBuildStage,
  onInsert,
  onRepeat,
  onSeating,
  onPrint,
  completed = {},
}: Props) {
  const [draft, setDraft] = useState<PlanIdentityFields>(identity);

  useEffect(() => {
    setDraft(identity);
  }, [identity.date, identity.venue, identity.event, identity.contact]);

  const dirty = !sameIdentity(draft, identity);
  const roomStatus = drawingRoomOutline ? 'drawing' : hasRoom ? 'ready' : 'needed';

  const setField = (key: keyof PlanIdentityFields, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = () => void onSaveIdentity(draft);

  return (
    <div className="section show-setup-section">
      <div className="section-title">
        <span>Show setup</span>
        <span className={`show-setup-chip is-${roomStatus}`}>
          {roomStatus === 'ready' ? 'Room ready' : roomStatus === 'drawing' ? 'Drawing room' : 'Room needed'}
        </span>
      </div>

      <div className="show-setup-phase">
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">1</span>
          <div>
            <strong>Build the room</strong>
            <small>Outline must exist before stage, seating, or print make sense.</small>
          </div>
        </div>
        {hasRoom && !drawingRoomOutline ? (
          <p className="hint show-setup-ok">Boundary is in place — continue with show details below.</p>
        ) : (
          <div className="show-setup-actions">
            <button type="button" className="btn-outline" disabled={!editable} onClick={onDrawRoomOutline}>
              <IconDrawPolygon size={14} />
              {drawingRoomOutline ? 'Cancel outline' : 'Draw room outline'}
            </button>
            <button type="button" className="link-btn" onClick={onOpenRoom}>
              Open Room panel
            </button>
          </div>
        )}
      </div>

      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">2</span>
          <div>
            <strong>Show details</strong>
            <small>Editable anytime — written into the plan trailer for print and reports.</small>
          </div>
        </div>
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
        <div className="show-setup-actions">
          <button
            type="button"
            className="btn-solid"
            disabled={!editable || identityBusy || !dirty}
            onClick={save}
          >
            {identityBusy ? 'Saving…' : 'Save show details'}
          </button>
        </div>
      </div>

      <div className={`show-setup-phase${hasRoom ? '' : ' is-gated'}`}>
        <div className="show-setup-phase-head">
          <span className="show-setup-phase-index">3</span>
          <div>
            <strong>Set up the show</strong>
            <small>{hasRoom ? 'Stage, objects, seating, then print.' : 'Finish the room outline first.'}</small>
          </div>
        </div>
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
            className={`create-flow-step${completed.seating ? ' is-done' : ''}`}
            disabled={!editable || !hasRoom}
            onClick={onSeating}
          >
            <strong>Seating</strong>
            <span>Theatre, classroom, or banquet layout</span>
          </button>
          <button
            type="button"
            className={`create-flow-step${completed.print ? ' is-done' : ''}`}
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
    </div>
  );
}
