/**
 * Classic left icon strip: Tables, Chairs, Staging, Screens, …
 * Click arms the first matching inventory item for stamp placement.
 */

import { PALETTE_CATEGORIES, type InsertGroupId } from '../../inventory/insert-catalog.js';

interface InventoryRow {
  id: string;
  name: string;
  category?: string | null;
}

interface Props {
  items: InventoryRow[];
  armedId: string | null;
  disabled?: boolean;
  onArm: (id: string, name: string) => void;
  onBrowse: (group: InsertGroupId) => void;
}

function pickForGroup(group: InsertGroupId, items: InventoryRow[]): InventoryRow | null {
  const cat = PALETTE_CATEGORIES.find((c) => c.id === group);
  if (!cat || !items.length) return null;
  const byCategory = items.find((item) => item.category && cat.categories.includes(item.category));
  if (byCategory) return byCategory;
  const lowered = cat.keywords.map((k) => k.toLowerCase());
  return (
    items.find((item) => {
      const name = item.name.toLowerCase();
      return lowered.some((k) => name.includes(k));
    }) ?? null
  );
}

export default function ObjectPalette({ items, armedId, disabled, onArm, onBrowse }: Props) {
  return (
    <nav className="object-palette" aria-label="Insert objects">
      {PALETTE_CATEGORIES.map((cat) => {
        const match = pickForGroup(cat.id, items);
        const active = match != null && match.id === armedId;
        return (
          <button
            key={cat.id}
            type="button"
            className={active ? 'active' : ''}
            disabled={disabled || !match}
            title={
              match
                ? `${cat.label}: ${match.name} (click to stamp, Shift+click to browse)`
                : `${cat.label}: nothing in inventory yet`
            }
            onClick={(e) => {
              if (e.shiftKey) {
                onBrowse(cat.id);
                return;
              }
              if (match) onArm(match.id, match.name);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onBrowse(cat.id);
            }}
          >
            <span aria-hidden>{cat.short}</span>
          </button>
        );
      })}
    </nav>
  );
}
