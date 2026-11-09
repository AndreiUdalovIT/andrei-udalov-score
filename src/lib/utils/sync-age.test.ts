import { describe, expect, it } from 'vitest';

import { getSyncAge } from './sync-age';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (elapsed: number) => new Date(NOW - elapsed).toISOString();

describe('getSyncAge', () => {
  it('formats elapsed time across minute, hour and day boundaries', () => {
    for (const [elapsed, label] of [
      [0, 'только что'],
      [59_999, 'только что'],
      [60_000, '1 мин назад'],
      [3_599_999, '59 мин назад'],
      [3_600_000, '1 ч назад'],
      [86_399_999, '23 ч назад'],
      [86_400_000, '1 день назад'],
      [172_800_000, '2 дня назад'],
      [432_000_000, '5 дней назад'],
    ] as const) {
      expect(getSyncAge(ago(elapsed), NOW)?.label).toBe(label);
    }
  });

  it('marks data stale at exactly eight hours', () => {
    expect(getSyncAge(ago(28_799_999), NOW)?.isStale).toBe(false);
    expect(getSyncAge(ago(28_800_000), NOW)?.isStale).toBe(true);
  });

  it('has no age when the timestamp or current time is unavailable', () => {
    expect(getSyncAge(null, NOW)).toBeNull();
    expect(getSyncAge('not-a-date', NOW)).toBeNull();
    expect(getSyncAge(ago(0), Number.NaN)).toBeNull();
  });

  it('avoids negative ages when the visitor clock is behind', () => {
    expect(getSyncAge(new Date(NOW + 60_000).toISOString(), NOW)).toEqual({
      label: 'только что',
      isStale: false,
    });
  });
});
