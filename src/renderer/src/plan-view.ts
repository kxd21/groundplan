/**
 * Top / Front / Side editor view modes.
 *
 * Top is the familiar plan canvas. Front and Side are elevation viewports:
 * horizontal axis follows plan X or plan Y; vertical axis is elevation.
 */

export type PlanViewMode = 'top' | 'front' | 'side';

export function planViewLabel(v: PlanViewMode): string {
  switch (v) {
    case 'top':
      return 'Top';
    case 'front':
      return 'Front';
    case 'side':
      return 'Side';
  }
}

/**
 * Which plan axis drives the horizontal position in an elevation view.
 * Front looks along plan Y (uses X); side looks along plan X (uses Y).
 * Top has no elevation axis.
 */
export function elevationAxis(v: PlanViewMode): 'x' | 'y' | null {
  if (v === 'front') return 'x';
  if (v === 'side') return 'y';
  return null;
}
