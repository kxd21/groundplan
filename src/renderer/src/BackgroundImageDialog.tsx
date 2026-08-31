import { useEffect } from 'react';

import type { PlanBackground } from '../../format/companion.js';
import type { Extent } from '../../format/index.js';
import type { UnitSystem } from '../../format/units.js';
import BackgroundLayerPanel from './BackgroundLayerPanel.js';
import { IconLayers } from './icons.js';
import SheetHeader from './SheetHeader.js';

interface Props {
  background: PlanBackground | null;
  extent: Extent | null;
  units: UnitSystem;
  onPreview: (background: PlanBackground | null) => void;
  onCommit: (background: PlanBackground | null, message?: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onStartTwoPointScale?: () => void;
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
        <SheetHeader
          eyebrow="Plan underlay"
          title="Background Studio"
          subtitle="Align a venue image beneath the plot · control screen and export visibility"
          titleId="background-dialog-title"
          mark={<IconLayers size={18} />}
          onClose={onClose}
        />
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
