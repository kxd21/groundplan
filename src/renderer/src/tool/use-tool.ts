/**
 * The React binding. Deliberately thin: everything that can be decided without
 * a DOM is decided in `machine.ts`, which is where the tests can reach.
 *
 * The ref is the truth and the `useState` mirror exists only so the toolbar,
 * the banner and the canvas re-render. `dispatch` writes the ref
 * *synchronously* and hands back the effect, so by the time a caller has an
 * `await` in front of it the held start point is already consumed and the epoch
 * already fixed. That technique was invented for one field — the two-point
 * start — and is applied here to the tool value as a whole.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import {
  initialToolState,
  reduce,
  type Capability,
  type PendingEffect,
  type ToolEvent,
  type ToolState,
} from './machine.js';

export type Dispatch = (event: ToolEvent) => {
  state: ToolState;
  effect: PendingEffect | null;
  refusal?: string;
};

export function useTool(can: Capability): {
  state: ToolState;
  /** The committed state, readable from inside an effect or an async handler. */
  ref: MutableRefObject<ToolState>;
  dispatch: Dispatch;
} {
  const ref = useRef<ToolState>(initialToolState(can));
  const [state, setState] = useState<ToolState>(ref.current);

  const dispatch = useCallback<Dispatch>((event) => {
    const next = reduce(ref.current, event);
    if (next.state !== ref.current) {
      ref.current = next.state;
      setState(next.state);
    }
    return next;
  }, []);

  useEffect(() => {
    const current = ref.current.can;
    if (current.open === can.open && current.editable === can.editable) return;
    dispatch({ type: 'capability', can });
  }, [can.open, can.editable, dispatch]);

  return { state, ref, dispatch };
}
