import type { WallEditGesture } from './wall-edit.js';

interface Props {
  open: boolean;
  wallLabel: string | null;
  wallLengthText?: string | null;
  curved?: boolean;
  wallIndex?: number | null;
  wallCount?: number;
  onPrevWall?: () => void;
  onNextWall?: () => void;
}

/**
 * Compact canvas chip for the selected wall — tools live in the top toolbar.
 */
export default function WallEditHud({
  open,
  wallLabel,
  wallLengthText = null,
  curved = false,
  wallIndex = null,
  wallCount = 0,
  onPrevWall,
  onNextWall,
}: Props) {
  if (!open) return null;

  const hasWall = wallLabel != null;
  const canStepWalls = wallCount > 1 && wallIndex != null;

  return (
    <div className="wall-edit-hud" role="status" aria-label="Selected wall">
      {hasWall ? (
        <div className="wall-edit-hud-identity">
          <span className="wall-edit-hud-label">
            <b>{wallLabel}</b>
            {wallLengthText ? <span className="wall-edit-hud-meta">{wallLengthText}</span> : null}
            {curved ? <span className="wall-edit-hud-badge">Curved</span> : null}
          </span>
          {canStepWalls ? (
            <div className="wall-edit-hud-stepper" role="group" aria-label="Select wall">
              <button type="button" onClick={onPrevWall} title="Previous wall" aria-label="Previous wall">
                ‹
              </button>
              <span aria-hidden>
                {(wallIndex ?? 0) + 1}/{wallCount}
              </span>
              <button type="button" onClick={onNextWall} title="Next wall" aria-label="Next wall">
                ›
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <span className="wall-edit-hud-label wall-edit-hud-prompt">
          <b>Click a wall</b>
          <span className="wall-edit-hud-meta">then drag the handle</span>
        </span>
      )}
      <span className="wall-edit-hud-hint">Shift fine · Alt free</span>
    </div>
  );
}

export type { WallEditGesture };
