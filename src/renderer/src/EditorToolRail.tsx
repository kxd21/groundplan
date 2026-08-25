import type { ReactNode } from 'react';

export interface EditorRailAction {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

interface Props {
  workspaces: EditorRailAction[];
  tools: EditorRailAction[];
}

/**
 * The plan editor's permanent activity + tool rail.
 *
 * Workspace buttons open real domain surfaces (assets, room, stage, seating,
 * layouts, properties). The compact grid below maps one-for-one to the pointer
 * state machine: picking a button changes what the next canvas gesture does.
 */
export default function EditorToolRail({ workspaces, tools }: Props) {
  const action = (item: EditorRailAction, compact = false) => {
    const tip = `${item.label}${item.shortcut ? ` (${item.shortcut})` : ''}`;
    return (
      <button
        key={item.id}
        type="button"
        className={`${compact ? 'editor-tool-action' : 'editor-workspace-action'}${item.active ? ' is-active' : ''}`}
        onClick={item.onClick}
        disabled={item.disabled}
        aria-label={tip}
        aria-pressed={Boolean(item.active)}
        data-tool-id={compact ? item.id : undefined}
        title={tip}
        data-tooltip={tip}
      >
        <span className="editor-rail-icon" aria-hidden>{item.icon}</span>
        {!compact && <span className="editor-rail-label">{item.label}</span>}
      </button>
    );
  };

  return (
    <aside className="editor-tool-rail" aria-label="Plan editor">
      <nav className="editor-workspace-actions" aria-label="Plan workspaces">
        {workspaces.map((item) => action(item))}
      </nav>
      <div className="editor-rail-divider" />
      <span className="editor-tools-label">Tools</span>
      <div className="editor-tool-actions" role="toolbar" aria-label="Canvas tools">
        {tools.map((item) => action(item, true))}
      </div>
    </aside>
  );
}
