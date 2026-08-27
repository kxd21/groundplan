import { Fragment, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';

import DockTitlebar from './DockTitlebar.js';
import { IconEdit, IconMore, IconSidebarLeft, IconSidebarRight } from './icons.js';

export interface PlanDockTool {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

export type PlanToolDockSide = 'left' | 'right' | 'floating';

interface Props {
  compact: boolean;
  /**
   * Rendered as a panel in the Plan dock rather than floated over the sheet.
   *
   * The shelf used to be the only dark surface in a light application, sat on
   * top of the ruler it was covering, and carried four unlabelled window
   * controls of its own. Docked it is one of five panels that all look and
   * close the same way, and it can afford to label its tools.
   */
  docked?: boolean;
  groups: PlanDockTool[][];
  /** Short scan labels for the groups above. Hidden by the compact floating shelf. */
  groupLabels?: string[];
  foreground: string;
  paper: boolean;
  side: PlanToolDockSide;
  position: { x: number; y: number };
  order: string[];
  hidden: string[];
  onToggleCompact: () => void;
  onClose: () => void;
  onForeground: () => void;
  onBackground: () => void;
  onSide: (side: PlanToolDockSide) => void;
  onPosition: (position: { x: number; y: number }) => void;
  onOrder: (order: string[]) => void;
  onHidden: (hidden: string[]) => void;
}

interface DragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Persistent, customizable plan tool shelf.
 *
 * Drag its grip to float it over the sheet, or release near either edge to
 * dock it. The Customize panel changes both visibility and order without
 * making the command unavailable elsewhere in the app.
 */
export default function PlanToolDock({
  compact,
  docked = false,
  groups,
  groupLabels = [],
  foreground,
  paper,
  side,
  position,
  order,
  hidden,
  onToggleCompact,
  onClose,
  onForeground,
  onBackground,
  onSide,
  onPosition,
  onOrder,
  onHidden,
}: Props) {
  const [customizing, setCustomizing] = useState(false);
  const dockRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const allTools = groups.flat();
  const toolById = new Map(allTools.map((tool) => [tool.id, tool]));
  const groupById = new Map(
    groups.flatMap((group, groupIndex) => group.map((tool) => [tool.id, groupIndex] as const)),
  );
  const canonicalOrder = allTools.map((tool) => tool.id);
  const orderedIds = [
    ...order.filter((id, index) => toolById.has(id) && order.indexOf(id) === index),
    ...canonicalOrder.filter((id) => !order.includes(id)),
  ];
  const hiddenSet = new Set(hidden.filter((id) => toolById.has(id)));
  const visibleTools = orderedIds.map((id) => toolById.get(id)!).filter((tool) => !hiddenSet.has(tool.id));
  const activeTool = visibleTools.find((tool) => tool.active);

  const moveTool = (id: string, delta: -1 | 1) => {
    const from = orderedIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[from], next[to]] = [next[to]!, next[from]!];
    onOrder(next);
  };

  const toggleTool = (id: string) => {
    const next = new Set(hiddenSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onHidden([...next]);
  };

  const cycleSide = () => {
    onSide(side === 'left' ? 'right' : side === 'right' ? 'floating' : 'left');
  };

  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const dock = dockRef.current;
    const parent = dock?.parentElement;
    if (!dock || !parent) return;
    const dockBounds = dock.getBoundingClientRect();
    const parentBounds = parent.getBoundingClientRect();
    const nextPosition = {
      x: dockBounds.left - parentBounds.left,
      y: dockBounds.top - parentBounds.top,
    };
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - dockBounds.left,
      offsetY: event.clientY - dockBounds.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onPosition(nextPosition);
    if (side !== 'floating') onSide('floating');
    event.preventDefault();
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const dock = dockRef.current;
    const parent = dock?.parentElement;
    if (!drag || drag.pointerId !== event.pointerId || !dock || !parent) return;
    const parentBounds = parent.getBoundingClientRect();
    const dockBounds = dock.getBoundingClientRect();
    const maxX = Math.max(0, parentBounds.width - dockBounds.width);
    const maxY = Math.max(0, parentBounds.height - Math.min(dockBounds.height, parentBounds.height));
    onPosition({
      x: Math.max(0, Math.min(maxX, event.clientX - parentBounds.left - drag.offsetX)),
      y: Math.max(0, Math.min(maxY, event.clientY - parentBounds.top - drag.offsetY)),
    });
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const dock = dockRef.current;
    const parent = dock?.parentElement;
    if (!drag || drag.pointerId !== event.pointerId || !dock || !parent) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const parentBounds = parent.getBoundingClientRect();
    const dockBounds = dock.getBoundingClientRect();
    const centre = dockBounds.left + dockBounds.width / 2 - parentBounds.left;
    if (centre < 72) onSide('left');
    else if (centre > parentBounds.width - 72) onSide('right');
  };

  const style =
    !docked && side === 'floating'
      ? ({ left: `${position.x}px`, top: `${position.y}px` } satisfies CSSProperties)
      : undefined;

  // Docked, the panel is as wide as every other one in the dock, so hiding the
  // tool names to save room would be saving room that is already there.
  const showLabels = docked || !compact;

  const customizeButton = (
    <button
      type="button"
      className={`plan-tool-customize${customizing ? ' is-active' : ''}`}
      onClick={() => setCustomizing((open) => !open)}
      aria-label="Customize toolbar"
      aria-expanded={customizing}
      title="Customize toolbar"
      data-tooltip="Customize toolbar"
    >
      <IconEdit size={12} />
    </button>
  );

  return (
    <aside
      ref={dockRef}
      className={`plan-tool-dock ${docked ? 'is-docked' : `is-${side}`}${compact && !docked ? ' is-compact' : ''}`}
      style={style}
      aria-label="Plan tools"
    >
      {docked ? (
        <DockTitlebar
          title="Draw tools"
          sub={
            activeTool
              ? `${activeTool.label}${activeTool.shortcut ? ` · ${activeTool.shortcut}` : ''}`
              : 'Annotate, measure, and run cables'
          }
          trailing={customizeButton}
          onClose={onClose}
          closeLabel="Close Draw tools"
        />
      ) : (
      <header
        className="plan-tool-dock-head"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to move the toolbar"
      >
        <span className="plan-tool-grip" aria-hidden>••••</span>
        {customizeButton}
        <button
          type="button"
          onClick={cycleSide}
          aria-label={`Move toolbar ${side === 'left' ? 'right' : side === 'right' ? 'to a floating position' : 'left'}`}
          title={`Move toolbar ${side === 'left' ? 'right' : side === 'right' ? 'to a floating position' : 'left'}`}
          data-tooltip={`Dock: ${side === 'left' ? 'move right' : side === 'right' ? 'float' : 'move left'}`}
        >
          {side === 'left' ? <IconSidebarRight size={12} /> : side === 'right' ? <IconMore size={12} /> : <IconSidebarLeft size={12} />}
        </button>
        <button
          type="button"
          onClick={onToggleCompact}
          aria-label={compact ? 'Expand tool palette' : 'Collapse tool palette'}
          title={compact ? 'Expand toolbar' : 'Collapse toolbar'}
          data-tooltip={compact ? 'Expand toolbar' : 'Collapse toolbar'}
        >
          {compact ? '»' : '«'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tool palette"
          title="Close toolbar"
          data-tooltip="Close toolbar"
        >
          ×
        </button>
      </header>
      )}

      <div
        className="plan-tool-dock-groups"
        tabIndex={0}
        role="region"
        aria-label="Scrollable plan tools"
        onWheel={(event) => {
          const tools = event.currentTarget;
          const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
          if (!delta) return;
          const before = tools.scrollTop;
          tools.scrollTop += delta;
          if (tools.scrollTop !== before) event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="plan-tool-dock-group is-custom-order">
          {visibleTools.map((item, index) => {
            const tip = `${item.label}${item.shortcut ? ` (${item.shortcut})` : ''}`;
            const groupIndex = groupById.get(item.id) ?? -1;
            const previousGroupIndex = index > 0 ? groupById.get(visibleTools[index - 1]!.id) ?? -1 : -2;
            const groupLabel = groupLabels[groupIndex];
            return (
              <Fragment key={item.id}>
                {docked && groupLabel && groupIndex !== previousGroupIndex ? (
                  <div className="plan-tool-group-label">{groupLabel}</div>
                ) : null}
                <button
                  type="button"
                  className={item.active ? 'is-active' : ''}
                  onClick={item.onClick}
                  disabled={item.disabled}
                  data-tool-id={item.id}
                  aria-label={tip}
                  aria-pressed={!!item.active}
                  title={tip}
                  data-tooltip={tip}
                >
                  <span className="plan-tool-icon" aria-hidden="true">{item.icon}</span>
                  {showLabels && <span className="plan-tool-label">{item.label}</span>}
                  {showLabels && item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>

      <footer className="plan-tool-colours" aria-label="Drawing colours">
        <button
          type="button"
          className="plan-tool-colour-action"
          onClick={onForeground}
          title="Selection line colour"
          data-tooltip="Selection line colour"
          aria-label="Selection line colour"
        >
          <span className="plan-tool-colour" style={{ background: foreground }} />
          {docked ? (
            <span className="plan-tool-colour-copy">
              <small>Stroke</small>
              <strong>{foreground.toUpperCase()}</strong>
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="plan-tool-colour-action"
          onClick={onBackground}
          title="Plan sheet colour"
          data-tooltip="Plan sheet colour"
          aria-label="Plan sheet colour"
        >
          <span className="plan-tool-colour" style={{ background: paper ? '#ffffff' : '#20252b' }} />
          {docked ? (
            <span className="plan-tool-colour-copy">
              <small>Sheet</small>
              <strong>{paper ? 'Paper' : 'Dark'}</strong>
            </span>
          ) : null}
        </button>
      </footer>

      {customizing && (
        <section className="plan-tool-customizer" aria-label="Customize plan toolbar">
          <header>
            <span>
              <strong>Customize tools</strong>
              <small>Show, hide, and reorder</small>
            </span>
            <button type="button" onClick={() => setCustomizing(false)} aria-label="Close customization">×</button>
          </header>
          <div className="plan-tool-customizer-list">
            {orderedIds.map((id, index) => {
              const tool = toolById.get(id)!;
              return (
                <div className={hiddenSet.has(id) ? 'is-hidden' : ''} key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!hiddenSet.has(id)}
                      disabled={!hiddenSet.has(id) && visibleTools.length === 1}
                      onChange={() => toggleTool(id)}
                      title={!hiddenSet.has(id) && visibleTools.length === 1 ? 'Keep at least one tool visible' : undefined}
                    />
                    <span className="plan-tool-customizer-icon">{tool.icon}</span>
                    <span>{tool.label}</span>
                    {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                  </label>
                  <span className="plan-tool-customizer-order">
                    <button type="button" onClick={() => moveTool(id, -1)} disabled={index === 0} aria-label={`Move ${tool.label} up`}>↑</button>
                    <button type="button" onClick={() => moveTool(id, 1)} disabled={index === orderedIds.length - 1} aria-label={`Move ${tool.label} down`}>↓</button>
                  </span>
                </div>
              );
            })}
          </div>
          <footer>
            <button
              type="button"
              onClick={() => {
                onOrder([]);
                onHidden([]);
              }}
            >
              Reset default toolbar
            </button>
          </footer>
        </section>
      )}
    </aside>
  );
}
