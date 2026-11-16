import { describe, expect, it } from 'vitest';

import type { VenueMatch } from '@/lib/football/venue-stats';
import { MATCH_STATUSES } from '@/lib/types/football';

import { calculateMatchProbabilities } from './match-probabilities';
import { assessPredictionResult } from './prediction-result';

const match: Readonly<VenueMatch> = Object.freeze({
  status: 'FINISHED',
  homeTeamId: 57,
  awayTeamId: 61,
  homeGoals90: 2,
  awayGoals90: 1,
});

describe('prediction assessment from the 90-minute result', () => {
  it.each([
    { homeGoals90: 2, awayGoals90: 1, outcome: 'home' },
    { homeGoals90: 0, awayGoals90: 0, outcome: 'draw' },
    { homeGoals90: 0, awayGoals90: 1, outcome: 'away' },
  ] as const)('classifies $homeGoals90–$awayGoals90 as $outcome', (result) => {
    for (const favorite of ['home', 'draw', 'away'] as const) {
      expect(assessPredictionResult({ ...match, ...result }, favorite)).toEqual({
        outcome: result.outcome,
        correct: favorite === result.outcome,
      });
    }
  });

  it('supports the upper safe integer score boundary', () => {
    expect(
      assessPredictionResult(
        {
          ...match,
          homeGoals90: Number.MAX_SAFE_INTEGER,
          awayGoals90: Number.MAX_SAFE_INTEGER - 1,
        },
        'home',
      ),
    ).toEqual({ outcome: 'home', correct: true });
  });

  it.each([null, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'returns null for an invalid 90-minute score %s',
    (goals) => {
      for (const field of ['homeGoals90', 'awayGoals90'] as const) {
        expect(
          assessPredictionResult({ ...match, [field]: goals }, 'home'),
        ).toBeNull();
      }
    },
  );

  it.each([{ homeTeamId: null }, { awayTeamId: null }, { homeTeamId: 61 }])(
    'returns null for incomplete or identical participants $homeTeamId / $awayTeamId',
    (teams) => {
      expect(assessPredictionResult({ ...match, ...teams }, 'home')).toBeNull();
    },
  );

  it.each(MATCH_STATUSES.filter((status) => status !== 'FINISHED'))(
    'waits for a completed match when the status is %s',
    (status) => {
      expect(assessPredictionResult({ ...match, status }, 'home')).toBeNull();
    },
  );

  it('uses the saved raw favorite when displayed percentages tie', () => {
    const prediction = calculateMatchProbabilities(1.5, 1.501, {
      tailTolerance: 1e-10,
      maxGoals: 64,
    })!;
    expect(prediction.percentages.home).toBe(prediction.percentages.away);
    expect(
      assessPredictionResult(
        {
          ...match,
          homeGoals90: 0,
          awayGoals90: 1,
        },
        prediction.favorite,
      ),
    ).toEqual({ outcome: 'away', correct: true });
  });
});
