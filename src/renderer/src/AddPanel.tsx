/**
 * Unified Add surface for Place mode.
 *
 * One searchable, category-bucketed list of inventory (and name-only gear)
 * rows, filtered to the active plan view so elevation drawings never stamp
 * into a top-down plan.
 */

import { useEffect, useMemo, useState } from 'react';

import { classify, type ItemView } from '../../inventory/classify.js';
import {
  ADD_CATEGORY_OPTIONS,
  addBucket,
  type AddCategoryId,
} from './add-categories.js';
import { IconSearch } from './icons.js';

export type PlanViewMode = 'top' | 'front' | 'side';

export interface AddPanelItem {
  id?: string;
  name: string;
  category?: string | null;
  view?: string | null;
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
  onPlaceGear: (name: string) => void;
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
  onPlaceGear: Props['onPlaceGear'],
) {
  if (item.id) onPlaceInventory(item.id, item.name);
  else onPlaceGear(item.name);
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
  onPlaceGear,
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
      return item.name.toLowerCase().includes(needle);
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

  return (
    <div className="add-panel">
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
                onClick={() => editable && placeItem(item, onPlaceInventory, onPlaceGear)}
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
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="file-list palette">
        {shown.map((item) => {
          const key = item.id ?? item.name;
          return (
            <li key={key} className={`palette-row${draggingKey === key ? ' is-dragging' : ''}`}>
              <button
                type="button"
                className="palette-place"
                draggable={editable}
                disabled={!editable}
                title={
                  editable
                    ? `Drag ${item.name} onto the plan, or click to place it`
                    : 'Open an editable plan to place items'
                }
                onClick={() => editable && placeItem(item, onPlaceInventory, onPlaceGear)}
                onDragStart={(e) => {
                  if (item.id) {
                    e.dataTransfer.setData('application/x-groundplan-item', item.id);
                  } else {
                    e.dataTransfer.setData('application/x-groundplan-gear', item.name);
                  }
                  e.dataTransfer.setData('application/x-groundplan-label', item.name);
                  e.dataTransfer.setData('text/plain', item.name);
                  e.dataTransfer.effectAllowed = 'copy';
                  setDraggingKey(key);
                }}
                onDragEnd={() => setDraggingKey(null)}
              >
                <span className="fname">{item.name}</span>
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
    </div>
  );
}

export default AddPanel;
