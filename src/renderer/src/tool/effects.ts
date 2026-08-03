/**
 * The one place a tool effect becomes an IPC call.
 *
 * `ToolEffect` is one-to-one with the main-process channels, and this file is
 * the whole mapping. That matters beyond tidiness: this subsystem writes no
 * bytes itself, but a mis-wired dispatch sending `plan:draw` where
 * `plan:add-dimension` was meant would produce a perfectly valid file
 * containing the wrong objects — `verifyWritable` would pass and nobody would
 * notice until the class histogram. One mapping in one file is what makes that
 * reviewable.
 *
 * Keeping it out of `machine.ts` is also what lets `tools/tool-machine-test.ts`
 * import the machine from a plain tsx script with no renderer around it.
 */

import type { PendingEffect } from './machine.js';

/** The slice of the preload API the tools need. Injected, never reached for. */
export interface ToolApi {
  placeGear(description: string, x: number, y: number): Promise<EditLike & { method?: string }>;
  inventoryPlace(id: string, x: number, y: number): Promise<EditLike & { method?: string }>;
  addLabel(text: string, x: number, y: number): Promise<EditLike>;
  addSeating(request: unknown): Promise<EditLike & { placed?: number }>;
  addDimension(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    startNodeId?: number,
    endNodeId?: number,
  ): Promise<EditLike & { text?: string }>;
  draw(shape: 'line' | 'rect' | 'ellipse', x1: number, y1: number, x2: number, y2: number): Promise<EditLike>;
}

interface EditLike {
  ok: boolean;
  reason?: string;
  created?: number[];
  doc?: unknown;
}

export type EffectResult = {
  ok: boolean;
  reason?: string;
  created?: number[];
  doc?: unknown;
  /** What to say in the status line when it worked. */
  status?: string;
};

export async function runEffect(effect: PendingEffect, api: ToolApi): Promise<EffectResult> {
  switch (effect.do) {
    case 'placeGear': {
      const reply = await api.placeGear(effect.description, effect.at.x, effect.at.y);
      return {
        ...reply,
        status: reply.ok
          ? reply.method === 'matched'
            ? `Placed ${effect.description} from the plan's own shapes`
            : `Placed ${effect.description} as a sized box`
          : undefined,
      };
    }
    case 'placeInventory': {
      const reply = await api.inventoryPlace(effect.id, effect.at.x, effect.at.y);
      return {
        ...reply,
        status: reply.ok
          ? reply.method === 'matched'
            ? `Placed ${effect.name} from the plan's own shapes`
            : `Placed ${effect.name} as a sized box`
          : undefined,
      };
    }
    case 'placeLabel': {
      const reply = await api.addLabel(effect.text, effect.at.x, effect.at.y);
      return { ...reply, status: reply.ok ? `Added ${effect.text}` : undefined };
    }
    case 'placeSeating': {
      const reply = await api.addSeating({ ...effect.request, x: effect.at.x, y: effect.at.y });
      return {
        ...reply,
        status: reply.ok ? `Placed ${reply.placed ?? 0} items` : undefined,
      };
    }
    case 'draw': {
      const reply = await api.draw(effect.shape, effect.from.x, effect.from.y, effect.to.x, effect.to.y);
      return {
        ...reply,
        status: reply.ok
          ? `Drew a ${effect.shape === 'rect' ? 'rectangle' : effect.shape}`
          : undefined,
      };
    }
    case 'addDimension': {
      const reply = await api.addDimension(
        effect.from.x,
        effect.from.y,
        effect.to.x,
        effect.to.y,
        effect.from.nodeId,
        effect.to.nodeId,
      );
      return { ...reply, status: reply.ok ? (reply.text ? `Added ${reply.text}` : 'Added dimension') : undefined };
    }
    case 'showReadout':
      // The temporary measurement never leaves the renderer. The machine has
      // already put it in `state.readout`; this exists so every click takes the
      // same path and the epoch guard applies uniformly.
      return { ok: true };
  }
}
