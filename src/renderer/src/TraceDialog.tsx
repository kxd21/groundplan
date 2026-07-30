import { useCallback, useEffect, useRef, useState } from 'react';

import { traceImage, type TraceResult } from '../../catalog/trace.js';
import { IconFit, IconPlus } from './icons.js';

const api = window.groundplan;
const FOOT = 120;

interface Props {
  onClose: () => void;
  onAdded: (name: string) => void;
  onError: (message: string) => void;
}

/** Accepts `4`, `4'`, `48"`, `4ft` — feet unless inches are marked. */
function parseLength(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(''|'|"|in|ft)?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  return unit === '"' || unit === 'in' ? n * 10 : n * FOOT;
}

const feet = (units: number): string => `${(units / FOOT).toFixed(2)}′`;

/**
 * Turning a picture into a plan outline.
 *
 * Adding gear by hand means drawing it, and most people will not — but almost
 * every product has a top-down drawing on its datasheet. Drop that in, say how
 * big the thing actually is, and it becomes a placeable outline.
 *
 * The two dimension fields are not optional decoration. The trace decides the
 * shape and the user decides the size; nothing about a photograph says how many
 * feet across something is, and an outline at the wrong scale is worse than no
 * outline because it looks right on screen and is wrong on the floor.
 */
export function TraceDialog({ onClose, onAdded, onError }: Props) {
  const [image, setImage] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState('');
  const [threshold, setThreshold] = useState(128);
  const [smoothing, setSmoothing] = useState(2);
  const [invert, setInvert] = useState(false);
  const [name, setName] = useState('');
  const [widthDraft, setWidthDraft] = useState('');
  const [depthDraft, setDepthDraft] = useState('');
  const [result, setResult] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const load = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        onError('That is not an image file.');
        return;
      }
      const bitmap = await createImageBitmap(file);
      // Downscale first: tracing a 6000px photograph is slow and no more
      // accurate than tracing a 1200px one.
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
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
      setImage(context.getImageData(0, 0, w, h));
      setFileName(file.name);
      if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
    },
    [name, onError],
  );

  // Re-trace whenever anything that affects the outline changes.
  useEffect(() => {
    if (!image) {
      setResult(null);
      return;
    }
    const width = parseLength(widthDraft);
    const depth = parseLength(depthDraft);
    setResult(
      traceImage(
        { data: image.data, width: image.width, height: image.height },
        {
          threshold,
          invert,
          simplify: smoothing,
          targetWidth: width ?? undefined,
          targetDepth: depth ?? undefined,
        },
      ),
    );
  }, [image, threshold, smoothing, invert, widthDraft, depthDraft]);

  // Draw the source with the traced outline over it, so the effect of a
  // threshold change is visible rather than guessed at.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const boxW = canvas.width;
    const boxH = canvas.height;
    context.clearRect(0, 0, boxW, boxH);

    const scale = Math.min(boxW / image.width, boxH / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const offX = (boxW - drawW) / 2;
    const offY = (boxH - drawH) / 2;

    const off = document.createElement('canvas');
    off.width = image.width;
    off.height = image.height;
    off.getContext('2d')?.putImageData(image, 0, 0);
    context.globalAlpha = 0.35;
    context.drawImage(off, offX, offY, drawW, drawH);
    context.globalAlpha = 1;

    if (!result?.ok || result.paths.length === 0) return;

    // The outline is centred on the origin and scaled to real units, so map it
    // back into the preview by its own extent.
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
    context.strokeStyle = '#2997ff';
    context.lineWidth = 2;
    context.stroke();

    context.fillStyle = '#2997ff';
    for (const path of result.paths) {
      for (let i = 0; i < path.points.length; i += 2) {
        context.beginPath();
        context.arc(cx + path.points[i] * k, cy + path.points[i + 1] * k, 2.2, 0, Math.PI * 2);
        context.fill();
      }
    }
  }, [image, result]);

  const save = async () => {
    if (!result?.ok) return;
    const trimmed = name.trim();
    if (!trimmed) {
      onError('Give the item a name first.');
      return;
    }
    if (!parseLength(widthDraft) || !parseLength(depthDraft)) {
      onError('Enter both dimensions, like 4 or 48″ — an outline needs a real size.');
      return;
    }

    setBusy(true);
    const reply = await api.inventoryAddTraced({
      name: trimmed,
      width: result.width,
      height: result.height,
      paths: result.paths,
    });
    setBusy(false);

    if (reply.ok) {
      onAdded(trimmed);
      onClose();
    } else if (reply.reason) onError(reply.reason);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet trace-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          <span>Trace an outline from a picture</span>
        </div>

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
            <canvas ref={canvasRef} width={420} height={260} />
          ) : (
            <div className="trace-empty">
              <p>Drop a picture here</p>
              <p className="hint">
                A top-down drawing from the datasheet works best. A photograph of the item on the floor
                will do.
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
          <>
            <div className="trace-controls">
              <label>
                <span>Threshold</span>
                <input
                  type="range"
                  min={20}
                  max={240}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
                <em className="num">{threshold}</em>
              </label>
              <label>
                <span>Smoothing</span>
                <input
                  type="range"
                  min={0}
                  max={12}
                  step={0.5}
                  value={smoothing}
                  onChange={(e) => setSmoothing(Number(e.target.value))}
                />
                <em className="num">{smoothing}</em>
              </label>
              <label className="trace-invert">
                <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
                <span>Light item on a dark background</span>
              </label>
            </div>

            <div className="trace-fields">
              <div className="field">
                <label htmlFor="trace-name">Name</label>
                <input
                  id="trace-name"
                  value={name}
                  placeholder="e.g. Barco UDX-4K32"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field trace-size">
                <label htmlFor="trace-w">Real size</label>
                <div className="trace-size-row">
                  <input
                    id="trace-w"
                    value={widthDraft}
                    placeholder="width"
                    onChange={(e) => setWidthDraft(e.target.value)}
                  />
                  <span className="inv-x">×</span>
                  <input
                    value={depthDraft}
                    placeholder="depth"
                    onChange={(e) => setDepthDraft(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <p className="hint trace-status">
              {result?.ok ? (
                <>
                  Traced {result.rawPoints.toLocaleString()} points down to {result.points} ·{' '}
                  {feet(result.width)} × {feet(result.height)}
                  {!parseLength(widthDraft) || !parseLength(depthDraft) ? (
                    <> · <strong>enter both dimensions to set the real size</strong></>
                  ) : null}
                </>
              ) : (
                (result?.reason ?? 'Reading the picture…')
              )}
            </p>
          </>
        )}

        <div className="sheet-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!result?.ok || busy}
            onClick={() => void save()}
            title={fileName ? `From ${fileName}` : undefined}
          >
            {busy ? 'Adding…' : 'Add to inventory'}
          </button>
        </div>
      </div>
    </div>
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
