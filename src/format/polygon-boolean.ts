/**
 * Boolean operations on arbitrary polygons.
 *
 * The room builder could already union and subtract rectangles, using a grid
 * decomposition that split both outlines on every x and y they contained and
 * kept the cells that survived. That is exact and fast and completely unable to
 * represent a diagonal or an arc, because a rectilinear grid has no cell for
 * one — `combineRooms` guarded with `isAxisAligned` and refused rather than
 * lie about the result.
 *
 * This is the general case: a sweep over the edges of both polygons, splitting
 * them wherever they cross, then walking the surviving pieces back into rings.
 * Angled walls, triangles, and arcs flattened to polylines all work, which is
 * what makes "rectangle + circle + triangle" one room rather than three.
 *
 * Coordinates are logical units — tenths of an inch — and are snapped to whole
 * units before anything else happens. That matters more than it looks: the
 * file format stores integers, so snapping costs no accuracy, and it turns the
 * degenerate cases that break naive clippers (a vertex landing exactly on an
 * edge, two outlines sharing a wall) into exact equalities that can be tested
 * for rather than floating-point near-misses that cannot.
 */

export interface Point {
  x: number;
  y: number;
}

export type BooleanOp = 'union' | 'difference' | 'intersection';

/** Snap to whole logical units: the format's own resolution. */
function snap(value: number): number {
  return Math.round(value);
}

function snapRing(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of ring) {
    const p = { x: snap(point.x), y: snap(point.y) };
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  // Drop a closing repeat; rings here are implicitly closed.
  while (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (first.x === last.x && first.y === last.y) out.pop();
    else break;
  }
  return out;
}

/** Twice the signed area. Positive is counter-clockwise in maths orientation. */
export function signedArea2(ring: Point[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total;
}

export function ringArea(ring: Point[]): number {
  return Math.abs(signedArea2(ring)) / 2;
}

/**
 * Winding-number point-in-polygon.
 *
 * Chosen over a crossing count because it is correct for self-intersecting and
 * nested rings without any special casing, which a room with a hole is.
 */
export function pointInRing(point: Point, ring: Point[]): boolean {
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (a.y <= point.y) {
      if (b.y > point.y && cross(a, b, point) > 0) winding++;
    } else if (b.y <= point.y && cross(a, b, point) < 0) {
      winding--;
    }
  }
  return winding !== 0;
}

function cross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

/** True when `p` lies on segment `a`–`b`, endpoints included. */
function onSegment(p: Point, a: Point, b: Point): boolean {
  if (cross(a, b, p) !== 0) return false;
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

/**
 * Every point where two rings' edges meet, as parameters along each edge.
 *
 * Collinear overlaps contribute their endpoints rather than an interval: the
 * walk below only needs the places where membership can change, and along a
 * shared edge it cannot change except at the ends.
 */
function splitPoints(ring: Point[], other: Point[]): Point[][] {
  const perEdge: Point[][] = ring.map(() => []);

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;

    for (let j = 0; j < other.length; j++) {
      const c = other[j]!;
      const d = other[(j + 1) % other.length]!;

      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);

      if (((d1 > 0) !== (d2 > 0) || (d1 < 0) !== (d2 < 0)) && ((d3 > 0) !== (d4 > 0) || (d3 < 0) !== (d4 < 0))) {
        // Proper crossing: solve for the point and snap it onto the grid.
        const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
        if (denominator !== 0) {
          const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
          perEdge[i]!.push({ x: snap(a.x + t * (b.x - a.x)), y: snap(a.y + t * (b.y - a.y)) });
        }
      }

      // Touching and collinear cases: any endpoint of one lying on the other is
      // a place the walk may need to turn.
      if (onSegment(c, a, b)) perEdge[i]!.push({ x: c.x, y: c.y });
      if (onSegment(d, a, b)) perEdge[i]!.push({ x: d.x, y: d.y });
    }
  }

  return perEdge;
}

/** Rebuilds a ring with every crossing inserted as a real vertex. */
function subdivide(ring: Point[], other: Point[]): Point[] {
  const perEdge = splitPoints(ring, other);
  const out: Point[] = [];

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    out.push(a);

    const along = perEdge[i]!
      .filter((p) => !(p.x === a.x && p.y === a.y) && !(p.x === b.x && p.y === b.y))
      .map((p) => ({ p, t: Math.hypot(p.x - a.x, p.y - a.y) }))
      .sort((m, n) => m.t - n.t);

    let previous: Point | null = null;
    for (const { p } of along) {
      if (previous && previous.x === p.x && previous.y === p.y) continue;
      out.push(p);
      previous = p;
    }
  }

  return snapRing(out);
}

/** The midpoint of an edge, which is where membership is tested. */
function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface Edge {
  from: Point;
  to: Point;
}

function ringEdges(ring: Point[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < ring.length; i++) {
    edges.push({ from: ring[i]!, to: ring[(i + 1) % ring.length]! });
  }
  return edges;
}

const keyOf = (p: Point) => `${p.x},${p.y}`;

/**
 * Walks a set of directed edges into closed rings.
 *
 * At a vertex with more than one way out, the walk takes the most clockwise
 * turn available. That is what keeps the outer boundary outside and any hole
 * inside rather than producing a figure-of-eight through the junction.
 */
function assembleRings(edges: Edge[]): Point[][] {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = keyOf(edge.from);
    const list = outgoing.get(key);
    if (list) list.push(edge);
    else outgoing.set(key, [edge]);
  }

  const used = new Set<Edge>();
  const rings: Point[][] = [];

  for (const start of edges) {
    if (used.has(start)) continue;

    const ring: Point[] = [];
    let edge: Edge | undefined = start;
    let guard = 0;

    while (edge && !used.has(edge) && guard++ < edges.length + 4) {
      used.add(edge);
      ring.push(edge.from);

      const candidates: Edge[] = (outgoing.get(keyOf(edge.to)) ?? []).filter(
        (next: Edge) => !used.has(next),
      );
      if (!candidates.length) break;

      if (candidates.length === 1) {
        edge = candidates[0];
        continue;
      }

      // Pick the sharpest right turn relative to the incoming direction.
      const incoming = Math.atan2(edge.to.y - edge.from.y, edge.to.x - edge.from.x);
      let best = candidates[0]!;
      let bestTurn = Infinity;
      for (const next of candidates) {
        const heading = Math.atan2(next.to.y - next.from.y, next.to.x - next.from.x);
        let turn = heading - incoming;
        while (turn <= -Math.PI) turn += 2 * Math.PI;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        if (turn < bestTurn) {
          bestTurn = turn;
          best = next;
        }
      }
      edge = best;
    }

    const closed = snapRing(ring);
    if (closed.length >= 3 && ringArea(closed) > 0) rings.push(closed);
  }

  return rings;
}

export interface BooleanResult {
  /** Outer boundaries, largest first. */
  outers: Point[][];
  /** Holes, each inside one of the outers. */
  holes: Point[][];
}

/**
 * Combines two polygons.
 *
 * Both are given as a single outer ring; holes in the operands are not handled
 * here, because the room model keeps holes separately and re-applies them.
 *
 * Returns null when the result is empty — an intersection that does not
 * overlap, or a difference that removes everything. That is a legitimate
 * answer and the caller has to say so rather than draw nothing.
 */
export function combinePolygons(
  subjectRaw: Point[],
  clipRaw: Point[],
  op: BooleanOp,
): BooleanResult | null {
  const subject = snapRing(subjectRaw);
  const clip = snapRing(clipRaw);
  if (subject.length < 3 || clip.length < 3) return null;

  // Work in a consistent orientation so the "keep" tests below mean the same
  // thing whichever way the caller wound its outlines.
  const orient = (ring: Point[]) => (signedArea2(ring) < 0 ? [...ring].reverse() : ring);
  const s = orient(subject);
  const c = orient(clip);

  const subjectSplit = subdivide(s, c);
  const clipSplit = subdivide(c, s);

  const keep: Edge[] = [];

  /**
   * Whether an edge lies along the other ring's boundary, and which way.
   *
   * This is the case a midpoint test cannot answer: a point exactly ON a
   * boundary is neither inside nor outside, so classifying a shared wall by
   * sampling its middle gives an arbitrary result. Two rooms that abut, a
   * shape unioned with itself, and any two outlines that share an edge all
   * land here — which is to say, most of the ways a room actually gets built.
   *
   * Returns 'same' when the two edges run the same direction (the shared wall
   * is outer boundary for both), 'opposite' when they run against each other
   * (one is inside the other), and null when the edge is not on the boundary
   * at all.
   */
  const coincident = (edge: Edge, ring: Point[]): 'same' | 'opposite' | null => {
    const mid = midpoint(edge.from, edge.to);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (!onSegment(mid, a, b)) continue;
      // Parallel test: the edge must be collinear with this one, not merely
      // crossing its midpoint.
      if (cross(a, b, edge.from) !== 0 || cross(a, b, edge.to) !== 0) continue;
      const dot =
        (edge.to.x - edge.from.x) * (b.x - a.x) + (edge.to.y - edge.from.y) * (b.y - a.y);
      return dot >= 0 ? 'same' : 'opposite';
    }
    return null;
  };

  /*
   * Which edges survive, by op:
   *
   *   union         subject outside clip, plus clip outside subject
   *   intersection  subject inside clip, plus clip inside subject
   *   difference    subject outside clip, plus clip inside subject REVERSED
   *
   * The reversal is what turns the cut-out's boundary into a hole running the
   * other way round, so the assembled ring encloses the right side of itself.
   */
  for (const edge of ringEdges(subjectSplit)) {
    const shared = coincident(edge, c);
    if (shared) {
      // A wall the two outlines have in common. It belongs to the result once,
      // and the subject is the one that contributes it.
      if (op === 'union' && shared === 'same') keep.push(edge);
      if (op === 'intersection' && shared === 'same') keep.push(edge);
      if (op === 'difference' && shared === 'opposite') keep.push(edge);
      continue;
    }
    const inside = pointInRing(midpoint(edge.from, edge.to), c);
    if (op === 'union' && !inside) keep.push(edge);
    if (op === 'intersection' && inside) keep.push(edge);
    if (op === 'difference' && !inside) keep.push(edge);
  }

  for (const edge of ringEdges(clipSplit)) {
    // A shared wall was already contributed by the subject; taking it again
    // here would give the walk two ways out of the same vertex and assemble a
    // ring that doubles back on itself.
    if (coincident(edge, s)) continue;

    const inside = pointInRing(midpoint(edge.from, edge.to), s);
    if (op === 'union' && !inside) keep.push(edge);
    if (op === 'intersection' && inside) keep.push(edge);
    if (op === 'difference' && inside) keep.push({ from: edge.to, to: edge.from });
  }

  if (!keep.length) {
    // No surviving boundary. For a union of two identical outlines that is
    // wrong, so fall back to whichever operand is the answer.
    if (op === 'union') return { outers: [s], holes: [] };
    if (op === 'intersection' && pointInRing(s[0]!, c)) return { outers: [s], holes: [] };
    return null;
  }

  const rings = assembleRings(keep);
  if (!rings.length) return null;

  // Sort by area so the largest is the outer boundary, and anything strictly
  // inside another is a hole.
  const sorted = [...rings].sort((a, b) => ringArea(b) - ringArea(a));
  const outers: Point[][] = [];
  const holes: Point[][] = [];

  for (const ring of sorted) {
    const insideAnOuter = outers.some((outer) => pointInRing(ring[0]!, outer));
    if (insideAnOuter) holes.push(ring);
    else outers.push(ring);
  }

  return { outers, holes };
}
