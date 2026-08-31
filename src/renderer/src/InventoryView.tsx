import { useEffect, useMemo, useState } from 'react';

import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import {
  IconPlus,
  IconTrash,
  IconFit,
  IconExport,
  IconWarning,
  IconFolder,
  IconEdit,
  IconMore,
} from './icons.js';
import InventoryItemEditor from './InventoryItemEditor.js';

const api = window.groundplan;
const PAGE_SIZE = 200;

interface InventoryItem {
  id: string;
  name: string;
  department?: string;
  category?: string;
  /**
   * Which drawing of the object this row is: the plan view, or a front / side /
   * rear elevation. 39% of a stock catalogue is elevations, and none of them
   * belong in a top-down plan.
   */
  view?: string;
  width?: number;
  height?: number;
  sizeSource: 'parsed' | 'user' | 'unknown' | 'symbol';
  symbolPath?: string;
  symbolName?: string;
  mappedBy?: 'auto' | 'user';
  mapReason?: string;
  tracedIcon?: { paths: Array<{ points: number[]; closed: boolean }>; width: number; height: number };
  photoDataUrl?: string;
  /** True when a photo exists but was omitted from the list payload. */
  hasPhoto?: boolean;
  timesSeen: number;
  peakQuantity: number;
  quantityOwned?: number | null;
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
  /** Drawing units — footprints accept ft/in/cm/m with this as the bare-number default. */
  units: UnitSystem;
  onChanged: () => void;
  onRemoved: (name: string) => void;
  onPlace: (id: string, name: string) => void;
  canPlace: boolean;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
  onDrawElevation?: (request: {
    baseName: string;
    view: 'front' | 'side';
    category?: string;
    planWidth?: number;
    planDepth?: number;
  }) => void;
}

interface HarvestProgress {
  scanned: number;
  processed?: number;
  total: number;
  added: number;
  failed?: number;
  cancelled?: boolean;
}

function sizeLabel(width?: number, height?: number, system: UnitSystem = 'imperial'): string {
  if (!width || !height) return '—';
  return `${formatLength(width, system)} × ${formatLength(height, system)}`;
}

function sizeHint(system: UnitSystem): string {
  return system === 'metric'
    ? 'Enter sizes like 120cm, 1.2m (or 4\', 48")'
    : 'Enter sizes like 4\', 48", 4\' 6" (or 120cm, 1.2m)';
}

type InventoryReadiness = 'all' | 'placeable' | 'needs-size' | 'needs-shape' | 'elevations';

const READINESS_FILTERS: Array<{ id: InventoryReadiness; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'placeable', label: 'Ready to place' },
  { id: 'needs-size', label: 'Needs size' },
  { id: 'needs-shape', label: 'Needs outline' },
  { id: 'elevations', label: 'Elevations' },
];

function isPlaceable(item: InventoryItem): boolean {
  return Boolean(
    (item.view ?? 'plan') === 'plan' &&
      ((item.tracedIcon?.paths.length ?? 0) > 0 || item.symbolPath || (item.width && item.height)),
  );
}

function matchesReadiness(item: InventoryItem, filter: InventoryReadiness): boolean {
  if (filter === 'all') return true;
  if (filter === 'placeable') return isPlaceable(item);
  if (filter === 'needs-size') return !item.width || !item.height;
  if (filter === 'needs-shape') {
    return (item.view ?? 'plan') === 'plan' && !item.symbolPath && !(item.tracedIcon?.paths.length ?? 0);
  }
  return (item.view ?? 'plan') !== 'plan';
}

function InventoryPreview({ item, photo }: { item: InventoryItem; photo?: string | null }) {
  if (photo) return <img src={photo} alt="" />;
  const icon = item.tracedIcon;
  if (icon?.paths.length && icon.width > 0 && icon.height > 0) {
    return (
      <svg
        className="inv-thumb-outline"
        viewBox={`${-icon.width / 2} ${-icon.height / 2} ${icon.width} ${icon.height}`}
        aria-hidden
      >
        {icon.paths.map((path, index) => {
          const points: string[] = [];
          for (let i = 0; i < path.points.length; i += 2) {
            points.push(`${path.points[i]},${path.points[i + 1]}`);
          }
          return path.closed ? (
            <polygon key={index} points={points.join(' ')} />
          ) : (
            <polyline key={index} points={points.join(' ')} />
          );
        })}
      </svg>
    );
  }
  return (
    <span
      className={`inv-thumb-dot${item.symbolPath ? ' has-symbol' : ' missing'}`}
      title={item.symbolPath ? 'Has plan symbol' : 'No outline'}
    />
  );
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
  units,
  onChanged,
  onRemoved,
  onPlace,
  canPlace,
  onError,
  onStatus,
  onDrawElevation,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [wDraft, setWDraft] = useState('');
  const [hDraft, setHDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [harvestProgress, setHarvestProgress] = useState<HarvestProgress | null>(null);
  const [photos, setPhotos] = useState<Record<string, string | null>>({});
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.inventoryHealth>> | null>(null);
  const [readiness, setReadiness] = useState<InventoryReadiness>('all');

  useEffect(() => {
    setEditing(null);
    setVisibleCount(PAGE_SIZE);
  }, [query, department, readiness]);

  useEffect(() => api.onHarvestProgress(setHarvestProgress), []);

  const items = inventory?.items ?? [];
  const filteredItems = useMemo(
    () => items.filter((item) => matchesReadiness(item, readiness)),
    [items, readiness],
  );
  const shownItems = filteredItems.slice(0, visibleCount);

  const readinessCounts = useMemo(() => {
    const counts = new Map<InventoryReadiness, number>();
    for (const filter of READINESS_FILTERS) {
      counts.set(filter.id, items.filter((item) => matchesReadiness(item, filter.id)).length);
    }
    return counts;
  }, [items]);

  useEffect(() => {
    let live = true;
    void api
      .inventoryHealth()
      .then((report) => {
        if (live) setHealth(report);
      })
      .catch(() => {
        if (live) setHealth(null);
      });
    return () => {
      live = false;
    };
  }, [inventory?.total, inventory?.path, inventory?.notice, items.length]);

  const mergeStarter = async () => {
    const reply = await api.inventoryMergeStarter();
    if (!reply.ok) {
      if (reply.reason) onError(reply.reason);
      return;
    }
    onChanged();
    onStatus(
      reply.seeded
        ? `Loaded ${reply.items ?? 0} starter equipment items`
        : `Merged ${reply.toppedUp ?? 0} starter shapes into the library`,
    );
  };

  useEffect(() => {
    const wanted = shownItems.filter((i) => i.hasPhoto && !(i.id in photos)).map((i) => i.id);
    if (wanted.length === 0) return;
    let live = true;
    void Promise.all(
      wanted.slice(0, 60).map(async (id) => {
        const reply = await api.inventoryGetPhoto(id);
        return [id, reply.ok && reply.photoDataUrl ? reply.photoDataUrl : null] as const;
      }),
    ).then((pairs) => {
      if (!live) return;
      setPhotos((prev) => {
        const next = { ...prev };
        for (const [id, url] of pairs) next[id] = url;
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [shownItems, photos]);
  const sized = useMemo(() => items.filter((i) => i.width && i.height).length, [items]);
  const editorItem = editorId ? items.find((i) => i.id === editorId) ?? null : null;

  const beginSizeEdit = (item: InventoryItem) => {
    setEditing(item.id);
    setWDraft(item.width ? formatLength(item.width, units) : '');
    setHDraft(item.height ? formatLength(item.height, units) : '');
  };

  const commitSize = async (item: InventoryItem) => {
    const width = parseLength(wDraft, units);
    const height = parseLength(hDraft, units);
    setEditing(null);
    if (width == null || height == null || width <= 0 || height <= 0) {
      if (wDraft.trim() || hDraft.trim()) onError(sizeHint(units));
      return;
    }
    const reply = await api.inventoryUpdate(item.id, { width, height });
    if (reply.ok) {
      onChanged();
      onStatus(`${item.name} is now ${sizeLabel(width, height, units)}`);
    } else if (reply.reason) onError(reply.reason);
  };

  const rename = async (item: InventoryItem) => {
    const wanted = nameDraft.trim();
    setRenaming(null);
    if (!wanted || wanted === item.name) return;
    const reply = await api.inventoryUpdate(item.id, { name: wanted });
    if (reply.ok) {
      onChanged();
      onStatus(`Renamed to ${wanted}`);
    } else if (reply.reason) onError(reply.reason);
  };

  /** Copies an item so variations of the same thing can live side by side. */
  const duplicate = async (item: InventoryItem) => {
    const reply = await api.inventoryDuplicate(item.id);
    if (reply.ok) {
      onChanged();
      onStatus(`Copied ${item.name}: rename the copy to tell them apart`);
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
          `Scan cancelled after ${reply.processed ?? reply.scanned} of ${reply.plans} plans: kept ${reply.added} new symbols`,
        );
      } else {
        onStatus(
          `Read ${reply.scanned.toLocaleString()} plans: ${reply.added} new symbols, ${reply.updated} items now have real geometry`,
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
    if (reply.ok) {
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
          Import gear lists, CSV, Spotlight inventory XML, or shape libraries and every item joins the inventory. It
          builds up across jobs, so the next plan can be drawn from your real inventory.
        </p>
        <div className="placeholder-actions">
          <button className="btn-primary" onClick={() => void mergeStarter()}>
            <IconPlus size={14} />
            Restore starter equipment
          </button>
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
              const from =
                reply.inventoryName != null
                  ? ` from ${reply.inventoryName}`
                  : reply.inventoryNames && reply.inventoryNames.length > 1
                    ? ` from ${reply.inventoryNames.length} inventories`
                    : '';
              onStatus(
                `Added ${reply.added} items from ${reply.files} file${reply.files === 1 ? '' : 's'}${from}`,
              );
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
      {health && !health.ok && health.issues.length > 0 && (
        <div className="recovery-notice" role="status">
          <IconWarning size={14} />
          <span>{health.issues[0]}</span>
          <button type="button" className="btn-outline" onClick={() => void mergeStarter()}>
            Merge starter shapes
          </button>
        </div>
      )}
      <header className="inventory-workspace-head">
        <div className="inventory-workspace-title">
          <span className="inventory-workspace-eyebrow">Company library</span>
          <strong>Equipment inventory</strong>
          <span>
            {inventory.total.toLocaleString()} items · {sized.toLocaleString()} sized
            {health ? ` · ${health.placeable.toLocaleString()} placeable` : ''}
          </span>
        </div>
        <div className="inventory-primary-actions">
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <IconPlus size={13} />
            New item
          </button>
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
              const from =
                reply.inventoryName != null
                  ? ` · ${reply.inventoryName}`
                  : reply.inventoryNames && reply.inventoryNames.length > 1
                    ? ` · ${reply.inventoryNames.length} Spotlight inventories`
                    : '';
              onStatus(`Added ${reply.added} new, updated ${reply.updated}${from}`);
            }}
            title="Import gear lists, CSV, Spotlight inventory XML, or shape libraries"
          >
            <IconExport size={13} />
            Import…
          </button>
          <details className="inventory-more-actions">
            <summary className="btn-outline">
              <IconMore size={13} />
              More
            </summary>
            <div className="inventory-more-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => void mergeStarter()}
                title="Add missing starter chairs, tables, doors, and AV shapes without wiping your library"
              >
                <IconPlus size={13} />
                Merge starter equipment
              </button>
              <button
                role="menuitem"
                onClick={async () => {
                  const reply = await api.inventoryImportPack();
                  if (reply.cancelled) return;
                  if (reply.ok) {
                    onChanged();
                    onStatus(`Imported pack: ${reply.added} new, ${reply.updated} updated`);
                  } else if (reply.reason) onError(reply.reason);
                }}
              >
                <IconFolder size={13} />
                Import inventory pack…
              </button>
              <button
                role="menuitem"
                onClick={async () => {
                  const reply = await api.inventoryExportPack();
                  if (reply.cancelled) return;
                  if (reply.ok) onStatus(`Exported ${reply.items ?? 0} items for other computers`);
                  else if (reply.reason) onError(reply.reason);
                }}
              >
                <IconExport size={13} />
                Export inventory pack…
              </button>
              <span className="inventory-menu-divider" />
              <button role="menuitem" onClick={harvest} disabled={!!harvestProgress}>
                <IconFit size={13} />
                Import outlines from plans…
              </button>
              <button role="menuitem" onClick={mapShapes}>
                <IconFit size={13} />
                Match missing outlines
              </button>
            </div>
          </details>
        </div>
      </header>

      <div className="inventory-readiness" aria-label="Inventory readiness filters">
        {READINESS_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={readiness === filter.id ? 'active' : ''}
            aria-pressed={readiness === filter.id}
            onClick={() => setReadiness(filter.id)}
          >
            <span>{filter.label}</span>
            <small className="num">{readinessCounts.get(filter.id) ?? 0}</small>
          </button>
        ))}
        {health && (
          <span className={`inventory-health-chip${health.seatingReady ? ' is-ready' : ' is-warning'}`}>
            Seating {health.seatingReady ? 'ready' : 'needs furniture'}
          </span>
        )}
      </div>

      <div className="inventory-column-head" aria-hidden>
        <span>Item</span>
        <span>Footprint</span>
        <span>Jobs</span>
        <span>Actions</span>
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

        {filteredItems.length === 0 ? (
          <p className="empty" style={{ padding: 24 }}>
            Nothing matches this search or readiness filter.
          </p>
        ) : (
          shownItems.map((item) => (
            <div className="gear-row inv-row" key={item.id}>
              <span className="inv-thumb" aria-hidden>
                <InventoryPreview item={item} photo={photos[item.id]} />
              </span>
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
                <span className="inv-item-copy">
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
                  </span>
                  <span className="inv-item-meta">
                    {item.category && <span>{item.category.replace(/-/g, ' ')}</span>}
                    <span>{(item.view ?? 'plan').replace('front-side', 'front + side')}</span>
                    {item.department && <span>{item.department}</span>}
                    {item.quantityOwned != null && <span className="num">{item.quantityOwned} owned</span>}
                    {item.symbolPath && (
                      <span
                        className={`inv-symbol${item.mappedBy === 'auto' ? ' is-auto' : ''}`}
                        title={
                          item.mappedBy === 'auto'
                            ? `Matched automatically to "${item.symbolName}": ${item.mapReason}.`
                            : 'Places as the real drawn symbol'
                        }
                      >
                        {item.mappedBy === 'auto' ? `matched · ${item.symbolName}` : 'outline ready'}
                      </span>
                    )}
                  </span>
                </span>
              )}

              {editing === item.id ? (
                <span
                  className="inv-size-edit"
                  onBlur={(e) => {
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    commitSize(item);
                  }}
                >
                  <input
                    autoFocus
                    className="gear-qty-input num"
                    value={wDraft}
                    placeholder={units === 'metric' ? 'w cm/m' : "w ' / \""}
                    aria-label={`Width for ${item.name}`}
                    onChange={(e) => setWDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitSize(item);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <span className="inv-x">×</span>
                  <input
                    className="gear-qty-input num"
                    value={hDraft}
                    placeholder={units === 'metric' ? 'h cm/m' : "h ' / \""}
                    aria-label={`Height for ${item.name}`}
                    onChange={(e) => setHDraft(e.target.value)}
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
                      ? 'Size you set: used when placing'
                      : item.width
                        ? 'Size guessed from the name. Click to correct it.'
                        : 'No size yet. Click to set one.'
                  }
                  onClick={() => beginSizeEdit(item)}
                >
                  {item.width ? sizeLabel(item.width, item.height, units) : 'set size'}
                </button>
              )}

              <span className="inv-seen num" title={`Used on ${item.timesSeen} job${item.timesSeen === 1 ? '' : 's'}`}>
                {item.timesSeen}
              </span>

              <span className="gear-actions">
                <button
                  className="icon-btn"
                  title="Edit name, size, and icon"
                  aria-label={`Edit ${item.name}`}
                  onClick={() => setEditorId(item.id)}
                >
                  <IconEdit size={13} />
                </button>
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
        {shownItems.length < filteredItems.length && (
          <div className="inventory-more">
            <button className="btn-outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, filteredItems.length - shownItems.length)} more
              <span className="num">{shownItems.length} of {filteredItems.length}</span>
            </button>
          </div>
        )}
      </div>

      {editorItem && (
        <InventoryItemEditor
          item={editorItem}
          catalogNames={(inventory?.items ?? []).map((row) => row.name)}
          units={units}
          onClose={() => setEditorId(null)}
          onSaved={onChanged}
          onError={onError}
          onStatus={onStatus}
          onDrawElevation={onDrawElevation}
        />
      )}
    </div>
  );
}
