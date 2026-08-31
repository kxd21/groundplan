/**
 * In-app hierarchical Insert picker (mirrors the Electron Insert menu).
 */

import { useEffect, useMemo, useState } from 'react';

import {
  INSERT_TREE,
  isInsertLeaf,
  matchInsertItem,
  type InsertBranch,
  type InsertLeaf,
  type InsertGroupId,
} from '../../inventory/insert-catalog.js';
import { IconPlus, IconSearch } from './icons.js';
import SheetHeader from './SheetHeader.js';

interface InventoryRow {
  id: string;
  name: string;
  category?: string | null;
}

interface Props {
  open: boolean;
  items: InventoryRow[];
  initialGroup?: InsertGroupId | null;
  onClose: () => void;
  /** Inventory match — preferred when the shop has this item. */
  onPick: (id: string, name: string) => void;
  /** Catalog leaf when there is no inventory match (stock-size fallback). */
  onPickLeaf?: (leafId: string) => void;
  /** Called when a leaf cannot be armed (no inventory match and no stock). */
  onUnavailable?: (label: string) => void;
}

function groupRoot(group: InsertGroupId | null | undefined): InsertBranch[] {
  if (!group) return INSERT_TREE;
  const map: Partial<Record<InsertGroupId, string>> = {
    screens: 'screens',
    projectors: 'projectors',
    av: 'av-more',
    staging: 'risers',
    tables: 'tables',
    chairs: 'chairs',
    drape: 'drape',
    misc: 'venue',
  };
  const id = map[group];
  if (!id) return INSERT_TREE;
  const found = INSERT_TREE.find((b) => b.id === id);
  return found ? [found] : INSERT_TREE;
}

function leafStatus(leaf: InsertLeaf, items: InventoryRow[]): {
  kind: 'inventory' | 'stock' | 'unavailable';
  detail: string;
} {
  const match = matchInsertItem(leaf, items);
  if (match) return { kind: 'inventory', detail: match.name };
  if (leaf.stockName) return { kind: 'stock', detail: leaf.stockName };
  if (leaf.keywords.length) return { kind: 'stock', detail: 'stock size' };
  return { kind: 'unavailable', detail: 'unavailable' };
}

function LeafRow({
  leaf,
  items,
  onChoose,
}: {
  leaf: InsertLeaf;
  items: InventoryRow[];
  onChoose: (leaf: InsertLeaf) => void;
}) {
  const status = leafStatus(leaf, items);
  const available = status.kind !== 'unavailable';
  const match = matchInsertItem(leaf, items);
  return (
    <li>
      <button
        type="button"
        className={`insert-leaf${available ? '' : ' is-unavailable'}`}
        disabled={!available}
        onClick={() => onChoose(leaf)}
        title={
          match
            ? match.name
            : leaf.stockName
              ? `Place stock ${leaf.stockName}`
              : available
                ? 'Arm stock size from keywords'
                : 'Not in inventory and no stock size. Add it in Inventory first'
        }
      >
        <span className="insert-leaf-main">
          <span className="fname">{leaf.label}</span>
          <span className="muted">{status.detail}</span>
        </span>
        <span className={`insert-badge insert-badge-${status.kind}`}>
          {status.kind === 'inventory' ? 'In shop' : status.kind === 'stock' ? 'Stock' : 'Missing'}
        </span>
      </button>
    </li>
  );
}

export default function InsertPicker({
  open,
  items,
  initialGroup,
  onClose,
  onPick,
  onPickLeaf,
  onUnavailable,
}: Props) {
  const roots = useMemo(() => groupRoot(initialGroup), [initialGroup]);
  const [path, setPath] = useState<InsertBranch[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setPath([]);
    setQuery('');
  }, [open, initialGroup]);

  const branch = path.length ? path[path.length - 1]! : null;
  const children = branch ? branch.children : roots;

  if (!open) return null;

  const filteredLeaves = ((): InsertLeaf[] => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    const out: InsertLeaf[] = [];
    const walk = (nodes: Array<InsertBranch | InsertLeaf>) => {
      for (const node of nodes) {
        if (isInsertLeaf(node)) {
          if (node.label.toLowerCase().includes(q) || node.keywords.some((k) => k.toLowerCase().includes(q))) {
            out.push(node);
          }
        } else walk(node.children);
      }
    };
    walk(INSERT_TREE);
    return out;
  })();

  const chooseLeaf = (leaf: InsertLeaf) => {
    const match = matchInsertItem(leaf, items);
    if (match) {
      onPick(match.id, match.name);
      onClose();
      return;
    }
    if (onPickLeaf && (leaf.stockName || leaf.keywords.length)) {
      onPickLeaf(leaf.id);
      onClose();
      return;
    }
    onUnavailable?.(leaf.label);
  };

  const crumb =
    path.length === 0
      ? initialGroup
        ? roots[0]?.label ?? 'Browse'
        : 'All categories'
      : path.map((b) => b.label).join(' › ');

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sheet insert-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Insert"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHeader
          eyebrow="Catalog"
          title="Insert"
          subtitle="Browse equipment · prefer inventory when it matches"
          mark={<IconPlus size={18} />}
          onClose={onClose}
        />
        <div className="sheet-body">
          <div className="field inv-search insert-search">
            <IconSearch size={14} />
            <input
              type="search"
              placeholder="Search catalog…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>

          {!query.trim() && (
            <div className="insert-crumb">
              <button
                type="button"
                className="btn-outline"
                disabled={path.length === 0}
                onClick={() => setPath((p) => p.slice(0, -1))}
              >
                Back
              </button>
              <span className="insert-crumb-path" title={crumb}>
                {crumb}
              </span>
            </div>
          )}

          <ul className="file-list insert-list">
            {query.trim()
              ? filteredLeaves.map((leaf) => (
                  <LeafRow key={leaf.id} leaf={leaf} items={items} onChoose={chooseLeaf} />
                ))
              : children.map((node) => {
                  if (isInsertLeaf(node)) {
                    return <LeafRow key={node.id} leaf={node} items={items} onChoose={chooseLeaf} />;
                  }
                  return (
                    <li key={node.id}>
                      <button type="button" className="insert-folder" onClick={() => setPath((p) => [...p, node])}>
                        <span className="fname">{node.label}</span>
                        <span className="insert-folder-chevron" aria-hidden>
                          ›
                        </span>
                      </button>
                    </li>
                  );
                })}
          </ul>
          {!query.trim() && children.length === 0 && (
            <p className="hint">Nothing in this category yet.</p>
          )}
          {query.trim() && filteredLeaves.length === 0 && (
            <p className="hint">No catalog matches for “{query.trim()}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}
