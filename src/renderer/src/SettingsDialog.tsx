import { useEffect, useState } from 'react';

const api = window.groundplan;
const FOOT = 120;

interface Settings {
  print: { scale: string; paper: string; landscape: boolean; subtitle: string };
  dxf: { includeSchedule: boolean; visibleLayersOnly: boolean };
  drawing: { units: 'imperial' | 'metric'; snapStep: number; showGrid: boolean; bulkDeleteWarning: number };
  catalog: {
    policy: 'automatic' | 'automatic-small' | 'notify' | 'manual';
    smallUpdateLimitMb: number;
    checkIntervalHours: number;
  };
  app: { checkOnLaunch: boolean };
  inventory: { autoAbsorbGear: boolean; autoMatchShapes: boolean };
}

type Panel = 'export' | 'drawing' | 'inventory' | 'updates';

const PANELS: Array<{ id: Panel; label: string; blurb: string }> = [
  { id: 'export', label: 'Export', blurb: 'What a printed sheet and a CAD file start out as.' },
  { id: 'drawing', label: 'Drawing', blurb: 'How the canvas behaves while you work.' },
  { id: 'inventory', label: 'Inventory', blurb: 'What happens when gear arrives.' },
  { id: 'updates', label: 'Updates', blurb: 'The equipment catalog and the application itself.' },
];

const SCALES = [
  ['1/16', '1/16" = 1\'-0"'],
  ['3/32', '3/32" = 1\'-0"'],
  ['1/8', '1/8" = 1\'-0"'],
  ['3/16', '3/16" = 1\'-0"'],
  ['1/4', '1/4" = 1\'-0"'],
  ['fit', 'Fit to page'],
] as const;

const PAPERS = ['Letter', 'Legal', 'Tabloid', 'A4', 'A3'] as const;

const SNAP_STEPS = [
  [0, 'Off'],
  [10, '1 inch'],
  [30, '3 inches'],
  [60, '6 inches'],
  [FOOT, '1 foot'],
  [FOOT * 5, '5 feet'],
] as const;

/**
 * Settings.
 *
 * Grouped by when a person thinks about them rather than by which module owns
 * them: everything that shapes a deliverable is under Export, everything that
 * shapes the drawing surface is under Drawing. Each change saves immediately —
 * there is no OK button, because a settings window with an unsaved state is a
 * settings window that loses work.
 */
export function SettingsDialog({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [panel, setPanel] = useState<Panel>('export');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .settingsGet()
      .then((value) => live && setSettings(value as Settings))
      .catch(() => onError('Settings could not be loaded.'));
    return () => {
      live = false;
    };
  }, [onError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Every change is written straight away, and the confirmation is quiet.
  const patch = async (change: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings } as Settings;
    for (const key of Object.keys(change) as Array<keyof Settings>) {
      next[key] = { ...(settings[key] as object), ...(change[key] as object) } as never;
    }
    setSettings(next);

    const reply = await api.settingsPatch(change);
    if (reply.ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1400);
    } else onError('That setting could not be saved.');
  };

  if (!settings) {
    return (
      <div className="sheet-backdrop" onClick={onClose}>
        <div className="sheet settings-sheet" onClick={(e) => e.stopPropagation()}>
          <p className="hint" style={{ padding: 24 }}>
            Loading settings…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="settings-body">
          <nav className="settings-nav">
            {PANELS.map((p) => (
              <button
                key={p.id}
                className={panel === p.id ? 'active' : ''}
                onClick={() => setPanel(p.id)}
              >
                {p.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            <p className="settings-blurb">{PANELS.find((p) => p.id === panel)?.blurb}</p>

            {panel === 'export' && (
              <>
                <div className="setting">
                  <label htmlFor="s-scale">Print scale</label>
                  <select
                    id="s-scale"
                    value={settings.print.scale}
                    onChange={(e) => void patch({ print: { ...settings.print, scale: e.target.value } })}
                  >
                    {SCALES.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="setting">
                  <label htmlFor="s-paper">Paper</label>
                  <select
                    id="s-paper"
                    value={settings.print.paper}
                    onChange={(e) => void patch({ print: { ...settings.print, paper: e.target.value } })}
                  >
                    {PAPERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.print.landscape}
                    onChange={(e) => void patch({ print: { ...settings.print, landscape: e.target.checked } })}
                  />
                  <span>Landscape</span>
                </label>

                <div className="setting">
                  <label htmlFor="s-subtitle">Title block job line</label>
                  <input
                    id="s-subtitle"
                    value={settings.print.subtitle}
                    placeholder="e.g. your company name"
                    onChange={(e) => void patch({ print: { ...settings.print, subtitle: e.target.value } })}
                  />
                </div>
                <p className="hint">
                  Printed in the title block when a plan carries no job number of its own.
                </p>

                <div className="settings-divider" />

                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.dxf.includeSchedule}
                    onChange={(e) => void patch({ dxf: { ...settings.dxf, includeSchedule: e.target.checked } })}
                  />
                  <span>Write the item schedule beside a DXF export</span>
                </label>
                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.dxf.visibleLayersOnly}
                    onChange={(e) =>
                      void patch({ dxf: { ...settings.dxf, visibleLayersOnly: e.target.checked } })
                    }
                  />
                  <span>Export only the layers currently shown</span>
                </label>
                <p className="hint">
                  Repeated gear exports as one reusable symbol plus its placements, so a 2,000-seat plan
                  becomes a handful of blocks to swap for 3D rather than 2,000 outlines.
                </p>
              </>
            )}

            {panel === 'drawing' && (
              <>
                <div className="setting">
                  <label htmlFor="s-units">Measurements</label>
                  <select
                    id="s-units"
                    value={settings.drawing.units}
                    onChange={(e) =>
                      void patch({
                        drawing: {
                          ...settings.drawing,
                          units: e.target.value === 'metric' ? 'metric' : 'imperial',
                        },
                      })
                    }
                  >
                    <option value="imperial">Feet and inches</option>
                    <option value="metric">Metres and centimetres</option>
                  </select>
                </div>
                <p className="settings-note">
                  Changes how lengths and areas are shown and typed. Bare numbers mean feet in imperial and metres in
                  metric; you can always type cm, mm, ft, or inches with a suffix. Plans stay in tenths of an inch on
                  disk — switching units does not alter a drawing.
                </p>

                <div className="setting">
                  <label htmlFor="s-snap">Snap to</label>
                  <select
                    id="s-snap"
                    value={settings.drawing.snapStep}
                    onChange={(e) =>
                      void patch({ drawing: { ...settings.drawing, snapStep: Number(e.target.value) } })
                    }
                  >
                    {SNAP_STEPS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="hint">Objects also snap to line up with what is already on the plan.</p>

                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.drawing.showGrid}
                    onChange={(e) => void patch({ drawing: { ...settings.drawing, showGrid: e.target.checked } })}
                  />
                  <span>Show the grid</span>
                </label>

                <div className="setting">
                  <label htmlFor="s-bulk">Warn before deleting</label>
                  <div className="setting-inline">
                    <input
                      id="s-bulk"
                      className="num"
                      value={settings.drawing.bulkDeleteWarning}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n >= 0) {
                          void patch({ drawing: { ...settings.drawing, bulkDeleteWarning: n } });
                        }
                      }}
                    />
                    <span className="hint">objects or more at once</span>
                  </div>
                </div>
              </>
            )}

            {panel === 'inventory' && (
              <>
                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.inventory.autoAbsorbGear}
                    onChange={(e) =>
                      void patch({ inventory: { ...settings.inventory, autoAbsorbGear: e.target.checked } })
                    }
                  />
                  <span>Add gear to the inventory when a gear list is imported</span>
                </label>
                <p className="hint">
                  That only updates this computer. To push new stock to the rest of the shop, use Inventory →
                  Export pack…, put the folder on a USB stick or shared drive, then Import pack… on each machine.
                </p>

                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.inventory.autoMatchShapes}
                    onChange={(e) =>
                      void patch({ inventory: { ...settings.inventory, autoMatchShapes: e.target.checked } })
                    }
                  />
                  <span>Give new items the closest drawn shape automatically</span>
                </label>
                <p className="hint">
                  A matched item borrows another shape, and says so with a ≈ next to its name. Your own
                  drawn symbols always win over a borrowed one.
                </p>
              </>
            )}

            {panel === 'updates' && (
              <>
                <div className="setting">
                  <label htmlFor="s-policy">Equipment catalog</label>
                  <select
                    id="s-policy"
                    value={settings.catalog.policy}
                    onChange={(e) =>
                      void patch({
                        catalog: { ...settings.catalog, policy: e.target.value as Settings['catalog']['policy'] },
                      })
                    }
                  >
                    <option value="automatic">Download and install everything</option>
                    <option value="automatic-small">Install small updates quietly</option>
                    <option value="notify">Tell me, and ask first</option>
                    <option value="manual">Only when I check</option>
                  </select>
                </div>

                {settings.catalog.policy === 'automatic-small' && (
                  <div className="setting">
                    <label htmlFor="s-small">Small means under</label>
                    <div className="setting-inline">
                      <input
                        id="s-small"
                        className="num"
                        value={settings.catalog.smallUpdateLimitMb}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n > 0) {
                            void patch({ catalog: { ...settings.catalog, smallUpdateLimitMb: n } });
                          }
                        }}
                      />
                      <span className="hint">MB</span>
                    </div>
                  </div>
                )}

                <div className="setting">
                  <label htmlFor="s-interval">Check every</label>
                  <div className="setting-inline">
                    <input
                      id="s-interval"
                      className="num"
                      value={settings.catalog.checkIntervalHours}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n > 0) {
                          void patch({ catalog: { ...settings.catalog, checkIntervalHours: n } });
                        }
                      }}
                    />
                    <span className="hint">hours while the application is open</span>
                  </div>
                </div>

                <div className="settings-divider" />

                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={settings.app.checkOnLaunch}
                    onChange={(e) => void patch({ app: { ...settings.app, checkOnLaunch: e.target.checked } })}
                  />
                  <span>Look for a new version of Groundplan at launch</span>
                </label>

                <div className="settings-actions">
                  <button onClick={() => void api.checkAppUpdate()}>Check for updates now</button>
                </div>
                <p className="hint">
                  When a new Groundplan build is available you can update now, later, or schedule a
                  reminder — and save open work before the restart. Checking also looks for a signed
                  equipment catalog. Both are verified before anything is installed, and the copy you
                  have is kept until the new one is in place.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="sheet-actions settings-footer">
          <span className={`settings-saved${saved ? ' is-on' : ''}`}>Saved</span>
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
