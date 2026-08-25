/**
 * The one titlebar every Plan dock panel opens with.
 *
 * Browse, Place, Inspect, Setup and Draw used to introduce themselves five
 * different ways. Setup carried a bare × in its corner, Draw carried four
 * unlabelled window controls on a dark strip, and Browse, Place and Inspect
 * carried no close affordance at all — so "what is this panel and how do I
 * get rid of it?" had three answers, two of which were invisible.
 *
 * One line, same place, same behaviour: what the panel is, an optional word
 * about its state, and the control that closes it.
 */

import type { ReactNode } from 'react';

import { IconClose } from './icons.js';

interface Props {
  /** The mode this panel belongs to, in the mode strip's own wording. */
  title: string;
  /** One short clause about what the panel does, or the state it is in. */
  sub?: string;
  /** Status that belongs to the panel rather than to the plan, e.g. Read only. */
  trailing?: ReactNode;
  onClose: () => void;
  /** Overrides the close button's label where "Close Draw" would read oddly. */
  closeLabel?: string;
}

export default function DockTitlebar({ title, sub, trailing, onClose, closeLabel }: Props) {
  return (
    <header className="dock-titlebar">
      <span className="dock-titlebar-copy">
        <span className="dock-titlebar-title">{title}</span>
        {sub ? (
          <span className="dock-titlebar-sub" title={sub}>
            {sub}
          </span>
        ) : null}
      </span>
      {trailing}
      <button
        type="button"
        className="dock-titlebar-close"
        onClick={onClose}
        data-tooltip={`${closeLabel ?? `Close ${title}`} (Esc)`}
        aria-label={closeLabel ?? `Close ${title}`}
      >
        <IconClose size={14} />
      </button>
    </header>
  );
}
