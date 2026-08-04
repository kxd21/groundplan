import { useEffect } from 'react';

import type { PlanBackground } from '../../format/companion.js';
import type { Extent } from '../../format/index.js';
import type { UnitSystem } from '../../format/units.js';
import BackgroundLayerPanel from './BackgroundLayerPanel.js';

interface Props {
  background: PlanBackground | null;
  extent: Extent | null;
  units: UnitSystem;
  onPreview: (background: PlanBackground | null) => void;
  onCommit: (background: PlanBackground | null, message?: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/** Detailed background workflow opened by the ribbon's Background button. */
export default function BackgroundImageDialog({ onClose, ...panelProps }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="sheet-backdrop background-dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet background-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="background-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="background-dialog-header">
          <span>
            <small>Plan underlay</small>
            <strong id="background-dialog-title">Background Studio</strong>
          </span>
          <p>Align a venue image beneath the editable plot and control how it appears on screen and in exports.</p>
          <button type="button" onClick={onClose} aria-label="Close Background Studio">×</button>
        </header>
        <div className="background-dialog-body">
          <BackgroundLayerPanel {...panelProps} expanded />
        </div>
        <footer className="sheet-actions background-dialog-footer">
          <span>Changes save automatically with this plan.</span>
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
