import { describe, expect, it } from 'vitest';

import { createChampionsLeaguePlayOffDraw } from './champions-league-play-off-draw';
import { createChampionsLeaguePlayOffSimulation } from './champions-league-play-off-simulation';
import {
  createChampionsLeagueRoundOf16Draw,
  type ChampionsLeagueRoundOf16Tie,
} from './champions-league-round-of-16-draw';
import {
  CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM,
  createChampionsLeagueRoundOf16Simulation,
  type ChampionsLeagueRoundOf16MatchInputs,
} from './champions-league-round-of-16-simulation';
import { createSeededRandom } from './seeded-random';

const groups = Array.from({ length: 36 }, (_, index) => ({
  from: index + 1,
  to: index + 1,
  teamIds: [100 - index],
}));
const options = { maxGoals: 40, tailTolerance: 1e-10 };
const seed = [1, 2, 3, 4] as const;

function completedLegs(firstHome: number, firstAway: number) {
  return [
    {
      leg: 1,
      kind: 'known-result',
      homeTeamId: firstHome,
      awayTeamId: firstAway,
      homeGoals90: 2,
      awayGoals90: 0,
    },
    {
      leg: 2,
      kind: 'known-result',
      homeTeamId: firstAway,
      awayTeamId: firstHome,
      homeGoals90: 0,
      awayGoals90: 0,
    },
  ] as const;
}

function ready<T>(
  prepared: { status: 'ready'; sample: T } | { status: 'unavailable' },
) {
  if (prepared.status !== 'ready') throw new Error('example round must be ready');
  return prepared;
}

function draws() {
  const playOff = createChampionsLeaguePlayOffDraw(2026, groups)!;
  const scenario = playOff.sample(createSeededRandom(seed));
  const published = playOff.fromOfficial({
    sourceReference: 'test-play-off-draw',
    ties: scenario.ties.map((tie) => ({
      side: tie.side,
      seededTeamId: tie.seeded.teamId,
      unseededTeamId: tie.unseeded.teamId,
      firstLegHomeTeamId: tie.unseeded.teamId,
    })),
  });
  const played = ready(
    createChampionsLeaguePlayOffSimulation(
      published,
      published.ties.map(({ seeded, unseeded }) => ({
        seededTeamId: seeded.teamId,
        unseededTeamId: unseeded.teamId,
        legs: completedLegs(unseeded.teamId, seeded.teamId),
        extraTime: null,
        penalties: null,
      })),
      options,
    ),
  ).sample(createSeededRandom(seed));

  const builder = createChampionsLeagueRoundOf16Draw(groups, played)!;
  const simulated = builder.sample(createSeededRandom(seed));
  const official = builder.fromOfficial({
    sourceReference: 'test-round-of-16-draw',
    ties: simulated.ties.map((tie, index) => ({
      side: tie.side,
      seededTeamId: tie.seeded.teamId,
      winnerTeamId: tie.playOffWinner.club.teamId,
      firstLegHomeTeamId:
        index === 0
          ? tie.seeded.teamId
          : index === 1
            ? null
            : tie.firstLegHomeTeamId,
    })),
  });
  return { simulated, official };
}

function completedInput(
  tie: ChampionsLeagueRoundOf16Tie,
): ChampionsLeagueRoundOf16MatchInputs {
  const firstTeamId = tie.seeded.teamId;
  const secondTeamId = tie.playOffWinner.club.teamId;
  const firstHome = tie.firstLegHomeTeamId ?? secondTeamId;
  return {
    firstTeamId,
    secondTeamId,
    legs: completedLegs(
      firstHome,
      firstHome === firstTeamId ? secondTeamId : firstTeamId,
    ),
    extraTime: null,
    penalties: null,
  };
}

function forecastInput(
  tie: ChampionsLeagueRoundOf16Tie,
): ChampionsLeagueRoundOf16MatchInputs {
  const base = completedInput(tie);
  return {
    ...base,
    legs: base.legs.map(({ leg, homeTeamId, awayTeamId }) => ({
      leg,
      homeTeamId,
      awayTeamId,
      kind: 'forecast',
      homeRate90: 0,
      awayRate90: 0,
    })),
    extraTime: { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
    penalties: { kind: 'forecast', firstTeamWinProbability: 0 },
  };
}

describe('Champions League round of 16 simulation', () => {
  it('advances observed winners by their round-of-16 slots after regulation, extra time and penalties', () => {
    const { official } = draws();
    const inputs = official.ties.map(completedInput);
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
    const preparation = createChampionsLeagueRoundOf16Simulation(
      official,
      inputs,
      options,
    );
    expect(preparation).toMatchObject({ status: 'ready', tailUpperBound: 0 });
    const result = ready(preparation).sample(() => {
      throw new Error('a completed round must not use RNG');
    });
    expect(result.algorithm).toBe(CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM);
    expect(result.draw).toMatchObject({
      source: 'official',
      sourceReference: 'test-round-of-16-draw',
      playOffDraw: { source: 'official', sourceReference: 'test-play-off-draw' },
    });
    expect(result.ties.map(({ tie }) => tie)).toEqual(official.ties);
    expect(result.ties[0]!.result).toMatchObject({
      winnerTeamId: first.secondTeamId,
      method: 'extra-time-goals',
      aggregateGoals90: { first: 2, second: 2 },
      extraTime: { homeTeamId: first.secondTeamId, source: 'known-result' },
    });
    expect(result.ties[1]!.result).toMatchObject({
      winnerTeamId: second.firstTeamId,
      method: 'penalties',
      shootout: { winnerTeamId: second.firstTeamId, source: 'known-result' },
    });
    expect(result.ties.slice(2).map(({ result }) => result.method)).toEqual(
      Array.from({ length: 6 }, () => 'aggregate-goals'),
    );
  });

  it('keeps the observed first leg and simulates the rest at the supplied venues', () => {
    const { official } = draws();
    const inputs = official.ties.map(completedInput);
    const first = inputs[0]!;
    const forecast = forecastInput(official.ties[0]!);
    inputs[0] = {
      ...forecast,
      legs: [
        { ...first.legs[0]!, kind: 'known-result', homeGoals90: 0, awayGoals90: 0 },
        forecast.legs[1]!,
      ],
    };
    const prepared = ready(
      createChampionsLeagueRoundOf16Simulation(official, inputs, options),
    );
    let randomCalls = 0;
    const result = prepared.sample(() => {
      randomCalls += 1;
      return 0.5;
    });
    expect(randomCalls).toBe(5);
    expect(result.ties[0]!.result).toMatchObject({
      winnerTeamId: first.secondTeamId,
      legs: [
        { homeTeamId: first.firstTeamId, source: 'known-result' },
        { homeTeamId: first.secondTeamId, source: 'simulated' },
      ],
      extraTime: { homeTeamId: first.secondTeamId, source: 'simulated' },
      shootout: { winnerTeamId: first.secondTeamId, source: 'simulated' },
    });
  });

  it('samples all eight scenario ties reproducibly in slot order and isolates results', () => {
    const { simulated } = draws();
    const inputs = simulated.ties.map(
      (tie): ChampionsLeagueRoundOf16MatchInputs => ({
        ...forecastInput(tie),
        penalties: { kind: 'forecast', firstTeamWinProbability: 0.5 },
      }),
    );
    const prepared = ready(
      createChampionsLeagueRoundOf16Simulation(simulated, inputs, options),
    );
    const reference = prepared.sample(createSeededRandom(seed));
    const reordered = ready(
      createChampionsLeagueRoundOf16Simulation(
        { ...simulated, ties: [...simulated.ties].reverse() },
        inputs.reverse(),
        options,
      ),
    ).sample(createSeededRandom(seed));
    expect(reordered).toEqual(reference);
    expect(reference.draw).toMatchObject({ source: 'simulated', randomDraws: 4 });
    expect(
      new Set(
        reference.ties.map(
          ({ tie, result }) => result.winnerTeamId === tie.seeded.teamId,
        ),
      ),
    ).toEqual(new Set([true, false]));
    const changed = prepared.sample(createSeededRandom(seed));
    changed.draw.playOffDraw.season = 1999;
    changed.ties[0]!.tie.playOffWinner.club.teamId = 0;
    simulated.ties[0]!.playOffWinner.club.teamId = 0;
    expect(prepared.sample(createSeededRandom(seed))).toEqual(reference);
  });

  it('reports missing pairs, extra time and penalty inputs by their round-of-16 slots', () => {
    const { simulated } = draws();
    const inputs = simulated.ties.map(forecastInput);
    inputs[1] = { ...inputs[1]!, extraTime: null };
    inputs[2] = { ...inputs[2]!, penalties: null };
    expect(
      createChampionsLeagueRoundOf16Simulation(simulated, inputs.slice(1), options),
    ).toEqual({
      status: 'unavailable',
      blockedTies: [
        { seededPairStart: 1, side: 'silver', reason: 'missing-match-inputs' },
        { seededPairStart: 1, side: 'blue', reason: 'missing-extra-time' },
        {
          seededPairStart: 3,
          side: 'silver',
          reason: 'knockout-sampler-unavailable',
        },
      ],
    });
  });

  it('rejects reversed match identity, incorrect home order and observations in a scenario', () => {
    const { official, simulated } = draws();
    const inputs = official.ties.map(completedInput);
    const [first, ...remaining] = inputs;
    const { firstTeamId, secondTeamId } = first!;
    expect(() =>
      createChampionsLeagueRoundOf16Simulation(
        official,
        [
          { ...first!, firstTeamId: secondTeamId, secondTeamId: firstTeamId },
          ...remaining,
        ],
        options,
      ),
    ).toThrow(/ordered drawn pairs/);
    expect(() =>
      createChampionsLeagueRoundOf16Simulation(
        official,
        [
          { ...first!, legs: completedLegs(secondTeamId, firstTeamId) },
          ...remaining,
        ],
        options,
      ),
    ).toThrow(/drawn home order/);
    expect(() =>
      createChampionsLeagueRoundOf16Simulation(
        simulated,
        simulated.ties.map(completedInput),
        options,
      ),
    ).toThrow(/require an official draw/);
  });

  it('rejects a changed season, duplicate slot and a winner assigned to the opposite side', () => {
    const { official } = draws();
    expect(() =>
      createChampionsLeagueRoundOf16Simulation(
        { ...official, season: 2025 },
        [],
        options,
      ),
    ).toThrow(/play-off season/);

    const [first, second, ...rest] = official.ties;
    const duplicate = { ...official, ties: [first!, first!, ...rest] };
    expect(() =>
      createChampionsLeagueRoundOf16Simulation(duplicate, [], options),
    ).toThrow(/one tie per side/);
    const winner = first!.playOffWinner;
    const wrongSide: ChampionsLeagueRoundOf16Tie = {
      ...first!,
      playOffWinner: { ...winner, slot: { ...winner.slot, side: 'blue' } },
    };
    expect(() =>
      createChampionsLeagueRoundOf16Simulation(
        { ...official, ties: [wrongSide, second!, ...rest] },
        [],
        options,
      ),
    ).toThrow(/retain their play-off winner slots/);
  });
});
