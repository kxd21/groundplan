/**
 * ⌘K command palette — search and run structured shell actions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { filterCommands, type CommandDef, type CommandContext } from './commands.js';

export interface RunnableCommand extends CommandDef {
  run: () => void;
}

interface Props {
  open: boolean;
  catalog: RunnableCommand[];
  context: CommandContext;
  onClose: () => void;
  platform: 'darwin' | 'win32' | 'linux' | string;
}

export function CommandPalette({ open, catalog, context, onClose, platform }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const matches = useMemo(
    () => filterCommands(catalog, context, query) as RunnableCommand[],
    [catalog, context, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => Math.min(matches.length - 1, i + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const cmd = matches[active];
        if (!cmd) return;
        onClose();
        queueMicrotask(() => cmd.run());
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, matches, active, onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';

  return createPortal(
    <div className="command-palette-backdrop" onClick={onClose} role="presentation">
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="command-palette-header">
          <input
            ref={inputRef}
            className="command-palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions…"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="command-palette-kbd">{mod}K</kbd>
        </header>
        <div className="command-palette-list" ref={listRef} role="listbox" aria-label="Commands">
          {matches.length === 0 ? (
            <p className="command-palette-empty">No matching actions</p>
          ) : (
            matches.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                role="option"
                data-index={index}
                aria-selected={index === active}
                className={`command-palette-item${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onClose();
                  queueMicrotask(() => cmd.run());
                }}
              >
                <span className="command-palette-item-copy">
                  <strong>{cmd.title}</strong>
                  {cmd.subtitle ? <small>{cmd.subtitle}</small> : null}
                </span>
                <span className="command-palette-item-meta">
                  <em>{cmd.section}</em>
                  {cmd.shortcut ? <kbd>{cmd.shortcut.replace(/⌘/g, mod)}</kbd> : null}
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="command-palette-footer">
          <span>↑↓ to move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default CommandPalette;
