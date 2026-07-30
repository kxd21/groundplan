import { useEffect, useMemo, useState } from 'react';

import { IconPlus, IconTrash, IconSearch, IconExport, IconFit, IconWarning } from './icons.js';
import type { GearDepartment, GearItem, GearList, GearTotals } from '../../gear/model.js';

const api = window.groundplan;

interface Props {
  lists: GearList[];
  totals: GearTotals[];
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  query: string;
  onApplied: (gear: unknown) => void;
  onError: (message: string) => void;
  notice?: string;
  /** Arms an item for dropping onto the plan. */
  onPlace: (description: string) => void;
  /** False when no plan is open to place onto. */
  canPlace: boolean;
}

/** Case-insensitive filter that keeps a package when any of its pieces match. */
function filterDepartments(departments: GearDepartment[], query: string): GearDepartment[] {
  const q = query.trim().toLowerCase();
  if (!q) return departments;

  const keep = (item: GearItem): GearItem | null => {
    const children = item.children.map(keep).filter((c): c is GearItem => c !== null);
    if (item.description.toLowerCase().includes(q) || children.length) return { ...item, children };
    return null;
  };

  return departments
    .map((d) => ({ ...d, items: d.items.map(keep).filter((i): i is GearItem => i !== null) }))
    .filter((d) => d.items.length > 0);
}

function countPieces(items: GearItem[]): number {
  return items.reduce((sum, i) => sum + (i.note ? 0 : i.quantity) + countPieces(i.children), 0);
}

export function GearView({
  lists,
  totals,
  activeIndex,
  onActiveIndex,
  query,
  onApplied,
  onError,
  notice,
  onPlace,
  canPlace,
}: Props) {
  const [editing, setEditing] = useState<{ id: string; field: 'quantity' | 'description' } | null>(null);
  const [draft, setDraft] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [undoNotice, setUndoNotice] = useState<string | null>(null);

  const list = lists[activeIndex];
  const departments = useMemo(() => filterDepartments(list?.departments ?? [], query), [list, query]);

  if (!list) return null;

  const update = async (itemId: string, patch: Record<string, unknown>) => {
    const reply = await api.gearUpdate(activeIndex, itemId, patch);
    if (reply.ok && reply.gear) {
      onApplied(reply.gear);
      setUndoNotice(null);
    }
    else if (reply.reason) onError(reply.reason);
  };

  const addTo = async (departmentId: string, parentId: string | null) => {
    const reply = await api.gearAdd(activeIndex, departmentId, parentId, 'New item');
    if (reply.ok && reply.gear) {
      onApplied(reply.gear);
      setUndoNotice(null);
      if (reply.createdId) {
        setEditing({ id: reply.createdId, field: 'description' });
        setDraft('New item');
      }
    } else if (reply.reason) onError(reply.reason);
  };

  const commit = async (item: GearItem) => {
    const active = editing;
    setEditing(null);
    if (!active) return;
    if (active.field === 'quantity') {
      const n = Number(draft);
      if (!Number.isInteger(n) || n < 0) {
        onError('Quantity must be a whole number of zero or more.');
        return;
      }
      if (n !== item.quantity) await update(item.id, { quantity: n });
    } else {
      const description = draft.trim();
      if (!description) {
        onError('An item description cannot be empty.');
        return;
      }
      if (description !== item.description) await update(item.id, { description });
    }
  };

  const removeItem = async (item: GearItem) => {
    try {
      const confirmed = await api.confirm({
        title: 'Remove gear item?',
        message: `Remove “${item.description}” from this gear list?`,
        detail: item.children.length
          ? `This also removes ${item.children.length} package item${item.children.length === 1 ? '' : 's'}. You can undo this until your next gear-list edit.`
          : 'You can undo this until your next gear-list edit.',
        confirmLabel: 'Remove',
        danger: true,
      });
      // Fail closed if the confirmation service ever returns a malformed value.
      if (confirmed !== true) return;
      const reply = await api.gearUpdate(activeIndex, item.id, { remove: true });
      if (reply.ok && reply.gear) {
        onApplied(reply.gear);
        setUndoNotice(reply.undoAvailable ? `Removed “${item.description}”` : null);
      } else if (reply.reason) {
        onError(reply.reason);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderItem = (item: GearItem, department: GearDepartment, depth: number) => {
    const isPackage = item.children.length > 0;
    const isCollapsed = collapsed.has(item.id);

    return (
      <div key={item.id}>
        <div
          className={`gear-row${item.note ? ' is-note' : ''}${item.checked ? ' is-checked' : ''}`}
          style={{ paddingLeft: 10 + depth * 18 }}
        >
          {item.note ? (
            <span className="gear-qty" />
          ) : (
            <>
              <input
                type="checkbox"
                className="gear-check"
                checked={!!item.checked}
                onChange={(e) => update(item.id, { checked: e.target.checked })}
                title="Tick off during prep"
                aria-label={`${item.checked ? 'Mark not prepared' : 'Mark prepared'}: ${item.description}`}
              />
              {editing?.id === item.id && editing.field === 'quantity' ? (
                <input
                  className="gear-qty-input num"
                  type="number"
                  min={0}
                  step={1}
                  aria-label={`Quantity for ${item.description}`}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <button
                  className="gear-qty num"
                  onClick={() => {
                    setEditing({ id: item.id, field: 'quantity' });
                    setDraft(String(item.quantity));
                  }}
                  title="Click to change the quantity"
                >
                  {item.quantity}
                </button>
              )}
            </>
          )}

          {isPackage && (
            <button
              className="gear-twisty"
              onClick={() => toggleCollapse(item.id)}
              title={isCollapsed ? 'Expand' : 'Collapse'}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${item.description}`}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          )}

          {editing?.id === item.id && editing.field === 'description' ? (
            <input
              className="gear-desc-input"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(null);
              }}
            />
          ) : (
            <button
              className="gear-desc"
              onClick={() => {
                setEditing({ id: item.id, field: 'description' });
                setDraft(item.description);
              }}
            >
              {item.description}
            </button>
          )}

          {isPackage && <span className="gear-badge num">{item.children.length}</span>}

          <span className="gear-actions">
            {!item.note && (
              <button
                className="icon-btn"
                onClick={() => onPlace(item.description)}
                disabled={!canPlace}
                title={canPlace ? 'Place on the plan' : 'Open a plan first'}
                aria-label={`Place ${item.description} on the plan`}
              >
                <IconFit size={13} />
              </button>
            )}
            {isPackage && (
              <button
                className="icon-btn"
                onClick={() => addTo(department.id, item.id)}
                title="Add a piece to this package"
                aria-label={`Add a piece to ${item.description}`}
              >
                <IconPlus size={13} />
              </button>
            )}
            <button
              className="icon-btn btn-danger"
              onClick={() => void removeItem(item)}
              title={`Remove ${item.description}`}
              aria-label={`Remove ${item.description}`}
            >
              <IconTrash size={13} />
            </button>
          </span>
        </div>

        {isPackage && !isCollapsed && item.children.map((child) => renderItem(child, department, depth + 1))}
      </div>
    );
  };

  return (
    <div className="gear">
      {notice && (
        <div className="recovery-notice" role="status">
          <IconWarning size={14} />
          <span>{notice}</span>
        </div>
      )}
      {undoNotice && (
        <div className="gear-undo" role="status">
          <span>{undoNotice}</span>
          <button
            className="btn-outline"
            onClick={async () => {
              try {
                const reply = await api.gearRestoreLast();
                setUndoNotice(null);
                if (reply.ok && reply.gear) {
                  onApplied(reply.gear);
                } else if (reply.reason) {
                  onError(reply.reason);
                }
              } catch (err) {
                setUndoNotice(null);
                onError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Undo
          </button>
          <button aria-label="Dismiss undo" onClick={() => setUndoNotice(null)}>Dismiss</button>
        </div>
      )}
      {lists.length > 1 && (
        <div className="gear-tabs">
          {lists.map((l, i) => (
            <button key={l.title + i} className={i === activeIndex ? 'active' : ''} onClick={() => onActiveIndex(i)}>
              {l.title.replace(/^\d{8}-\d{2}_/, '')}
              <span className="num">{totals[i]?.pieces ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      <div className="gear-scroll">
        {departments.length === 0 ? (
          <p className="empty" style={{ padding: 24 }}>
            Nothing matches that search.
          </p>
        ) : (
          departments.map((d) => (
            <section className="gear-dept" key={d.id} id={`dept-${d.id}`}>
              <header>
                <h2>{d.name}</h2>
                <span className="num">
                  {d.items.filter((i) => !i.note).length} lines · {countPieces(d.items)} pieces
                </span>
                <button
                  className="icon-btn"
                  onClick={() => addTo(d.id, null)}
                  title={`Add a line to ${d.name}`}
                  aria-label={`Add a line to ${d.name}`}
                >
                  <IconPlus size={13} />
                </button>
              </header>
              {d.items.map((item) => renderItem(item, d, 0))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

interface ReconcileRow {
  name: string;
  status: 'match' | 'missing-on-plan' | 'missing-on-list' | 'count';
  listed: number;
  drawn: number;
}

interface ReconcileReport {
  identity: {
    gear: {
      revision: number;
      jobNumber?: string;
      title: string;
    };
    plan: {
      revision?: number;
      path?: string;
      title?: string;
    };
    comparedAt: string;
  };
  rows: ReconcileRow[];
  matched: number;
  missingOnPlan: number;
  missingOnList: number;
  countMismatch: number;
  ignored: number;
}

type ShowLinkState = Awaited<ReturnType<typeof api.showGet>>;

/** Summary panel for the inspector column. */
export function GearSummary({
  list,
  totals,
  listIndex,
  onError,
  hasPlan,
  planName,
  planRevision,
  planPath,
  gearPath,
  gearDirty,
}: {
  list: GearList;
  totals: GearTotals;
  listIndex: number;
  onError: (message: string) => void;
  hasPlan: boolean;
  planName?: string;
  planRevision?: number;
  planPath?: string;
  gearPath?: string;
  gearDirty: boolean;
}) {
  const progress = totals.allLines ? Math.round((totals.checked / totals.allLines) * 100) : 0;
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [showLink, setShowLink] = useState<ShowLinkState | null>(null);
  const [linking, setLinking] = useState(false);

  // A reconciliation describes one exact list/plan pair. Any gear mutation or
  // plan switch invalidates it so a stale green result is never presented.
  useEffect(() => setReport(null), [list, listIndex, planName, planRevision]);

  useEffect(() => {
    let live = true;
    api
      .showGet()
      .then((state) => {
        if (live) setShowLink(state);
      })
      .catch((err) => {
        if (live) onError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [planPath, gearPath, gearDirty, list, listIndex, onError]);

  const exactList = !!list.id && showLink?.manifest?.gear.listId === list.id;
  const showLinked = !!showLink?.linked && exactList && !gearDirty;
  const linkReason = !hasPlan
    ? 'Open the plan for this Show first.'
    : !gearPath
      ? 'Save this gear list before linking it to a plan.'
      : gearDirty
        ? 'Save the latest gear changes before linking this pair.'
        : showLink?.linked && !exactList
          ? 'This Show is linked to another list in the open gear file.'
          : showLink?.reason ?? 'This plan and gear list are not linked yet.';

  return (
    <>
      <div className="section">
        <div className="section-title">
          <span>{list.jobNumber ? `Job ${list.jobNumber}` : 'Gear list'}</span>
        </div>
        <dl className="facts">
          <div>
            <dt>Show</dt>
            <dd>{list.title.replace(/^\d{8}-\d{2}_/, '')}</dd>
          </div>
          {list.location && (
            <div>
              <dt>Location</dt>
              <dd>{list.location}</dd>
            </div>
          )}
          <div>
            <dt>Departments</dt>
            <dd className="num">{list.departments.length}</dd>
          </div>
          <div>
            <dt>Lines</dt>
            <dd className="num">{totals.lines.toLocaleString()}</dd>
          </div>
          <div>
            <dt>With contents</dt>
            <dd className="num">{totals.allLines.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Pieces</dt>
            <dd className="num">{totals.pieces.toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      <div className="section">
        <div className="section-title">
          <span>Prep</span>
          <span className="num">{progress}%</span>
        </div>
        <div className="meter" role="img" aria-label={`${progress} percent prepped`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="hint">
          {totals.checked.toLocaleString()} of {totals.allLines.toLocaleString()} lines ticked off.
        </p>
      </div>

      <div className="section">
        <div className="section-title">
          <span>Show link</span>
          <span className={`link-state ${showLinked ? 'is-linked' : ''}`}>
            {showLinked ? 'Linked' : 'Not linked'}
          </span>
        </div>
        {showLinked && showLink?.manifest ? (
          <>
            <dl className="facts">
              <div>
                <dt>Show</dt>
                <dd>{showLink.manifest.title}</dd>
              </div>
              {showLink.manifest.jobNumber && (
                <div>
                  <dt>Job</dt>
                  <dd className="num">{showLink.manifest.jobNumber}</dd>
                </div>
              )}
              <div>
                <dt>Status</dt>
                <dd>{showLink.manifest.status}</dd>
              </div>
            </dl>
            <p className="hint">The open plan and this saved gear list are the verified pair for this Show.</p>
          </>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>{linkReason}</p>
            <button
              className="btn-outline"
              style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
              disabled={!hasPlan || !gearPath || gearDirty || linking}
              onClick={async () => {
                setLinking(true);
                try {
                  const reply = await api.showLinkCurrent(listIndex);
                  if (reply.ok && reply.show) setShowLink(reply.show);
                  else if (reply.reason) onError(reply.reason);
                } catch (err) {
                  onError(err instanceof Error ? err.message : String(err));
                } finally {
                  setLinking(false);
                }
              }}
            >
              {linking ? 'Linking…' : 'Link this plan and gear'}
            </button>
          </>
        )}
      </div>

      <div className="section">
        <div className="section-title">
          <span>Check against plan</span>
        </div>
        {!hasPlan ? (
          <p className="hint">Open the plan for this job to compare it with the list.</p>
        ) : (
          <>
            <p className="hint" style={{ margin: '0 0 10px' }}>
              Comparing with <strong>{planName ?? 'the open plan'}</strong>. Confirm it belongs to this show before
              relying on the result.
            </p>
            <button
              className="btn-outline"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={async () => {
                const next = (await api.gearReconcile(listIndex)) as ReconcileReport | null;
                if (next) setReport(next);
                else onError('Nothing to compare yet.');
              }}
            >
              Compare with the open plan
            </button>

            {report && (
              <>
                <div className="recon-identity">
                  <strong>
                    {report.identity.gear.jobNumber
                      ? `Job ${report.identity.gear.jobNumber}`
                      : report.identity.gear.title}
                  </strong>
                  <span aria-hidden="true">→</span>
                  <strong>{report.identity.plan.title ?? planName ?? 'Open plan'}</strong>
                  <span>
                    List r{report.identity.gear.revision} · Plan r{report.identity.plan.revision ?? planRevision ?? '—'} ·{' '}
                    {new Date(report.identity.comparedAt).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
                <ul className="recon-tally">
                  <li className="bad">
                    <span>Drawn, not on the list</span>
                    <span className="num">{report.missingOnList}</span>
                  </li>
                  <li className="warn">
                    <span>Counts differ</span>
                    <span className="num">{report.countMismatch}</span>
                  </li>
                  <li>
                    <span>Listed, not drawn</span>
                    <span className="num">{report.missingOnPlan}</span>
                  </li>
                  <li className="ok">
                    <span>Agree</span>
                    <span className="num">{report.matched}</span>
                  </li>
                </ul>
                <ul className="recon-rows">
                  {report.rows
                    .filter((r) => r.status !== 'match')
                    .slice(0, 12)
                    .map((r) => (
                      <li key={r.name} className={r.status}>
                        <span className="iname">{r.name}</span>
                        <span className="num">
                          {r.listed} / {r.drawn}
                        </span>
                      </li>
                    ))}
                </ul>
                <p className="hint">
                  Listed / drawn. {report.ignored} cable and consumable lines were left out — they never appear
                  on a plan.
                </p>
              </>
            )}
          </>
        )}
      </div>

      <div className="section">
        <div className="section-title">
          <span>Export</span>
        </div>
        <button
          className="btn-outline"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={async () => {
            const saved = await api.gearExportCsv(listIndex);
            if (!saved) return;
            onError('');
          }}
        >
          <IconExport size={14} />
          Export CSV
        </button>
        <p className="hint">One row per line, with its package and prep state.</p>
      </div>
    </>
  );
}

export { IconSearch };
