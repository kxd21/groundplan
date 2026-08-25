/**
 * Printing a plan at a stated scale.
 *
 * These drawings go to venues, and a venue wants a sheet it can measure: a plan
 * printed "to fit" is worthless if someone needs to check a 10ft clearance with
 * a scale rule. So the page is laid out at a real architectural scale — 1/8in
 * to the foot and friends — with a title block naming the scale it was drawn
 * at, and the sheet is sized to fit rather than the drawing squashed.
 */

import { BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';

import { atomicWriteFile } from './storage.js';

/** Architectural scales, as the fraction of an inch that represents one foot. */
export const SCALES = [
  { id: '1/16', label: '1/16" = 1\'-0"', inchesPerFoot: 1 / 16 },
  { id: '3/32', label: '3/32" = 1\'-0"', inchesPerFoot: 3 / 32 },
  { id: '1/8', label: '1/8" = 1\'-0"', inchesPerFoot: 1 / 8 },
  { id: '3/16', label: '3/16" = 1\'-0"', inchesPerFoot: 3 / 16 },
  { id: '1/4', label: '1/4" = 1\'-0"', inchesPerFoot: 1 / 4 },
  { id: 'fit', label: 'Fit to page', inchesPerFoot: 0 },
] as const;

export type ScaleId = (typeof SCALES)[number]['id'];

/** Printable areas in inches, portrait. */
const PAPERS = {
  Letter: { width: 8.5, height: 11 },
  Legal: { width: 8.5, height: 14 },
  Tabloid: { width: 11, height: 17 },
  A4: { width: 8.27, height: 11.69 },
  A3: { width: 11.69, height: 16.54 },
} as const;

export type PaperId = keyof typeof PAPERS;

export interface PrintRequest {
  svg: string;
  title: string;
  subtitle?: string;
  venue?: string;
  event?: string;
  contact?: string;
  /**
   * Who drew it and which revision this is.
   *
   * Both already existed on the report's title block and neither reached the
   * sheet, which meant the drawing a client signs off could not be cited in a
   * production conversation: there was no way to say "we're working to Rev C,
   * drawn by ...". They are the two fields that make a plan a document rather
   * than a picture.
   */
  drawnBy?: string;
  revision?: string;
  /** What is on the sheet, by layer, with counts. Built from the drawing. */
  legend?: Array<{ layer: string; name: string; count: number }>;
  /** Room size in logical units, for the title block. */
  roomWidth?: number;
  roomHeight?: number;
  /** Clear / ceiling height in logical units. */
  ceilingHeight?: number;
  scale: ScaleId;
  paper: PaperId;
  landscape: boolean;
  printedOn: string;
  /**
   * When true (default), oversize drawings at a fixed scale are split across
   * multiple sheets instead of silently cropping.
   */
  tilePages?: boolean;
}

const MARGIN = 0.4;
const TITLE_BLOCK = 0.85;

function feetInches(units?: number): string {
  if (!units) return '—';
  const totalInches = units / 10;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  return inches === 0 ? `${feet}'` : `${feet}'-${inches}"`;
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
}

/**
 * Wraps the plan SVG in a sheet.
 *
 * The SVG's own `viewBox` is in tenths of an inch, so a scale of 1/8in per foot
 * means one drawing unit becomes `inchesPerFoot / 120` of a page inch.
 */
/**
 * The drawing's own extent, in logical units.
 *
 * The `viewBox` frames every drawn primitive, which is not the same as the room
 * rectangle — sizing the element by the room instead squeezes a larger viewBox
 * into a smaller box and quietly breaks the stated scale.
 */
function viewBoxExtent(svg: string): { width: number; height: number } | null {
  const match = svg.match(/viewBox="\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*"/);
  if (!match) return null;
  const width = Number(match[3]);
  const height = Number(match[4]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Whether the drawing fits the sheet at the requested scale. */
function fitCheck(request: PrintRequest): { fits: boolean; overBy: number } {
  const scale = SCALES.find((s) => s.id === request.scale) ?? SCALES[2];
  if (!scale.inchesPerFoot) return { fits: true, overBy: 0 };

  const paper = PAPERS[request.paper];
  const pageWidth = request.landscape ? paper.height : paper.width;
  const pageHeight = request.landscape ? paper.width : paper.height;
  const frameWidth = pageWidth - MARGIN * 2 - 0.2;
  const frameHeight = pageHeight - MARGIN * 2 - TITLE_BLOCK - 0.2;

  const extent = viewBoxExtent(request.svg) ?? {
    width: request.roomWidth ?? 0,
    height: request.roomHeight ?? 0,
  };
  const drawnWidth = (extent.width / 120) * scale.inchesPerFoot;
  const drawnHeight = (extent.height / 120) * scale.inchesPerFoot;
  const over = Math.max(drawnWidth / frameWidth, drawnHeight / frameHeight);
  return { fits: over <= 1.001, overBy: over };
}

function parseViewBox(svg: string): { minX: number; minY: number; width: number; height: number } | null {
  const match = svg.match(/viewBox="\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*"/);
  if (!match) return null;
  const minX = Number(match[1]);
  const minY = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  return width > 0 && height > 0 ? { minX, minY, width, height } : null;
}

function svgWithViewBox(
  svg: string,
  box: { minX: number; minY: number; width: number; height: number },
): string {
  const next = `viewBox="${box.minX} ${box.minY} ${box.width} ${box.height}"`;
  if (/viewBox="[^"]*"/.test(svg)) return svg.replace(/viewBox="[^"]*"/, next);
  return svg.replace(/<svg\b/, `<svg ${next}`);
}

function titleBlockHtml(
  request: PrintRequest,
  drawnAt: string,
  sheetLabel: string,
): string {
  const job =
    request.subtitle ||
    [request.venue, request.event].filter(Boolean).join(' · ') ||
    '';
  return `<div class="title">
      <div class="grow"><span class="k">Plan</span><span class="v">${escapeHtml(request.title)}</span></div>
      ${job ? `<div><span class="k">Job</span><span class="v small">${escapeHtml(job)}</span></div>` : ''}
      ${request.contact ? `<div><span class="k">Contact</span><span class="v small">${escapeHtml(request.contact)}</span></div>` : ''}
      <div><span class="k">Room</span><span class="v small">${feetInches(request.roomWidth)} × ${feetInches(request.roomHeight)}${
        request.ceilingHeight ? ` × ${feetInches(request.ceilingHeight)} ceiling` : ''
      }</span></div>
      <div><span class="k">Scale</span><span class="v small">${escapeHtml(drawnAt)}</span></div>
      ${request.drawnBy ? `<div><span class="k">Drawn by</span><span class="v small">${escapeHtml(request.drawnBy)}</span></div>` : ''}
      ${request.revision ? `<div><span class="k">Rev</span><span class="v small">${escapeHtml(request.revision)}</span></div>` : ''}
      <div><span class="k">Sheet</span><span class="v small">${escapeHtml(sheetLabel)}</span></div>
      <div><span class="k">Printed</span><span class="v small">${escapeHtml(request.printedOn)}</span></div>
    </div>`;
}

/**
 * The key to what is on the sheet.
 *
 * Capped, because a legend that runs off the page is worse than none: on a
 * 2,000-chair plan the tail is a long list of ones, and the head is what
 * somebody is actually looking up. What is cut is stated rather than silently
 * dropped.
 */
function legendHtml(request: PrintRequest): string {
  const entries = request.legend ?? [];
  if (!entries.length) return '';

  const LIMIT = 18;
  const shown = entries.slice(0, LIMIT);
  const hidden = entries.length - shown.length;

  const rows = shown
    .map(
      (entry) =>
        `<tr><td class="lg-n">${entry.count}</td><td>${escapeHtml(entry.name)}</td>` +
        `<td class="lg-l">${escapeHtml(entry.layer)}</td></tr>`,
    )
    .join('');

  return `<div class="legend">
      <div class="legend-head">Legend</div>
      <table>${rows}</table>
      ${hidden > 0 ? `<div class="legend-more">+${hidden} more on the equipment report</div>` : ''}
    </div>`;
}

function buildSheet(request: PrintRequest): { html: string; pageCount: number } {
  const paper = PAPERS[request.paper];
  const pageWidth = request.landscape ? paper.height : paper.width;
  const pageHeight = request.landscape ? paper.width : paper.height;

  const scale = SCALES.find((s) => s.id === request.scale) ?? SCALES[2];
  const drawnAt = scale.inchesPerFoot
    ? `${scale.label}`
    : 'Fit to page: not to scale';

  const box = parseViewBox(request.svg);
  const frameWidth = pageWidth - MARGIN * 2 - 0.2;
  const frameHeight = pageHeight - MARGIN * 2 - TITLE_BLOCK - 0.2;

  type Tile = { svg: string; sheetLabel: string; sizing: string };
  const tiles: Tile[] = [];

  const wantTiles = request.tilePages !== false && !!scale.inchesPerFoot && !!box;
  if (wantTiles && box && scale.inchesPerFoot) {
    const unitsPerInch = 120 / scale.inchesPerFoot;
    const tileW = frameWidth * unitsPerInch;
    const tileH = frameHeight * unitsPerInch;
    const cols = Math.max(1, Math.ceil(box.width / tileW - 1e-6));
    const rows = Math.max(1, Math.ceil(box.height / tileH - 1e-6));
    const total = cols * rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const minX = box.minX + col * tileW;
        const minY = box.minY + row * tileH;
        const width = Math.min(tileW, box.minX + box.width - minX);
        const height = Math.min(tileH, box.minY + box.height - minY);
        tiles.push({
          svg: svgWithViewBox(request.svg, { minX, minY, width, height }),
          sheetLabel: `${col + 1},${row + 1} of ${cols}×${rows} · ${request.paper}`,
          sizing:
            `width:${(width / 120) * scale.inchesPerFoot}in;` +
            `height:${(height / 120) * scale.inchesPerFoot}in;`,
        });
      }
    }
    if (total === 1) {
      tiles[0]!.sheetLabel = `${request.paper} ${request.landscape ? 'landscape' : 'portrait'}`;
    }
  } else {
    const sizing =
      scale.inchesPerFoot && box
        ? `width:${(box.width / 120) * scale.inchesPerFoot}in;` +
          `height:${(box.height / 120) * scale.inchesPerFoot}in;`
        : `max-width:100%;max-height:100%;`;
    tiles.push({
      svg: request.svg,
      sheetLabel: `${request.paper} ${request.landscape ? 'landscape' : 'portrait'}`,
      sizing,
    });
  }

  const pages = tiles
    .map(
      (tile, index) => `
  <div class="sheet${index < tiles.length - 1 ? ' break' : ''}">
    <div class="frame" style="--svg-size:${tile.sizing}">${tile.svg}${index === 0 ? legendHtml(request) : ''}</div>
    ${titleBlockHtml(request, drawnAt, tile.sheetLabel)}
  </div>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${pageWidth}in ${pageHeight}in; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; }
  .sheet {
    width: ${pageWidth}in; height: ${pageHeight}in;
    padding: ${MARGIN}in; box-sizing: border-box;
    display: flex; flex-direction: column; overflow: hidden;
    font: 9pt -apple-system, "Segoe UI", system-ui, sans-serif; color: #111;
  }
  .sheet.break { page-break-after: always; break-after: page; }
  .frame {
    position: relative;
    flex: 1; min-height: 0; border: 0.5pt solid #999;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; padding: 0.1in; box-sizing: border-box;
  }
  .frame svg { flex: none; max-width: 100%; max-height: 100%; }
  ${tiles
    .map(
      (tile, i) =>
        `.sheet:nth-child(${i + 1}) .frame svg { ${tile.sizing} }`,
    )
    .join('\n  ')}
  .title {
    height: ${TITLE_BLOCK}in; border: 0.5pt solid #999; border-top: none;
    display: flex; align-items: stretch;
  }
  .title div { padding: 0.09in 0.14in; border-right: 0.5pt solid #ccc; display: flex; flex-direction: column; justify-content: center; }
  .title div:last-child { border-right: none; }
  .title .grow { flex: 1; min-width: 0; }
  .k { font-size: 6pt; letter-spacing: 0.08em; text-transform: uppercase; color: #777; margin-bottom: 0.02in; }
  .v { font-size: 10pt; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v.small { font-size: 8.5pt; font-weight: 500; }
  /* The legend floats over the sheet's top-right corner rather than taking a
     column of its own: on a tight architectural scale the drawing needs every
     inch, and the corner above the plan is the one place reliably empty. */
  .legend {
    position: absolute; top: 0.08in; right: 0.08in; max-width: 2.6in;
    background: rgba(255, 255, 255, 0.94); border: 0.5pt solid #999;
    padding: 0.07in 0.09in; font-size: 7pt; line-height: 1.35;
  }
  .legend-head {
    font-size: 6pt; letter-spacing: 0.08em; text-transform: uppercase;
    color: #777; margin-bottom: 0.04in;
  }
  .legend table { border-collapse: collapse; width: 100%; }
  .legend td { padding: 0 0.05in 0 0; vertical-align: baseline; }
  .legend .lg-n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  .legend .lg-l { color: #777; text-align: right; white-space: nowrap; }
  .legend-more { color: #777; margin-top: 0.03in; }
</style></head><body>
${pages}
</body></html>`;

  return { html, pageCount: tiles.length };
}

/**
 * Renders a sheet to PDF in an offscreen window.
 *
 * A hidden `BrowserWindow` is the only way to get Chromium's PDF engine, which
 * is what makes the vector output print sharply at any size.
 */
export async function printPlanToPdf(
  request: PrintRequest,
  target: string,
): Promise<{ fits: boolean; overBy: number; pages?: number }> {
  const paper = PAPERS[request.paper];
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false },
  });

  try {
    const { html, pageCount } = buildSheet(request);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      // Electron takes this in inches. Passing microns silently yields a sheet
      // hundreds of thousands of inches wide, which then paginates.
      pageSize: request.landscape
        ? { width: paper.height, height: paper.width }
        : { width: paper.width, height: paper.height },
      printBackground: true,
      margins: { marginType: 'none' },
      // Omit pageRanges so tiled multi-sheet HTML prints every page.
    });
    await atomicWriteFile(target, pdf, {
      backupPath: existsSync(target) ? `${target}.bak` : undefined,
    });
    const check = fitCheck(request);
    return { ...check, fits: check.fits || pageCount > 1, pages: pageCount };
  } finally {
    win.destroy();
  }
}
