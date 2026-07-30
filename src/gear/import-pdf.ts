/**
 * Reads a printed gear list back into structured data.
 *
 * The rental system prints a consistent layout, and none of the hierarchy is
 * stored as structure — it exists only as *x* positions on the page — so the
 * importer reconstructs it from geometry. Measured from the source documents:
 *
 *   x ≈ 15   department heading ("Audio", "Lighting", "Stage & Scenic")
 *   x ≈ 70   quantity, right-aligned
 *   x = 138  a top-level line item
 *   x = 156  a piece belonging to the line above it
 *
 * Two wrinkles the layout hides: headings repeat across pages as "Audio
 * Continued" and must fold back into the same department, and one PDF can hold
 * several lists end to end (a job often ships as separate GS and VS Stage
 * pulls), each starting with its own "GEAR LIST" banner.
 */

import { createHash } from 'node:crypto';

import { nextId, type GearDepartment, type GearItem, type GearList } from './model.js';

interface TextSpan {
  text: string;
  x: number;
  y: number;
  bold: boolean;
}

/** Column positions in PDF points, with tolerance for a wandering renderer. */
const HEADING_MAX_X = 40;
const QUANTITY_MAX_X = 120;
const DESCRIPTION_MIN_X = 128;
const NEST_MIN_X = 150;

export class GearImportError extends Error {}

/**
 * Loads pdf.js at call time rather than importing it at the top.
 *
 * pdf.js is ESM and ships a separate worker file that it resolves *relative to
 * itself*. Bundling the inventory into the main process moves it away from that
 * worker and the load fails, so it stays an external module and is pulled in
 * with a dynamic import, which a CommonJS bundle is allowed to do.
 */
async function loadPdfJs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

async function readSpans(data: Uint8Array): Promise<TextSpan[][]> {
  const { getDocument } = await loadPdfJs();
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const pages: TextSpan[][] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const spans: TextSpan[] = [];

    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const transform = item.transform as number[];
      spans.push({
        text: item.str,
        x: transform[4],
        y: transform[5],
        bold: /bold/i.test(String(item.fontName ?? '')),
      });
    }
    pages.push(spans);
  }

  await doc.cleanup?.();
  return pages;
}

/** Groups spans into visual lines, top to bottom, left to right. */
function toLines(spans: TextSpan[]): TextSpan[][] {
  const rows = new Map<number, TextSpan[]>();
  for (const span of spans) {
    // Round to a couple of points so one line's spans land in the same bucket.
    const key = Math.round(span.y / 2) * 2;
    const row = rows.get(key);
    if (row) row.push(span);
    else rows.set(key, [span]);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x));
}

/**
 * Extracts every gear list in a PDF.
 *
 * Returns one entry per "GEAR LIST" banner, in page order.
 */
export async function importGearPdf(data: Uint8Array, sourcePath?: string): Promise<GearList[]> {
  const sourceFingerprint = createHash('sha256').update(data).digest('hex');
  const pages = await readSpans(data);
  if (pages.length === 0) throw new GearImportError('the PDF has no pages');

  const lists: GearList[] = [];
  let list: GearList | null = null;
  let byName = new Map<string, GearDepartment>();
  let department: GearDepartment | null = null;
  /** The most recent top-level item, which owns the indented lines below it. */
  let lastTopLevel: GearItem | null = null;
  /** Set while reading the header block, so its lines are not taken as items. */
  let inHeader = false;

  const startList = () => {
    list = {
      id: nextId('l'),
      revision: 0,
      title: 'Gear list',
      departments: [],
      sourcePath,
      sourceFingerprint,
    };
    lists.push(list);
    byName = new Map();
    department = null;
    lastTopLevel = null;
    inHeader = true;
  };

  for (const spans of pages) {
    for (const line of toLines(spans)) {
      const joined = line
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!joined) continue;

      // Page furniture.
      if (/^Page \d+ of \d+/i.test(joined) || /^Print Date/i.test(joined)) continue;
      if (/^Quantity\b/i.test(joined) && /Description/i.test(joined)) {
        inHeader = false;
        continue;
      }

      if (/^GEAR LIST$/i.test(joined)) {
        startList();
        continue;
      }
      if (!list) startList();

      if (inHeader) {
        if (/^JOB\s*#/i.test(joined)) {
          list!.jobNumber = joined.replace(/^JOB\s*#\s*/i, '').trim();
          continue;
        }
        if (/^LOCATION:/i.test(joined)) {
          list!.location = joined.replace(/^LOCATION:\s*/i, '').trim();
          continue;
        }
        // The remaining header line is the job's own title.
        if (line[0].x < HEADING_MAX_X) {
          list!.title = joined;
          continue;
        }
      }

      // Repeated title lines on later pages are page furniture, not a heading.
      if (joined === list!.title) continue;

      const first = line[0];

      // A department heading sits at the far left with no quantity column.
      if (first.x < HEADING_MAX_X) {
        const name = joined.replace(/\s+Continued$/i, '').trim();
        if (!name) continue;
        const existing = byName.get(name.toLowerCase());
        if (existing) {
          department = existing;
        } else {
          department = { id: nextId('d'), name, items: [] };
          byName.set(name.toLowerCase(), department);
          list!.departments.push(department);
        }
        lastTopLevel = null;
        continue;
      }

      if (!department) continue;

      const quantitySpan = line.find((s) => s.x < QUANTITY_MAX_X && /^\d[\d,]*$/.test(s.text.trim()));
      const descriptionSpans = line.filter((s) => s !== quantitySpan && s.x >= DESCRIPTION_MIN_X);
      if (descriptionSpans.length === 0) continue;

      const description = descriptionSpans
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!description) continue;

      const quantity = quantitySpan ? Number(quantitySpan.text.replace(/,/g, '')) : 0;
      const nested = descriptionSpans[0].x >= NEST_MIN_X;

      const item: GearItem = {
        id: nextId(),
        quantity,
        description,
        children: [],
        // A bold line with no quantity is an instruction to the warehouse
        // rather than a physical item. A non-bold line missing a quantity is
        // kept as a zero-count item (parse glitch) so reconcile still sees it.
        note:
          !quantitySpan && descriptionSpans.some((span) => span.bold) ? true : undefined,
      };

      if (nested && lastTopLevel) lastTopLevel.children.push(item);
      else {
        department.items.push(item);
        lastTopLevel = item;
      }
    }
  }

  const usable = lists.filter((l) => l.departments.length > 0);
  if (usable.length === 0) throw new GearImportError('no departments found — is this a gear list?');
  return usable;
}
