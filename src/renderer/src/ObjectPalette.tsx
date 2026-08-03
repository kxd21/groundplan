/**
 * Classic left icon strip: Tables, Chairs, Staging, Screens, …
 * Click arms the first matching inventory item for stamp placement.
 * Empty categories still open the Insert browser.
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
            className={`${active ? 'active' : ''}${!match ? ' is-browse-only' : ''}`}
            disabled={disabled}
            aria-label={
              match
                ? `${cat.label}: ${match.name}. Click to stamp, Shift+click to browse.`
                : `${cat.label}: browse catalog`
            }
            title={
              match
                ? `${cat.label}: ${match.name}\nClick to stamp · Shift+click or right-click to browse`
                : `${cat.label}: nothing matched in inventory — click to browse Insert`
            }
            onClick={(e) => {
              if (e.shiftKey || !match) {
                onBrowse(cat.id);
                return;
              }
              onArm(match.id, match.name);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onBrowse(cat.id);
            }}
          >
            <span className="palette-short" aria-hidden>
              {cat.short}
            </span>
            <span className="palette-label" aria-hidden>
              {cat.label.split(' ')[0]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
