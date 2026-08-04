import { IconPointer, IconText, IconWarning } from './icons.js';
import type { CSSProperties, RefObject } from 'react';

const QUICK_LABELS = [
  'STAGE',
  'SCREEN',
  'FOH',
  'REGISTRATION',
  'ENTRANCE',
  'EXIT',
  'BACKSTAGE',
  'DANCE FLOOR',
  'BUFFET',
  'BAR',
  'RESTROOMS',
  'DO NOT BLOCK',
];

const TEXT_COLORS = ['#20252b', '#ffffff', '#0877d8', '#d33d3d', '#d58a16', '#248554', '#7952b3'];

interface Props {
  active: boolean;
  editable: boolean;
  text: string;
  color: string;
  platform: string;
  styleHint?: string | null;
  inputRef: RefObject<HTMLTextAreaElement>;
  onText: (text: string) => void;
  onColor: (color: string) => void;
  onStart: () => void;
  onDone: () => void;
}

/** Focused composer for the repeatable label stamp used by both toolbars. */
export default function TextToolPanel({
  active,
  editable,
  text,
  color,
  platform,
  styleHint,
  inputRef,
  onText,
  onColor,
  onStart,
  onDone,
}: Props) {
  const trimmed = text.trim();
  const lines = trimmed ? text.split(/\r?\n/).length : 0;
  const shortcut = platform === 'darwin' ? '⌘' : 'Ctrl';

  return (
    <div className="text-tool-workspace">
      <div className={active ? 'text-tool-hero is-active' : 'text-tool-hero'}>
        <span className="text-tool-hero-icon"><IconText size={20} /></span>
        <span className="text-tool-hero-copy">
          <small>Annotation tool</small>
          <strong>{active ? 'Text ready to place' : 'Add text to the plan'}</strong>
          <span>{active ? 'Click anywhere on the drawing. The tool stays active for repeated labels.' : 'Compose a label, choose its color, then start placement.'}</span>
        </span>
        <b>{active ? 'ACTIVE' : 'T'}</b>
      </div>

      <div className="text-tool-flow" aria-label="Text placement workflow">
        <span className={trimmed ? 'is-complete' : 'is-current'}><b>1</b> Write</span>
        <span className={active ? 'is-current' : trimmed ? '' : undefined}><b>2</b> Place</span>
        <span><b>3</b> Select to edit</span>
      </div>

      <div className="text-tool-card">
        <div className="text-tool-card-title">
          <span><strong>Label text</strong><small>Multi-line labels are supported.</small></span>
          <em className={text.length > 230 ? 'is-warning' : ''}>{text.length}/254 · {lines} line{lines === 1 ? '' : 's'}</em>
        </div>
        <textarea
          id="annotation-text"
          ref={inputRef}
          rows={4}
          maxLength={254}
          value={text}
          placeholder={'Type a room name, production note, or callout…\nPress Enter for another line.'}
          onChange={(event) => onText(event.target.value)}
          disabled={!editable}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              onStart();
            }
          }}
        />
        <span className="text-tool-key-hint">{shortcut}+Enter starts placement · Esc puts the tool down</span>
      </div>

      <div className="text-tool-card">
        <div className="text-tool-card-title">
          <span><strong>Quick labels</strong><small>Use a common venue callout as a starting point.</small></span>
        </div>
        <div className="text-quick-labels">
          {QUICK_LABELS.map((label) => (
            <button
              type="button"
              key={label}
              className={trimmed === label ? 'is-active' : ''}
              onClick={() => onText(label)}
              disabled={!editable}
              title={`Use “${label}”`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="text-tool-card">
        <div className="text-tool-card-title">
          <span><strong>Text color</strong><small>Stored with every label you place in this run.</small></span>
          <code>{color.toUpperCase()}</code>
        </div>
        <div className="text-color-row">
          <input
            type="color"
            value={color}
            onChange={(event) => onColor(event.target.value)}
            disabled={!editable}
            aria-label="Text color"
          />
          <div className="text-color-presets" aria-label="Text color presets">
            {TEXT_COLORS.map((hex) => (
              <button
                type="button"
                key={hex}
                className={color.toLowerCase() === hex ? 'is-active' : ''}
                style={{ '--text-swatch': hex } as CSSProperties}
                onClick={() => onColor(hex)}
                disabled={!editable}
                aria-label={`Use text color ${hex}`}
                title={hex}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="text-tool-preview" aria-label="Text preview">
        <small>Preview</small>
        <div style={{ color }}>
          {trimmed || 'Your text will appear here'}
        </div>
      </div>

      {styleHint && (
        <div className="notice annotation-capability-notice" role="status">
          <IconWarning size={14} />
          <span>{styleHint}</span>
        </div>
      )}

      <div className="text-tool-actions">
        <button type="button" onClick={() => onText('')} disabled={!editable || !text}>Clear</button>
        {active && <button type="button" onClick={onDone}>Done placing</button>}
        <button type="button" className="primary" onClick={onStart} disabled={!editable || !trimmed}>
          <IconPointer size={14} />
          {active ? 'Update text in hand' : 'Start placing text'}
        </button>
      </div>

      <p className="text-tool-aftercare">
        After placement, choose Select and double-click a label to edit it directly on the plan. Quick formatting appears above; full typography stays in Properties.
      </p>
    </div>
  );
}
