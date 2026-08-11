import RoomPanel from './RoomPanel.js';
import type { Doc } from './App.js';
import { IconDrawPolygon, IconRuler } from './icons.js';
import type { WallEditGesture, WallEditSession } from './wall-edit.js';

export type RoomWorkspaceFocus = 'walls' | 'room';

interface Props {
  open: boolean;
  focus?: RoomWorkspaceFocus;
  doc: Doc;
  onDoc: (doc: Doc) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onSelect: (ids: number[]) => void;
  drawingRoomOutline: boolean;
  onDrawRoomOutline: () => void;
  onRoomAuthored?: () => void | Promise<void>;
  onWallEditChange?: (session: WallEditSession | null) => void;
  wallPickIndex?: number | null;
  wallEditGesture?: WallEditGesture;
  onWallEditGestureChange?: (action: WallEditGesture) => void;
  onClose: () => void;
}

/**
 * Dedicated dock for room layout and wall editing while the plan stays
 * interactive — whole-room size/add-cut plus per-wall numeric edits.
 * Live gestures (Push / Curve / Length) live in the top toolbar.
 */
export default function RoomRefineWorkspace({
  open,
  focus = 'room',
  doc,
  onDoc,
  onStatus,
  onError,
  onSelect,
  drawingRoomOutline,
  onDrawRoomOutline,
  onRoomAuthored,
  onWallEditChange,
  wallPickIndex = null,
  wallEditGesture = 'push',
  onWallEditGestureChange,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <aside className="room-refine-workspace" aria-label="Room layout workspace">
      <header className="room-refine-header">
        <span className="room-refine-mark" aria-hidden>
          <IconDrawPolygon size={18} />
        </span>
        <div className="room-refine-title">
          <small>Workspace</small>
          <strong>Room layout</strong>
          <span title={doc.name}>{doc.name.replace(/\.[^.]+$/, '')}</span>
        </div>
        <span className={`inspector-access${doc.editable ? '' : ' is-readonly'}`}>
          {doc.editable ? 'Editable' : 'Read only'}
        </span>
        <button
          type="button"
          className="room-refine-close"
          onClick={onClose}
          aria-label="Close room layout workspace"
          title="Close room layout workspace (Esc)"
        >
          ×
        </button>
      </header>

      <div className="room-refine-guide" role="note">
        <IconRuler size={14} />
        <p>
          {focus === 'walls'
            ? 'Use Push / Curve / Length in the top bar, then drag the wall handle on the plan.'
            : 'Resize the whole room or add/cut area, then drag walls on the plan.'}
        </p>
      </div>

      <div className="room-refine-body">
        <RoomPanel
          mode="refine"
          workspaceFocus={focus}
          doc={doc}
          onDoc={onDoc}
          onStatus={onStatus}
          onError={onError}
          onSelect={onSelect}
          drawingRoomOutline={drawingRoomOutline}
          onDrawRoomOutline={onDrawRoomOutline}
          onRoomAuthored={onRoomAuthored}
          onWallEditChange={onWallEditChange}
          wallPickIndex={wallPickIndex}
          preferredWallAction={wallEditGesture}
          onPreferredWallActionChange={onWallEditGestureChange}
        />
      </div>
    </aside>
  );
}
