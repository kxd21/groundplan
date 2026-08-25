/**
 * The plan, written down.
 *
 * Every phase before this produces a fact about the drawing: how big the room
 * is, how many it seats, which decks build the stage, what is short in the
 * warehouse, which seats cannot see the screen. Individually each is a panel in
 * the app. Together they are the document that gets sent to the client and the
 * one the crew works from, and assembling it by hand is exactly the retyping
 * this project exists to remove.
 *
 * Rendered as Markdown because it is readable as text, prints through the
 * existing PDF path, and pastes into an email without turning into a mess.
 */

import type { Allocation } from './allocation.js';
import { allocationCsv, summariseAllocation } from './allocation.js';
import type { SightlineSummary } from './av.js';
import type { PlacedItem } from './definition.js';
import { seatCount } from './definition.js';
import type { LegendEntry, LoadSummary, TitleBlock } from './layers.js';
import type { cableSchedule } from './cable.js';
import { allCapacities, describeRoom, roomArea, roomPerimeter, type RoomModel } from './room.js';
import type { SeatingSolution } from './seating-plan.js';
import type { BuildListLine, StageBuild, StageSolution } from './stage.js';
import { stageBuildList, stageWarnings } from './stage.js';
import { formatArea, formatLength, type UnitSystem } from './units.js';

export interface ReportInput {
  title: TitleBlock;
  units: UnitSystem;
  room?: RoomModel;
  items?: PlacedItem[];
  seating?: SeatingSolution;
  stage?: { build: StageBuild; solution: StageSolution };
  allocation?: Allocation[];
  sightlines?: SightlineSummary;
  legend?: LegendEntry[];
  /** Weight and power by layer, for rigging and distro planning. */
  load?: LoadSummary;
  /** Cable footage by type, for the pull. */
  cable?: ReturnType<typeof cableSchedule>;
  /** Anything the caller wants said at the top. */
  warnings?: string[];
}

function table(headers: string[], rows: string[][]): string[] {
  if (!rows.length) return [];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

/**
 * Builds the report.
 *
 * Sections appear only when there is something to say — a plan with no stage
 * gets no stage section rather than an empty heading, because a report full of
 * "None" is a report people stop reading.
 */
export function buildReport(input: ReportInput): string {
  const lines: string[] = [];
  const { units } = input;

  lines.push(`# ${input.title.plan}`, '');

  const facts: string[][] = [];
  if (input.title.venue) facts.push(['Venue', input.title.venue]);
  if (input.title.client) facts.push(['Client', input.title.client]);
  if (input.title.event) facts.push(['Event', input.title.event]);
  if (input.title.date) facts.push(['Date', input.title.date]);
  facts.push(['Scale', input.title.scale]);
  if (input.title.drawnBy) facts.push(['Drawn by', input.title.drawnBy]);
  if (input.title.revision) facts.push(['Revision', input.title.revision]);
  lines.push(...table(['', ''], facts), '');

  if (input.warnings?.length) {
    lines.push('## Check before issuing', '');
    for (const warning of input.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  if (input.room && input.room.walls.length >= 3) {
    const room = input.room;
    lines.push('## Room', '');
    lines.push(`${describeRoom(room)}`, '');
    lines.push(
      ...table(
        ['', ''],
        [
          ['Floor area', formatArea(roomArea(room), units)],
          ['Perimeter', formatLength(roomPerimeter(room), units)],
          ['Walls', `${room.walls.length}`],
          ...(room.holes.length ? [['Cut-outs', `${room.holes.length}`]] : []),
          ...(room.ceilingHeight ? [['Ceiling', formatLength(room.ceilingHeight, units)]] : []),
        ],
      ),
      '',
    );

    lines.push('### Capacity by layout', '');
    lines.push('Estimated from usable floor area. Not an occupancy figure. That depends on exits and local code.', '');
    lines.push(
      ...table(
        ['Layout', 'People', 'Allowance'],
        allCapacities(room).map((c) => [
          c.layout,
          c.low === c.high ? `${c.low}` : `${c.low}–${c.high}`,
          `${c.squareFeetEach} sq ft each`,
        ]),
      ),
      '',
    );
  }

  if (input.seating && (input.seating.seats.length || input.seating.tables.length)) {
    const seating = input.seating;
    lines.push('## Seating', '');
    lines.push(
      ...table(
        ['', ''],
        [
          ['Seats', `${seating.seats.length}`],
          ...(seating.tables.length ? [['Tables', `${seating.tables.length}`]] : []),
          ...(seating.rowCount ? [['Rows', `${seating.rowCount}`]] : []),
        ],
      ),
      '',
    );
    for (const note of seating.notes) lines.push(`- ${note}`);
    if (seating.notes.length) lines.push('');
  }

  if (input.items?.length) {
    const seats = seatCount(input.items);
    if (seats.total) {
      lines.push('## Seats provided by the furniture', '');
      lines.push(`${seats.total} seats.`);
      if (seats.estimated) lines.push(`${seats.estimated} of those come from estimated seat counts.`);
      lines.push('');
    }
  }

  if (input.stage) {
    const { build, solution } = input.stage;
    lines.push(`## ${build.name}`, '');

    const buildList: BuildListLine[] = stageBuildList(build, solution);
    lines.push(
      ...table(
        ['Item', 'Qty', 'Note'],
        buildList.map((l) => [l.item, `${l.quantity}`, l.detail ?? '']),
      ),
      '',
    );

    const notes = [...solution.notes, ...stageWarnings(build)];
    if (notes.length) {
      lines.push('**Watch:**', '');
      for (const note of notes) lines.push(`- ${note}`);
      lines.push('');
    }
  }

  if (input.sightlines && input.sightlines.total) {
    const s = input.sightlines;
    lines.push('## Sightlines', '');
    lines.push(
      ...table(
        ['Verdict', 'Seats'],
        [
          ['Clear', `${s.clear}`],
          ...(s.tooClose ? [['Too close', `${s.tooClose}`]] : []),
          ...(s.tooFar ? [['Too far', `${s.tooFar}`]] : []),
          ...(s.offAxis ? [['Off axis', `${s.offAxis}`]] : []),
          ...(s.blocked ? [['Blocked', `${s.blocked}`]] : []),
        ],
      ),
      '',
    );
    for (const note of s.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  if (input.allocation?.length) {
    const summary = summariseAllocation(input.allocation);
    lines.push('## Equipment', '');
    for (const note of summary.notes) lines.push(`- ${note}`);
    lines.push('');
    lines.push(
      ...table(
        ['Item', 'Needed', 'Owned', 'Left', 'Short'],
        input.allocation
          .filter((a) => a.state !== 'conceptual')
          .map((a) => [
            a.estimated ? `${a.name} *` : a.name,
            `${a.placed}`,
            a.owned == null ? '—' : `${a.owned}`,
            a.remaining == null ? '—' : `${a.remaining}`,
            a.shortfall ? `**${a.shortfall}**` : '',
          ]),
      ),
      '',
    );
    if (input.allocation.some((a) => a.estimated)) lines.push('\\* size estimated from the item name.', '');
  }

  if (input.load?.lines.length) {
    lines.push('## Weight and power', '');
    lines.push(
      ...table(
        ['Layer', 'Items', 'Weight (lb)', 'Power (W)'],
        input.load.lines.map((line) => [
          line.layer,
          line.unknown ? `${line.counted} (+${line.unknown} unrated)` : String(line.counted),
          line.weightLb ? Math.round(line.weightLb).toLocaleString() : '—',
          line.powerW ? Math.round(line.powerW).toLocaleString() : '—',
        ]),
      ),
    );
    lines.push('');
    lines.push(
      `**Total ${Math.round(input.load.totalWeightLb).toLocaleString()} lb · ` +
        `${Math.round(input.load.totalPowerW).toLocaleString()} W ` +
        `(${input.load.ampsAt120V.toFixed(1)} A at 120V single phase)**`,
    );
    if (input.load.unknown) {
      lines.push(
        '',
        `${input.load.unknown} item${input.load.unknown === 1 ? '' : 's'} carry no weight or ` +
          'power figure and are not in these totals. Add them on the item in Inventory ' +
          'to bring them in.',
      );
    }
    lines.push(
      '',
      'Planning figures only: a straight sum with no derating, power factor or ' +
        'inrush allowance. Not a substitute for an electrician or a rigger.',
      '',
    );
  }

  if (input.cable?.lines.length) {
    lines.push('## Cable', '');
    lines.push(
      ...table(
        ['Type', 'Runs', 'Drawn (ft)', 'Order (ft)'],
        input.cable.lines.map((line) => [
          line.label,
          String(line.runs),
          line.feet.toFixed(0),
          String(line.orderFeet),
        ]),
      ),
    );
    lines.push('');
    lines.push(
      `**${input.cable.totalFeet.toFixed(0)} ft drawn · ` +
        `${input.cable.totalOrderFeet} ft to order**`,
    );
    lines.push(
      '',
      'Order footage rounds each run up to the next stock length. The difference ' +
        'from the drawn total is slack, not waste — a run cut to the drawn length ' +
        'arrives short.',
      '',
    );
  }

  if (input.legend?.length) {
    lines.push('## Legend', '');
    let current = '';
    for (const entry of input.legend) {
      if (entry.layer !== current) {
        current = entry.layer;
        lines.push('', `**${current}**`, '');
      }
      lines.push(`- ${entry.count} × ${entry.name}`);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** The pull sheet on its own, for the warehouse. */
export function buildPullSheet(allocation: Allocation[]): string {
  return allocationCsv(allocation.filter((a) => a.state !== 'conceptual'));
}
