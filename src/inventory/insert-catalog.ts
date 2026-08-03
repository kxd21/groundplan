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
    label: 'Misc / ADA',
    short: 'Misc',
    keywords: ['ada', 'wheelchair', 'lectern', 'podium', 'plant'],
    categories: ['podium', 'person', 'lift', 'ladder'],
  },
];

function leaf(id: string, label: string, keywords: string[], categories?: string[]): InsertLeaf {
  return { id, label, keywords, categories };
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
      leaf('tripod', 'Tripod screen', ['Tripod Screen', 'tripod'], ['screen']),
      leaf('cradle', 'Cradle screen', ['Cradle Screen', 'cradle'], ['screen']),
      leaf('flat', 'Flat panel', ['Flat Panel', 'TV', 'monitor'], ['flat-panel']),
    ],
  },
  {
    id: 'projectors',
    label: 'Projectors',
    children: [
      leaf('proj-any', 'Projector', ['Projector'], ['projector']),
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
          leaf('speaker', 'Speaker', ['Speaker', 'loudspeaker'], ['speaker']),
          leaf('sub', 'Subwoofer', ['Subwoofer', 'sub'], ['subwoofer']),
          leaf('mixer', 'Mixer', ['Mixer', 'console'], ['mixer']),
        ],
      },
      {
        id: 'front-av',
        label: 'Front',
        children: [leaf('podium', 'Podium / lectern', ['Podium', 'Lectern'], ['podium'])],
      },
      {
        id: 'rear-av',
        label: 'Rear',
        children: [leaf('camera', 'Camera', ['Camera'], ['camera'])],
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
          leaf('par', 'PAR', ['PAR'], ['par-light']),
          leaf('ellipsoid', 'Ellipsoidal', ['Ellipsoidal', 'Leko'], ['ellipsoidal']),
          leaf('moving', 'Moving light', ['Moving Light', 'spot'], ['moving-light']),
          leaf('batten', 'Light batten', ['Batten', 'Light Bar'], ['light-batten']),
        ],
      },
      {
        id: 'truss',
        label: 'Truss',
        children: [
          leaf('truss-sec', 'Truss section', ['Truss'], ['truss']),
          leaf('truss-base', 'Truss base', ['Truss Base', 'base plate'], ['truss-base']),
        ],
      },
      leaf('scaffold', 'Scaffolding', ['Scaffold', 'Scaffolding'], ['lift', 'ladder']),
      leaf('video', 'Video', ['Switcher', 'Camera', 'Recorder'], ['camera', 'flat-panel']),
    ],
  },
  {
    id: 'risers',
    label: 'Risers',
    children: [
      leaf('riser-4x8', '4′ × 8′ riser', ['4x8 Riser', '4\' x 8\' Riser', '4x8 Stage'], ['riser']),
      leaf('riser-6x8', '6′ × 8′ riser', ['6x8 Riser', '6\' x 8\' Riser'], ['riser']),
      leaf('riser-8x4', '8′ × 4′ riser', ['8x4 Riser', '8\' x 4\' Riser'], ['riser']),
      leaf('riser-8x6', '8′ × 6′ riser', ['8x6 Riser', '8\' x 6\' Riser'], ['riser']),
      leaf('riser-circ', 'Circular deck', ['Circular Deck', 'Round Riser', 'circle stage'], ['riser']),
    ],
  },
  {
    id: 'tables',
    label: 'Tables',
    children: [
      leaf('round-60', '60″ round', ['60 Round', '60" Round', 'Banquet 60'], ['table-round']),
      leaf('round-72', '72″ round', ['72 Round', '72" Round'], ['table-round']),
      leaf('rect-6', '6′ banquet', ['6\' Table', '6 ft Banquet', 'Rectangular Table'], ['table-rect']),
      leaf('rect-8', '8′ banquet', ['8\' Table', '8 ft Banquet'], ['table-rect']),
    ],
  },
  {
    id: 'chairs',
    label: 'Chairs',
    children: [
      leaf('banquet-chair', 'Banquet chair', ['Banquet Chair', 'Chair'], ['chair']),
      leaf('stack-chair', 'Stack chair', ['Stack Chair', 'Chair'], ['chair']),
    ],
  },
  {
    id: 'drape',
    label: 'Drape',
    children: [
      leaf('drape-panel', 'Pipe and drape', ['Pipe and Drape', 'Drape Panel', 'Drape'], ['drape']),
      leaf('drape-upright', 'Drape upright', ['Drape Upright', 'Upright'], ['drape-upright']),
    ],
  },
  {
    id: 'misc',
    label: 'Misc / ADA',
    children: [
      leaf('lectern', 'Lectern / podium', ['Lectern', 'Podium'], ['podium']),
      leaf('ada', 'ADA access', ['ADA', 'Wheelchair', 'Ramp'], ['person', 'lift']),
      leaf('plant', 'Plant', ['Plant', 'Potted'], ['not-drawn']),
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
      let score = 0;
      if (leaf.categories?.length && item.category && leaf.categories.includes(item.category)) {
        score += 8;
      }
      for (const key of lowered) {
        if (key.length < 3) {
          // Short tokens (PAR, TV, sub) need a word boundary so "adapter" does not win.
          const re = new RegExp(`(?:^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
          if (re.test(name)) score += 6;
          continue;
        }
        if (name === key) score += 20;
        else if (name.includes(key)) score += 5 + Math.min(key.length, 16);
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
