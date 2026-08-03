/**
 * Build a Stage — riser stock sizes with W / D / H, then place via stageAdd.
 */

import { useEffect, useState } from 'react';

import { DECK_SIZES } from '../../format/stage.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../../format/rv.js';

const api = window.groundplan;

const RISER_PRESETS = [
  { id: '4x8', label: "4′ × 8′", width: 8 * UNITS_PER_FOOT, depth: 4 * UNITS_PER_FOOT },
  { id: '6x8', label: "6′ × 8′", width: 8 * UNITS_PER_FOOT, depth: 6 * UNITS_PER_FOOT },
  { id: '8x4', label: "8′ × 4′", width: 4 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
  { id: '8x6', label: "8′ × 6′", width: 6 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
  { id: 'circ', label: 'Circular deck (8′)', width: 8 * UNITS_PER_FOOT, depth: 8 * UNITS_PER_FOOT },
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
  const [widthText, setWidthText] = useState(() => formatLength(24 * UNITS_PER_FOOT, units));
  const [depthText, setDepthText] = useState(() => formatLength(16 * UNITS_PER_FOOT, units));
  const [heightText, setHeightText] = useState(() => formatLength(24 * UNITS_PER_INCH, units));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreset(RISER_PRESETS[0]!.id);
    setWidthText(formatLength(24 * UNITS_PER_FOOT, units));
    setDepthText(formatLength(16 * UNITS_PER_FOOT, units));
    setHeightText(formatLength(24 * UNITS_PER_INCH, units));
    setBusy(false);
  }, [open, units]);

  if (!open) return null;

  const applyPreset = (id: string) => {
    setPreset(id);
    const row = RISER_PRESETS.find((p) => p.id === id);
    if (!row) return;
    setWidthText(formatLength(row.width, units));
    setDepthText(formatLength(row.depth, units));
  };

  const build = async () => {
    const width = parseLength(widthText, units);
    const depth = parseLength(depthText, units);
    const height = parseLength(heightText, units);
    if (!(width && width > 0) || !(depth && depth > 0) || !(height && height > 0)) {
      onError('Enter width, depth, and deck height');
      return;
    }
    setBusy(true);
    try {
      const reply = await api.stageAdd(origin.x - width / 2, origin.y, width, depth, height);
      if (!reply.ok) {
        onError(reply.reason ?? 'stage could not be built');
        return;
      }
      onStatus(reply.note ?? 'Stage added');
      onBuilt(reply.doc, reply.created);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Build a Stage"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420, maxWidth: '92vw' }}
      >
        <div className="sheet-title">
          <h2>Build a Stage</h2>
          <button type="button" className="btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          <div className="field">
            <label htmlFor="stage-preset">Riser / deck type</label>
            <select
              id="stage-preset"
              value={preset}
              disabled={disabled}
              onChange={(e) => applyPreset(e.target.value)}
            >
              {RISER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <p className="hint">
            Stock decks for tiling: {DECK_SIZES.map((d) => d.label).join(', ')}. Overall stage size can
            span multiple decks.
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="bs-w">Width</label>
              <input
                id="bs-w"
                value={widthText}
                disabled={disabled}
                onChange={(e) => setWidthText(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="bs-d">Depth</label>
              <input
                id="bs-d"
                value={depthText}
                disabled={disabled}
                onChange={(e) => setDepthText(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="bs-h">Height (deck)</label>
            <input
              id="bs-h"
              value={heightText}
              disabled={disabled}
              onChange={(e) => setHeightText(e.target.value)}
            />
          </div>
          <div className="actions-row">
            <button
              type="button"
              className="btn-solid"
              disabled={disabled || busy}
              onClick={() => void build()}
            >
              Build stage
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
