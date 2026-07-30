/**
 * Plan symbols drawn from published specifications.
 *
 * The shared catalog carries what a piece of gear *is* — a Barco UDX is 31in
 * wide and throws from a lens on its front face — and that is enough to draw it.
 * So symbols are generated from category and dimensions rather than lifted out
 * of anyone's drawings.
 *
 * That distinction is the whole point. Symbols harvested from a real plan carry
 * that show with them: the room it was drawn in, the labels around it, the
 * client it belonged to. Those stay on the machine that made them and are never
 * published. A generated symbol carries nothing but the product's own
 * dimensions, which are on the manufacturer's data sheet.
 *
 * Precedence when something is placed:
 *
 *   1. a symbol harvested from the user's own plans   (private, never uploaded)
 *   2. this generated symbol                          (public, same for everyone)
 *   3. a plain sized box                              (last resort)
 *
 * So a shop that has drawn its own Barco keeps its drawing, and a shop that has
 * never seen one still places something that reads as a projector.
 */

import { CATALOG_UNITS_PER_INCH, type CatalogProduct } from './model.js';

/** One outline. Points are `[x0, y0, x1, y1, …]` around the insertion point. */
export interface SymbolPath {
  points: number[];
  closed: boolean;
}

export interface GeneratedSymbol {
  paths: SymbolPath[];
  /** Footprint in logical units, for placement and for the size readout. */
  width: number;
  height: number;
  /** Which rule drew it, so a wrong-looking symbol can be traced. */
  basis: string;
}

const INCH = CATALOG_UNITS_PER_INCH;
const FOOT = 12 * INCH;

/** Default footprints, in inches, for products with no published dimensions. */
const FALLBACK_SIZE: Record<string, [number, number]> = {
  projector: [24, 30],
  screen: [120, 6],
  'flat-panel': [48, 4],
  camera: [10, 14],
  'moving-light': [14, 14],
  'par-light': [10, 10],
  ellipsoidal: [10, 22],
  'light-batten': [48, 6],
  'light-tree': [24, 24],
  'lighting-console': [30, 20],
  speaker: [15, 18],
  subwoofer: [24, 24],
  mixer: [40, 24],
  podium: [24, 20],
  riser: [96, 48],
  stairs: [48, 36],
  truss: [120, 12],
  'truss-base': [30, 30],
  drape: [120, 2],
  'drape-upright': [18, 18],
  lift: [60, 30],
  ladder: [24, 60],
  'table-round': [60, 60],
  'table-rect': [72, 30],
  chair: [18, 18],
  desk: [72, 24],
  person: [22, 18],
};

function rect(x0: number, y0: number, x1: number, y1: number): SymbolPath {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true };
}

function circle(cx: number, cy: number, r: number, segments = 32): SymbolPath {
  const points: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return { points, closed: true };
}

function line(x0: number, y0: number, x1: number, y1: number): SymbolPath {
  return { points: [x0, y0, x1, y1], closed: false };
}

/**
 * Draws a product's plan symbol.
 *
 * Every shape is centred on the origin, because that is where a placement's
 * insertion point sits. Conventions follow how this trade already draws: a
 * projector shows its throw direction, a speaker is splayed towards its
 * coverage, a truss shows its bracing.
 */
export function generateSymbol(product: CatalogProduct): GeneratedSymbol {
  const category = product.category;
  const fallback = FALLBACK_SIZE[category] ?? [24, 24];

  const width = product.dimensions?.width ?? fallback[0] * INCH;
  const depth = product.dimensions?.depth ?? fallback[1] * INCH;
  const hw = width / 2;
  const hd = depth / 2;

  const paths: SymbolPath[] = [];
  let basis = category;

  switch (category) {
    case 'projector': {
      // Body, with the lens and a throw arrow on the front face. Which way a
      // projector faces is the single most useful thing a plan can say about it.
      paths.push(rect(-hw, -hd, hw, hd));
      const lens = Math.min(hw * 0.4, hd * 0.4);
      paths.push(circle(0, hd - lens * 1.2, lens));
      paths.push(line(0, hd, 0, hd + depth * 0.45));
      paths.push(line(-lens * 0.5, hd + depth * 0.25, 0, hd + depth * 0.45));
      paths.push(line(lens * 0.5, hd + depth * 0.25, 0, hd + depth * 0.45));
      break;
    }

    case 'screen': {
      // A screen in plan is its face plus the frame depth behind it.
      paths.push(rect(-hw, -hd, hw, hd));
      paths.push(line(-hw, -hd, hw, -hd));
      break;
    }

    case 'flat-panel': {
      paths.push(rect(-hw, -hd, hw, hd));
      // Stand foot, so it is not confused with a flown panel.
      paths.push(line(-hw * 0.3, hd, hw * 0.3, hd));
      break;
    }

    case 'speaker':
    case 'subwoofer': {
      // Splayed towards coverage — the standard plan convention for a box.
      const front = hw * (category === 'speaker' ? 0.62 : 0.85);
      paths.push({
        points: [-hw, -hd, hw, -hd, front, hd, -front, hd],
        closed: true,
      });
      break;
    }

    case 'moving-light':
    case 'par-light': {
      paths.push(circle(0, 0, Math.min(hw, hd)));
      // Yoke arms, which is how a fixture is told from a plain circle.
      paths.push(line(-hw, -hd * 0.5, -hw, hd * 0.5));
      paths.push(line(hw, -hd * 0.5, hw, hd * 0.5));
      break;
    }

    case 'ellipsoidal': {
      // Barrel plus lens tube: longer than it is wide, pointing forward.
      paths.push(rect(-hw, -hd, hw, hd * 0.2));
      paths.push(rect(-hw * 0.55, hd * 0.2, hw * 0.55, hd));
      break;
    }

    case 'light-batten': {
      paths.push(rect(-hw, -hd, hw, hd));
      const cells = Math.max(2, Math.min(12, Math.round(width / (6 * INCH))));
      for (let i = 1; i < cells; i++) {
        const x = -hw + (width * i) / cells;
        paths.push(line(x, -hd, x, hd));
      }
      break;
    }

    case 'truss': {
      // Chords with X bracing between, at roughly bay spacing.
      paths.push(rect(-hw, -hd, hw, hd));
      const bays = Math.max(1, Math.min(16, Math.round(width / (2 * FOOT))));
      for (let i = 0; i < bays; i++) {
        const x0 = -hw + (width * i) / bays;
        const x1 = -hw + (width * (i + 1)) / bays;
        paths.push(line(x0, -hd, x1, hd));
        paths.push(line(x0, hd, x1, -hd));
      }
      break;
    }

    case 'riser': {
      paths.push(rect(-hw, -hd, hw, hd));
      // Corner ticks read as a deck rather than a plain rectangle.
      const t = Math.min(width, depth) * 0.12;
      paths.push(line(-hw, -hd + t, -hw + t, -hd));
      paths.push(line(hw - t, -hd, hw, -hd + t));
      paths.push(line(-hw, hd - t, -hw + t, hd));
      paths.push(line(hw - t, hd, hw, hd - t));
      break;
    }

    case 'stairs': {
      paths.push(rect(-hw, -hd, hw, hd));
      const treads = Math.max(2, Math.min(10, Math.round(depth / (10 * INCH))));
      for (let i = 1; i < treads; i++) {
        const y = -hd + (depth * i) / treads;
        paths.push(line(-hw, y, hw, y));
      }
      break;
    }

    case 'table-round': {
      paths.push(circle(0, 0, Math.max(hw, hd)));
      break;
    }

    case 'chair': {
      paths.push(rect(-hw, -hd, hw, hd * 0.55));
      // Back rail.
      paths.push(line(-hw, hd * 0.55, hw, hd * 0.55));
      paths.push(rect(-hw, hd * 0.55, hw, hd));
      break;
    }

    case 'podium': {
      paths.push(rect(-hw, -hd, hw, hd));
      // Angled reading surface.
      paths.push(line(-hw, hd * 0.35, hw, hd * 0.35));
      break;
    }

    case 'camera': {
      paths.push(rect(-hw, -hd, hw, hd * 0.4));
      paths.push(circle(0, hd * 0.65, Math.min(hw, hd) * 0.35));
      break;
    }

    case 'mixer':
    case 'lighting-console': {
      paths.push(rect(-hw, -hd, hw, hd));
      // Fader bank along the operator edge.
      paths.push(line(-hw * 0.85, hd * 0.45, hw * 0.85, hd * 0.45));
      break;
    }

    case 'lift': {
      paths.push(rect(-hw * 0.6, -hd * 0.6, hw * 0.6, hd * 0.6));
      // Outriggers, which is the footprint that actually matters on a plan.
      paths.push(rect(-hw, -hd, hw, hd));
      break;
    }

    case 'drape':
    case 'drape-upright': {
      if (category === 'drape-upright') {
        paths.push(circle(0, 0, Math.min(hw, hd)));
      } else {
        // A run of drape reads as a wave, the way it is drawn by hand.
        const waves = Math.max(4, Math.min(40, Math.round(width / (INCH * 12))));
        const points: number[] = [];
        for (let i = 0; i <= waves * 4; i++) {
          const t = i / (waves * 4);
          points.push(-hw + width * t, Math.sin(t * waves * Math.PI * 2) * hd);
        }
        paths.push({ points, closed: false });
      }
      break;
    }

    case 'person': {
      paths.push(circle(0, hd * 0.4, Math.min(hw, hd) * 0.45));
      paths.push({
        points: [-hw, -hd, hw, -hd, hw * 0.7, hd * 0.1, -hw * 0.7, hd * 0.1],
        closed: true,
      });
      break;
    }

    default: {
      paths.push(rect(-hw, -hd, hw, hd));
      basis = `${category} (generic outline)`;
      break;
    }
  }

  return { paths, width, height: depth, basis };
}

/**
 * Whether a product can be drawn from what the catalog knows.
 *
 * Used to show, in the catalog browser, which products will place as a real
 * shape and which will fall back to a box.
 */
export function canGenerate(product: CatalogProduct): boolean {
  return Boolean(product.dimensions?.width && product.dimensions?.depth) || product.category in FALLBACK_SIZE;
}
