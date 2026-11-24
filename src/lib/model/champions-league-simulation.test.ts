import { describe, expect, it, vi } from 'vitest';

import {
  CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM,
  createChampionsLeagueSimulation,
  type ChampionsLeagueMatchProviders,
  type ChampionsLeagueSimulationInput,
  type ChampionsLeagueSimulationSample,
} from './champions-league-simulation';
import type { ChampionsLeagueTwoLegMatchInputs } from './champions-league-two-leg-round';
import type { SeasonCalendarFixture } from './season-calendar-sampler';
import { projectSeasonStats } from './season-stats';
import { SEEDED_RANDOM_ALGORITHM } from './seeded-random';

const seed = [1, 2, 3, 4] as const;
const anotherSeed = [11, 12, 13, 14] as const;

function tieInputs(
  firstTeamId: number,
  secondTeamId: number,
  firstLegHomeTeamId: number | null,
  source: 'official' | 'simulated',
): ChampionsLeagueTwoLegMatchInputs {
  const firstHome = firstLegHomeTeamId ?? secondTeamId;
  const secondHome = firstHome === firstTeamId ? secondTeamId : firstTeamId;
  const identities = [
    { leg: 1, homeTeamId: firstHome, awayTeamId: secondHome },
    { leg: 2, homeTeamId: secondHome, awayTeamId: firstHome },
  ] as const;
  return {
    firstTeamId,
    secondTeamId,
    legs:
      source === 'official'
        ? identities.map((leg) => ({
            ...leg,
            kind: 'known-result',
            homeGoals90: Number(leg.homeTeamId === firstTeamId),
            awayGoals90: 0,
          }))
        : identities.map((leg) => ({
            ...leg,
            kind: 'forecast',
            homeRate90: 0,
            awayRate90: 0,
          })),
    extraTime:
      source === 'official'
        ? null
        : { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
    penalties:
      source === 'official'
        ? null
        : { kind: 'forecast', firstTeamWinProbability: 1 },
  };
}

const matches: ChampionsLeagueMatchProviders = {
  playOff: (draw) =>
    draw.ties.map((tie) => {
      const { firstTeamId, secondTeamId, ...inputs } = tieInputs(
        tie.seeded.teamId,
        tie.unseeded.teamId,
        tie.firstLegHomeTeamId,
        draw.source,
      );
      return { ...inputs, seededTeamId: firstTeamId, unseededTeamId: secondTeamId };
    }),
  roundOf16: (draw) =>
    draw.ties.map((tie) =>
      tieInputs(
        tie.seeded.teamId,
        tie.playOffWinner.club.teamId,
        tie.firstLegHomeTeamId,
        draw.source,
      ),
    ),
  quarterFinals: (draw) =>
    draw.ties.map((tie) =>
      tieInputs(
        tie.first.club.teamId,
        tie.second.club.teamId,
        tie.firstLegHomeTeamId,
        draw.source,
      ),
    ),
  semiFinals: (draw) =>
    draw.ties.map((tie) =>
      tieInputs(
        tie.first.club.teamId,
        tie.second.club.teamId,
        tie.firstLegHomeTeamId,
        draw.source,
      ),
    ),
  final: ({ silver, blue, source }) => ({
    silverTeamId: silver.club.teamId,
    blueTeamId: blue.club.teamId,
    regulation:
      source === 'official'
        ? { kind: 'known-result', silverGoals90: 1, blueGoals90: 0 }
        : { kind: 'forecast', silverNeutralRate90: 0, blueNeutralRate90: 0 },
    extraTime:
      source === 'official'
        ? null
        : { kind: 'forecast', silverNeutralRate30: 0, blueNeutralRate30: 0 },
    penalties:
      source === 'official'
        ? null
        : { kind: 'forecast', firstTeamWinProbability: 1 },
  }),
};

function input(
  season = 2026,
  withFutureMatch = false,
): ChampionsLeagueSimulationInput {
  const teamIds = Array.from({ length: 36 }, (_, index) => index + 1);
  const fixtures = teamIds.flatMap((homeTeamId) =>
    [1, 2, 3, 4].map((offset): SeasonCalendarFixture => {
      const fixture = {
        id: (homeTeamId - 1) * 4 + offset,
        homeTeamId,
        awayTeamId: ((homeTeamId - 1 + offset) % 36) + 1,
      };
      return withFutureMatch && fixture.id === 1
        ? { ...fixture, kind: 'forecast', homeRate90: 1.6, awayRate90: 0.8 }
        : { ...fixture, kind: 'known-result', homeGoals90: 1, awayGoals90: 0 };
    }),
  );
  const empty = teamIds.map((teamId) => ({
    teamId,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
  }));
  const baseline = projectSeasonStats(
    empty,
    fixtures
      .filter((fixture) => fixture.kind === 'known-result')
      .map(({ id, homeTeamId, awayTeamId, homeGoals90, awayGoals90 }) => ({
        id,
        homeTeamId,
        awayTeamId,
        homeGoals90,
        awayGoals90,
        source: 'simulated',
      })),
  )!;
  return {
    season,
    baseline,
    fixtures,
    matches,
    sampling: { maxGoals: 40, tailTolerance: 1e-10 },
    tieBreakContext: teamIds.map((teamId) => ({
      teamId,
      disciplinaryPoints: 0,
      clubCoefficient: 37 - teamId,
    })),
  };
}

function complete(
  result: ReturnType<ReturnType<typeof createChampionsLeagueSimulation>['sample']>,
) {
  if (result.status !== 'complete')
    throw new Error('test expected a complete Champions League run');
  return result;
}

function recordedDraws(
  sample: ChampionsLeagueSimulationSample,
): NonNullable<ChampionsLeagueSimulationInput['officialDraws']> {
  const season = sample.leaguePhase.ranking.season;
  return {
    playOff: {
      sourceReference: 'test-play-offs',
      ties: sample.playOff.ties.map(({ tie }) => ({
        side: tie.side,
        seededTeamId: tie.seeded.teamId,
        unseededTeamId: tie.unseeded.teamId,
        firstLegHomeTeamId: tie.firstLegHomeTeamId,
      })),
    },
    roundOf16: {
      sourceReference: 'test-round-of-16',
      ties: sample.roundOf16.ties.map(({ tie }) => ({
        side: tie.side,
        seededTeamId: tie.seeded.teamId,
        winnerTeamId: tie.playOffWinner.club.teamId,
        firstLegHomeTeamId: tie.firstLegHomeTeamId,
      })),
    },
    quarterFinals: {
      season,
      sourceReference: 'test-quarter-finals',
      ties: sample.quarterFinals.ties.map(({ tie }) => ({
        side: tie.side,
        seededPairStart: tie.seededPairStart,
        firstLegHomeFrom: tie.first.slot.seededPairStart,
      })),
    },
    semiFinals: {
      season,
      sourceReference: 'test-semi-finals',
      ties: sample.semiFinals.ties.map(({ tie }) => ({
        side: tie.side,
        firstLegHomeFrom: tie.first.slot.seededPairStart,
      })),
    },
  };
}

describe('Champions League season scenario', () => {
  it('replays the whole competition with a seeded mixed league-phase calendar', () => {
    const data = input(2026, true);
    const simulation = createChampionsLeagueSimulation(data);
    const sample = complete(simulation.sample(seed));
    expect(sample).toMatchObject({
      algorithm: CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM,
      randomAlgorithm: SEEDED_RANDOM_ALGORITHM,
      seed,
      playOff: { draw: { source: 'simulated', randomDraws: 8 } },
      roundOf16: { draw: { source: 'simulated', randomDraws: 4 } },
      quarterFinals: { draw: { homeOrder: { source: 'inherited-seeding' } } },
      semiFinals: { draw: { homeOrder: { source: 'inherited-seeding' } } },
      final: { fixture: { venue: 'neutral', source: 'simulated' } },
    });
    expect(sample.leaguePhase.scores).toHaveLength(144);
    expect(sample.leaguePhase.scores[0]).toMatchObject({
      id: 1,
      source: 'simulated',
      homeGoals90: 0,
      awayGoals90: 0,
    });
    expect(sample.leaguePhase.scores[1]).toMatchObject({
      id: 2,
      source: 'known-result',
    });
    expect([
      sample.playOff.ties.length,
      sample.roundOf16.ties.length,
      sample.quarterFinals.ties.length,
      sample.semiFinals.ties.length,
    ]).toEqual([8, 8, 4, 2]);
    expect(sample.final.fixture.nominalHomeTeamId).toBe(
      sample.semiFinals.ties[0]!.result.winnerTeamId,
    );
    expect(sample.final.result.winnerTeamId).toBe(
      sample.final.fixture.silver.club.teamId,
    );
    expect(sample.tailUpperBound).toBeGreaterThan(0);
    expect(simulation.sample(seed)).toEqual(sample);
    const reordered = createChampionsLeagueSimulation({
      ...data,
      fixtures: [...data.fixtures].reverse(),
      baseline: [...data.baseline].reverse(),
      tieBreakContext: [...data.tieBreakContext!].reverse(),
    });
    expect(reordered.sample(seed)).toEqual(sample);
    expect(complete(simulation.sample(anotherSeed)).playOff.ties).not.toEqual(
      sample.playOff.ties,
    );
  });

  it('applies every published draw and replays observed scores through the final', () => {
    const data = input(2024);
    const scenario = complete(createChampionsLeagueSimulation(data).sample(seed));
    expect(scenario.quarterFinals.draw.homeOrder).toMatchObject({
      source: 'simulated-lots',
      randomDraws: 4,
    });
    expect(scenario.semiFinals.draw.homeOrder).toMatchObject({
      source: 'simulated-lots',
      randomDraws: 2,
    });
    const simulation = createChampionsLeagueSimulation({
      ...data,
      officialDraws: recordedDraws(scenario),
    });
    const sample = complete(simulation.sample(anotherSeed));
    expect(sample).toMatchObject({
      tailUpperBound: 0,
      playOff: { draw: { source: 'official', sourceReference: 'test-play-offs' } },
      roundOf16: {
        draw: { source: 'official', sourceReference: 'test-round-of-16' },
      },
      quarterFinals: {
        draw: {
          source: 'official',
          homeOrder: { sourceReference: 'test-quarter-finals' },
        },
      },
      semiFinals: {
        draw: {
          source: 'official',
          homeOrder: { sourceReference: 'test-semi-finals' },
        },
      },
      final: {
        fixture: { source: 'official' },
        result: { method: 'regulation-goals' },
      },
    });
    expect(
      sample.leaguePhase.scores.every((score) => score.source === 'known-result'),
    ).toBe(true);
    expect(
      sample.quarterFinals.ties.every(
        ({ tie }) => tie.firstLegHomeTeamId === tie.first.club.teamId,
      ),
    ).toBe(true);
    expect(sample.final.result.winnerTeamId).toBe(
      scenario.final.result.winnerTeamId,
    );
    expect(simulation.sample(seed)).toEqual({ ...sample, seed });
  });

  it('keeps the published semi-final order when quarter-final scores are forecasts', () => {
    const data = input(2024);
    const scenario = complete(createChampionsLeagueSimulation(data).sample(seed));
    const sample = complete(
      createChampionsLeagueSimulation({
        ...data,
        officialDraws: recordedDraws(scenario),
        matches: {
          ...matches,
          quarterFinals: (draw) =>
            draw.ties.map((tie) =>
              tieInputs(
                tie.first.club.teamId,
                tie.second.club.teamId,
                tie.firstLegHomeTeamId,
                'simulated',
              ),
            ),
        },
      }).sample(seed),
    );
    expect(sample.semiFinals.draw).toMatchObject({
      source: 'simulated',
      homeOrder: { source: 'official', sourceReference: 'test-semi-finals' },
    });
    expect(
      sample.semiFinals.ties.every(
        ({ tie }) => tie.firstLegHomeTeamId === tie.first.club.teamId,
      ),
    ).toBe(true);
    expect(sample.final.fixture.source).toBe('simulated');
  });

  it('rejects a published knockout draw in a projected league phase', () => {
    expect(() =>
      createChampionsLeagueSimulation({
        ...input(2026, true),
        officialDraws: { playOff: { sourceReference: 'after-cutoff', ties: [] } },
      }),
    ).toThrow(/fully observed league phase/);
  });

  it('reports an unresolved seeding range before drawing or requesting matches', () => {
    const playOff = vi.fn(matches.playOff);
    const simulation = createChampionsLeagueSimulation({
      ...input(),
      tieBreakContext: [],
      matches: { ...matches, playOff },
    });
    expect(simulation.sample(seed)).toMatchObject({
      status: 'unavailable',
      stage: 'league-phase',
      reason: 'unresolved-seeding',
      groups: [{ from: 1, to: 36 }],
    });
    expect(playOff).not.toHaveBeenCalled();
  });

  it('withholds the winner on missing quarter-final or final inputs', () => {
    const final = vi.fn(matches.final);
    const data = input();
    const blocked = createChampionsLeagueSimulation({
      ...data,
      matches: { ...matches, quarterFinals: () => [], final },
    }).sample(seed);
    expect(blocked).toEqual({
      status: 'unavailable',
      stage: 'quarter-finals',
      blockedTies: [
        { side: 'silver', seededPairStart: 1, reason: 'missing-match-inputs' },
        { side: 'silver', seededPairStart: 3, reason: 'missing-match-inputs' },
        { side: 'blue', seededPairStart: 1, reason: 'missing-match-inputs' },
        { side: 'blue', seededPairStart: 3, reason: 'missing-match-inputs' },
      ],
    });
    expect(final).not.toHaveBeenCalled();
    expect(
      createChampionsLeagueSimulation({
        ...data,
        matches: { ...matches, final: () => null },
      }).sample(seed),
    ).toEqual({
      status: 'unavailable',
      stage: 'final',
      reason: 'missing-match-inputs',
    });
  });

  it('isolates the calendar snapshot and the draws passed to providers', () => {
    const data = input();
    const original = complete(createChampionsLeagueSimulation(data).sample(seed));
    const sampling = { ...data.sampling };
    const playOff = vi.fn(
      (draw: Parameters<ChampionsLeagueMatchProviders['playOff']>[0]) => {
        const prepared = matches.playOff(draw);
        draw.ties.length = 0;
        return prepared;
      },
    );
    const simulation = createChampionsLeagueSimulation({
      ...data,
      sampling,
      matches: { ...matches, playOff },
    });
    sampling.maxGoals = 0;
    expect(simulation.sample(seed)).toEqual(original);
    expect(playOff).toHaveBeenCalledOnce();
  });
});
