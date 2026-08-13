import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { estimateThreshold, traceImage, type TraceResult } from '../../catalog/trace.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { IconFit, IconPlus } from './icons.js';
import { SnappySlider } from './SnappySlider.js';

const api = window.groundplan;

type PreviewMode = 'overlay' | 'mask' | 'outline';

interface Props {
  units: UnitSystem;
  onClose: () => void;
  /** Inventory palette / standalone: save a new inventory item. */
  onAdded?: (name: string) => void;
  /**
   * Shape builder: return the traced outline to the caller instead of writing
   * inventory. When set, the primary action is “Use outline”.
   */
  onOutline?: (result: TraceResult) => void;
  onError: (message: string) => void;
  /** Prefill from the shape wizard (name, sizes, already-uploaded picture). */
  initialName?: string;
  initialWidth?: string;
  initialDepth?: string;
  initialImage?: ImageData | null;
  initialFileName?: string;
}

function buildInkMask(
  image: ImageData,
  threshold: number,
  invert: boolean,
): ImageData {
  const out = new ImageData(image.width, image.height);
  const src = image.data;
  const dst = out.data;
  for (let p = 0; p < src.length; p += 4) {
    const alpha = src[p + 3];
    if (alpha < 128) {
      dst[p] = dst[p + 1] = dst[p + 2] = 255;
      dst[p + 3] = 255;
      continue;
    }
    const luma = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
    const ink = invert ? luma > threshold : luma < threshold;
    const v = ink ? 28 : 245;
    dst[p] = dst[p + 1] = dst[p + 2] = v;
    dst[p + 3] = 255;
  }
  return out;
}

/**
 * Turning a picture into a plan outline.
 *
 * The two dimension fields are not optional decoration. The trace decides the
 * shape and the user decides the size; nothing about a photograph says how many
 * feet across something is.
 */
export function TraceDialog({
  units,
  onClose,
  onAdded,
  onOutline,
  onError,
  initialName = '',
  initialWidth = '',
  initialDepth = '',
  initialImage = null,
  initialFileName = '',
}: Props) {
  const [image, setImage] = useState<ImageData | null>(initialImage);
  const [fileName, setFileName] = useState(initialFileName);
  const [threshold, setThreshold] = useState(() =>
    initialImage ? estimateThreshold(initialImage) : 128,
  );
  const [smoothing, setSmoothing] = useState(3);
  const [invert, setInvert] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('overlay');
  const [name, setName] = useState(initialName);
  const [widthDraft, setWidthDraft] = useState(initialWidth);
  const [depthDraft, setDepthDraft] = useState(initialDepth);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const outlineMode = typeof onOutline === 'function';

  const load = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        onError('That is not an image file.');
        return;
      }
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const context = off.getContext('2d', { willReadFrequently: true });
      if (!context) {
        onError('The image could not be read.');
        return;
      }
      context.drawImage(bitmap, 0, 0, w, h);
      const next = context.getImageData(0, 0, w, h);
      setImage(next);
      setFileName(file.name);
      setThreshold(estimateThreshold(next));
      setSmoothing(3);
      setInvert(false);
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ''));
    },
    [name, onError],
  );

  useEffect(() => {
    if (!image) {
      setResult(null);
      return;
    }
    const width = parseLength(widthDraft, units);
    const depth = parseLength(depthDraft, units);
    const handle = window.setTimeout(() => {
      try {
        setResult(
          traceImage(
            { data: image.data, width: image.width, height: image.height },
            {
              threshold,
              invert,
              useAlpha: true,
              simplify: smoothing,
              targetWidth: width ?? undefined,
              targetDepth: depth ?? undefined,
            },
          ),
        );
      } catch (err) {
        setResult({
          ok: false,
          paths: [],
          width: 0,
          height: 0,
          rawPoints: 0,
          points: 0,
          coverage: 0,
          reason: err instanceof Error ? err.message : 'Tracing failed',
        });
      }
    }, 80);
    return () => window.clearTimeout(handle);
  }, [image, threshold, smoothing, invert, widthDraft, depthDraft, units]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const boxW = canvas.width;
    const boxH = canvas.height;
    context.clearRect(0, 0, boxW, boxH);
    context.fillStyle = '#0f1218';
    context.fillRect(0, 0, boxW, boxH);

    const scale = Math.min(boxW / image.width, boxH / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const offX = (boxW - drawW) / 2;
    const offY = (boxH - drawH) / 2;

    const source = document.createElement('canvas');
    source.width = image.width;
    source.height = image.height;
    const sourceCtx = source.getContext('2d');
    if (!sourceCtx) return;

    if (previewMode === 'mask') {
      sourceCtx.putImageData(buildInkMask(image, threshold, invert), 0, 0);
      context.drawImage(source, offX, offY, drawW, drawH);
    } else if (previewMode === 'outline') {
      context.fillStyle = '#1a1f28';
      context.fillRect(offX, offY, drawW, drawH);
    } else {
      sourceCtx.putImageData(image, 0, 0);
      context.globalAlpha = 0.42;
      context.drawImage(source, offX, offY, drawW, drawH);
      context.globalAlpha = 1;
    }

    if (!result?.ok || result.paths.length === 0) return;

    const span = Math.max(result.width, result.height) || 1;
    const k = (Math.min(drawW, drawH) * 0.92) / span;
    const cx = offX + drawW / 2;
    const cy = offY + drawH / 2;

    context.beginPath();
    for (const path of result.paths) {
      for (let i = 0; i < path.points.length; i += 2) {
        const px = cx + path.points[i] * k;
        const py = cy + path.points[i + 1] * k;
        if (i === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      if (path.closed) context.closePath();
    }
    context.fillStyle = 'rgba(41, 151, 255, 0.22)';
    context.fill();
    context.strokeStyle = '#5eb1ff';
    context.lineWidth = 2.25;
    context.lineJoin = 'round';
    context.stroke();

    const showDots = result.points <= 48;
    if (showDots) {
      context.fillStyle = '#8ec8ff';
      for (const path of result.paths) {
        for (let i = 0; i < path.points.length; i += 2) {
          context.beginPath();
          context.arc(cx + path.points[i] * k, cy + path.points[i + 1] * k, 2.4, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
  }, [image, result, previewMode, threshold, invert]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const confirmedResult = (): TraceResult | null => {
    if (!image || !result?.ok) return null;
    const widthValue = parseLength(widthDraft, units);
    const depthValue = parseLength(depthDraft, units);
    if (!widthValue || !depthValue) return null;
    return traceImage(
      { data: image.data, width: image.width, height: image.height },
      {
        threshold,
        invert,
        useAlpha: true,
        simplify: smoothing,
        targetWidth: widthValue,
        targetDepth: depthValue,
      },
    );
  };

  const save = async () => {
    const widthValue = parseLength(widthDraft, units);
    const depthValue = parseLength(depthDraft, units);
    if (!widthValue || !depthValue) {
      onError(
        units === 'metric'
          ? 'Enter both dimensions, like 120cm or 1.2m — an outline needs a real size.'
          : 'Enter both dimensions, like 4\' or 48" — an outline needs a real size.',
      );
      return;
    }

    const confirmed = confirmedResult();
    if (!confirmed?.ok) {
      onError(confirmed?.reason ?? 'Tracing failed — adjust threshold or invert');
      return;
    }

    if (outlineMode) {
      onOutline!(confirmed);
      onClose();
      return;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      onError('Give the item a name first.');
      return;
    }

    setBusy(true);
    const reply = await api.inventoryAddTraced({
      name: trimmed,
      width: confirmed.width,
      height: confirmed.height,
      paths: confirmed.paths,
    });
    setBusy(false);

    if (reply.ok) {
      onAdded?.(trimmed);
      onClose();
    } else if (reply.reason) onError(reply.reason);
  };

  const canSave =
    Boolean(result?.ok) &&
    Boolean(parseLength(widthDraft, units)) &&
    Boolean(parseLength(depthDraft, units)) &&
    (outlineMode || Boolean(name.trim()));

  return createPortal(
    <div className="sheet-backdrop sheet-backdrop-raised" role="presentation" onClick={onClose}>
      <div
        className="sheet trace-sheet trace-sheet-refined"
        role="dialog"
        aria-modal="true"
        aria-label="Trace an outline from a picture"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title">
          <div>
            <small className="trace-eyebrow">{outlineMode ? 'Shape builder' : 'Inventory'}</small>
            <span>{outlineMode ? 'Auto-trace & refine' : 'Trace an outline from a picture'}</span>
          </div>
          <button type="button" className="btn-outline" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="trace-layout">
          <div className="trace-preview-col">
            <div
              className={`trace-drop${image ? ' has-image' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) void load(file);
              }}
            >
              {image ? (
                <canvas ref={canvasRef} width={560} height={360} />
              ) : (
                <div className="trace-empty">
                  <p>Drop a picture here</p>
                  <p className="hint">
                    Top-down datasheet art works best. A floor photo of the item will do.
                  </p>
                  <label className="btn-outline">
                    Choose a picture…
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void load(file);
                      }}
                    />
                  </label>
                </div>
              )}
            </div>

            {image && (
              <div className="seg tabs seat-kinds trace-preview-modes" role="tablist" aria-label="Preview">
                {(
                  [
                    ['overlay', 'Photo + outline'],
                    ['mask', 'Ink mask'],
                    ['outline', 'Outline only'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={previewMode === id ? 'active' : ''}
                    onClick={() => setPreviewMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="trace-side">
            {image ? (
              <>
                <div className="trace-controls">
                  <div className="trace-control-head">
                    <span>Detection</span>
                    <button
                      type="button"
                      className="btn-outline trace-auto-btn"
                      onClick={() => {
                        if (!image) return;
                        setThreshold(estimateThreshold(image));
                        setInvert(false);
                      }}
                    >
                      Auto threshold
                    </button>
                  </div>
                  <SnappySlider
                    label="Threshold"
                    values={[20, 64, 128, 192, 240]}
                    defaultValue={128}
                    min={20}
                    max={240}
                    step={1}
                    compact
                    value={threshold}
                    onChange={setThreshold}
                  />
                  <SnappySlider
                    label="Simplify"
                    values={[0, 2, 4, 8, 14, 22]}
                    defaultValue={3}
                    min={0}
                    max={24}
                    step={0.5}
                    compact
                    value={smoothing}
                    onChange={setSmoothing}
                  />
                  <label className="trace-invert">
                    <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
                    <span>Light item on a dark background</span>
                  </label>
                  <div className="actions-row trace-simplify-actions">
                    <button
                      type="button"
                      className="btn-outline"
                      disabled={!result?.ok}
                      onClick={() => setSmoothing((v) => Math.min(24, v + 3))}
                    >
                      Fewer corners
                    </button>
                    <button
                      type="button"
                      className="btn-outline"
                      disabled={!result?.ok || smoothing <= 0}
                      onClick={() => setSmoothing((v) => Math.max(0, v - 2))}
                    >
                      More detail
                    </button>
                  </div>
                </div>

                <div className="trace-fields">
                  {!outlineMode && (
                    <div className="field">
                      <label htmlFor="trace-name">Name</label>
                      <input
                        id="trace-name"
                        value={name}
                        placeholder="e.g. Barco UDX-4K32"
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="field trace-size">
                    <label htmlFor="trace-w">
                      Real size ({units === 'metric' ? 'cm / m' : 'ft / in'})
                    </label>
                    <div className="trace-size-row">
                      <input
                        id="trace-w"
                        value={widthDraft}
                        placeholder={units === 'metric' ? '120cm' : "4'"}
                        onChange={(e) => setWidthDraft(e.target.value)}
                      />
                      <span className="inv-x">×</span>
                      <input
                        value={depthDraft}
                        placeholder={units === 'metric' ? '80cm' : "3'"}
                        onChange={(e) => setDepthDraft(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <p className="hint trace-status">
                  {result?.ok ? (
                    <>
                      {result.points} corners · {formatLength(result.width, units)} ×{' '}
                      {formatLength(result.height, units)}
                      {result.coverage > 0 ? ` · ${Math.round(result.coverage * 100)}% ink` : ''}
                      {!parseLength(widthDraft, units) || !parseLength(depthDraft, units) ? (
                        <>
                          {' '}
                          · <strong>enter both dimensions</strong>
                        </>
                      ) : (
                        <> · ready to apply</>
                      )}
                    </>
                  ) : (
                    (result?.reason ?? 'Reading the picture…')
                  )}
                </p>
                {image && !result?.ok && result?.reason && (
                  <p className="hint trace-status">
                    Try Auto threshold, move Threshold, or toggle light-on-dark. Check the Ink mask view.
                  </p>
                )}
                {result?.ok && result.points > 36 && (
                  <p className="hint trace-status">
                    Lots of corners — tap <strong>Fewer corners</strong> before applying, then drag points
                    in the shape builder to refine.
                  </p>
                )}
              </>
            ) : (
              <p className="hint" style={{ padding: '0 4px' }}>
                Choose a picture to begin. You can still adjust detection after it loads.
              </p>
            )}
          </div>
        </div>

        <div className="sheet-actions">
          {image && (
            <label className="btn-outline">
              Replace picture…
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void load(file);
                }}
              />
            </label>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!canSave || busy}
            onClick={() => void save()}
            title={fileName ? `From ${fileName}` : undefined}
          >
            {busy ? 'Adding…' : outlineMode ? 'Use outline' : 'Add to inventory'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Small button that opens the tracer, for use in the inventory palette. */
export function TraceButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn" title="Add an item by tracing a picture" onClick={onClick}>
      <IconPlus size={12} />
      <IconFit size={12} />
    </button>
  );
}
