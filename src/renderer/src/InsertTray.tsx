/**
 * Unified Insert surface for the Inspector.
 *
 * Configure something (catalog leaf, seating bank, stage, fill-room), then Place
 * on the plan. The canvas stays visible; this tray does not replace it.
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
import {
  IconChair,
  IconLayers,
  IconPlus,
  IconSearch,
  IconStageDeck,
} from './icons.js';

interface InventoryRow {
  id: string;
  name: string;
  category?: string | null;
}

export type InsertTrayFocus = 'catalog' | 'seating' | 'stage' | 'fill';

interface Props {
  items: InventoryRow[];
  initialGroup?: InsertGroupId | null;
  focus?: InsertTrayFocus;
  armedLabel?: string | null;
  editable: boolean;
  hasRoom: boolean;
  onPick: (id: string, name: string) => void;
  onPickLeaf?: (leafId: string) => void;
  onUnavailable?: (label: string) => void;
  onBuildStage: () => void;
  onSeatingFill: () => void;
  onSeatingStamp: () => void;
  onDonePlacing?: () => void;
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

export default function InsertTray({
  items,
  initialGroup = null,
  focus = 'catalog',
  armedLabel = null,
  editable,
  hasRoom,
  onPick,
  onPickLeaf,
  onUnavailable,
  onBuildStage,
  onSeatingFill,
  onSeatingStamp,
  onDonePlacing,
}: Props) {
  const roots = useMemo(() => groupRoot(initialGroup), [initialGroup]);
  const [path, setPath] = useState<InsertBranch[]>([]);
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<InsertTrayFocus>(focus);

  useEffect(() => {
    setPath([]);
    setQuery('');
    setSection(focus);
  }, [focus, initialGroup]);

  const branch = path.length ? path[path.length - 1]! : null;
  const children = branch ? branch.children : roots;

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
      return;
    }
    if (onPickLeaf && (leaf.stockName || leaf.keywords.length)) {
      onPickLeaf(leaf.id);
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
    <div className="section insert-tray" aria-label="Insert">
      <div className="section-title">
        <span>Insert</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Configure below, then click the plan to place. The sheet stays on screen.
      </p>

      {armedLabel && (
        <div className="insert-tray-armed" role="status">
          <div>
            <strong>Ready to place</strong>
            <small>{armedLabel}</small>
          </div>
          {onDonePlacing && (
            <button type="button" className="link-btn" onClick={onDonePlacing}>
              Done
            </button>
          )}
        </div>
      )}

      <div className="insert-tray-routes" role="tablist" aria-label="What to insert">
        <button
          type="button"
          role="tab"
          aria-selected={section === 'catalog'}
          className={section === 'catalog' ? 'is-on' : ''}
          onClick={() => setSection('catalog')}
        >
          <IconLayers size={14} />
          <span>Objects</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'stage'}
          className={section === 'stage' ? 'is-on' : ''}
          disabled={!editable || !hasRoom}
          onClick={() => setSection('stage')}
        >
          <IconStageDeck size={14} />
          <span>Stage</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'seating' || section === 'fill'}
          className={section === 'seating' || section === 'fill' ? 'is-on' : ''}
          disabled={!editable || !hasRoom}
          onClick={() => setSection('seating')}
        >
          <IconChair size={14} />
          <span>Seating</span>
        </button>
      </div>

      {section === 'catalog' && (
        <>
          <div className="field inv-search insert-search">
            <IconSearch size={14} />
            <input
              type="search"
              placeholder="Search catalog…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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

          <ul className="file-list insert-list insert-tray-list">
            {query.trim()
              ? filteredLeaves.map((leaf) => {
                  const status = leafStatus(leaf, items);
                  const available = status.kind !== 'unavailable';
                  return (
                    <li key={leaf.id}>
                      <button
                        type="button"
                        className={`insert-leaf${available ? '' : ' is-unavailable'}`}
                        disabled={!available || !editable}
                        onClick={() => chooseLeaf(leaf)}
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
                })
              : children.map((node) => {
                  if (isInsertLeaf(node)) {
                    const status = leafStatus(node, items);
                    const available = status.kind !== 'unavailable';
                    return (
                      <li key={node.id}>
                        <button
                          type="button"
                          className={`insert-leaf${available ? '' : ' is-unavailable'}`}
                          disabled={!available || !editable}
                          onClick={() => chooseLeaf(node)}
                        >
                          <span className="insert-leaf-main">
                            <span className="fname">{node.label}</span>
                            <span className="muted">{status.detail}</span>
                          </span>
                          <span className={`insert-badge insert-badge-${status.kind}`}>
                            {status.kind === 'inventory' ? 'In shop' : status.kind === 'stock' ? 'Stock' : 'Missing'}
                          </span>
                        </button>
                      </li>
                    );
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
          {!query.trim() && children.length === 0 && <p className="hint">Nothing in this category yet.</p>}
          {query.trim() && filteredLeaves.length === 0 && (
            <p className="hint">No catalog matches for “{query.trim()}”.</p>
          )}
        </>
      )}

      {section === 'stage' && (
        <div className="insert-tray-action-card">
          <p>Build decks and stairs, then place the finished stage on the plan.</p>
          <button
            type="button"
            className="btn-primary show-setup-wide-action"
            disabled={!editable || !hasRoom}
            onClick={onBuildStage}
          >
            <IconPlus size={14} />
            Configure stage…
          </button>
        </div>
      )}

      {(section === 'seating' || section === 'fill') && (
        <div className="insert-tray-action-card">
          <p>Fill the whole floor from the seating planner, or stamp one bank per click.</p>
          <button
            type="button"
            className="btn-primary show-setup-wide-action"
            disabled={!editable || !hasRoom}
            onClick={onSeatingFill}
          >
            Fill room…
          </button>
          <button
            type="button"
            className="btn-outline show-setup-wide-action"
            disabled={!editable || !hasRoom}
            onClick={onSeatingStamp}
          >
            Stamp a seating bank
          </button>
          <p className="hint">Fill room opens the planner overlay. Stamp arms a bank and leaves this tray open so you can adjust and click again.</p>
        </div>
      )}
    </div>
  );
}
