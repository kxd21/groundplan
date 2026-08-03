/**
 * Multi-step Shape Editor Wizard: category, names, table type / chairs, outline.
 */

import { useEffect, useMemo, useState } from 'react';

import { CATEGORY_LABELS, type Category } from '../../inventory/classify.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { TraceDialog } from './TraceDialog.js';

const api = window.groundplan;

const TABLE_CATEGORIES: Category[] = ['table-round', 'table-rect', 'desk'];
const SEATING_STYLES = [
  'theatre',
  'schoolroom',
  'banquet',
  'cabaret',
  'crescent',
  'conference',
  'u-shape',
  'hollow-square',
] as const;

interface Props {
  open: boolean;
  units: UnitSystem;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

type TableKind = 'other' | 'round' | 'rectangular';

function defaultWidth(units: UnitSystem): string {
  return formatLength(60 * 10, units);
}

export default function ShapeEditorWizard({ open, units, onClose, onCreated, onError, onStatus }: Props) {
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<Category>('table-round');
  const [name, setName] = useState('');
  const [spanishName, setSpanishName] = useState('');
  const [tableKind, setTableKind] = useState<TableKind>('round');
  const [allowChairs, setAllowChairs] = useState(true);
  const [defaultChairs, setDefaultChairs] = useState(8);
  const [styles, setStyles] = useState<string[]>(['banquet']);
  const [widthText, setWidthText] = useState(() => defaultWidth(units));
  const [depthText, setDepthText] = useState(() => defaultWidth(units));
  const [traceOpen, setTraceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deptDraft, setDeptDraft] = useState('');

  const categories = useMemo(
    () => (Object.keys(CATEGORY_LABELS) as Category[]).filter((c) => c !== 'not-drawn'),
    [],
  );

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setCategory('table-round');
    setName('');
    setSpanishName('');
    setTableKind('round');
    setAllowChairs(true);
    setDefaultChairs(8);
    setStyles(['banquet']);
    setWidthText(defaultWidth(units));
    setDepthText(defaultWidth(units));
    setTraceOpen(false);
    setBusy(false);
    setDeptDraft('');
  }, [open, units]);

  if (!open) return null;

  const width = parseLength(widthText, units);
  const depth = parseLength(depthText, units);

  const seatingNote = (): string | undefined => {
    const parts: string[] = [];
    if (allowChairs && defaultChairs > 0) parts.push(`chairs:${defaultChairs}`);
    if (styles.length) parts.push(`styles:${styles.join(',')}`);
    if (spanishName.trim()) parts.push(`es:${spanishName.trim()}`);
    return parts.length ? parts.join(' · ') : undefined;
  };

  const finishPatch = async (id: string | undefined, labeled: string) => {
    if (!id) return;
    const patch: { department?: string; notes?: string } = {};
    if (deptDraft.trim()) patch.department = deptDraft.trim();
    const note = seatingNote();
    if (note) patch.notes = note;
    if (Object.keys(patch).length) await api.inventoryUpdate(id, patch);
    void labeled;
  };

  const finishBox = async () => {
    if (!name.trim()) {
      onError('A shape needs a name');
      return;
    }
    if (!(width && width > 0) || !(depth && depth > 0)) {
      onError('Enter a width and depth');
      return;
    }
    setBusy(true);
    try {
      const hw = width / 2;
      const hd = depth / 2;
      let paths: Array<{ points: number[]; closed: boolean }>;
      if (tableKind === 'round' || category === 'table-round') {
        const pts: number[] = [];
        const n = 32;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          pts.push(hw + Math.cos(a) * hw, hd + Math.sin(a) * hd);
        }
        paths = [{ points: pts, closed: true }];
      } else {
        paths = [{ points: [0, 0, width, 0, width, depth, 0, depth], closed: true }];
      }
      const labeled = spanishName.trim() ? `${name.trim()} / ${spanishName.trim()}` : name.trim();
      const reply = await api.inventoryAddTraced({
        name: labeled,
        width,
        height: depth,
        paths,
        category,
        notes: seatingNote(),
        department: deptDraft.trim() || undefined,
      });
      if (!reply.ok) {
        onError(reply.reason ?? 'could not create the shape');
        return;
      }
      onStatus(
        allowChairs && defaultChairs > 0
          ? `Created “${labeled}” · default ${defaultChairs} chairs`
          : `Created “${labeled}”`,
      );
      if (reply.id) onCreated(reply.id, labeled);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-backdrop" role="presentation" onClick={onClose}>
        <div
          className="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Shape Editor Wizard"
          onClick={(e) => e.stopPropagation()}
          style={{ width: 480, maxWidth: '94vw' }}
        >
          <div className="sheet-title">
            <h2>Shape Editor · Step {step + 1} of 3</h2>
            <button type="button" className="btn-outline" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="sheet-body">
            {step === 0 && (
              <>
                <div className="field">
                  <label htmlFor="shape-cat">Category</label>
                  <select id="shape-cat" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="shape-name">Name</label>
                  <input
                    id="shape-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Required"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="shape-es">Spanish name (optional)</label>
                  <input id="shape-es" value={spanishName} onChange={(e) => setSpanishName(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="shape-dept">Inventory department</label>
                  <input
                    id="shape-dept"
                    value={deptDraft}
                    onChange={(e) => setDeptDraft(e.target.value)}
                    placeholder="e.g. Banquet · Tables"
                  />
                </div>
                <p className="hint">Departments group items in the inventory palette (category maintenance).</p>
              </>
            )}

            {step === 1 && (
              <>
                <div className="field">
                  <label>Table type</label>
                  <div className="seg tabs seat-kinds" role="radiogroup">
                    {(
                      [
                        ['other', 'Other'],
                        ['round', 'Round'],
                        ['rectangular', 'Rectangular'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={tableKind === id ? 'active' : ''}
                        onClick={() => {
                          setTableKind(id);
                          if (id === 'round') setCategory('table-round');
                          if (id === 'rectangular') setCategory('table-rect');
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="check">
                  <input type="checkbox" checked={allowChairs} onChange={(e) => setAllowChairs(e.target.checked)} />
                  Allow chairs
                </label>
                <div className="field">
                  <label htmlFor="shape-chairs">Default chair count</label>
                  <input
                    id="shape-chairs"
                    type="number"
                    min={0}
                    max={24}
                    value={defaultChairs}
                    disabled={!allowChairs}
                    onChange={(e) => setDefaultChairs(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <fieldset className="erd-styles">
                  <legend>Seating styles (auto-place)</legend>
                  {SEATING_STYLES.map((id) => (
                    <label key={id} className="check">
                      <input
                        type="checkbox"
                        checked={styles.includes(id)}
                        disabled={!TABLE_CATEGORIES.includes(category) && tableKind === 'other'}
                        onChange={(e) => {
                          setStyles((prev) =>
                            e.target.checked ? [...prev, id] : prev.filter((s) => s !== id),
                          );
                        }}
                      />
                      {id}
                    </label>
                  ))}
                </fieldset>
                <p className="hint">Chair count and styles are stored on the inventory item notes for later seating.</p>
              </>
            )}

            {step === 2 && (
              <>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="shape-w">Width</label>
                    <input id="shape-w" value={widthText} onChange={(e) => setWidthText(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="shape-d">Depth</label>
                    <input id="shape-d" value={depthText} onChange={(e) => setDepthText(e.target.value)} />
                  </div>
                </div>
                <div className="actions-row">
                  <button type="button" className="btn-outline" onClick={() => setTraceOpen(true)}>
                    Trace outline…
                  </button>
                  <button type="button" className="btn-solid" disabled={busy} onClick={() => void finishBox()}>
                    Create shape
                  </button>
                </div>
                <p className="hint">Trace from a photo, or create a round / rectangular outline from the sizes above.</p>
              </>
            )}

            <div className="actions-row" style={{ marginTop: 12 }}>
              <button type="button" className="btn-outline" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
              {step < 2 && (
                <button
                  type="button"
                  className="btn-solid"
                  disabled={step === 0 && !name.trim()}
                  onClick={() => setStep((s) => s + 1)}
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {traceOpen && (
        <TraceDialog
          units={units}
          onClose={() => setTraceOpen(false)}
          onAdded={(savedName) => {
            setTraceOpen(false);
            void (async () => {
              const state = await api.inventoryList('', null, null);
              const created = state.items.find((row) => row.name === savedName);
              if (created) {
                await finishPatch(created.id, savedName);
                onCreated(created.id, savedName);
              }
              onStatus(`Created “${savedName}”`);
              onClose();
            })();
          }}
          onError={onError}
        />
      )}
    </>
  );
}
