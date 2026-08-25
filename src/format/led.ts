/**
 * LED walls, by the panels they are actually built from.
 *
 * Nothing in Groundplan knew what a pixel pitch was. A wall could be drawn as
 * a rectangle of about the right size, which answers none of the questions a
 * video engineer has to answer before a truck is loaded: how many panels, what
 * resolution does the processor have to drive, does the real aspect match the
 * content, and how many bumpers and cases does that come to.
 *
 * This is the arithmetic. It deliberately works in panels first and dimensions
 * second, because a wall is an integer number of panels and asking for 19.4ft
 * of a 500mm product is how you end up with a wall that is 19.7ft.
 */

import { UNITS_PER_FOOT } from './rv.js';

/** Tenths of an inch in one millimetre — the file's unit is 1/10in. */
const UNITS_PER_MM = 10 / 25.4;

export interface PanelSpec {
  id: string;
  label: string;
  /** Cabinet size in millimetres. */
  widthMm: number;
  heightMm: number;
  /** Millimetres between pixel centres. */
  pitchMm: number;
  /** Pixels across and down one cabinet. */
  pixelsWide: number;
  pixelsHigh: number;
  /** Cabinet weight in pounds, for the rigging total. */
  weightLb: number;
  /** Cabinet draw in watts, average rather than peak. */
  powerW: number;
}

/**
 * Panels the rental market actually stocks.
 *
 * Sizes are the common 500mm and 500x1000mm cabinet formats. Pixel counts
 * follow from the pitch, and are stated rather than derived so an odd product
 * can be added without the maths having to allow for it.
 */
export const PANEL_TYPES: PanelSpec[] = [
  {
    id: 'p2.6-500',
    label: '2.6mm · 500×500',
    widthMm: 500,
    heightMm: 500,
    pitchMm: 2.6,
    pixelsWide: 192,
    pixelsHigh: 192,
    weightLb: 17,
    powerW: 130,
  },
  {
    id: 'p2.6-500x1000',
    label: '2.6mm · 500×1000',
    widthMm: 500,
    heightMm: 1000,
    pitchMm: 2.6,
    pixelsWide: 192,
    pixelsHigh: 384,
    weightLb: 33,
    powerW: 260,
  },
  {
    id: 'p3.9-500',
    label: '3.9mm · 500×500',
    widthMm: 500,
    heightMm: 500,
    pitchMm: 3.9,
    pixelsWide: 128,
    pixelsHigh: 128,
    weightLb: 16,
    powerW: 120,
  },
  {
    id: 'p3.9-500x1000',
    label: '3.9mm · 500×1000',
    widthMm: 500,
    heightMm: 1000,
    pitchMm: 3.9,
    pixelsWide: 128,
    pixelsHigh: 256,
    weightLb: 31,
    powerW: 240,
  },
  {
    id: 'p4.8-500x1000',
    label: '4.8mm · 500×1000',
    widthMm: 500,
    heightMm: 1000,
    pitchMm: 4.8,
    pixelsWide: 104,
    pixelsHigh: 208,
    weightLb: 30,
    powerW: 230,
  },
  {
    id: 'p6-500x1000',
    label: '6mm · 500×1000',
    widthMm: 500,
    heightMm: 1000,
    pitchMm: 6,
    pixelsWide: 84,
    pixelsHigh: 168,
    weightLb: 28,
    powerW: 200,
  },
];

export function panelSpec(id: string): PanelSpec | undefined {
  return PANEL_TYPES.find((panel) => panel.id === id);
}

export interface WallRequest {
  panel: string;
  /** Panels across. */
  columns: number;
  /** Panels down. */
  rows: number;
}

export interface WallSolution {
  panel: PanelSpec;
  columns: number;
  rows: number;
  panels: number;
  /** Finished size in logical units. */
  width: number;
  height: number;
  widthMm: number;
  heightMm: number;
  /** Native resolution of the whole wall. */
  pixelsWide: number;
  pixelsHigh: number;
  /** Total pixels, for the processor conversation. */
  pixels: number;
  /** Real aspect as a decimal, and as the nearest common ratio when it is one. */
  aspect: number;
  aspectLabel: string;
  weightLb: number;
  powerW: number;
  ampsAt208V: number;
  /**
   * 4K and HD processor budgets, as a fraction used.
   *
   * A processor is bought by pixel count, and "will this fit on one" is the
   * question that decides whether the order has one box or three.
   */
  fractionOfHd: number;
  fractionOf4k: number;
  warnings: string[];
}

const HD_PIXELS = 1920 * 1080;
const UHD_PIXELS = 3840 * 2160;

/** Common delivery ratios, for naming a wall's real aspect. */
const RATIOS: Array<{ label: string; value: number }> = [
  { label: '16:9', value: 16 / 9 },
  { label: '16:10', value: 16 / 10 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:1', value: 2 },
  { label: '21:9', value: 21 / 9 },
  { label: '1:1', value: 1 },
  { label: '3:1', value: 3 },
  { label: '4:1', value: 4 },
];

/**
 * Names an aspect only when it really is one.
 *
 * A wall of 11 by 6 panels is 1.833:1, which is not 16:9 and should not be
 * called it — content cut for 16:9 will be letterboxed or stretched on it, and
 * the drawing is where somebody should notice.
 */
export function describeAspect(aspect: number): string {
  for (const ratio of RATIOS) {
    if (Math.abs(aspect - ratio.value) / ratio.value < 0.01) return ratio.label;
  }
  return `${aspect.toFixed(2)}:1`;
}

/**
 * Works out everything that follows from a panel count.
 *
 * The wall is exactly `columns × rows` panels, so its size is exact and its
 * resolution is exact. Nothing here rounds a dimension to make a number look
 * tidy.
 */
export function solveWall(request: WallRequest): WallSolution | null {
  const panel = panelSpec(request.panel);
  if (!panel) return null;

  const columns = Math.max(1, Math.floor(request.columns));
  const rows = Math.max(1, Math.floor(request.rows));
  const panels = columns * rows;

  const widthMm = columns * panel.widthMm;
  const heightMm = rows * panel.heightMm;
  const pixelsWide = columns * panel.pixelsWide;
  const pixelsHigh = rows * panel.pixelsHigh;
  const pixels = pixelsWide * pixelsHigh;
  const aspect = pixelsWide / pixelsHigh;

  const weightLb = panels * panel.weightLb;
  const powerW = panels * panel.powerW;

  const warnings: string[] = [];

  // A wall this heavy is a rigging conversation, not a video one.
  if (weightLb > 2000) {
    warnings.push(
      `The wall weighs ${Math.round(weightLb).toLocaleString()} lb. Confirm the rigging points and the roof capacity.`,
    );
  }
  if (pixels > UHD_PIXELS) {
    warnings.push(
      `${pixels.toLocaleString()} pixels is more than a single 4K processor output. Plan for more than one.`,
    );
  }
  const named = describeAspect(aspect);
  if (named.endsWith(':1') && !RATIOS.some((r) => r.label === named)) {
    warnings.push(
      `The wall is ${named}, which is not a standard delivery ratio. Content will need building to size.`,
    );
  }
  // Below about 2.6mm the pitch stops mattering at typical audience distance,
  // and above about 6mm the front row can count the pixels.
  if (panel.pitchMm >= 6) {
    warnings.push(
      `${panel.pitchMm}mm pitch: the nearest comfortable viewing distance is about ${panel.pitchMm.toFixed(0)}m. Check the front row.`,
    );
  }

  return {
    panel,
    columns,
    rows,
    panels,
    width: widthMm * UNITS_PER_MM,
    height: heightMm * UNITS_PER_MM,
    widthMm,
    heightMm,
    pixelsWide,
    pixelsHigh,
    pixels,
    aspect,
    aspectLabel: named,
    weightLb,
    powerW,
    // LED walls are fed three-phase 208V far more often than 120V single phase.
    ampsAt208V: powerW / 208,
    fractionOfHd: pixels / HD_PIXELS,
    fractionOf4k: pixels / UHD_PIXELS,
    warnings,
  };
}

/**
 * The panel count that comes closest to a wanted size without exceeding it.
 *
 * A wall is an integer number of panels, so "20ft wide" is a wish rather than a
 * specification. This answers it honestly and reports what it actually built.
 */
export function fitWall(
  panelId: string,
  targetWidth: number,
  targetHeight: number,
): WallSolution | null {
  const panel = panelSpec(panelId);
  if (!panel) return null;
  const columns = Math.max(1, Math.floor(targetWidth / (panel.widthMm * UNITS_PER_MM)));
  const rows = Math.max(1, Math.floor(targetHeight / (panel.heightMm * UNITS_PER_MM)));
  return solveWall({ panel: panelId, columns, rows });
}

/** The build list for a wall: panels, bumpers, cases and spares. */
export function wallBuildList(
  solution: WallSolution,
): Array<{ item: string; quantity: number; detail?: string }> {
  const lines: Array<{ item: string; quantity: number; detail?: string }> = [
    {
      item: `LED panel ${solution.panel.label}`,
      quantity: solution.panels,
      detail: `${solution.columns} across × ${solution.rows} down`,
    },
  ];

  // One bumper per column for a hung wall; ground support is a different order.
  lines.push({
    item: 'Hanging bumper',
    quantity: solution.columns,
    detail: 'one per column, if flown',
  });

  // Spares are counted in panels, not percentages: half a panel is no use.
  const spares = Math.max(1, Math.ceil(solution.panels * 0.03));
  lines.push({ item: 'Spare panels', quantity: spares, detail: '3% of the wall, rounded up' });

  // Road cases hold six 500×1000 cabinets, or twelve 500×500.
  const perCase = solution.panel.heightMm >= 1000 ? 6 : 12;
  lines.push({
    item: 'Panel case',
    quantity: Math.ceil((solution.panels + spares) / perCase),
    detail: `${perCase} panels per case`,
  });

  lines.push({
    item: 'Processor',
    quantity: Math.max(1, Math.ceil(solution.fractionOf4k)),
    detail: `${solution.pixelsWide}×${solution.pixelsHigh} = ${solution.pixels.toLocaleString()} px`,
  });

  return lines;
}

/** Feet, for a readout. */
export function unitsToFeet(units: number): number {
  return units / UNITS_PER_FOOT;
}
