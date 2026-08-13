/**
 * Edit one inventory item: name, size, and icon (upload a photo to replace a missing outline).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { traceImage, type TraceResult } from '../../catalog/trace.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { SnappySlider } from './SnappySlider.js';

const api = window.groundplan;

export interface EditableInventoryItem {
  id: string;
  name: string;
  department?: string;
  category?: string;
  width?: number;
  height?: number;
  sizeSource: 'parsed' | 'user' | 'unknown' | 'symbol';
  symbolPath?: string;
  symbolName?: string;
  mappedBy?: 'auto' | 'user';
  mapReason?: string;
  tracedIcon?: { paths: Array<{ points: number[]; closed: boolean }>; width: number; height: number };
  photoDataUrl?: string;
  hasPhoto?: boolean;
  notes?: string;
  timesSeen: number;
  peakQuantity: number;
  quantityOwned?: number | null;
  addedAt: string;
}

interface Props {
  item: EditableInventoryItem;
  units: UnitSystem;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

function sizeHint(system: UnitSystem): string {
  return system === 'metric'
    ? 'Enter sizes like 120cm, 1.2m (or 4\', 48")'
    : 'Enter sizes like 4\', 48", 4\' 6" (or 120cm, 1.2m)';
}

/** Shrink a photo for inventory storage (preview only). */
async function photoToDataUrl(file: File, maxEdge = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read that image');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function fileToImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read that image');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function pathsToSvg(
  icon: { paths: Array<{ points: number[]; closed: boolean }>; width: number; height: number },
  box = 120,
): { paths: string[]; closed: boolean[] } {
  const span = Math.max(icon.width, icon.height, 1);
  const scale = (box * 0.82) / span;
  const ox = box / 2;
  const oy = box / 2;
  const paths: string[] = [];
  const closed: boolean[] = [];
  for (const path of icon.paths) {
    const pts: string[] = [];
    for (let i = 0; i + 1 < path.points.length; i += 2) {
      pts.push(`${(ox + path.points[i]! * scale).toFixed(1)},${(oy + path.points[i + 1]! * scale).toFixed(1)}`);
    }
    if (pts.length >= 2) {
      paths.push(pts.join(' '));
      closed.push(path.closed);
    }
  }
  return { paths, closed };
}

export default function InventoryItemEditor({
  item,
  units,
  onClose,
  onSaved,
  onError,
  onStatus,
}: Props) {
  const [name, setName] = useState(item.name);
  const [wDraft, setWDraft] = useState(
    item.width != null && Number.isFinite(item.width) ? formatLength(item.width, units) : '',
  );
  const [hDraft, setHDraft] = useState(
    item.height != null && Number.isFinite(item.height) ? formatLength(item.height, units) : '',
  );
  const [notes, setNotes] = useState(item.notes ?? '');
  const [ownedDraft, setOwnedDraft] = useState(
    item.quantityOwned != null && Number.isFinite(item.quantityOwned) ? String(item.quantityOwned) : '',
  );
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(item.photoDataUrl ?? null);
  const [tracedIcon, setTracedIcon] = useState(item.tracedIcon ?? null);
  const [clearPhoto, setClearPhoto] = useState(false);
  const [clearTrace, setClearTrace] = useState(false);

  const [image, setImage] = useState<ImageData | null>(null);
  const [threshold, setThreshold] = useState(128);
  const [smoothing, setSmoothing] = useState(2);
  const [invert, setInvert] = useState(false);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (item.photoDataUrl || !item.hasPhoto) return;
    let live = true;
    void api.inventoryGetPhoto(item.id).then((reply) => {
      if (!live || !reply.ok || !reply.photoDataUrl) return;
      setPhotoDataUrl(reply.photoDataUrl);
    });
    return () => {
      live = false;
    };
  }, [item.id, item.hasPhoto, item.photoDataUrl]);

  const hasSymbol = Boolean(item.symbolPath);
  const previewIcon = useMemo(() => {
    if (clearTrace) return null;
    if (tracedIcon?.paths?.length) return tracedIcon;
    if (trace?.ok && trace.paths.length) {
      return { paths: trace.paths, width: trace.width, height: trace.height };
    }
    return item.tracedIcon ?? null;
  }, [clearTrace, tracedIcon, trace, item.tracedIcon]);

  const svgPreview = previewIcon ? pathsToSvg(previewIcon) : null;

  const loadPhoto = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        onError('That is not an image file.');
        return;
      }
      try {
        const [dataUrl, imageData] = await Promise.all([photoToDataUrl(file), fileToImageData(file)]);
        setPhotoDataUrl(dataUrl);
        setClearPhoto(false);
        setImage(imageData);
        setClearTrace(false);
        if (!wDraft.trim() && item.width) setWDraft(formatLength(item.width, units));
        if (!hDraft.trim() && item.height) setHDraft(formatLength(item.height, units));
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [hDraft, item.height, item.width, onError, units, wDraft],
  );

  useEffect(() => {
    if (!image) {
      setTrace(null);
      return;
    }
    const width = parseLength(wDraft, units);
    const depth = parseLength(hDraft, units);
    const handle = window.setTimeout(() => {
      setTrace(
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
    }, 80);
    return () => window.clearTimeout(handle);
  }, [image, threshold, smoothing, invert, wDraft, hDraft, units]);

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
    context.globalAlpha = 0.4;
    context.drawImage(off, offX, offY, drawW, drawH);
    context.globalAlpha = 1;
    if (!trace?.ok || !trace.paths.length) return;
    const span = Math.max(trace.width, trace.height, 1);
    const map = (boxW * 0.85) / span;
    context.strokeStyle = 'var(--accent, #0b6ecb)';
    context.lineWidth = 1.5;
    for (const path of trace.paths) {
      context.beginPath();
      for (let i = 0; i + 1 < path.points.length; i += 2) {
        const x = boxW / 2 + path.points[i]! * map;
        const y = boxH / 2 + path.points[i + 1]! * map;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      if (path.closed) context.closePath();
      context.stroke();
    }
  }, [image, trace]);

  const applyTraceFromPhoto = () => {
    if (!trace?.ok || !trace.paths.length) {
      onError(trace?.reason ?? 'Could not trace an outline from that photo');
      return;
    }
    setTracedIcon({ paths: trace.paths, width: trace.width, height: trace.height });
    setClearTrace(false);
    setWDraft(formatLength(trace.width, units));
    setHDraft(formatLength(trace.height, units));
    onStatus('Outline ready — save to apply it to this item');
  };

  const save = async () => {
    const wanted = name.trim();
    if (!wanted) {
      onError('Name cannot be empty');
      return;
    }
    const width = parseLength(wDraft, units);
    const height = parseLength(hDraft, units);
    if (wDraft.trim() || hDraft.trim()) {
      if (width == null || height == null || width <= 0 || height <= 0) {
        onError(sizeHint(units));
        return;
      }
    }

    const patch: Parameters<typeof api.inventoryUpdate>[1] = { name: wanted, notes: notes.trim() || undefined };
    if (width != null && height != null && width > 0 && height > 0) {
      patch.width = width;
      patch.height = height;
    }
    const ownedTrim = ownedDraft.trim();
    if (!ownedTrim) {
      if (item.quantityOwned != null) patch.quantityOwned = null;
    } else {
      const owned = Number(ownedTrim);
      if (!Number.isFinite(owned) || owned < 0 || !Number.isInteger(owned)) {
        onError('Owned quantity must be a whole non-negative number');
        return;
      }
      patch.quantityOwned = owned;
    }
    if (clearTrace) patch.tracedIcon = null;
    else if (
      tracedIcon &&
      (!item.tracedIcon ||
        tracedIcon.width !== item.tracedIcon.width ||
        tracedIcon.height !== item.tracedIcon.height ||
        JSON.stringify(tracedIcon.paths) !== JSON.stringify(item.tracedIcon.paths))
    ) {
      patch.tracedIcon = tracedIcon;
    }
    if (clearPhoto) patch.photoDataUrl = null;
    else if (photoDataUrl && photoDataUrl !== item.photoDataUrl) patch.photoDataUrl = photoDataUrl;

    setBusy(true);
    try {
      const reply = await api.inventoryUpdate(item.id, patch);
      if (!reply.ok) {
        onError(reply.reason ?? 'Could not save item');
        return;
      }
      onStatus(reply.changed ? `Saved ${wanted}` : 'No changes');
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const showPhoto = !clearPhoto && (photoDataUrl || item.photoDataUrl);

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sheet item-editor-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${item.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title">
          <h2>Edit item</h2>
          <button type="button" className="btn-outline" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="sheet-body item-editor-body">
          <div className="item-editor-preview" aria-label="Item icon">
            {showPhoto ? (
              <img src={photoDataUrl || item.photoDataUrl} alt="" className="item-editor-photo" />
            ) : svgPreview?.paths.length ? (
              <svg viewBox="0 0 120 120" className="item-editor-svg" aria-hidden>
                {svgPreview.paths.map((d, i) =>
                  svgPreview.closed[i] ? (
                    <polygon key={i} points={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
                  ) : (
                    <polyline key={i} points={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
                  ),
                )}
              </svg>
            ) : (
              <div className="item-editor-missing">
                <span>No icon</span>
                <p className="hint">Upload a photo to create one</p>
              </div>
            )}
            {hasSymbol && !previewIcon && (
              <p className="hint">Uses drawn symbol from plan{item.symbolName ? ` (“${item.symbolName}”)` : ''}</p>
            )}
          </div>

          <div className="field">
            <label htmlFor="item-edit-name">Name</label>
            <input
              id="item-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="item-edit-w">
              Size ({units === 'metric' ? 'cm / m' : 'ft / in'})
            </label>
            <div className="size-row">
              <input
                id="item-edit-w"
                className="num"
                value={wDraft}
                placeholder={units === 'metric' ? 'width' : "e.g. 4'"}
                onChange={(e) => setWDraft(e.target.value)}
              />
              <span className="inv-x">×</span>
              <input
                className="num"
                value={hDraft}
                placeholder={units === 'metric' ? 'depth' : "e.g. 3'"}
                onChange={(e) => setHDraft(e.target.value)}
              />
            </div>
            <span className="field-help">{sizeHint(units)}</span>
          </div>

          <div className="field">
            <label htmlFor="item-edit-owned">Owned</label>
            <input
              id="item-edit-owned"
              className="num"
              inputMode="numeric"
              value={ownedDraft}
              placeholder="On-hand stock"
              onChange={(e) => setOwnedDraft(e.target.value)}
            />
            <span className="field-help">Company stock on hand (from Spotlight inventory or CSV)</span>
          </div>

          <div className="field">
            <label htmlFor="item-edit-notes">Notes</label>
            <textarea
              id="item-edit-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="item-editor-icon-block">
            <div className="section-title">
              <span>Icon</span>
            </div>
            <p className="hint">
              Upload a top-down photo or datasheet drawing. Groundplan traces an outline for the plan,
              and keeps a small photo preview for the inventory list.
            </p>
            <div className="actions-row">
              <button type="button" className="btn-outline" onClick={() => fileRef.current?.click()}>
                Upload photo…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadPhoto(file);
                  e.target.value = '';
                }}
              />
              {showPhoto && (
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    setClearPhoto(true);
                    setPhotoDataUrl(null);
                    setImage(null);
                    setTrace(null);
                  }}
                >
                  Remove photo
                </button>
              )}
              {(tracedIcon || item.tracedIcon) && !clearTrace && (
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    setClearTrace(true);
                    setTracedIcon(null);
                    setImage(null);
                    setTrace(null);
                  }}
                >
                  Clear outline
                </button>
              )}
            </div>

            {image && (
              <div className="item-editor-trace">
                <canvas ref={canvasRef} width={280} height={200} className="item-editor-canvas" />
                <div className="trace-controls">
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
                    label="Smoothing"
                    values={[0, 2, 4, 8, 12]}
                    defaultValue={2}
                    min={0}
                    max={12}
                    step={0.5}
                    compact
                    value={smoothing}
                    onChange={setSmoothing}
                  />
                  <label className="trace-invert">
                    <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
                    <span>Light on dark</span>
                  </label>
                </div>
                <p className="hint">
                  {trace?.ok
                    ? `Traced ${trace.points} points · set size above, then apply outline`
                    : (trace?.reason ?? 'Tracing…')}
                </p>
                <button
                  type="button"
                  className="btn-solid"
                  disabled={!trace?.ok}
                  onClick={applyTraceFromPhoto}
                >
                  Use as outline
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-solid" onClick={() => void save()} disabled={busy}>
            Save item
          </button>
        </div>
      </div>
    </div>
  );
}
