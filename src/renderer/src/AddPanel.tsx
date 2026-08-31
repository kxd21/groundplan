/**
 * Unified Add surface for Place mode.
 *
 * One searchable, category-bucketed list of inventory (and name-only gear)
 * rows, filtered to the active plan view so elevation drawings never stamp
 * into a top-down plan.
 */

import { useEffect, useMemo, useState } from 'react';

import { classify, type ItemView } from '../../inventory/classify.js';
import { formatLength, type UnitSystem } from '../../format/units.js';
import {
  ADD_CATEGORY_OPTIONS,
  addBucket,
  type AddCategoryId,
} from './add-categories.js';
import { IconCheck, IconEdit, IconPlus, IconSearch } from './icons.js';

export type PlanViewMode = 'top' | 'front' | 'side';

export interface AddPanelItem {
  id?: string;
  /** Insert-catalog fallback when this is a stock shape, not an inventory row. */
  leafId?: string;
  name: string;
  /** Actual stamped name; stock rows may have a friendlier browser label. */
  placeName?: string;
  category?: string | null;
  view?: string | null;
  width?: number;
  height?: number;
  symbolPath?: string;
  tracedIcon?: {
    paths: Array<{ points: number[]; closed: boolean }>;
    width: number;
    height: number;
  };
}

interface Props {
  items: AddPanelItem[];
  recentNames: string[];
  planView: PlanViewMode;
  query: string;
  onQuery: (q: string) => void;
  category: string;
  onCategory: (c: string) => void;
  onPlaceInventory: (id: string, name: string) => void;
  onPlaceStock: (leafId: string) => void;
  armedInventoryId?: string | null;
  armedStockName?: string | null;
  onStopPlacement: () => void;
  onCreateItem: () => void;
  onManageInventory: () => void;
  units: UnitSystem;
  editable: boolean;
}

const PAGE_SIZE = 120;

const FRONT_VIEWS: ReadonlySet<ItemView> = new Set(['front', 'front-side', 'rear']);
const SIDE_VIEWS: ReadonlySet<ItemView> = new Set(['side', 'front-side']);

function resolveView(item: AddPanelItem): ItemView {
  const raw = item.view;
  if (raw === 'plan' || raw === 'front' || raw === 'side' || raw === 'rear' || raw === 'front-side') {
    return raw;
  }
  // Missing / unknown → infer from the name suffix; bare names are plan.
  return classify(item.name).view;
}

function baseNameOf(item: AddPanelItem): string {
  return classify(item.name).baseName;
}

/**
 * Keeps drawings that belong in the active viewport.
 *
 * Top is plan-only. Front / side prefer elevation siblings (FV, SV, FV-SV, R);
 * a plan row is kept only when that object has no elevation twin in the list.
 */
export function filterItemsForPlanView<T extends AddPanelItem>(
  items: T[],
  planView: PlanViewMode,
): T[] {
  if (planView === 'top') {
    return items.filter((item) => resolveView(item) === 'plan');
  }

  const elevationViews = planView === 'front' ? FRONT_VIEWS : SIDE_VIEWS;
  const hasElevation = new Set<string>();
  for (const item of items) {
    if (elevationViews.has(resolveView(item))) hasElevation.add(baseNameOf(item));
  }

  return items.filter((item) => {
    const view = resolveView(item);
    if (elevationViews.has(view)) return true;
    if (view === 'plan') return !hasElevation.has(baseNameOf(item));
    return false;
  });
}

function itemBucket(item: AddPanelItem): AddCategoryId {
  const category = item.category ?? classify(item.name).category;
  return addBucket(category);
}

function placeItem(
  item: AddPanelItem,
  onPlaceInventory: Props['onPlaceInventory'],
  onPlaceStock: Props['onPlaceStock'],
) {
  if (item.id) onPlaceInventory(item.id, item.name);
  else if (item.leafId) onPlaceStock(item.leafId);
}

function itemLabel(item: AddPanelItem): string {
  return item.category ? item.category.replace(/-/g, ' ') : itemBucket(item);
}

function itemSize(item: AddPanelItem, units: UnitSystem): string | null {
  if (!item.width || !item.height) return null;
  return `${formatLength(item.width, units)} × ${formatLength(item.height, units)}`;
}

/** Draw the outline that will be stamped; fall back to a quiet category tile. */
function AssetPreview({ item }: { item: AddPanelItem }) {
  const icon = item.tracedIcon;
  if (icon?.paths.length && icon.width > 0 && icon.height > 0) {
    return (
      <svg
        className="add-item-preview has-outline"
        viewBox={`${-icon.width / 2} ${-icon.height / 2} ${icon.width} ${icon.height}`}
        aria-hidden
        focusable={false}
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

  const bucket = itemBucket(item);
  const glyph: Record<AddCategoryId, string> = {
    all: '•',
    room: 'R',
    furniture: 'F',
    stage: 'S',
    production: 'AV',
    annotations: 'T',
    custom: '+',
  };
  return (
    <span className={`add-item-preview is-${bucket}`} aria-hidden>
      {glyph[bucket]}
    </span>
  );
}

/**
 * Place-mode Add panel: search, recent chips, category buckets, and a
 * click-to-place list filtered by Top / Front / Side.
 */
export function AddPanel({
  items,
  recentNames,
  planView,
  query,
  onQuery,
  category,
  onCategory,
  onPlaceInventory,
  onPlaceStock,
  armedInventoryId,
  armedStockName,
  onStopPlacement,
  onCreateItem,
  onManageInventory,
  units,
  editable,
}: Props) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, category, planView]);

  const viewItems = useMemo(() => filterItemsForPlanView(items, planView), [items, planView]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const bucket = (category || 'all') as AddCategoryId;
    return viewItems.filter((item) => {
      if (bucket !== 'all' && itemBucket(item) !== bucket) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        (item.category ?? '').toLowerCase().replace(/-/g, ' ').includes(needle)
      );
    });
  }, [viewItems, query, category]);

  // Reset pagination when the visible set shrinks for a new filter.
  const shown = filtered.slice(0, visibleCount);
  const activeCategory = (category || 'all') as string;

  const recentRows = useMemo(() => {
    if (recentNames.length === 0) return [];
    const byName = new Map(viewItems.map((item) => [item.name, item]));
    return recentNames
      .map((name) => byName.get(name) ?? { name })
      .filter((item) => {
        // Recents still respect the active view — no FV chip in Top.
        return filterItemsForPlanView([item], planView).length > 0;
      });
  }, [recentNames, viewItems, planView]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<AddCategoryId, number>();
    counts.set('all', viewItems.length);
    for (const item of viewItems) {
      const bucket = itemBucket(item);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return counts;
  }, [viewItems]);

  const armedItem = viewItems.find(
    (item) =>
      (item.id != null && item.id === armedInventoryId) ||
      (item.leafId != null && item.placeName === armedStockName),
  );

  return (
    <div className="add-panel">
      {armedItem && (
        <div className="add-placement-status" role="status">
          <span className="add-placement-status-icon" aria-hidden>
            <IconCheck size={13} />
          </span>
          <span className="add-placement-status-copy">
            <strong>{armedItem.name}</strong>
            <small>Ready · click the drawing to place · Esc stops</small>
          </span>
          <button type="button" onClick={onStopPlacement}>
            Stop
          </button>
        </div>
      )}

      <div className="search inventory-palette-search">
        <IconSearch size={13} />
        <input
          aria-label="Search items to add"
          placeholder="Search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>

      {recentRows.length > 0 && (
        <div className="equipment-recent" aria-label="Recently placed">
          <div className="section-title">
            <span>Recent</span>
          </div>
          <div className="equipment-recent-chips">
            {recentRows.map((item) => (
              <button
                key={`recent:${item.id ?? item.name}`}
                type="button"
                className="equipment-recent-chip"
                disabled={!editable}
                title={editable ? `Place ${item.name}` : 'Open an editable plan to place items'}
                onClick={() => editable && placeItem(item, onPlaceInventory, onPlaceStock)}
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="equipment-recent" aria-label="Add categories">
        <div className="equipment-recent-chips" role="tablist">
          {ADD_CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={activeCategory === opt.id}
              className={`equipment-recent-chip${activeCategory === opt.id ? ' is-armed' : ''}`}
              onClick={() => onCategory(opt.id)}
            >
              <span>{opt.label}</span>
              <small className="num">{categoryCounts.get(opt.id) ?? 0}</small>
            </button>
          ))}
        </div>
      </div>

      <ul className="file-list palette">
        {shown.map((item) => {
          const key = item.id ?? item.leafId ?? item.name;
          const armed =
            (item.id != null && item.id === armedInventoryId) ||
            (item.leafId != null && item.placeName === armedStockName);
          const size = itemSize(item, units);
          return (
            <li
              key={key}
              className={`palette-row add-item-row${armed ? ' is-armed' : ''}${draggingKey === key ? ' is-dragging' : ''}`}
            >
              <button
                type="button"
                className="palette-place"
                draggable={editable && Boolean(item.id)}
                disabled={!editable}
                title={
                  editable
                    ? `Drag ${item.name} onto the plan, or click to place it`
                    : 'Open an editable plan to place items'
                }
                aria-pressed={armed}
                onClick={() => editable && placeItem(item, onPlaceInventory, onPlaceStock)}
                onDragStart={(e) => {
                  if (item.id) {
                    e.dataTransfer.setData('application/x-groundplan-item', item.id);
                  }
                  e.dataTransfer.setData('application/x-groundplan-label', item.name);
                  e.dataTransfer.setData('text/plain', item.name);
                  e.dataTransfer.effectAllowed = 'copy';
                  setDraggingKey(key);
                }}
                onDragEnd={() => setDraggingKey(null)}
              >
                <AssetPreview item={item} />
                <span className="add-item-copy">
                  <span className="fname">{item.name}</span>
                  <span className="add-item-meta">
                    <span>{itemLabel(item)}</span>
                    {size && <span className="num">{size}</span>}
                    {item.leafId && <span>Stock</span>}
                    {!item.tracedIcon && !item.symbolPath && item.id && <span className="is-warning">No outline</span>}
                  </span>
                </span>
                <span className="add-item-action" aria-hidden>
                  {armed ? <IconCheck size={13} /> : 'Place'}
                </span>
              </button>
            </li>
          );
        })}

        {shown.length < filtered.length && (
          <li className="list-more">
            <button type="button" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, filtered.length - shown.length)} more
              <span className="num">
                {shown.length} of {filtered.length}
              </span>
            </button>
          </li>
        )}

        {items.length === 0 && <li className="empty">Nothing to add yet.</li>}
        {items.length > 0 && filtered.length === 0 && (
          <li className="empty">Nothing matches that search or category.</li>
        )}
      </ul>

      <div className="add-panel-footer">
        <button type="button" onClick={onCreateItem}>
          <IconPlus size={13} />
          New custom item
        </button>
        <button type="button" onClick={onManageInventory}>
          <IconEdit size={13} />
          Manage inventory
        </button>
      </div>
    </div>
  );
}

export default AddPanel;
