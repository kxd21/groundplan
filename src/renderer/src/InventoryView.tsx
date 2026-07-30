import { useEffect, useMemo, useState } from 'react';

import { IconPlus, IconTrash, IconFit, IconExport, IconWarning } from './icons.js';

const api = window.groundplan;
const UNITS_PER_FOOT = 120;
const PAGE_SIZE = 200;

interface InventoryItem {
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
  timesSeen: number;
  peakQuantity: number;
  notes?: string;
  addedAt: string;
}

export interface InventoryState {
  items: InventoryItem[];
  departments: Array<{ name: string; count: number }>;
  /** Category counts, already grouped into the drawing's layer families. */
  groups: Array<{
    layer: string;
    label: string;
    categories: Array<{ id: string; label: string; count: number }>;
  }>;
  total: number;
  path: string;
  notice?: string;
}

interface Props {
  inventory: InventoryState | null;
  query: string;
  department: string | null;
  onChanged: () => void;
  onRemoved: (name: string) => void;
  onPlace: (id: string, name: string) => void;
  canPlace: boolean;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

interface HarvestProgress {
  scanned: number;
  processed?: number;
  total: number;
  added: number;
  failed?: number;
  cancelled?: boolean;
}

/** Logical units to a feet-and-inches string. */
function feet(units?: number): string {
  if (!units) return '—';
  const totalInches = units / 10;
  const ft = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - ft * 12);
  if (ft === 0) return `${Math.round(totalInches)}″`;
  if (inches === 12) return `${ft + 1}′`;
  return inches === 0 ? `${ft}′` : `${ft}′ ${inches}″`;
}

/** Accepts `4`, `4'`, `48"`, `4ft`, `4.5` — feet unless inches are marked. */
function parseLength(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(''|'|"|in|ft)?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  return unit === '"' || unit === 'in' ? n * 10 : n * UNITS_PER_FOOT;
}

/**
 * The company's equipment inventory.
 *
 * Separate from a job's gear list: this accumulates across jobs so a new plan
 * can be built from the real inventory. Footprints corrected here are
 * remembered and used by every later placement.
 */
export function InventoryView({
  inventory,
  query,
  department,
  onChanged,
  onRemoved,
  onPlace,
  canPlace,
  onError,
  onStatus,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [wDraft, setWDraft] = useState('');
  const [hDraft, setHDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [harvestProgress, setHarvestProgress] = useState<HarvestProgress | null>(null);

  useEffect(() => {
    setEditing(null);
    setVisibleCount(PAGE_SIZE);
  }, [query, department]);

  useEffect(() => api.onHarvestProgress(setHarvestProgress), []);

  const items = inventory?.items ?? [];
  const shownItems = items.slice(0, visibleCount);
  const sized = useMemo(() => items.filter((i) => i.width && i.height).length, [items]);

  const commitSize = async (item: InventoryItem) => {
    const width = parseLength(wDraft);
    const height = parseLength(hDraft);
    setEditing(null);
    if (!width || !height) {
      if (wDraft.trim() || hDraft.trim()) onError('Enter sizes like 4, 4′ or 48″');
      return;
    }
    const reply = await api.inventoryUpdate(item.id, { width, height });
    if (reply.ok && reply.inventory) {
      onChanged();
      onStatus(`${item.name} is now ${feet(width)} × ${feet(height)}`);
    } else if (reply.reason) onError(reply.reason);
  };

  const rename = async (item: InventoryItem) => {
    const wanted = nameDraft.trim();
    setRenaming(null);
    if (!wanted || wanted === item.name) return;
    const reply = await api.inventoryUpdate(item.id, { name: wanted });
    if (reply.ok && reply.inventory) {
      onChanged();
      onStatus(`Renamed to ${wanted}`);
    } else if (reply.reason) onError(reply.reason);
  };

  /** Copies an item so variations of the same thing can live side by side. */
  const duplicate = async (item: InventoryItem) => {
    const reply = await api.inventoryDuplicate(item.id);
    if (reply.ok && reply.inventory) {
      onChanged();
      onStatus(`Copied ${item.name} — rename the copy to tell them apart`);
      if (reply.id) {
        setRenaming(reply.id);
        setNameDraft(`${item.name} (copy)`);
      }
    } else if (reply.reason) onError(reply.reason);
  };

  const remove = async (item: InventoryItem) => {
    try {
      const approved = await api.confirm({
        title: 'Remove inventory item',
        message: `Remove “${item.name}” from the company inventory?`,
        detail: 'Plans that already use this item are not changed. You can undo this until your next inventory edit.',
        confirmLabel: 'Remove Item',
        danger: true,
      });
      if (approved !== true) return;
      const reply = await api.inventoryRemove(item.id);
      if (reply.ok) {
        onChanged();
        if (reply.undoAvailable) onRemoved(item.name);
      } else if (reply.reason) onError(reply.reason);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Pulls drawn symbols out of existing plans.
   *
   * Items that arrive from a gear list have a name and a size but no shape, so
   * they place as plain boxes. The plans hold the outlines someone actually
   * drew — this is what makes a projector place as a projector.
   */
  const harvest = async () => {
    if (harvestProgress) return;
    setHarvestProgress({ scanned: 0, processed: 0, total: 0, added: 0, failed: 0 });
    try {
      const reply = await api.inventoryHarvest();
      if (!reply) return;
      if (!reply.ok) {
        if (reply.reason) onError(reply.reason);
        return;
      }
      onChanged();
      if (reply.cancelled) {
        onStatus(
          `Scan cancelled after ${reply.processed ?? reply.scanned} of ${reply.plans} plans — kept ${reply.added} new symbols`,
        );
      } else {
        onStatus(
          `Read ${reply.scanned.toLocaleString()} plans — ${reply.added} new symbols, ${reply.updated} items now have real geometry`,
        );
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setHarvestProgress(null);
    }
  };

  const cancelHarvest = async () => {
    if (!harvestProgress || harvestProgress.cancelled) return;
    const reply = await api.cancelInventoryHarvest();
    if (reply.ok) {
      setHarvestProgress((progress) => (progress ? { ...progress, cancelled: true } : progress));
    } else if (reply.reason) {
      onError(reply.reason);
    }
  };

  /**
   * Gives every unshaped item the closest drawn symbol.
   *
   * Matching several hundred gear-list descriptions to shapes by hand is not
   * realistic, so each is classified by what it is — projector, speaker,
   * truss — and matched to a symbol harvested from real plans.
   */
  const mapShapes = async () => {
    const reply = await api.inventoryMapSymbols();
    if (!reply.ok) {
      if (reply.reason) onError(reply.reason);
      return;
    }
    onChanged();
    onStatus(
      `Matched ${reply.mapped} items to a shape · ${reply.alreadyHad} already had one · ` +
        `${reply.notDrawn} are cable or hardware that is never drawn`,
    );
  };

  const add = async () => {
    const name = newName.trim();
    setAdding(false);
    setNewName('');
    if (!name) return;
    const reply = await api.inventoryAdd(name, department ?? undefined);
    if (reply.ok && reply.inventory) {
      onChanged();
      onStatus(`Added ${name}`);
    } else if (reply.reason) onError(reply.reason);
  };

  const harvestProcessed = harvestProgress
    ? (harvestProgress.processed ?? harvestProgress.scanned + (harvestProgress.failed ?? 0))
    : 0;
  const harvestStatus = harvestProgress ? (
    <div className="harvest-progress" role="status" aria-live="polite">
      <div className="harvest-progress-copy">
        <strong>{harvestProgress.cancelled ? 'Cancelling symbol scan…' : 'Importing symbols from plans…'}</strong>
        <span>
          {harvestProgress.total > 0
            ? `${harvestProcessed.toLocaleString()} of ${harvestProgress.total.toLocaleString()} processed · ` +
              `${harvestProgress.scanned.toLocaleString()} read · ${harvestProgress.added.toLocaleString()} symbols added`
            : 'Preparing the selected folder…'}
        </span>
      </div>
      <progress
        aria-label="Plan symbol import progress"
        value={harvestProcessed}
        max={Math.max(harvestProgress.total, 1)}
      />
      <button
        className="btn-outline"
        onClick={() => void cancelHarvest()}
        disabled={harvestProgress.cancelled || harvestProgress.total === 0}
      >
        {harvestProgress.cancelled ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  ) : null;

  if (!inventory || inventory.total === 0) {
    return (
      <div className="placeholder">
        {harvestStatus}
        <h1>Your equipment inventory is empty</h1>
        <p>
          Import the gear lists your rental system prints and every item on them joins the inventory. It builds up
          across jobs, so the next plan can be drawn from your real inventory.
        </p>
        <div className="placeholder-actions">
          <button
            className="btn-outline"
            onClick={async () => {
              const reply = await api.inventoryImport();
              if (!reply) return;
              if (!reply.ok) {
                if (reply.reason) onError(reply.reason);
                return;
              }
              onChanged();
              onStatus(`Added ${reply.added} items from ${reply.files} file${reply.files === 1 ? '' : 's'}`);
            }}
          >
            <IconExport size={14} />
            Upload assets…
          </button>
          <button className="btn-outline" onClick={harvest} disabled={!!harvestProgress}>
            <IconFit size={14} />
            Import symbols from plans…
          </button>
          <button className="btn-outline" onClick={() => setAdding(true)}>
            <IconPlus size={14} />
            Add an item
          </button>
        </div>
        {adding && (
          <div className="field" style={{ width: 300, marginTop: 8 }}>
            <input
              autoFocus
              value={newName}
              placeholder="Item name"
              onChange={(e) => setNewName(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="gear">
      {inventory.notice && (
        <div className="recovery-notice" role="status">
          <IconWarning size={14} />
          <span>{inventory.notice}</span>
        </div>
      )}
      {harvestStatus}
      <div className="inv-bar">
        <span className="num">
          {items.length.toLocaleString()} of {inventory.total.toLocaleString()} items · {sized.toLocaleString()} sized
        </span>
        <div className="spacer" />
        <button
          onClick={async () => {
            const reply = await api.inventoryImport();
            if (!reply) return;
            if (!reply.ok) {
              if (reply.reason) onError(reply.reason);
              return;
            }
            onChanged();
            onStatus(`Added ${reply.added} new, updated ${reply.updated}`);
          }}
        >
          <IconExport size={13} />
          Upload…
        </button>
        <button
          onClick={harvest}
          disabled={!!harvestProgress}
          title="Take real drawn symbols out of a folder of plans"
        >
          <IconFit size={13} />
          Import symbols…
        </button>
        <button onClick={mapShapes} title="Give every remaining item the closest drawn shape">
          <IconFit size={13} />
          Match shapes
        </button>
        <button onClick={() => setAdding(true)}>
          <IconPlus size={13} />
          Add item
        </button>
      </div>

      <div className="gear-scroll">
        {adding && (
          <div className="gear-row">
            <input
              className="gear-desc-input"
              autoFocus
              value={newName}
              placeholder="Item name"
              onChange={(e) => setNewName(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
          </div>
        )}

        {items.length === 0 ? (
          <p className="empty" style={{ padding: 24 }}>
            Nothing matches that search.
          </p>
        ) : (
          shownItems.map((item) => (
            <div className="gear-row inv-row" key={item.id}>
              {renaming === item.id ? (
                <input
                  autoFocus
                  className="gear-desc-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => rename(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
              <span
                className="inv-name"
                role="button"
                tabIndex={0}
                title="Click to rename"
                onClick={() => {
                  setRenaming(item.id);
                  setNameDraft(item.name);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  setRenaming(item.id);
                  setNameDraft(item.name);
                }}
              >
                {item.name}
                {item.symbolPath && (
                  <em
                    className={`inv-symbol${item.mappedBy === 'auto' ? ' is-auto' : ''}`}
                    title={
                      item.mappedBy === 'auto'
                        ? `Matched automatically to "${item.symbolName}" — ${item.mapReason}. Click the size to correct it.`
                        : 'Places as the real drawn symbol'
                    }
                  >
                    {item.mappedBy === 'auto' ? `≈ ${item.symbolName}` : 'symbol'}
                  </em>
                )}
                {item.department && <em className="icat">{item.department}</em>}
              </span>
              )}

              {editing === item.id ? (
                <span className="inv-size-edit">
                  <input
                    autoFocus
                    className="gear-qty-input num"
                    value={wDraft}
                    placeholder="w"
                    onChange={(e) => setWDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitSize(item);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <span className="inv-x">×</span>
                  <input
                    className="gear-qty-input num"
                    value={hDraft}
                    placeholder="h"
                    onChange={(e) => setHDraft(e.target.value)}
                    onBlur={() => commitSize(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                </span>
              ) : (
                <button
                  className={`inv-size num${item.sizeSource === 'user' ? ' is-set' : ''}`}
                  title={
                    item.sizeSource === 'user'
                      ? 'Size you set — used when placing'
                      : item.width
                        ? 'Size guessed from the name. Click to correct it.'
                        : 'No size yet. Click to set one.'
                  }
                  onClick={() => {
                    setEditing(item.id);
                    setWDraft(item.width ? String(+(item.width / UNITS_PER_FOOT).toFixed(2)) : '');
                    setHDraft(item.height ? String(+(item.height / UNITS_PER_FOOT).toFixed(2)) : '');
                  }}
                >
                  {item.width ? `${feet(item.width)} × ${feet(item.height)}` : 'set size'}
                </button>
              )}

              <span className="inv-seen num" title={`On ${item.timesSeen} job${item.timesSeen === 1 ? '' : 's'}`}>
                ×{item.timesSeen}
              </span>

              <span className="gear-actions">
                <button
                  className="icon-btn"
                  disabled={!canPlace}
                  title={canPlace ? 'Place on the plan' : 'Open a plan first'}
                  aria-label={`Place ${item.name} on the plan`}
                  onClick={() => onPlace(item.id, item.name)}
                >
                  <IconFit size={13} />
                </button>
                <button
                  className="icon-btn"
                  title="Make a variation of this item"
                  aria-label={`Make a variation of ${item.name}`}
                  onClick={() => duplicate(item)}
                >
                  <IconPlus size={13} />
                </button>
                <button
                  className="icon-btn btn-danger"
                  title="Remove from inventory"
                  aria-label={`Remove ${item.name} from inventory`}
                  onClick={() => remove(item)}
                >
                  <IconTrash size={13} />
                </button>
              </span>
            </div>
          ))
        )}
        {shownItems.length < items.length && (
          <div className="inventory-more">
            <button className="btn-outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, items.length - shownItems.length)} more
              <span className="num">{shownItems.length} of {items.length}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
