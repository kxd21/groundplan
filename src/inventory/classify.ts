/**
 * Working out what a piece of gear actually *is*.
 *
 * A rental list describes items the way a warehouse does — by brand, model and
 * pack quantity — while a floor plan describes them the way a room does, by
 * shape. "Panasonic PT-RZ21KU Laser Projector" and "20K Barco HDX-W20 FLEX"
 * are the same thing to a drawing: a projector.
 *
 * Matching those two vocabularies by hand is impractical on a list of several
 * hundred items, so this classifies a description into a category first, and
 * `match.ts` then picks the best drawn symbol for that category.
 *
 * Order matters throughout. The rules run most-specific first, because
 * "Barco 20K IEC to L-630 - 3'" is a cable that happens to name a projector,
 * and "Projector Lens" is a lens, not a projector.
 */

export type Category =
  | 'projector'
  | 'screen'
  | 'flat-panel'
  | 'camera'
  | 'moving-light'
  | 'par-light'
  | 'ellipsoidal'
  | 'light-batten'
  | 'light-tree'
  | 'lighting-console'
  | 'speaker'
  | 'subwoofer'
  | 'mixer'
  | 'podium'
  | 'riser'
  | 'stairs'
  | 'truss'
  | 'truss-base'
  | 'drape'
  | 'drape-upright'
  | 'lift'
  | 'ladder'
  | 'table-round'
  | 'table-rect'
  | 'chair'
  | 'desk'
  | 'person'
  | 'door'
  | 'not-drawn';

/**
 * Which drawing of an object a catalogue entry is.
 *
 * Room Viewer ships every object several times over: `Buffet Line 1`,
 * `Buffet Line 1 (FV)` and `Buffet Line 1 (SV)` are one table drawn from above,
 * from the front and from the side. Only the plan drawing belongs in a
 * top-down plan; the elevations are for a front or side view of the room.
 *
 * They were indistinguishable before, so every picker listed each object three
 * or four times and a side-view table could be dropped into a plan — which is
 * exactly what it looks like, a table lying on its face.
 */
export type ItemView = 'plan' | 'front' | 'side' | 'rear' | 'front-side';

export interface Classification {
  category: Category;
  /** Why it landed here — shown in the UI so a wrong call is obvious. */
  reason: string;
  /** Size parsed out of the description, in logical units, when present. */
  width?: number;
  height?: number;
  /** Which drawing this is. `plan` unless the name says otherwise. */
  view: ItemView;
  /** The name with any view suffix removed — what the object actually is. */
  baseName: string;
}

/**
 * Splits `Buffet Line 1 (FV)` into the object and the drawing.
 *
 * The suffix is always parenthesised and always last. `(R)` is Room Viewer's
 * older spelling of a rear view, and `(FV-SV)` marks one drawing that serves as
 * both elevations.
 */
export function splitView(description: string): { baseName: string; view: ItemView } {
  const match = /^(.*?)\s*\((FV-SV|FV|SV|RV|R)\)\s*$/i.exec(description.trim());
  if (!match) return { baseName: description.trim(), view: 'plan' };
  const tag = match[2]!.toUpperCase();
  const view: ItemView =
    tag === 'FV' ? 'front' : tag === 'SV' ? 'side' : tag === 'FV-SV' ? 'front-side' : 'rear';
  return { baseName: match[1]!.trim() || description.trim(), view };
}

const UNITS_PER_FOOT = 120;
const UNITS_PER_INCH = 10;

/**
 * Things that never appear on a floor plan.
 *
 * This runs first and is deliberately broad. A gear list is mostly cable,
 * hardware and the parts that make up a package; drawing them would bury the
 * dozen items that actually occupy floor space.
 */
const NOT_DRAWN: Array<[RegExp, string]> = [
  [/\b(cable|cabling|jumper|xlr|sdi|hdmi|dvi|vga|cat\s*-?\s*6|cat6|cat5|dmx|soca|socapex|edison|feeder|opticore|fiber|fibre|snake|loom|breakout|whip|powercon|l6-20|l-630|iec|stinger)\b/i, 'cable or connector'],
  [/\b(adapter|adaptor|converter|dongle|barrel|coupler|connector|gender)\b/i, 'adapter'],
  [/\b(batter(y|ies)|charger|power supply|power conditioner|ups)\b/i, 'power accessory'],
  [/\b(shackle|clamp|clip|bolt|screw|pin|nut|washer|turnbuckle|ratchet|span\s*set|spanset|chain|rope|sling|safet(y|ies)|hardware|bracket|omega|mega claw|crescent wrench|wrench|key\b)/i, 'rigging hardware'],
  [/\b(sock|socks|cover|slip cover|skirt|sleeve|cap|topper|insert|valence|grommet|velcro|gaff|tape|marley)\b/i, 'soft goods or trim'],
  [/\b(case|bag|hamper|crate|trunk|road box|flight case)\b/i, 'transport'],
  [/\b(cleaner|cloth|microfiber|gel|gobo|diffusion|filter|lens\b|barn ?door|shutter|holder|frame clamp|lamp\b|bulb|globe)\b/i, 'consumable or optic'],
  [/\b(licen[cs]e|software|subscription|labo?u?r|technician fee|per ft\.?|per foot|freight|delivery|fuel|misc\b)/i, 'service or fee'],
  [/\b(ssd|hard drive|thumb drive|usb|switch|router|receiver|transmitter|beltpack|handheld|lavalier|lav\b|microphone|mic\b|antenna|paddle|wireless)\b/i, 'rack or handheld electronics'],
  [/\b(remote|controller|keyboard|mouse|ipad|laptop|pc\b|monitor arm|mount|mounting)\b/i, 'control or accessory'],
  // Package sub-components: a screen kit's frame parts are not separate objects.
  [/\b(frame (top|bottom|brace|stage (left|right))|leg stage (left|right)|side panel|front panel|countertop|desktop|deck key|crank)\b/i, 'part of a package'],
  [/\b(timer|signal light|plug-?in light|cue light|di\b|direct box|windscreen|gooseneck|boom|tripod|pod\b)\b/i, 'small accessory'],
  [/^please\b|^send\b|^will use\b/i, 'a note, not an item'],
];

/**
 * Brand and model knowledge.
 *
 * Names that carry no clue in the words themselves. Verified against the
 * manufacturers' own listings rather than guessed from context.
 */
const MODELS: Array<[RegExp, Category, string]> = [
  // Projectors — large-venue families.
  [/\b(barco)\b.*\b(hdx|udx|udm|uhd|flex|lc\b)/i, 'projector', 'Barco large-venue projector'],
  [/\b(panasonic)\b.*\bpt-\w+/i, 'projector', 'Panasonic PT-series projector'],
  [/\b(christie|epson|sanyo|nec)\b.*\b(projector|laser|dlp|lcd)\b/i, 'projector', 'projector'],
  [/\b(dlp|lcd|xenon|laser)\s*projector\b/i, 'projector', 'projector'],

  // Moving lights.
  [/\b(sola ?spot|sola ?frame|sola ?wash|sola ?pix)\b/i, 'moving-light', 'High End Systems SolaFrame/SolaSpot moving head'],
  [/\b(impression\s*x4|glp\b.*impression)\b/i, 'moving-light', 'GLP impression X4 moving head wash'],
  [/\bmac\s*(101|301|500|600|700|2000|aura|encore|viper)\b/i, 'moving-light', 'Martin MAC moving head'],
  [/\b(mythos|sharpy|maverick|rogue|hydrasync|pointe|spiider|megapointe)\b/i, 'moving-light', 'moving head'],
  [/\bmoving (head|light|wash|spot)\b/i, 'moving-light', 'moving head'],

  // Conventional and LED wash.
  [/\b(source ?four|source ?4|s4\b|leko|ellipsoidal|lustr)\b/i, 'ellipsoidal', 'Source Four / Leko ellipsoidal'],
  [/\b(freedom flex|uplight|up-light|par ?can|parcan|par ?64|par ?38|slimpar|colorado|led par)\b/i, 'par-light', 'uplight / PAR'],
  [/\b(colordash|batten|strip ?light|cyc ?light|border ?light|linear wash)\b/i, 'light-batten', 'linear batten wash'],
  [/\blight (tree|stand|tower)\b/i, 'light-tree', 'lighting tree'],
  [/\b(grand ?ma|hog\b|ion\b|eos\b|element\b|lighting (console|control|desk))\b/i, 'lighting-console', 'lighting console'],

  // Audio. Decided before video: a "PA/Monitor Speaker" is a speaker, and the
  // word "monitor" would otherwise claim it for the flat-panel rule.
  [/\b(sub ?woofer|subwoofer)\b/i, 'subwoofer', 'subwoofer'],
  [/\b(speaker|loudspeaker|line ?array|monitor wedge|wedge|pa\b)\b/i, 'speaker', 'speaker'],
  [/\b(mixer|mixing (console|desk)|foh console|audio console)\b/i, 'mixer', 'mixing console'],

  // Video.
  [/\bcamera\b.*\b(riser|platform)\b/i, 'riser', 'camera riser'],
  [/\b(marshall|blackmagic|sony|panasonic|canon)\b.*\bcamera\b/i, 'camera', 'camera'],
  [/\bcamera\b/i, 'camera', 'camera'],
  [/\b(plasma|lcd|led|oled|qled)?\s*\b(tv|television|flat ?panel|display|monitor)\b/i, 'flat-panel', 'flat panel display'],

  // Structure and staging.
  [/\bbox truss\b|\btruss\b.*\b\d+\s*['"]|circle truss|triangle truss|global truss/i, 'truss', 'truss'],
  [/\btruss (base|base plate)\b|\bbase plate\b/i, 'truss-base', 'truss base plate'],
  [/\b(stage deck|stage riser|riser|platform|staging)\b/i, 'riser', 'stage deck / riser'],
  [/\b(stairs?|steps?|tread)\b/i, 'stairs', 'stairs'],
  [/\b(genie|eventer|stage lift|personnel lift|scissor lift|lift\b)\b/i, 'lift', 'lift'],
  [/\bladder\b/i, 'ladder', 'ladder'],
  // Venue openings — not barn doors (those are optics, caught above as not-drawn).
  [/\bdoors?\b|\bopening\b/i, 'door', 'door / opening'],

  // Drape.
  [/\b(velour|drape|drapery|masking|backdrop)\b/i, 'drape', 'drape'],
  [/\b(upright|crossbar|schedule 40 pipe|pipe\b.*\b\d+\s*'|telescoping)\b/i, 'drape-upright', 'drape upright or crossbar'],

  // Screens.
  [/\b(projection screen|screen kit|fastfold|fast-fold|rear projection|front projection|projection surface)\b/i, 'screen', 'projection screen'],

  /*
   * Furniture.
   *
   * Two thirds of a stock Room Viewer catalogue used to land in `not-drawn`,
   * and most of it was furniture — 111 rows of buffet line alone, plus every
   * serpentine, square, half round and bare `3' x 3'`. An uncategorised item
   * cannot be offered in the table picker, cannot be grouped in a palette, and
   * cannot be filtered out of one; it just swells a flat list of 828 names.
   * These patterns are what the stock catalogue actually calls things.
   */
  [/\b(buffet|serving)\s*(line|table)?\b/i, 'table-rect', 'buffet line'],
  [/\bserpentine\b/i, 'table-round', 'serpentine table'],
  [/\b(half|quarter)\s*round\b/i, 'table-round', 'part-round table'],
  [/\bsquare\s*\d/i, 'table-rect', 'square table'],
  [/\bfamily\s*\d+\s*['’]?\s*x/i, 'table-rect', 'family-style table'],
  [/\b(plate|platter)\s*\d+/i, 'table-round', 'platter'],
  [/\bcradle\s*\d/i, 'table-rect', 'cradle'],
  [/\bstacked\s+chairs?\b/i, 'chair', 'stacked chairs'],
  // `18"x18"`, `18" x 18" - No Detail` — the stock chair, named by its footprint.
  [/^\s*\d+\s*["”]?\s*x\s*\d+\s*["”]/i, 'chair', 'chair, named by its size'],
  [/\b(piano|spinet)\b/i, 'desk', 'piano'],
  [/\b(whiteboard|flip\s*chart|flipchart|easel)\b/i, 'desk', 'presentation board'],
  [/\bbooth\s*\d/i, 'table-rect', 'trade-show booth'],
  [/\bscaffold\b/i, 'riser', 'scaffold'],
  [/\bcart\b/i, 'table-rect', 'cart'],
  [/\b(plasma|led\s*tv|lcd\s*tv)\b/i, 'flat-panel', 'flat panel'],
  [/\bbar\s*mat\b/i, 'table-rect', 'bar mat'],

  [/\b(podium|lectern|acrylic podium)\b/i, 'podium', 'podium / lectern'],
  [/\b(registration desk|desk\b|counter\b)\b/i, 'desk', 'desk'],
  // Chairs before any "banquet …" table catch-all — "Banquet Chair" is a chair.
  [/\bchiavari\b/i, 'chair', 'chiavari chair'],
  [/\b(bar\s*stool|barstool)\b/i, 'chair', 'barstool'],
  [/\bchairs?\b|\bseat\b|\bstool\b/i, 'chair', 'chair'],
  [/\bround\s*\d+/i, 'table-round', 'round table'],
  [/\b\d+\s*(?:["″]|in(?:ch(?:es)?)?)\s*round\b/i, 'table-round', 'round table'],
  [/\b(cocktail|highboy|hi-?top)\b/i, 'table-round', 'cocktail / highboy'],
  [/\bcircular\s+deck\b/i, 'riser', 'circular deck'],
  [/\b(6|8|10)\s*['’]?\s*x\s*(18|30|36|48)\s*["”]?/i, 'table-rect', 'banquet table'],
  [/\b(table|classroom|conference)\b/i, 'table-rect', 'table'],
  [/\bbanquet\b/i, 'table-rect', 'banquet table'],
  [/\b(technician|operator|staff|crew|labor position)\b/i, 'person', 'technician position'],
];

/** Pulls a footprint out of a description like `20.5" x 8'` or `6' x 10'8"`. */
export function parseSize(text: string): { width?: number; height?: number } {
  // Two dimensions separated by an x, each feet and/or inches.
  const match = text.match(
    /(\d+(?:\.\d+)?)\s*(['’]|ft|feet|["”]|in|")?\s*(?:(\d+(?:\.\d+)?)\s*["”])?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(['’]|ft|feet|["”]|in|")?\s*(?:(\d+(?:\.\d+)?)\s*["”])?/,
  );
  if (!match) return {};

  const toUnits = (value: string, unit: string | undefined, extraInches?: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const inches = unit === '"' || unit === '”' || unit === 'in';
    const base = inches ? n * UNITS_PER_INCH : n * UNITS_PER_FOOT;
    return base + (extraInches ? Number(extraInches) * UNITS_PER_INCH : 0);
  };

  const width = toUnits(match[1], match[2], match[3]);
  const height = toUnits(match[4], match[5], match[6]);
  if (width <= 0 || height <= 0) return {};
  // A "10 Port" switch or "2 M/E" switcher is not a footprint.
  if (width > 200 * UNITS_PER_FOOT || height > 200 * UNITS_PER_FOOT) return {};
  return { width, height };
}

/** Decides what a gear-list description is, for the purpose of drawing it. */
export function classify(description: string): Classification {
  const raw = description.replace(/\s+/g, ' ').trim();
  // Classify what the object IS, not which drawing of it this row holds. The
  // suffix used to defeat every pattern below, so `Podium/Lectern` was a podium
  // and `Podium/Lectern (SV)` was nothing at all.
  const { baseName, view } = splitView(raw);
  const text = baseName;
  const size = parseSize(text);
  const at = (category: Category, reason: string, extra: Partial<Classification> = {}) =>
    ({ category, reason, view, baseName, ...extra }) as Classification;

  for (const [pattern, reason] of NOT_DRAWN) {
    if (pattern.test(text)) return at('not-drawn', reason);
  }
  for (const [pattern, category, reason] of MODELS) {
    if (pattern.test(text)) return at(category, reason, size);
  }

  return at('not-drawn', 'nothing recognisable to draw');
}

/**
 * Which plan layer each category belongs on.
 *
 * Deliberately the same five families the Layers panel uses, so "what can I
 * switch off in the drawing" and "how is my inventory organised" are one idea
 * rather than two competing ones.
 */
export type CategoryLayer = 'walls' | 'furniture' | 'annotation' | 'region' | 'other';

export const CATEGORY_LAYER: Record<Category, CategoryLayer> = {
  truss: 'walls',
  'truss-base': 'walls',
  drape: 'walls',
  'drape-upright': 'walls',
  riser: 'walls',
  stairs: 'walls',
  lift: 'walls',
  ladder: 'walls',
  door: 'walls',

  projector: 'furniture',
  screen: 'furniture',
  'flat-panel': 'furniture',
  camera: 'furniture',
  'moving-light': 'furniture',
  'par-light': 'furniture',
  ellipsoidal: 'furniture',
  'light-batten': 'furniture',
  'light-tree': 'furniture',
  'lighting-console': 'furniture',
  speaker: 'furniture',
  subwoofer: 'furniture',
  mixer: 'furniture',
  podium: 'furniture',
  'table-round': 'furniture',
  'table-rect': 'furniture',
  chair: 'furniture',
  desk: 'furniture',

  person: 'region',
  'not-drawn': 'other',
};

/** Plain-language names, for the sidebar. */
export const CATEGORY_LABELS: Record<Category, string> = {
  projector: 'Projectors',
  screen: 'Screens',
  'flat-panel': 'Displays',
  camera: 'Cameras',
  'moving-light': 'Moving lights',
  'par-light': 'PAR & uplights',
  ellipsoidal: 'Lekos',
  'light-batten': 'Battens & strips',
  'light-tree': 'Light trees',
  'lighting-console': 'Lighting consoles',
  speaker: 'Speakers',
  subwoofer: 'Subwoofers',
  mixer: 'Mixers',
  podium: 'Podiums',
  riser: 'Risers & decks',
  stairs: 'Stairs',
  truss: 'Truss',
  'truss-base': 'Truss bases',
  drape: 'Drape',
  'drape-upright': 'Uprights & crossbars',
  lift: 'Lifts',
  ladder: 'Ladders',
  'table-round': 'Round tables',
  'table-rect': 'Banquet tables',
  chair: 'Chairs',
  desk: 'Desks & counters',
  person: 'Crew positions',
  door: 'Doors & openings',
  'not-drawn': 'Not drawn',
};

export const LAYER_LABELS: Record<CategoryLayer, string> = {
  walls: 'Structure & staging',
  furniture: 'Equipment & furniture',
  region: 'Crew & regions',
  annotation: 'Dimensions & labels',
  other: 'Not drawn',
};

/** Display order, matching the Layers panel. */
export const LAYER_ORDER: CategoryLayer[] = ['walls', 'furniture', 'region', 'annotation', 'other'];
