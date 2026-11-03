import { describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/matches.json';
import { matchSchema } from '../schemas/matches';
import { mapMatch } from './matches';

vi.mock('server-only', () => ({}));

const upcoming = matchSchema.parse(fixture.upcoming);
const extraTime = matchSchema.parse(fixture.extraTime);
const penalties = matchSchema.parse(fixture.penalties);

describe('match mapper', () => {
  it('maps match identity, UTC instants and unknown scores', () => {
    const result = mapMatch(upcoming);

    expect(result).toMatchObject({
      id: 560634,
      competitionId: 2021,
      season: 2026,
      matchday: 10,
      stage: 'REGULAR_SEASON',
      status: 'TIMED',
      homeTeamId: 62,
      awayTeamId: 1076,
      homeGoals: null,
      awayGoals: null,
      homeGoals90: null,
      awayGoals90: null,
      duration: 'REGULAR',
      homePenalties: null,
      awayPenalties: null,
    });
    expect(result.utcDate.toISOString()).toBe('2026-11-06T20:00:00.000Z');
    expect(result.lastUpdated.toISOString()).toBe('2026-11-03T01:32:01.000Z');
  });

  it('maps a finished regular goalless draw without losing zeroes', () => {
    const result = mapMatch({
      ...upcoming,
      status: 'FINISHED',
      score: {
        ...upcoming.score,
        winner: 'DRAW',
        fullTime: { home: 0, away: 0 },
        halfTime: { home: 0, away: 0 },
      },
    });

    expect(result).toMatchObject({
      homeGoals: 0,
      awayGoals: 0,
      homeGoals90: 0,
      awayGoals90: 0,
    });
  });

  it('keeps extra-time goals out of the 90-minute result', () => {
    const result = mapMatch(extraTime);

    expect(result).toMatchObject({
      season: 2025,
      homeGoals: 3,
      awayGoals: 2,
      homeGoals90: 3,
      awayGoals90: 0,
      duration: 'EXTRA_TIME',
    });
  });

  it('keeps the full-time, 90-minute and shootout scores separate', () => {
    const result = mapMatch(penalties);

    expect(result).toMatchObject({
      season: 2025,
      matchday: null,
      homeGoals: 5,
      awayGoals: 4,
      homeGoals90: 1,
      awayGoals90: 1,
      homePenalties: 4,
      awayPenalties: 3,
      duration: 'PENALTY_SHOOTOUT',
    });
  });

  it.each([
    { label: 'extra time', match: extraTime },
    { label: 'a shootout', match: penalties },
  ])('keeps missing period scores unknown after $label', ({ match }) => {
    const result = mapMatch({
      ...match,
      score: { ...match.score, regularTime: undefined, penalties: undefined },
    });

    expect(result).toMatchObject({
      homeGoals90: null,
      awayGoals90: null,
      homePenalties: null,
      awayPenalties: null,
    });
  });

  it('preserves a live score without treating it as the 90-minute result', () => {
    const result = mapMatch({
      ...upcoming,
      status: 'IN_PLAY',
      score: { ...upcoming.score, fullTime: { home: 0, away: 1 } },
    });

    expect(result).toMatchObject({
      homeGoals: 0,
      awayGoals: 1,
      homeGoals90: null,
      awayGoals90: null,
    });
  });

  it('preserves unknown participants without inventing IDs', () => {
    const result = mapMatch({
      ...upcoming,
      homeTeam: { id: null, name: null },
      awayTeam: { id: null, name: null },
    });

    expect(result).toMatchObject({ homeTeamId: null, awayTeamId: null });
  });

  it('preserves a known zero in the shootout score', () => {
    const result = mapMatch({
      ...penalties,
      score: {
        ...penalties.score,
        winner: 'AWAY_TEAM',
        fullTime: { home: 1, away: 4 },
        penalties: { home: 0, away: 3 },
      },
    });

    expect(result).toMatchObject({ homePenalties: 0, awayPenalties: 3 });
  });
});
