/**
 * DXF export, aimed at Vectorworks.
 *
 * The point of this is not to move lines across — anything can do that. It is
 * to move *structure* across, because that is what decides whether the 3D work
 * on the other side takes ten minutes or two days.
 *
 * A plan holds 105 chairs. Exported as loose geometry that is 105 scattered
 * outlines, and making them 3D means drawing 105 chairs. Exported as a block
 * definition plus 105 insertions, Vectorworks turns the block into a symbol —
 * so the chair is replaced with a 3D chair *once* and every instance updates.
 * Same for tables, projectors, truss and everything else that repeats.
 *
 * So each distinct catalogue shape becomes one BLOCK, and every placement
 * becomes an INSERT carrying its own position and rotation. Free-drawn
 * geometry — walls, dimension lines, notes — goes out as ordinary entities on
 * named layers that survive the round trip.
 *
 * R12 is the target: it is the most widely-read DXF flavour, and Vectorworks
 * has imported it reliably for two decades.
 */

import { walk, type RVDocument, type RVNode } from './rv.js';
import type { Layer, Scene, ScenePrimitive } from './scene.js';
import { instanceKey } from './definition.js';

/** Logical units are tenths of an inch; DXF goes out in inches. */
const UNITS_PER_INCH = 10;

/** Groundplan layers to DXF layer names, with an AutoCAD colour index each. */
const LAYERS: Record<Layer, { name: string; color: number }> = {
  walls: { name: 'GP-WALLS', color: 7 },
  furniture: { name: 'GP-EQUIPMENT', color: 5 },
  region: { name: 'GP-REGIONS', color: 3 },
  annotation: { name: 'GP-ANNOTATION', color: 2 },
  other: { name: 'GP-OTHER', color: 8 },
};

const BLOCK_LAYER = 'GP-EQUIPMENT';

export interface DxfOptions {
  /** Layers the user has switched off are left out, as they are when printing. */
  visible?: Set<Layer>;
  /**
   * Elevation above finished floor in logical units, keyed by instanceKey
   * (name@inchX,inchY). Written as DXF INSERT group-code 30 so VW can hang
   * symbols at height.
   */
  elevations?: Map<string, number> | Record<string, number>;
}

export interface DxfResult {
  text: string;
  /** Distinct symbols exported as blocks — the ones worth swapping for 3D. */
  blocks: number;
  /** Placements referencing those blocks. */
  inserts: number;
  /** Entities written directly, because they belong to no repeated symbol. */
  loose: number;
}

/**
 * DXF block names are restrictive: no spaces, and R12 keeps them short.
 *
 * Names are also the only thing tying the export back to the inventory, so
 * collisions have to be resolved rather than allowed to merge two shapes.
 */
function blockNames(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();

  for (const name of names) {
    const base =
      name
        .toUpperCase()
        .replace(/["']/g, '')
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28) || 'SHAPE';

    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base.slice(0, 26)}-${n++}`;
    used.add(candidate);
    out.set(name, candidate);
  }
  return out;
}

/** A DXF group code and value, which is the whole file format. */
type Pair = [number, string | number];

function emit(pairs: Pair[]): string {
  const out: string[] = [];
  for (const [code, value] of pairs) {
    out.push(String(code));
    out.push(typeof value === 'number' ? formatNumber(value) : value);
  }
  return out.join('\r\n');
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0.0';
  // Six decimals in inches is a ten-thousandth of an inch: far past the
  // precision of anything drawn here, and short enough to keep files small.
  return (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
}

const toInches = (units: number): number => units / UNITS_PER_INCH;

/** The name a shape is drawn under, ignoring font labels. */
function shapeName(node: RVNode): string | undefined {
  return node.labels.find((l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l));
}

function polylineEntity(layer: string, points: number[], closed: boolean, elevation = 0): Pair[] {
  const pairs: Pair[] = [
    [0, 'POLYLINE'],
    [8, layer],
    [66, 1],
    [10, 0],
    [20, 0],
    [30, elevation],
    [70, closed ? 1 : 0],
  ];
  for (let i = 0; i < points.length; i += 2) {
    pairs.push([0, 'VERTEX'], [8, layer], [10, points[i]], [20, points[i + 1]], [30, elevation]);
  }
  pairs.push([0, 'SEQEND'], [8, layer]);
  return pairs;
}

function textEntity(layer: string, x: number, y: number, height: number, value: string): Pair[] {
  return [
    [0, 'TEXT'],
    [8, layer],
    [10, x],
    [20, y],
    [30, 0],
    [40, height],
    [1, value.replace(/\r?\n/g, ' ')],
  ];
}

/**
 * Converts a plan to DXF.
 *
 * Takes both the document and its flattened scene: the document knows where
 * each shape sits and how it is turned, the scene knows what it looks like.
 */
export function toDxf(doc: RVDocument, scene: Scene, options: DxfOptions = {}): DxfResult {
  const visible = options.visible;
  const isVisible = (p: ScenePrimitive): boolean => !visible || visible.has(p.layer);
  const elevLookup = (key: string): number => {
    if (!options.elevations) return 0;
    if (options.elevations instanceof Map) return options.elevations.get(key) ?? 0;
    return options.elevations[key] ?? 0;
  };

  // Geometry, grouped by the shape that owns it.
  const byShape = new Map<number, ScenePrimitive[]>();
  for (const primitive of scene.primitives) {
    if (!isVisible(primitive)) continue;
    const group = byShape.get(primitive.selectId);
    if (group) group.push(primitive);
    else byShape.set(primitive.selectId, [primitive]);
  }

  // Placed shapes that carry a catalogue name are the ones worth blocking.
  interface Placement {
    node: RVNode;
    name: string;
    x: number;
    y: number;
    angle: number;
  }
  const placements: Placement[] = [];
  for (const node of walk(doc)) {
    if (node.cls !== 'RVShape') continue;
    const name = shapeName(node);
    const at = node.points[0];
    if (!name || !at || !byShape.has(node.id)) continue;
    placements.push({ node, name, x: at.x, y: at.y, angle: node.angle ?? 0 });
  }

  // One definition per distinct name, taken from the instance closest to
  // unrotated so the stored geometry reads the way the shape was drawn.
  const byName = new Map<string, Placement[]>();
  for (const placement of placements) {
    const list = byName.get(placement.name);
    if (list) list.push(placement);
    else byName.set(placement.name, [placement]);
  }

  const names = blockNames([...byName.keys()]);
  const definitions: Pair[] = [];
  const entities: Pair[] = [];
  let inserts = 0;
  let loose = 0;
  const consumed = new Set<number>();

  for (const [name, group] of byName) {
    const block = names.get(name)!;
    const reference = group.reduce((best, p) =>
      Math.abs(p.angle) < Math.abs(best.angle) ? p : best,
    );

    // Normalise the reference into the block's own coordinate space: move its
    // insertion point to the origin and undo its rotation, so every INSERT can
    // simply state its own angle.
    const cos = Math.cos(-reference.angle);
    const sin = Math.sin(-reference.angle);
    const body: Pair[] = [];
    for (const primitive of byShape.get(reference.node.id) ?? []) {
      const local: number[] = [];
      for (let i = 0; i < primitive.pts.length; i += 2) {
        const dx = primitive.pts[i] - reference.x;
        const dy = primitive.pts[i + 1] - reference.y;
        local.push(toInches(dx * cos - dy * sin), toInches(dx * sin + dy * cos));
      }
      if (primitive.text) {
        body.push(...textEntity(BLOCK_LAYER, local[0] ?? 0, local[1] ?? 0, 6, primitive.text));
      } else if (local.length >= 4) {
        body.push(...polylineEntity(BLOCK_LAYER, local, primitive.type === 'polygon'));
      }
    }
    if (body.length === 0) continue;

    definitions.push(
      [0, 'BLOCK'],
      [8, BLOCK_LAYER],
      [2, block],
      [70, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [3, block],
      ...body,
      [0, 'ENDBLK'],
      [8, BLOCK_LAYER],
    );

    for (const placement of group) {
      consumed.add(placement.node.id);
      const elev = elevLookup(instanceKey(placement.name, placement.x, placement.y));
      entities.push(
        [0, 'INSERT'],
        [8, BLOCK_LAYER],
        [2, block],
        [10, toInches(placement.x)],
        [20, toInches(placement.y)],
        [30, toInches(elev)],
        // Normalised: a shape turned twice round carries an angle of -630 in
        // the source, and not every importer reduces that before using it.
        [50, ((((placement.angle * 180) / Math.PI) % 360) + 360) % 360],
      );
      inserts++;
    }
  }

  // Everything not part of a repeated symbol — walls, dimensions, stray notes.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [selectId, group] of byShape) {
    if (consumed.has(selectId)) continue;
    for (const primitive of group) {
      const layer = LAYERS[primitive.layer].name;
      const pts: number[] = [];
      for (let i = 0; i < primitive.pts.length; i += 2) {
        const x = toInches(primitive.pts[i]);
        const y = toInches(primitive.pts[i + 1]);
        pts.push(x, y);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (primitive.text) {
        entities.push(...textEntity(layer, pts[0] ?? 0, pts[1] ?? 0, 6, primitive.text));
        loose++;
      } else if (pts.length >= 4) {
        entities.push(...polylineEntity(layer, pts, primitive.type === 'polygon'));
        loose++;
      }
    }
  }

  for (const placement of placements) {
    const x = toInches(placement.x);
    const y = toInches(placement.y);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  const layerTable: Pair[] = [];
  for (const { name, color } of Object.values(LAYERS)) {
    layerTable.push([0, 'LAYER'], [2, name], [70, 0], [62, color], [6, 'CONTINUOUS']);
  }

  const text = emit([
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1009'],
    // 1 = inches. Without this an importer has to guess, and a 200ft ballroom
    // arriving as 200 millimetres is the classic way this goes wrong.
    [9, '$INSUNITS'],
    [70, 1],
    [9, '$EXTMIN'],
    [10, minX],
    [20, minY],
    [9, '$EXTMAX'],
    [10, maxX],
    [20, maxY],
    [0, 'ENDSEC'],

    [0, 'SECTION'],
    [2, 'TABLES'],
    [0, 'TABLE'],
    [2, 'LAYER'],
    [70, Object.keys(LAYERS).length],
    ...layerTable,
    [0, 'ENDTAB'],
    [0, 'ENDSEC'],

    [0, 'SECTION'],
    [2, 'BLOCKS'],
    ...definitions,
    [0, 'ENDSEC'],

    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...entities,
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);

  return { text: `${text}\r\n`, blocks: names.size, inserts, loose };
}
