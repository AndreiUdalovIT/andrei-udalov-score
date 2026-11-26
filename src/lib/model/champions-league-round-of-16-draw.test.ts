import { describe, expect, it } from 'vitest';

import { createChampionsLeaguePlayOffDraw } from './champions-league-play-off-draw';
import {
  createChampionsLeaguePlayOffSimulation,
  type ChampionsLeaguePlayOffMatchInputs,
} from './champions-league-play-off-simulation';
import {
  CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
  createChampionsLeagueRoundOf16Draw,
  type OfficialChampionsLeagueRoundOf16Draw,
  type SimulatedChampionsLeagueRoundOf16Draw,
} from './champions-league-round-of-16-draw';
import { createSeededRandom } from './seeded-random';

const groups = Array.from({ length: 36 }, (_, index) => ({
  from: index + 1,
  to: index + 1,
  teamIds: [999 - index],
}));
const seed = [1, 2, 3, 4] as const;
const options = { tailTolerance: 1e-10, maxGoals: 30 };

function playOff(season = 2026, observed = true) {
  const builder = createChampionsLeaguePlayOffDraw(season, groups)!;
  const proposed = builder.sample(createSeededRandom(seed));
  const draw = observed
    ? builder.fromOfficial({
        sourceReference: 'test-published-play-offs',
        ties: proposed.ties.map((tie) => ({
          side: tie.side,
          seededTeamId: tie.seeded.teamId,
          unseededTeamId: tie.unseeded.teamId,
          firstLegHomeTeamId: tie.firstLegHomeTeamId,
        })),
      })
    : proposed;

  const inputs = draw.ties.map((tie): ChampionsLeaguePlayOffMatchInputs => {
    const hosts = [
      { homeTeamId: tie.unseeded.teamId, awayTeamId: tie.seeded.teamId, leg: 1 },
      { homeTeamId: tie.seeded.teamId, awayTeamId: tie.unseeded.teamId, leg: 2 },
    ] as const;
    return {
      seededTeamId: tie.seeded.teamId,
      unseededTeamId: tie.unseeded.teamId,
      legs: observed
        ? hosts.map((host) => ({
            ...host,
            kind: 'known-result',
            homeGoals90: host.leg === 1 ? 2 : 0,
            awayGoals90: 0,
          }))
        : hosts.map((host) => ({
            ...host,
            kind: 'forecast',
            homeRate90: 0,
            awayRate90: 0,
          })),
      extraTime: observed
        ? null
        : { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
      penalties: observed ? null : { kind: 'forecast', firstTeamWinProbability: 0 },
    };
  });
  const prepared = createChampionsLeaguePlayOffSimulation(draw, inputs, options);
  if (prepared.status !== 'ready')
    throw new Error('play-off example must be available');
  return prepared.sample(createSeededRandom(seed));
}

function officialInput(sampled: SimulatedChampionsLeagueRoundOf16Draw) {
  return {
    sourceReference: 'test-published-round-of-16',
    ties: sampled.ties.map((tie, index) => ({
      side: tie.side,
      seededTeamId: tie.seeded.teamId,
      winnerTeamId: tie.playOffWinner.club.teamId,
      firstLegHomeTeamId:
        index === 0
          ? tie.seeded.teamId
          : index === 1
            ? undefined
            : tie.firstLegHomeTeamId,
    })),
  } satisfies OfficialChampionsLeagueRoundOf16Draw;
}

describe('Champions League round-of-16 draw', () => {
  it.each([2024, 2025, 2026])(
    'preserves the slot of each play-off winner in season %s',
    (season) => {
      const round = createChampionsLeagueRoundOf16Draw(groups, playOff(season))!;
      const result = round.sample(createSeededRandom(seed));
      expect(result).toMatchObject({
        algorithm: CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
        season,
        source: 'simulated',
        randomDraws: 4,
        playOffDraw: {
          source: 'official',
          sourceReference: 'test-published-play-offs',
        },
      });
      // Clubs from places 17–24 win every tie in this test. The C-reference
      // seed gives four even draws, placing the higher-ranked seed on silver
      // because the team ID order is the reverse of the ranking order.
      expect(
        result.ties.map(({ side, seeded, playOffWinner }) => [
          side,
          seeded.position,
          playOffWinner.club.position,
          playOffWinner.slot.seededPairStart,
        ]),
      ).toEqual([
        ['silver', 1, 17, 15],
        ['blue', 2, 18, 15],
        ['silver', 3, 19, 13],
        ['blue', 4, 20, 13],
        ['silver', 5, 21, 11],
        ['blue', 6, 22, 11],
        ['silver', 7, 23, 9],
        ['blue', 8, 24, 9],
      ]);
      expect(
        result.ties.every(
          ({ side, playOffWinner, firstLegHomeTeamId }) =>
            playOffWinner.slot.side === side &&
            playOffWinner.source === 'observed' &&
            firstLegHomeTeamId === playOffWinner.club.teamId,
        ),
      ).toBe(true);
    },
  );

  it('enumerates all 16 combinations of the four fair bowls without moving any play-off winner', () => {
    const round = createChampionsLeagueRoundOf16Draw(groups, playOff())!;
    const assignments = new Set<string>();
    const silverCounts = new Map<number, number>();
    for (let mask = 0; mask < 16; mask += 1) {
      let draws = 0;
      const result = round.sample(() => ((mask >> draws++) & 1) / 2 ** 53);
      expect(draws).toBe(4);
      const silver = result.ties.filter((tie) => tie.side === 'silver');
      assignments.add(silver.map((tie) => tie.seeded.teamId).join(','));
      expect(silver.map((tie) => tie.playOffWinner.club.position)).toEqual([
        17, 19, 21, 23,
      ]);
      expect(
        result.ties.map((tie) => tie.seeded.position).sort((a, b) => a - b),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      for (const { seeded } of silver)
        silverCounts.set(
          seeded.position,
          (silverCounts.get(seeded.position) ?? 0) + 1,
        );
    }
    expect(assignments.size).toBe(16);
    expect(silverCounts.size).toBe(8);
    expect([...silverCounts.values()]).toEqual(Array(8).fill(8));
  });

  it('records published ties without guessing the home order or borrowing a winner from the other side', () => {
    const round = createChampionsLeagueRoundOf16Draw(groups, playOff())!;
    const input = officialInput(round.sample(createSeededRandom(seed)));
    const record = round.fromOfficial({ ...input, ties: [...input.ties].reverse() });
    expect(record).toMatchObject({
      source: 'official',
      sourceReference: 'test-published-round-of-16',
      playOffDraw: {
        source: 'official',
        sourceReference: 'test-published-play-offs',
      },
    });
    expect(record.ties[0]!.firstLegHomeTeamId).toBe(record.ties[0]!.seeded.teamId);
    expect(record.ties[1]!.firstLegHomeTeamId).toBeNull();
    expect(record).toEqual(round.fromOfficial(input));
    const first = input.ties[0]!;
    const withFirst = (patch: Partial<typeof first>) => ({
      ...input,
      ties: [{ ...first, ...patch }, ...input.ties.slice(1)],
    });
    for (const invalid of [
      { ...input, sourceReference: '  ' },
      { ...input, ties: input.ties.slice(1) },
      withFirst({ side: 'blue' }),
      withFirst({ winnerTeamId: input.ties[1]!.winnerTeamId }),
      withFirst({ seededTeamId: input.ties[1]!.seededTeamId }),
      withFirst({ firstLegHomeTeamId: 42 }),
    ])
      expect(() => round.fromOfficial(invalid)).toThrow(RangeError);
  });

  it('keeps simulated participants out of official draw records', () => {
    const simulated = createChampionsLeagueRoundOf16Draw(
      groups,
      playOff(2026, false),
    )!;
    const result = simulated.sample(createSeededRandom(seed));
    expect(
      result.ties.every(({ playOffWinner }) => playOffWinner.source === 'simulated'),
    ).toBe(true);
    expect(() => simulated.fromOfficial(officialInput(result))).toThrow(
      /observed play-off winners/,
    );

    const mixed = playOff();
    mixed.ties[0]!.result.legs[0]!.source = 'simulated';
    const withForecast = createChampionsLeagueRoundOf16Draw(groups, mixed)!;
    const pending = withForecast.sample(createSeededRandom(seed));
    expect(
      pending.ties.filter(
        ({ playOffWinner }) => playOffWinner.source === 'simulated',
      ),
    ).toHaveLength(1);
    expect(() => withForecast.fromOfficial(officialInput(pending))).toThrow(
      /observed play-off winners/,
    );
  });

  it('requires individual positions 1–24 but permits unresolved eliminated clubs', () => {
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
    const prior = playOff();
    expect(createChampionsLeagueRoundOf16Draw(combine(1, 2), prior)).toBeNull();
    expect(createChampionsLeagueRoundOf16Draw(combine(8, 9), prior)).toBeNull();
    expect(createChampionsLeagueRoundOf16Draw(combine(23, 24), prior)).toBeNull();
    expect(
      createChampionsLeagueRoundOf16Draw(combine(25, 36), prior),
    ).not.toBeNull();
  });

  it('rejects results from another ranking, duplicate slots and a winner outside the tie', () => {
    const prior = playOff();
    const alteredTable = [...groups];
    alteredTable[8] = { ...groups[8]!, teamIds: [...groups[9]!.teamIds] };
    alteredTable[9] = { ...groups[9]!, teamIds: [...groups[8]!.teamIds] };
    expect(() => createChampionsLeagueRoundOf16Draw(alteredTable, prior)).toThrow(
      /final table/,
    );
    expect(() =>
      createChampionsLeagueRoundOf16Draw(groups, {
        ...prior,
        ties: prior.ties.slice(1),
      }),
    ).toThrow(/complete/);
    expect(() =>
      createChampionsLeagueRoundOf16Draw(groups, {
        ...prior,
        ties: [prior.ties[1]!, ...prior.ties.slice(1)],
      }),
    ).toThrow(/slots/);
    prior.ties[0]!.result.winnerTeamId = 42;
    expect(() => createChampionsLeagueRoundOf16Draw(groups, prior)).toThrow(
      /belong to the tie/,
    );
  });

  it('can replay from a reordered snapshot and isolates draw results', () => {
    const prior = playOff();
    const a = createChampionsLeagueRoundOf16Draw(groups, prior)!;
    const b = createChampionsLeagueRoundOf16Draw([...groups].reverse(), {
      ...prior,
      ties: [...prior.ties].reverse(),
    })!;
    const expected = a.sample(createSeededRandom(seed));
    const changed = b.sample(createSeededRandom(seed));
    expect(changed).toEqual(expected);
    changed.ties[0]!.playOffWinner.club.position = 42;
    prior.ties[0]!.tie.unseeded.teamId = 42;
    expect(b.sample(createSeededRandom(seed))).toEqual(expected);
  });
});
