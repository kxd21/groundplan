import type { WallEditGesture } from './wall-edit.js';
import { IconDrawPolygon, IconRuler } from './icons.js';

interface Props {
  focus: 'walls' | 'room';
  onFocus: (focus: 'walls' | 'room') => void;
  gesture: WallEditGesture;
  onGesture: (gesture: WallEditGesture) => void;
  wallLabel: string | null;
  wallLengthText: string | null;
  curved: boolean;
  editable: boolean;
  onNudgeIn: () => void;
  onNudgeOut: () => void;
  onStraighten: () => void;
  onAddCorner: () => void;
  onRoundCorner: () => void;
  onDone: () => void;
}

/**
 * Top-ribbon wall tools while Room layout is open — replaces the side
 * inspector for this mode with controls that actually change walls.
 */
export default function WallEditToolbar({
  focus,
  onFocus,
  gesture,
  onGesture,
  wallLabel,
  wallLengthText,
  curved,
  editable,
  onNudgeIn,
  onNudgeOut,
  onStraighten,
  onAddCorner,
  onRoundCorner,
  onDone,
}: Props) {
  const hasWall = wallLabel != null;
  const nudgeBlocked = !editable || !hasWall || (gesture !== 'curve' && curved);

  return (
    <div className="room-layout-toolbar" aria-label="Wall edit tools">
      <span className="text-context-mode">
        <IconDrawPolygon size={14} />
        <b>{focus === 'walls' ? 'Edit walls' : 'Room layout'}</b>
      </span>

      <div className="seg" role="group" aria-label="Workspace focus">
        <button
          type="button"
          className={focus === 'walls' ? 'is-on' : ''}
          aria-pressed={focus === 'walls'}
          onClick={() => onFocus('walls')}
        >
          Walls
        </button>
        <button
          type="button"
          className={focus === 'room' ? 'is-on' : ''}
          aria-pressed={focus === 'room'}
          onClick={() => onFocus('room')}
        >
          Room
        </button>
      </div>

      <span className="seg-divider" aria-hidden />

      <div className="seg" role="group" aria-label="Wall gesture">
        {(
          [
            ['push', 'Push'],
            ['curve', 'Curve'],
            ['length', 'Length'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={gesture === id ? 'is-on' : ''}
            aria-pressed={gesture === id}
            disabled={!editable}
            title={
              id === 'push'
                ? 'Push / pull the wall (1″ · Shift fine · Alt free)'
                : id === 'curve'
                  ? 'Curve the wall (1″ · Shift fine · Alt free)'
                  : 'Stretch wall length (1″ · Shift fine · Alt free)'
            }
            onClick={() => onGesture(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {hasWall ? (
        <>
          <span className="room-layout-wall-chip" title={wallLabel ?? undefined}>
            <IconRuler size={13} />
            <b>{wallLabel}</b>
            {wallLengthText ? <span>{wallLengthText}</span> : null}
            {curved ? <em>Curved</em> : null}
          </span>
          <div className="seg room-layout-wall-actions" role="group" aria-label="Wall actions">
            <button
              type="button"
              disabled={nudgeBlocked}
              title={
                gesture === 'curve'
                  ? 'Nudge curve into the room (1″)'
                  : gesture === 'length'
                    ? 'Shorten wall (1″)'
                    : 'Pull wall in (1″)'
              }
              onClick={onNudgeIn}
            >
              −1″
            </button>
            <button
              type="button"
              disabled={nudgeBlocked}
              title={
                gesture === 'curve'
                  ? 'Nudge curve out of the room (1″)'
                  : gesture === 'length'
                    ? 'Lengthen wall (1″)'
                    : 'Push wall out (1″)'
              }
              onClick={onNudgeOut}
            >
              +1″
            </button>
            <button
              type="button"
              disabled={!editable || !curved}
              title={curved ? 'Straighten this wall' : 'Wall is already straight'}
              onClick={onStraighten}
            >
              Straighten
            </button>
            <button
              type="button"
              disabled={!editable || curved}
              title={curved ? 'Straighten before adding a corner' : 'Add a corner on this wall'}
              onClick={onAddCorner}
            >
              Add corner
            </button>
            <button
              type="button"
              disabled={!editable || curved}
              title={curved ? 'Straighten before rounding' : 'Round the start corner'}
              onClick={onRoundCorner}
            >
              Round
            </button>
          </div>
        </>
      ) : (
        <span className="room-layout-wall-chip is-empty">Click a wall on the plan</span>
      )}

      <span className="spacer" />
      <button type="button" className="primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
