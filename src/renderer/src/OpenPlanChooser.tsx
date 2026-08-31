/**
 * Chooser opened from the plan-tab +. Lets the user start a new plan, browse
 * the filesystem, or reopen a recent show — without jumping straight to a
 * file picker.
 */

import { useEffect, useMemo, useState } from 'react';

import type { RecentFile } from '../../main/index.js';
import { IconFile, IconFolder, IconPlus, IconSearch } from './icons.js';
import SheetHeader from './SheetHeader.js';

interface Props {
  recent: RecentFile[];
  currentPath?: string | null;
  busy?: boolean;
  onNewPlan: () => void;
  onBrowse: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

function openedLabel(timestamp: number): string {
  if (!timestamp) return 'Previously opened';
  const difference = Date.now() - timestamp;
  if (difference < 60_000) return 'Just now';
  if (difference < 3_600_000) return `${Math.max(1, Math.round(difference / 60_000))} min ago`;
  if (difference < 86_400_000) return `${Math.max(1, Math.round(difference / 3_600_000))} hr ago`;
  if (difference < 604_800_000) return `${Math.max(1, Math.round(difference / 86_400_000))} days ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function OpenPlanChooser({
  recent,
  currentPath,
  busy,
  onNewPlan,
  onBrowse,
  onOpenPath,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return recent;
    return recent.filter((entry) =>
      `${entry.name} ${entry.folder} ${entry.extension}`.toLowerCase().includes(text),
    );
  }, [query, recent]);

  return (
    <div
      className="sheet-backdrop open-plan-chooser-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="sheet open-plan-chooser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-plan-chooser-title"
      >
        <SheetHeader
          eyebrow="Plans"
          title="Open another plan"
          subtitle="Start new, browse, or reopen a recent show"
          titleId="open-plan-chooser-title"
          mark={<IconFolder size={18} />}
          onClose={onClose}
        />

        <div className="sheet-body open-plan-chooser-body">
          <div className="open-plan-chooser-actions" role="group" aria-label="Plan actions">
            <button type="button" className="open-plan-chooser-primary" disabled={busy} onClick={onNewPlan}>
              <IconPlus size={15} />
              <span>
                <strong>New plan</strong>
                <small>Build a room and show from scratch</small>
              </span>
            </button>
            <button type="button" disabled={busy} onClick={onBrowse}>
              <IconFolder size={15} />
              <span>
                <strong>Browse…</strong>
                <small>Choose a plan file on disk</small>
              </span>
            </button>
          </div>

          <div className="open-plan-chooser-recents">
            <div className="open-plan-chooser-recents-head">
              <span>
                <strong>Recent shows</strong>
                {recent.length > 0 && <small className="num">{recent.length}</small>}
              </span>
              <label className="open-plan-chooser-search">
                <IconSearch size={13} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a recent show…"
                  aria-label="Find a recent show"
                  autoFocus
                />
              </label>
            </div>

            <ul className="open-plan-chooser-list" role="listbox" aria-label="Recent shows">
              {matches.map((entry) => {
                const active = currentPath === entry.path;
                return (
                  <li key={entry.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={active ? 'is-current' : undefined}
                      disabled={busy}
                      title={entry.path}
                      onClick={() => onOpenPath(entry.path)}
                    >
                      <IconFile size={14} />
                      <span className="open-plan-chooser-copy">
                        <strong>{entry.name.replace(/\.[^.]+$/, '')}</strong>
                        <small>
                          {entry.folder} · {openedLabel(entry.openedAt)}
                        </small>
                      </span>
                      <span className="open-plan-chooser-ext">{entry.extension}</span>
                    </button>
                  </li>
                );
              })}
              {matches.length === 0 && (
                <li className="empty">
                  {query.trim()
                    ? 'No recent shows match that search.'
                    : 'No recent shows yet. Browse for a plan or start a new one.'}
                </li>
              )}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
