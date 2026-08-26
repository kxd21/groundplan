/**
 * The show, described — and the drawing measured against it.
 *
 * Two cards that sit above the room and layout tools rather than wrapping
 * them: a summary of the brief that opens into a focused editor, and a review
 * that says whether the plan satisfies what the brief asked for.
 *
 * Deliberately not one long form. A brief has thirty fields and nobody fills
 * in thirty fields; the summary shows the handful that are set, and each group
 * opens only when somebody wants it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  describeBrief,
  LAYOUT_TYPES,
  SHOW_STATUSES,
  type ShowBrief,
} from '../../format/show-brief.js';
import { describeReadiness, type ReadinessReport, type IssueTarget } from '../../format/readiness.js';
import { IconCheck, IconEdit, IconWarning } from './icons.js';

interface BriefProps {
  brief: ShowBrief | null;
  busy?: boolean;
  editable: boolean;
  onSave: (patch: Partial<ShowBrief>) => void | Promise<void>;
  /** Opened by the review card when it points at a group. */
  openGroup?: BriefGroup | null;
  onOpenGroupHandled?: () => void;
}

export type BriefGroup = 'basic' | 'venue' | 'layout' | 'constraints';

const GROUPS: ReadonlyArray<{ id: BriefGroup; label: string; hint: string }> = [
  { id: 'basic', label: 'Show', hint: 'Name, client, job number, dates' },
  { id: 'venue', label: 'Venue & room', hint: 'Where it happens, and who to ask' },
  { id: 'layout', label: 'Layout goals', hint: 'Headcount, layout, stage, screens' },
  { id: 'constraints', label: 'Constraints', hint: 'Aisles, access, rigging, power, egress' },
];

/** A brief field as a controlled text input that commits on blur. */
function Field({
  id,
  label,
  value,
  onCommit,
  placeholder,
  type = 'text',
  disabled,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'date' | 'number';
  disabled?: boolean;
  hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);

  // Follow the stored value unless the user is mid-edit, so a save elsewhere
  // does not clobber what somebody is typing.
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const commit = () => {
    dirty.current = false;
    if (draft !== value) onCommit(draft);
  };

  /*
   * Commit on unmount too.
   *
   * These fields save on blur, and a disclosure group can be collapsed — or
   * the whole dock closed — while one still has focus, which unmounts the
   * input without ever firing blur. Losing a venue name because somebody hit
   * the close button instead of tabbing out is not an acceptable way to lose
   * work. `latest` is a ref so the cleanup sees the final draft rather than
   * the one captured on first render.
   */
  const latest = useRef({ draft, value, onCommit });
  latest.current = { draft, value, onCommit };
  useEffect(
    () => () => {
      const { draft: d, value: v, onCommit: commitFn } = latest.current;
      if (dirty.current && d !== v) commitFn(d);
    },
    [],
  );

  return (
    <div className="brief-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            (event.target as HTMLInputElement).blur();
          }
          if (event.key === 'Escape') {
            dirty.current = false;
            setDraft(value);
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function Toggle({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: boolean | undefined;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="brief-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function ShowBriefCard({
  brief,
  busy,
  editable,
  onSave,
  openGroup = null,
  onOpenGroupHandled,
}: BriefProps) {
  const [open, setOpen] = useState<BriefGroup | null>(null);

  // The review card can point straight at the group that fixes an issue.
  useEffect(() => {
    if (!openGroup) return;
    setOpen(openGroup);
    onOpenGroupHandled?.();
  }, [openGroup, onOpenGroupHandled]);

  const set = (patch: Partial<ShowBrief>) => void onSave(patch);
  const text = (key: keyof ShowBrief): string => {
    const v = brief?.[key];
    return v == null ? '' : String(v);
  };
  const num = (key: keyof ShowBrief): string => {
    const v = brief?.[key];
    return typeof v === 'number' ? String(v) : '';
  };
  const commitNumber = (key: keyof ShowBrief) => (next: string) => {
    const parsed = Number(next);
    set({ [key]: next.trim() === '' || !Number.isFinite(parsed) ? '' : parsed } as Partial<ShowBrief>);
  };

  const summary = brief ? describeBrief(brief) : '';
  const named = brief?.name.trim();

  return (
    <section className="section brief-card" aria-label="Show brief">
      <div className="section-title">
        <span>Brief</span>
        {brief ? (
          <span className={`brief-status is-${brief.status}`}>
            {SHOW_STATUSES.find((s) => s.id === brief.status)?.label}
          </span>
        ) : null}
      </div>

      <div className="brief-summary">
        <strong>{named || 'This show has no name yet'}</strong>
        <small>{summary || 'Describe the show once, and the plan gets checked against it.'}</small>
      </div>

      <div className="brief-groups">
        {GROUPS.map((group) => {
          const isOpen = open === group.id;
          return (
            <div key={group.id} className={`brief-group${isOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="brief-group-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : group.id)}
              >
                <span className="brief-group-copy">
                  <strong>{group.label}</strong>
                  <small>{group.hint}</small>
                </span>
                <span className="brief-group-mark" aria-hidden>
                  <IconEdit size={13} />
                </span>
              </button>

              {isOpen ? (
                <div className="brief-group-body">
                  {group.id === 'basic' ? (
                    <>
                      <Field id="brief-name" label="Show name" value={text('name')} disabled={!editable || busy}
                        placeholder="Northwind Global Kickoff" onCommit={(v) => set({ name: v })} />
                      <Field id="brief-client" label="Client" value={text('client')} disabled={!editable || busy}
                        onCommit={(v) => set({ client: v })} />
                      <Field id="brief-job" label="Job number" value={text('jobNumber')} disabled={!editable || busy}
                        onCommit={(v) => set({ jobNumber: v })} />
                      <div className="brief-field">
                        <label htmlFor="brief-status">Status</label>
                        <select
                          id="brief-status"
                          value={brief?.status ?? 'planning'}
                          disabled={!editable || busy}
                          onChange={(event) => set({ status: event.target.value as ShowBrief['status'] })}
                        >
                          {SHOW_STATUSES.map((s) => (
                            <option key={s.id} value={s.id}>{s.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="brief-pair">
                        <Field id="brief-start" label="Event start" type="date" value={text('eventStart')}
                          disabled={!editable || busy} onCommit={(v) => set({ eventStart: v })} />
                        <Field id="brief-end" label="Event end" type="date" value={text('eventEnd')}
                          disabled={!editable || busy} onCommit={(v) => set({ eventEnd: v })} />
                      </div>
                      <div className="brief-pair">
                        <Field id="brief-loadin" label="Load-in" value={text('loadIn')} disabled={!editable || busy}
                          placeholder="12 Sep, 06:00" onCommit={(v) => set({ loadIn: v })} />
                        <Field id="brief-loadout" label="Load-out" value={text('loadOut')} disabled={!editable || busy}
                          placeholder="16 Sep, 23:00" onCommit={(v) => set({ loadOut: v })} />
                      </div>
                    </>
                  ) : null}

                  {group.id === 'venue' ? (
                    <>
                      <Field id="brief-venue" label="Venue" value={text('venue')} disabled={!editable || busy}
                        placeholder="Marriott Marquis" onCommit={(v) => set({ venue: v })} />
                      <Field id="brief-room" label="Room name" value={text('roomName')} disabled={!editable || busy}
                        placeholder="Grand Ballroom East" hint="Prints on the title block with the venue."
                        onCommit={(v) => set({ roomName: v })} />
                      <Field id="brief-address" label="Address" value={text('address')} disabled={!editable || busy}
                        onCommit={(v) => set({ address: v })} />
                      <div className="brief-pair">
                        <Field id="brief-venue-contact" label="Venue contact" value={text('venueContact')}
                          disabled={!editable || busy} onCommit={(v) => set({ venueContact: v })} />
                        <Field id="brief-prod-contact" label="Production contact" value={text('productionContact')}
                          disabled={!editable || busy} onCommit={(v) => set({ productionContact: v })} />
                      </div>
                      <Field id="brief-access" label="Loading and access" value={text('accessNotes')}
                        disabled={!editable || busy} placeholder="Dock 3, 12ft clearance"
                        onCommit={(v) => set({ accessNotes: v })} />
                    </>
                  ) : null}

                  {group.id === 'layout' ? (
                    <>
                      <Field id="brief-attendance" label="Target attendance" type="number" value={num('targetAttendance')}
                        disabled={!editable || busy} placeholder="850"
                        hint="The number the finished plan is checked against."
                        onCommit={commitNumber('targetAttendance')} />
                      <div className="brief-field">
                        <label htmlFor="brief-layout">Layout type</label>
                        <select
                          id="brief-layout"
                          value={brief?.layoutType ?? ''}
                          disabled={!editable || busy}
                          onChange={(event) =>
                            set({ layoutType: (event.target.value || '') as ShowBrief['layoutType'] })
                          }
                        >
                          <option value="">Not decided</option>
                          {LAYOUT_TYPES.map((l) => (
                            <option key={l.id} value={l.id}>{l.label}</option>
                          ))}
                        </select>
                      </div>
                      <Toggle id="brief-stage" label="A stage is required" value={brief?.stageRequired}
                        disabled={!editable || busy} onChange={(v) => set({ stageRequired: v })} />
                      {brief?.stageRequired ? (
                        <div className="brief-triple">
                          <Field id="brief-stage-w" label="Width ft" type="number" value={num('stageWidthFt')}
                            disabled={!editable || busy} onCommit={commitNumber('stageWidthFt')} />
                          <Field id="brief-stage-d" label="Depth ft" type="number" value={num('stageDepthFt')}
                            disabled={!editable || busy} onCommit={commitNumber('stageDepthFt')} />
                          <Field id="brief-stage-h" label="Height in" type="number" value={num('stageHeightIn')}
                            disabled={!editable || busy} onCommit={commitNumber('stageHeightIn')} />
                        </div>
                      ) : null}
                      <Toggle id="brief-screens" label="Screens or A/V are required" value={brief?.screensRequired}
                        disabled={!editable || busy} onChange={(v) => set({ screensRequired: v })} />
                      <Toggle id="brief-tables" label="Tables are required" value={brief?.tablesRequired}
                        disabled={!editable || busy} onChange={(v) => set({ tablesRequired: v })} />
                    </>
                  ) : null}

                  {group.id === 'constraints' ? (
                    <>
                      <div className="brief-pair">
                        <Field id="brief-aisle" label="Min aisle (in)" type="number" value={num('minAisleIn')}
                          disabled={!editable || busy} placeholder="44" onCommit={commitNumber('minAisleIn')} />
                        <Field id="brief-accessible" label="Accessible seats" type="number" value={num('accessibleSeats')}
                          disabled={!editable || busy} placeholder="12" onCommit={commitNumber('accessibleSeats')} />
                      </div>
                      <Toggle id="brief-rigging" label="Rigging is allowed" value={brief?.riggingAllowed}
                        disabled={!editable || busy} onChange={(v) => set({ riggingAllowed: v })} />
                      <Field id="brief-rigging-notes" label="Rigging notes" value={text('riggingNotes')}
                        disabled={!editable || busy} onCommit={(v) => set({ riggingNotes: v })} />
                      <Field id="brief-power" label="Power" value={text('powerNotes')} disabled={!editable || busy}
                        placeholder="400A three phase, stage left" onCommit={(v) => set({ powerNotes: v })} />
                      <Field id="brief-egress" label="Exits and egress" value={text('egressNotes')}
                        disabled={!editable || busy} placeholder="Four exits, none blocked by seating"
                        onCommit={(v) => set({ egressNotes: v })} />
                      <Field id="brief-notes" label="Production notes" value={text('productionNotes')}
                        disabled={!editable || busy} onCommit={(v) => set({ productionNotes: v })} />
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface ReviewProps {
  report: ReadinessReport;
  onGoTo: (target: IssueTarget) => void;
  /** Revision and drawn-by ride with the sheet, so they are edited here. */
  revision: string;
  drawnBy: string;
  onRevision: (next: string) => void;
  onDrawnBy: (next: string) => void;
  onPrint: () => void;
  printDisabled?: boolean;
}

export function ReviewCard({
  report,
  onGoTo,
  revision,
  drawnBy,
  onRevision,
  onDrawnBy,
  onPrint,
  printDisabled,
}: ReviewProps) {
  const { level, issues, seats } = report;

  const rows = useMemo(() => {
    const out: Array<{ label: string; value: string; ok: boolean | null }> = [];

    /*
     * Both directions are worth saying. A shortfall is the obvious one; spare
     * capacity is what tells a planner they can drop a bank and widen the
     * aisles, and it reads as an oversight when the panel stays silent about
     * seating 200 more people than anyone invited.
     */
    const spare = seats.shortfall == null ? null : -seats.shortfall;
    out.push({
      label: 'Seats',
      value:
        seats.target == null
          ? `${seats.actual.toLocaleString()} drawn`
          : `${seats.actual.toLocaleString()} of ${seats.target.toLocaleString()}` +
            (spare == null || spare === 0
              ? ''
              : spare > 0
                ? ` · ${spare.toLocaleString()} spare`
                : ` · ${(-spare).toLocaleString()} short`),
      ok: seats.shortfall == null ? null : seats.shortfall <= 0,
    });

    if (report.layoutLabel) out.push({ label: 'Layout', value: report.layoutLabel, ok: null });

    // Only report on things the brief actually asked for. A stage nobody
    // wanted is not a missing stage.
    if (report.stage.required != null) {
      out.push({
        label: 'Stage',
        value: report.stage.found ? 'On the drawing' : 'Not drawn',
        ok: report.stage.found,
      });
    }
    if (report.screens.required != null) {
      out.push({
        label: 'Screens / AV',
        value: report.screens.found ? 'On the drawing' : 'Not drawn',
        ok: report.screens.found,
      });
    }
    if (report.accessible.required != null) {
      out.push({
        label: 'Accessible',
        value: `${report.accessible.found} of ${report.accessible.required}`,
        ok: report.accessible.found >= report.accessible.required,
      });
    }
    return out;
  }, [report, seats]);

  return (
    <section className="section review-card" aria-label="Review and issue">
      <div className="section-title">
        <span>Review &amp; issue</span>
        <span className={`review-state is-${level}`}>
          {level === 'ready' ? 'Ready' : level === 'attention' ? 'Needs attention' : 'Incomplete'}
        </span>
      </div>

      <p className="review-headline">{describeReadiness(report)}</p>

      <dl className="review-facts">
        {rows.map((row) => (
          <div key={row.label} className={row.ok === false ? 'is-off' : undefined}>
            <dt>{row.label}</dt>
            <dd>
              {row.ok === true ? <IconCheck size={12} /> : row.ok === false ? <IconWarning size={12} /> : null}
              <span>{row.value}</span>
            </dd>
          </div>
        ))}
      </dl>

      {issues.length ? (
        <ul className="review-issues">
          {issues.map((issue) => (
            <li key={issue.id} className={`is-${issue.severity}`}>
              <span className="review-issue-copy">
                <strong>{issue.title}</strong>
                {issue.detail ? <small>{issue.detail}</small> : null}
              </span>
              <button type="button" onClick={() => onGoTo(issue.target)}>
                {issue.action}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="review-issue-block">
        <div className="brief-pair">
          <div className="brief-field">
            <label htmlFor="review-drawn-by">Drawn by</label>
            <input
              id="review-drawn-by"
              value={drawnBy}
              placeholder="Name or company"
              onChange={(event) => onDrawnBy(event.target.value)}
            />
          </div>
          <div className="brief-field">
            <label htmlFor="review-revision">Revision</label>
            <input
              id="review-revision"
              value={revision}
              placeholder="A"
              maxLength={12}
              onChange={(event) => onRevision(event.target.value)}
            />
          </div>
        </div>
        {/*
          Printing is never blocked. A drawing that does not yet satisfy the
          brief is still a drawing somebody may need to send — the point is
          that they see the state above before they issue it, not that they
          are stopped.
        */}
        <button type="button" className="btn-primary review-print" onClick={onPrint} disabled={printDisabled}>
          Print to PDF…
        </button>
      </div>
    </section>
  );
}
