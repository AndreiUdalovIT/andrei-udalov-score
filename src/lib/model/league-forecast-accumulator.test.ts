import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { SiteCompetitionCode } from '@/lib/config/competitions';

import { rankBundesligaSeason } from './bundesliga-ranking';
import { rankLaLigaSeason } from './la-liga-ranking';
import {
  createLeagueForecastAccumulator,
  LEAGUE_FORECAST_ACCUMULATION_ALGORITHM,
  LEAGUE_POINTS_INTERVAL_METHOD,
  type LeagueForecastPoints,
  type LeagueForecastPositionGroup,
} from './league-forecast-accumulator';
import { rankLigue1Season } from './ligue1-ranking';
import { rankPremierLeagueSeason } from './premier-league-ranking';
import { rankSerieASeason } from './serie-a-ranking';
import { projectSeasonStats } from './season-stats';

const ids20 = Array.from({ length: 20 }, (_, index) => index + 1);

function points(ids = ids20, total = 0): LeagueForecastPoints[] {
  return ids.map((teamId) => ({ teamId, points: total }));
}

function ranking(ids = ids20): LeagueForecastPositionGroup[] {
  return ids.map((teamId, index) => ({
    from: index + 1,
    to: index + 1,
    teamIds: [teamId],
  }));
}

function rankingWithSharedRange(
  from: number,
  to: number,
): LeagueForecastPositionGroup[] {
  return [
    ...ranking().slice(0, from - 1),
    { from, to, teamIds: ids20.slice(from - 1, to), reason: 'shared-position' },
    ...ranking().slice(to),
  ];
}

function atPosition(teamId: number, position: number, ids = ids20): number[] {
  const ordered = [...ids];
  const previous = ordered.indexOf(teamId);
  [ordered[previous], ordered[position - 1]] = [
    ordered[position - 1]!,
    ordered[previous]!,
  ];
  return ordered;
}

function completeLeague(teamCount: number) {
  const ids = Array.from({ length: teamCount }, (_, index) => index + 1);
  const scores = ids.flatMap((homeTeamId) =>
    ids
      .filter((awayTeamId) => awayTeamId !== homeTeamId)
      .map((awayTeamId) => ({
        id: (homeTeamId - 1) * teamCount + awayTeamId,
        homeTeamId,
        awayTeamId,
        homeGoals90: 1,
        awayGoals90: 0,
      })),
  );
  const baseline = ids.map((teamId) => ({
    teamId,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  const rows = projectSeasonStats(
    baseline,
    scores.map((score) => ({ ...score, source: 'simulated' as const })),
  )!.map((row) => ({ ...row, points: -row.teamId }));
  return { ids, rows, scores };
}

describe('complete league forecast accumulation', () => {
  it('withholds a summary until exactly the requested number of runs', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 2)!;
    expect(accumulator.algorithm).toBe('complete-league-empirical-summary-v3');
    expect(accumulator.algorithm).toBe(LEAGUE_FORECAST_ACCUMULATION_ALGORITHM);
    expect(accumulator.targetRuns).toBe(2);
    expect(accumulator.completedRuns).toBe(0);
    expect(accumulator.status).toBe('collecting');
    expect(accumulator.summarize()).toBeNull();
    accumulator.addRun(points(), ranking());
    expect(accumulator.completedRuns).toBe(1);
    expect(accumulator.status).toBe('collecting');
    expect(accumulator.summarize()).toBeNull();
    accumulator.addRun(points(), ranking());
    const result = accumulator.summarize()!;
    expect(accumulator.status).toBe('complete');
    expect(result.competitionCode).toBe('PL');
    expect(result.season).toBe(2026);
    expect(result.runs).toBe(2);
    expect(result.pointsIntervalMethod).toBe('inverse-empirical-cdf-10-90-v1');
    expect(result.pointsIntervalMethod).toBe(LEAGUE_POINTS_INTERVAL_METHOD);
    expect(result.qualificationNote).toBe(
      getCompetitionSeasonConfig('PL', 2026)!.qualificationNote,
    );
    expect(result.teams.map((team) => team.teamId)).toEqual(ids20);
  });

  it('uses empirical inverse-CDF endpoints rather than interpolation', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 10)!;
    for (let value = 0; value < 10; value += 1)
      accumulator.addRun(points(ids20, value), ranking());
    const team = accumulator.summarize()!.teams[0]!;
    expect(team.expectedPoints).toBe(4.5);
    expect(team.pointsInterval80).toEqual({ lower: 0, upper: 8 });
    expect(team.positionDistribution[0]).toEqual({
      position: 1,
      count: 10,
      probability: 1,
    });
    expect(
      team.positionDistribution
        .slice(1)
        .every((bin) => bin.count === 0 && bin.probability === 0),
    ).toBe(true);
  });

  it('supports negative points and non-divisible sample ranks', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 11)!;
    for (let value = -10; value <= 0; value += 1)
      accumulator.addRun(points(ids20, value), ranking());
    const team = accumulator.summarize()!.teams[0]!;
    expect(team.expectedPoints).toBe(-5);
    expect(team.pointsInterval80).toEqual({ lower: -9, upper: -1 });
  });

  it('preserves repeated point masses and uses singleton intervals for a single run', () => {
    const single = createLeagueForecastAccumulator('PL', 2026, ids20, 1)!;
    single.addRun(points(ids20, -7), ranking());
    expect(single.summarize()!.teams[0]!.pointsInterval80).toEqual({
      lower: -7,
      upper: -7,
    });
    const repeated = createLeagueForecastAccumulator('PL', 2026, ids20, 10)!;
    for (let index = 0; index < 10; index += 1)
      repeated.addRun(points(ids20, index === 9 ? 100 : 3), ranking());
    expect(repeated.summarize()!.teams[0]!.pointsInterval80).toEqual({
      lower: 3,
      upper: 3,
    });
    expect(repeated.summarize()!.teams[0]!.expectedPoints).toBe(12.7);
  });

  it.each([
    {
      values: [
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER - 2,
      ],
      mean: Number.MAX_SAFE_INTEGER - 1,
    },
    { values: [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER], mean: 0 },
    { values: [-4, -4, -3], mean: -11 / 3 },
  ])(
    'sums integer points without cumulative Number overflow: %j',
    ({ values, mean }) => {
      const accumulator = createLeagueForecastAccumulator(
        'PL',
        2026,
        ids20,
        values.length,
      )!;
      for (const value of values)
        accumulator.addRun(points(ids20, value), ranking());
      expect(accumulator.summarize()!.teams[0]!.expectedPoints).toBe(mean);
    },
  );

  it('counts position and range occupancy without rounding probabilities', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 3)!;
    for (const position of [1, 4, 18])
      accumulator.addRun(points(), ranking(atPosition(1, position)));
    const team = accumulator.summarize()!.teams[0]!;
    expect(team.positionDistribution.filter((bin) => bin.count > 0)).toEqual([
      { position: 1, count: 1, probability: 1 / 3 },
      { position: 4, count: 1, probability: 1 / 3 },
      { position: 18, count: 1, probability: 1 / 3 },
    ]);
    expect(
      team.zones.map(({ from, to, count, probability }) => ({
        from,
        to,
        count,
        probability,
      })),
    ).toEqual([
      { from: 1, to: 4, count: 2, probability: 2 / 3 },
      { from: 5, to: 5, count: 0, probability: 0 },
      { from: 18, to: 20, count: 1, probability: 1 / 3 },
    ]);
  });

  it('uses the selected season quota and preserves its qualification note', () => {
    const summaries = [2023, 2024].map((season) => {
      const accumulator = createLeagueForecastAccumulator('PL', season, ids20, 2)!;
      for (const position of [4, 5])
        accumulator.addRun(points(), ranking(atPosition(1, position)));
      return accumulator.summarize()!;
    });
    expect(summaries[0]!.teams[0]!.zones[0]!.probability).toBe(1 / 2);
    expect(summaries[1]!.teams[0]!.zones[0]!.probability).toBe(1);
    expect(summaries[0]!.qualificationNote).toBe(
      getCompetitionSeasonConfig('PL', 2023)!.qualificationNote,
    );
    expect(summaries[1]!.qualificationNote).toBe(
      getCompetitionSeasonConfig('PL', 2024)!.qualificationNote,
    );
  });

  it('keeps Ligue 1 direct and qualifying UCL ranges separate', () => {
    const ids = Array.from({ length: 18 }, (_, index) => index + 1);
    const accumulator = createLeagueForecastAccumulator('FL1', 2026, ids, 2)!;
    for (const position of [3, 4])
      accumulator.addRun(points(ids), ranking(atPosition(1, position, ids)));
    const zones = accumulator
      .summarize()!
      .teams[0]!.zones.filter((zone) => zone.zone === 'ucl');
    expect(zones).toEqual([
      {
        from: 1,
        to: 3,
        zone: 'ucl',
        label: 'Лига чемпионов',
        count: 1,
        probability: 0.5,
      },
      {
        from: 4,
        to: 4,
        zone: 'ucl',
        label: 'Квалификация ЛЧ',
        count: 1,
        probability: 0.5,
      },
    ]);
  });

  it.each(['PL', 'PD', 'BL1', 'SA', 'FL1'] as const)(
    'accepts complete groups from the existing %s ranker',
    (code) => {
      const size = getCompetitionSeasonConfig(code, 2026)!.teamCount;
      const { ids, rows, scores } = completeLeague(size);
      const rankers = {
        PL: rankPremierLeagueSeason,
        PD: rankLaLigaSeason,
        BL1: rankBundesligaSeason,
        SA: rankSerieASeason,
        FL1: rankLigue1Season,
      };
      const ranked = rankers[code](rows, scores, 2026)!;
      const accumulator = createLeagueForecastAccumulator(code, 2026, ids, 1)!;
      accumulator.addRun(rows, ranked.groups);
      const summary = accumulator.summarize()!;
      expect(summary.teams).toHaveLength(size);
      expect(summary.teams[0]!.expectedPoints).toBe(-1);
      expect(summary.teams[0]!.positionDistribution[0]!.count).toBe(1);
      expect(summary.teams[size - 1]!.positionDistribution[size - 1]!.count).toBe(1);
    },
  );

  it('fails closed for an actual unresolved Ligue 1 disciplinary group', () => {
    const { ids, rows, scores } = completeLeague(18);
    rows[0]!.points = 0;
    rows[1]!.points = 0;
    const ranked = rankLigue1Season(rows, scores, 2026)!;
    expect(ranked.groups[0]!.reason).toBe('disciplinary-data-required');
    const accumulator = createLeagueForecastAccumulator('FL1', 2026, ids, 1)!;
    expect(() => accumulator.addRun(rows, ranked.groups)).toThrow(RangeError);
    expect(accumulator.status).toBe('failed');
    expect(accumulator.completedRuns).toBe(0);
    expect(accumulator.summarize()).toBeNull();
  });

  it.each([
    {
      name: 'missing point row',
      changePoints: (rows: LeagueForecastPoints[]) => rows.slice(1),
    },
    {
      name: 'duplicate point ID',
      changePoints: (rows: LeagueForecastPoints[]) => [
        ...rows.slice(0, -1),
        rows[0]!,
      ],
    },
    {
      name: 'foreign point ID',
      changePoints: (rows: LeagueForecastPoints[]) => [
        ...rows.slice(0, -1),
        { teamId: 999, points: 0 },
      ],
    },
    {
      name: 'unsafe point total',
      changePoints: (rows: LeagueForecastPoints[]) => [
        ...rows.slice(0, -1),
        { teamId: 20, points: Number.MAX_SAFE_INTEGER + 1 },
      ],
    },
    {
      name: 'NaN point total',
      changePoints: (rows: LeagueForecastPoints[]) => [
        ...rows.slice(0, -1),
        { teamId: 20, points: NaN },
      ],
    },
    {
      name: 'sparse point rows',
      changePoints: () => Array<LeagueForecastPoints>(20),
    },
  ])(
    'rejects a malformed run atomically and withholds partial forecasts: $name',
    ({ changePoints }) => {
      const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 2)!;
      accumulator.addRun(points(), ranking());
      expect(() => accumulator.addRun(changePoints(points()), ranking())).toThrow(
        RangeError,
      );
      expect(accumulator.completedRuns).toBe(1);
      expect(accumulator.status).toBe('failed');
      expect(accumulator.summarize()).toBeNull();
      expect(() => accumulator.addRun(points(), ranking())).toThrow(/failed/);
      expect(accumulator.completedRuns).toBe(1);
    },
  );

  it.each([
    {
      name: 'unlabelled position range',
      groups: [{ from: 1, to: 2, teamIds: [1, 2] }, ...ranking().slice(2)],
    },
    {
      name: 'duplicate position',
      groups: [...ranking().slice(0, -1), { from: 1, to: 1, teamIds: [20] }],
    },
    {
      name: 'duplicate club',
      groups: [...ranking().slice(0, -1), { from: 20, to: 20, teamIds: [1] }],
    },
    {
      name: 'foreign club',
      groups: [...ranking().slice(0, -1), { from: 20, to: 20, teamIds: [999] }],
    },
    {
      name: 'fractional position',
      groups: [...ranking().slice(0, -1), { from: 19.5, to: 19.5, teamIds: [20] }],
    },
    { name: 'sparse groups', groups: Array<LeagueForecastPositionGroup>(20) },
  ])('rejects unresolved or inconsistent final rankings: $name', ({ groups }) => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 1)!;
    expect(() => accumulator.addRun(points(), groups)).toThrow(RangeError);
    expect(accumulator.status).toBe('failed');
    expect(accumulator.summarize()).toBeNull();
  });

  it('counts joint finishes by rank and exact range while preserving zone mass', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 3)!;
    accumulator.addRun(points(), ranking());
    accumulator.addRun(points(), rankingWithSharedRange(2, 4).reverse());
    accumulator.addRun(points(), rankingWithSharedRange(2, 3));
    const summary = accumulator.summarize()!;
    const second = summary.teams[1]!;
    const third = summary.teams[2]!;
    const fourth = summary.teams[3]!;
    expect(second.positionDistribution[1]).toEqual({
      position: 2,
      count: 3,
      probability: 1,
    });
    expect(third.positionDistribution.slice(1, 3).map(({ count }) => count)).toEqual(
      [2, 1],
    );
    expect(
      fourth.positionDistribution.slice(1, 4).map(({ count }) => count),
    ).toEqual([1, 0, 2]);
    expect(second.sharedPositionDistribution).toEqual([
      { from: 2, to: 3, count: 1, probability: 1 / 3 },
      { from: 2, to: 4, count: 1, probability: 1 / 3 },
    ]);
    expect(third.sharedPositionDistribution).toEqual(
      second.sharedPositionDistribution,
    );
    expect(fourth.sharedPositionDistribution).toEqual([
      { from: 2, to: 4, count: 1, probability: 1 / 3 },
    ]);
    for (const [index, team] of summary.teams.entries()) {
      expect(
        team.positionDistribution.reduce((sum, bin) => sum + bin.count, 0),
      ).toBe(3);
      expect(team.zones.find(({ zone }) => zone === 'ucl')!.count).toBe(
        index < 4 ? 3 : 0,
      );
    }
    second.sharedPositionDistribution[0]!.count = 999;
    expect(
      accumulator.summarize()!.teams[1]!.sharedPositionDistribution[0]!.count,
    ).toBe(1);
  });

  it('counts each unresolved run once per possible position or zone', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 3)!;
    const unresolved = (from: number, to: number, reason: string) =>
      rankingWithSharedRange(from, to).map((group) =>
        group.from === from ? { ...group, reason } : group,
      );
    accumulator.addRun(points(ids20, 60), ranking());
    accumulator.addRun(points(ids20, 66), unresolved(1, 2, 'play-off-required'));
    accumulator.addRun(
      points(ids20, 69),
      unresolved(3, 5, 'league-decision-required'),
    );

    const summary = accumulator.summarize()!;
    expect(summary.runs).toBe(3);
    expect(summary.unresolvedRankingRuns).toBe(2);

    const first = summary.teams[0]!;
    expect(first.expectedPoints).toBe(65);
    expect(first.pointsInterval80).toEqual({ lower: 60, upper: 69 });
    expect(first.positionDistribution[0]).toEqual({
      position: 1,
      count: 2,
      probability: 2 / 3,
      upperBound: { count: 3, probability: 1 },
    });
    expect(first.positionDistribution[1]).toEqual({
      position: 2,
      count: 0,
      probability: 0,
      upperBound: { count: 1, probability: 1 / 3 },
    });
    expect(first.zones.find(({ zone }) => zone === 'ucl')).toMatchObject({
      count: 3,
      probability: 1,
    });
    expect(first.zones.find(({ zone }) => zone === 'ucl')).not.toHaveProperty(
      'upperBound',
    );
    expect(first.sharedPositionDistribution).toEqual([]);

    const fourth = summary.teams[3]!;
    expect(fourth.zones.find(({ zone }) => zone === 'ucl')).toMatchObject({
      count: 2,
      probability: 2 / 3,
      upperBound: { count: 3, probability: 1 },
    });
    expect(fourth.zones.find(({ zone }) => zone === 'uel')).toMatchObject({
      count: 0,
      probability: 0,
      upperBound: { count: 1, probability: 1 / 3 },
    });
    expect(fourth.zones.find(({ zone }) => zone === 'releg')).toMatchObject({
      count: 0,
      probability: 0,
    });
    expect(fourth.zones.find(({ zone }) => zone === 'releg')).not.toHaveProperty(
      'upperBound',
    );
  });

  it('rejects an unresolved range that misstates the competition, boundary, or reason', () => {
    for (const [code, from, to, reason] of [
      ['PD', 1, 2, 'play-off-required'],
      ['PL', 8, 9, 'play-off-required'],
      ['PL', 1, 3, 'play-off-required'],
      ['PL', 1, 2, 'league-decision-required'],
    ] as const) {
      const groups = rankingWithSharedRange(from, to).map((group) =>
        group.from === from ? { ...group, reason } : group,
      );
      const accumulator = createLeagueForecastAccumulator(code, 2026, ids20, 1)!;
      expect(() => accumulator.addRun(points(), groups)).toThrow(RangeError);
      expect(accumulator.summarize()).toBeNull();
    }
  });

  it.each([
    { season: 2026, from: 1, to: 2 },
    { season: 2026, from: 4, to: 5 },
    { season: 2026, from: 5, to: 6 },
    { season: 2026, from: 17, to: 18 },
    { season: 2024, from: 5, to: 6 },
  ])(
    'rejects a shared range crossing a title or zone boundary: %j',
    ({ season, from, to }) => {
      const accumulator = createLeagueForecastAccumulator('PL', season, ids20, 1)!;
      expect(() =>
        accumulator.addRun(points(), rankingWithSharedRange(from, to)),
      ).toThrow(RangeError);
      expect(accumulator.status).toBe('failed');
    },
  );

  it('rejects inconsistent shared ranges and refuses them in other leagues', () => {
    const shared = rankingWithSharedRange(8, 9);
    expect(() =>
      createLeagueForecastAccumulator('PD', 2026, ids20, 1)!.addRun(
        points(),
        shared,
      ),
    ).toThrow(RangeError);
    const differentPoints = points().map((row) =>
      row.teamId === 8 ? { ...row, points: 1 } : row,
    );
    expect(() =>
      createLeagueForecastAccumulator('PL', 2026, ids20, 1)!.addRun(
        differentPoints,
        shared,
      ),
    ).toThrow(RangeError);

    const overlap = shared.map((group) =>
      group.from === 10 ? { ...group, from: 9, to: 9 } : group,
    );
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 2)!;
    accumulator.addRun(points(), shared);
    expect(() => accumulator.addRun(points(), overlap)).toThrow(RangeError);
    expect(accumulator.completedRuns).toBe(1);
    expect(accumulator.summarize()).toBeNull();
    expect(accumulator.status).toBe('failed');
  });

  it('refuses extra submissions without corrupting a complete forecast', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 1)!;
    accumulator.addRun(points(), ranking());
    const expected = accumulator.summarize()!;
    expect(() => accumulator.addRun([], [])).toThrow(/already complete/);
    expect(accumulator.status).toBe('complete');
    expect(accumulator.completedRuns).toBe(1);
    expect(accumulator.summarize()).toEqual(expected);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid target run count %s',
    (count) => {
      expect(() =>
        createLeagueForecastAccumulator('PL', 2026, ids20, count),
      ).toThrow(RangeError);
    },
  );

  it.each([
    { ids: ids20.slice(1) },
    { ids: [...ids20.slice(0, -1), 1] },
    { ids: [...ids20.slice(0, -1), 0] },
    { ids: [...ids20.slice(0, -1), 1.5] },
    { ids: [...ids20.slice(0, -1), Number.MAX_SAFE_INTEGER + 1] },
  ])('rejects invalid fixed rosters: %j', ({ ids }) => {
    expect(() => createLeagueForecastAccumulator('PL', 2026, ids, 1)).toThrow(
      RangeError,
    );
  });

  it('counts the Champions League phase zones at positions 8/9 and 24/25', () => {
    const clubIds = Array.from({ length: 36 }, (_, index) => index + 1);
    const accumulator = createLeagueForecastAccumulator('CL', 2026, clubIds, 1)!;
    accumulator.addRun(points(clubIds), ranking(clubIds));
    const { teams } = accumulator.summarize()!;
    expect(teams).toHaveLength(36);
    for (const [teamId, zone] of [
      [8, 0],
      [9, 1],
      [24, 1],
      [25, 2],
    ] as const) {
      const team = teams[teamId - 1]!;
      expect(team.zones.map(({ count }) => count)).toEqual(
        [0, 1, 2].map((index) => Number(index === zone)),
      );
    }
  });

  it('validates seasons and rejects unsupported forecast formats', () => {
    expect(() => createLeagueForecastAccumulator('PL', 2026.5, ids20, 1)).toThrow(
      RangeError,
    );
    expect(createLeagueForecastAccumulator('PL', 2027, ids20, 1)).toBeNull();
    expect(createLeagueForecastAccumulator('CL', 2023, ids20, 1)).toBeNull();
    expect(() => createLeagueForecastAccumulator('CL', 2026, ids20, 1)).toThrow(
      RangeError,
    );
    expect(
      createLeagueForecastAccumulator('ELC' as SiteCompetitionCode, 2026, ids20, 1),
    ).toBeNull();
  });

  it('is invariant to roster, run, row and ranking transport order and returns JSON-safe values', () => {
    const values = [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 3, 4];
    const first = createLeagueForecastAccumulator('PL', 2026, ids20, values.length)!;
    const second = createLeagueForecastAccumulator(
      'PL',
      2026,
      [...ids20].reverse(),
      values.length,
    )!;
    for (const value of values) first.addRun(points(ids20, value), ranking());
    for (const value of [...values].reverse()) {
      second.addRun(
        JSON.parse(JSON.stringify(points(ids20, value).reverse())),
        JSON.parse(JSON.stringify(ranking().reverse())),
      );
    }
    const summary = first.summarize()!;
    expect(second.summarize()).toEqual(summary);
    expect(summary.teams[0]!.expectedPoints).toBe(1.75);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('copies the roster and frozen run inputs and isolates every summary snapshot', () => {
    const original = [...ids20];
    const accumulator = createLeagueForecastAccumulator('PL', 2026, original, 1)!;
    original.fill(999);
    const rows = Object.freeze(points(ids20, 50).map((row) => Object.freeze(row)));
    const groups = Object.freeze(
      ranking().map((group) =>
        Object.freeze({ ...group, teamIds: Object.freeze([...group.teamIds]) }),
      ),
    );
    accumulator.addRun(rows, groups);
    const expected = accumulator.summarize()!;
    const summary = accumulator.summarize()!;
    summary.teams[0]!.expectedPoints = -999;
    summary.teams[0]!.pointsInterval80.lower = -999;
    summary.teams[0]!.positionDistribution[0]!.count = 999;
    summary.teams[0]!.zones[0]!.label = 'changed';
    summary.teams.pop();
    expect(accumulator.summarize()).toEqual(expected);
    expect(expected.teams.map((team) => team.teamId)).toEqual(ids20);
    expect(groups[0]!.teamIds).toEqual([1]);
  });

  it('conserves mass for 10000 deterministic complete league runs', () => {
    const accumulator = createLeagueForecastAccumulator('PL', 2026, ids20, 10000)!;
    const rows = Object.freeze(points().map((row) => Object.freeze(row)));
    for (let index = 0; index < 10000; index += 1) {
      const offset = index % ids20.length;
      accumulator.addRun(
        rows,
        ranking([...ids20.slice(offset), ...ids20.slice(0, offset)]),
      );
    }
    const summary = accumulator.summarize()!;
    expect(summary.runs).toBe(10000);
    for (const team of summary.teams) {
      expect(team.expectedPoints).toBe(0);
      expect(team.pointsInterval80).toEqual({ lower: 0, upper: 0 });
      expect(
        team.positionDistribution.every(
          (bin) => bin.count === 500 && bin.probability === 0.05,
        ),
      ).toBe(true);
      expect(
        team.positionDistribution.reduce((sum, bin) => sum + bin.count, 0),
      ).toBe(10000);
      expect(team.zones.map((zone) => zone.count)).toEqual([2000, 500, 1500]);
    }
    for (let position = 0; position < 20; position += 1) {
      expect(
        summary.teams.reduce(
          (sum, team) => sum + team.positionDistribution[position]!.count,
          0,
        ),
      ).toBe(10000);
    }
  });
});
