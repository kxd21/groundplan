/**
 * Build a Stage — single or two-tier house risers, stock deck tiling, stairs.
 */

import { useEffect, useMemo, useState } from 'react';

import { DECK_SIZES, type StairEdge } from '../../format/stage.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../../format/rv.js';

const api = window.groundplan;

const RISER_PRESETS = [
  { id: '4x8', label: "4′ × 8′", width: 8 * UNITS_PER_FOOT, depth: 4 * UNITS_PER_FOOT },
  { id: '6x8', label: "6′ × 8′", width: 6 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
  { id: '8x4', label: "8′ × 4′", width: 4 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
  { id: '8x6', label: "8′ × 6′", width: 8 * UNITS_PER_FOOT, depth: 6 * UNITS_PER_FOOT },
  { id: 'house-42', label: "House 8′ × 42′", width: 42 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
  { id: 'circ', label: '8′ round', width: 8 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
];

const STAIR_OPTIONS: Array<{ id: string; label: string; short: string; edges: StairEdge[] }> = [
  { id: 'front', label: 'Front', short: 'Front', edges: ['front'] },
  { id: 'sides', label: 'Left & right', short: 'Sides', edges: ['left', 'right'] },
  { id: 'left', label: 'Left only', short: 'Left', edges: ['left'] },
  { id: 'right', label: 'Right only', short: 'Right', edges: ['right'] },
  { id: 'none', label: 'None', short: 'None', edges: [] },
];

interface Props {
  open: boolean;
  units: UnitSystem;
  origin: { x: number; y: number };
  disabled?: boolean;
  onClose: () => void;
  onBuilt: (doc?: unknown, created?: number[]) => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

export default function BuildStageDialog({
  open,
  units,
  origin,
  disabled,
  onClose,
  onBuilt,
  onError,
  onStatus,
}: Props) {
  const [preset, setPreset] = useState(RISER_PRESETS[0]!.id);
  const [tiered, setTiered] = useState(false);
  const [widthText, setWidthText] = useState(() => formatLength(24 * UNITS_PER_FOOT, units));
  const [depthText, setDepthText] = useState(() => formatLength(16 * UNITS_PER_FOOT, units));
  const [heightText, setHeightText] = useState(() => formatLength(24 * UNITS_PER_INCH, units));
  const [backDepthText, setBackDepthText] = useState(() => formatLength(8 * UNITS_PER_FOOT, units));
  const [backHeightText, setBackHeightText] = useState(() => formatLength(24 * UNITS_PER_INCH, units));
  const [stairs, setStairs] = useState('front');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Single-deck default — house/tiered presets are one click away.
    // Resetting to house-42 on every open made custom W×D×H easy to miss.
    setPreset('4x8');
    setTiered(false);
    setWidthText(formatLength(24 * UNITS_PER_FOOT, units));
    setDepthText(formatLength(16 * UNITS_PER_FOOT, units));
    setHeightText(formatLength(24 * UNITS_PER_INCH, units));
    setBackDepthText(formatLength(8 * UNITS_PER_FOOT, units));
    setBackHeightText(formatLength(24 * UNITS_PER_INCH, units));
    setStairs('front');
    setBusy(false);
  }, [open, units]);

  const isCircular = preset === 'circ';

  const summary = useMemo(() => {
    const width = parseLength(widthText, units);
    const depth = parseLength(depthText, units);
    const height = parseLength(heightText, units);
    if (!(width && depth && height)) return 'Enter width, depth, and height';
    if (isCircular) {
      return `${formatLength(Math.max(width, depth), units)} circular deck · no stairs`;
    }
    const stairLabel = STAIR_OPTIONS.find((s) => s.id === stairs)?.label ?? 'None';
    if (tiered) {
      const backDepth = parseLength(backDepthText, units);
      const backHeight = parseLength(backHeightText, units);
      const total =
        depth && backDepth ? formatLength(depth + backDepth, units) : formatLength(depth, units);
      return (
        `${formatLength(width, units)} wide · ${total} deep` +
        (backHeight ? ` · ${formatLength(height, units)} / ${formatLength(backHeight, units)}` : '') +
        ` · stairs ${stairLabel.toLowerCase()}`
      );
    }
    return `${formatLength(width, units)} × ${formatLength(depth, units)} × ${formatLength(height, units)} · stairs ${stairLabel.toLowerCase()}`;
  }, [
    widthText,
    depthText,
    heightText,
    backDepthText,
    backHeightText,
    stairs,
    tiered,
    isCircular,
    units,
  ]);

  if (!open) return null;

  const applyPreset = (id: string) => {
    setPreset(id);
    const row = RISER_PRESETS.find((p) => p.id === id);
    if (!row) return;
    setWidthText(formatLength(row.width, units));
    setDepthText(formatLength(row.depth, units));
    if (id === 'house-42') {
      setTiered(true);
      setHeightText(formatLength(32 * UNITS_PER_INCH, units));
      setBackDepthText(formatLength(8 * UNITS_PER_FOOT, units));
      setBackHeightText(formatLength(24 * UNITS_PER_INCH, units));
      setStairs('sides');
    } else if (id === 'circ') {
      setTiered(false);
      setHeightText(formatLength(24 * UNITS_PER_INCH, units));
      setStairs('none');
    } else {
      // Stock single-deck presets — leave custom height alone only if already
      // editing; otherwise reset to a common 24″ deck with front stairs.
      setTiered(false);
      setHeightText(formatLength(24 * UNITS_PER_INCH, units));
      setStairs('front');
    }
  };

  const build = async () => {
    const width = parseLength(widthText, units);
    const depth = parseLength(depthText, units);
    const height = parseLength(heightText, units);
    if (!(width && width > 0) || !(depth && depth > 0) || !(height && height > 0)) {
      onError('Enter width, depth, and deck height');
      return;
    }
    let back: { depth: number; height: number } | undefined;
    if (tiered && !isCircular) {
      const backDepth = parseLength(backDepthText, units);
      const backHeight = parseLength(backHeightText, units);
      if (!(backDepth && backDepth > 0) || !(backHeight && backHeight > 0)) {
        onError('Enter back-tier depth and height');
        return;
      }
      back = { depth: backDepth, height: backHeight };
    }
    const stairEdges = isCircular
      ? []
      : (STAIR_OPTIONS.find((s) => s.id === stairs)?.edges ?? []);
    setBusy(true);
    try {
      if (isCircular) {
        const diameter = Math.max(width, depth);
        const label =
          units === 'metric'
            ? `Circular deck ${formatLength(diameter, units)}`
            : `${Math.round(diameter / UNITS_PER_FOOT)}' Circular deck`;
        const reply = await api.placeGear(label, origin.x, origin.y);
        if (!reply.ok) {
          onError(reply.reason ?? 'circular deck could not be placed');
          return;
        }
        let doc = reply.doc;
        let created = reply.created;
        if (reply.created?.[0] != null) {
          const sized = await api.resize(reply.created[0], diameter, diameter);
          if (sized.ok) {
            doc = sized.doc ?? doc;
            created = sized.created ?? created;
          }
        }
        onStatus(`Placed ${formatLength(diameter, units)} circular deck`);
        onBuilt(doc, created);
        onClose();
        return;
      }

      const reply = await api.stageAdd(
        origin.x - width / 2,
        origin.y,
        width,
        depth,
        height,
        back,
        stairEdges,
      );
      if (!reply.ok) {
        onError(reply.reason ?? 'stage could not be built');
        return;
      }
      const warn = Array.isArray(reply.warnings) ? reply.warnings.filter(Boolean) : [];
      if (warn.length) {
        onStatus(`${reply.note ?? 'Stage added'}: ${warn.join(' · ')}`);
      } else {
        onStatus(reply.note ?? 'Stage added');
      }
      onBuilt(reply.doc, reply.created);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="sheet stage-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Build a Stage"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault();
            if (!busy && !disabled) void build();
          }
        }}
      >
        <div className="sheet-title">
          <div className="stage-sheet-heading">
            <h2>Build a Stage</h2>
            <p>Stock decks tile automatically · place at the front of the room</p>
          </div>
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          <div className="stage-section">
            <span className="tool-label">Preset</span>
            <div className="stage-preset-grid" role="listbox" aria-label="Riser presets">
              {RISER_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={preset === p.id}
                  className={`stage-preset${preset === p.id ? ' is-on' : ''}`}
                  disabled={disabled || busy}
                  onClick={() => applyPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="hint stage-deck-hint">
              Tiles with {DECK_SIZES.map((d) => d.label).join(', ')}
            </p>
          </div>

          {!isCircular && (
            <label className={`check-row stage-tier-toggle${tiered ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                checked={tiered}
                disabled={disabled || busy}
                onChange={(e) => setTiered(e.target.checked)}
              />
              <span>
                <strong>Two tiers</strong>
                <small>Front house riser + taller back riser</small>
              </span>
            </label>
          )}

          <div className="stage-section">
            <span className="tool-label">Size</span>
            <div className="field-row">
              <div className="field">
                <label htmlFor="bs-w">{isCircular ? 'Diameter' : 'Width'}</label>
                <input
                  id="bs-w"
                  value={widthText}
                  disabled={disabled || busy}
                  onChange={(e) => {
                    setWidthText(e.target.value);
                    if (isCircular) setDepthText(e.target.value);
                  }}
                />
              </div>
              {!isCircular && (
                <div className="field">
                  <label htmlFor="bs-d">{tiered ? 'Front depth' : 'Depth'}</label>
                  <input
                    id="bs-d"
                    value={depthText}
                    disabled={disabled || busy}
                    onChange={(e) => setDepthText(e.target.value)}
                  />
                </div>
              )}
            </div>
            {!isCircular && (
              <div className="field">
                <label htmlFor="bs-h">{tiered ? 'Front height' : 'Deck height'}</label>
                <input
                  id="bs-h"
                  value={heightText}
                  disabled={disabled || busy}
                  onChange={(e) => setHeightText(e.target.value)}
                />
              </div>
            )}
            {tiered && !isCircular && (
              <div className="field-row">
                <div className="field">
                  <label htmlFor="bs-bd">Back depth</label>
                  <input
                    id="bs-bd"
                    value={backDepthText}
                    disabled={disabled || busy}
                    onChange={(e) => setBackDepthText(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="bs-bh">Back height</label>
                  <input
                    id="bs-bh"
                    value={backHeightText}
                    disabled={disabled || busy}
                    onChange={(e) => setBackHeightText(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          {!isCircular && (
            <div className="stage-section">
              <span className="tool-label">Stairs</span>
              <div className="seg stage-stairs" role="group" aria-label="Stair edges">
                {STAIR_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={stairs === s.id ? 'is-on' : ''}
                    aria-pressed={stairs === s.id}
                    disabled={disabled || busy}
                    onClick={() => setStairs(s.id)}
                    title={s.label}
                  >
                    {s.short}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="stage-summary" role="status">
            {summary}
          </div>

          <div className="actions-row stage-actions">
            <button
              type="button"
              className="btn-solid"
              disabled={disabled || busy}
              onClick={() => void build()}
            >
              {busy ? 'Building…' : isCircular ? 'Place circular deck' : 'Build stage'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
