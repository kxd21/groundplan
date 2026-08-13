import { useEffect, useMemo, useRef, useState } from 'react';

import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';

export interface EditablePointPath {
  nodeId: number;
  cls: string;
  closed: boolean;
  canEdit: boolean;
  reason?: string;
  points: Array<{
    index: number;
    x: number;
    y: number;
    role: 'anchor' | 'control';
  }>;
}

interface Props {
  paths: EditablePointPath[];
  units: UnitSystem;
  editable: boolean;
  onMovePoint: (pathNodeId: number, pointIndex: number, x: number, y: number) => Promise<boolean>;
  onSetPathKind: (pathNodeId: number, kind: 'line' | 'curve') => Promise<boolean>;
  onError: (message: string) => void;
}

interface Draft {
  x: string;
  y: string;
}

const keyFor = (nodeId: number, pointIndex: number) => `${nodeId}:${pointIndex}`;

export default function PointEditor({ paths, units, editable, onMovePoint, onSetPathKind, onError }: Props) {
  const [openPaths, setOpenPaths] = useState<Set<number>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [changingPath, setChangingPath] = useState<number | null>(null);
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const focusedKeyRef = useRef<string | null>(null);
  const pathSignature = useMemo(
    () => paths.map((path) => `${path.nodeId}:${path.points.map((point) => `${point.index},${point.x},${point.y}`).join(';')}`).join('|'),
    [paths],
  );

  useEffect(() => {
    setDrafts((current) => {
      const next: Record<string, Draft> = {};
      for (const path of paths) {
        for (const point of path.points) {
          const key = keyFor(path.nodeId, point.index);
          const incoming = {
            x: formatLength(point.x, units),
            y: formatLength(point.y, units),
          };
          // Keep mid-edit drafts for focused or dirty rows; sync the rest from geometry.
          if (
            (focusedKeyRef.current === key || dirtyKeysRef.current.has(key)) &&
            current[key]
          ) {
            next[key] = current[key];
          } else {
            next[key] = incoming;
            dirtyKeysRef.current.delete(key);
          }
        }
      }
      return next;
    });
    setOpenPaths((current) => {
      const live = new Set(paths.map((path) => path.nodeId));
      const kept = new Set([...current].filter((id) => live.has(id)));
      if (!kept.size && paths[0]) kept.add(paths[0].nodeId);
      return kept;
    });
  }, [pathSignature, units, paths]);

  if (!paths.length) {
    return (
      <div className="point-editor-empty">
        <strong>No editable outline found</strong>
        <p>Select a line, room edge, drawn shape, or symbol with writable geometry.</p>
      </div>
    );
  }

  const commit = async (path: EditablePointPath, pointIndex: number) => {
    const key = keyFor(path.nodeId, pointIndex);
    const draft = drafts[key];
    const x = draft ? parseLength(draft.x, units) : null;
    const y = draft ? parseLength(draft.y, units) : null;
    if (x == null || y == null) {
      onError(
        units === 'metric'
          ? 'Enter point coordinates as lengths, for example 2.4m.'
          : 'Enter point coordinates as lengths, for example 8\' 6".',
      );
      return;
    }
    const ok = await onMovePoint(path.nodeId, pointIndex, x, y);
    if (ok) dirtyKeysRef.current.delete(key);
  };

  const setPathKind = async (path: EditablePointPath, kind: 'line' | 'curve') => {
    const current = path.cls === 'RVSegmentArc' ? 'curve' : 'line';
    if (current === kind || changingPath != null) return;
    setChangingPath(path.nodeId);
    try {
      await onSetPathKind(path.nodeId, kind);
    } finally {
      setChangingPath(null);
    }
  };

  return (
    <div className="point-editor">
      <div className="point-editor-intro">
        <strong>Edit points</strong>
        <span>Drag blue anchors and round handles on the plan, or enter exact coordinates below. Hold Alt while dragging to bypass snap.</span>
      </div>
      {paths.map((path, pathIndex) => {
        const open = openPaths.has(path.nodeId);
        const currentKind = path.cls === 'RVSegmentArc' ? 'curve' : 'line';
        const canChooseKind = path.cls === 'RVSegmentArc' ||
          ((path.cls === 'RVSegmentLine' || path.cls === 'RVSegmentPoly') && path.points.length === 2);
        return (
          <section className="point-path" key={path.nodeId}>
            <button
              type="button"
              className="point-path-toggle"
              aria-expanded={open}
              onClick={() =>
                setOpenPaths((current) => {
                  const next = new Set(current);
                  if (next.has(path.nodeId)) next.delete(path.nodeId);
                  else next.add(path.nodeId);
                  return next;
                })
              }
            >
              <span className="disclosure" aria-hidden>{open ? '⌄' : '›'}</span>
              <span>Path {pathIndex + 1}</span>
              <small>{path.cls.replace(/^RVSegment/, '')} · {path.points.length} points</small>
            </button>
            {open && (
              <div className="point-path-body">
                {!path.canEdit && <p className="point-path-warning">{path.reason ?? 'This path is read only.'}</p>}
                {canChooseKind && (
                  <div className="point-path-kind">
                    <span>
                      <strong>Segment shape</strong>
                      <small>{currentKind === 'curve' ? 'Drag either round handle to shape the curve.' : 'Convert to a curve to reveal Bézier handles.'}</small>
                    </span>
                    <div role="group" aria-label={`Path ${pathIndex + 1} segment shape`}>
                      <button
                        type="button"
                        className={currentKind === 'line' ? 'is-active' : ''}
                        aria-pressed={currentKind === 'line'}
                        disabled={!editable || !path.canEdit || changingPath === path.nodeId}
                        onClick={() => void setPathKind(path, 'line')}
                        title="Use a straight segment between the two anchors"
                      >
                        <span className="point-kind-symbol is-line" aria-hidden />
                        Straight
                      </button>
                      <button
                        type="button"
                        className={currentKind === 'curve' ? 'is-active' : ''}
                        aria-pressed={currentKind === 'curve'}
                        disabled={!editable || !path.canEdit || changingPath === path.nodeId}
                        onClick={() => void setPathKind(path, 'curve')}
                        title="Convert to a cubic curve with two draggable handles"
                      >
                        <span className="point-kind-symbol is-curve" aria-hidden />
                        Curve
                      </button>
                    </div>
                  </div>
                )}
                {path.points.map((point, index) => {
                  const key = keyFor(path.nodeId, point.index);
                  const draft = drafts[key] ?? { x: '', y: '' };
                  return (
                    <div className="point-row" key={key}>
                      <span className={`point-kind is-${point.role}`} title={point.role === 'control' ? 'Bézier control handle' : 'Anchor point'}>
                        {point.role === 'control' ? '○' : '◆'}
                      </span>
                      <span className="point-number">{index + 1}</span>
                      <label>
                        <span>X</span>
                        <input
                          value={draft.x}
                          disabled={!editable || !path.canEdit}
                          onFocus={() => {
                            focusedKeyRef.current = key;
                          }}
                          onChange={(event) => {
                            dirtyKeysRef.current.add(key);
                            setDrafts((current) => ({ ...current, [key]: { ...draft, x: event.target.value } }));
                          }}
                          onBlur={() => {
                            if (focusedKeyRef.current === key) focusedKeyRef.current = null;
                            void commit(path, point.index);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void commit(path, point.index);
                          }}
                        />
                      </label>
                      <label>
                        <span>Y</span>
                        <input
                          value={draft.y}
                          disabled={!editable || !path.canEdit}
                          onFocus={() => {
                            focusedKeyRef.current = key;
                          }}
                          onChange={(event) => {
                            dirtyKeysRef.current.add(key);
                            setDrafts((current) => ({ ...current, [key]: { ...draft, y: event.target.value } }));
                          }}
                          onBlur={() => {
                            if (focusedKeyRef.current === key) focusedKeyRef.current = null;
                            void commit(path, point.index);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void commit(path, point.index);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={!editable || !path.canEdit}
                        onClick={() => void commit(path, point.index)}
                        aria-label={`Apply point ${index + 1} coordinates`}
                        title="Apply coordinates"
                      >
                        ✓
                      </button>
                    </div>
                  );
                })}
                {path.closed && <p className="point-path-note">The last point reconnects to the first.</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
