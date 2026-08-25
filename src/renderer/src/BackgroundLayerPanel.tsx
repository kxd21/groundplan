import { useEffect, useRef, useState } from 'react';

import type { PlanBackground } from '../../format/companion.js';
import type { Extent } from '../../format/index.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import {
  IconEye,
  IconFit,
  IconFile,
  IconFlipHorizontal,
  IconFlipVertical,
  IconLock,
  IconRotateLeft,
  IconRotateRight,
  IconTrash,
} from './icons.js';
import { BACKGROUND_FILE_ACCEPT, prepareBackgroundFile } from './background-prepare.js';
import { SnappySlider } from './SnappySlider.js';

interface Props {
  background: PlanBackground | null;
  extent: Extent | null;
  units: UnitSystem;
  onPreview: (background: PlanBackground | null) => void;
  onCommit: (background: PlanBackground | null, message?: string) => void;
  onError: (message: string) => void;
  /** Start canvas two-point calibrate (closes studio; App owns the clicks). */
  onStartTwoPointScale?: () => void;
  expanded?: boolean;
  /**
   * The plan already has something drawn on it.
   *
   * Tracing a site plan is the FIRST thing you do on a blank sheet and never
   * the thing you do to a finished one, but the empty state pitched it the
   * same way either way: a 340px illustrated card, three lines of copy and a
   * button, permanently occupying the top third of the Layers tab on plans
   * that were finished years ago. On a drawing that already has content the
   * offer collapses to one line, and still opens the same picker.
   */
  planHasContent?: boolean;
}

function fitRect(
  imageWidth: number,
  imageHeight: number,
  extent: Extent | null,
): Pick<PlanBackground, 'x' | 'y' | 'width' | 'height'> {
  const bounds = extent ?? { minX: 0, minY: 0, maxX: 4800, maxY: 3600 };
  const plotWidth = Math.max(120, bounds.maxX - bounds.minX);
  const plotHeight = Math.max(120, bounds.maxY - bounds.minY);
  const imageRatio = imageWidth / imageHeight;
  const plotRatio = plotWidth / plotHeight;
  const width = imageRatio >= plotRatio ? plotWidth : plotHeight * imageRatio;
  const height = imageRatio >= plotRatio ? plotWidth / imageRatio : plotHeight;
  return {
    x: bounds.minX + (plotWidth - width) / 2,
    y: bounds.minY + (plotHeight - height) / 2,
    width,
    height,
  };
}

export default function BackgroundLayerPanel({
  background,
  extent,
  units,
  onPreview,
  onCommit,
  onError,
  onStartTwoPointScale,
  expanded = false,
  planHasContent = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [opacity, setOpacity] = useState(background?.opacity ?? 0.45);
  const [knownWidth, setKnownWidth] = useState('');
  const [appearance, setAppearance] = useState({
    brightness: background?.brightness ?? 1,
    contrast: background?.contrast ?? 1,
    saturation: background?.saturation ?? 1,
    grayscale: background?.grayscale ?? 0,
  });
  const [draft, setDraft] = useState({ x: '', y: '', width: '', height: '', rotation: '0' });
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const placementEditingRef = useRef(false);

  // Sync placement drafts only when geometry changes — not on opacity/appearance preview ticks.
  useEffect(() => {
    if (!background) return;
    if (placementEditingRef.current) return;
    setDraft({
      x: formatLength(background.x, units),
      y: formatLength(background.y, units),
      width: formatLength(background.width, units),
      height: formatLength(background.height, units),
      rotation: String(Math.round(background.rotation * 10) / 10),
    });
  }, [background?.x, background?.y, background?.width, background?.height, background?.rotation, units]);

  // Sync local opacity/appearance when committed background identity changes.
  useEffect(() => {
    if (!background) return;
    setOpacity(background.opacity);
    setAppearance({
      brightness: background.brightness,
      contrast: background.contrast,
      saturation: background.saturation,
      grayscale: background.grayscale,
    });
  }, [
    background?.dataUrl,
    background?.opacity,
    background?.brightness,
    background?.contrast,
    background?.saturation,
    background?.grayscale,
  ]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const prepared = await prepareBackgroundFile(file);
      const next: PlanBackground = {
        name: prepared.name,
        dataUrl: prepared.dataUrl,
        visible: true,
        opacity: 0.45,
        rotation: 0,
        flipX: false,
        flipY: false,
        locked: false,
        includeInExport: true,
        blendMode: 'normal',
        brightness: 1,
        contrast: 1,
        saturation: 1,
        grayscale: 0,
        ...fitRect(prepared.width, prepared.height, extent),
      };
      onPreview(next);
      onCommit(next, 'Site plan added: set a known width, then trace the room');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const scaleToKnownWidth = () => {
    if (!background || background.locked) return;
    const known = parseLength(knownWidth, units);
    if (!(known && known > 0)) {
      onError('Enter the real width of the drawing (or a wall you can measure on it).');
      return;
    }
    if (!(background.width > 0)) return;
    const factor = known / background.width;
    if (!(factor > 0.01 && factor < 100)) {
      onError('That scale is out of range. Check the known width.');
      return;
    }
    const cx = background.x + background.width / 2;
    const cy = background.y + background.height / 2;
    const width = background.width * factor;
    const height = background.height * factor;
    const next = {
      ...background,
      width,
      height,
      x: cx - width / 2,
      y: cy - height / 2,
    };
    onPreview(next);
    onCommit(next, 'Background scaled to known width');
  };

  const commitDraft = () => {
    if (!background || background.locked) return;
    const x = parseLength(draft.x, units);
    const y = parseLength(draft.y, units);
    const width = parseLength(draft.width, units);
    const height = parseLength(draft.height, units);
    const rotation = Number(draft.rotation);
    if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0 || !Number.isFinite(rotation)) {
      onError('Enter valid X, Y, width, height, and rotation values.');
      return;
    }
    const next = { ...background, x, y, width, height, rotation };
    onPreview(next);
    onCommit(next, 'Background placement updated');
  };

  const fit = () => {
    if (!background || background.locked) return;
    const next = { ...background, ...fitRect(background.width, background.height, extent), rotation: 0 };
    onPreview(next);
    onCommit(next, 'Background fitted to the plot');
  };

  const centre = () => {
    if (!background || background.locked || !extent) return;
    const next = {
      ...background,
      x: (extent.minX + extent.maxX - background.width) / 2,
      y: (extent.minY + extent.maxY - background.height) / 2,
    };
    onPreview(next);
    onCommit(next, 'Background centred');
  };

  const fillPlot = () => {
    if (!background || background.locked || !extent) return;
    const next = {
      ...background,
      x: extent.minX,
      y: extent.minY,
      width: Math.max(120, extent.maxX - extent.minX),
      height: Math.max(120, extent.maxY - extent.minY),
      rotation: 0,
    };
    onPreview(next);
    onCommit(next, 'Background filled the plot bounds');
  };

  const transform = (patch: Partial<Pick<PlanBackground, 'rotation' | 'flipX' | 'flipY'>>) => {
    if (!background || background.locked) return;
    const next = { ...background, ...patch };
    onPreview(next);
    onCommit(next);
  };

  const previewAppearance = (field: keyof typeof appearance, value: number) => {
    if (!background) return;
    const nextAppearance = { ...appearanceRef.current, [field]: value };
    appearanceRef.current = nextAppearance;
    setAppearance(nextAppearance);
    onPreview({ ...background, ...nextAppearance });
  };

  const commitAppearanceField = (field: keyof typeof appearance, value: number) => {
    if (!background) return;
    const nextAppearance = { ...appearanceRef.current, [field]: value };
    appearanceRef.current = nextAppearance;
    setAppearance(nextAppearance);
    onCommit({ ...background, ...nextAppearance });
  };

  const nudge = (dx: number, dy: number) => {
    if (!background || background.locked) return;
    const step = units === 'metric' ? 100 : 30;
    const next = { ...background, x: background.x + dx * step, y: background.y + dy * step };
    onPreview(next);
    onCommit(next);
  };

  const remove = async () => {
    if (!background) return;
    const approved = await window.groundplan.confirm({
      title: 'Remove background image',
      message: `Remove “${background.name}” from this plan?`,
      detail: 'The original image file is not changed. You can upload it again later.',
      confirmLabel: 'Remove Background',
      danger: true,
    });
    if (!approved) return;
    onPreview(null);
    onCommit(null, 'Background image removed');
  };

  return (
    <section className={`background-layer-card${expanded ? ' is-expanded' : ''}`} aria-label="Background image layer">
      <header>
        <span className="background-layer-icon" aria-hidden><IconFile size={15} /></span>
        <span className="background-layer-title">
          <strong>{expanded ? 'Background Studio' : 'Background image'}</strong>
          <small>{background ? background.name : 'Site plan, venue map, or reference image'}</small>
        </span>
        {background && (
          <span className="background-header-actions">
            <button
              type="button"
              className={background.visible ? 'is-on' : ''}
              onClick={() => {
                const next = { ...background, visible: !background.visible };
                onPreview(next);
                onCommit(next);
              }}
              aria-label={background.visible ? 'Hide background image' : 'Show background image'}
              aria-pressed={background.visible}
              title={background.visible ? 'Hide background' : 'Show background'}
            >
              <IconEye size={15} />
            </button>
            <button
              type="button"
              className={background.locked ? 'is-on' : ''}
              onClick={() => {
                const next = { ...background, locked: !background.locked };
                onPreview(next);
                onCommit(next, next.locked ? 'Background placement locked' : 'Background placement unlocked');
              }}
              aria-label={background.locked ? 'Unlock background placement' : 'Lock background placement'}
              aria-pressed={background.locked}
              title={background.locked ? 'Unlock placement' : 'Lock placement'}
            >
              <IconLock size={14} />
            </button>
          </span>
        )}
      </header>

      <input
        ref={inputRef}
        type="file"
        accept={BACKGROUND_FILE_ACCEPT}
        hidden
        onChange={(event) => void upload(event.target.files?.[0])}
      />

      {!background && planHasContent ? (
        <button
          type="button"
          className="background-add-compact"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <IconFile size={14} />
          <span>{busy ? 'Preparing drawing…' : 'Add a site plan or CAD export…'}</span>
        </button>
      ) : !background ? (
        <div className="background-empty-state">
          <span className="background-empty-visual"><IconFile size={24} /></span>
          <strong>Start from a site plan or CAD export</strong>
          <p>
            Drop a venue PDF, SVG, or raster export under the plot, set a known width, then trace the room walls on top.
          </p>
          <button type="button" className="background-upload" onClick={() => inputRef.current?.click()} disabled={busy}>
            <IconFile size={15} />
            {busy ? 'Preparing drawing…' : 'Choose site plan / PDF / image'}
          </button>
          <small>PDF, SVG, PNG, JPEG, or WebP · up to 25 MB · first PDF page</small>
        </div>
      ) : (
        <>
          {expanded && (
            <div className="background-preview">
              <img
                src={background.dataUrl}
                alt="Background preview"
                style={{
                  opacity: background.opacity,
                  filter: `brightness(${background.brightness}) contrast(${background.contrast}) saturate(${background.saturation}) grayscale(${background.grayscale})`,
                  transform: `rotate(${background.rotation}deg) scale(${background.flipX ? -1 : 1}, ${background.flipY ? -1 : 1})`,
                  mixBlendMode: background.blendMode,
                }}
              />
              <span className="background-preview-grid" aria-hidden />
              <span className="background-preview-badges">
                <small>{background.visible ? 'Visible' : 'Hidden'}</small>
                <small>{background.locked ? 'Placement locked' : 'Placement editable'}</small>
                <small>{background.includeInExport ? 'Exports on' : 'Exports off'}</small>
              </span>
            </div>
          )}

          <SnappySlider
            className="background-opacity-slider"
            label="Opacity"
            values={[5, 25, 45, 70, 100]}
            defaultValue={45}
            min={5}
            max={100}
            step={1}
            suffix="%"
            compact
            value={Math.round(opacity * 100)}
            onChange={(next) => {
              const value = next / 100;
              setOpacity(value);
              onPreview({ ...background, opacity: value });
            }}
            onChangeEnd={(next) => onCommit({ ...background, opacity: next / 100 })}
          />

          {expanded && (
            <section className="background-studio-group">
              <header><strong>Appearance</strong><small>Make the plot readable over the image.</small></header>
              <label className="background-select-row">
                <span>Blend mode</span>
                <select
                  value={background.blendMode}
                  onChange={(event) => {
                    const next = { ...background, blendMode: event.target.value as PlanBackground['blendMode'] };
                    onPreview(next);
                    onCommit(next);
                  }}
                >
                  <option value="normal">Normal</option>
                  <option value="multiply">Multiply</option>
                  <option value="screen">Screen</option>
                  <option value="darken">Darken</option>
                  <option value="lighten">Lighten</option>
                </select>
              </label>
              <div className="background-adjustments">
                {([
                  ['brightness', 'Brightness', 20, 200, [50, 100, 150, 200]],
                  ['contrast', 'Contrast', 20, 200, [50, 100, 150, 200]],
                  ['saturation', 'Saturation', 0, 200, [0, 50, 100, 150, 200]],
                  ['grayscale', 'Grayscale', 0, 100, [0, 25, 50, 75, 100]],
                ] as const).map(([field, label, min, max, marks]) => (
                  <SnappySlider
                    key={field}
                    label={label}
                    values={[...marks]}
                    defaultValue={field === 'grayscale' ? 0 : 100}
                    min={min}
                    max={max}
                    step={1}
                    suffix="%"
                    compact
                    value={Math.round(appearance[field] * 100)}
                    onChange={(next) => previewAppearance(field, next / 100)}
                    onChangeEnd={(next) => commitAppearanceField(field, next / 100)}
                  />
                ))}
              </div>
              <div className="background-option-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={background.includeInExport}
                    onChange={(event) => {
                      const next = { ...background, includeInExport: event.target.checked };
                      onPreview(next);
                      onCommit(next);
                    }}
                  />
                  Include in PDF and SVG exports
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...background, brightness: 1, contrast: 1, saturation: 1, grayscale: 0, blendMode: 'normal' as const };
                    onPreview(next);
                    onCommit(next, 'Background appearance reset');
                  }}
                >Reset appearance</button>
              </div>
            </section>
          )}

          <section className={expanded ? 'background-studio-group' : undefined}>
            {expanded && (
              <header>
                <strong>Placement</strong>
                <small>Scale the drawing to a known length, then nudge into place.</small>
              </header>
            )}
            <div className="background-scale-row">
              <label>
                <span>Known drawing width</span>
                <input
                  value={knownWidth}
                  disabled={background.locked}
                  placeholder={units === 'metric' ? 'e.g. 30 m' : "e.g. 100'"}
                  onChange={(event) => setKnownWidth(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') scaleToKnownWidth();
                  }}
                />
              </label>
              <button type="button" disabled={background.locked || busy} onClick={scaleToKnownWidth}>
                Scale to width
              </button>
            </div>
            {onStartTwoPointScale && (
              <div className="background-actions" style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  disabled={background.locked || busy}
                  onClick={onStartTwoPointScale}
                  title="Click two points on a known wall, then enter its real length"
                >
                  Two-point scale on plan…
                </button>
              </div>
            )}
            <p className="hint" style={{ margin: '0 0 10px' }}>
              Prefer two-point scale for a measured wall. Or enter the full drawing width below, then trace the room.
            </p>
            <div className="background-placement-grid">
              {(['x', 'y', 'width', 'height'] as const).map((field) => (
                <label key={field}>
                  <span>{field === 'x' ? 'X' : field === 'y' ? 'Y' : field[0].toUpperCase() + field.slice(1)}</span>
                  <input
                    value={draft[field]}
                    disabled={background.locked}
                    onFocus={() => {
                      placementEditingRef.current = true;
                    }}
                    onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
                    onBlur={() => {
                      placementEditingRef.current = false;
                      commitDraft();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                </label>
              ))}
              <label>
                <span>Rotation</span>
                <div className="background-rotation-input">
                  <input
                    type="number"
                    step="1"
                    value={draft.rotation}
                    disabled={background.locked}
                    onFocus={() => {
                      placementEditingRef.current = true;
                    }}
                    onChange={(event) => setDraft((current) => ({ ...current, rotation: event.target.value }))}
                    onBlur={() => {
                      placementEditingRef.current = false;
                      commitDraft();
                    }}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                  />
                  <small>°</small>
                </div>
              </label>
            </div>
            <div className="background-replace-row">
              <button type="button" className="link-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
                Replace drawing…
              </button>
            </div>

            <div className="background-nudge" aria-label="Nudge background image">
              <span>{background.locked ? 'Placement locked' : 'Nudge'}</span>
              <button type="button" disabled={background.locked} onClick={() => nudge(-1, 0)} aria-label="Nudge left">←</button>
              <button type="button" disabled={background.locked} onClick={() => nudge(0, -1)} aria-label="Nudge up">↑</button>
              <button type="button" disabled={background.locked} onClick={() => nudge(0, 1)} aria-label="Nudge down">↓</button>
              <button type="button" disabled={background.locked} onClick={() => nudge(1, 0)} aria-label="Nudge right">→</button>
            </div>

            {expanded && (
              <div className="background-transform-tools" aria-label="Rotate and flip background">
                <button type="button" disabled={background.locked} onClick={() => transform({ rotation: background.rotation - 90 })}><IconRotateLeft size={14} /> Rotate left</button>
                <button type="button" disabled={background.locked} onClick={() => transform({ rotation: background.rotation + 90 })}><IconRotateRight size={14} /> Rotate right</button>
                <button type="button" disabled={background.locked} className={background.flipX ? 'is-on' : ''} onClick={() => transform({ flipX: !background.flipX })}><IconFlipHorizontal size={14} /> Flip H</button>
                <button type="button" disabled={background.locked} className={background.flipY ? 'is-on' : ''} onClick={() => transform({ flipY: !background.flipY })}><IconFlipVertical size={14} /> Flip V</button>
              </div>
            )}

            <div className="background-actions">
              <button type="button" onClick={fit} disabled={background.locked}><IconFit size={13} /> Fit to plot</button>
              {expanded && <button type="button" onClick={fillPlot} disabled={background.locked || !extent}>Fill plot</button>}
              <button type="button" onClick={centre} disabled={background.locked || !extent}>Center</button>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>Replace</button>
              <button type="button" className="danger" onClick={() => void remove()}><IconTrash size={13} /> Remove</button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
