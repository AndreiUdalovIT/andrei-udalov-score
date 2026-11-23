import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { SiteCompetitionCode } from '@/lib/config/competitions';

import { CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM } from './champions-league-phase-ranking';
import { KNOCKOUT_SAMPLING_ALGORITHM } from './knockout-sampler';
import {
  createLeagueSimulation,
  LEAGUE_SIMULATION_ALGORITHM,
  type LeagueSimulationInput,
  type SerieAPlayOffScenario,
} from './league-simulation';
import { createPoissonScoreSampler } from './poisson-score-sampler';
import type { SeasonCalendarFixture } from './season-calendar-sampler';
import { SEEDED_RANDOM_ALGORITHM, type RandomSeed } from './seeded-random';
import { projectSeasonStats } from './season-stats';

function baselineFromKnown(
  fixtures: readonly SeasonCalendarFixture[],
  size: number,
) {
  const initial = Array.from({ length: size }, (_, index) => ({
    teamId: index + 1,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  const known = fixtures.flatMap((fixture) =>
    fixture.kind === 'known-result'
      ? [
          {
            id: fixture.id,
            homeTeamId: fixture.homeTeamId,
            awayTeamId: fixture.awayTeamId,
            homeGoals90: fixture.homeGoals90,
            awayGoals90: fixture.awayGoals90,
            source: 'simulated' as const,
          },
        ]
      : [],
  );
  return projectSeasonStats(initial, known)!.map((row) => ({
    ...row,
    points: -100 * row.teamId,
  }));
}

function input(
  competitionCode: SiteCompetitionCode = 'PL',
  runs = 4,
  forecast = true,
): LeagueSimulationInput {
  const size = getCompetitionSeasonConfig(competitionCode, 2026)!.teamCount;
  const fixtures: SeasonCalendarFixture[] = [];
  for (let homeTeamId = 1; homeTeamId <= size; homeTeamId += 1) {
    for (let awayTeamId = 1; awayTeamId <= size; awayTeamId += 1) {
      if (homeTeamId === awayTeamId) continue;
      const identity = { id: fixtures.length + 1, homeTeamId, awayTeamId };
      fixtures.push(
        forecast && fixtures.length === 0
          ? { ...identity, kind: 'forecast', homeRate90: 1.6, awayRate90: 0.8 }
          : { ...identity, kind: 'known-result', homeGoals90: 1, awayGoals90: 0 },
      );
    }
  }
  return {
    competitionCode,
    season: 2026,
    modelVersion: 'poisson-test-v1',
    dataCutoffMs: Date.UTC(2026, 10, 19),
    seed: [1, 2, 3, 4],
    runs,
    sampling: { tailTolerance: 1e-10, maxGoals: 40 },
    baseline: baselineFromKnown(fixtures, size),
    fixtures,
  };
}

function championsLeagueInput(): LeagueSimulationInput {
  const size = 36;
  const teamIds = Array.from({ length: size }, (_, index) => index + 1);
  const fixtures: SeasonCalendarFixture[] = teamIds.flatMap((homeTeamId) =>
    [1, 2, 3, 4].map((offset): SeasonCalendarFixture => {
      const identity = {
        id: (homeTeamId - 1) * 4 + offset,
        homeTeamId,
        awayTeamId: ((homeTeamId - 1 + offset) % size) + 1,
      };
      return identity.id === 1
        ? { ...identity, kind: 'forecast', homeRate90: 1.6, awayRate90: 0.8 }
        : { ...identity, kind: 'known-result', homeGoals90: 1, awayGoals90: 0 };
    }),
  );
  return {
    modelVersion: 'poisson-test-v1',
    dataCutoffMs: Date.UTC(2026, 10, 19),
    seed: [1, 2, 3, 4],
    runs: 4,
    season: 2026,
    sampling: { tailTolerance: 1e-10, maxGoals: 40 },
    competitionCode: 'CL',
    fixtures,
    baseline: championsLeagueBaseline(fixtures),
    fixedContext: {
      championsLeagueTieBreaks: teamIds.map((teamId) => ({
        teamId,
        disciplinaryPoints: 0,
        clubCoefficient: 37 - teamId,
      })),
    },
  };
}

function championsLeagueBaseline(fixtures: readonly SeasonCalendarFixture[]) {
  return baselineFromKnown(fixtures, 36).map((row) => ({
    ...row,
    points: row.won * 3 + row.draw,
  }));
}

function withPoints(
  base: LeagueSimulationInput,
  values: Readonly<Record<number, number>>,
): LeagueSimulationInput {
  return {
    ...base,
    baseline: base.baseline.map((row) => ({
      ...row,
      points: values[row.teamId] ?? row.points,
    })),
  };
}

const titleScenario = {
  kind: 'title',
  higherTeamId: 2,
  lowerTeamId: 1,
  higherHome: { homeRate90: 0, awayRate90: 0 },
  higherSeedShootoutWinProbability: 0,
} as const satisfies SerieAPlayOffScenario;

const survivalScenario = {
  kind: 'survival',
  higherTeamId: 18,
  lowerTeamId: 17,
  higherHome: { homeRate90: 0, awayRate90: 0 },
  lowerHome: { homeRate90: 3, awayRate90: 0 },
  higherSeedShootoutWinProbability: 1,
} as const satisfies SerieAPlayOffScenario;

describe('cooperative seeded league simulation', () => {
  it('matches fixture outcomes independently derived from C-reference random numerators', () => {
    const job = createLeagueSimulation(input())!;
    expect(job.status).toBe('ready');
    expect(job.completedRuns).toBe(0);
    expect(job.result()).toBeNull();
    job.advance(4);
    expect(job.status).toBe('complete');
    expect(job.completedRuns).toBe(4);
    const result = job.result()!;
    expect(LEAGUE_SIMULATION_ALGORITHM).toBe(
      'seeded-fixed-rate-league-simulation-v4',
    );
    expect(result.algorithm).toBe(LEAGUE_SIMULATION_ALGORITHM);
    expect(result.versions.random).toBe(SEEDED_RANDOM_ALGORITHM);
    // The existing C-reference numerators yield 0:0, 1:0, 3:0, 3:2 at rates 1.6/0.8.
    // Gains are [1,3,3,3] and [1,0,0,0]; known games must not be added again.
    expect(result.forecast.teams[0]!.expectedPoints).toBe(-97.5);
    expect(result.forecast.teams[1]!.expectedPoints).toBe(-199.75);
    expect(result.forecast.teams[0]!.pointsInterval80).toEqual({
      lower: -99,
      upper: -97,
    });
    expect(result.forecast.teams[1]!.pointsInterval80).toEqual({
      lower: -200,
      upper: -199,
    });
    expect(result.forecast.teams[2]!.expectedPoints).toBe(-300);
    expect(result.forecast.teams[0]!.positionDistribution[0]!.count).toBe(4);
    expect(result.samplingBounds.perRun).toBeGreaterThan(0);
    expect(result.samplingBounds.allRuns).toBe(
      Math.min(1, 4 * result.samplingBounds.perRun),
    );
    expect(result.lotPolicy).toBe('simulate-eligible-uniform-lots');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('keeps the same random stream across batches and recreates a job from its snapshot', () => {
    const source = input();
    const first = createLeagueSimulation(source)!;
    first.advance(100);
    const second = createLeagueSimulation({
      ...source,
      baseline: [...source.baseline].reverse(),
      fixtures: [...source.fixtures].reverse(),
      seed: JSON.parse(JSON.stringify(source.seed)),
    })!;
    second.advance();
    expect(second.status).toBe('running');
    expect(second.completedRuns).toBe(1);
    expect(second.result()).toBeNull();
    second.advance(2);
    expect(second.completedRuns).toBe(3);
    second.advance(100);
    expect(second.result()).toEqual(first.result());
    const replay = createLeagueSimulation(
      JSON.parse(JSON.stringify(first.result()!.inputSnapshot)),
    )!;
    replay.advance(2);
    replay.advance(2);
    expect(replay.result()).toEqual(first.result());
  });

  it.each(['PL', 'PD', 'BL1', 'SA', 'FL1'] as const)(
    'runs the existing %s projection/ranking/summary pipeline',
    (code) => {
      const source = input(code, 1);
      const job = createLeagueSimulation(source)!;
      job.advance();
      const result = job.result()!;
      expect(job.status).toBe('complete');
      expect(result.forecast.competitionCode).toBe(code);
      expect(result.forecast.teams).toHaveLength(source.baseline.length);
      expect(result.forecast.teams[0]!.expectedPoints).toBe(-99);
      expect(result.forecast.teams[1]!.expectedPoints).toBe(-199);
      expect(
        result.forecast.teams.every(
          (team, index) => team.positionDistribution[index]!.count === 1,
        ),
      ).toBe(true);
    },
  );

  it('keeps completed known results and official deductions fixed', () => {
    const source = input('PL', 3, false);
    const job = createLeagueSimulation(source)!;
    job.advance(3);
    const result = job.result()!;
    expect(result.forecast.teams[0]!.expectedPoints).toBe(-100);
    expect(result.forecast.teams[0]!.pointsInterval80).toEqual({
      lower: -100,
      upper: -100,
    });
    expect(result.samplingBounds).toEqual({ perRun: 0, allRuns: 0 });
    expect(result.inputSnapshot.modelVersion).toBe(source.modelVersion);
    expect(result.inputSnapshot.dataCutoffMs).toBe(source.dataCutoffMs);
    expect(result.inputSnapshot.seed).toEqual(source.seed);
    expect(result.inputSnapshot.fixtures).toHaveLength(380);
  });

  it('samples only eligible Ligue 1 lots and retains fixed final discipline assumptions', () => {
    const base = withPoints(input('FL1', 6, false), { 1: 0, 2: 0 });
    const source = {
      ...base,
      fixedContext: {
        ligue1Discipline: [
          { teamId: 2, points: 0 },
          { teamId: 1, points: 0 },
        ],
      },
    };
    const single = createLeagueSimulation(source)!;
    single.advance(6);
    const batched = createLeagueSimulation(source)!;
    for (let index = 0; index < 6; index += 1) batched.advance();
    const result = single.result()!;
    expect(batched.result()).toEqual(result);
    expect(result.versions.ranking).toBe('fl1-season-head-to-head-v2');
    expect(result.inputSnapshot.fixedContext.ligue1Discipline).toEqual([
      { teamId: 1, points: 0 },
      { teamId: 2, points: 0 },
    ]);
    expect(
      result.forecast.teams[0]!.positionDistribution.slice(0, 2).reduce(
        (sum, bin) => sum + bin.count,
        0,
      ),
    ).toBe(6);
    expect(
      result.forecast.teams[1]!.positionDistribution.slice(0, 2).reduce(
        (sum, bin) => sum + bin.count,
        0,
      ),
    ).toBe(6);
    expect(result.samplingBounds).toEqual({ perRun: 0, allRuns: 0 });
  });

  it('uses explicitly supplied final Fair Play ranks for La Liga', () => {
    const source = withPoints(input('PD', 2, false), { 1: 0, 2: 0 });
    const job = createLeagueSimulation({
      ...source,
      fixedContext: {
        laLigaFairPlay: [
          { teamId: 2, rank: 2 },
          { teamId: 1, rank: 1 },
        ],
      },
    })!;
    job.advance(2);
    expect(job.result()!.forecast.teams[0]!.positionDistribution[0]!.count).toBe(2);
    expect(job.result()!.inputSnapshot.fixedContext.laLigaFairPlay).toEqual([
      { teamId: 1, rank: 1 },
      { teamId: 2, rank: 2 },
    ]);
  });

  it.each([
    { code: 'PD' as const, expected: 'fair-play-data-required' },
    { code: 'FL1' as const, expected: 'disciplinary-data-required' },
    { code: 'BL1' as const, expected: 'play-off-required' },
  ])(
    'withholds a forecast for unresolved $code ranking criteria',
    ({ code, expected }) => {
      const job = createLeagueSimulation(
        withPoints(input(code, 2, false), { 1: 0, 2: 0 }),
      )!;
      job.advance(2);
      expect(job.status).toBe('unavailable');
      expect(job.completedRuns).toBe(0);
      expect(job.result()).toBeNull();
      expect(job.unavailability!.reason).toBe('ranking-unresolved');
      expect(job.unavailability!.groups[0]!.reason).toBe(expected);
    },
  );

  it.each([2023, 2024])(
    'does not invent a draw for an LFP decision in season %s',
    (season) => {
      const base = withPoints(input('FL1', 1, false), { 1: 0, 2: 0 });
      const job = createLeagueSimulation({
        ...base,
        season,
        fixedContext: {
          ligue1Discipline: [
            { teamId: 1, points: 0 },
            { teamId: 2, points: 0 },
          ],
        },
      })!;
      job.advance();
      expect(job.status).toBe('unavailable');
      expect(job.unavailability!.groups[0]!.reason).toBe('league-decision-required');
    },
  );

  it('withholds the entire forecast when a later sampled run needs a Premier League play-off', () => {
    // Run 1 is 0:0 and keeps distinct points; run 2 is 1:0 and makes clubs 1/2
    // fully equal in the complete league and both direct criteria.
    const job = createLeagueSimulation(
      withPoints(input(), { 1: 0, 2: 3, 8: -800, 9: -800 }),
    )!;
    job.advance(100);
    expect(job.status).toBe('unavailable');
    expect(job.completedRuns).toBe(1);
    expect(job.result()).toBeNull();
    expect(job.unavailability).toEqual({
      run: 2,
      reason: 'ranking-unresolved',
      playOffEvents: [],
      groups: [{ from: 1, to: 2, teamIds: [1, 2], reason: 'play-off-required' }],
    });
    job.advance(100);
    job.cancel();
    expect(job.status).toBe('unavailable');
    expect(job.completedRuns).toBe(1);
  });

  it('keeps a joint Premier League finish and the next distinct place in the forecast', () => {
    const source = withPoints(input('PL', 2, false), { 8: -800, 9: -800 });
    const job = createLeagueSimulation(source)!;
    job.advance(2);
    expect(job.status).toBe('complete');
    expect(job.unavailability).toBeNull();
    const { forecast, inputSnapshot } = job.result()!;
    for (const teamId of [8, 9]) {
      const team = forecast.teams[teamId - 1]!;
      expect(team.positionDistribution[7]!.count).toBe(2);
      expect(team.positionDistribution[8]!.count).toBe(0);
      expect(team.sharedPositionDistribution).toEqual([
        { from: 8, to: 9, count: 2, probability: 1 },
      ]);
    }
    expect(forecast.teams[9]!.positionDistribution[9]!.count).toBe(2);
    const replay = createLeagueSimulation(
      JSON.parse(JSON.stringify(inputSnapshot)),
    )!;
    replay.advance();
    replay.advance();
    expect(replay.result()).toEqual(job.result());
  });

  it.each([
    { finalists: null, decision: 'uefa-finalists-required' },
    { finalists: [] as number[], decision: 'play-off-required' },
  ])(
    'reports the selected Serie A pair and required context: %j',
    ({ finalists, decision }) => {
      const base = withPoints(input('SA', 1, false), { 1: 0, 2: 0 });
      const job = createLeagueSimulation({
        ...base,
        fixedContext: { serieAUefaFinalistTeamIds: finalists },
      })!;
      job.advance();
      expect(job.status).toBe('unavailable');
      expect(job.unavailability!.reason).toBe('serie-a-play-off-context-required');
      const event = job.unavailability!.playOffEvents[0]!;
      expect(event.higherSlot.candidateTeamIds).toEqual([2]);
      expect(event.lowerSlot.candidateTeamIds).toEqual([1]);
      expect(event.decision).toBe(decision);
      expect(job.result()).toBeNull();
    },
  );

  it('applies Serie A model lots and a known fixed UEFA waiver through the final ranker', () => {
    const base = withPoints(input('SA', 1, false), { 1: 0, 2: 0 });
    const job = createLeagueSimulation({
      ...base,
      fixedContext: {
        serieAUefaFinalistTeamIds: [1],
        serieAPlayOffScenarios: [titleScenario],
      },
    })!;
    job.advance();
    const result = job.result()!;
    expect(result.versions.ranking).toBe('sa-lots-and-play-offs-ranking-v1');
    expect(result.forecast.teams[0]!.positionDistribution[1]!.count).toBe(1);
    expect(result.forecast.teams[1]!.positionDistribution[0]!.count).toBe(1);
    expect(result.inputSnapshot.fixedContext.serieAUefaFinalistTeamIds).toEqual([1]);
  });

  it('samples both Serie A play-offs after the lots and moves only their positions', () => {
    const base = withPoints(input('SA', 1, false), {
      1: 0,
      2: 0,
      17: -1700,
      18: -1700,
    });
    const job = createLeagueSimulation({
      ...base,
      fixedContext: {
        serieAUefaFinalistTeamIds: [],
        serieAPlayOffScenarios: [
          survivalScenario,
          { ...titleScenario, higherHome: { homeRate90: 0.25, awayRate90: 0.25 } },
        ],
      },
    })!;
    job.advance();
    const { forecast, versions, samplingBounds } = job.result()!;
    expect(job.status).toBe('complete');
    expect(versions.knockout).toBe(KNOCKOUT_SAMPLING_ALGORITHM);
    // The first two even C-reference numerators swap both groups, so 2 and
    // 18 are the higher seeds. Title is 0:0 and the lower seed wins penalties.
    // The sixth reference uniform (~0.079) gives 1 home goal at rate 3:
    // club 17 wins the first survival leg, then the reverse leg is 0:0.
    for (const [teamId, place, points] of [
      [1, 1, 0],
      [2, 2, 0],
      [17, 17, -1700],
      [18, 18, -1700],
    ] as const) {
      const team = forecast.teams[teamId - 1]!;
      expect(team.positionDistribution[place - 1]!.count).toBe(1);
      expect(team.expectedPoints).toBe(points);
    }
    expect(
      forecast.teams[16]!.zones.find(({ zone }) => zone === 'releg')!.count,
    ).toBe(0);
    expect(
      forecast.teams[17]!.zones.find(({ zone }) => zone === 'releg')!.count,
    ).toBe(1);
    const bound =
      createPoissonScoreSampler(0.25, 0.25, base.sampling)!.tailUpperBound +
      createPoissonScoreSampler(3, 0, base.sampling)!.tailUpperBound;
    expect(samplingBounds).toEqual({ perRun: bound, allRuns: bound });
  });

  it('replays a Serie A forecast across batches and keeps canonical scenario rates isolated', () => {
    const base = withPoints(input('SA', 8, false), { 1: 0, 2: 0 });
    const higherHome = { homeRate90: 0, awayRate90: 0 };
    const otherOrder = {
      ...titleScenario,
      higherTeamId: 1,
      lowerTeamId: 2,
      higherHome: { homeRate90: 0.5, awayRate90: 0.5 },
      higherSeedShootoutWinProbability: 0.4,
    };
    const firstPair = {
      ...titleScenario,
      higherHome,
      higherSeedShootoutWinProbability: 0,
    };
    const serieAPlayOffScenarios = [firstPair, otherOrder];
    const source = {
      ...base,
      fixedContext: { serieAUefaFinalistTeamIds: [], serieAPlayOffScenarios },
    };
    const single = createLeagueSimulation(source)!;
    const batched = createLeagueSimulation({
      ...source,
      fixedContext: {
        ...source.fixedContext,
        serieAPlayOffScenarios: [...serieAPlayOffScenarios].reverse(),
      },
    })!;
    higherHome.homeRate90 = 10;
    firstPair.higherSeedShootoutWinProbability = 1;
    serieAPlayOffScenarios.pop();
    single.advance(8);
    batched.advance(3);
    batched.advance(5);
    const result = single.result()!;
    expect(batched.result()).toEqual(result);
    expect(result.inputSnapshot.fixedContext.serieAPlayOffScenarios).toMatchObject([
      { higherTeamId: 1, lowerTeamId: 2, higherHome: { homeRate90: 0.5 } },
      {
        higherTeamId: 2,
        lowerTeamId: 1,
        higherHome: { homeRate90: 0 },
        higherSeedShootoutWinProbability: 0,
      },
    ]);
    const replay = createLeagueSimulation(
      JSON.parse(JSON.stringify(result.inputSnapshot)),
    )!;
    replay.advance(8);
    expect(replay.result()).toEqual(result);
    const bound = createPoissonScoreSampler(0.5, 0.5, base.sampling)!.tailUpperBound;
    expect(result.samplingBounds).toEqual({ perRun: bound, allRuns: 8 * bound });
  });

  it('withholds the whole forecast when the second run needs an uncovered pair', () => {
    const base = withPoints(input('SA', 3), { 1: 0, 2: 3 });
    const job = createLeagueSimulation({
      ...base,
      fixedContext: { serieAUefaFinalistTeamIds: [] },
    })!;
    job.advance(3);
    expect(job.status).toBe('unavailable');
    expect(job.completedRuns).toBe(1);
    expect(job.unavailability).toMatchObject({
      run: 2,
      reason: 'serie-a-play-off-context-required',
      playOffEvents: [{ kind: 'title', decision: 'play-off-required' }],
    });
    expect(job.result()).toBeNull();
  });

  it('distinguishes a reversed seed order from a pair whose rates exceed the sampling budget', () => {
    const base = withPoints(input('SA', 1, false), { 1: 0, 2: 0 });
    const configurations = [
      {
        scenario: { ...titleScenario, higherTeamId: 1, lowerTeamId: 2 },
        reason: 'serie-a-play-off-context-required',
      },
      {
        scenario: {
          ...titleScenario,
          higherHome: { homeRate90: Number.MAX_VALUE, awayRate90: 1 },
        },
        reason: 'serie-a-play-off-sampling-unavailable',
      },
    ];
    for (const { scenario, reason } of configurations) {
      const job = createLeagueSimulation({
        ...base,
        fixedContext: {
          serieAUefaFinalistTeamIds: [],
          serieAPlayOffScenarios: [scenario],
        },
      })!;
      job.advance();
      expect(job.status).toBe('unavailable');
      expect(job.unavailability).toMatchObject({
        run: 1,
        reason,
        playOffEvents: [
          {
            kind: 'title',
            higherSlot: { candidateTeamIds: [2] },
            lowerSlot: { candidateTeamIds: [1] },
          },
        ],
      });
      expect(job.result()).toBeNull();
    }
  });

  it('validates unused scenarios and rejects them for other leagues', () => {
    const base = input('SA', 1, false);
    const invalid = [
      [titleScenario, titleScenario],
      [{ ...titleScenario, lowerTeamId: 999 }],
      [{ ...titleScenario, lowerTeamId: 2 }],
      [{ ...titleScenario, higherSeedShootoutWinProbability: 1.1 }],
      [{ ...titleScenario, higherHome: { homeRate90: -1, awayRate90: 0 } }],
      [{ ...survivalScenario, lowerHome: { homeRate90: 0, awayRate90: NaN } }],
    ];
    for (const serieAPlayOffScenarios of invalid)
      expect(() =>
        createLeagueSimulation({
          ...base,
          fixedContext: { serieAPlayOffScenarios },
        }),
      ).toThrow(RangeError);
    expect(() =>
      createLeagueSimulation({
        ...input('PL'),
        fixedContext: { serieAPlayOffScenarios: [titleScenario] },
      }),
    ).toThrow(RangeError);
  });

  it.each([false, true])(
    'cancels a job between batches, after progress: %s',
    (started) => {
      const job = createLeagueSimulation(input())!;
      if (started) job.advance();
      const completed = job.completedRuns;
      job.cancel();
      expect(job.status).toBe('cancelled');
      job.advance(100);
      expect(job.completedRuns).toBe(completed);
      expect(job.result()).toBeNull();
    },
  );

  it('keeps a completed result stable after cancellation and extra advances', () => {
    const job = createLeagueSimulation(input('PL', 1))!;
    job.advance();
    const expected = job.result();
    job.cancel();
    job.advance(100);
    expect(job.status).toBe('complete');
    expect(job.completedRuns).toBe(1);
    expect(job.result()).toEqual(expected);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid batch size without consuming runs: %s',
    (size) => {
      const job = createLeagueSimulation(input())!;
      expect(() => job.advance(size)).toThrow(RangeError);
      expect(job.status).toBe('ready');
      expect(job.completedRuns).toBe(0);
      job.advance(4);
      expect(job.result()!.forecast.teams[0]!.expectedPoints).toBe(-97.5);
    },
  );

  it('marks unexpected per-run arithmetic errors failed without publishing a prefix', () => {
    const source = withPoints(input(), { 1: Number.MAX_SAFE_INTEGER - 2 });
    const job = createLeagueSimulation(source)!;
    job.advance();
    expect(job.completedRuns).toBe(1);
    expect(() => job.advance()).toThrow(RangeError); // Run 2 adds three points.
    expect(job.status).toBe('failed');
    expect(job.completedRuns).toBe(1);
    expect(job.result()).toBeNull();
    job.advance(100);
    job.cancel();
    expect(job.status).toBe('failed');
  });

  it.each([
    { modelVersion: '' },
    { dataCutoffMs: NaN },
    { dataCutoffMs: 8640000000000001 },
    { runs: 0 },
    { seed: [0, 0, 0, 0] as RandomSeed },
  ])('validates common model metadata and controls: %j', (patch) => {
    expect(() => createLeagueSimulation({ ...input(), ...patch })).toThrow(
      RangeError,
    );
  });

  it('returns null for unsupported formats, seasons and insufficient Poisson support', () => {
    const source = input();
    expect(
      createLeagueSimulation({ ...championsLeagueInput(), season: 2023 }),
    ).toBeNull();
    expect(
      createLeagueSimulation({
        ...source,
        competitionCode: 'ELC' as SiteCompetitionCode,
      }),
    ).toBeNull();
    expect(createLeagueSimulation({ ...source, season: 2027 })).toBeNull();
    expect(
      createLeagueSimulation({
        ...source,
        sampling: { tailTolerance: 1e-12, maxGoals: 0 },
      }),
    ).toBeNull();
  });

  it('forecasts Champions League points, places and advancement over the remaining calendar', () => {
    const source = championsLeagueInput();
    const job = createLeagueSimulation(source)!;
    expect(job.status).toBe('ready');
    job.advance(4);
    expect(job.status).toBe('complete');
    const { forecast, versions, samplingBounds } = job.result()!;
    expect(versions.ranking).toBe(CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM);
    expect(versions.knockout).toBeNull();
    expect(forecast.competitionCode).toBe('CL');
    expect(forecast.teams).toHaveLength(36);
    const [home, away] = forecast.teams;
    // Python independently evaluated the C-reference draws and all standings:
    // 0:0 -> places 36/1; 1:0 -> 1/2; 3:0 -> 1/36; 3:2 -> 2/1.
    expect(home!.expectedPoints).toBe(11.5);
    expect(away!.expectedPoints).toBe(12.25);
    expect(home!.pointsInterval80).toEqual({ lower: 10, upper: 12 });
    expect(away!.pointsInterval80).toEqual({ lower: 12, upper: 13 });
    for (const team of [home!, away!]) {
      expect(team.positionDistribution.filter(({ count }) => count > 0)).toEqual([
        { position: 1, count: 2, probability: 0.5 },
        { position: 2, count: 1, probability: 0.25 },
        { position: 36, count: 1, probability: 0.25 },
      ]);
      expect(
        team.zones.map(({ from, to, probability }) => [from, to, probability]),
      ).toEqual([
        [1, 8, 0.75],
        [9, 24, 0],
        [25, 36, 0.25],
      ]);
    }
    expect(forecast.teams[2]!.expectedPoints).toBe(12);
    expect(
      forecast.teams[0]!.zones.map((_, index) =>
        forecast.teams.reduce((sum, team) => sum + team.zones[index]!.count, 0),
      ),
    ).toEqual([32, 64, 48]);
    expect(samplingBounds.perRun).toBeGreaterThan(0);
    expect(samplingBounds.allRuns).toBe(4 * samplingBounds.perRun);
  });

  it('replays the Champions League forecast from a canonical fixed context', () => {
    const source = championsLeagueInput();
    const supplied = source.fixedContext!.championsLeagueTieBreaks!.map((row) => ({
      ...row,
    }));
    const job = createLeagueSimulation({
      ...source,
      fixtures: [...source.fixtures].reverse(),
      fixedContext: { championsLeagueTieBreaks: supplied.reverse() },
    })!;
    supplied[0]!.clubCoefficient = 999;
    supplied.pop();
    job.advance();
    expect(job.status).toBe('running');
    job.advance(3);
    const first = job.result()!;
    expect(first.inputSnapshot.fixedContext.championsLeagueTieBreaks).toEqual(
      source.fixedContext!.championsLeagueTieBreaks,
    );
    const replay = createLeagueSimulation(
      JSON.parse(JSON.stringify(first.inputSnapshot)),
    )!;
    replay.advance(4);
    expect(replay.result()).toEqual(first);
  });

  it.each(['disciplinaryPoints', 'clubCoefficient'] as const)(
    'identifies missing Champions League %s in a later tied run',
    (criterion) => {
      const source = championsLeagueInput();
      const job = createLeagueSimulation({
        ...source,
        fixedContext: {
          championsLeagueTieBreaks:
            source.fixedContext!.championsLeagueTieBreaks!.map((row) =>
              row.teamId === 1 ? { ...row, [criterion]: null } : row,
            ),
        },
      })!;
      // Team 1 is last outright after the first 0:0. After 1:0 all
      // sporting criteria tie and a full ranking needs the missing input.
      job.advance(4);
      expect(job.status).toBe('unavailable');
      expect(job.completedRuns).toBe(1);
      expect(job.unavailability).toMatchObject({
        run: 2,
        reason: 'ranking-unresolved',
        groups: [
          {
            from: 1,
            to: 36,
            reason: 'missing-criterion',
            missingCriterion: criterion,
          },
        ],
      });
      expect(job.unavailability!.groups[0]!.teamIds).toHaveLength(36);
      expect(job.result()).toBeNull();
    },
  );

  it('rejects an incomplete or invalid Champions League calendar during preparation', () => {
    const source = championsLeagueInput();
    expect(
      createLeagueSimulation({ ...source, fixtures: source.fixtures.slice(1) }),
    ).toBeNull();
    // Keep four home and away games for each team, but play 5 vs 2
    // in addition to the existing 2 vs 5.
    const fixtures = source.fixtures.map((fixture) => {
      if (fixture.id === 1) return { ...fixture, awayTeamId: 6 };
      if (fixture.id === 17) return { ...fixture, awayTeamId: 2 };
      return fixture;
    });
    expect(
      createLeagueSimulation({
        ...source,
        fixtures,
        baseline: championsLeagueBaseline(fixtures),
      }),
    ).toBeNull();
    const baseline = source.baseline.map((row) =>
      row.teamId === 1 ? { ...row, points: row.points - 1 } : row,
    );
    expect(createLeagueSimulation({ ...source, baseline })).toBeNull();
  });

  it('validates supplied Champions League context during preparation', () => {
    const source = championsLeagueInput();
    for (const entry of [
      { teamId: 999, disciplinaryPoints: 0, clubCoefficient: 1.125 },
      { teamId: 1, disciplinaryPoints: -1, clubCoefficient: 1.125 },
      { teamId: 1, disciplinaryPoints: 0, clubCoefficient: NaN },
    ]) {
      expect(() =>
        createLeagueSimulation({
          ...source,
          fixedContext: { championsLeagueTieBreaks: [entry] },
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      createLeagueSimulation({
        ...input(),
        fixedContext: source.fixedContext,
      }),
    ).toThrow(RangeError);
  });

  it('preflights known-result reconciliation and complete oriented pair coverage', () => {
    const source = input();
    const baseline = source.baseline.map((row, index) =>
      index === 0 ? { ...row, goalsFor: row.goalsFor + 1 } : row,
    );
    expect(createLeagueSimulation({ ...source, baseline })).toBeNull();
    expect(
      createLeagueSimulation({ ...source, fixtures: source.fixtures.slice(1) }),
    ).toBeNull();
    const fixtures = source.fixtures.map((fixture) => ({ ...fixture }));
    const index = fixtures.findIndex(
      (fixture) => fixture.homeTeamId === 2 && fixture.awayTeamId === 1,
    );
    fixtures[index] = { ...fixtures[index]!, homeTeamId: 1, awayTeamId: 2 };
    expect(
      createLeagueSimulation({
        ...source,
        fixtures,
        baseline: baselineFromKnown(fixtures, 20),
      }),
    ).toBeNull();
  });

  it('validates rates, known scores and fixed league context before returning a job', () => {
    const source = input();
    const invalidRate: SeasonCalendarFixture = {
      id: 1,
      homeTeamId: 1,
      awayTeamId: 2,
      kind: 'forecast',
      homeRate90: NaN,
      awayRate90: 1,
    };
    expect(() =>
      createLeagueSimulation({
        ...source,
        fixtures: [invalidRate, ...source.fixtures.slice(1)],
      }),
    ).toThrow(RangeError);
    const invalidKnown: SeasonCalendarFixture = {
      id: 2,
      homeTeamId: 1,
      awayTeamId: 3,
      kind: 'known-result',
      homeGoals90: -1,
      awayGoals90: 0,
    };
    expect(() =>
      createLeagueSimulation({
        ...source,
        fixtures: [source.fixtures[0]!, invalidKnown, ...source.fixtures.slice(2)],
      }),
    ).toThrow(RangeError);
    expect(() =>
      createLeagueSimulation({
        ...source,
        fixedContext: { ligue1Discipline: [{ teamId: 1, points: 0 }] },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createLeagueSimulation({
        ...input('PD'),
        fixedContext: { laLigaFairPlay: [{ teamId: 999, rank: 1 }] },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createLeagueSimulation({
        ...input('FL1'),
        fixedContext: { ligue1Discipline: [{ teamId: 1, points: -1 }] },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createLeagueSimulation({
        ...input('SA'),
        fixedContext: { serieAUefaFinalistTeamIds: [999] },
      }),
    ).toThrow(RangeError);
  });

  it('copies inputs at preparation time and returns independent snapshots and forecasts', () => {
    const source = input();
    const baseline = source.baseline.map((row) => ({ ...row }));
    const fixtures = source.fixtures.map((fixture) => ({ ...fixture }));
    const seed: [number, number, number, number] = [...source.seed];
    const job = createLeagueSimulation({ ...source, baseline, fixtures, seed })!;
    baseline[0]!.points = 0;
    fixtures[0] = {
      id: 1,
      homeTeamId: 1,
      awayTeamId: 2,
      kind: 'forecast',
      homeRate90: 0,
      awayRate90: 0,
    };
    seed.fill(0);
    job.advance(4);
    const expected = job.result()!;
    const result = job.result()!;
    expect(result.forecast.teams[0]!.expectedPoints).toBe(-97.5);
    result.forecast.teams[0]!.expectedPoints = 999;
    (result.inputSnapshot.fixtures as SeasonCalendarFixture[]).pop();
    expect(job.result()).toEqual(expected);
    expect(expected.inputSnapshot.seed).toEqual([1, 2, 3, 4]);
    expect(expected.inputSnapshot.baseline[0]!.points).toBe(-100);
    expect(expected.inputSnapshot.fixtures).toHaveLength(380);
  });

  it('accepts frozen input snapshots and returns independent unavailability diagnostics', () => {
    const base = withPoints(input('FL1', 1, false), { 1: 0, 2: 0 });
    for (const row of base.baseline) Object.freeze(row);
    for (const fixture of base.fixtures) Object.freeze(fixture);
    Object.freeze(base.baseline);
    Object.freeze(base.fixtures);
    Object.freeze(base.sampling);
    Object.freeze(base.seed);
    Object.freeze(base);
    const job = createLeagueSimulation(base)!;
    job.advance();
    const expected = job.unavailability!;
    const changed = job.unavailability!;
    changed.groups[0]!.teamIds.push(999);
    changed.run = 999;
    expect(job.unavailability).toEqual(expected);
    expect(job.unavailability!.groups[0]!.teamIds).toEqual([1, 2]);
  });
});
