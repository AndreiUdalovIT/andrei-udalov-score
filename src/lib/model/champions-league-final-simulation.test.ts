import { describe, expect, it } from 'vitest';

import {
  CHAMPIONS_LEAGUE_FINAL_SIMULATION_ALGORITHM,
  createChampionsLeagueFinalSimulation,
  type ChampionsLeagueFinalMatchInputs,
  type ChampionsLeagueFinalPreparation,
} from './champions-league-final-simulation';
import { CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM } from './champions-league-play-off-draw';
import { CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM } from './champions-league-quarter-final-draw';
import { CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM } from './champions-league-round-of-16-draw';
import {
  CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
  type RecordedChampionsLeagueSemiFinalDraw,
} from './champions-league-semi-final-draw';
import {
  createChampionsLeagueSemiFinalSimulation,
  type ChampionsLeagueSemiFinalMatchInputs,
} from './champions-league-semi-final-simulation';
import { createSeededRandom } from './seeded-random';

const options = { maxGoals: 40, tailTolerance: 1e-10 };
const seed = [1, 2, 3, 4] as const;

function semiFinals(season = 2025, playedSilver = true) {
  const fixtures = [
    ['silver', 9, 5],
    ['blue', 10, 6],
  ] as const;
  const draw: RecordedChampionsLeagueSemiFinalDraw = {
    algorithm: CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
    season,
    source: 'official',
    homeOrder: { source: 'official', sourceReference: 'test-semi-finals' },
    quarterFinalDraw: {
      algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
      season,
      source: 'official',
      homeOrder: { source: 'official', sourceReference: 'test-quarter-finals' },
      roundOf16Draw: {
        algorithm: CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
        season,
        source: 'official',
        sourceReference: 'test-round-of-16',
        playOffDraw: {
          algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
          season,
          source: 'official',
          sourceReference: 'test-play-offs',
        },
      },
    },
    ties: fixtures.map(([side, firstPosition, secondPosition]) => ({
      side,
      first: {
        club: { teamId: 100 + firstPosition, position: firstPosition },
        slot: { side, seededPairStart: 1 },
        source: 'observed',
      },
      second: {
        club: { teamId: 100 + secondPosition, position: secondPosition },
        slot: { side, seededPairStart: 3 },
        source: 'observed',
      },
      firstLegHomeTeamId: 100 + secondPosition,
    })),
  };

  const matches = draw.ties.map((tie): ChampionsLeagueSemiFinalMatchInputs => {
    const firstTeamId = tie.first.club.teamId;
    const secondTeamId = tie.second.club.teamId;
    const venues = [
      { leg: 1, homeTeamId: secondTeamId, awayTeamId: firstTeamId },
      { leg: 2, homeTeamId: firstTeamId, awayTeamId: secondTeamId },
    ] as const;
    const played = playedSilver || tie.side === 'blue';
    const decisiveLeg = tie.side === 'blue' ? 1 : 2;
    return {
      firstTeamId,
      secondTeamId,
      legs: played
        ? venues.map((venue) => ({
            ...venue,
            kind: 'known-result',
            homeGoals90: venue.leg === decisiveLeg ? 2 : 0,
            awayGoals90: 0,
          }))
        : venues.map((venue) => ({
            ...venue,
            kind: 'forecast',
            homeRate90: 0,
            awayRate90: 0,
          })),
      extraTime: played ? null : { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
      penalties: played ? null : { kind: 'forecast', firstTeamWinProbability: 1 },
    };
  });
  const prepared = createChampionsLeagueSemiFinalSimulation(draw, matches, options);
  if (prepared.status !== 'ready') throw new Error('test semi-finals must be ready');
  return prepared.sample(() => 0.5);
}

const neutralForecast: ChampionsLeagueFinalMatchInputs = {
  silverTeamId: 109,
  blueTeamId: 106,
  regulation: { kind: 'forecast', silverNeutralRate90: 0, blueNeutralRate90: 0 },
  extraTime: { kind: 'forecast', silverNeutralRate30: 0, blueNeutralRate30: 0 },
  penalties: { kind: 'forecast', firstTeamWinProbability: 0.4 },
};

const knownFinal: ChampionsLeagueFinalMatchInputs = {
  silverTeamId: 109,
  blueTeamId: 106,
  regulation: { kind: 'known-result', silverGoals90: 1, blueGoals90: 2 },
  extraTime: null,
  penalties: null,
};

function ready(prepared: ChampionsLeagueFinalPreparation) {
  if (prepared.status !== 'ready') throw new Error('test final must be ready');
  return prepared;
}

function noRandom(): never {
  throw new Error('a completed final must not consume RNG');
}

describe('Champions League final simulation', () => {
  it.each([2024, 2025, 2026])(
    'pairs the observed winners at a neutral venue in season %s',
    (season) => {
      const final = createChampionsLeagueFinalSimulation(semiFinals(season));
      expect(final.fixture).toMatchObject({
        season,
        venue: 'neutral',
        source: 'official',
        nominalHomeTeamId: 109,
        silver: { club: { teamId: 109, position: 9 }, source: 'observed' },
        blue: { club: { teamId: 106, position: 6 }, source: 'observed' },
        semiFinalDraw: {
          source: 'official',
          homeOrder: { sourceReference: 'test-semi-finals' },
        },
      });
      const prepared = ready(final.prepare(knownFinal, options));
      expect(prepared.tailUpperBound).toBe(0);
      expect(prepared.sample(noRandom)).toMatchObject({
        algorithm: CHAMPIONS_LEAGUE_FINAL_SIMULATION_ALGORITHM,
        fixture: final.fixture,
        result: {
          winnerTeamId: 106,
          loserTeamId: 109,
          method: 'regulation-goals',
          legs: [{ homeTeamId: 109, awayTeamId: 106, source: 'known-result' }],
          extraTime: null,
          shootout: null,
        },
      });
    },
  );

  it('uses the supplied neutral rates for one match regardless of nominal home order', () => {
    const final = createChampionsLeagueFinalSimulation(semiFinals());
    const prepared = ready(
      final.prepare(
        {
          ...neutralForecast,
          regulation: {
            kind: 'forecast',
            silverNeutralRate90: 0,
            blueNeutralRate90: 2,
          },
        },
        options,
      ),
    );
    let calls = 0;
    const { result } = prepared.sample(() => {
      calls += 1;
      return 0.5;
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({
      method: 'regulation-goals',
      winnerTeamId: 106,
      legs: [{ leg: 1, homeGoals90: 0, awayGoals90: 2, source: 'simulated' }],
      extraTime: null,
      shootout: null,
    });
  });

  it('simulates a shootout after extra time using the silver-side probability', () => {
    const final = createChampionsLeagueFinalSimulation(semiFinals());
    const prepared = ready(final.prepare(neutralForecast, options));
    for (const [lastDraw, winnerTeamId] of [
      [0.399, 109],
      [0.4, 106],
    ] as const) {
      let calls = 0;
      const { result } = prepared.sample(() => (++calls < 5 ? 0.5 : lastDraw));
      expect(calls).toBe(5);
      expect(result).toMatchObject({
        winnerTeamId,
        method: 'penalties',
        extraTime: { homeGoals30: 0, awayGoals30: 0, source: 'simulated' },
        shootout: { winnerTeamId, source: 'simulated' },
      });
    }
  });

  it('replays observed extra time and penalties without using RNG', () => {
    const final = createChampionsLeagueFinalSimulation(semiFinals());
    const tied: ChampionsLeagueFinalMatchInputs = {
      ...knownFinal,
      regulation: { kind: 'known-result', silverGoals90: 1, blueGoals90: 1 },
    };
    const extraTime = ready(
      final.prepare(
        {
          ...tied,
          extraTime: { kind: 'known-result', silverGoals30: 1, blueGoals30: 0 },
        },
        options,
      ),
    );
    expect(extraTime.sample(noRandom).result).toMatchObject({
      winnerTeamId: 109,
      method: 'extra-time-goals',
      aggregateGoalsAfterExtraTime: { first: 2, second: 1 },
    });
    const penalties = ready(
      final.prepare(
        {
          ...tied,
          extraTime: { kind: 'known-result', silverGoals30: 0, blueGoals30: 0 },
          penalties: { kind: 'known-result', winnerTeamId: 106 },
        },
        options,
      ),
    );
    expect(penalties.sample(noRandom).result).toMatchObject({
      winnerTeamId: 106,
      method: 'penalties',
      shootout: { winnerTeamId: 106, source: 'known-result' },
    });
  });

  it('reports missing final inputs, extra time and shootout context', () => {
    const final = createChampionsLeagueFinalSimulation(semiFinals());
    expect(final.prepare(null, options)).toEqual({
      status: 'unavailable',
      reason: 'missing-match-inputs',
    });
    expect(final.prepare({ ...neutralForecast, extraTime: null }, options)).toEqual({
      status: 'unavailable',
      reason: 'missing-extra-time',
    });
    expect(
      final.prepare(
        {
          ...knownFinal,
          regulation: { kind: 'known-result', silverGoals90: 1, blueGoals90: 1 },
          penalties: { kind: 'known-result', winnerTeamId: 106 },
        },
        options,
      ),
    ).toEqual({ status: 'unavailable', reason: 'missing-extra-time' });
    expect(final.prepare({ ...neutralForecast, penalties: null }, options)).toEqual({
      status: 'unavailable',
      reason: 'knockout-sampler-unavailable',
    });
  });

  it('keeps the final a scenario when a semi-final winner was simulated', () => {
    const final = createChampionsLeagueFinalSimulation(semiFinals(2026, false));
    expect(final.fixture).toMatchObject({
      source: 'simulated',
      silver: { club: { teamId: 109 }, source: 'simulated' },
      blue: { club: { teamId: 106 }, source: 'observed' },
    });
    expect(() => final.prepare(knownFinal, options)).toThrow(
      /require observed finalists/,
    );
    expect(final.prepare(neutralForecast, options).status).toBe('ready');
  });

  it('pairs finalists by side and isolates the prepared inputs and sampled outputs', () => {
    const semi = semiFinals();
    semi.ties.reverse();
    const final = createChampionsLeagueFinalSimulation(semi);
    const regulation = {
      kind: 'forecast' as const,
      silverNeutralRate90: 0,
      blueNeutralRate90: 0,
    };
    const prepared = ready(
      final.prepare({ ...neutralForecast, regulation }, options),
    );
    const reference = prepared.sample(createSeededRandom(seed));
    const changed = prepared.sample(createSeededRandom(seed));
    changed.fixture.semiFinalDraw.season = 1900;
    changed.result.legs[0]!.homeGoals90 = 19;
    final.fixture.silver.club.teamId = 9999;
    semi.ties[0]!.result.winnerTeamId = 9998;
    regulation.silverNeutralRate90 = 30;
    expect(prepared.sample(createSeededRandom(seed))).toEqual(reference);
    expect(final.prepare(neutralForecast, options).status).toBe('ready');
  });

  it('rejects mismatched fixture inputs and invalid semi-final winners', () => {
    const semi = semiFinals();
    const final = createChampionsLeagueFinalSimulation(semi);
    expect(() =>
      final.prepare(
        {
          ...knownFinal,
          silverTeamId: 106,
          blueTeamId: 109,
        },
        options,
      ),
    ).toThrow(/finalists in order/);
    semi.ties[0]!.result.winnerTeamId = 1000;
    expect(() => createChampionsLeagueFinalSimulation(semi)).toThrow(
      /winner and loser/,
    );
  });
});
