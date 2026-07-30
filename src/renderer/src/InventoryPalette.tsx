import { useEffect, useState } from 'react';

import { IconEdit, IconFit, IconPlus, IconSearch, IconTrash, IconDuplicate, IconWarning } from './icons.js';
import type { InventoryState } from './InventoryView.js';
import { TraceDialog } from './TraceDialog.js';

const api = window.groundplan;
const UNITS_PER_FOOT = 120;
const PAGE_SIZE = 120;

interface Item {
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
  tracedIcon?: { paths: Array<{ points: number[]; closed: boolean }>; width: number; height: number };
}

interface Thumb {
  paths: string[];
  closed: boolean[];
  width: number;
  height: number;
}

/**
 * A plan-view preview of the item.
 *
 * Items with a drawn symbol show the real outline; the rest show a rectangle in
 * their own proportions, which still says more than a generic glyph — a 6ft
 * banquet table and an 18in chair are told apart at a glance.
 */
function Preview({ thumb, width, height }: { thumb?: Thumb | null; width?: number; height?: number }) {
  if (thumb) {
    return (
      <svg className="thumb" viewBox={`0 0 ${thumb.width} ${thumb.height}`} aria-hidden focusable={false}>
        {thumb.paths.map((points, i) =>
          thumb.closed[i] ? (
            <polygon key={i} points={points} />
          ) : (
            <polyline key={i} points={points} />
          ),
        )}
      </svg>
    );
  }

  const w = width ?? 0;
  const h = height ?? 0;
  const span = Math.max(w, h);
  if (span <= 0) {
    return (
      <svg className="thumb is-unknown" viewBox="0 0 100 100" aria-hidden focusable={false}>
        <rect x="26" y="26" width="48" height="48" rx="6" strokeDasharray="6 5" />
      </svg>
    );
  }
  const bw = (w / span) * 84;
  const bh = (h / span) * 84;
  return (
    <svg className="thumb" viewBox="0 0 100 100" aria-hidden focusable={false}>
      <rect x={(100 - bw) / 2} y={(100 - bh) / 2} width={bw} height={bh} />
    </svg>
  );
}

/**
 * A traced outline is centred on the insertion point; the preview draws into a
 * box whose origin is its top-left corner. This shifts one into the other.
 */
function centredToThumb(icon: {
  paths: Array<{ points: number[]; closed: boolean }>;
  width: number;
  height: number;
}): Thumb {
  const halfWidth = icon.width / 2;
  const halfHeight = icon.height / 2;
  return {
    paths: icon.paths.map((path) => {
      const pairs: string[] = [];
      for (let i = 0; i < path.points.length; i += 2) {
        pairs.push(`${path.points[i] + halfWidth},${path.points[i + 1] + halfHeight}`);
      }
      return pairs.join(' ');
    }),
    closed: icon.paths.map((path) => path.closed),
    width: icon.width,
    height: icon.height,
  };
}

interface Props {
  inventory: InventoryState | null;
  query: string;
  onQuery: (next: string) => void;
  category: string | null;
  onCategory: (next: string | null) => void;
  canPlace: boolean;
  onPlace: (id: string, name: string) => void;
  onChanged: () => void;
  onRemoved: (name: string) => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

function feet(units?: number): string {
  if (!units) return '—';
  const inches = units / 10;
  const ft = Math.floor(inches / 12);
  const rest = Math.round(inches - ft * 12);
  if (ft === 0) return `${Math.round(inches)}″`;
  if (rest === 12) return `${ft + 1}′`;
  return rest === 0 ? `${ft}′` : `${ft}′ ${rest}″`;
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
  return unit === '"' || unit === 'in' ? n * 10 : n * UNITS_PER_FOOT;
}

/**
 * The inventory, on the page where plans are actually drawn.
 *
 * Nobody switches tabs while building a sheet, so everything needed to put gear
 * on a drawing has to be here: searching, filtering by category, placing, and
 * editing an item in place — including making variations of one, which is how a
 * real inventory grows ("Round 60″" becomes "Round 60″ gold linen").
 *
 * The primary gesture differs from the Inventory tab on purpose. There, an item
 * row is a record and clicking its name edits it. Here, an item is something
 * you are about to put on the plan, so clicking places it and editing lives
 * behind its own control.
 */
export function InventoryPalette({
  inventory,
  query,
  onQuery,
  category,
  onCategory,
  canPlace,
  onPlace,
  onChanged,
  onRemoved,
  onError,
  onStatus,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [wDraft, setWDraft] = useState('');
  const [hDraft, setHDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, Thumb | null>>({});
  const [tracing, setTracing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // A filter change can hide whatever was being edited.
  useEffect(() => {
    setEditing(null);
    setVisibleCount(PAGE_SIZE);
  }, [query, category]);

  const items = (inventory?.items ?? []) as Item[];
  const shownItems = items.slice(0, visibleCount);

  // Previews are fetched for whatever is on screen, and only for rows that do
  // not have one yet — the main process caches the parsed plans behind this.
  useEffect(() => {
    const wanted = shownItems.filter((i) => i.symbolPath && !(i.id in thumbs)).map((i) => i.id);
    if (wanted.length === 0) return;
    let live = true;
    api
      .inventoryThumbnails(wanted.slice(0, 120))
      .then((next) => live && setThumbs((prev) => ({ ...prev, ...next })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [shownItems, thumbs]);

  const openEditor = (item: Item) => {
    setEditing(item.id);
    setNameDraft(item.name);
    setWDraft(item.width ? String(+(item.width / UNITS_PER_FOOT).toFixed(2)) : '');
    setHDraft(item.height ? String(+(item.height / UNITS_PER_FOOT).toFixed(2)) : '');
  };

  const commit = async (item: Item) => {
    const patch: { name?: string; width?: number; height?: number } = {};
    const name = nameDraft.trim();
    if (name && name !== item.name) patch.name = name;

    const width = parseLength(wDraft);
    const height = parseLength(hDraft);
    if (width && height && (width !== item.width || height !== item.height)) {
      patch.width = width;
      patch.height = height;
    } else if ((wDraft.trim() || hDraft.trim()) && !(width && height)) {
      onError('Enter sizes like 4, 4′ or 48″');
      return;
    }

    setEditing(null);
    if (Object.keys(patch).length === 0) return;

    const reply = await api.inventoryUpdate(item.id, patch);
    if (reply.ok && reply.inventory) {
      onChanged();
      onStatus(patch.name ? `Renamed to ${patch.name}` : `${item.name} is now ${feet(patch.width)} × ${feet(patch.height)}`);
    } else if (reply.reason) onError(reply.reason);
  };

  /** Copies an item and opens the copy for renaming, which is the point of it. */
  const duplicate = async (item: Item) => {
    const reply = await api.inventoryDuplicate(item.id);
    if (!reply.ok || !reply.inventory) {
      if (reply.reason) onError(reply.reason);
      return;
    }
    onChanged();
    if (reply.id) {
      setEditing(reply.id);
      setNameDraft(`${item.name} (copy)`);
      setWDraft(item.width ? String(+(item.width / UNITS_PER_FOOT).toFixed(2)) : '');
      setHDraft(item.height ? String(+(item.height / UNITS_PER_FOOT).toFixed(2)) : '');
    }
    onStatus('Made a variation — give it a name');
  };

  const remove = async (item: Item) => {
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

  const add = async () => {
    const name = newName.trim();
    setAdding(false);
    setNewName('');
    if (!name) return;
    const reply = await api.inventoryAdd(name);
    if (reply.ok && reply.inventory) {
      onChanged();
      onStatus(`Added ${name}`);
    } else if (reply.reason) onError(reply.reason);
  };

  return (
    <>
      {tracing && (
        <TraceDialog
          onClose={() => setTracing(false)}
          onAdded={(name) => {
            onChanged();
            onStatus(`Added ${name} from a traced picture`);
          }}
          onError={onError}
        />
      )}

      <div className="section-title" style={{ padding: '14px 14px 8px', margin: 0 }}>
        <span>Inventory</span>
        <span className="num">{inventory?.total ?? 0}</span>
        <button
          className="icon-btn title-action"
          title="Trace an item from a picture"
          aria-label="Trace an inventory item from a picture"
          onClick={() => setTracing(true)}
        >
          <IconFit size={12} />
        </button>
        <button
          className="icon-btn"
          title="Add an item"
          aria-label="Add an inventory item"
          onClick={() => setAdding(true)}
        >
          <IconPlus size={12} />
        </button>
      </div>

      {inventory?.notice && (
        <div className="recovery-notice is-rail" role="status">
          <IconWarning size={14} />
          <span>{inventory.notice}</span>
        </div>
      )}

      <div className="search">
        <IconSearch size={13} />
        <input
          aria-label="Search equipment by name or category"
          placeholder="Search name or category…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>

      <div className="palette-filter">
        <select value={category ?? ''} onChange={(e) => onCategory(e.target.value || null)}>
          <option value="">All categories</option>
          {inventory?.groups.map((group) => (
            <optgroup key={group.layer} label={group.label}>
              {group.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.count})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <ul className="file-list palette">
        {adding && (
          <li>
            <input
              autoFocus
              className="gear-desc-input"
              value={newName}
              placeholder="Item name"
              aria-label="New inventory item name"
              onChange={(e) => setNewName(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
          </li>
        )}

        {shownItems.map((item) =>
          editing === item.id ? (
            <li
              key={item.id}
              className="palette-editor"
              // Clicking away commits, the way the size fields elsewhere do.
              // Without it the only exit is Escape while an input still holds
              // focus, which leaves the row stuck open.
              onBlur={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                void commit(item);
              }}
            >
              <input
                autoFocus
                className="gear-desc-input"
                value={nameDraft}
                placeholder="Name"
                aria-label={`Name for ${item.name}`}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(item);
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
              <div className="palette-size">
                <input
                  className="gear-qty-input num"
                  value={wDraft}
                  placeholder="w"
                  aria-label={`Width for ${item.name} in feet`}
                  onChange={(e) => setWDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(item);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
                <span className="inv-x">×</span>
                <input
                  className="gear-qty-input num"
                  value={hDraft}
                  placeholder="h"
                  aria-label={`Height for ${item.name} in feet`}
                  onChange={(e) => setHDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(item);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
                <button
                  className="icon-btn"
                  title="Done"
                  aria-label={`Save changes to ${item.name}`}
                  onClick={() => commit(item)}
                >
                  <IconFit size={12} />
                </button>
              </div>
            </li>
          ) : (
            <li key={item.id} className="palette-row">
              <button
                className="palette-place"
                draggable={canPlace}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-groundplan-item', item.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title={
                  canPlace
                    ? `Drag ${item.name} onto the plan, or click to place it${
                        item.width ? ` · ${feet(item.width)} × ${feet(item.height)}` : ''
                      }`
                    : 'Open an editable plan to place items'
                }
                onClick={() => canPlace && onPlace(item.id, item.name)}
              >
                <Preview
                thumb={item.tracedIcon ? centredToThumb(item.tracedIcon) : thumbs[item.id]}
                width={item.width}
                height={item.height}
              />
                <span className="fname">{item.name}</span>
              </button>

              <span className="palette-actions">
                <button
                  className="icon-btn"
                  title="Rename or resize"
                  aria-label={`Rename or resize ${item.name}`}
                  onClick={() => openEditor(item)}
                >
                  <IconEdit size={11} />
                </button>
                <button
                  className="icon-btn"
                  title="Make a variation of this item"
                  aria-label={`Make a variation of ${item.name}`}
                  onClick={() => duplicate(item)}
                >
                  <IconDuplicate size={11} />
                </button>
                <button
                  className="icon-btn btn-danger"
                  title="Remove from inventory"
                  aria-label={`Remove ${item.name} from inventory`}
                  onClick={() => remove(item)}
                >
                  <IconTrash size={11} />
                </button>
              </span>
            </li>
          ),
        )}

        {shownItems.length < items.length && (
          <li className="list-more">
            <button onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, items.length - shownItems.length)} more
              <span className="num">{shownItems.length} of {items.length}</span>
            </button>
          </li>
        )}

        {(inventory?.total ?? 0) === 0 && (
          <li className="empty">
            Your inventory is empty. Import a gear list or add an item with the + above.
          </li>
        )}
        {(inventory?.total ?? 0) > 0 && items.length === 0 && (
          <li className="empty">Nothing in the inventory matches that.</li>
        )}
      </ul>
    </>
  );
}
