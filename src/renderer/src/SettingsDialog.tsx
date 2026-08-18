import { useEffect, useRef, useState } from 'react';

import { SnappySlider } from './SnappySlider.js';

const api = window.groundplan;
const FOOT = 120;

interface Settings {
  print: { scale: string; paper: string; landscape: boolean; subtitle: string };
  dxf: { includeSchedule: boolean; visibleLayersOnly: boolean };
  drawing: {
    units: 'imperial' | 'metric';
    snapStep: number;
    objectSnap: boolean;
    showGrid: boolean;
    paperSheet: boolean;
    autoFitOnOpen: boolean;
    openPropertiesOnSelect: boolean;
    showStackPeek: boolean;
    showSightlineMarkers: boolean;
    nudgeStep: number;
    fineNudgeStep: number;
    bulkDeleteWarning: number;
  };
  catalog: {
    policy: 'automatic' | 'automatic-small' | 'notify' | 'manual';
    smallUpdateLimitMb: number;
    checkIntervalHours: number;
  };
  app: { checkOnLaunch: boolean };
  inventory: { autoAbsorbGear: boolean; autoMatchShapes: boolean };
}

export interface SettingsAppPreferences {
  appearance: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'compact';
  showTooltips: boolean;
  railOpen: boolean;
  inspectorOpen: boolean;
  toolDockOpen: boolean;
  toolDockCompact: boolean;
  toolDockSide: 'left' | 'right' | 'floating';
}

type Section = 'plan' | 'app';

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

const PLAN_DEFAULTS: Pick<Settings, 'print' | 'dxf' | 'drawing'> = {
  print: { scale: '1/8', paper: 'Tabloid', landscape: true, subtitle: '' },
  dxf: { includeSchedule: true, visibleLayersOnly: true },
  drawing: {
    units: 'imperial',
    snapStep: 10,
    objectSnap: true,
    showGrid: true,
    paperSheet: true,
    autoFitOnOpen: true,
    openPropertiesOnSelect: true,
    showStackPeek: true,
    showSightlineMarkers: false,
    nudgeStep: 10,
    fineNudgeStep: 1,
    bulkDeleteWarning: 25,
  },
};

const APP_DEFAULTS: SettingsAppPreferences = {
  appearance: 'system',
  density: 'comfortable',
  showTooltips: true,
  railOpen: true,
  inspectorOpen: true,
  toolDockOpen: true,
  toolDockCompact: false,
  toolDockSide: 'left',
};

interface Props {
  appPreferences: SettingsAppPreferences;
  onAppPreferences: (patch: Partial<SettingsAppPreferences>) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Two-level settings hub: plan behaviour and application behaviour. */
export function SettingsDialog({ appPreferences, onAppPreferences, onClose, onError }: Props) {
  const [section, setSection] = useState<Section>('plan');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveSequence = useRef(0);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .settingsGet()
      .then((value) => live && setSettings(value as Settings))
      .catch(() => onError('Settings could not be loaded.'));
    return () => {
      live = false;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
  }, [onError]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const settleSaveState = (state: 'saved' | 'error') => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    setSaveState(state);
    saveTimer.current = window.setTimeout(() => setSaveState('idle'), state === 'saved' ? 1400 : 3200);
  };

  /** Update UI immediately without waiting on IPC (slider drag). */
  const applyLocal = (change: Partial<Settings>) => {
    setSettings((current) => {
      if (!current) return current;
      const next = { ...current } as Settings;
      for (const key of Object.keys(change) as Array<keyof Settings>) {
        next[key] = { ...(current[key] as object), ...(change[key] as object) } as never;
      }
      return next;
    });
  };

  const patch = async (change: Partial<Settings>) => {
    if (!settings) return;
    applyLocal(change);
    const sequence = ++saveSequence.current;
    setSaveState('saving');
    try {
      const reply = await api.settingsPatch(change);
      if (sequence !== saveSequence.current) return;
      if (reply.ok) settleSaveState('saved');
      else {
        settleSaveState('error');
        onError('That setting could not be saved.');
      }
    } catch {
      if (sequence !== saveSequence.current) return;
      settleSaveState('error');
      onError('That setting could not be saved.');
    }
  };

  const patchApp = (change: Partial<SettingsAppPreferences>) => {
    onAppPreferences(change);
    settleSaveState('saved');
  };

  if (!settings) {
    return (
      <div className="sheet-backdrop" onClick={onClose}>
        <div className="sheet settings-sheet settings-sheet-expanded" onClick={(event) => event.stopPropagation()}>
          <p className="hint settings-loading">Loading settings…</p>
        </div>
      </div>
    );
  }

  const drawing = settings.drawing;
  const snapLabel = SNAP_STEPS.find(([value]) => value === drawing.snapStep)?.[1] ?? 'Custom';
  const openPanelCount = [appPreferences.railOpen, appPreferences.inspectorOpen, appPreferences.toolDockOpen]
    .filter(Boolean).length;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className="sheet settings-sheet settings-sheet-expanded"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <span>
            <small>Groundplan preferences</small>
            <strong id="settings-title">Settings</strong>
          </span>
          <span
            className={`settings-saved is-${saveState}${saveState !== 'idle' ? ' is-on' : ''}`}
            role="status"
            aria-live="polite"
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save issue' : 'Saved'}
          </span>
          <button type="button" onClick={onClose} aria-label="Close settings">×</button>
        </header>

        <div className="settings-body settings-body-expanded">
          <nav className="settings-nav settings-primary-nav" aria-label="Settings level">
            <button className={section === 'plan' ? 'active' : ''} onClick={() => setSection('plan')}>
              <strong>Plan</strong>
              <small>Drawing, print, CAD</small>
            </button>
            <button className={section === 'app' ? 'active' : ''} onClick={() => setSection('app')}>
              <strong>App</strong>
              <small>Theme, panels, updates</small>
            </button>
          </nav>

          <main className="settings-panel settings-panel-expanded">
            {section === 'plan' ? (
              <>
                <div className="settings-level-heading">
                  <span><small>Plan level</small><strong>Drawing and document defaults</strong></span>
                  <button type="button" onClick={() => void patch(PLAN_DEFAULTS)}>Restore plan defaults</button>
                </div>

                <div className="settings-health-strip" aria-label="Current plan settings summary">
                  <span><small>Units</small><strong>{drawing.units === 'metric' ? 'Metric' : 'Imperial'}</strong></span>
                  <span><small>Grid snap</small><strong>{snapLabel}</strong></span>
                  <span><small>Bulk safety</small><strong>{drawing.bulkDeleteWarning ? `${drawing.bulkDeleteWarning}+ items` : 'Off'}</strong></span>
                </div>

                <section className="settings-card">
                  <div className="settings-card-title">
                    <strong>Canvas and measurements</strong>
                    <span>How every plan looks and reads when it opens.</span>
                  </div>
                  <div className="settings-grid two">
                    <div className="setting">
                      <label htmlFor="s-units">Measurement system</label>
                      <select
                        id="s-units"
                        value={drawing.units}
                        onChange={(event) => void patch({ drawing: { ...drawing, units: event.target.value === 'metric' ? 'metric' : 'imperial' } })}
                      >
                        <option value="imperial">Feet and inches</option>
                        <option value="metric">Metres and centimetres</option>
                      </select>
                    </div>
                    <div className="setting">
                      <label htmlFor="s-sheet">Default sheet</label>
                      <select
                        id="s-sheet"
                        value={drawing.paperSheet ? 'paper' : 'dark'}
                        onChange={(event) => void patch({ drawing: { ...drawing, paperSheet: event.target.value === 'paper' } })}
                      >
                        <option value="paper">White paper</option>
                        <option value="dark">Dark drafting sheet</option>
                      </select>
                    </div>
                  </div>
                  <div className="settings-check-grid">
                    <label className="setting-check">
                      <input type="checkbox" checked={drawing.showGrid} onChange={(event) => void patch({ drawing: { ...drawing, showGrid: event.target.checked } })} />
                      <span><strong>Show grid</strong><small>Display the drafting grid when a plan opens.</small></span>
                    </label>
                    <label className="setting-check">
                      <input type="checkbox" checked={drawing.autoFitOnOpen} onChange={(event) => void patch({ drawing: { ...drawing, autoFitOnOpen: event.target.checked } })} />
                      <span><strong>Zoom to fit on open</strong><small>Frame the room automatically after loading.</small></span>
                    </label>
                  </div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title">
                    <strong>Snap, movement and selection</strong>
                    <span>Precision, keyboard movement and edit safety.</span>
                  </div>
                  <div className="settings-slider-stack">
                    <SnappySlider
                      label="Grid snap"
                      values={SNAP_STEPS.map(([value]) => value)}
                      defaultValue={FOOT}
                      min={0}
                      max={FOOT * 5}
                      step={10}
                      compact
                      value={drawing.snapStep}
                      config={{
                        snappingThreshold: 8,
                        labelFormatter: (value) =>
                          SNAP_STEPS.find(([step]) => step === value)?.[1] ?? `${value}`,
                      }}
                      onChange={(next) => applyLocal({ drawing: { ...drawing, snapStep: next } })}
                      onChangeEnd={(next) => void patch({ drawing: { ...drawing, snapStep: next } })}
                    />
                    <SnappySlider
                      label="Arrow-key nudge"
                      values={SNAP_STEPS.slice(1).map(([value]) => value)}
                      defaultValue={FOOT}
                      min={10}
                      max={FOOT * 5}
                      step={10}
                      compact
                      value={drawing.nudgeStep}
                      config={{
                        snappingThreshold: 8,
                        labelFormatter: (value) =>
                          SNAP_STEPS.find(([step]) => step === value)?.[1] ?? `${value}`,
                      }}
                      onChange={(next) => applyLocal({ drawing: { ...drawing, nudgeStep: next } })}
                      onChangeEnd={(next) => void patch({ drawing: { ...drawing, nudgeStep: next } })}
                    />
                    <SnappySlider
                      label="Shift + arrow nudge"
                      values={[1, 10, 30, 60, 120]}
                      defaultValue={1}
                      min={1}
                      max={FOOT}
                      step={1}
                      compact
                      value={drawing.fineNudgeStep}
                      config={{
                        snappingThreshold: 4,
                        labelFormatter: (value) =>
                          SNAP_STEPS.find(([step]) => step === value)?.[1] ??
                          (value === 1 ? '1″' : `${value}`),
                      }}
                      onChange={(next) => applyLocal({ drawing: { ...drawing, fineNudgeStep: next } })}
                      onChangeEnd={(next) => void patch({ drawing: { ...drawing, fineNudgeStep: next } })}
                    />
                    <SnappySlider
                      label="Warn before bulk delete"
                      values={[0, 10, 25, 50, 100]}
                      defaultValue={25}
                      min={0}
                      max={100}
                      step={1}
                      suffix=" objs"
                      compact
                      value={drawing.bulkDeleteWarning}
                      onChange={(next) => applyLocal({ drawing: { ...drawing, bulkDeleteWarning: next } })}
                      onChangeEnd={(next) => void patch({ drawing: { ...drawing, bulkDeleteWarning: next } })}
                    />
                  </div>
                  <div className="settings-check-grid">
                    <label className="setting-check">
                      <input type="checkbox" checked={drawing.objectSnap} onChange={(event) => void patch({ drawing: { ...drawing, objectSnap: event.target.checked } })} />
                      <span><strong>Snap to nearby objects</strong><small>Align centres and edges while dragging.</small></span>
                    </label>
                    <label className="setting-check">
                      <input type="checkbox" checked={drawing.openPropertiesOnSelect} onChange={(event) => void patch({ drawing: { ...drawing, openPropertiesOnSelect: event.target.checked } })} />
                      <span><strong>Open Properties on selection</strong><small>Bring the inspector to the selected item.</small></span>
                    </label>
                    <label className="setting-check">
                      <input
                        type="checkbox"
                        checked={drawing.showStackPeek !== false}
                        onChange={(event) => void patch({ drawing: { ...drawing, showStackPeek: event.target.checked } })}
                      />
                      <span>
                        <strong>Stack markers</strong>
                        <small>Hover card and numbered height tags for stacked pieces.</small>
                      </span>
                    </label>
                    <label className="setting-check">
                      <input
                        type="checkbox"
                        checked={drawing.showSightlineMarkers === true}
                        onChange={(event) => void patch({ drawing: { ...drawing, showSightlineMarkers: event.target.checked } })}
                      />
                      <span>
                        <strong>Sightline grades on seats</strong>
                        <small>Colour every chair by A/V view of the screen. Off by default; very busy on large plans.</small>
                      </span>
                    </label>
                  </div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>Print defaults</strong><span>Starting values for Print to PDF.</span></div>
                  <div className="settings-grid three">
                    <div className="setting"><label htmlFor="s-scale">Scale</label><select id="s-scale" value={settings.print.scale} onChange={(event) => void patch({ print: { ...settings.print, scale: event.target.value } })}>{SCALES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
                    <div className="setting"><label htmlFor="s-paper">Paper</label><select id="s-paper" value={settings.print.paper} onChange={(event) => void patch({ print: { ...settings.print, paper: event.target.value } })}>{PAPERS.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
                    <div className="setting"><label htmlFor="s-orientation">Orientation</label><select id="s-orientation" value={settings.print.landscape ? 'landscape' : 'portrait'} onChange={(event) => void patch({ print: { ...settings.print, landscape: event.target.value === 'landscape' } })}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></div>
                  </div>
                  <div className="setting"><label htmlFor="s-subtitle">Default title-block job line</label><input id="s-subtitle" value={settings.print.subtitle} placeholder="Company, client, or project line" onChange={(event) => void patch({ print: { ...settings.print, subtitle: event.target.value } })} /></div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>CAD export defaults</strong><span>Control what accompanies DXF output.</span></div>
                  <div className="settings-check-grid">
                    <label className="setting-check"><input type="checkbox" checked={settings.dxf.includeSchedule} onChange={(event) => void patch({ dxf: { ...settings.dxf, includeSchedule: event.target.checked } })} /><span><strong>Write item schedule</strong><small>Export a schedule beside the DXF.</small></span></label>
                    <label className="setting-check"><input type="checkbox" checked={settings.dxf.visibleLayersOnly} onChange={(event) => void patch({ dxf: { ...settings.dxf, visibleLayersOnly: event.target.checked } })} /><span><strong>Visible layers only</strong><small>Leave hidden plan layers out of CAD exports.</small></span></label>
                  </div>
                </section>
              </>
            ) : (
              <>
                <div className="settings-level-heading">
                  <span><small>Application level</small><strong>Workspace and automation</strong></span>
                  <button type="button" onClick={() => { patchApp(APP_DEFAULTS); void patch({ app: { checkOnLaunch: true }, catalog: { policy: 'notify', smallUpdateLimitMb: 5, checkIntervalHours: 12 }, inventory: { autoAbsorbGear: false, autoMatchShapes: false } }); }}>Restore app defaults</button>
                </div>

                <div className="settings-health-strip" aria-label="Current application settings summary">
                  <span><small>Theme</small><strong>{appPreferences.appearance === 'system' ? 'System' : appPreferences.appearance === 'dark' ? 'Dark' : 'Light'}</strong></span>
                  <span><small>Density</small><strong>{appPreferences.density === 'compact' ? 'Compact' : 'Comfortable'}</strong></span>
                  <span><small>Panels open</small><strong>{openPanelCount}/3</strong></span>
                </div>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>Appearance</strong><span>Theme, information density and help cues.</span></div>
                  <div className="settings-grid two">
                    <div className="setting"><label htmlFor="s-theme">Interface theme</label><select id="s-theme" value={appPreferences.appearance} onChange={(event) => patchApp({ appearance: event.target.value as SettingsAppPreferences['appearance'] })}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
                    <div className="setting"><label htmlFor="s-density">Panel density</label><select id="s-density" value={appPreferences.density} onChange={(event) => patchApp({ density: event.target.value === 'compact' ? 'compact' : 'comfortable' })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div>
                  </div>
                  <label className="setting-check"><input type="checkbox" checked={appPreferences.showTooltips} onChange={(event) => patchApp({ showTooltips: event.target.checked })} /><span><strong>Show tool names on hover</strong><small>Display toolbar and control explanations.</small></span></label>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>Workspace panels</strong><span>Choose the surfaces that stay visible while planning.</span></div>
                  <div className="settings-check-grid three">
                    <label className="setting-check"><input type="checkbox" checked={appPreferences.railOpen} onChange={(event) => patchApp({ railOpen: event.target.checked })} /><span><strong>Browse / Place rail</strong><small>Recent plans and equipment stamping.</small></span></label>
                    <label className="setting-check"><input type="checkbox" checked={appPreferences.inspectorOpen} onChange={(event) => patchApp({ inspectorOpen: event.target.checked })} /><span><strong>Inspect panel</strong><small>Layers, properties, and room tools.</small></span></label>
                    <label className="setting-check"><input type="checkbox" checked={appPreferences.toolDockOpen} onChange={(event) => patchApp({ toolDockOpen: event.target.checked })} /><span><strong>Draw tools dock</strong><small>Movable drawing-tool shelf.</small></span></label>
                  </div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>Side toolbar</strong><span>Default position and footprint of the movable tool palette.</span></div>
                  <div className="settings-grid two">
                    <div className="setting"><label htmlFor="s-dock-side">Dock position</label><select id="s-dock-side" value={appPreferences.toolDockSide} disabled={!appPreferences.toolDockOpen} onChange={(event) => patchApp({ toolDockSide: event.target.value as SettingsAppPreferences['toolDockSide'] })}><option value="left">Left</option><option value="right">Right</option><option value="floating">Floating</option></select></div>
                    <div className="setting"><label htmlFor="s-dock-size">Toolbar size</label><select id="s-dock-size" value={appPreferences.toolDockCompact ? 'compact' : 'standard'} disabled={!appPreferences.toolDockOpen} onChange={(event) => patchApp({ toolDockCompact: event.target.value === 'compact' })}><option value="standard">Standard</option><option value="compact">Compact</option></select></div>
                  </div>
                  <p className={`settings-note${appPreferences.toolDockOpen ? '' : ' is-dependency-warning'}`}>
                    {appPreferences.toolDockOpen
                      ? 'Tool order and hidden tools stay on the gear button on the Draw dock.'
                      : 'Turn on Draw tools dock under Workspace panels to change its position or size.'}
                  </p>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>Inventory automation</strong><span>Decide how imported gear becomes reusable plan objects.</span></div>
                  <div className="settings-check-grid">
                    <label className="setting-check"><input type="checkbox" checked={settings.inventory.autoAbsorbGear} onChange={(event) => void patch({ inventory: { ...settings.inventory, autoAbsorbGear: event.target.checked } })} /><span><strong>Absorb imported gear</strong><small>Add new gear-list items to this computer’s inventory.</small></span></label>
                    <label className="setting-check"><input type="checkbox" checked={settings.inventory.autoMatchShapes} onChange={(event) => void patch({ inventory: { ...settings.inventory, autoMatchShapes: event.target.checked } })} /><span><strong>Auto-match drawn shapes</strong><small>Give unshaped items the closest known symbol.</small></span></label>
                  </div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-title"><strong>Updates</strong><span>Application and equipment-catalog update behaviour.</span></div>
                  <div className="settings-grid three">
                    <div className="setting"><label htmlFor="s-policy">Catalog updates</label><select id="s-policy" value={settings.catalog.policy} onChange={(event) => void patch({ catalog: { ...settings.catalog, policy: event.target.value as Settings['catalog']['policy'] } })}><option value="automatic">Install automatically</option><option value="automatic-small">Install small updates</option><option value="notify">Notify and ask</option><option value="manual">Manual only</option></select></div>
                  </div>
                  <div className="settings-slider-stack">
                    <SnappySlider
                      label="Small update limit"
                      values={[1, 5, 10, 25, 50]}
                      defaultValue={5}
                      min={1}
                      max={50}
                      step={1}
                      suffix=" MB"
                      compact
                      disabled={settings.catalog.policy !== 'automatic-small'}
                      value={settings.catalog.smallUpdateLimitMb}
                      onChange={(next) =>
                        applyLocal({ catalog: { ...settings.catalog, smallUpdateLimitMb: next } })
                      }
                      onChangeEnd={(next) =>
                        void patch({ catalog: { ...settings.catalog, smallUpdateLimitMb: next } })
                      }
                    />
                    <SnappySlider
                      label="Check interval"
                      values={[1, 6, 12, 24, 48, 72]}
                      defaultValue={12}
                      min={1}
                      max={72}
                      step={1}
                      suffix=" h"
                      compact
                      value={settings.catalog.checkIntervalHours}
                      onChange={(next) =>
                        applyLocal({ catalog: { ...settings.catalog, checkIntervalHours: next } })
                      }
                      onChangeEnd={(next) =>
                        void patch({ catalog: { ...settings.catalog, checkIntervalHours: next } })
                      }
                    />
                  </div>
                  <div className="settings-actions-row">
                    <label className="setting-check"><input type="checkbox" checked={settings.app.checkOnLaunch} onChange={(event) => void patch({ app: { checkOnLaunch: event.target.checked } })} /><span><strong>Check at launch</strong><small>Look for a new Groundplan build shortly after startup.</small></span></label>
                    <button type="button" onClick={() => void api.checkAppUpdate()}>Check now</button>
                  </div>
                </section>
              </>
            )}
          </main>
        </div>

        <footer className="sheet-actions settings-footer">
          <span>Changes save automatically</span>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
