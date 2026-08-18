import { useEffect, useMemo, useState } from 'react';

import type { PlanFolderState } from '../../main/index.js';
import { IconFile, IconFolder, IconPlus, IconSearch, IconStar, IconTrash } from './icons.js';

const api = window.groundplan;
type Folder = PlanFolderState['folders'][number];
type Plan = PlanFolderState['plans'][number];
type Scope = 'folder' | 'all' | 'starred' | 'missing';
type Status = Plan['status'];

const COLOURS = ['#1687f8', '#7357d8', '#d44b7c', '#e47b24', '#d2a414', '#28a66a', '#687789'];
const STATUS_LABELS: Record<Status, string> = {
  active: 'Active',
  review: 'In review',
  approved: 'Approved',
  archived: 'Archived',
};

interface Props {
  state: PlanFolderState;
  initialFolderId: string | null;
  currentPath?: string;
  onState: (state: PlanFolderState) => void;
  onOpenPlan: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

function keyFor(plan: Pick<Plan, 'folderId' | 'path'>): string {
  return `${plan.folderId}\0${plan.path}`;
}

function folderTrail(folders: Folder[], folder: Folder): string {
  const names = [folder.name];
  let parentId = folder.parentId;
  while (parentId) {
    const parent = folders.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(' / ');
}

function descendants(folders: Folder[], id: string): Set<string> {
  const found = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if ((folder.parentId === id || (folder.parentId && found.has(folder.parentId))) && !found.has(folder.id)) {
        found.add(folder.id);
        changed = true;
      }
    }
  }
  return found;
}

/** Full-width organizer for nested folders, batch filing, and plan workflow metadata. */
export default function PlanFolderWorkspace({
  state,
  initialFolderId,
  currentPath,
  onState,
  onOpenPlan,
  onClose,
  onError,
  onStatus,
}: Props) {
  const [scope, setScope] = useState<Scope>(initialFolderId ? 'folder' : 'all');
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'modified' | 'added' | 'status'>('name');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetFolderId, setTargetFolderId] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('');
  const [moveFolderTarget, setMoveFolderTarget] = useState('');
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);

  const selectedFolder = state.folders.find((folder) => folder.id === folderId) ?? null;
  useEffect(() => {
    setFolderName(selectedFolder?.name ?? '');
    setDescription(selectedFolder?.description ?? '');
    setColor(selectedFolder?.color ?? '');
    setMoveFolderTarget(selectedFolder?.parentId ?? '');
  }, [selectedFolder?.id, selectedFolder?.description, selectedFolder?.color, selectedFolder?.parentId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const folderRows = useMemo(() => {
    const rows: Array<{ folder: Folder; depth: number; trail: string }> = [];
    const visit = (parentId: string | null, depth: number) => {
      state.folders
        .filter((folder) => folder.parentId === parentId)
        .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name, undefined, { numeric: true }))
        .forEach((folder) => {
          rows.push({ folder, depth, trail: folderTrail(state.folders, folder) });
          visit(folder.id, depth + 1);
        });
    };
    visit(null, 0);
    return rows;
  }, [state.folders]);

  const displayedPlans = useMemo(() => {
    const text = query.trim().toLowerCase();
    let plans = state.plans.filter((plan) => {
      if (scope === 'folder') return !!folderId && plan.folderId === folderId;
      if (scope === 'starred') return plan.starred;
      if (scope === 'missing') return plan.missing;
      return true;
    });
    if (text) {
      plans = plans.filter((plan) => {
        const folder = state.folders.find((candidate) => candidate.id === plan.folderId);
        return `${plan.name} ${plan.sourceFolder} ${folder?.name ?? ''} ${plan.note ?? ''} ${STATUS_LABELS[plan.status]}`
          .toLowerCase()
          .includes(text);
      });
    }
    return [...plans].sort((a, b) => {
      if (sort === 'modified') return b.modified - a.modified;
      if (sort === 'added') return Date.parse(b.addedAt) - Date.parse(a.addedAt);
      if (sort === 'status') return a.status.localeCompare(b.status) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }, [folderId, query, scope, sort, state.folders, state.plans]);

  const selectedPlans = useMemo(
    () => state.plans.filter((plan) => selected.has(keyFor(plan))),
    [selected, state.plans],
  );
  const oneSelected = selectedPlans.length === 1 ? selectedPlans[0] : null;
  useEffect(() => setNote(oneSelected?.note ?? ''), [oneSelected?.folderId, oneSelected?.path, oneSelected?.note]);

  const run = async (
    operation: () => Promise<{ ok: boolean; reason?: string; state?: PlanFolderState }>,
    success: string,
  ): Promise<boolean> => {
    setWorking(true);
    try {
      const reply = await operation();
      if (!reply.ok) {
        onError(reply.reason ?? 'That folder operation could not be completed.');
        return false;
      }
      if (reply.state) onState(reply.state);
      onStatus(success);
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setWorking(false);
    }
  };

  const chooseFolder = (id: string) => {
    setFolderId(id);
    setScope('folder');
    setSelected(new Set());
  };

  const createFolder = () => {
    if (!newFolderName.trim()) return;
    const parentId = scope === 'folder' ? folderId : null;
    void run(
      () => api.planFolderCreate(newFolderName, parentId),
      parentId ? 'Subfolder created' : 'Folder created',
    ).then((created) => { if (created) setNewFolderName(''); });
  };

  const saveFolderDetails = () => {
    if (!selectedFolder) return;
    void run(
      () => api.planFolderUpdate(selectedFolder.id, { name: folderName, description, color }),
      'Folder details saved',
    );
  };

  const deleteFolder = async () => {
    if (!selectedFolder) return;
    const accepted = await api.confirm({
      title: 'Remove plan folder?',
      message: `Remove “${selectedFolder.name}” and its subfolders?`,
      detail: 'Only the virtual organization and folder notes are removed. Original plan files are never deleted or moved.',
      confirmLabel: 'Remove Folder',
      danger: true,
    });
    if (!accepted) return;
    const parentId = selectedFolder.parentId;
    const removed = await run(() => api.planFolderRemove(selectedFolder.id), 'Folder removed: original plans were left untouched');
    if (!removed) return;
    setFolderId(parentId);
    setScope(parentId ? 'folder' : 'all');
    setSelected(new Set());
  };

  const moveFolder = () => {
    if (!selectedFolder) return;
    void run(
      () => api.planFolderMove(selectedFolder.id, moveFolderTarget || null),
      'Folder moved',
    );
  };

  const updatePlan = (plan: Plan, patch: { status?: Status; starred?: boolean; note?: string }) => {
    void run(() => api.planFolderUpdatePlan(plan.folderId, plan.path, patch), 'Plan workflow updated');
  };

  const transferSelected = async (mode: 'copy' | 'move') => {
    if (!targetFolderId || !selectedPlans.length) return;
    setWorking(true);
    try {
      const bySource = new Map<string, string[]>();
      for (const plan of selectedPlans) bySource.set(plan.folderId, [...(bySource.get(plan.folderId) ?? []), plan.path]);
      let nextState: PlanFolderState | undefined;
      for (const [source, paths] of bySource) {
        const reply = await api.planFolderTransferPlans(source, targetFolderId, paths, mode);
        if (!reply.ok) throw new Error(reply.reason ?? 'The plans could not be filed.');
        nextState = reply.state;
      }
      if (nextState) onState(nextState);
      setSelected(new Set());
      onStatus(`${mode === 'move' ? 'Moved' : 'Copied'} ${selectedPlans.length} plan${selectedPlans.length === 1 ? '' : 's'}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const setSelectedStatus = async (status: Status) => {
    if (!selectedPlans.length) return;
    setWorking(true);
    try {
      let nextState: PlanFolderState | undefined;
      for (const plan of selectedPlans) {
        const reply = await api.planFolderUpdatePlan(plan.folderId, plan.path, { status });
        if (!reply.ok) throw new Error(reply.reason ?? 'The workflow status could not be updated.');
        nextState = reply.state;
      }
      if (nextState) onState(nextState);
      onStatus(`Updated ${selectedPlans.length} plan${selectedPlans.length === 1 ? '' : 's'}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const forbiddenMoveTargets = selectedFolder ? descendants(state.folders, selectedFolder.id) : new Set<string>();
  if (selectedFolder) forbiddenMoveTargets.add(selectedFolder.id);

  return (
    <div className="sheet-backdrop folder-workspace-backdrop" role="presentation" onClick={onClose}>
      <section className="sheet folder-workspace" role="dialog" aria-modal="true" aria-labelledby="folder-workspace-title" onClick={(event) => event.stopPropagation()}>
        <header className="folder-workspace-header">
          <span><small>Virtual filing: plans stay on disk where they are</small><strong id="folder-workspace-title">Folder Workspace</strong></span>
          <div className="folder-workspace-search"><IconSearch size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plans, folders, notes, or status…" /></div>
          <button type="button" onClick={onClose} aria-label="Close Folder Workspace">×</button>
        </header>

        <div className="folder-workspace-body">
          <aside className="folder-workspace-tree">
            <nav className="folder-smart-views" aria-label="Plan folder views">
              {([
                ['all', 'All filed plans', state.plans.length],
                ['starred', 'Starred', state.plans.filter((plan) => plan.starred).length],
                ['missing', 'Missing files', state.plans.filter((plan) => plan.missing).length],
              ] as const).map(([id, label, count]) => (
                <button key={id} className={scope === id ? 'active' : ''} onClick={() => { setScope(id); setSelected(new Set()); }}><span>{label}</span><small>{count}</small></button>
              ))}
            </nav>
            <div className="folder-tree-heading"><strong>Folders</strong><small>{state.folders.length}</small></div>
            <div className="folder-tree-list">
              {folderRows.map(({ folder, depth, trail }) => (
                <button key={folder.id} className={scope === 'folder' && folderId === folder.id ? 'active' : ''} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => chooseFolder(folder.id)} title={trail}>
                  <span className="folder-colour" style={{ background: folder.color ?? '#8793a0' }} />
                  <IconFolder size={14} />
                  <span>{folder.name}</span>
                  {folder.favorite && <small title="Favorite"><IconStar size={12} filled /></small>}
                </button>
              ))}
              {!folderRows.length && <p>No folders yet.</p>}
            </div>
            <div className="folder-create-inline">
              <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder={scope === 'folder' && folderId ? 'New subfolder…' : 'New folder…'} onKeyDown={(event) => { if (event.key === 'Enter') createFolder(); }} />
              <button type="button" onClick={createFolder} disabled={!newFolderName.trim() || working} aria-label="Create folder"><IconPlus size={14} /></button>
            </div>
          </aside>

          <main className="folder-workspace-plans">
            <header>
              <span><strong>{scope === 'folder' ? selectedFolder?.name ?? 'Choose a folder' : scope === 'all' ? 'All filed plans' : scope === 'starred' ? 'Starred plans' : 'Missing files'}</strong><small>{displayedPlans.length} result{displayedPlans.length === 1 ? '' : 's'}</small></span>
              <label>Sort <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="name">Name</option><option value="modified">Modified</option><option value="added">Date added</option><option value="status">Status</option></select></label>
            </header>
            <div className="folder-plan-select-all">
              <label><input type="checkbox" checked={!!displayedPlans.length && displayedPlans.every((plan) => selected.has(keyFor(plan)))} onChange={(event) => setSelected(event.target.checked ? new Set(displayedPlans.map(keyFor)) : new Set())} /> Select visible</label>
              <span>{selectedPlans.length ? `${selectedPlans.length} selected` : 'Select plans for batch actions'}</span>
            </div>
            <div className="folder-workspace-plan-list">
              {displayedPlans.map((plan) => {
                const folder = state.folders.find((candidate) => candidate.id === plan.folderId);
                return (
                  <article className={`${selected.has(keyFor(plan)) ? 'is-selected' : ''}${plan.missing ? ' is-missing' : ''}${currentPath === plan.path ? ' is-open' : ''}`} key={keyFor(plan)}>
                    <input type="checkbox" checked={selected.has(keyFor(plan))} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(keyFor(plan)); else next.delete(keyFor(plan)); return next; })} aria-label={`Select ${plan.name}`} />
                    <button className="folder-plan-open" onClick={() => onOpenPlan(plan.path)} disabled={plan.missing || working} title={plan.path}><IconFile size={15} /><span><strong>{plan.name.replace(/\.[^.]+$/, '')}</strong><small>{folder ? folderTrail(state.folders, folder) : plan.sourceFolder} · {plan.extension}{plan.note ? ` · ${plan.note}` : ''}</small></span></button>
                    <select className={`folder-plan-status is-${plan.status}`} value={plan.status} onChange={(event) => updatePlan(plan, { status: event.target.value as Status })} disabled={working} aria-label={`Workflow status for ${plan.name}`}>{(Object.keys(STATUS_LABELS) as Status[]).map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select>
                    <button className={`folder-plan-star${plan.starred ? ' is-on' : ''}`} onClick={() => updatePlan(plan, { starred: !plan.starred })} title={plan.starred ? 'Unstar plan' : 'Star plan'} aria-label={plan.starred ? `Unstar ${plan.name}` : `Star ${plan.name}`}><IconStar size={13} filled={plan.starred} /></button>
                  </article>
                );
              })}
              {!displayedPlans.length && <div className="folder-workspace-empty">No plans match this view.</div>}
            </div>
          </main>

          <aside className="folder-workspace-details">
            {selectedPlans.length ? (
              <>
                <div className="folder-details-heading"><small>Batch workflow</small><strong>{selectedPlans.length} selected</strong></div>
                <label className="folder-detail-field"><span>Set status</span><select defaultValue="" onChange={(event) => { if (event.target.value) void setSelectedStatus(event.target.value as Status); event.target.value = ''; }} disabled={working}><option value="">Choose status…</option>{(Object.keys(STATUS_LABELS) as Status[]).map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
                <label className="folder-detail-field"><span>Destination</span><select value={targetFolderId} onChange={(event) => setTargetFolderId(event.target.value)}><option value="">Choose folder…</option>{folderRows.map(({ folder, trail }) => <option key={folder.id} value={folder.id}>{trail}</option>)}</select></label>
                <div className="folder-batch-actions"><button onClick={() => void transferSelected('copy')} disabled={!targetFolderId || working}>Copy to folder</button><button onClick={() => void transferSelected('move')} disabled={!targetFolderId || working}>Move to folder</button></div>
                {oneSelected && <label className="folder-detail-field"><span>Plan note</span><textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Review notes, client feedback, next step…" /><button type="button" onClick={() => updatePlan(oneSelected, { note })} disabled={working}>Save note</button></label>}
              </>
            ) : selectedFolder ? (
              <>
                <div className="folder-details-heading"><small>Folder details</small><strong>{selectedFolder.name}</strong></div>
                <label className="folder-detail-field"><span>Folder name</span><input value={folderName} maxLength={80} onChange={(event) => setFolderName(event.target.value)} /></label>
                <label className="folder-detail-field"><span>Description</span><textarea value={description} maxLength={240} onChange={(event) => setDescription(event.target.value)} placeholder="Client, venue, production phase, or filing rules…" /></label>
                <div className="folder-colour-picker"><span>Colour</span><div><button className={!color ? 'active clear' : 'clear'} onClick={() => setColor('')} aria-label="No folder colour">×</button>{COLOURS.map((value) => <button key={value} className={color === value ? 'active' : ''} style={{ background: value }} onClick={() => setColor(value)} aria-label={`Use ${value}`} />)}</div></div>
                <button className="folder-detail-primary" onClick={saveFolderDetails} disabled={working || !folderName.trim()}>Save folder details</button>
                <button className="folder-favorite-toggle" onClick={() => void run(() => api.planFolderUpdate(selectedFolder.id, { favorite: !selectedFolder.favorite }), selectedFolder.favorite ? 'Removed from favorites' : 'Folder favorited')} disabled={working}><IconStar size={13} filled={selectedFolder.favorite} />{selectedFolder.favorite ? 'Favorite folder' : 'Add to favorites'}</button>
                <label className="folder-detail-field"><span>Move folder under</span><select value={moveFolderTarget} onChange={(event) => setMoveFolderTarget(event.target.value)}><option value="">Top level</option>{folderRows.filter(({ folder }) => !forbiddenMoveTargets.has(folder.id)).map(({ folder, trail }) => <option key={folder.id} value={folder.id}>{trail}</option>)}</select><button type="button" onClick={moveFolder} disabled={working || moveFolderTarget === (selectedFolder.parentId ?? '')}>Move folder</button></label>
                <button className="folder-cleanup" onClick={() => void run(() => api.planFolderCleanupMissing(selectedFolder.id), 'Missing links cleaned up')} disabled={working || !state.plans.some((plan) => plan.folderId === selectedFolder.id && plan.missing)}><IconTrash size={13} /> Remove missing links</button>
                <button className="folder-delete" onClick={() => void deleteFolder()} disabled={working}><IconTrash size={13} /> Remove folder</button>
              </>
            ) : (
              <div className="folder-workspace-guidance">
                <IconFolder size={28} />
                <strong>{scope === 'missing' ? 'Missing file links' : 'Choose a folder'}</strong>
                <p>
                  {scope === 'missing'
                    ? 'These entries point at plans that moved or were renamed on disk. Removing a link only clears the membership. It never deletes a file.'
                    : 'Folders are Groundplan memberships, not disk directories. Edit details here, or select plans for batch filing. Original .rv4 files stay where they are.'}
                </p>
                {scope === 'missing' && (
                  <button
                    className="folder-cleanup"
                    type="button"
                    onClick={() => void run(() => api.planFolderCleanupMissing(null), 'Missing links cleaned up')}
                    disabled={working || !state.plans.some((plan) => plan.missing)}
                  >
                    <IconTrash size={13} /> Remove all missing links
                  </button>
                )}
              </div>
            )}
          </aside>
        </div>

        <footer className="folder-workspace-footer"><span>Virtual folders never move or delete the original plan files.</span><button className="btn-primary" onClick={onClose}>Done</button></footer>
      </section>
    </div>
  );
}
