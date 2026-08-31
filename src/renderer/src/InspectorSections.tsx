/**
 * Progressive-disclosure wrappers for the Properties inspector.
 *
 * Primary sections stay open; Advanced collapses behind a details summary.
 * Selection-kind helpers let App wrap only the controls that apply.
 */

import type { ReactNode } from 'react';

import { classify, type Category } from '../../inventory/classify.js';

export type SelectionKind = 'table' | 'chair' | 'stage' | 'wall' | 'label' | 'mixed' | 'generic';

export type MultiSelectField = 'size' | 'rotation' | 'label' | 'elevation';

const TABLE_CATEGORIES = new Set<Category>(['table-round', 'table-rect', 'desk']);
const STAGE_CATEGORIES = new Set<Category>(['riser', 'stairs', 'lift', 'ladder']);
const WALL_CATEGORIES = new Set<Category>(['truss', 'truss-base', 'drape', 'drape-upright']);

/** Fields each selection kind can edit in a multi-select. */
const FIELDS_BY_KIND: Record<Exclude<SelectionKind, 'mixed'>, ReadonlySet<MultiSelectField>> = {
  table: new Set(['size', 'rotation', 'label', 'elevation']),
  chair: new Set(['size', 'rotation', 'label', 'elevation']),
  stage: new Set(['size', 'rotation', 'label', 'elevation']),
  wall: new Set(['size', 'rotation', 'label']),
  label: new Set(['label', 'rotation']),
  generic: new Set(['size', 'rotation', 'label', 'elevation']),
};

function kindOfName(name: string): Exclude<SelectionKind, 'mixed'> {
  const text = name.trim();
  if (!text) return 'generic';

  // Name-shaped cues that classify() does not always catch.
  if (/\b(label|annotation|dimension|note)\b/i.test(text) || /^text\b/i.test(text)) {
    return 'label';
  }
  if (/\b(wall|airwall|column|door|opening)\b/i.test(text)) return 'wall';
  if (/\b(stage|deck|platform)\b/i.test(text)) return 'stage';

  const { category } = classify(text);
  if (TABLE_CATEGORIES.has(category)) return 'table';
  if (category === 'chair') return 'chair';
  if (STAGE_CATEGORIES.has(category)) return 'stage';
  if (WALL_CATEGORIES.has(category)) return 'wall';
  return 'generic';
}

/**
 * Collapses a multi-name selection into one inspector kind.
 * Empty → generic; all alike → that kind; otherwise mixed.
 */
export function classifySelectionKind(names: string[]): SelectionKind {
  if (names.length === 0) return 'generic';
  const kinds = names.map(kindOfName);
  const first = kinds[0]!;
  for (let i = 1; i < kinds.length; i++) {
    if (kinds[i] !== first) return 'mixed';
  }
  return first;
}

/**
 * Intersection of editable fields across selected kinds.
 * Multi-select only keeps size / rotation / label / elevation when every
 * kind shares that field.
 */
export function sharedMultiSelectFields(kinds: string[]): Set<MultiSelectField> {
  if (kinds.length === 0) return new Set();

  let shared: Set<MultiSelectField> | null = null;
  for (const raw of kinds) {
    const key = (raw === 'mixed' ? 'generic' : raw) as Exclude<SelectionKind, 'mixed'>;
    const fields = FIELDS_BY_KIND[key] ?? FIELDS_BY_KIND.generic;
    if (!shared) {
      shared = new Set(fields);
      continue;
    }
    for (const field of [...shared]) {
      if (!fields.has(field)) shared.delete(field);
    }
  }
  return shared ?? new Set();
}

export function InspectorSection({
  title,
  children,
  defaultOpen,
  advanced = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  advanced?: boolean;
}) {
  if (!advanced) {
    return (
      <section className="inspector-section section">
        <div className="section-title">
          <span>{title}</span>
        </div>
        {children}
      </section>
    );
  }

  // Advanced stays collapsed unless the caller opts in with defaultOpen.
  const openByDefault = defaultOpen ?? false;
  return (
    <details className="inspector-section section is-advanced" {...(openByDefault ? { open: true } : {})}>
      <summary className="section-title">
        <span>{title || 'Advanced'}</span>
      </summary>
      {children}
    </details>
  );
}
