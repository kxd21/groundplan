/**
 * Starting a plan.
 *
 * Room Viewer opens Event Room Data on File → New: you name the room, give its
 * dimensions, and the drawing exists. This is the same idea and the same first
 * two questions, because they are the two that cannot be deferred — everything
 * else about a plan can be decided later, but a room with no size cannot be
 * laid out, dimensioned, or seated.
 *
 * The presets are there because a venue books the same handful of rooms over
 * and over, and typing `60'` and `40'` every time is work the app can do.
 */

import { useEffect, useState } from 'react';

import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { IconPlus } from './icons.js';

const api = window.groundplan;

interface Preset {
  label: string;
  /** In feet, as the presets are stated. */
  width: number;
  depth: number;
}

interface Props {
  units: UnitSystem;
  onCreated: (doc: unknown) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

const FT = 120;

export default function NewPlanDialog({ units, onCreated, onCancel, onError }: Props) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('Untitled plan');
  const [width, setWidth] = useState(() => formatLength(60 * FT, units));
  const [depth, setDepth] = useState(() => formatLength(40 * FT, units));
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.roomPresets().then(setPresets);
  }, []);

  const widthUnits = parseLength(width, units);
  const depthUnits = parseLength(depth, units);
  const sized = empty || ((widthUnits ?? 0) > 0 && (depthUnits ?? 0) > 0);

  const choose = (preset: Preset) => {
    if (preset.width <= 0 || preset.depth <= 0) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    setWidth(formatLength(preset.width * FT, units));
    setDepth(formatLength(preset.depth * FT, units));
  };

  const create = async () => {
    setBusy(true);
    try {
      const reply = await api.newPlan({
        name: name.trim() || 'Untitled plan',
        width: empty ? 0 : (widthUnits ?? 0),
        depth: empty ? 0 : (depthUnits ?? 0),
      });
      if (reply.cancelled) return;
      if (!reply.ok || !reply.doc) {
        onError(reply.reason ?? 'the plan could not be created');
        return;
      }
      onCreated(reply.doc);
    } finally {
      setBusy(false);
    }
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
          <p>
            A real Room Viewer file, created from nothing. It opens in Room Viewer like any other plan.
          </p>
        </div>

        <div className="new-plan-body">
          <div className="field">
            <label htmlFor="new-plan-name">Plan name</label>
            <input
              id="new-plan-name"
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && sized && !busy) void create();
              }}
            />
          </div>

          <div className="field">
            <label>Room size</label>
            <div className="preset-grid">
              {presets.map((preset) => {
                const isEmpty = preset.width <= 0;
                const active = isEmpty
                  ? empty
                  : !empty &&
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

          {!empty && (
            <div className="field-row">
              <div className="field">
                <label htmlFor="new-plan-width">Width</label>
                <input
                  id="new-plan-width"
                  type="text"
                  value={width}
                  aria-invalid={width.trim() !== '' && !(widthUnits! > 0)}
                  onChange={(e) => setWidth(e.target.value)}
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
                />
              </div>
            </div>
          )}

          <p className="hint">
            {empty
              ? 'An empty sheet. Draw the room from the Room tab once the plan is open.'
              : 'A rectangular room is drawn for you. Change its shape, curve a wall or cut a corridor out of it from the Room tab.'}
          </p>
        </div>

        <div className="new-plan-foot">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void create()} disabled={!sized || busy}>
            <IconPlus size={14} />
            {busy ? 'Creating…' : 'Create plan…'}
          </button>
        </div>
      </div>
    </div>
  );
}
