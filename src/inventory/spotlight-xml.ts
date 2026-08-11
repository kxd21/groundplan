/**
 * Vectorworks Spotlight inventory XML → Groundplan inventory rows.
 *
 * Spotlight saves company inventories as `.xml` under
 * `[User|Workgroup]/Libraries/Defaults/Inventories` (Inventory and Equipment
 * List → New Inventory from File). Those files are catalogue + stock lists —
 * names, categories, part types, stock quantities, and virtual parts — not
 * drawable geometry.
 *
 * Primary element map (see tools/fixtures/spotlight-inventory-sample.xml):
 *
 *   Inventory / VWInventory / SpotlightInventory
 *     InventoryInfo → Name, Vendor, Notes
 *     Categories / Category
 *     SymbolObjects / SymbolObject  (also Items/Item, Symbols/Symbol)
 *       Name, Category, PartType, Stock|Quantity|StockQuantity
 *       VirtualParts / VirtualPart → Name, DefaultQuantity|Quantity
 *     IndependentVirtualParts / IndependentVirtualPart → Name, Stock, PartType
 *
 * The parser is tolerant of unknown nodes and alternate tag spellings so minor
 * VW version differences do not reject a file outright.
 */

import { normaliseName, type IncomingItem } from './model.js';

export interface SpotlightInventoryMeta {
  name?: string;
  vendor?: string;
  notes?: string;
}

export interface SpotlightInventoryParse {
  ok: true;
  meta: SpotlightInventoryMeta;
  items: IncomingItem[];
}

export interface SpotlightInventoryParseFailure {
  ok: false;
  reason: string;
}

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

const ROOT_NAMES = new Set(['inventory', 'vwinventory', 'spotlightinventory']);

const ITEM_CONTAINER_NAMES = new Set([
  'symbolobjects',
  'symbols',
  'items',
  'objects',
  'symbolobjectlist',
]);

const ITEM_NAMES = new Set(['symbolobject', 'symbol', 'item', 'object', 'part']);

const IVP_CONTAINER_NAMES = new Set([
  'independentvirtualparts',
  'independentvirtualpartlist',
  'ivps',
]);

const IVP_NAMES = new Set(['independentvirtualpart', 'ivp']);

const VIRTUAL_CONTAINER_NAMES = new Set(['virtualparts', 'virtualpartlist']);
const VIRTUAL_NAMES = new Set(['virtualpart', 'vp']);

/**
 * Parses a Spotlight (or Spotlight-compatible) inventory XML document into
 * mergeable inventory rows.
 */
export function parseSpotlightInventoryXml(
  text: string,
): SpotlightInventoryParse | SpotlightInventoryParseFailure {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { ok: false, reason: 'the inventory file is empty' };

  let root: XmlNode;
  try {
    root = parseXml(trimmed);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'could not parse the XML',
    };
  }

  const inventoryRoot = findInventoryRoot(root);
  if (!inventoryRoot) {
    return {
      ok: false,
      reason: 'not a Vectorworks Spotlight inventory file (missing Inventory root)',
    };
  }

  const meta = readMeta(inventoryRoot);
  const items: IncomingItem[] = [];
  const seen = new Set<string>();

  const push = (item: IncomingItem) => {
    const key = normaliseName(item.name);
    if (!key) return;
    // First wins for duplicates within one file; stock already recorded.
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const container of walkNamed(inventoryRoot, ITEM_CONTAINER_NAMES)) {
    for (const node of container.children) {
      if (!ITEM_NAMES.has(node.name)) continue;
      const row = readEquipmentRow(node, false);
      if (row) push(row);
      for (const vp of collectVirtualParts(node)) push(vp);
    }
  }

  // Some exports list symbol objects directly under the root.
  for (const node of inventoryRoot.children) {
    if (!ITEM_NAMES.has(node.name)) continue;
    const row = readEquipmentRow(node, false);
    if (row) push(row);
    for (const vp of collectVirtualParts(node)) push(vp);
  }

  for (const container of walkNamed(inventoryRoot, IVP_CONTAINER_NAMES)) {
    for (const node of container.children) {
      if (!IVP_NAMES.has(node.name) && !ITEM_NAMES.has(node.name)) continue;
      const row = readEquipmentRow(node, true);
      if (row) push(row);
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      reason: 'the inventory file has no symbol, object, or virtual-part rows',
    };
  }

  return { ok: true, meta, items };
}

function findInventoryRoot(root: XmlNode): XmlNode | null {
  if (ROOT_NAMES.has(root.name)) return root;
  for (const child of root.children) {
    if (ROOT_NAMES.has(child.name)) return child;
  }
  // Document wrapper with a single element child.
  if (root.name === '#document' || root.name === 'xml') {
    for (const child of root.children) {
      const found = findInventoryRoot(child);
      if (found) return found;
    }
  }
  return null;
}

function readMeta(root: XmlNode): SpotlightInventoryMeta {
  const info =
    root.children.find((c) => c.name === 'inventoryinfo' || c.name === 'info' || c.name === 'settings') ??
    root;
  const name =
    childText(info, ['name', 'inventoryname', 'title']) ||
    attr(root, ['name', 'inventoryname', 'title']) ||
    undefined;
  const vendor =
    childText(info, ['vendor', 'venue', 'source', 'company']) ||
    attr(root, ['vendor', 'venue']) ||
    undefined;
  const notes =
    childText(info, ['notes', 'note', 'description', 'comment']) || undefined;
  return { name, vendor, notes };
}

function readEquipmentRow(node: XmlNode, forceVirtual: boolean): IncomingItem | null {
  const name =
    childText(node, ['name', 'symbol', 'symbolname', 'object', 'objectname', 'part']) ||
    attr(node, ['name', 'symbol', 'object']);
  if (!name) return null;

  const category =
    childText(node, ['category', 'department', 'group', 'folder']) ||
    attr(node, ['category', 'department']) ||
    undefined;

  const partType =
    childText(node, ['parttype', 'type', 'kind']) ||
    attr(node, ['parttype', 'type']) ||
    '';

  const stockRaw =
    childText(node, ['stock', 'quantity', 'stockquantity', 'qty', 'count', 'owned']) ||
    attr(node, ['stock', 'quantity', 'qty']);
  const quantity = parseQuantity(stockRaw);

  const virtual =
    forceVirtual ||
    /^(ivp|independent\s*virtual|virtual\s*part|virtualpart)$/i.test(partType.trim()) ||
    IVP_NAMES.has(node.name) ||
    VIRTUAL_NAMES.has(node.name);

  const notesParts: string[] = [];
  if (virtual) notesParts.push(forceVirtual || /ivp/i.test(partType) ? 'Independent virtual part' : 'Virtual part');
  if (partType && !virtual) notesParts.push(`Part type: ${partType}`);

  return {
    name,
    department: category,
    quantity: quantity ?? undefined,
    virtual: virtual || undefined,
    notes: notesParts.length ? notesParts.join(' · ') : undefined,
    sizeSource: 'unknown',
  };
}

function collectVirtualParts(parent: XmlNode): IncomingItem[] {
  const out: IncomingItem[] = [];
  for (const container of [...parent.children, parent]) {
    if (container !== parent && !VIRTUAL_CONTAINER_NAMES.has(container.name)) continue;
    const nodes = container === parent ? parent.children : container.children;
    for (const node of nodes) {
      if (!VIRTUAL_NAMES.has(node.name)) continue;
      const name =
        childText(node, ['name', 'part', 'partname']) || attr(node, ['name']);
      if (!name) continue;
      // DefaultQuantity is "per parent instance", not warehouse stock — only
      // honour an explicit Stock/Quantity attribute as owned quantity.
      const stockRaw =
        childText(node, ['stock', 'stockquantity']) || attr(node, ['stock', 'stockquantity']);
      const quantity = parseQuantity(stockRaw);
      const defaultQty =
        childText(node, ['defaultquantity', 'quantity', 'qty', 'count']) ||
        attr(node, ['defaultquantity', 'quantity', 'qty']);
      const noteBits = ['Virtual part'];
      const per = parseQuantity(defaultQty);
      if (per != null && per > 0) noteBits.push(`${per} per parent`);
      out.push({
        name,
        department:
          childText(parent, ['category', 'department']) ||
          attr(parent, ['category', 'department']) ||
          undefined,
        quantity: quantity ?? undefined,
        virtual: true,
        notes: noteBits.join(' · '),
        sizeSource: 'unknown',
      });
    }
  }
  return out;
}

function parseQuantity(raw: string | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function childText(node: XmlNode, names: string[]): string {
  for (const name of names) {
    const child = node.children.find((c) => c.name === name);
    if (child) {
      const text = (child.text || directText(child)).trim();
      if (text) return text;
    }
  }
  return '';
}

function directText(node: XmlNode): string {
  return node.text;
}

function attr(node: XmlNode, names: string[]): string {
  for (const name of names) {
    const value = node.attrs[name];
    if (value?.trim()) return value.trim();
  }
  return '';
}

function* walkNamed(node: XmlNode, names: Set<string>): Generator<XmlNode> {
  if (names.has(node.name)) yield node;
  for (const child of node.children) yield* walkNamed(child, names);
}

/**
 * Minimal XML tree builder — no external dependency.
 *
 * Enough for Spotlight inventory documents: elements, attributes, text, and
 * comments/processing instructions skipped.
 */
function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  const peek = () => source[i];
  const startsWith = (s: string) => source.startsWith(s, i);

  while (i < source.length) {
    if (peek() !== '<') {
      const start = i;
      while (i < source.length && source[i] !== '<') i++;
      const text = source.slice(start, i);
      const parent = stack[stack.length - 1];
      if (text.trim()) parent.text += (parent.text ? ' ' : '') + text.trim();
      continue;
    }

    if (startsWith('<?')) {
      i = source.indexOf('?>', i);
      i = i < 0 ? source.length : i + 2;
      continue;
    }
    if (startsWith('<!--')) {
      i = source.indexOf('-->', i);
      i = i < 0 ? source.length : i + 3;
      continue;
    }
    if (startsWith('<![CDATA[')) {
      const end = source.indexOf(']]>', i);
      const text = source.slice(i + 9, end < 0 ? source.length : end);
      stack[stack.length - 1].text += text;
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (startsWith('</')) {
      const close = source.indexOf('>', i);
      const rawName = source.slice(i + 2, close < 0 ? source.length : close).trim();
      const name = rawName.toLowerCase();
      i = close < 0 ? source.length : close + 1;
      while (stack.length > 1) {
        const node = stack.pop()!;
        if (node.name === name) break;
      }
      continue;
    }

    // Opening or empty tag.
    const close = source.indexOf('>', i);
    if (close < 0) break;
    let body = source.slice(i + 1, close).trim();
    i = close + 1;
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1).trim();

    const { tag, attrs } = parseOpenTag(body);
    if (!tag) continue;
    const node: XmlNode = { name: tag.toLowerCase(), attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function parseOpenTag(body: string): { tag: string; attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  const match = body.match(/^([^\s/]+)/);
  if (!match) return { tag: '', attrs };
  const tag = match[1];
  const attrSource = body.slice(tag.length);
  const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrSource))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return { tag, attrs };
}
