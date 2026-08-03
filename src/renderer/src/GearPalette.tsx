import { useMemo, useState } from 'react';

import type { GearDepartment, GearItem, GearList } from '../../gear/model.js';
import { IconEdit, IconSearch } from './icons.js';

interface Props {
  lists: GearList[];
  activeIndex: number;
  query: string;
  onQuery: (next: string) => void;
  canPlace: boolean;
  armedDescription: string | null;
  onPlace: (description: string) => void;
  onManage: () => void;
}

interface PaletteItem {
  id: string;
  description: string;
  quantity: number;
  depth: number;
  packageSize: number;
}

function flattenItems(items: GearItem[], depth = 0): PaletteItem[] {
  return items.flatMap((item) => [
    ...(item.note
      ? []
      : [{
          id: item.id,
          description: item.description,
          quantity: item.quantity,
          depth,
          packageSize: item.children.length,
        }]),
    ...flattenItems(item.children, depth + 1),
  ]);
}

function matchingDepartments(list: GearList | undefined, query: string) {
  const needle = query.trim().toLowerCase();
  return (list?.departments ?? []).flatMap((department: GearDepartment) => {
    const items = flattenItems(department.items).filter(
      (item) => !needle || item.description.toLowerCase().includes(needle) || department.name.toLowerCase().includes(needle),
    );
    return items.length ? [{ department, items }] : [];
  });
}

/**
 * A plan-side view of a gear list.
 *
 * The full Gear workspace is for editing the list. This palette is deliberately
 * narrower: drag once to an exact point, or click once and stamp a run of the
 * same item. Keeping the plan visible is what makes either gesture understandable.
 */
export function GearPalette({
  lists,
  activeIndex,
  query,
  onQuery,
  canPlace,
  armedDescription,
  onPlace,
  onManage,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const list = lists[activeIndex];
  const departments = useMemo(() => matchingDepartments(list, query), [list, query]);
  const itemCount = departments.reduce((sum, department) => sum + department.items.length, 0);

  return (
    <div className="gear-palette">
      <div className="palette-panel-heading">
        <span>
          <strong>Gear list</strong>
          <small>{list?.title.replace(/^\d{8}-\d{2}_/, '') ?? 'No list open'}</small>
        </span>
        <button type="button" className="icon-btn" onClick={onManage} title="Open the full gear-list editor">
          <IconEdit size={13} />
        </button>
      </div>

      <div className="search equipment-search">
        <IconSearch size={13} />
        <input
          aria-label="Search gear to place"
          placeholder="Search this gear list…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {itemCount > 0 && <span className="search-count num">{itemCount}</span>}
      </div>

      <div className="gear-palette-scroll">
        {departments.map(({ department, items }) => (
          <section className="gear-palette-department" key={department.id}>
            <div className="gear-palette-department-title">
              <span>{department.name}</span>
              <span className="num">{items.length}</span>
            </div>
            <ul>
              {items.map((item) => {
                const active = armedDescription === item.description;
                return (
                  <li key={item.id} className={draggingId === item.id ? 'is-dragging' : ''}>
                    <button
                      type="button"
                      className={`gear-palette-item${active ? ' is-armed' : ''}`}
                      style={{ paddingLeft: 10 + item.depth * 12 }}
                      draggable={canPlace}
                      disabled={!canPlace}
                      aria-pressed={active}
                      title={
                        canPlace
                          ? `Drag ${item.description} onto the plan, or click for repeat placement`
                          : 'Open an editable plan to place gear'
                      }
                      onClick={() => onPlace(item.description)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('application/x-groundplan-gear', item.description);
                        event.dataTransfer.setData('application/x-groundplan-label', item.description);
                        event.dataTransfer.setData('text/plain', item.description);
                        event.dataTransfer.effectAllowed = 'copy';
                        setDraggingId(item.id);
                      }}
                      onDragEnd={() => setDraggingId(null)}
                    >
                      <span className="palette-drag-handle" aria-hidden>⠿</span>
                      <span className="gear-palette-copy">
                        <span>{item.description}</span>
                        {item.packageSize > 0 && <small>{item.packageSize} package lines</small>}
                      </span>
                      <span className="gear-palette-qty num">×{item.quantity}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {!list && <p className="empty">Open a gear list to drag its items onto this plan.</p>}
        {list && departments.length === 0 && (
          <p className="empty">{query.trim() ? 'Nothing matches that search.' : 'This gear list has no placeable lines.'}</p>
        )}
      </div>
    </div>
  );
}
