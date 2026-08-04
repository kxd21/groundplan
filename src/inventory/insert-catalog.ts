/**
 * Hierarchical Insert catalog — browse path for screens, projectors, risers, etc.
 *
 * Rows are keyword seeds against the open inventory / opened `.stk` / `.add` /
 * `.lib` libraries. Placement still goes through inventoryPlace / gear stamp;
 * this module only decides what to offer and how to search for it.
 */

export type InsertGroupId =
  | 'tables'
  | 'chairs'
  | 'staging'
  | 'screens'
  | 'projectors'
  | 'av'
  | 'drape'
  | 'misc';

export interface InsertLeaf {
  id: string;
  label: string;
  /** Inventory search terms tried in order until a match is found. */
  keywords: string[];
  /** Prefer inventory items whose category matches. */
  categories?: string[];
  /**
   * Name used when no inventory match exists — must parse to a footprint
   * (`6' x 8' Riser`, `Circular Deck 8'`, `Curved Riser 4' x 4'`).
   */
  stockName?: string;
}

export interface InsertBranch {
  id: string;
  label: string;
  children: Array<InsertBranch | InsertLeaf>;
}

export interface PaletteCategory {
  id: InsertGroupId;
  label: string;
  short: string;
  keywords: string[];
  categories: string[];
}

export const PALETTE_CATEGORIES: PaletteCategory[] = [
  {
    id: 'tables',
    label: 'Tables',
    short: 'Tbl',
    keywords: ['table', 'banquet', 'round', 'rect'],
    categories: ['table-round', 'table-rect', 'desk'],
  },
  {
    id: 'chairs',
    label: 'Chairs',
    short: 'Chr',
    keywords: ['chair', 'seat'],
    categories: ['chair'],
  },
  {
    id: 'staging',
    label: 'Staging',
    short: 'Stg',
    keywords: ['riser', 'stage', 'deck', 'stairs'],
    categories: ['riser', 'stairs'],
  },
  {
    id: 'screens',
    label: 'Screens',
    short: 'Scr',
    keywords: ['screen', 'fastfold', 'tripod'],
    categories: ['screen', 'flat-panel'],
  },
  {
    id: 'projectors',
    label: 'Projectors',
    short: 'Prj',
    keywords: ['projector'],
    categories: ['projector'],
  },
  {
    id: 'av',
    label: 'A/V',
    short: 'A/V',
    keywords: ['speaker', 'mixer', 'truss', 'light', 'scaffold', 'camera'],
    categories: [
      'speaker',
      'subwoofer',
      'mixer',
      'truss',
      'truss-base',
      'moving-light',
      'par-light',
      'ellipsoidal',
      'light-batten',
      'light-tree',
      'camera',
      'podium',
    ],
  },
  {
    id: 'drape',
    label: 'Drape',
    short: 'Drp',
    keywords: ['drape', 'pipe and drape'],
    categories: ['drape', 'drape-upright'],
  },
  {
    id: 'misc',
    label: 'Venue',
    short: 'Ven',
    keywords: ['door', 'technician', 'ada', 'wheelchair', 'lectern', 'podium', 'plant'],
    categories: ['podium', 'person', 'lift', 'ladder', 'not-drawn'],
  },
];

function leaf(
  id: string,
  label: string,
  keywords: string[],
  categories?: string[],
  stockName?: string,
): InsertLeaf {
  return { id, label, keywords, categories, stockName };
}

/** Classic Room Viewer Insert hierarchy, seeded from inventory match keywords. */
export const INSERT_TREE: InsertBranch[] = [
  {
    id: 'screens',
    label: 'Screens',
    children: [
      {
        id: 'fastfold',
        label: 'Fastfold',
        children: [
          leaf('ff-6', '6′ Fastfold', ['6\' Fastfold', '6 ft Fastfold', 'Fastfold 6'], ['screen']),
          leaf('ff-7', '7′6″ Fastfold', ['7\'6 Fastfold', '7.5 Fastfold', 'Fastfold 7'], ['screen']),
          leaf('ff-8', '8′ Fastfold', ['8\' Fastfold', '8 ft Fastfold', 'Fastfold 8'], ['screen']),
          leaf('ff-9', '9′ Fastfold', ['9\' Fastfold', 'Fastfold 9'], ['screen']),
          leaf('ff-10', '10′ Fastfold', ['10\' Fastfold', 'Fastfold 10'], ['screen']),
          leaf('ff-12', '12′ Fastfold', ['12\' Fastfold', 'Fastfold 12'], ['screen']),
          leaf('ff-dress', 'Fastfold w/ Dress', ['Fastfold Dress', 'Fastfold w/ Dress', 'dressed Fastfold'], [
            'screen',
          ]),
        ],
      },
      leaf('tripod', 'Tripod screen', ['Tripod Screen', 'tripod'], ['screen'], "6' Tripod Screen"),
      leaf('cradle', 'Cradle screen', ['Cradle Screen', 'cradle'], ['screen'], "8' Cradle Screen"),
      leaf('flat', 'Flat panel', ['Flat Panel', 'TV', 'monitor'], ['flat-panel'], "4' x 2' Flat Panel"),
    ],
  },
  {
    id: 'projectors',
    label: 'Projectors',
    children: [
      leaf('proj-any', 'Projector', ['LCD Projector', 'Projector'], ['projector'], "2' x 1' Projector"),
      leaf('proj-barco', 'Barco LC', ['Barco LC', 'Barco'], ['projector'], "2' x 4' Barco LC"),
      leaf('proj-sanyo', 'Sanyo 9000', ['Sanyo 9000', 'Sanyo'], ['projector'], "1' x 2' Sanyo 9000"),
      leaf('proj-combo', 'Screen + Projector', ['Screen Projector', 'Fastfold', 'Projector'], ['screen', 'projector']),
    ],
  },
  {
    id: 'av-more',
    label: 'Additional A/V',
    children: [
      {
        id: 'audio',
        label: 'Audio',
        children: [
          leaf('speaker', 'Speaker', ['Speaker', 'loudspeaker'], ['speaker'], "2' x 2' Speaker"),
          leaf('sub', 'Subwoofer', ['Subwoofer', 'sub'], ['subwoofer'], "2' x 2' Subwoofer"),
          leaf('mixer', 'Mixer', ['Mixer'], ['mixer'], "3' x 2' 6\" Mixer"),
        ],
      },
      {
        id: 'front-av',
        label: 'Front',
        children: [
          leaf('podium', 'Podium / lectern', ['Podium/Lectern', 'Podium', 'Lectern'], ['podium'], "3' x 3' Podium"),
        ],
      },
      {
        id: 'rear-av',
        label: 'Rear',
        children: [
          leaf('camera', 'Video camera', ['Video Camera', 'Camera'], ['camera'], "2' 6\" x 2' 6\" Video Camera"),
        ],
      },
      {
        id: 'side-av',
        label: 'Side',
        children: [leaf('side-fill', 'Side fill', ['Side fill', 'Speaker'], ['speaker'])],
      },
      {
        id: 'lighting',
        label: 'Lighting',
        children: [
          leaf('par', 'Source 4 PAR', ['Source 4 Par', 'S4 Par', 'PAR'], ['par-light', 'ellipsoidal'], "1' x 1' 6\" Source 4 Par"),
          leaf('ellipsoid', 'Leko / ellipsoidal', ['Leko Light', 'Leko', 'Ellipsoidal', 'S4 Leko'], ['ellipsoidal'], "1' 8\" x 2' 5\" Leko Light"),
          leaf('moving', 'Mac 600', ['Mac 600', 'MAC 600', 'Moving Light'], ['moving-light'], "1' 9\" x 1' 9\" Mac 600"),
          leaf('console', 'Lighting control', ['Lighting Control', 'lighting console'], ['lighting-console'], "2' 10\" x 1' 9\" Lighting Control"),
          leaf('batten', 'Light batten', ['Batten', 'Light Bar', 'Leko Bar'], ['light-batten']),
        ],
      },
      {
        id: 'truss',
        label: 'Truss',
        children: [
          leaf('truss-10', "Triangle truss 10′", ['Triangle Truss 10\'', 'Triangle Truss'], ['truss'], "10' x 1' Triangle Truss"),
          leaf('truss-5', "Triangle truss 5′", ['Triangle Truss 5\'', 'Triangle Truss'], ['truss'], "5' x 1' Triangle Truss"),
          leaf('truss-sec', 'Box truss', ['Box Truss', 'Truss'], ['truss'], "10' x 1' Truss"),
          leaf('truss-base', 'Truss base', ['Truss Base', 'base plate'], ['truss-base'], "2' x 2' Truss Base"),
        ],
      },
      leaf('lift', 'Genie lift', ['Genie Lift', 'Genie', 'Lift'], ['lift'], "4' x 7' Genie Lift"),
      leaf('scaffold', 'Scaffolding', ['Scaffold', 'Scaffolding'], ['ladder'], "4' x 4' Scaffold"),
      leaf(
        'flat-plasma',
        'Plasma / flat panel',
        ['Plasma - 50"', 'Plasma', 'Flat Panel', '50"'],
        ['flat-panel'],
        "4' x 2' 4\" Plasma 50\"",
      ),
      leaf('video', 'Video', ['Switcher', 'Camera', 'Recorder'], ['camera', 'flat-panel']),
    ],
  },
  {
    id: 'risers',
    label: 'Risers',
    children: [
      leaf('riser-4x8', '4′ × 8′ riser', ["Riser 4'x8'", "4' x 8' Riser", '4x8 Riser'], ['riser'], "4' x 8' Riser"),
      leaf('riser-6x8', '6′ × 8′ riser', ["Riser 6'x8'", "6' x 8' Riser", '6x8 Riser'], ['riser'], "6' x 8' Riser"),
      leaf('riser-8x4', '8′ × 4′ riser', ["Riser 8'x4'", "8' x 4' Riser"], ['riser'], "8' x 4' Riser"),
      leaf('riser-8x6', '8′ × 6′ riser', ["Riser 8'x6'", "8' x 6' Riser"], ['riser'], "8' x 6' Riser"),
      leaf('riser-4x4', '4′ × 4′ deck', ["Riser 4'x4'", "4' x 4' Riser", 'LEMG'], ['riser'], "4' x 4' Riser"),
      leaf(
        'riser-curved-4x4',
        'Curved 4′ × 4′ deck',
        ['Curved Riser', 'LEMG Curved', 'Curved 4x4'],
        ['riser'],
        "Curved Riser 4' x 4'",
      ),
      leaf(
        'riser-circ',
        'Circular deck 8′',
        ['Circular Deck', 'Round Riser', 'circle stage'],
        ['riser'],
        "Circular Deck 8'",
      ),
      leaf('stairs-4', 'Steps / stair unit', ['Steps', 'Stairs', 'Stair Unit'], ['stairs'], "3' x 3' Steps"),
    ],
  },
  {
    id: 'tables',
    label: 'Tables',
    children: [
      leaf('round-60', '60″ round', ['60 Round', '60" Round', 'Banquet 60'], ['table-round'], '60" Round'),
      leaf('round-72', '72″ round', ['72 Round', '72" Round'], ['table-round'], '72" Round'),
      leaf('round-8', '8′ round', ["8' Circle", '8ft Round'], ['table-round'], "8' Circle"),
      leaf('rect-6', '6′ banquet', ["6' Table", '6 ft Banquet', 'Rectangular Table'], ['table-rect'], "6' x 30\" Table"),
      leaf('rect-6-30', '6′ × 30″', ["6' x 30\"", "6' x 30"], ['table-rect'], "6' x 30\" Table"),
      leaf('rect-8', '8′ banquet', ["8' Table", '8 ft Banquet'], ['table-rect'], "8' x 30\" Table"),
      leaf('rect-8-30', '8′ × 30″', ["8' x 30\"", "8' x 30"], ['table-rect'], "8' x 30\" Table"),
      leaf('rect-6-18', '6′ × 18″', ["6' x 18\"", "6' x 18"], ['table-rect'], "6' x 18\" Table"),
      leaf('rect-8-18', '8′ × 18″', ["8' x 18\"", "8' x 18"], ['table-rect'], "8' x 18\" Table"),
    ],
  },
  {
    id: 'chairs',
    label: 'Chairs',
    children: [
      leaf(
        'banquet-chair',
        'Banquet chair',
        ['Chair 20.5W X 23.23D', 'Banquet Chair', 'Chair'],
        ['chair'],
        '20.5" x 23.23" Chair',
      ),
      leaf('stack-chair', 'Stack chair', ['Stack Chair'], ['chair'], '20" x 20" Chair'),
    ],
  },
  {
    id: 'drape',
    label: 'Drape',
    children: [
      leaf(
        'drape-panel',
        'Pipe and drape',
        ['Pipe and Drape', 'Drape Panel', 'Drape'],
        ['drape'],
        "10' x 8' Pipe and Drape",
      ),
      leaf('drape-upright', 'Drape upright', ['Drape Upright', 'Upright'], ['drape-upright'], "1' x 1' Drape Upright"),
    ],
  },
  {
    id: 'venue',
    label: 'Venue',
    children: [
      leaf(
        'door-double',
        'Door — double',
        ['Door - Double (Out)', 'Door - Double', 'Double Door'],
        ['not-drawn'],
        "6' x 6' Door Double",
      ),
      leaf(
        'door-single-in-l',
        'Door — single in (L)',
        ['Door - Single (In) Left Swing', 'Door - Single'],
        ['not-drawn'],
        "3' x 3' Door Single",
      ),
      leaf(
        'door-single-in-r',
        'Door — single in (R)',
        ['Door - Single (In) Right Swing', 'Door - Single'],
        ['not-drawn'],
        "3' x 3' Door Single",
      ),
      leaf(
        'door-single-out-r',
        'Door — single out (R)',
        ['Door - Single (Out) Right Swing', 'Door - Single'],
        ['not-drawn'],
        "3' x 3' Door Single",
      ),
      leaf('tech', 'Technician', ['Technician'], ['person'], "2' 6\" x 2' 4\" Technician"),
      leaf('lectern', 'Lectern / podium', ['Podium/Lectern', 'Lectern', 'Podium'], ['podium'], "3' x 3' Podium"),
      leaf('ada', 'ADA access', ['ADA', 'Wheelchair', 'Ramp'], ['person'], "3' x 3' ADA Access"),
      leaf('plant', 'Plant', ['Plant', 'Potted'], ['not-drawn'], "2' x 2' Plant"),
    ],
  },
];

export function isInsertLeaf(node: InsertBranch | InsertLeaf): node is InsertLeaf {
  return 'keywords' in node;
}

export function flattenInsertLeaves(nodes: Array<InsertBranch | InsertLeaf> = INSERT_TREE): InsertLeaf[] {
  const out: InsertLeaf[] = [];
  const walk = (list: Array<InsertBranch | InsertLeaf>) => {
    for (const node of list) {
      if (isInsertLeaf(node)) out.push(node);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Picks the best inventory row for a leaf: prefer category match, then
 * keyword substring on the name (case-insensitive).
 */
export function matchInsertItem<T extends { id: string; name: string; category?: string | null }>(
  leaf: InsertLeaf,
  items: T[],
): T | null {
  if (!items.length) return null;
  const lowered = leaf.keywords.map((k) => k.toLowerCase());
  const scored = items
    .map((item) => {
      const name = item.name.toLowerCase();
      let keywordScore = 0;
      for (const key of lowered) {
        if (key.length < 3) {
          // Short tokens (PAR, TV, sub) need a word boundary so "adapter" does not win.
          const re = new RegExp(`(?:^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
          if (re.test(name)) keywordScore += 6;
          continue;
        }
        if (name === key) keywordScore += 20;
        else if (name.includes(key)) keywordScore += 5 + Math.min(key.length, 16);
      }
      // Category alone must not steal a stock fallback (e.g. "Barco" → random projector).
      if (keywordScore <= 0) {
        if (leaf.stockName) return { item, score: 0 };
        if (leaf.categories?.length && item.category && leaf.categories.includes(item.category)) {
          return { item, score: 4 };
        }
        return { item, score: 0 };
      }
      let score = keywordScore;
      if (leaf.categories?.length && item.category && leaf.categories.includes(item.category)) {
        score += 8;
      }
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return scored[0]?.item ?? null;
}

/** How many Insert leaves have at least one inventory match (for tests). */
export function insertCatalogCoverage(
  items: Array<{ id: string; name: string; category?: string | null }>,
): { total: number; matched: number; missing: string[] } {
  const leaves = flattenInsertLeaves();
  const missing: string[] = [];
  let matched = 0;
  for (const leaf of leaves) {
    if (matchInsertItem(leaf, items)) matched++;
    else missing.push(leaf.id);
  }
  return { total: leaves.length, matched, missing };
}
