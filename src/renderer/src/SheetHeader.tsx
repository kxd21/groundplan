/**
 * Shared dialog header: icon mark, eyebrow, title, subtitle, square close.
 *
 * Seating / print / refine already used this language; legacy sheets used a
 * plain h2 + outline “Close”. One component keeps every overlay consistent.
 */

import type { ReactNode } from 'react';

import { IconClose } from './icons.js';

interface Props {
  /** Short uppercase context line above the title. */
  eyebrow?: string;
  title: string;
  /** One clause about what this dialog does. */
  subtitle?: string;
  /** Associates with aria-labelledby on the dialog. */
  titleId?: string;
  /** Optional icon or glyph in the mark tile. */
  mark?: ReactNode;
  onClose?: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
  trailing?: ReactNode;
}

export default function SheetHeader({
  eyebrow,
  title,
  subtitle,
  titleId,
  mark,
  onClose,
  closeDisabled = false,
  closeLabel,
  trailing,
}: Props) {
  return (
    <header className="sheet-header">
      {mark != null ? (
        <span className="sheet-header-mark" aria-hidden>
          {mark}
        </span>
      ) : null}
      <span className="sheet-header-copy">
        {eyebrow ? <small>{eyebrow}</small> : null}
        <strong id={titleId}>{title}</strong>
        {subtitle ? <span title={subtitle}>{subtitle}</span> : null}
      </span>
      {trailing}
      {onClose ? (
        <button
          type="button"
          className="sheet-header-close"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label={closeLabel ?? `Close ${title}`}
          title={closeLabel ?? `Close ${title} (Esc)`}
        >
          <IconClose size={14} />
        </button>
      ) : null}
    </header>
  );
}
