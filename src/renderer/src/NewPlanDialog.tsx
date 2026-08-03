/**
 * Starting a plan.
 *
 * Room Viewer opens Event Room Data on File → New: identity first, then the
 * room. Those are the questions that cannot wait — a plan with no name is hard
 * to find again, and a room with no size cannot be laid out, dimensioned, or
 * seated. Everything else can be decided later from the Room tab.
 *
 * Two steps keep that order visible. Jumping straight to a Save dialog after a
 * single thin form felt like a missing beat; the stepper names what is left.
 */

import { useEffect, useState } from 'react';

import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { IconDrawPolygon, IconDrawRect, IconPlus } from './icons.js';

const api = window.groundplan;

interface Preset {
  label: string;
  /** In feet, as the presets are stated. */
  width: number;
  depth: number;
}

interface Props {
  units: UnitSystem;
  onCreated: (doc: unknown, options: { startRoomOutline: boolean }) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

const FT = 120;

type Step = 'details' | 'room';

const STEPS: Array<{ id: Step; label: string; blurb: string }> = [
  { id: 'details', label: 'Event', blurb: 'What this plan is for' },
  { id: 'room', label: 'Room', blurb: 'Choose or trace the floor' },
];

export default function NewPlanDialog({ units, onCreated, onCancel, onError }: Props) {
  const [step, setStep] = useState<Step>('details');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('Untitled plan');
  const [venue, setVenue] = useState('');
  const [event, setEvent] = useState('');
  const [date, setDate] = useState('');
  const [contact, setContact] = useState('');
  const [width, setWidth] = useState(() => formatLength(60 * FT, units));
  const [depth, setDepth] = useState(() => formatLength(40 * FT, units));
  const [roomShape, setRoomShape] = useState<'rectangle' | 'custom'>('rectangle');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.roomPresets().then(setPresets);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  const widthUnits = parseLength(width, units);
  const depthUnits = parseLength(depth, units);
  const detailsReady = name.trim().length >= 2;
  const customRoom = roomShape === 'custom';
  const roomReady = customRoom || ((widthUnits ?? 0) > 0 && (depthUnits ?? 0) > 0);

  const choose = (preset: Preset) => {
    if (preset.width <= 0 || preset.depth <= 0) {
      setRoomShape('custom');
      return;
    }
    setRoomShape('rectangle');
    setWidth(formatLength(preset.width * FT, units));
    setDepth(formatLength(preset.depth * FT, units));
  };

  const create = async () => {
    if (!detailsReady || !roomReady) return;
    setBusy(true);
    try {
      const reply = await api.newPlan({
        name: name.trim() || 'Untitled plan',
        width: customRoom ? 0 : (widthUnits ?? 0),
        depth: customRoom ? 0 : (depthUnits ?? 0),
        identity: {
          venue: venue.trim() || undefined,
          event: event.trim() || undefined,
          date: date.trim() || undefined,
          contact: contact.trim() || undefined,
        },
      });
      if (reply.cancelled) return;
      if (!reply.ok || !reply.doc) {
        onError(reply.reason ?? 'the plan could not be created');
        return;
      }
      onCreated(reply.doc, { startRoomOutline: customRoom });
    } finally {
      setBusy(false);
    }
  };

  const goNext = () => {
    if (step === 'details') {
      if (!detailsReady) {
        onError('Enter a plan name of at least two characters.');
        return;
      }
      setStep('room');
      return;
    }
    void create();
  };

  const goBack = () => {
    if (step === 'room') setStep('details');
    else onCancel();
  };

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="sheet new-plan-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-plan-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="new-plan-head">
          <h2 id="new-plan-title">New plan</h2>
          <p>Name the show, choose how its room starts, then save a real Room Viewer file.</p>
        </div>

        <ol className="new-plan-steps" aria-label="New plan steps">
          {STEPS.map((item, index) => {
            const active = item.id === step;
            const done = item.id === 'details' && step === 'room';
            return (
              <li key={item.id} className={active ? 'is-active' : done ? 'is-done' : undefined}>
                <button
                  type="button"
                  disabled={busy || (item.id === 'room' && !detailsReady)}
                  onClick={() => {
                    if (item.id === 'room' && !detailsReady) return;
                    setStep(item.id);
                  }}
                >
                  <span className="new-plan-step-index">{index + 1}</span>
                  <span className="new-plan-step-copy">
                    <strong>{item.label}</strong>
                    <span>{item.blurb}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="new-plan-body">
          {step === 'details' ? (
            <>
              <div className="field">
                <label htmlFor="new-plan-name">Plan / room name</label>
                <input
                  id="new-plan-name"
                  type="text"
                  value={name}
                  autoFocus
                  aria-invalid={name.trim() !== '' && !detailsReady}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && detailsReady) {
                      e.preventDefault();
                      setStep('room');
                    }
                  }}
                />
                <span className="field-help">Shown on the drawing and used as the suggested file name.</span>
              </div>

              <div className="field">
                <label htmlFor="new-plan-venue">Venue</label>
                <input
                  id="new-plan-venue"
                  type="text"
                  value={venue}
                  placeholder="Optional"
                  onChange={(e) => setVenue(e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="new-plan-event">Event</label>
                <input
                  id="new-plan-event"
                  type="text"
                  value={event}
                  placeholder="Optional"
                  onChange={(e) => setEvent(e.target.value)}
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="new-plan-date">Date</label>
                  <input
                    id="new-plan-date"
                    type="text"
                    value={date}
                    placeholder="Optional"
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-plan-contact">Contact</label>
                  <input
                    id="new-plan-contact"
                    type="text"
                    value={contact}
                    placeholder="Optional"
                    onChange={(e) => setContact(e.target.value)}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>Starting room layout</label>
                <div className="new-plan-room-shapes" role="radiogroup" aria-label="Starting room layout">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={roomShape === 'rectangle'}
                    className={roomShape === 'rectangle' ? 'active' : ''}
                    onClick={() => setRoomShape('rectangle')}
                  >
                    <IconDrawRect size={19} />
                    <span>
                      <strong>Sized rectangle</strong>
                      <small>Start from exact dimensions</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={roomShape === 'custom'}
                    className={roomShape === 'custom' ? 'active' : ''}
                    onClick={() => setRoomShape('custom')}
                  >
                    <IconDrawPolygon size={19} />
                    <span>
                      <strong>Custom outline</strong>
                      <small>Trace any room shape next</small>
                    </span>
                  </button>
                </div>
              </div>

              {!customRoom ? (
                <>
                  <div className="field">
                    <label>Common room sizes</label>
                    <div className="preset-grid">
                      {presets.filter((preset) => preset.width > 0 && preset.depth > 0).map((preset) => {
                        const active =
                          Math.abs((widthUnits ?? 0) - preset.width * FT) < 1 &&
                          Math.abs((depthUnits ?? 0) - preset.depth * FT) < 1;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            className={active ? 'preset active' : 'preset'}
                            onClick={() => choose(preset)}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="new-plan-width">Width</label>
                      <input
                        id="new-plan-width"
                        type="text"
                        value={width}
                        autoFocus
                        aria-invalid={width.trim() !== '' && !(widthUnits! > 0)}
                        onChange={(e) => setWidth(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && roomReady && !busy) void create();
                        }}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="new-plan-depth">Depth</label>
                      <input
                        id="new-plan-depth"
                        type="text"
                        value={depth}
                        aria-invalid={depth.trim() !== '' && !(depthUnits! > 0)}
                        onChange={(e) => setDepth(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && roomReady && !busy) void create();
                        }}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="new-plan-custom-guide" role="status">
                  <IconDrawPolygon size={20} />
                  <span>
                    <strong>The custom room tool opens with the new plan</strong>
                    <small>Click each corner in order, then press Enter or choose Finish room. The outline can be angled, concave, or irregular.</small>
                  </span>
                </div>
              )}

              <p className="hint">
                {customRoom
                  ? 'The Room panel opens automatically so layout editing starts immediately.'
                  : 'The rectangular room is drawn immediately and remains fully adjustable from the Room panel.'}
              </p>
              <p className="hint">Next you will choose where to save the `.rv4` file, then the plan opens.</p>
            </>
          )}
        </div>

        <div className="new-plan-foot">
          <button type="button" onClick={goBack} disabled={busy}>
            {step === 'details' ? 'Cancel' : 'Back'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={goNext}
            disabled={busy || (step === 'details' ? !detailsReady : !roomReady)}
          >
            {step === 'details' ? (
              'Continue'
            ) : (
              <>
                <IconPlus size={14} />
                {busy ? 'Creating…' : customRoom ? 'Create & draw…' : 'Create & save…'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
