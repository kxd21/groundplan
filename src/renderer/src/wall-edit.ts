/** Shared room-wall overlay contract between RoomPanel and PlanCanvas. */

export interface WallEditSegment {
  index: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  curved: boolean;
  bulge: number;
  length: number;
}

export type WallEditGesture = 'push' | 'curve' | 'length';

export interface WallEditSession {
  walls: WallEditSegment[];
  selected: number;
  /** Mid-handle drag: push moves the wall, curve bows it, length stretches the chord. */
  gesture: WallEditGesture;
  editable: boolean;
}
