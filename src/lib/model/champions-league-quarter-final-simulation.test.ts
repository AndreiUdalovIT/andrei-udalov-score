import { describe, expect, it } from 'vitest';

import { CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM } from './champions-league-play-off-draw';
import {
  CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
  type ChampionsLeagueQuarterFinalTie,
  type RecordedChampionsLeagueQuarterFinalDraw,
  type SimulatedChampionsLeagueQuarterFinalDraw,
} from './champions-league-quarter-final-draw';
import {
  CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM,
  createChampionsLeagueQuarterFinalSimulation,
  type ChampionsLeagueQuarterFinalMatchInputs,
  type ChampionsLeagueQuarterFinalPreparation,
} from './champions-league-quarter-final-simulation';
import { CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM } from './champions-league-round-of-16-draw';
import { createSeededRandom } from './seeded-random';
import { SEASON_LOTS_SAMPLING_ALGORITHM } from './season-lots-sampler';

const options = { maxGoals: 40, tailTolerance: 1e-10 };
const seed = [1, 2, 3, 4] as const;

function officialDraw(season = 2025): RecordedChampionsLeagueQuarterFinalDraw {
  const fixtures = [
    ['silver', 1, 7, 15, 9, 115],
    ['silver', 3, 5, 13, 11, null],
    ['blue', 1, 7, 16, 10, 110],
    ['blue', 3, 5, 14, 12, 112],
  ] as const;
  const ties: ChampionsLeagueQuarterFinalTie[] = fixtures.map(
    ([
      side,
      seededPairStart,
      opponentBand,
      firstPosition,
      secondPosition,
      firstLegHomeTeamId,
    ]) => ({
      side,
      seededPairStart,
      first: {
        club: { teamId: firstPosition + 100, position: firstPosition },
        slot: { side, seededPairStart },
        source: 'observed',
      },
      second: {
        club: { teamId: secondPosition + 100, position: secondPosition },
        slot: { side, seededPairStart: opponentBand },
        source: 'observed',
      },
      firstLegHomeTeamId,
    }),
  );
  return {
    algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
    season,
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
    source: 'official',
    homeOrder: { source: 'official', sourceReference: 'test-quarter-finals' },
    ties,
  };
}

function scenarioDraw(season: number): SimulatedChampionsLeagueQuarterFinalDraw {
  const published = officialDraw(season);
  return {
    ...published,
    source: 'simulated',
    homeOrder:
      season === 2024
        ? {
            source: 'simulated-lots',
            lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
            randomDraws: 4,
          }
        : { source: 'inherited-seeding' },
    ties: published.ties.map((tie) => ({
      ...tie,
      firstLegHomeTeamId:
        season === 2024 ? tie.first.club.teamId : tie.second.club.teamId,
    })),
  };
}

function completedInput(
  tie: ChampionsLeagueQuarterFinalTie,
): ChampionsLeagueQuarterFinalMatchInputs {
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
        homeGoals90: 2,
        awayGoals90: 0,
      },
      {
        kind: 'known-result',
        leg: 2,
        homeTeamId: away,
        awayTeamId: home,
        homeGoals90: 0,
        awayGoals90: 0,
      },
    ],
    extraTime: null,
    penalties: null,
  };
}

function forecastInput(
  tie: ChampionsLeagueQuarterFinalTie,
): ChampionsLeagueQuarterFinalMatchInputs {
  const base = completedInput(tie);
  return {
    ...base,
    legs: base.legs.map(({ leg, homeTeamId, awayTeamId }) => ({
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

function ready(prepared: ChampionsLeagueQuarterFinalPreparation) {
  if (prepared.status !== 'ready')
    throw new Error('test quarter-finals must be ready');
  return prepared;
}

describe('Champions League quarter-final simulation', () => {
  it('keeps completed winners, extra-time goals and shootouts in their quarter-final paths', () => {
    const draw = officialDraw();
    const inputs = draw.ties.map(completedInput);
    const first = inputs[0]!;
    const second = inputs[1]!;
    inputs[0] = {
      ...first,
      legs: [
        { ...first.legs[0]!, kind: 'known-result', homeGoals90: 1, awayGoals90: 0 },
        { ...first.legs[1]!, kind: 'known-result', homeGoals90: 2, awayGoals90: 1 },
      ],
      extraTime: { kind: 'known-result', homeGoals30: 1, awayGoals30: 0 },
    };
    inputs[1] = {
      ...second,
      legs: second.legs.map((leg) => ({
        ...leg,
        kind: 'known-result',
        homeGoals90: 0,
        awayGoals90: 0,
      })),
      extraTime: { kind: 'known-result', homeGoals30: 0, awayGoals30: 0 },
      penalties: { kind: 'known-result', winnerTeamId: second.firstTeamId },
    };
    const prepared = ready(
      createChampionsLeagueQuarterFinalSimulation(draw, inputs, options),
    );
    expect(prepared.tailUpperBound).toBe(0);
    const sample = prepared.sample(() => {
      throw new Error('completed ties must not consume RNG');
    });
    expect(sample).toMatchObject({
      algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM,
      draw: {
        source: 'official',
        homeOrder: { sourceReference: 'test-quarter-finals' },
      },
    });
    expect(sample.ties.map(({ tie }) => tie)).toEqual(draw.ties);
    expect(sample.ties[0]!.result).toMatchObject({
      winnerTeamId: 109,
      method: 'extra-time-goals',
      aggregateGoals90: { first: 2, second: 2 },
      extraTime: { homeTeamId: 109, source: 'known-result' },
    });
    expect(sample.ties[1]!.result).toMatchObject({
      winnerTeamId: 113,
      method: 'penalties',
      shootout: { winnerTeamId: 113, source: 'known-result' },
    });
    expect(sample.ties.slice(2).map(({ result }) => result.method)).toEqual([
      'aggregate-goals',
      'aggregate-goals',
    ]);
  });

  it('starts from the observed first leg and preserves the return leg venue', () => {
    const draw = officialDraw();
    const inputs = draw.ties.map(completedInput);
    const first = inputs[0]!;
    const forecast = forecastInput(draw.ties[0]!);
    inputs[0] = {
      ...forecast,
      legs: [
        { ...first.legs[0]!, kind: 'known-result', homeGoals90: 0, awayGoals90: 0 },
        forecast.legs[1]!,
      ],
    };
    const prepared = ready(
      createChampionsLeagueQuarterFinalSimulation(draw, inputs, options),
    );
    let draws = 0;
    const result = prepared.sample(() => {
      draws += 1;
      return 0.25;
    }).ties[0]!.result;
    expect(draws).toBe(5);
    expect(result).toMatchObject({
      winnerTeamId: 115,
      legs: [
        { homeTeamId: 115, source: 'known-result' },
        { homeTeamId: 109, source: 'simulated' },
      ],
      extraTime: { homeTeamId: 109, source: 'simulated' },
      shootout: { winnerTeamId: 115, source: 'simulated' },
    });
  });

  it.each([2024, 2025, 2026])(
    'replays the same ordered scenarios in season %s',
    (season) => {
      const draw = scenarioDraw(season);
      const inputs = draw.ties.map(forecastInput);
      const prepared = ready(
        createChampionsLeagueQuarterFinalSimulation(draw, inputs, options),
      );
      const reordered = ready(
        createChampionsLeagueQuarterFinalSimulation(
          { ...draw, ties: [...draw.ties].reverse() },
          [...inputs].reverse(),
          options,
        ),
      );
      const reference = prepared.sample(createSeededRandom(seed));
      expect(
        reference.ties.map(({ tie }) => [tie.side, tie.seededPairStart]),
      ).toEqual([
        ['silver', 1],
        ['silver', 3],
        ['blue', 1],
        ['blue', 3],
      ]);
      expect(reference.draw.homeOrder).toEqual(draw.homeOrder);
      expect(reordered.sample(createSeededRandom(seed))).toEqual(reference);
      const changed = reordered.sample(createSeededRandom(seed));
      changed.draw.roundOf16Draw.season = 1900;
      changed.ties[0]!.tie.first.club.teamId = 999;
      draw.ties[0]!.first.club.teamId = 888;
      expect(reordered.sample(createSeededRandom(seed))).toEqual(reference);
    },
  );

  it('accepts a published venue order for a scenario while requiring forecasts for its scores', () => {
    const published = officialDraw();
    const draw: SimulatedChampionsLeagueQuarterFinalDraw = {
      ...published,
      source: 'simulated',
      ties: published.ties.map((tie, index) =>
        index === 0 ? { ...tie, first: { ...tie.first, source: 'simulated' } } : tie,
      ),
    };
    const preparation = ready(
      createChampionsLeagueQuarterFinalSimulation(
        draw,
        draw.ties.map(forecastInput),
        options,
      ),
    );
    expect(preparation.sample(() => 0.25).draw).toMatchObject({
      source: 'simulated',
      homeOrder: { source: 'official' },
    });
    expect(() =>
      createChampionsLeagueQuarterFinalSimulation(
        draw,
        draw.ties.map(completedInput),
        options,
      ),
    ).toThrow(/observed results require an official draw/);
  });

  it('returns missing prerequisites by their slot on the bracket', () => {
    const draw = scenarioDraw(2025);
    const inputs = draw.ties.map(forecastInput);
    inputs[1] = { ...inputs[1]!, extraTime: null };
    inputs[2] = { ...inputs[2]!, penalties: null };
    expect(
      createChampionsLeagueQuarterFinalSimulation(draw, inputs.slice(1), options),
    ).toEqual({
      status: 'unavailable',
      blockedTies: [
        { seededPairStart: 1, side: 'silver', reason: 'missing-match-inputs' },
        { seededPairStart: 3, side: 'silver', reason: 'missing-extra-time' },
        { seededPairStart: 1, side: 'blue', reason: 'knockout-sampler-unavailable' },
      ],
    });
  });

  it('rejects changed feeder slots, a historically wrong home order and mismatched fixtures', () => {
    const draw = scenarioDraw(2026);
    const [tie, ...rest] = draw.ties;
    expect(() =>
      createChampionsLeagueQuarterFinalSimulation(
        {
          ...draw,
          homeOrder: {
            source: 'simulated-lots',
            lotSamplingAlgorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
            randomDraws: 4,
          },
        },
        [],
        options,
      ),
    ).toThrow(/home order consistent/);
    expect(() =>
      createChampionsLeagueQuarterFinalSimulation(
        {
          ...draw,
          ties: [
            {
              ...tie!,
              first: { ...tie!.first, slot: { ...tie!.first.slot, side: 'blue' } },
            },
            ...rest,
          ],
        },
        [],
        options,
      ),
    ).toThrow(/retain their round-of-16 feeder slots/);
    expect(() =>
      createChampionsLeagueQuarterFinalSimulation(
        draw,
        [forecastInput({ ...tie!, firstLegHomeTeamId: tie!.first.club.teamId })],
        options,
      ),
    ).toThrow(/drawn home order/);
  });
});
