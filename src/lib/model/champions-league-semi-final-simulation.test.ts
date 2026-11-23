import { describe, expect, it } from 'vitest';

import { CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM } from './champions-league-play-off-draw';
import { CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM } from './champions-league-quarter-final-draw';
import { CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM } from './champions-league-round-of-16-draw';
import {
  CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
  type ChampionsLeagueSemiFinalTie,
  type RecordedChampionsLeagueSemiFinalDraw,
  type SimulatedChampionsLeagueSemiFinalDraw,
} from './champions-league-semi-final-draw';
import {
  CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM,
  createChampionsLeagueSemiFinalSimulation,
  type ChampionsLeagueSemiFinalMatchInputs,
  type ChampionsLeagueSemiFinalPreparation,
} from './champions-league-semi-final-simulation';
import { createSeededRandom } from './seeded-random';
import { SEASON_LOTS_SAMPLING_ALGORITHM } from './season-lots-sampler';

const options = { maxGoals: 40, tailTolerance: 1e-10 };
const seed = [1, 2, 3, 4] as const;

function officialDraw(season = 2025): RecordedChampionsLeagueSemiFinalDraw {
  const fixtures = [
    ['silver', 9, 5, 109],
    ['blue', 10, 6, null],
  ] as const;
  const ties: ChampionsLeagueSemiFinalTie[] = fixtures.map(
    ([side, firstPosition, secondPosition, firstLegHomeTeamId]) => ({
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
      firstLegHomeTeamId,
    }),
  );
  return {
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
    ties,
  };
}

function scenarioDraw(season: number): SimulatedChampionsLeagueSemiFinalDraw {
  const draw = officialDraw(season);
  return {
    ...draw,
    source: 'simulated',
    homeOrder:
      season === 2024
        ? {
            source: 'simulated-lots',
            lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
            randomDraws: 2,
          }
        : { source: 'inherited-seeding' },
    ties: draw.ties.map((tie) => ({
      ...tie,
      firstLegHomeTeamId: tie.second.club.teamId,
    })),
  };
}

function completed(
  tie: ChampionsLeagueSemiFinalTie,
): ChampionsLeagueSemiFinalMatchInputs {
  const firstTeamId = tie.first.club.teamId;
  const secondTeamId = tie.second.club.teamId;
  const home = tie.firstLegHomeTeamId ?? secondTeamId;
  const away = home === firstTeamId ? secondTeamId : firstTeamId;
  return {
    firstTeamId,
    secondTeamId,
    legs: [
      {
        kind: 'known-result',
        leg: 1,
        homeTeamId: home,
        awayTeamId: away,
        homeGoals90: 1,
        awayGoals90: 0,
      },
      {
        kind: 'known-result',
        leg: 2,
        homeTeamId: away,
        awayTeamId: home,
        homeGoals90: 2,
        awayGoals90: 1,
      },
    ],
    extraTime: { kind: 'known-result', homeGoals30: 1, awayGoals30: 0 },
    penalties: null,
  };
}

function forecast(
  tie: ChampionsLeagueSemiFinalTie,
): ChampionsLeagueSemiFinalMatchInputs {
  const match = completed(tie);
  return {
    ...match,
    legs: match.legs.map(({ leg, homeTeamId, awayTeamId }) => ({
      kind: 'forecast',
      leg,
      homeTeamId,
      awayTeamId,
      homeRate90: 0,
      awayRate90: 0,
    })),
    extraTime: { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
    penalties: { kind: 'forecast', firstTeamWinProbability: 0.5 },
  };
}

function ready(prepared: ChampionsLeagueSemiFinalPreparation) {
  if (prepared.status !== 'ready') throw new Error('test semi-finals must be ready');
  return prepared;
}

describe('Champions League semi-final simulation', () => {
  it('advances the observed extra-time and shootout winners on their own sides', () => {
    const draw = officialDraw();
    const [silver, blue] = draw.ties.map(completed);
    const inputs = [
      silver!,
      {
        ...blue!,
        extraTime: { kind: 'known-result', homeGoals30: 0, awayGoals30: 0 },
        penalties: { kind: 'known-result', winnerTeamId: 106 },
      },
    ] satisfies ChampionsLeagueSemiFinalMatchInputs[];
    const prepared = ready(
      createChampionsLeagueSemiFinalSimulation(draw, inputs, options),
    );
    expect(prepared.tailUpperBound).toBe(0);
    const result = prepared.sample(() => {
      throw new Error('completed ties must not consume RNG');
    });
    expect(result).toMatchObject({
      algorithm: CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM,
      draw: {
        source: 'official',
        homeOrder: { sourceReference: 'test-semi-finals' },
      },
    });
    expect(result.ties.map(({ tie }) => tie)).toEqual(draw.ties);
    expect(result.ties[0]!.result).toMatchObject({
      winnerTeamId: 105,
      method: 'extra-time-goals',
      aggregateGoals90: { first: 2, second: 2 },
      extraTime: { homeTeamId: 105, source: 'known-result' },
    });
    expect(result.ties[1]!.result).toMatchObject({
      winnerTeamId: 106,
      method: 'penalties',
      shootout: { winnerTeamId: 106, source: 'known-result' },
    });
  });

  it('retains a played first leg and simulates the return at its recorded venue', () => {
    const draw = officialDraw();
    const silver = draw.ties[0]!;
    const future = forecast(silver);
    const [first] = completed(silver).legs;
    const inputs = [
      {
        ...future,
        legs: [
          { ...first!, kind: 'known-result', homeGoals90: 0, awayGoals90: 0 },
          future.legs[1]!,
        ],
      },
      completed(draw.ties[1]!),
    ] satisfies ChampionsLeagueSemiFinalMatchInputs[];
    const prepared = ready(
      createChampionsLeagueSemiFinalSimulation(draw, inputs, options),
    );
    let randomCalls = 0;
    const result = prepared.sample(() => {
      randomCalls += 1;
      return 0.25;
    }).ties[0]!.result;
    expect(randomCalls).toBe(5);
    expect(result).toMatchObject({
      winnerTeamId: 109,
      legs: [
        { homeTeamId: 109, source: 'known-result' },
        { homeTeamId: 105, source: 'simulated' },
      ],
      extraTime: { homeTeamId: 105, source: 'simulated' },
      shootout: { winnerTeamId: 109, source: 'simulated' },
    });
  });

  it.each([2024, 2025, 2026])(
    'replays the sides in order for season %s',
    (season) => {
      const draw = scenarioDraw(season);
      const inputs = draw.ties.map(forecast);
      const prepared = ready(
        createChampionsLeagueSemiFinalSimulation(draw, inputs, options),
      );
      const reordered = ready(
        createChampionsLeagueSemiFinalSimulation(
          { ...draw, ties: [...draw.ties].reverse() },
          [...inputs].reverse(),
          options,
        ),
      );
      const reference = prepared.sample(createSeededRandom(seed));
      expect(reference.ties.map(({ tie }) => tie.side)).toEqual(['silver', 'blue']);
      expect(reference.draw.homeOrder).toEqual(draw.homeOrder);
      expect(reordered.sample(createSeededRandom(seed))).toEqual(reference);
      const changed = prepared.sample(createSeededRandom(seed));
      changed.draw.quarterFinalDraw.season = 1900;
      changed.ties[0]!.tie.first.club.position = 100;
      draw.ties[0]!.first.club.teamId = 900;
      expect(prepared.sample(createSeededRandom(seed))).toEqual(reference);
    },
  );

  it('identifies sides blocked by missing match inputs or tiebreakers', () => {
    const draw = scenarioDraw(2025);
    const blue = forecast(draw.ties[1]!);
    expect(
      createChampionsLeagueSemiFinalSimulation(
        draw,
        [{ ...blue, extraTime: null }],
        options,
      ),
    ).toEqual({
      status: 'unavailable',
      blockedTies: [
        { side: 'silver', reason: 'missing-match-inputs' },
        { side: 'blue', reason: 'missing-extra-time' },
      ],
    });
    expect(
      createChampionsLeagueSemiFinalSimulation(
        draw,
        [forecast(draw.ties[0]!), { ...blue, penalties: null }],
        options,
      ),
    ).toEqual({
      status: 'unavailable',
      blockedTies: [{ side: 'blue', reason: 'knockout-sampler-unavailable' }],
    });
  });

  it('preserves published home orders for scenarios and rejects mixing them with played scores', () => {
    const official = officialDraw();
    const draw: SimulatedChampionsLeagueSemiFinalDraw = {
      ...official,
      source: 'simulated',
      ties: official.ties.map((tie, index) =>
        index === 0 ? { ...tie, first: { ...tie.first, source: 'simulated' } } : tie,
      ),
    };
    const prepared = ready(
      createChampionsLeagueSemiFinalSimulation(
        draw,
        draw.ties.map(forecast),
        options,
      ),
    );
    expect(prepared.sample(() => 0.25).draw).toMatchObject({
      source: 'simulated',
      homeOrder: { source: 'official' },
    });
    expect(() =>
      createChampionsLeagueSemiFinalSimulation(
        draw,
        draw.ties.map(completed),
        options,
      ),
    ).toThrow(/observed results require an official draw/);
  });

  it('rejects duplicate sides, changed feeder paths and incompatible home orders', () => {
    const draw = scenarioDraw(2026);
    const [silver, blue] = draw.ties;
    expect(() =>
      createChampionsLeagueSemiFinalSimulation(
        { ...draw, ties: [silver!, silver!] },
        [],
        options,
      ),
    ).toThrow(/one tie per side/);
    expect(() =>
      createChampionsLeagueSemiFinalSimulation(
        {
          ...draw,
          ties: [
            {
              ...silver!,
              first: {
                ...silver!.first,
                slot: { side: 'blue', seededPairStart: 1 },
              },
            },
            blue!,
          ],
        },
        [],
        options,
      ),
    ).toThrow(/retain their quarter-final feeder slots/);
    expect(() =>
      createChampionsLeagueSemiFinalSimulation(
        {
          ...draw,
          ties: [
            {
              ...silver!,
              first: {
                ...silver!.first,
                club: { ...silver!.first.club, position: 3 },
              },
            },
            blue!,
          ],
        },
        [],
        options,
      ),
    ).toThrow(/permitted league positions/);
    expect(() =>
      createChampionsLeagueSemiFinalSimulation(
        {
          ...draw,
          homeOrder: {
            source: 'simulated-lots',
            lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
            randomDraws: 2,
          },
        },
        [],
        options,
      ),
    ).toThrow(/home order consistent/);
    expect(() =>
      createChampionsLeagueSemiFinalSimulation(
        draw,
        [forecast({ ...silver!, firstLegHomeTeamId: silver!.first.club.teamId })],
        options,
      ),
    ).toThrow(/drawn home order/);
  });
});
