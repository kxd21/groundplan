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
import { writeFile } from 'node:fs/promises';

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
  /** Room size in logical units, for the title block. */
  roomWidth?: number;
  roomHeight?: number;
  scale: ScaleId;
  paper: PaperId;
  landscape: boolean;
  printedOn: string;
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

function buildSheet(request: PrintRequest): string {
  const paper = PAPERS[request.paper];
  const pageWidth = request.landscape ? paper.height : paper.width;
  const pageHeight = request.landscape ? paper.width : paper.height;

  const scale = SCALES.find((s) => s.id === request.scale) ?? SCALES[2];
  const drawnAt = scale.inchesPerFoot
    ? `${scale.label}`
    : 'Fit to page — not to scale';

  // The plan is placed with the SVG's own aspect preserved; at a fixed scale
  // the sheet may crop, which is honest and expected for a large room.
  const extent = viewBoxExtent(request.svg);
  const sizing =
    scale.inchesPerFoot && extent
      ? `width:${(extent.width / 120) * scale.inchesPerFoot}in;` +
        `height:${(extent.height / 120) * scale.inchesPerFoot}in;`
      : `max-width:100%;max-height:100%;`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${pageWidth}in ${pageHeight}in; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; overflow: hidden; }
  .sheet {
    width: ${pageWidth}in; height: ${pageHeight}in;
    padding: ${MARGIN}in; box-sizing: border-box;
    display: flex; flex-direction: column; overflow: hidden;
    font: 9pt -apple-system, "Segoe UI", system-ui, sans-serif; color: #111;
  }
  .frame {
    flex: 1; min-height: 0; border: 0.5pt solid #999;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; padding: 0.1in; box-sizing: border-box;
  }
  .frame svg { flex: none; ${sizing} }
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
</style></head><body>
  <div class="sheet">
    <div class="frame">${request.svg}</div>
    <div class="title">
      <div class="grow"><span class="k">Plan</span><span class="v">${escapeHtml(request.title)}</span></div>
      ${request.subtitle ? `<div><span class="k">Job</span><span class="v small">${escapeHtml(request.subtitle)}</span></div>` : ''}
      <div><span class="k">Room</span><span class="v small">${feetInches(request.roomWidth)} × ${feetInches(request.roomHeight)}</span></div>
      <div><span class="k">Scale</span><span class="v small">${escapeHtml(drawnAt)}</span></div>
      <div><span class="k">Sheet</span><span class="v small">${escapeHtml(request.paper)} ${request.landscape ? 'landscape' : 'portrait'}</span></div>
      <div><span class="k">Printed</span><span class="v small">${escapeHtml(request.printedOn)}</span></div>
    </div>
  </div>
</body></html>`;
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
): Promise<{ fits: boolean; overBy: number }> {
  const paper = PAPERS[request.paper];
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildSheet(request))}`);
    const pdf = await win.webContents.printToPDF({
      // Electron takes this in inches. Passing microns silently yields a sheet
      // hundreds of thousands of inches wide, which then paginates.
      pageSize: request.landscape
        ? { width: paper.height, height: paper.width }
        : { width: paper.width, height: paper.height },
      printBackground: true,
      margins: { marginType: 'none' },
      pageRanges: '1',
    });
    await writeFile(target, pdf);
    return fitCheck(request);
  } finally {
    win.destroy();
  }
}
