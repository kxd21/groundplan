/**
 * Remembering what the user said about an application update.
 *
 * The quiet launch check must not nag every eight seconds: "Later" and
 * "Schedule…" write a small reminder so the same version stays silent until
 * the chosen time. A newer version always clears the old decision. Manual
 * "Check for updates" ignores the reminder and offers again.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const REMINDER_FILENAME = 'app-update-reminder.json';

export interface AppUpdateReminder {
  /** Version these choices apply to. */
  version?: string;
  /** Quiet launch checks stay silent until this time for `version`. */
  silentUntil?: string;
  /** When set, offer the update again at/after this time. */
  remindAt?: string;
}

export interface ScheduleOption {
  id: string;
  label: string;
  at: Date;
}

export type OfferDecision =
  | { offer: true }
  | { offer: false; reason: 'later' | 'scheduled' };

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function emptyReminder(): AppUpdateReminder {
  return {};
}

export function parseReminder(raw: unknown): AppUpdateReminder {
  if (!raw || typeof raw !== 'object') return emptyReminder();
  const value = raw as Partial<AppUpdateReminder>;
  const out: AppUpdateReminder = {};
  if (typeof value.version === 'string' && value.version.trim()) {
    out.version = value.version.trim();
  }
  if (isIso(value.silentUntil)) out.silentUntil = new Date(value.silentUntil).toISOString();
  if (isIso(value.remindAt)) out.remindAt = new Date(value.remindAt).toISOString();
  return out;
}

export function reminderPath(userDataDir: string): string {
  return join(userDataDir, REMINDER_FILENAME);
}

export async function loadReminder(userDataDir: string): Promise<AppUpdateReminder> {
  try {
    return parseReminder(JSON.parse(await readFile(reminderPath(userDataDir), 'utf8')));
  } catch {
    return emptyReminder();
  }
}

export async function saveReminder(userDataDir: string, reminder: AppUpdateReminder): Promise<void> {
  const path = reminderPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  const cleaned = parseReminder(reminder);
  await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
}

export async function clearReminder(userDataDir: string): Promise<void> {
  await saveReminder(userDataDir, emptyReminder());
}

/**
 * Whether a quiet (launch) check should show the update prompt.
 *
 * Interactive checks always offer — the Settings button must not be a no-op
 * after someone chose Later.
 */
export function shouldOfferUpdate(
  reminder: AppUpdateReminder,
  latestVersion: string,
  now = new Date(),
  interactive = false,
): OfferDecision {
  if (interactive) return { offer: true };
  if (!latestVersion || reminder.version !== latestVersion) return { offer: true };

  if (reminder.remindAt) {
    const at = Date.parse(reminder.remindAt);
    if (Number.isFinite(at) && at > now.getTime()) {
      return { offer: false, reason: 'scheduled' };
    }
    // Due or past — offer again.
    return { offer: true };
  }

  if (reminder.silentUntil) {
    const until = Date.parse(reminder.silentUntil);
    if (Number.isFinite(until) && until > now.getTime()) {
      return { offer: false, reason: 'later' };
    }
  }

  return { offer: true };
}

/** "Update later" — stay quiet for a day on this version. */
export function reminderAfterLater(version: string, now = new Date()): AppUpdateReminder {
  const silentUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    version,
    silentUntil: silentUntil.toISOString(),
  };
}

/** "Schedule…" — remind at a chosen wall-clock time. */
export function reminderAfterSchedule(version: string, remindAt: Date): AppUpdateReminder {
  return {
    version,
    remindAt: remindAt.toISOString(),
  };
}

/**
 * Concrete schedule choices for the follow-up dialog.
 *
 * Times are local. "Tonight" rolls to tomorrow if it is already past 6pm;
 * "Tomorrow morning" is always the next calendar day's 9:00.
 */
export function scheduleOptions(now = new Date()): ScheduleOption[] {
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const inFourHours = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  const tonight = new Date(now);
  tonight.setHours(18, 0, 0, 0);
  if (tonight.getTime() <= now.getTime()) {
    tonight.setDate(tonight.getDate() + 1);
  }

  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(9, 0, 0, 0);

  return [
    { id: '1h', label: 'In 1 hour', at: inOneHour },
    { id: '4h', label: 'In 4 hours', at: inFourHours },
    { id: 'tonight', label: 'Tonight at 6:00 PM', at: tonight },
    { id: 'tomorrow', label: 'Tomorrow morning at 9:00 AM', at: tomorrowMorning },
  ];
}

/** Milliseconds until a scheduled reminder, or null when it should not arm. */
export function msUntilReminder(reminder: AppUpdateReminder, latestVersion: string, now = new Date()): number | null {
  if (!reminder.remindAt || reminder.version !== latestVersion) return null;
  const at = Date.parse(reminder.remindAt);
  if (!Number.isFinite(at)) return null;
  const wait = at - now.getTime();
  return wait > 0 ? wait : 0;
}

export function formatReminderTime(at: Date): string {
  return at.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
