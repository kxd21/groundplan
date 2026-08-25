/** Room and layout library surfaced beside the live plan canvas. */

import { useEffect, useRef, useState } from 'react';

import {
  IconChair,
  IconDrawPolygon,
  IconFile,
  IconLayers,
  IconPlus,
  IconPrint,
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

/** Pick the bundled kit closest to the room's working scale. */
export function suggestKitForRoom(
  kits: ShowKitInfo[],
  widthFt?: number,
  depthFt?: number,
): string | undefined {
  if (!kits.length) return undefined;
  const w = widthFt ?? 0;
  const d = depthFt ?? 0;
  const area = w * d;
  const by = (re: RegExp) => kits.find((kit) => re.test(`${kit.name} ${kit.id}`));
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
  onExportSchedule,
  onExportReport,
  onExportPullSheet,
  allocationSummary = null,
  completed = {},
}: Props) {
  const suggestedKit = suggestKitForRoom(kits, roomWidthFt, roomDepthFt);
  const [selectedKit, setSelectedKit] = useState('');
  const [draft, setDraft] = useState<PlanIdentityFields>(identity);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const identityDirtyRef = useRef(false);

  useEffect(() => {
    if (!identityDirtyRef.current) setDraft(identity);
  }, [identity.date, identity.venue, identity.event, identity.contact]);

  useEffect(() => {
    setSelectedKit((current) => {
      if (current && kits.some((kit) => kit.id === current)) return current;
      return suggestedKit ?? kits[0]?.id ?? '';
    });
  }, [kits, suggestedKit]);

  const selected = kits.find((kit) => kit.id === selectedKit);
  const dirty = !sameIdentity(draft, identity);
  const identityFilled = Boolean(identity.venue.trim() || identity.event.trim());
  const roomStatus = drawingRoomOutline ? 'drawing' : hasRoom ? 'ready' : 'needed';

  const setField = (key: keyof PlanIdentityFields, value: string) => {
    identityDirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const saveIdentity = () => {
    identityDirtyRef.current = false;
    void onSaveIdentity(draft);
  };

  return (
    <div className="section show-setup-section is-guided">
      <div className="section-title show-setup-title">
        <span>{hasRoom ? 'Layout library' : 'Room boundary'}</span>
        <span className={`show-setup-chip is-${roomStatus}`}>
          {roomStatus === 'ready' ? 'Room ready' : roomStatus === 'drawing' ? 'Drawing room' : 'Room needed'}
        </span>
      </div>

      {!hasRoom && (
        <section className="show-setup-next-card">
          <h3>{drawingRoomOutline ? 'Finish the room boundary' : 'Create the room boundary'}</h3>
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
        <section className="show-setup-next-card">
          <h3>Room-fitted layouts</h3>
          <p>Apply a complete starting point, then edit every object directly on the plan.</p>

          <div className="show-setup-kit-hero">
            <div className="show-setup-kit-hero-head">
              <span><IconLayers size={18} /></span>
              <div><strong>Start from a layout kit</strong><small>Recommended · fitted to this room</small></div>
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

      {hasRoom && (
        <section className="show-setup-next-card is-ready">
          <h3>Output</h3>
          <div className="show-setup-output-summary">
            <strong>{roomSizeText ?? 'Room ready'}</strong>
            <span>{chairCount.toLocaleString()} seats{tableCount ? ` · ${tableCount.toLocaleString()} tables` : ''}{completed.stage ? ' · stage' : ''}</span>
          </div>
          <button type="button" className="btn-primary show-setup-wide-action" onClick={onPrint}>
            <IconPrint size={14} /> {completed.print ? 'Print or export again' : 'Print / export PDF'}
          </button>
        </section>
      )}

      {hasRoom && (
        <section className="show-setup-compact-card">
          <div><strong>Room</strong><small>{roomSizeText ?? 'Boundary ready'}</small></div>
          <div className="show-setup-compact-actions">
            <button type="button" onClick={onOpenRoom}>Edit geometry</button>
            {onOpenBackground && <button type="button" onClick={onOpenBackground}>{hasBackground ? 'Site plan' : 'Add site plan'}</button>}
            {onPlaceDoor && <button type="button" disabled={!editable} onClick={onPlaceDoor}>Door</button>}
            {onPlaceOpening && <button type="button" disabled={!editable} onClick={onPlaceOpening}>Opening</button>}
          </div>
        </section>
      )}

      <section className="show-setup-disclosure">
        <button
          type="button"
          className={`show-setup-collapse${detailsOpen ? ' is-open' : ''}`}
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span className="show-setup-phase-index">·</span>
          <span><strong>Show details</strong><small>{identityFilled ? [identity.venue, identity.event].filter(Boolean).join(' · ') : 'Venue, event, date, and contact'}</small></span>
        </button>
        {detailsOpen && (
          <div className="show-setup-identity">
            {([
              ['venue', 'Venue', 'Venue or building'],
              ['event', 'Event', 'Show or event name'],
              ['date', 'Event date', 'Optional'],
              ['contact', 'Client / contact', 'Optional'],
            ] as const).map(([key, label, placeholder]) => (
              <div className="field" key={key}>
                <label htmlFor={`show-setup-${key}`}>{label}</label>
                <input
                  id={`show-setup-${key}`}
                  value={draft[key]}
                  disabled={!editable || identityBusy}
                  onChange={(event) => setField(key, event.target.value)}
                  onBlur={() => { if (dirty) saveIdentity(); }}
                  placeholder={placeholder}
                />
              </div>
            ))}
            {dirty && <button type="button" className="btn-solid" disabled={!editable || identityBusy} onClick={saveIdentity}>{identityBusy ? 'Saving…' : 'Save details'}</button>}
          </div>
        )}
      </section>

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
              <button type="button" disabled={!hasRoom} onClick={() => onExportPullSheet?.()}>Pull sheet…</button>
              <button type="button" disabled={!hasRoom} onClick={() => onExportReport?.()}>Full report…</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
