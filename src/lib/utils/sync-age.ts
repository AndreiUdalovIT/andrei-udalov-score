import { plural } from './plural';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STALE_AFTER = 8 * HOUR;

/** Elapsed time since a successful sync; the caller supplies the current time. */
export function getSyncAge(lastSyncedAt: string | null, now: number) {
  if (!lastSyncedAt) return null;

  const timestamp = Date.parse(lastSyncedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return null;

  const elapsed = Math.max(0, now - timestamp);
  let label = 'только что';

  if (elapsed >= DAY) {
    const days = Math.floor(elapsed / DAY);
    label = `${days} ${plural(days, ['день', 'дня', 'дней'])} назад`;
  } else if (elapsed >= HOUR) {
    label = `${Math.floor(elapsed / HOUR)} ч назад`;
  } else if (elapsed >= MINUTE) {
    label = `${Math.floor(elapsed / MINUTE)} мин назад`;
  }

  return { label, isStale: elapsed >= STALE_AFTER };
}
