/**
 * Layers that mean something to the trade.
 *
 * The scene already sorts geometry into five buckets — walls, furniture,
 * annotation, region, other — worked out from the class of each object and what
 * contains it. That is the right default and it is not enough to hand a plan to
 * a lighting crew, because everything they care about is filed under
 * "furniture" along with the chairs.
 *
 * So a layer here is a named set the user controls, assigned per placement, on
 * top of the derived ones. Assignment is by the same stable key the schedule and
 * the definitions use, so a chair belongs to one thing and everything that has
 * an opinion about it agrees on which chair it is.
 *
 * Layers live entirely in the companion. The `.rv4` has no layer field, so a
 * hidden layer is still drawn when the plan is opened in Room Viewer — which is
 * why hiding is a view state and not a way to remove something from a drawing.
 */

import type { PlacedItem } from './definition.js';
import type { Layer as SceneLayer, ScenePrimitive } from './scene.js';

export interface LayerDefinition {
  id: string;
  name: string;
  visible: boolean;
  /** Locked layers cannot be selected or edited. */
  locked: boolean;
  /** Draw order, low first. */
  order: number;
  /** COLORREF for the layer's own colour, when it overrides the object's. */
  color?: number;
  /** Included when the plan is exported or printed. */
  printed: boolean;
}

/**
 * The technical systems an event plan is separated into.
 *
 * These are the sheets a production actually issues, which is why they are the
 * defaults rather than something generic like "Layer 1".
 */
export const DEFAULT_LAYERS: Array<Omit<LayerDefinition, 'id'> & { id: string; match?: RegExp }> = [
  { id: 'architecture', name: 'Architecture', visible: true, locked: true, order: 0, printed: true },
  { id: 'staging', name: 'Staging', visible: true, locked: false, order: 10, printed: true, match: /\b(stage|riser|deck|platform|stair)\b/i },
  { id: 'seating', name: 'Seating', visible: true, locked: false, order: 20, printed: true, match: /\b(chair|table|round|banquet|stool|bench)\b/i },
  { id: 'video', name: 'Video', visible: true, locked: false, order: 30, printed: true, match: /\b(screen|projector|led|monitor|tv|display|camera|ptz|dsm|confidence|switcher|video)\b/i },
  { id: 'lighting', name: 'Lighting', visible: true, locked: false, order: 40, printed: true, match: /\b(light|leko|par|fixture|wash|moving)\b/i },
  // Rigging is its own discipline and its own conversation: what flies, from
  // where, and how much it weighs. Truss and motors used to land on Lighting,
  // which is who hangs the fixtures but never who signs off the points.
  { id: 'rigging', name: 'Rigging', visible: true, locked: false, order: 45, printed: true, match: /\b(truss|motor|hoist|rigging|rig point|pick point|chain|span ?set|shackle)\b/i },
  { id: 'audio', name: 'Audio', visible: true, locked: false, order: 50, printed: true, match: /\b(speaker|subwoofer|sub|mic|console|line array|monitor wedge|foh|amp rack)\b/i },
  { id: 'power', name: 'Power & data', visible: true, locked: false, order: 55, printed: true, match: /\b(cable|feeder|distro|power|signal|dmx|soca|data|network|switch|ethernet)\b/i },
  { id: 'drape', name: 'Drape and scenic', visible: true, locked: false, order: 60, printed: true, match: /\b(drape|pipe|masking|scenic|backdrop)\b/i },
  { id: 'catering', name: 'Catering', visible: true, locked: false, order: 70, printed: true, match: /\b(buffet|bar|catering|service|beverage)\b/i },
  { id: 'annotation', name: 'Annotation', visible: true, locked: false, order: 100, printed: true },
];

/** A fresh set of layers with nothing assigned. */
export function defaultLayers(): LayerDefinition[] {
  return DEFAULT_LAYERS.map(({ match, ...layer }) => {
    void match;
    return { ...layer };
  });
}

/** Assignments of placements to layers, keyed by placement. */
export type LayerAssignment = Record<string, string>;

/**
 * Suggests a layer for a placement from its name.
 *
 * A suggestion, not a decision: it fills in a plan that has never been
 * organised, and any explicit assignment beats it.
 */
/**
 * Which layer wins when a name matches more than one.
 *
 * "Buffet Table" matches Catering on "buffet" and Seating on "table", and
 * testing in draw order handed it to Seating — so a buffet ended up counted as
 * furniture and missing from the catering plan. Draw order is about what paints
 * on top of what; it says nothing about which word in a name is the more
 * telling one.
 *
 * This is that second question, answered explicitly. The rule is specific
 * before generic: a name that says "buffet" is about catering whatever else it
 * also says, and Seating goes last because "table" and "round" are the words
 * most likely to appear in a name that is really about something else.
 */
const MATCH_PRECEDENCE: readonly string[] = [
  'catering',
  'rigging',
  'video',
  'audio',
  'lighting',
  'power',
  'drape',
  'staging',
  'seating',
];

export function suggestLayer(name: string): string {
  const byId = new Map(DEFAULT_LAYERS.map((layer) => [layer.id, layer]));
  for (const id of MATCH_PRECEDENCE) {
    if (byId.get(id)?.match?.test(name)) return id;
  }
  // Anything still unmatched in an event plan is furniture more often than it
  // is anything else. A guess, and labelled as one: the layer is editable.
  return 'seating';
}

/**
 * The production layer a drawn primitive belongs to.
 *
 * `suggestLayer` answers for a NAMED placement — a chair, a projector — and
 * falls back to seating, which is the right guess for an unrecognised piece of
 * furniture and the wrong one for a wall. Room geometry and annotation are not
 * named placements at all, so they are decided by what the file says they are
 * before the name is ever consulted.
 */
export function disciplineFor(
  primitiveLayer: 'walls' | 'furniture' | 'annotation' | 'region' | 'other',
  owner?: string,
): string {
  if (primitiveLayer === 'walls' || primitiveLayer === 'region') return 'architecture';
  if (primitiveLayer === 'annotation') return 'annotation';
  if (owner) return suggestLayer(owner);
  // Free geometry with no owner is scenery until somebody says otherwise: it is
  // drawn linework rather than equipment, and filing it under seating would put
  // the room's own detail in with the chairs.
  return 'drape';
}

/** Every layer id, in draw order. */
export const LAYER_IDS: readonly string[] = DEFAULT_LAYERS.map((layer) => layer.id);

/** The layer a placement belongs to, explicit assignment first. */
export function layerOf(item: PlacedItem, assignment: LayerAssignment): string {
  return assignment[item.key] ?? suggestLayer(item.name);
}

/** Groups placements by layer, in draw order. */
export function groupByLayer(
  items: PlacedItem[],
  layers: LayerDefinition[],
  assignment: LayerAssignment,
): Array<{ layer: LayerDefinition; items: PlacedItem[] }> {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const groups = new Map<string, PlacedItem[]>();

  for (const item of items) {
    const id = layerOf(item, assignment);
    const list = groups.get(id);
    if (list) list.push(item);
    else groups.set(id, [item]);
  }

  return [...groups]
    .map(([id, group]) => ({
      layer: byId.get(id) ?? { id, name: id, visible: true, locked: false, order: 999, printed: true },
      items: group,
    }))
    .sort((a, b) => a.layer.order - b.layer.order);
}

/**
 * Whether a scene primitive should be drawn.
 *
 * Derived layers and user layers are answered together, because the canvas has
 * one question to ask and should not care which kind it is dealing with.
 */
export function primitiveVisible(
  primitive: ScenePrimitive,
  layers: LayerDefinition[],
  assignment: LayerAssignment,
  sceneLayerVisible: Record<SceneLayer, boolean>,
  itemsByNode: Map<number, PlacedItem>,
): boolean {
  if (!sceneLayerVisible[primitive.layer]) return false;

  const item = itemsByNode.get(primitive.selectId);
  if (!item) return true;

  const id = layerOf(item, assignment);
  const layer = layers.find((l) => l.id === id);
  return layer ? layer.visible : true;
}

/** Whether a placement can be selected and edited. */
export function itemEditable(item: PlacedItem, layers: LayerDefinition[], assignment: LayerAssignment): boolean {
  const layer = layers.find((l) => l.id === layerOf(item, assignment));
  return layer ? !layer.locked : true;
}

/** Moves a layer up or down the draw order, keeping the order values tidy. */
export function reorderLayer(layers: LayerDefinition[], id: string, direction: -1 | 1): LayerDefinition[] {
  const sorted = [...layers].sort((a, b) => a.order - b.order);
  const at = sorted.findIndex((l) => l.id === id);
  if (at === -1) return layers;
  const to = at + direction;
  if (to < 0 || to >= sorted.length) return layers;

  [sorted[at], sorted[to]] = [sorted[to], sorted[at]];
  return sorted.map((layer, index) => ({ ...layer, order: index * 10 }));
}

/** The layers that go on a printed sheet, in order. */
export function printedLayers(layers: LayerDefinition[]): LayerDefinition[] {
  return layers.filter((l) => l.printed && l.visible).sort((a, b) => a.order - b.order);
}

export interface LegendEntry {
  layer: string;
  name: string;
  count: number;
  color?: number;
}

/**
 * The legend for a sheet: what is on it, by layer, with counts.
 *
 * Built from the drawing rather than maintained beside it, which is the whole
 * argument for the plan being the database.
 */
export function buildLegend(
  items: PlacedItem[],
  layers: LayerDefinition[],
  assignment: LayerAssignment,
): LegendEntry[] {
  const out: LegendEntry[] = [];

  for (const { layer, items: group } of groupByLayer(items, layers, assignment)) {
    if (!layer.printed) continue;
    const counts = new Map<string, number>();
    for (const item of group) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      out.push({ layer: layer.name, name, count, color: layer.color });
    }
  }

  return out;
}

export interface TitleBlock {
  plan: string;
  venue?: string;
  client?: string;
  event?: string;
  date?: string;
  scale: string;
  drawnBy?: string;
  revision?: string;
  /** Room summary line: size, area, capacity. */
  summary?: string;
}

/** The fields a title block carries, with the ones the plan already knows filled. */
export function titleBlockFor(planName: string, scale: string, extra: Partial<TitleBlock> = {}): TitleBlock {
  return { plan: planName, scale, ...extra };
}

/** A weight and power total for one production layer. */
export interface LoadLine {
  layer: string;
  /** Items counted. Items with no figure are excluded and reported separately. */
  counted: number;
  /** Items on this layer with no weight or power figure on their definition. */
  unknown: number;
  weightLb: number;
  powerW: number;
}

export interface LoadSummary {
  lines: LoadLine[];
  totalWeightLb: number;
  totalPowerW: number;
  /** Items across the whole plan carrying no figure at all. */
  unknown: number;
  /**
   * Amps at 120V, single phase, for the whole plan.
   *
   * A distro conversation happens in amps, not watts, and 120V single phase is
   * what a US corporate ballroom runs unless somebody says otherwise. This is a
   * planning figure for sizing a service, not a substitute for an electrician:
   * it is a straight sum with no derating, no power factor and no allowance for
   * inrush.
   */
  ampsAt120V: number;
}

/**
 * What the plan weighs and what it draws, by layer.
 *
 * `weightLb` and `powerW` have been on every item definition since the
 * catalogue was written, and nothing has ever read them. A TD sizing rigging
 * points and an electrician sizing a distro have both been rebuilding these
 * numbers in a spreadsheet from a drawing that already held them.
 *
 * Items with no figure are counted separately rather than treated as zero. A
 * total that quietly assumes the unknowns weigh nothing is worse than no total,
 * because it looks like an answer.
 */
export function summariseLoad(
  items: PlacedItem[],
  layers: LayerDefinition[],
  assignment: LayerAssignment,
): LoadSummary {
  const lines: LoadLine[] = [];
  let totalWeightLb = 0;
  let totalPowerW = 0;
  let unknown = 0;

  for (const { layer, items: group } of groupByLayer(items, layers, assignment)) {
    let weightLb = 0;
    let powerW = 0;
    let counted = 0;
    let missing = 0;

    for (const item of group) {
      const w = item.spec.weightLb;
      const p = item.spec.powerW;
      if (w == null && p == null) {
        missing++;
        continue;
      }
      counted++;
      weightLb += w ?? 0;
      powerW += p ?? 0;
    }

    if (!counted && !missing) continue;
    lines.push({ layer: layer.name, counted, unknown: missing, weightLb, powerW });
    totalWeightLb += weightLb;
    totalPowerW += powerW;
    unknown += missing;
  }

  return {
    lines,
    totalWeightLb,
    totalPowerW,
    unknown,
    ampsAt120V: totalPowerW / 120,
  };
}
