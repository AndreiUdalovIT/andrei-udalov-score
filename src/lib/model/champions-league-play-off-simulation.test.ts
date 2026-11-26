import { describe, expect, it } from 'vitest';

import {
  createChampionsLeaguePlayOffDraw,
  type ChampionsLeaguePlayOffTie,
} from './champions-league-play-off-draw';
import {
  CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM,
  createChampionsLeaguePlayOffSimulation,
  type ChampionsLeaguePlayOffMatchInputs,
} from './champions-league-play-off-simulation';
import { createPoissonScoreSampler } from './poisson-score-sampler';
import { createSeededRandom } from './seeded-random';

const options = { maxGoals: 40, tailTolerance: 1e-10 };
const table = Array.from({ length: 36 }, (_, index) => ({
  from: index + 1,
  to: index + 1,
  teamIds: [index + 1],
}));
const drawBuilder = createChampionsLeaguePlayOffDraw(2026, table)!;

function simulatedDraw() {
  return drawBuilder.sample(createSeededRandom([1, 2, 3, 4]));
}

function officialDraw(firstLeg: 'standard' | 'reversed' | 'unknown' = 'standard') {
  const model = simulatedDraw();
  return drawBuilder.fromOfficial({
    sourceReference: 'test-published-draw',
    ties: model.ties.map((tie, index) => ({
      side: tie.side,
      seededTeamId: tie.seeded.teamId,
      unseededTeamId: tie.unseeded.teamId,
      firstLegHomeTeamId:
        index === 0 && firstLeg === 'unknown'
          ? null
          : index === 0 && firstLeg === 'reversed'
            ? tie.seeded.teamId
            : tie.unseeded.teamId,
    })),
  });
}

function matchInput(
  tie: ChampionsLeaguePlayOffTie,
): ChampionsLeaguePlayOffMatchInputs {
  const home = tie.firstLegHomeTeamId ?? tie.unseeded.teamId;
  const away = home === tie.seeded.teamId ? tie.unseeded.teamId : tie.seeded.teamId;
  return {
    seededTeamId: tie.seeded.teamId,
    unseededTeamId: tie.unseeded.teamId,
    legs: [
      {
        leg: 1,
        homeTeamId: home,
        awayTeamId: away,
        kind: 'known-result',
        homeGoals90: 2,
        awayGoals90: 0,
      },
      {
        leg: 2,
        homeTeamId: away,
        awayTeamId: home,
        kind: 'known-result',
        homeGoals90: 0,
        awayGoals90: 0,
      },
    ],
    extraTime: null,
    penalties: null,
  };
}

function forecast(
  tie: ChampionsLeaguePlayOffTie,
): ChampionsLeaguePlayOffMatchInputs {
  const base = matchInput(tie);
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
    penalties: { kind: 'forecast', firstTeamWinProbability: 0.65 },
  };
}

function ready(prepared: ReturnType<typeof createChampionsLeaguePlayOffSimulation>) {
  expect(prepared.status).toBe('ready');
  if (prepared.status !== 'ready') throw new Error('round unexpectedly unavailable');
  return prepared;
}

describe('Champions League play-off round simulation', () => {
  it('keeps played outcomes, including extra time and shootouts, in their bracket slots', () => {
    const draw = officialDraw('reversed');
    const inputs = draw.ties.map(matchInput);
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
      penalties: { kind: 'known-result', winnerTeamId: second.unseededTeamId },
    };
    const prepared = ready(
      createChampionsLeaguePlayOffSimulation(draw, inputs.reverse(), options),
    );
    expect(prepared.tailUpperBound).toBe(0);
    const result = prepared.sample(() => {
      throw new Error('observations must not consume random draws');
    });
    expect(result.algorithm).toBe(CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM);
    expect(result.draw).toMatchObject({
      season: 2026,
      source: 'official',
      sourceReference: 'test-published-draw',
    });
    expect(result.ties.map(({ tie }) => tie)).toEqual(draw.ties);
    expect(result.ties[0]!.result).toMatchObject({
      winnerTeamId: first.unseededTeamId,
      method: 'extra-time-goals',
      aggregateGoals90: { first: 2, second: 2 },
      extraTime: { homeTeamId: first.unseededTeamId, source: 'known-result' },
      aggregateGoalsAfterExtraTime: { first: 2, second: 3 },
    });
    expect(result.ties[1]!.result).toMatchObject({
      winnerTeamId: second.unseededTeamId,
      method: 'penalties',
      shootout: { winnerTeamId: second.unseededTeamId, source: 'known-result' },
    });
    expect(
      result.ties
        .slice(2)
        .every(({ result }) => result.method === 'aggregate-goals'),
    ).toBe(true);
  });

  it('starts a mixed forecast from the played first leg and uses the supplied home order', () => {
    const draw = officialDraw('unknown');
    const inputs = draw.ties.map(matchInput);
    const first = inputs[0]!;
    inputs[0] = {
      ...first,
      legs: [
        { ...first.legs[0]!, kind: 'known-result', homeGoals90: 1, awayGoals90: 0 },
        { ...first.legs[1]!, kind: 'forecast', homeRate90: 1.5, awayRate90: 0 },
      ],
      extraTime: { kind: 'forecast', homeRate30: 0.4, awayRate30: 0 },
      penalties: { kind: 'forecast', firstTeamWinProbability: 0.65 },
    };
    const values = [0.5, 0.5, 0.2, 0.5, 0.8];
    let calls = 0;
    const prepared = ready(
      createChampionsLeaguePlayOffSimulation(draw, inputs, options),
    );
    const result = prepared.sample(() => values[calls++]!);
    expect(calls).toBe(5);
    expect(result.ties[0]!.tie.firstLegHomeTeamId).toBeNull();
    // The regular-time median at rate 1.5 is one goal, whereas the
    // extra-time draw at uniform 0.2 and rate 0.4 yields zero.
    expect(result.ties[0]!.result).toMatchObject({
      aggregateGoals90: { first: 1, second: 1 },
      legs: [
        { leg: 1, homeGoals90: 1, source: 'known-result' },
        { leg: 2, homeGoals90: 1, source: 'simulated' },
      ],
      extraTime: {
        homeTeamId: first.seededTeamId,
        homeGoals30: 0,
        source: 'simulated',
      },
      shootout: { winnerTeamId: first.unseededTeamId, source: 'simulated' },
    });
    expect(prepared.tailUpperBound).toBe(
      createPoissonScoreSampler(1.5, 0, options)!.tailUpperBound +
        createPoissonScoreSampler(0.4, 0, options)!.tailUpperBound,
    );
  });

  it('replays simulated wins regardless of the input order and isolates output', () => {
    const draw = simulatedDraw();
    const inputs = draw.ties.map(forecast);
    const a = ready(createChampionsLeaguePlayOffSimulation(draw, inputs, options));
    const b = ready(
      createChampionsLeaguePlayOffSimulation(
        { ...draw, ties: [...draw.ties].reverse() },
        [...inputs]
          .reverse()
          .map((input) => ({ ...input, legs: [...input.legs].reverse() })),
        options,
      ),
    );
    const seed = [123, 456, 789, 101112] as const;
    const reference = a.sample(createSeededRandom(seed));
    expect(reference.draw).toMatchObject({ source: 'simulated', randomDraws: 8 });
    expect(reference.ties).toHaveLength(8);
    expect(b.sample(createSeededRandom(seed))).toEqual(reference);
    const altered = b.sample(createSeededRandom(seed));
    altered.ties[0]!.tie.seeded.teamId = 999;
    altered.ties[0]!.result.legs[0]!.homeGoals90 = 99;
    draw.ties[0]!.seeded.teamId = 999;
    expect(a.sample(createSeededRandom(seed))).toEqual(reference);
  });

  it('reports blocked slots when the round cannot be resolved', () => {
    const draw = officialDraw();
    const inputs = draw.ties.map(forecast);
    inputs[1] = { ...inputs[1]!, extraTime: null };
    inputs[2] = { ...inputs[2]!, penalties: null };
    expect(
      createChampionsLeaguePlayOffSimulation(draw, inputs.slice(1), options),
    ).toEqual({
      status: 'unavailable',
      blockedTies: [
        { seededPairStart: 9, side: 'silver', reason: 'missing-match-inputs' },
        { seededPairStart: 9, side: 'blue', reason: 'missing-extra-time' },
        {
          seededPairStart: 11,
          side: 'silver',
          reason: 'knockout-sampler-unavailable',
        },
      ],
    });
  });

  it('requires extra time for a tied reported aggregate even if a shootout winner is supplied', () => {
    const draw = officialDraw();
    const inputs = draw.ties.map(matchInput);
    const first = inputs[0]!;
    inputs[0] = {
      ...first,
      legs: first.legs.map((leg) => ({
        ...leg,
        kind: 'known-result',
        homeGoals90: 0,
        awayGoals90: 0,
      })),
      penalties: { kind: 'known-result', winnerTeamId: first.seededTeamId },
    };
    expect(
      createChampionsLeaguePlayOffSimulation(draw, inputs, options),
    ).toMatchObject({
      status: 'unavailable',
      blockedTies: [
        { seededPairStart: 9, side: 'silver', reason: 'missing-extra-time' },
      ],
    });
  });

  it('rejects contradictory observations, venues and pair assignments', () => {
    const draw = officialDraw();
    const inputs = draw.ties.map(matchInput);
    const first = inputs[0]!;
    const replacing = (match: ChampionsLeaguePlayOffMatchInputs) => [
      match,
      ...inputs.slice(1),
    ];
    expect(() =>
      createChampionsLeaguePlayOffSimulation(simulatedDraw(), inputs, options),
    ).toThrow(/official draw/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        draw,
        replacing({
          ...first,
          legs: [forecast(draw.ties[0]!).legs[0]!, first.legs[1]!],
        }),
        options,
      ),
    ).toThrow(/chronological/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        draw,
        replacing({
          ...first,
          legs: [first.legs[0]!],
        }),
        options,
      ),
    ).toThrow(/two legs/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        draw,
        replacing({
          ...first,
          legs: first.legs.map((leg) => ({
            ...leg,
            homeTeamId: leg.awayTeamId,
            awayTeamId: leg.homeTeamId,
          })),
        }),
        options,
      ),
    ).toThrow(/drawn home order/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        draw,
        replacing({
          ...first,
          seededTeamId: inputs[1]!.seededTeamId,
        }),
        options,
      ),
    ).toThrow(/drawn pairs/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(draw, [...inputs, first], options),
    ).toThrow(/unique ordered/);
  });

  it('rejects tampered draw slots and positions before preparing matches', () => {
    const draw = simulatedDraw();
    const inputs = draw.ties.map(forecast);
    const first = draw.ties[0]!;
    const replacing = (tie: ChampionsLeaguePlayOffTie) => ({
      ...draw,
      ties: [tie, ...draw.ties.slice(1)],
    });
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        replacing({ ...first, side: 'blue' }),
        inputs,
        options,
      ),
    ).toThrow(/one tie per side/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        replacing({ ...first, unseeded: { ...first.unseeded, position: 21 } }),
        inputs,
        options,
      ),
    ).toThrow(/permitted league positions/);
    expect(() =>
      createChampionsLeaguePlayOffSimulation(
        { ...draw, randomDraws: 7 },
        inputs,
        options,
      ),
    ).toThrow(/simulation metadata/);
  });
});
