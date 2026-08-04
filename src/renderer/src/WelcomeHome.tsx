import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { PlanFolderState, RecentFile } from '../../main/index.js';
import {
  IconChair,
  IconCopy,
  IconDrawPolygon,
  IconEdit,
  IconFile,
  IconFolder,
  IconHelp,
  IconLayers,
  IconPaste,
  IconPlus,
  IconSearch,
  Mark,
} from './icons.js';

interface Props {
  recent: RecentFile[];
  folders: PlanFolderState | null;
  onNewPlan: () => void;
  onOpenPlan: () => void;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onOpenFolderWorkspace: (folderId?: string) => void;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
}

const FEATURES = [
  {
    eyebrow: 'New workflow',
    title: 'Work across multiple shows',
    body: 'Keep plans in tabs, copy exact items from one show, and paste them into another without rebuilding the layout.',
    action: 'Open a second plan with the + beside the document tabs.',
    tone: 'blue',
    icon: <IconCopy size={24} />,
    companion: <IconPaste size={24} />,
  },
  {
    eyebrow: 'Project organization',
    title: 'Build a real folder workflow',
    body: 'Nest client and venue folders, add review notes, track approval status, and batch-file several plans at once.',
    action: 'Choose Folder Workspace from Home or the left panel.',
    tone: 'violet',
    icon: <IconFolder size={25} />,
    companion: <IconLayers size={23} />,
  },
  {
    eyebrow: 'Flexible rooms',
    title: 'Draw rooms in any shape',
    body: 'Trace custom outlines, add or remove corners, bow walls, and round one corner or the complete room.',
    action: 'Create a custom plan, then use Room editing in the inspector.',
    tone: 'orange',
    icon: <IconDrawPolygon size={25} />,
    companion: <IconEdit size={23} />,
  },
  {
    eyebrow: 'Detailed layouts',
    title: 'Plan seating in a focused workspace',
    body: 'Compare layouts, tune clearances and aisles, place sections, and keep the drawing visible while you work.',
    action: 'Open Seating from the top toolbar after opening a plan.',
    tone: 'green',
    icon: <IconChair size={25} />,
    companion: <IconLayers size={23} />,
  },
] as const;

function openedLabel(timestamp: number): string {
  if (!timestamp) return 'Previously opened';
  const difference = Date.now() - timestamp;
  if (difference < 60_000) return 'Just now';
  if (difference < 3_600_000) return `${Math.max(1, Math.round(difference / 60_000))} min ago`;
  if (difference < 86_400_000) return `${Math.max(1, Math.round(difference / 3_600_000))} hr ago`;
  if (difference < 604_800_000) return `${Math.max(1, Math.round(difference / 86_400_000))} days ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function folderTrail(folders: PlanFolderState['folders'], folder: PlanFolderState['folders'][number]): string {
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

export default function WelcomeHome({
  recent,
  folders,
  onNewPlan,
  onOpenPlan,
  onOpenFolder,
  onOpenPath,
  onOpenFolderWorkspace,
  onOpenShortcuts,
  onOpenSettings,
}: Props) {
  const [featureIndex, setFeatureIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [showAllRecent, setShowAllRecent] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(
      () => setFeatureIndex((current) => (current + 1) % FEATURES.length),
      7_000,
    );
    return () => window.clearInterval(timer);
  }, [paused]);

  const matchingRecent = useMemo(() => {
    const text = query.trim().toLowerCase();
    const found = text
      ? recent.filter((entry) => `${entry.name} ${entry.folder} ${entry.extension}`.toLowerCase().includes(text))
      : recent;
    return found.slice(0, showAllRecent || text ? 24 : 8);
  }, [query, recent, showAllRecent]);

  const featuredFolders = useMemo(() => {
    if (!folders) return [];
    return [...folders.folders]
      .sort(
        (a, b) =>
          Number(!!b.favorite) - Number(!!a.favorite) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 6);
  }, [folders]);

  const feature = FEATURES[featureIndex]!;

  return (
    <div className="welcome-home">
      <aside className="welcome-nav" aria-label="Home actions">
        <div className="welcome-nav-brand"><Mark size={24} /><span><strong>Groundplan</strong><small>Production planning</small></span></div>
        <button className="welcome-new" onClick={onNewPlan}><IconPlus size={16} /> New plan</button>
        <button onClick={onOpenPlan}><IconFile size={15} /> Open plan</button>
        <button onClick={onOpenFolder}><IconFolder size={15} /> Browse a folder</button>
        <div className="welcome-nav-rule" />
        <button className="is-current"><Mark size={15} /> Home</button>
        <button onClick={() => onOpenFolderWorkspace()}><IconLayers size={15} /> Folder Workspace</button>
        <div className="welcome-nav-spacer" />
        <button onClick={onOpenShortcuts}><IconHelp size={15} /> Shortcuts & tips</button>
        <button onClick={onOpenSettings}><IconEdit size={15} /> Settings</button>
        <p>Open native Room Viewer files directly. Groundplan never converts your original plan format.</p>
      </aside>

      <main className="welcome-content">
        <header className="welcome-heading">
          <span><small>Welcome back</small><h1>What are you planning today?</h1></span>
          <div className="welcome-global-search"><IconSearch size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a recent show…" aria-label="Find a recent show" /></div>
        </header>

        <section
          className={`welcome-feature is-${feature.tone}`}
          aria-label="Groundplan feature tips"
          aria-live="polite"
          onPointerEnter={() => setPaused(true)}
          onPointerLeave={() => setPaused(false)}
        >
          <div className="welcome-feature-copy">
            <small>{feature.eyebrow}</small>
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
            <button onClick={() => setFeatureIndex((featureIndex + 1) % FEATURES.length)}>Next tip <span aria-hidden="true">→</span></button>
            <span className="welcome-feature-action">{feature.action}</span>
          </div>
          <div className="welcome-feature-visual" aria-hidden="true">
            <div className="welcome-feature-sheet">
              <span className="feature-room-outline" />
              <span className="feature-row row-one" />
              <span className="feature-row row-two" />
              <span className="feature-row row-three" />
              <i>{feature.icon}</i>
              <i>{feature.companion}</i>
            </div>
          </div>
          <div className="welcome-feature-dots" aria-label="Choose a tip">
            {FEATURES.map((candidate, index) => (
              <button key={candidate.title} className={index === featureIndex ? 'active' : ''} onClick={() => setFeatureIndex(index)} aria-label={`Show tip: ${candidate.title}`} aria-current={index === featureIndex ? 'true' : undefined} />
            ))}
          </div>
        </section>

        <section className="welcome-section welcome-recents">
          <header><span><h2>Recent shows</h2><small>Continue where you left off</small></span>{recent.length > 8 && <button onClick={() => setShowAllRecent((all) => !all)}>{showAllRecent ? 'Show less' : `View all ${recent.length}`}</button>}</header>
          <div className="welcome-recent-grid">
            {matchingRecent.map((entry, index) => (
              <button className="welcome-recent-card" key={entry.path} onClick={() => onOpenPath(entry.path)} title={entry.path}>
                <span className={`welcome-plan-preview preview-${index % 4}`} aria-hidden="true"><i /><i /><i /><i /><b /></span>
                <span className="welcome-card-copy"><strong>{entry.name.replace(/\.[^.]+$/, '')}</strong><small>{entry.folder} · {entry.extension}</small><small>{openedLabel(entry.openedAt)}</small></span>
              </button>
            ))}
            {!matchingRecent.length && (
              <button className="welcome-empty-card" onClick={query ? () => setQuery('') : onOpenPlan}>
                <IconFile size={24} />
                <strong>{query ? 'No matching recent shows' : 'Open your first show'}</strong>
                <small>{query ? 'Clear the search and try again.' : 'Choose an RV4, RS4, SE4, RSD, or shape library.'}</small>
              </button>
            )}
          </div>
        </section>

        <section className="welcome-section welcome-folders">
          <header><span><h2>Plan folders</h2><small>Virtual filing — files stay on disk; Groundplan only tracks membership</small></span><button onClick={() => onOpenFolderWorkspace()}>Open Folder Workspace</button></header>
          <div className="welcome-folder-grid">
            {featuredFolders.map((folder) => {
              const planCount = folders?.plans.filter((plan) => plan.folderId === folder.id).length ?? 0;
              const childCount = folders?.folders.filter((candidate) => candidate.parentId === folder.id).length ?? 0;
              return (
                <button key={folder.id} onClick={() => onOpenFolderWorkspace(folder.id)} title={folderTrail(folders!.folders, folder)}>
                  <span className="welcome-folder-icon" style={{ '--folder-colour': folder.color ?? '#687789' } as CSSProperties}><IconFolder size={17} /></span>
                  <span><strong>{folder.name}</strong><small>{planCount} plan{planCount === 1 ? '' : 's'}{childCount ? ` · ${childCount} subfolder${childCount === 1 ? '' : 's'}` : ''}</small></span>
                  {folder.favorite && <b title="Favorite">★</b>}
                </button>
              );
            })}
            {!featuredFolders.length && (
              <button className="welcome-create-folder" onClick={() => onOpenFolderWorkspace()}><IconPlus size={15} /><span><strong>Create your first folder</strong><small>Organize plans without moving the original files.</small></span></button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
