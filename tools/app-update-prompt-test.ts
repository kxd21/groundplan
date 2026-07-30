/**
 * Application update reminder decisions — Later / Schedule / offer again.
 *
 *   npx tsx tools/app-update-prompt-test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearReminder,
  formatReminderTime,
  loadReminder,
  msUntilReminder,
  parseReminder,
  reminderAfterLater,
  reminderAfterSchedule,
  saveReminder,
  scheduleOptions,
  shouldOfferUpdate,
} from '../src/update/reminder.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  pass  ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const now = new Date('2026-07-30T15:00:00.000Z');

check(
  'a fresh reminder always offers',
  shouldOfferUpdate({}, '1.2.0', now).offer,
);

const later = reminderAfterLater('1.2.0', now);
check('later records the version', later.version === '1.2.0');
check('later is silent for quiet checks', !shouldOfferUpdate(later, '1.2.0', now).offer);
check(
  'later still offers on interactive check',
  shouldOfferUpdate(later, '1.2.0', now, true).offer,
);
check(
  'a newer version ignores the old later',
  shouldOfferUpdate(later, '1.3.0', now).offer,
);
check(
  'later expires after a day',
  shouldOfferUpdate(later, '1.2.0', new Date(now.getTime() + 25 * 60 * 60 * 1000)).offer,
);

const scheduledAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
const scheduled = reminderAfterSchedule('1.2.0', scheduledAt);
check('schedule stores remindAt', scheduled.remindAt === scheduledAt.toISOString());
check('schedule stays quiet before the time', !shouldOfferUpdate(scheduled, '1.2.0', now).offer);
check(
  'schedule offers when due',
  shouldOfferUpdate(scheduled, '1.2.0', new Date(scheduledAt.getTime() + 1000)).offer,
);
check(
  'msUntilReminder matches the wait',
  msUntilReminder(scheduled, '1.2.0', now) === 2 * 60 * 60 * 1000,
  `${msUntilReminder(scheduled, '1.2.0', now)}`,
);

const options = scheduleOptions(new Date('2026-07-30T10:00:00'));
check('schedule options include four choices', options.length === 4);
check(
  'tonight is later today when before 6pm',
  options.find((o) => o.id === 'tonight')!.at.getHours() === 18,
);

const evening = scheduleOptions(new Date('2026-07-30T19:00:00'));
const tonight = evening.find((o) => o.id === 'tonight')!;
check(
  'tonight rolls to tomorrow after 6pm',
  tonight.at.getDate() === 31 && tonight.at.getHours() === 18,
);

check('formatReminderTime is non-empty', formatReminderTime(scheduledAt).length > 0);
check('parseReminder drops junk', parseReminder({ version: 3, remindAt: 'nope' }).version == null);

const root = mkdtempSync(join(tmpdir(), 'groundplan-update-reminder-'));
async function main(): Promise<void> {
  await saveReminder(root, later);
  const loaded = await loadReminder(root);
  check('reminder round-trips on disk', loaded.version === '1.2.0' && !!loaded.silentUntil);
  await clearReminder(root);
  const cleared = await loadReminder(root);
  check('clear empties the reminder', !cleared.version && !cleared.silentUntil && !cleared.remindAt);

  rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall app-update prompt checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
