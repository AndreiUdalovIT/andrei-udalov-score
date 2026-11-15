import { describe, expect, it } from 'vitest';

import { MATCH_STATUSES } from '@/lib/types/football';

import {
  canPublishPrediction,
  type PredictionTiming,
} from './prediction-eligibility';

const fixture = Object.freeze({
  status: 'TIMED' as const,
  utcDate: new Date('2026-11-15T18:00:00Z'),
  homeTeamId: 57,
  awayTeamId: 61,
});
const timing: Readonly<PredictionTiming> = Object.freeze({
  dataCutoff: new Date('2026-11-15T17:00:00Z'),
  calculatedAt: new Date('2026-11-15T17:01:00Z'),
  publishedAt: new Date('2026-11-15T17:02:00Z'),
});

describe('prematch prediction publication eligibility', () => {
  it.each(['SCHEDULED', 'TIMED'] as const)(
    'allows publication for a %s fixture before kickoff',
    (status) => {
      expect(canPublishPrediction({ ...fixture, status }, timing)).toBe(true);
    },
  );

  it.each(
    MATCH_STATUSES.filter((status) => status !== 'SCHEDULED' && status !== 'TIMED'),
  )('rejects publication for a %s fixture', (status) => {
    expect(canPublishPrediction({ ...fixture, status }, timing)).toBe(false);
  });

  it.each([
    { homeTeamId: null, awayTeamId: 61 },
    { homeTeamId: 57, awayTeamId: null },
    { homeTeamId: 57, awayTeamId: 57 },
  ])('requires two known, different teams: %j', (teams) => {
    expect(canPublishPrediction({ ...fixture, ...teams }, timing)).toBe(false);
  });

  it.each([
    { offset: -1, allowed: true },
    { offset: 0, allowed: false },
    { offset: 1, allowed: false },
  ])(
    'checks actual publication at kickoff offset $offset milliseconds',
    ({ offset, allowed }) => {
      expect(
        canPublishPrediction(fixture, {
          ...timing,
          publishedAt: new Date(fixture.utcDate.getTime() + offset),
        }),
      ).toBe(allowed);
    },
  );

  it('allows equal cutoff, calculation and publication times before kickoff', () => {
    expect(
      canPublishPrediction(fixture, {
        dataCutoff: timing.publishedAt,
        calculatedAt: timing.publishedAt,
        publishedAt: timing.publishedAt,
      }),
    ).toBe(true);
  });

  it('rejects a data cutoff later than calculation completion', () => {
    expect(
      canPublishPrediction(fixture, {
        ...timing,
        dataCutoff: new Date(timing.calculatedAt.getTime() + 1),
      }),
    ).toBe(false);
  });

  it('rejects calculation completion later than publication', () => {
    expect(
      canPublishPrediction(fixture, {
        ...timing,
        calculatedAt: new Date(timing.publishedAt.getTime() + 1),
      }),
    ).toBe(false);
  });

  it.each(['dataCutoff', 'calculatedAt', 'publishedAt'] as const)(
    'rejects an invalid %s',
    (field) => {
      expect(
        canPublishPrediction(fixture, {
          ...timing,
          [field]: new Date(NaN),
        }),
      ).toBe(false);
    },
  );

  it('rejects an invalid kickoff date', () => {
    expect(
      canPublishPrediction({ ...fixture, utcDate: new Date(NaN) }, timing),
    ).toBe(false);
  });

  it('uses the current kickoff when a fixture is rescheduled', () => {
    expect(
      canPublishPrediction({ ...fixture, utcDate: timing.publishedAt }, timing),
    ).toBe(false);
    expect(
      canPublishPrediction(
        { ...fixture, utcDate: new Date('2026-11-16T18:00:00Z') },
        timing,
      ),
    ).toBe(true);
  });

  it('compares instants consistently across UTC offsets', () => {
    expect(
      canPublishPrediction(
        { ...fixture, utcDate: new Date('2026-11-15T21:00:00+03:00') },
        {
          ...timing,
          publishedAt: new Date('2026-11-15T20:59:59.999+03:00'),
        },
      ),
    ).toBe(true);
  });
});
