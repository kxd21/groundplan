/**
 * The menu you get for right-clicking something on the plan.
 *
 * There was no menu at all before this: the canvas called `preventDefault` on
 * `contextmenu` and right-drag was taken for panning, so right-clicking a
 * selected object did nothing. Every object action — duplicate, group, send to
 * back, properties — was a trip to the toolbar or the Inspect panel, which is
 * a long way to go for something the pointer is already on top of.
 *
 * The menu offers what applies to what was actually clicked. An empty patch of
 * sheet gets paste and select-all; an object gets the actions that operate on
 * it. Nothing here is a new capability — it is the existing commands, at the
 * pointer.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface PlanMenuItem {
  id: string;
  label: string;
  /** Shown right-aligned; the same shortcut the command already answers to. */
  shortcut?: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

/** A rule between groups of related items. */
export type PlanMenuEntry = PlanMenuItem | { id: string; separator: true };

interface Props {
  /** Where the click happened, in client coordinates. */
  at: { x: number; y: number };
  items: PlanMenuEntry[];
  onClose: () => void;
}

const MARGIN = 8;

export default function PlanContextMenu({ at, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: at.x, top: at.y });

  /*
   * Flip rather than clip. A menu opened near the right or bottom edge has to
   * come back inside the window, and moving it before paint means it never
   * appears in the wrong place and jumps.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    let left = at.x;
    let top = at.y;
    if (left + box.width > window.innerWidth - MARGIN) left = Math.max(MARGIN, at.x - box.width);
    if (top + box.height > window.innerHeight - MARGIN) top = Math.max(MARGIN, at.y - box.height);
    setPosition({ left, top });
  }, [at.x, at.y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    // Capture, so a click anywhere closes the menu before that click is acted
    // on by whatever is underneath it.
    const onDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const usable = items.filter(
    (item): item is PlanMenuItem => !('separator' in item),
  );
  if (!usable.length) return null;

  return createPortal(
    <div
      ref={ref}
      className="plan-context-menu"
      role="menu"
      aria-label="Plan actions"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) =>
        'separator' in item ? (
          <div key={item.id} className="plan-context-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={item.danger ? 'is-danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon ? (
              <span className="plan-context-icon" aria-hidden>
                {item.icon}
              </span>
            ) : (
              <span className="plan-context-icon" aria-hidden />
            )}
            <span className="plan-context-label">{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
