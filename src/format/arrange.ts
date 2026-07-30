export type ArrangeMode =
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'distribute-horizontal'
  | 'distribute-vertical';

export interface ArrangeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ArrangeItem {
  id: number;
  bounds: ArrangeBounds;
}

export interface ArrangeMove {
  id: number;
  dx: number;
  dy: number;
}

const centreX = (bounds: ArrangeBounds) => (bounds.minX + bounds.maxX) / 2;
const centreY = (bounds: ArrangeBounds) => (bounds.minY + bounds.maxY) / 2;

/**
 * Calculates a drafting-style alignment without touching the document.
 *
 * Edge alignment uses the outside of the whole selection. Distribution keeps
 * the two outside objects fixed and gives the objects between them equal clear
 * space, which behaves well when the selected items have different sizes.
 */
export function arrangeMoves(items: ArrangeItem[], mode: ArrangeMode): ArrangeMove[] {
  const minimum = mode.startsWith('distribute-') ? 3 : 2;
  if (items.length < minimum) return [];

  const moves: ArrangeMove[] = [];
  const selection = {
    minX: Math.min(...items.map((item) => item.bounds.minX)),
    minY: Math.min(...items.map((item) => item.bounds.minY)),
    maxX: Math.max(...items.map((item) => item.bounds.maxX)),
    maxY: Math.max(...items.map((item) => item.bounds.maxY)),
  };

  if (mode === 'distribute-horizontal') {
    const ordered = [...items].sort((a, b) => centreX(a.bounds) - centreX(b.bounds));
    const occupied = ordered.reduce((sum, item) => sum + item.bounds.maxX - item.bounds.minX, 0);
    const gap = (selection.maxX - selection.minX - occupied) / (ordered.length - 1);
    let cursor = selection.minX;
    for (const item of ordered) {
      moves.push({ id: item.id, dx: cursor - item.bounds.minX, dy: 0 });
      cursor += item.bounds.maxX - item.bounds.minX + gap;
    }
  } else if (mode === 'distribute-vertical') {
    const ordered = [...items].sort((a, b) => centreY(a.bounds) - centreY(b.bounds));
    const occupied = ordered.reduce((sum, item) => sum + item.bounds.maxY - item.bounds.minY, 0);
    const gap = (selection.maxY - selection.minY - occupied) / (ordered.length - 1);
    let cursor = selection.minY;
    for (const item of ordered) {
      moves.push({ id: item.id, dx: 0, dy: cursor - item.bounds.minY });
      cursor += item.bounds.maxY - item.bounds.minY + gap;
    }
  } else {
    for (const item of items) {
      let dx = 0;
      let dy = 0;
      if (mode === 'align-left') dx = selection.minX - item.bounds.minX;
      if (mode === 'align-center') dx = centreX(selection) - centreX(item.bounds);
      if (mode === 'align-right') dx = selection.maxX - item.bounds.maxX;
      if (mode === 'align-top') dy = selection.minY - item.bounds.minY;
      if (mode === 'align-middle') dy = centreY(selection) - centreY(item.bounds);
      if (mode === 'align-bottom') dy = selection.maxY - item.bounds.maxY;
      moves.push({ id: item.id, dx, dy });
    }
  }

  // Tiny floating-point residue should not turn a no-op into an undo step.
  return moves.map((move) => ({
    ...move,
    dx: Math.abs(move.dx) < 1e-6 ? 0 : move.dx,
    dy: Math.abs(move.dy) < 1e-6 ? 0 : move.dy,
  }));
}
