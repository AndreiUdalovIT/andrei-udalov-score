import { describe, expect, it } from 'vitest';

import { CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM } from './champions-league-play-off-draw';
import {
  CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
  type ChampionsLeagueQuarterFinalTie,
  type RecordedChampionsLeagueQuarterFinalDraw,
  type SimulatedChampionsLeagueQuarterFinalDraw,
} from './champions-league-quarter-final-draw';
import {
  createChampionsLeagueQuarterFinalSimulation,
  type ChampionsLeagueQuarterFinalMatchInputs,
} from './champions-league-quarter-final-simulation';
import { CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM } from './champions-league-round-of-16-draw';
import {
  CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
  createChampionsLeagueSemiFinalDraw,
  type OfficialChampionsLeagueSemiFinalHomeOrder,
} from './champions-league-semi-final-draw';
import { SEASON_LOTS_SAMPLING_ALGORITHM } from './season-lots-sampler';

const options = { maxGoals: 40, tailTolerance: 1e-10 };
const nextNumerator = 2 ** -53;

function quarterFinals(
  season: number,
  mode: 'played' | 'mixed' | 'scenario' = 'played',
) {
  const fixtures = [
    ['silver', 1, 7, 15, 9],
    ['silver', 3, 5, 13, 5],
    ['blue', 1, 7, 16, 10],
    ['blue', 3, 5, 14, 6],
  ] as const;
  const entrantSource = mode === 'scenario' ? 'simulated' : 'observed';
  const ties: ChampionsLeagueQuarterFinalTie[] = fixtures.map(
    ([side, seededPairStart, opponentBand, firstPosition, secondPosition]) => ({
      side,
      seededPairStart,
      first: {
        club: { teamId: firstPosition + 100, position: firstPosition },
        slot: { side, seededPairStart },
        source: entrantSource,
      },
      second: {
        club: { teamId: secondPosition + 100, position: secondPosition },
        slot: { side, seededPairStart: opponentBand },
        source: entrantSource,
      },
      firstLegHomeTeamId: secondPosition + 100,
    }),
  );
  const roundOf16 = {
    algorithm: CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
    season,
    playOffDraw: {
      algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
      season,
      source: 'official',
      sourceReference: 'test-play-offs',
    },
  } as const;
  const common = {
    algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
    season,
    ties,
  } as const;
  const draw:
    | RecordedChampionsLeagueQuarterFinalDraw
    | SimulatedChampionsLeagueQuarterFinalDraw =
    mode === 'scenario'
      ? {
          ...common,
          source: 'simulated',
          homeOrder: { source: 'inherited-seeding' },
          roundOf16Draw: {
            ...roundOf16,
            source: 'simulated',
            lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
            randomDraws: 4,
          },
        }
      : {
          ...common,
          source: 'official',
          homeOrder: { source: 'official', sourceReference: 'test-quarter-finals' },
          roundOf16Draw: {
            ...roundOf16,
            source: 'official',
            sourceReference: 'test-round-of-16',
          },
        };

  const matches = ties.map((tie, index): ChampionsLeagueQuarterFinalMatchInputs => {
    const firstTeamId = tie.first.club.teamId;
    const secondTeamId = tie.second.club.teamId;
    const venues = [
      { leg: 1, homeTeamId: secondTeamId, awayTeamId: firstTeamId },
      { leg: 2, homeTeamId: firstTeamId, awayTeamId: secondTeamId },
    ] as const;
    const played = mode === 'played' || (mode === 'mixed' && index > 0);
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
      penalties: played ? null : { kind: 'forecast', firstTeamWinProbability: 1 },
    };
  });
  const prepared = createChampionsLeagueQuarterFinalSimulation(
    draw,
    matches,
    options,
  );
  if (prepared.status !== 'ready')
    throw new Error('test quarter-finals must be ready');
  return prepared.sample(() => 0.5);
}

function publishedOrder(season: number): OfficialChampionsLeagueSemiFinalHomeOrder {
  return {
    season,
    sourceReference: ' test-semi-finals ',
    ties: [
      { side: 'blue', firstLegHomeFrom: null },
      { side: 'silver', firstLegHomeFrom: 1 },
    ],
  };
}

function noRandom(): never {
  throw new Error('this home order requires no random draws');
}

describe('Champions League semi-final draw', () => {
  it.each([2025, 2026])(
    'preserves the 1/2 return-leg path after an upset in season %s',
    (season) => {
      const result = createChampionsLeagueSemiFinalDraw(
        quarterFinals(season),
      ).sample(noRandom);
      expect(result).toMatchObject({
        algorithm: CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
        season,
        source: 'simulated',
        homeOrder: { source: 'inherited-seeding' },
        quarterFinalDraw: {
          source: 'official',
          homeOrder: { sourceReference: 'test-quarter-finals' },
        },
      });
      expect(result.ties).toEqual([
        {
          side: 'silver',
          first: {
            club: { teamId: 109, position: 9 },
            slot: { side: 'silver', seededPairStart: 1 },
            source: 'observed',
          },
          second: {
            club: { teamId: 105, position: 5 },
            slot: { side: 'silver', seededPairStart: 3 },
            source: 'observed',
          },
          firstLegHomeTeamId: 105,
        },
        {
          side: 'blue',
          first: {
            club: { teamId: 110, position: 10 },
            slot: { side: 'blue', seededPairStart: 1 },
            source: 'observed',
          },
          second: {
            club: { teamId: 106, position: 6 },
            slot: { side: 'blue', seededPairStart: 3 },
            source: 'observed',
          },
          firstLegHomeTeamId: 106,
        },
      ]);
    },
  );

  it('models the four home-order possibilities for 2024/25 with two draws', () => {
    const builder = createChampionsLeagueSemiFinalDraw(quarterFinals(2024));
    for (let mask = 0; mask < 4; mask += 1) {
      let calls = 0;
      const result = builder.sample(() => ((mask >> calls++) & 1) * nextNumerator);
      expect(calls).toBe(2);
      expect(result.homeOrder).toEqual({
        source: 'simulated-lots',
        lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
        randomDraws: 2,
      });
      expect(
        result.ties.map(({ side, firstLegHomeTeamId }) => [
          side,
          firstLegHomeTeamId,
        ]),
      ).toEqual([
        ['silver', (mask & 1) === 1 ? 109 : 105],
        ['blue', (mask & 2) === 2 ? 110 : 106],
      ]);
    }
  });

  it('retains an official home-order reversal and an unknown venue', () => {
    const result = createChampionsLeagueSemiFinalDraw(
      quarterFinals(2025),
    ).withOfficialHomeOrder(publishedOrder(2025));
    expect(result).toMatchObject({
      source: 'official',
      homeOrder: { source: 'official', sourceReference: 'test-semi-finals' },
    });
    expect(result.ties.map(({ firstLegHomeTeamId }) => firstLegHomeTeamId)).toEqual([
      109,
      null,
    ]);
  });

  it('applies the published branch order to a simulated quarter-final winner', () => {
    const result = createChampionsLeagueSemiFinalDraw(
      quarterFinals(2024, 'mixed'),
    ).withOfficialHomeOrder(publishedOrder(2024));
    expect(result).toMatchObject({
      source: 'simulated',
      homeOrder: { source: 'official' },
    });
    expect(result.ties[0]).toMatchObject({
      first: { club: { teamId: 115 }, source: 'simulated' },
      second: { club: { teamId: 105 }, source: 'observed' },
      firstLegHomeTeamId: 115,
    });
  });

  it('stabilizes out-of-order samples and keeps independent result snapshots', () => {
    const sample = quarterFinals(2026, 'scenario');
    const original = createChampionsLeagueSemiFinalDraw(sample);
    const reordered = createChampionsLeagueSemiFinalDraw({
      ...sample,
      ties: [...sample.ties].reverse(),
    });
    const expected = original.sample(noRandom);
    expect(
      expected.ties.every(
        ({ first, second }) =>
          first.source === 'simulated' && second.source === 'simulated',
      ),
    ).toBe(true);
    expect(reordered.sample(noRandom)).toEqual(expected);
    const changed = original.sample(noRandom);
    changed.quarterFinalDraw.roundOf16Draw.season = 1900;
    changed.ties[0]!.first.club.teamId = 101;
    sample.ties[0]!.tie.first.club.teamId = 102;
    expect(original.sample(noRandom)).toEqual(expected);
  });

  it('rejects duplicate feeders, incomplete results and an outsider winning a tie', () => {
    const sample = quarterFinals(2025);
    const [first, , ...rest] = sample.ties;
    expect(() =>
      createChampionsLeagueSemiFinalDraw({
        ...sample,
        ties: [first!, first!, ...rest],
      }),
    ).toThrow(/one tie per side/);
    const invalid = structuredClone(sample);
    const result = invalid.ties[0]!.result;
    const leg = result.legs.pop()!;
    expect(() => createChampionsLeagueSemiFinalDraw(invalid)).toThrow(
      /supported two-leg result/,
    );
    result.legs.push(leg);
    result.winnerTeamId = 9999;
    expect(() => createChampionsLeagueSemiFinalDraw(invalid)).toThrow(
      /winner and loser/,
    );
  });

  it('requires both published bracket sides from the correct season', () => {
    const builder = createChampionsLeagueSemiFinalDraw(quarterFinals(2026));
    const order = publishedOrder(2026);
    expect(() => builder.withOfficialHomeOrder({ ...order, season: 2025 })).toThrow(
      /this season/,
    );
    expect(() =>
      builder.withOfficialHomeOrder({
        ...order,
        ties: [order.ties[0]!, order.ties[0]!],
      }),
    ).toThrow(/each semi-final side once/);
    expect(() =>
      createChampionsLeagueSemiFinalDraw(
        quarterFinals(2026, 'scenario'),
      ).withOfficialHomeOrder(order),
    ).toThrow(/published bracket/);
  });
});
