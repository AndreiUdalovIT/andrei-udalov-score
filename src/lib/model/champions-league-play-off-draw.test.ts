import { describe, expect, it } from 'vitest';

import { rankChampionsLeaguePhase } from './champions-league-phase-ranking';
import {
  CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
  createChampionsLeaguePlayOffDraw,
  type OfficialChampionsLeaguePlayOffDraw,
} from './champions-league-play-off-draw';
import { createSeededRandom } from './seeded-random';
import { projectSeasonStats } from './season-stats';

const groups = Array.from({ length: 36 }, (_, index) => ({
  from: index + 1,
  to: index + 1,
  // Team ID order intentionally differs from position order.
  teamIds: [999 - index],
}));

function combine(from: number, to: number) {
  return [
    ...groups.slice(0, from - 1),
    {
      from,
      to,
      teamIds: groups.slice(from - 1, to).flatMap((group) => group.teamIds),
    },
    ...groups.slice(to),
  ];
}

function officialFixture() {
  return {
    sourceReference: 'test-published-bracket',
    ties: [
      {
        side: 'silver',
        seededTeamId: 990,
        unseededTeamId: 977,
        firstLegHomeTeamId: 990,
      },
      {
        side: 'blue',
        seededTeamId: 991,
        unseededTeamId: 976,
        firstLegHomeTeamId: 976,
      },
      { side: 'silver', seededTeamId: 989, unseededTeamId: 978 },
      { side: 'blue', seededTeamId: 988, unseededTeamId: 979 },
      { side: 'silver', seededTeamId: 987, unseededTeamId: 981 },
      { side: 'blue', seededTeamId: 986, unseededTeamId: 980 },
      { side: 'silver', seededTeamId: 984, unseededTeamId: 982 },
      { side: 'blue', seededTeamId: 985, unseededTeamId: 983 },
    ],
  } satisfies OfficialChampionsLeaguePlayOffDraw;
}

describe('Champions League knockout phase play-off draw', () => {
  it.each([2024, 2025, 2026])(
    'prepares the four opponent bands for season %s',
    (season) => {
      const draw = createChampionsLeaguePlayOffDraw(season, groups)!;
      expect(
        draw.candidateBands.map(({ seeded, unseeded }) => [
          seeded.map(({ position }) => position),
          unseeded.map(({ position }) => position),
        ]),
      ).toEqual([
        [
          [9, 10],
          [23, 24],
        ],
        [
          [11, 12],
          [21, 22],
        ],
        [
          [13, 14],
          [19, 20],
        ],
        [
          [15, 16],
          [17, 18],
        ],
      ]);
    },
  );

  it('reconstructs all eight ties and sides from reference draws in UEFA bowl order', () => {
    const draw = createChampionsLeaguePlayOffDraw(2026, groups)!;
    const result = draw.sample(createSeededRandom([1, 2, 3, 4]));
    expect(result).toMatchObject({
      algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
      source: 'simulated',
      season: 2026,
      randomDraws: 8,
      lotSamplingAlgorithm: 'position-ordered-fisher-yates-u53-rejection128-v1',
    });
    // Parity of the first eight reference u53 numerators, evaluated independently.
    expect(
      result.ties.map(({ side, seeded, unseeded }) => [
        side,
        seeded.position,
        unseeded.position,
      ]),
    ).toEqual([
      ['silver', 10, 23],
      ['blue', 9, 24],
      ['silver', 11, 21],
      ['blue', 12, 22],
      ['silver', 13, 19],
      ['blue', 14, 20],
      ['silver', 16, 17],
      ['blue', 15, 18],
    ]);
    expect(
      result.ties.every((tie) => tie.firstLegHomeTeamId === tie.unseeded.teamId),
    ).toBe(true);
    const repeated = createChampionsLeaguePlayOffDraw(2026, [...groups].reverse())!;
    expect(repeated.sample(createSeededRandom([1, 2, 3, 4]))).toEqual(result);
  });

  it('enumerates every fair-bowl scenario with complementary sides and equal pair frequencies', () => {
    const draw = createChampionsLeaguePlayOffDraw(2026, groups)!;
    const outcomes = new Set<string>();
    const counts = new Map<string, number>();
    for (let mask = 0; mask < 256; mask += 1) {
      let calls = 0;
      const result = draw.sample(() => ((mask >> calls++) & 1) / 2 ** 53);
      expect(calls).toBe(8);
      expect(
        new Set(
          result.ties.flatMap(({ seeded, unseeded }) => [
            seeded.position,
            unseeded.position,
          ]),
        ).size,
      ).toBe(16);
      outcomes.add(JSON.stringify(result.ties));
      for (const { side, seeded, unseeded } of result.ties) {
        const allowedStart = 23 - 2 * Math.floor((seeded.position - 9) / 2);
        expect([allowedStart, allowedStart + 1]).toContain(unseeded.position);
        const key = side + ':' + seeded.position + ':' + unseeded.position;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect(outcomes.size).toBe(256);
    expect(counts.size).toBe(32);
    expect([...counts.values()]).toEqual(Array(32).fill(64));
  });

  it('records an official source with both sides and the stated match order', () => {
    const draw = createChampionsLeaguePlayOffDraw(2025, groups)!;
    const input = officialFixture();
    const first = draw.fromOfficial(input);
    expect(first).toMatchObject({
      source: 'official',
      sourceReference: 'test-published-bracket',
      season: 2025,
    });
    expect(first.ties.slice(0, 3)).toEqual([
      {
        seededPairStart: 9,
        side: 'silver',
        seeded: { teamId: 990, position: 10 },
        unseeded: { teamId: 977, position: 23 },
        firstLegHomeTeamId: 990,
      },
      {
        seededPairStart: 9,
        side: 'blue',
        seeded: { teamId: 991, position: 9 },
        unseeded: { teamId: 976, position: 24 },
        firstLegHomeTeamId: 976,
      },
      {
        seededPairStart: 11,
        side: 'silver',
        seeded: { teamId: 989, position: 11 },
        unseeded: { teamId: 978, position: 22 },
        firstLegHomeTeamId: null,
      },
    ]);
    expect(draw.fromOfficial({ ...input, ties: [...input.ties].reverse() })).toEqual(
      first,
    );
    first.ties[0]!.unseeded.teamId = 123;
    expect(draw.fromOfficial(input).ties[0]!.unseeded.teamId).toBe(977);
  });

  it('rejects official data that is incomplete or inconsistent with its ranking and sides', () => {
    const draw = createChampionsLeaguePlayOffDraw(2026, groups)!;
    const input = officialFixture();
    const withFirst = (
      first: OfficialChampionsLeaguePlayOffDraw['ties'][number],
    ) => ({
      ...input,
      ties: [first, ...input.ties.slice(1)],
    });
    const first = input.ties[0]!;
    const invalid = [
      { ...input, sourceReference: '  ' },
      { ...input, ties: input.ties.slice(1) },
      withFirst({ ...first, side: 'blue' }),
      withFirst({ ...first, unseededTeamId: 978 }),
      withFirst({ ...first, unseededTeamId: 976 }),
      withFirst({ ...first, firstLegHomeTeamId: 999 }),
      withFirst({ ...first, seededTeamId: 999 }),
    ];
    for (const record of invalid)
      expect(() => draw.fromOfficial(record)).toThrow(RangeError);
  });

  it('allows unresolved ranges wholly outside the play-off places', () => {
    const first = combine(1, 8);
    const valid = [...first.slice(0, 17), ...combine(25, 36).slice(-1)];
    const draw = createChampionsLeaguePlayOffDraw(2026, valid)!;
    expect(draw.sample(createSeededRandom([1, 2, 3, 4])).ties).toHaveLength(8);
  });

  it.each([
    [8, 9],
    [12, 13],
    [24, 25],
  ] as const)(
    'leaves the draw unavailable when places %s–%s are unresolved',
    (from, to) => {
      expect(createChampionsLeaguePlayOffDraw(2026, combine(from, to))).toBeNull();
    },
  );

  it('rejects malformed position ranges and unsupported seasons', () => {
    expect(createChampionsLeaguePlayOffDraw(2023, groups)).toBeNull();
    expect(createChampionsLeaguePlayOffDraw(2027, groups)).toBeNull();
    expect(() => createChampionsLeaguePlayOffDraw(2026.1, groups)).toThrow(
      RangeError,
    );
    for (const incorrect of [
      groups.slice(0, -1),
      [...groups.slice(0, -1), { ...groups[0]!, teamIds: [964] }],
      [...groups.slice(0, -1), { ...groups[35]!, teamIds: [999] }],
      [...groups.slice(0, -1), { ...groups[35]!, teamIds: [0] }],
      [...groups.slice(0, -1), { ...groups[35]!, from: 35 }],
    ])
      expect(() => createChampionsLeaguePlayOffDraw(2026, incorrect)).toThrow(
        RangeError,
      );
  });

  it('copies the ranking and returns independent snapshots', () => {
    const input = groups.map((group) => ({ ...group, teamIds: [...group.teamIds] }));
    const draw = createChampionsLeaguePlayOffDraw(2026, input)!;
    const expected = draw.sample(createSeededRandom([1, 2, 3, 4]));
    input[8]!.teamIds[0] = 123;
    const candidates = draw.candidateBands;
    candidates[0]!.seeded[0].teamId = 42;
    draw.sample(createSeededRandom([1, 2, 3, 4])).ties[0]!.seeded.teamId = 42;
    expect(draw.candidateBands[0]!.seeded[0].teamId).toBe(991);
    expect(draw.sample(createSeededRandom([1, 2, 3, 4]))).toEqual(expected);
    expect(() => draw.sample(() => 1)).toThrow(RangeError);
  });

  it('accepts the output of the real league phase ranker directly', () => {
    const ids = groups.map(({ teamIds }) => teamIds[0]!);
    const matches = ids.flatMap((homeTeamId, index) =>
      [1, 2, 3, 4].map((offset) => ({
        id: index * 4 + offset,
        homeTeamId,
        awayTeamId: ids[(index + offset) % ids.length]!,
        homeGoals90: 0,
        awayGoals90: 0,
      })),
    );
    const empty = ids.map((teamId) => ({
      teamId,
      playedGames: 0,
      won: 0,
      draw: 0,
      lost: 0,
      points: 0,
      goalsFor: 0,
      goalsAgainst: 0,
    }));
    const finalRows = projectSeasonStats(
      empty,
      matches.map((match) => ({ ...match, source: 'simulated' })),
    )!;
    const context = ids.map((teamId) => ({
      teamId,
      disciplinaryPoints: 0,
      clubCoefficient: teamId,
    }));
    const ranking = rankChampionsLeaguePhase(finalRows, matches, 2026, context)!;
    const draw = createChampionsLeaguePlayOffDraw(ranking.season, ranking.groups)!;
    expect(draw.candidateBands[0]).toMatchObject({
      seeded: [
        { teamId: 991, position: 9 },
        { teamId: 990, position: 10 },
      ],
      unseeded: [
        { teamId: 977, position: 23 },
        { teamId: 976, position: 24 },
      ],
    });
  });
});
