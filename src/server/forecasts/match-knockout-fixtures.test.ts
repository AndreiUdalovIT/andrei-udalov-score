import { describe, expect, it } from 'vitest';

import type { ChampionsLeagueKnockoutObservation } from '@/lib/model/champions-league-knockout-observation';
import { createChampionsLeagueKnockoutFixtureLookup } from '@/lib/model/match-knockout-fixtures';

type Match = ChampionsLeagueKnockoutObservation;

const season = 2026;
const officialPair = {
  stage: 'PLAYOFFS',
  source: 'official',
  season,
  firstTeamId: 1,
  secondTeamId: 2,
  firstLegHomeTeamId: 2,
} as const;
const officialFinal = {
  source: 'official',
  season,
  silver: { club: { teamId: 1 } },
  blue: { club: { teamId: 2 } },
} as const;

function firstLeg(overrides: Partial<Match> = {}): Match {
  return {
    matchId: 90,
    stage: 'PLAYOFFS',
    utcDate: new Date('2027-02-16T20:00:00Z'),
    observedAt: new Date('2027-02-16T23:00:00Z'),
    status: 'FINISHED',
    homeTeamId: 2,
    awayTeamId: 1,
    result: {
      regulation: {
        kind: 'known-result',
        homeTeamId: 2,
        awayTeamId: 1,
        homeGoals90: 2,
        awayGoals90: 0,
      },
      extraTime: null,
      penalties: null,
    },
    ...overrides,
  };
}

function secondLeg(overrides: Partial<Match> = {}): Match {
  return {
    matchId: 80,
    stage: 'PLAYOFFS',
    utcDate: new Date('2027-02-23T20:00:00Z'),
    observedAt: new Date('2027-02-16T23:00:00Z'),
    status: 'TIMED',
    homeTeamId: 1,
    awayTeamId: 2,
    result: null,
    ...overrides,
  };
}

describe('createChampionsLeagueKnockoutFixtureLookup', () => {
  it.each(['PLAYOFFS', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS'] as const)(
    'finds both legs in kickoff order and preserves their states in %s',
    (stage) => {
      const first = firstLeg({ stage });
      const second = secondLeg({ stage });
      const lookup = createChampionsLeagueKnockoutFixtureLookup(season, [
        second,
        secondLeg({ matchId: 77, stage: 'FINAL' }),
        first,
      ]);

      expect(lookup.twoLeg({ ...officialPair, stage })).toEqual({
        status: 'matched',
        fixtures: [first, second],
      });
    },
  );

  it('uses reciprocal venues and distinct kickoff times when the first host is unknown', () => {
    const first = firstLeg();
    const second = secondLeg();
    const lookup = createChampionsLeagueKnockoutFixtureLookup(season, [
      second,
      first,
    ]);

    expect(lookup.twoLeg({ ...officialPair, firstLegHomeTeamId: null })).toEqual({
      status: 'matched',
      fixtures: [first, second],
    });
    expect(lookup.twoLeg({ ...officialPair, firstLegHomeTeamId: 1 })).toEqual({
      status: 'unavailable',
      reason: 'conflicting-fixtures',
    });
  });

  it.each<Partial<Match>>([
    { homeTeamId: 2, awayTeamId: 1 },
    { utcDate: new Date('2027-02-16T20:00:00Z') },
    { matchId: 90 },
  ])('withholds conflicting fixtures (%j)', (fields) => {
    const lookup = createChampionsLeagueKnockoutFixtureLookup(season, [
      firstLeg(),
      secondLeg(fields),
    ]);

    expect(lookup.twoLeg(officialPair)).toEqual({
      status: 'unavailable',
      reason: 'conflicting-fixtures',
    });
  });

  it('distinguishes missing legs from multiple candidate records', () => {
    const first = firstLeg();
    const second = secondLeg();
    const incomplete = createChampionsLeagueKnockoutFixtureLookup(season, [
      first,
      secondLeg({ awayTeamId: null }),
      secondLeg({ matchId: 81, awayTeamId: 3 }),
    ]);
    const ambiguous = createChampionsLeagueKnockoutFixtureLookup(season, [
      first,
      second,
      secondLeg({ matchId: 81 }),
    ]);

    expect(incomplete.twoLeg(officialPair)).toEqual({
      status: 'unavailable',
      reason: 'missing-fixtures',
    });
    expect(ambiguous.twoLeg(officialPair)).toEqual({
      status: 'unavailable',
      reason: 'ambiguous-fixtures',
    });
  });

  it('links the final while keeping the score in the observed home-away order', () => {
    const final = firstLeg({ stage: 'FINAL' });
    const lookup = createChampionsLeagueKnockoutFixtureLookup(season, [
      firstLeg({ matchId: 50, stage: 'SEMI_FINALS' }),
      final,
    ]);

    expect(lookup.final(officialFinal)).toEqual({
      status: 'matched',
      fixtures: [final],
    });
  });

  it('withholds ambiguous finals, simulated draws and draws from another season', () => {
    const lookup = createChampionsLeagueKnockoutFixtureLookup(season, [
      firstLeg(),
      secondLeg(),
      firstLeg({ stage: 'FINAL', matchId: 121 }),
      secondLeg({ stage: 'FINAL', matchId: 122 }),
    ]);

    expect(lookup.final(officialFinal)).toEqual({
      status: 'unavailable',
      reason: 'ambiguous-fixtures',
    });
    for (const result of [
      lookup.twoLeg({ ...officialPair, source: 'simulated' }),
      lookup.final({ ...officialFinal, source: 'simulated' }),
    ]) {
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'draw-not-confirmed',
      });
    }
    expect(lookup.twoLeg({ ...officialPair, season: 2025 })).toEqual({
      status: 'unavailable',
      reason: 'season-mismatch',
    });
  });

  it('copies the stored and returned snapshots', () => {
    const first = firstLeg();
    const second = secondLeg();
    const lookup = createChampionsLeagueKnockoutFixtureLookup(season, [
      first,
      second,
    ]);
    first.utcDate.setUTCFullYear(2029);

    const matched = lookup.twoLeg(officialPair);
    expect(matched.status).toBe('matched');
    if (matched.status !== 'matched') throw new Error('expected a matched pair');
    matched.fixtures[0].utcDate.setUTCFullYear(2030);

    expect(lookup.twoLeg(officialPair)).toEqual({
      status: 'matched',
      fixtures: [firstLeg(), secondLeg()],
    });
  });
});
