/**
 * Scrubbable property label (Illustrator-style).
 * Drag left/right on the label to nudge the linked numeric value.
 */
import { useCallback, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from 'react';

export interface ScrubLabelProps extends HTMLAttributes<HTMLSpanElement> {
  disabled?: boolean;
  /** Pixels of drag per unit of change. Higher = finer. */
  pixelsPerUnit?: number;
  /** Called continuously while dragging with the signed unit delta since last move. */
  onDelta: (delta: number) => void;
  /** Called once when the pointer is released after a drag. */
  onScrubEnd?: () => void;
}

export function ScrubLabel({
  disabled = false,
  pixelsPerUnit = 4,
  onDelta,
  onScrubEnd,
  className,
  children,
  ...rest
}: ScrubLabelProps) {
  const lastX = useRef<number | null>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      lastX.current = event.clientX;
      dragging.current = false;
    },
    [disabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (lastX.current == null || disabled) return;
      const dx = event.clientX - lastX.current;
      if (!dragging.current && Math.abs(dx) < 2) return;
      dragging.current = true;
      lastX.current = event.clientX;
      const units = dx / Math.max(1, pixelsPerUnit);
      if (units !== 0) onDelta(units);
    },
    [disabled, onDelta, pixelsPerUnit],
  );

  const end = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (lastX.current == null) return;
      lastX.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (dragging.current) onScrubEnd?.();
      dragging.current = false;
    },
    [onScrubEnd],
  );

  return (
    <span
      {...rest}
      className={`scrub-label${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      title={undefined}
      data-tooltip={disabled ? undefined : 'Drag left or right to adjust'}
      data-no-tooltip={disabled ? true : undefined}
    >
      {children}
    </span>
  );
}
