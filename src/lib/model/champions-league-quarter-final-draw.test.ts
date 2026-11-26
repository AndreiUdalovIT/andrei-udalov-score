import { describe, expect, it } from 'vitest';

import { CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM } from './champions-league-play-off-draw';
import {
  CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
  createChampionsLeagueQuarterFinalDraw,
  type OfficialChampionsLeagueQuarterFinalHomeOrder,
} from './champions-league-quarter-final-draw';
import {
  CHAMPIONS_LEAGUE_ROUND_OF_16_BANDS,
  CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
  type ChampionsLeagueRoundOf16Tie,
  type RecordedChampionsLeagueRoundOf16Draw,
  type SimulatedChampionsLeagueRoundOf16Draw,
} from './champions-league-round-of-16-draw';
import {
  createChampionsLeagueRoundOf16Simulation,
  type ChampionsLeagueRoundOf16MatchInputs,
} from './champions-league-round-of-16-simulation';
import { SEASON_LOTS_SAMPLING_ALGORITHM } from './season-lots-sampler';

const options = { maxGoals: 40, tailTolerance: 1e-10 };
const sides = ['silver', 'blue'] as const;
const nextNumerator = 2 ** -53;

function roundOf16(
  season: number,
  mode: 'played' | 'mixed' | 'scenario' = 'played',
) {
  const ties: ChampionsLeagueRoundOf16Tie[] =
    CHAMPIONS_LEAGUE_ROUND_OF_16_BANDS.flatMap(
      ({ seededPairStart, playOffSeededPairStart }) =>
        sides.map((side) => {
          const offset = side === 'blue' ? 1 : 0;
          const seededPosition = seededPairStart + offset;
          const winnerPosition = playOffSeededPairStart + offset;
          return {
            seededPairStart,
            side,
            seeded: { teamId: 100 + seededPosition, position: seededPosition },
            playOffWinner: {
              club: { teamId: 100 + winnerPosition, position: winnerPosition },
              slot: { seededPairStart: playOffSeededPairStart, side },
              source: 'observed',
            },
            firstLegHomeTeamId: 100 + winnerPosition,
          };
        }),
    );
  const common = {
    season,
    algorithm: CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
    playOffDraw: {
      season,
      algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
      source: 'official',
      sourceReference: 'test-published-play-off-draw',
    },
    ties,
  } as const;
  const draw:
    RecordedChampionsLeagueRoundOf16Draw | SimulatedChampionsLeagueRoundOf16Draw =
    mode === 'scenario'
      ? {
          ...common,
          source: 'simulated',
          lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
          randomDraws: 4,
        }
      : {
          ...common,
          source: 'official',
          sourceReference: 'test-published-round-of-16',
        };

  const inputs = ties.map((tie, index): ChampionsLeagueRoundOf16MatchInputs => {
    const firstTeamId = tie.seeded.teamId;
    const secondTeamId = tie.playOffWinner.club.teamId;
    const venues = [
      { leg: 1, homeTeamId: secondTeamId, awayTeamId: firstTeamId },
      { leg: 2, homeTeamId: firstTeamId, awayTeamId: secondTeamId },
    ] as const;
    const played = mode === 'played' || (mode === 'mixed' && index !== 0);
    return {
      firstTeamId,
      secondTeamId,
      legs: played
        ? venues.map((venue) => ({
            ...venue,
            kind: 'known-result',
            homeGoals90: venue.leg === 1 ? 2 : 0,
            awayGoals90: 0,
          }))
        : venues.map((venue) => ({
            ...venue,
            kind: 'forecast',
            homeRate90: 0,
            awayRate90: 0,
          })),
      extraTime: played ? null : { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
      penalties: played
        ? null
        : { kind: 'forecast', firstTeamWinProbability: mode === 'mixed' ? 1 : 0 },
    };
  });
  const prepared = createChampionsLeagueRoundOf16Simulation(draw, inputs, options);
  if (prepared.status !== 'ready') throw new Error('fixture round must be ready');
  return prepared.sample(() => 0.5);
}

function officialOrder(
  season: number,
): OfficialChampionsLeagueQuarterFinalHomeOrder {
  return {
    season,
    sourceReference: ' test-published-quarter-finals ',
    ties: [
      { side: 'blue', seededPairStart: 3, firstLegHomeFrom: 5 },
      { side: 'silver', seededPairStart: 3, firstLegHomeFrom: null },
      { side: 'blue', seededPairStart: 1, firstLegHomeFrom: 7 },
      { side: 'silver', seededPairStart: 1, firstLegHomeFrom: 1 },
    ],
  };
}

function noRandom(): never {
  throw new Error('inherited home order must not consume RNG');
}

describe('Champions League quarter-final draw', () => {
  it.each([2025, 2026])(
    'inherits the seeded branch in season %s even when its seed lost',
    (season) => {
      const result = createChampionsLeagueQuarterFinalDraw(roundOf16(season)).sample(
        noRandom,
      );
      expect(result).toMatchObject({
        algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
        season,
        source: 'simulated',
        homeOrder: { source: 'inherited-seeding' },
        roundOf16Draw: {
          source: 'official',
          sourceReference: 'test-published-round-of-16',
        },
      });
      expect(
        result.ties.map(
          ({ side, seededPairStart, first, second, firstLegHomeTeamId }) => [
            side,
            seededPairStart,
            first.slot.seededPairStart,
            second.slot.seededPairStart,
            first.club.position,
            second.club.position,
            firstLegHomeTeamId,
          ],
        ),
      ).toEqual([
        ['silver', 1, 1, 7, 15, 9, 109],
        ['silver', 3, 3, 5, 13, 11, 111],
        ['blue', 1, 1, 7, 16, 10, 110],
        ['blue', 3, 3, 5, 14, 12, 112],
      ]);
      expect(
        result.ties.every(
          ({ side, first, second }) =>
            first.slot.side === side &&
            second.slot.side === side &&
            first.source === 'observed' &&
            second.source === 'observed',
        ),
      ).toBe(true);
    },
  );

  it('models all 16 home-order combinations for 2024/25 with four draws', () => {
    const builder = createChampionsLeagueQuarterFinalDraw(roundOf16(2024));
    for (let mask = 0; mask < 16; mask += 1) {
      let calls = 0;
      const result = builder.sample(() => ((mask >> calls++) & 1) * nextNumerator);
      expect(calls).toBe(4);
      expect(result.homeOrder).toEqual({
        source: 'simulated-lots',
        lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
        randomDraws: 4,
      });
      expect(
        result.ties.map(({ first, second, firstLegHomeTeamId }, index) => [
          first.slot.seededPairStart,
          second.slot.seededPairStart,
          firstLegHomeTeamId === first.club.teamId ? 1 : 0,
          [first.club.teamId, second.club.teamId].includes(firstLegHomeTeamId!),
          index,
        ]),
      ).toEqual([
        [1, 7, mask & 1, true, 0],
        [3, 5, (mask >> 1) & 1, true, 1],
        [1, 7, (mask >> 2) & 1, true, 2],
        [3, 5, (mask >> 3) & 1, true, 3],
      ]);
    }
  });

  it('retains published hosts, including a reversed pairing and an unknown host', () => {
    const record = createChampionsLeagueQuarterFinalDraw(
      roundOf16(2025),
    ).withOfficialHomeOrder(officialOrder(2025));
    expect(record).toMatchObject({
      source: 'official',
      homeOrder: {
        source: 'official',
        sourceReference: 'test-published-quarter-finals',
      },
    });
    expect(record.ties.map(({ firstLegHomeTeamId }) => firstLegHomeTeamId)).toEqual([
      115,
      null,
      110,
      112,
    ]);
  });

  it('applies a published home-order draw to an unplayed feeder without claiming its winner is official', () => {
    const record = createChampionsLeagueQuarterFinalDraw(
      roundOf16(2024, 'mixed'),
    ).withOfficialHomeOrder(officialOrder(2024));
    expect(record).toMatchObject({
      source: 'simulated',
      homeOrder: {
        source: 'official',
        sourceReference: 'test-published-quarter-finals',
      },
    });
    expect(record.ties[0]).toMatchObject({
      first: { club: { teamId: 101 }, source: 'simulated' },
      second: { club: { teamId: 109 }, source: 'observed' },
      firstLegHomeTeamId: 101,
    });
  });

  it('keeps bracket order stable when transported out of order and snapshots winners', () => {
    const sample = roundOf16(2024, 'scenario');
    const builder = createChampionsLeagueQuarterFinalDraw(sample);
    const reordered = createChampionsLeagueQuarterFinalDraw({
      ...sample,
      ties: [...sample.ties].reverse(),
    });
    const reference = builder.sample(() => 0);
    expect(reordered.sample(() => 0)).toEqual(reference);
    const edited = builder.sample(() => 0);
    edited.ties[0]!.first.club.position = 100;
    sample.ties[0]!.tie.playOffWinner.club.position = 100;
    expect(builder.sample(() => 0)).toEqual(reference);
    expect(
      reference.ties.every(
        ({ first, second }) =>
          first.source === 'simulated' && second.source === 'simulated',
      ),
    ).toBe(true);
  });

  it('rejects duplicate slots and results for clubs outside the pairing', () => {
    const sample = roundOf16(2025);
    const [first, , ...rest] = sample.ties;
    expect(() =>
      createChampionsLeagueQuarterFinalDraw({
        ...sample,
        ties: [first!, first!, ...rest],
      }),
    ).toThrow(/one tie per side/);
    const edited = structuredClone(sample);
    edited.ties[0]!.result.winnerTeamId = 99;
    expect(() => createChampionsLeagueQuarterFinalDraw(edited)).toThrow(
      /winner and loser/,
    );
  });

  it('rejects a published order from the wrong season or outside the bracket path', () => {
    const builder = createChampionsLeagueQuarterFinalDraw(roundOf16(2024));
    const record = officialOrder(2024);
    expect(() => builder.withOfficialHomeOrder({ ...record, season: 2025 })).toThrow(
      /this season/,
    );
    expect(() =>
      builder.withOfficialHomeOrder({
        ...record,
        ties: [{ ...record.ties[0]!, firstLegHomeFrom: 7 }, ...record.ties.slice(1)],
      }),
    ).toThrow(/feeder for the pair/);
    expect(() =>
      builder.withOfficialHomeOrder({
        ...record,
        ties: [record.ties[0]!, record.ties[0]!, ...record.ties.slice(2)],
      }),
    ).toThrow(/each quarter-final slot once/);
    expect(() =>
      createChampionsLeagueQuarterFinalDraw(
        roundOf16(2024, 'scenario'),
      ).withOfficialHomeOrder(record),
    ).toThrow(/official bracket pairs/);
  });
});
