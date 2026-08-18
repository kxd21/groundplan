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
 *
 * LEMG / Omni “PULL SHEET” prints are also supported (QTY / S-QTY / Product
 * Name columns). Layout is detected from the banner and column headers.
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
interface ColumnLayout {
  headingMaxX: number;
  /** Right edge of the primary quantity column (excludes LEMG S-QTY). */
  quantityMaxX: number;
  descriptionMinX: number;
  nestMinX: number;
  /** Ignore part-number / PO columns to the right of this. */
  descriptionMaxX: number;
}

/** Classic rental “GEAR LIST” print. */
const CLASSIC_LAYOUT: ColumnLayout = {
  headingMaxX: 40,
  quantityMaxX: 120,
  descriptionMinX: 128,
  nestMinX: 150,
  descriptionMaxX: 520,
};

/**
 * LEMG / Omni-style “PULL SHEET” print:
 * QTY ≈ 27, S-QTY ≈ 50, Product Name ≈ 92 (package) / 110 (contents).
 */
const LEMG_LAYOUT: ColumnLayout = {
  headingMaxX: 40,
  quantityMaxX: 45,
  descriptionMinX: 80,
  nestMinX: 100,
  descriptionMaxX: 400,
};

function detectLayout(pages: TextSpan[][]): ColumnLayout {
  for (const spans of pages) {
    for (const line of toLines(spans)) {
      const joined = line
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (/^PULL SHEET$/i.test(joined)) return LEMG_LAYOUT;
      if (/\bQTY\b/i.test(joined) && /\bS-QTY\b/i.test(joined) && /Product Name/i.test(joined)) {
        return LEMG_LAYOUT;
      }
    }
  }
  return CLASSIC_LAYOUT;
}

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
 * Returns one entry per "GEAR LIST" / "PULL SHEET" banner, in page order.
 */
export async function importGearPdf(data: Uint8Array, sourcePath?: string): Promise<GearList[]> {
  const sourceFingerprint = createHash('sha256').update(data).digest('hex');
  const pages = await readSpans(data);
  if (pages.length === 0) throw new GearImportError('the PDF has no pages');

  const layout = detectLayout(pages);
  const { headingMaxX, quantityMaxX, descriptionMinX, nestMinX, descriptionMaxX } = layout;

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
      if (
        (/^Quantity\b/i.test(joined) && /Description/i.test(joined)) ||
        (/\bQTY\b/i.test(joined) && /Product Name/i.test(joined))
      ) {
        inHeader = false;
        continue;
      }

      if (/^(GEAR LIST|PULL SHEET)$/i.test(joined)) {
        startList();
        continue;
      }
      if (!list) startList();

      if (inHeader) {
        const jobMatch = joined.match(/\bJOB\s*#\s*(\d+)\b/i);
        if (jobMatch) {
          list!.jobNumber = jobMatch[1];
          continue;
        }
        if (/^LOCATION:/i.test(joined)) {
          list!.location = joined.replace(/^LOCATION:\s*/i, '').trim();
          continue;
        }
        // LEMG venue block — capture the resort name when present.
        if (/^The Omni Homestead Resort$/i.test(joined) || /^Omni /i.test(joined)) {
          list!.location = joined;
          continue;
        }
        // Classic: title sits at the far left. LEMG: job title is a mid-page line
        // with a dated job code prefix (e.g. 20260816-19_Electricities_…).
        if (line[0].x < headingMaxX) {
          list!.title = joined;
          continue;
        }
        if (
          list!.title === 'Gear list' &&
          /^\d{8}/.test(joined) &&
          /Electricities|Conference|Gala|Wedding|Show/i.test(joined)
        ) {
          list!.title = joined;
          continue;
        }
        if (
          list!.title === 'Gear list' &&
          line[0].x < 200 &&
          joined.length > 12 &&
          !/^(Product Unavailable|Load in|Show Start|Load Out|Product Available|VENUE|LEMG|Updated|Total Weight)/i.test(
            joined,
          )
        ) {
          list!.title = joined;
          continue;
        }
        continue;
      }

      // Repeated title lines on later pages are page furniture, not a heading.
      if (joined === list!.title) continue;

      const first = line[0];
      const quantitySpan = line.find(
        (s) => s.x < quantityMaxX && /^\d[\d,]*$/.test(s.text.trim()),
      );
      const descriptionSpans = line.filter(
        (s) =>
          s !== quantitySpan &&
          s.x >= descriptionMinX &&
          s.x < descriptionMaxX &&
          !/^\d[\d,]*$/.test(s.text.trim()),
      );
      const looksLikeItem = Boolean(quantitySpan && descriptionSpans.length);

      // A department heading sits at the far left with no quantity column.
      // LEMG puts QTY in that same left band, so skip lines that are clearly items.
      if (first.x < headingMaxX && !looksLikeItem) {
        const name = joined.replace(/\s+Continued$/i, '').trim();
        if (!name) continue;
        if (/^(QTY|S-QTY|Product Name|Part Number|PO#)$/i.test(name)) continue;
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
      if (descriptionSpans.length === 0) continue;

      const description = descriptionSpans
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!description) continue;

      const quantity = quantitySpan ? Number(quantitySpan.text.replace(/,/g, '')) : 0;
      const nested = descriptionSpans[0].x >= nestMinX;

      const item: GearItem = {
        id: nextId(),
        quantity,
        description,
        children: [],
        // A bold line with no quantity is an instruction to the warehouse
        // rather than a physical item. A non-bold line missing a quantity is
        // kept as a zero-count item (parse glitch) so reconcile still sees it.
        // LEMG also prints italic/plain warehouse notes under packages.
        note:
          !quantitySpan &&
          (descriptionSpans.some((span) => span.bold) ||
            /^\(/.test(description) ||
            /^(To go with|For |PLEASE |Please |\*\*\*)/i.test(description))
            ? true
            : undefined,
      };

      if (nested && lastTopLevel) lastTopLevel.children.push(item);
      else {
        department.items.push(item);
        lastTopLevel = item.note ? lastTopLevel : item;
      }
    }
  }

  const usable = lists.filter((l) => l.departments.length > 0);
  if (usable.length === 0) throw new GearImportError('no departments found: is this a gear list?');
  return usable;
}
