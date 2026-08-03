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
import { IconSearch } from './icons.js';

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
  onPick: (id: string, name: string) => void;
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
    misc: 'misc',
  };
  const id = map[group];
  if (!id) return INSERT_TREE;
  const found = INSERT_TREE.find((b) => b.id === id);
  return found ? [found] : INSERT_TREE;
}

export default function InsertPicker({ open, items, initialGroup, onClose, onPick }: Props) {
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
    if (!match) return;
    onPick(match.id, match.name);
    onClose();
  };

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Insert"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420, maxWidth: '92vw' }}
      >
        <div className="sheet-title">
          <h2>Insert</h2>
          <button type="button" className="btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          <div className="field inv-search" style={{ position: 'relative' }}>
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
            <div className="actions-row" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="btn-outline"
                disabled={path.length === 0}
                onClick={() => setPath((p) => p.slice(0, -1))}
              >
                Back
              </button>
              <span className="hint" style={{ margin: 0 }}>
                {path.length === 0
                  ? initialGroup
                    ? roots[0]?.label ?? 'Browse'
                    : 'Browse'
                  : path.map((b) => b.label).join(' › ')}
              </span>
            </div>
          )}

          <ul className="file-list">
            {query.trim()
              ? filteredLeaves.map((leaf) => {
                  const match = matchInsertItem(leaf, items);
                  return (
                    <li key={leaf.id}>
                      <button
                        type="button"
                        disabled={!match}
                        onClick={() => chooseLeaf(leaf)}
                        title={match ? match.name : 'No matching inventory item'}
                      >
                        <span className="fname">{leaf.label}</span>
                        <span className="muted">{match ? match.name : 'not in inventory'}</span>
                      </button>
                    </li>
                  );
                })
              : children.map((node) => {
                  if (isInsertLeaf(node)) {
                    const match = matchInsertItem(node, items);
                    return (
                      <li key={node.id}>
                        <button
                          type="button"
                          disabled={!match}
                          onClick={() => chooseLeaf(node)}
                          title={match ? match.name : 'No matching inventory item'}
                        >
                          <span className="fname">{node.label}</span>
                          <span className="muted">{match ? match.name : 'not in inventory'}</span>
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li key={node.id}>
                      <button type="button" onClick={() => setPath((p) => [...p, node])}>
                        <span className="fname">{node.label}</span>
                        <span className="muted">›</span>
                      </button>
                    </li>
                  );
                })}
          </ul>
          {!query.trim() && children.length === 0 && (
            <p className="hint">Nothing in this category yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
