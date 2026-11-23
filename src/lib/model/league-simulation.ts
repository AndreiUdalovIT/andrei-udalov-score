import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { SiteCompetitionCode } from '@/lib/config/competitions';

import {
  BUNDESLIGA_RANKING_ALGORITHM,
  rankBundesligaSeason,
} from './bundesliga-ranking';
import {
  createKnockoutSampler,
  KNOCKOUT_SAMPLING_ALGORITHM,
  type KnockoutLegInput,
  type KnockoutSampler,
} from './knockout-sampler';
import {
  LA_LIGA_RANKING_ALGORITHM,
  rankLaLigaSeason,
  type LaLigaFairPlayRank,
} from './la-liga-ranking';
import {
  createLeagueForecastAccumulator,
  type LeagueForecastSummary,
  type LeagueForecastPositionGroup,
} from './league-forecast-accumulator';
import {
  LIGUE1_RANKING_ALGORITHM,
  rankLigue1Season,
  type Ligue1DisciplinaryPoints,
} from './ligue1-ranking';
import type { PoissonDistributionOptions } from './poisson-distribution';
import {
  PREMIER_LEAGUE_RANKING_ALGORITHM,
  rankPremierLeagueSeason,
} from './premier-league-ranking';
import { reconcileRoundRobinSeason } from './round-robin-season';
import {
  createSeasonCalendarSampler,
  type SeasonCalendarFixture,
  type SeasonFixtureScore,
} from './season-calendar-sampler';
import {
  createSeasonLotsSampler,
  SEASON_LOTS_SAMPLING_ALGORITHM,
} from './season-lots-sampler';
import {
  createSeededRandom,
  SEEDED_RANDOM_ALGORITHM,
  type RandomSeed,
} from './seeded-random';
import {
  planSerieAPlayOffs,
  type SerieAPlayOffEvent,
} from './serie-a-play-off-plan';
import { rankSerieASeason, SERIE_A_RANKING_ALGORITHM } from './serie-a-ranking';
import {
  projectSeasonStats,
  type SeasonStatsBaseline,
  type ProjectedSeasonStats,
} from './season-stats';

export const LEAGUE_SIMULATION_ALGORITHM = 'seeded-fixed-rate-league-simulation-v3';

type PlayOffGoalRates = Readonly<{ homeRate90: number; awayRate90: number }>;

export type SerieAPlayOffScenario = {
  readonly higherTeamId: number;
  readonly lowerTeamId: number;
  readonly higherHome: PlayOffGoalRates;
  /** Chance that the higher mini-table seed wins the shootout, if needed. */
  readonly higherSeedShootoutWinProbability: number;
} & (
  | { readonly kind: 'title' }
  | { readonly kind: 'survival'; readonly lowerHome: PlayOffGoalRates }
);

type FixedContext = {
  readonly laLigaFairPlay?: readonly Readonly<LaLigaFairPlayRank>[];
  readonly ligue1Discipline?: readonly Readonly<Ligue1DisciplinaryPoints>[];
  readonly serieAUefaFinalistTeamIds?: readonly number[] | null;
  /** Forecast rates for the nominal venues of an ordered play-off pair. */
  readonly serieAPlayOffScenarios?: readonly SerieAPlayOffScenario[];
};

export type LeagueSimulationInput = {
  readonly competitionCode: SiteCompetitionCode;
  readonly season: number;
  readonly modelVersion: string;
  /** Supplied UTC epoch milliseconds; the caller enforces the actual data cutoff. */
  readonly dataCutoffMs: number;
  readonly seed: RandomSeed;
  readonly runs: number;
  readonly sampling: Readonly<PoissonDistributionOptions>;
  readonly baseline: readonly Readonly<SeasonStatsBaseline>[];
  readonly fixtures: readonly SeasonCalendarFixture[];
  /** Explicit final-scenario values, held fixed across all runs; omitted means unknown. */
  readonly fixedContext?: FixedContext;
};

export type LeagueSimulationSnapshot = Omit<
  LeagueSimulationInput,
  'fixedContext'
> & {
  readonly fixedContext: {
    readonly laLigaFairPlay: readonly Readonly<LaLigaFairPlayRank>[];
    readonly ligue1Discipline: readonly Readonly<Ligue1DisciplinaryPoints>[];
    readonly serieAUefaFinalistTeamIds: readonly number[] | null;
    readonly serieAPlayOffScenarios: readonly SerieAPlayOffScenario[];
  };
};

type RankingGroup = LeagueForecastPositionGroup & { readonly reason: string };
type Ranking = { algorithm: string; groups: readonly RankingGroup[] };

export type LeagueSimulationUnavailability = {
  run: number;
  reason:
    | 'ranking-unavailable'
    | 'ranking-unresolved'
    | 'serie-a-play-off-context-required'
    | 'serie-a-play-off-sampling-unavailable';
  groups: { from: number; to: number; teamIds: number[]; reason: string }[];
  playOffEvents: SerieAPlayOffEvent[];
};

export type LeagueSimulationResult = {
  algorithm: typeof LEAGUE_SIMULATION_ALGORITHM;
  inputSnapshot: LeagueSimulationSnapshot;
  versions: {
    random: typeof SEEDED_RANDOM_ALGORITHM;
    calendar: string;
    score: string;
    ranking: string;
    lots: typeof SEASON_LOTS_SAMPLING_ALGORITHM;
    knockout: typeof KNOCKOUT_SAMPLING_ALGORITHM | null;
  };
  lotPolicy: 'simulate-eligible-uniform-lots';
  /** Truncated Poisson mass bounds, excluding numeric/RNG resolution and model error. */
  samplingBounds: { perRun: number; allRuns: number };
  forecast: LeagueForecastSummary;
};

export type LeagueSimulation = {
  readonly completedRuns: number;
  readonly status:
    'ready' | 'running' | 'complete' | 'unavailable' | 'failed' | 'cancelled';
  readonly unavailability: LeagueSimulationUnavailability | null;
  /** Advance at most maxRuns (default 1); terminal jobs are left unchanged. */
  readonly advance: (maxRuns?: number) => void;
  readonly cancel: () => void;
  readonly result: () => LeagueSimulationResult | null;
};

const rankingAlgorithms: Partial<Record<SiteCompetitionCode, string>> = {
  PL: PREMIER_LEAGUE_RANKING_ALGORITHM,
  PD: LA_LIGA_RANKING_ALGORITHM,
  BL1: BUNDESLIGA_RANKING_ALGORITHM,
  SA: SERIE_A_RANKING_ALGORITHM,
  FL1: LIGUE1_RANKING_ALGORITHM,
};

function copySerieAPlayOffScenarios(
  scenarios: readonly SerieAPlayOffScenario[],
): SerieAPlayOffScenario[] {
  function copyRates(rates: PlayOffGoalRates): PlayOffGoalRates {
    if (rates == null) throw new RangeError('play-off goal rates are required');
    return { homeRate90: rates.homeRate90, awayRate90: rates.awayRate90 };
  }

  return Array.from(scenarios, (scenario): SerieAPlayOffScenario => {
    if (scenario == null)
      throw new RangeError('play-off scenarios cannot contain missing rows');
    const pair = {
      higherTeamId: scenario.higherTeamId,
      lowerTeamId: scenario.lowerTeamId,
      higherHome: copyRates(scenario.higherHome),
      higherSeedShootoutWinProbability: scenario.higherSeedShootoutWinProbability,
    };
    if (scenario.kind === 'title') return { ...pair, kind: 'title' };
    if (scenario.kind === 'survival')
      return { ...pair, kind: 'survival', lowerHome: copyRates(scenario.lowerHome) };
    throw new RangeError('play-off scenarios must be title or survival');
  }).sort(
    (left, right) =>
      Number(left.kind === 'survival') - Number(right.kind === 'survival') ||
      left.higherTeamId - right.higherTeamId ||
      left.lowerTeamId - right.lowerTeamId,
  );
}

function playOffKey(
  kind: SerieAPlayOffEvent['kind'],
  higherTeamId: number,
  lowerTeamId: number,
): string {
  return kind + ':' + higherTeamId + ':' + lowerTeamId;
}

function prepareSerieAPlayOffs(snapshot: LeagueSimulationSnapshot) {
  const roster = new Set(snapshot.baseline.map((row) => row.teamId));
  const samplers = new Map<string, KnockoutSampler | null>();
  const tailByKind = { title: 0, survival: 0 };
  for (const scenario of snapshot.fixedContext.serieAPlayOffScenarios) {
    const { kind, higherTeamId, lowerTeamId, higherHome } = scenario;
    const key = playOffKey(kind, higherTeamId, lowerTeamId);
    if (
      higherTeamId === lowerTeamId ||
      !roster.has(higherTeamId) ||
      !roster.has(lowerTeamId) ||
      samplers.has(key)
    ) {
      throw new RangeError(
        'play-off scenarios require distinct roster clubs and unique ordered pairs per kind',
      );
    }
    const higherHomeLeg = {
      kind: 'forecast' as const,
      homeTeamId: higherTeamId,
      awayTeamId: lowerTeamId,
      ...higherHome,
    };
    const legs: KnockoutLegInput[] =
      kind === 'title'
        ? [{ ...higherHomeLeg, leg: 1 }]
        : [
            {
              kind: 'forecast',
              leg: 1,
              homeTeamId: lowerTeamId,
              awayTeamId: higherTeamId,
              ...scenario.lowerHome,
            },
            { ...higherHomeLeg, leg: 2 },
          ];
    const sampler = createKnockoutSampler({
      firstTeamId: higherTeamId,
      secondTeamId: lowerTeamId,
      legs,
      extraTime: { kind: 'none' },
      penalties: {
        kind: 'forecast',
        firstTeamWinProbability: scenario.higherSeedShootoutWinProbability,
      },
      sampling: snapshot.sampling,
    });
    samplers.set(key, sampler);
    if (sampler !== null)
      tailByKind[kind] = Math.max(tailByKind[kind], sampler.tailUpperBound);
  }
  return { samplers, tailUpperBound: tailByKind.title + tailByKind.survival };
}

function copyInput(input: LeagueSimulationInput): LeagueSimulationSnapshot {
  return {
    competitionCode: input.competitionCode,
    season: input.season,
    modelVersion: input.modelVersion,
    dataCutoffMs: input.dataCutoffMs,
    seed: [...input.seed] as [number, number, number, number],
    runs: input.runs,
    sampling: {
      tailTolerance: input.sampling.tailTolerance,
      maxGoals: input.sampling.maxGoals,
    },
    baseline: Array.from(input.baseline, (row) => {
      if (row === undefined || row === null)
        throw new RangeError('baseline cannot contain missing rows');
      return {
        teamId: row.teamId,
        playedGames: row.playedGames,
        won: row.won,
        draw: row.draw,
        lost: row.lost,
        points: row.points,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
      };
    }).sort((left, right) => left.teamId - right.teamId),
    fixtures: Array.from(input.fixtures, (fixture): SeasonCalendarFixture => {
      if (fixture === undefined || fixture === null)
        throw new RangeError('calendar cannot contain missing fixtures');
      const identity = {
        id: fixture.id,
        homeTeamId: fixture.homeTeamId,
        awayTeamId: fixture.awayTeamId,
      };
      if (fixture.kind === 'known-result')
        return {
          ...identity,
          kind: 'known-result',
          homeGoals90: fixture.homeGoals90,
          awayGoals90: fixture.awayGoals90,
        };
      if (fixture.kind === 'forecast')
        return {
          ...identity,
          kind: 'forecast',
          homeRate90: fixture.homeRate90,
          awayRate90: fixture.awayRate90,
        };
      throw new RangeError('fixture kind must be known-result or forecast');
    }).sort((left, right) => left.id - right.id),
    fixedContext: {
      serieAPlayOffScenarios: copySerieAPlayOffScenarios(
        input.fixedContext?.serieAPlayOffScenarios ?? [],
      ),
      laLigaFairPlay: Array.from(input.fixedContext?.laLigaFairPlay ?? [], (row) => {
        if (row === undefined || row === null)
          throw new RangeError('Fair Play cannot contain missing rows');
        return { teamId: row.teamId, rank: row.rank };
      }).sort((left, right) => left.teamId - right.teamId),
      ligue1Discipline: Array.from(
        input.fixedContext?.ligue1Discipline ?? [],
        (row) => {
          if (row === undefined || row === null)
            throw new RangeError('discipline cannot contain missing rows');
          return { teamId: row.teamId, points: row.points };
        },
      ).sort((left, right) => left.teamId - right.teamId),
      serieAUefaFinalistTeamIds:
        input.fixedContext?.serieAUefaFinalistTeamIds == null
          ? null
          : Array.from(input.fixedContext.serieAUefaFinalistTeamIds).sort(
              (left, right) => left - right,
            ),
    },
  };
}

/**
 * Prepare a seed-reproducible, cooperatively stepped league simulation.
 * Copy/canonicalize its complete input snapshot; keep fixture rates, official
 * adjustments and explicitly supplied final-context assumptions fixed across runs.
 * Preflight known-result reconciliation and oriented pair coverage without RNG:
 * zero-goal placeholders for future fixtures are used only for these checks.
 * Each run samples the whole calendar by fixture ID, projects league stats, then
 * ranks the season. Only eligible modern Ligue 1 / Serie A lots use the same RNG
 * after calendar draws, in position order. Never randomize missing criteria.
 * For Serie A, sample required title then survival play-offs after the lots.
 * Only explicitly supplied rates/probabilities for the selected ordered pair
 * are used, at nominal venues without extra time. A waiver consumes no RNG.
 * These games resolve positions without adding to league stats. The truncation
 * bound includes at most one title game and one survival series per run, using
 * the largest sampler bound of each kind across supplied pairs.
 * Withhold the entire forecast at the first unresolved scenario. No runs are
 * skipped or resampled. A resolved Premier League shared position is retained
 * as a tied finish. Missing context and unavailable samplers are reported.
 * advance boundaries do not affect the RNG sequence. Cancellation is observed
 * between calls, allowing a server/Worker wrapper to schedule cooperative batches.
 * Invalid run control throws without changing the job. Unexpected run errors mark
 * it failed and are rethrown. Complete/terminal jobs cannot resume or be overwritten.
 * Return null for unsupported formats/seasons or unavailable sampling/reconciliation.
 * Invalid seed, metadata, counts, rates, context and unsafe arithmetic throw RangeError.
 * result copies the full serializable snapshot, versions, bounds and forecast.
 * Its inputSnapshot can recreate the same job with matching implementation versions.
 * The caller selects cutoff-safe fixtures/statuses and supplies the model's rates;
 * this kernel neither verifies temporal authenticity nor queries external data.
 */
export function createLeagueSimulation(
  input: LeagueSimulationInput,
): LeagueSimulation | null {
  if (
    typeof input.modelVersion !== 'string' ||
    input.modelVersion.trim().length === 0 ||
    !Number.isSafeInteger(input.dataCutoffMs) ||
    !Number.isFinite(new Date(input.dataCutoffMs).getTime())
  ) {
    throw new RangeError(
      'simulation requires a model version and valid UTC cutoff milliseconds',
    );
  }
  const random = createSeededRandom(input.seed);
  const snapshot = copyInput(input);
  const accumulator = createLeagueForecastAccumulator(
    snapshot.competitionCode,
    snapshot.season,
    snapshot.baseline.map((row) => row.teamId),
    snapshot.runs,
  );
  const rankingAlgorithm = rankingAlgorithms[snapshot.competitionCode];
  if (accumulator === null || rankingAlgorithm === undefined) return null;
  const config = getCompetitionSeasonConfig(
    snapshot.competitionCode,
    snapshot.season,
  )!;
  const context = snapshot.fixedContext;
  if (
    (snapshot.competitionCode !== 'PD' && context.laLigaFairPlay.length > 0) ||
    (snapshot.competitionCode !== 'FL1' && context.ligue1Discipline.length > 0) ||
    (snapshot.competitionCode !== 'SA' &&
      ((context.serieAUefaFinalistTeamIds?.length ?? 0) > 0 ||
        context.serieAPlayOffScenarios.length > 0))
  )
    throw new RangeError('fixed final context must belong to the selected league');

  const calendar = createSeasonCalendarSampler(snapshot.fixtures, snapshot.sampling);
  const serieAPlayOffs = prepareSerieAPlayOffs(snapshot);
  const previewScores: SeasonFixtureScore[] = snapshot.fixtures.map((fixture) => ({
    id: fixture.id,
    homeTeamId: fixture.homeTeamId,
    awayTeamId: fixture.awayTeamId,
    source: fixture.kind === 'known-result' ? 'known-result' : 'simulated',
    homeGoals90: fixture.kind === 'known-result' ? fixture.homeGoals90 : 0,
    awayGoals90: fixture.kind === 'known-result' ? fixture.awayGoals90 : 0,
  }));
  const preview = projectSeasonStats(snapshot.baseline, previewScores);
  if (
    preview === null ||
    reconcileRoundRobinSeason(preview, previewScores, config) === null
  )
    return null;

  function rank(
    rows: readonly Readonly<SeasonStatsBaseline>[],
    scores: readonly SeasonFixtureScore[],
  ): Ranking | null {
    switch (snapshot.competitionCode) {
      case 'PL':
        return rankPremierLeagueSeason(rows, scores, snapshot.season);
      case 'BL1':
        return rankBundesligaSeason(rows, scores, snapshot.season);
      case 'PD':
        return rankLaLigaSeason(
          rows,
          scores,
          snapshot.season,
          context.laLigaFairPlay,
        );
      case 'FL1':
        return rankLigue1Season(
          rows,
          scores,
          snapshot.season,
          context.ligue1Discipline,
        );
      default:
        return null;
    }
  }
  const previewRanking =
    snapshot.competitionCode === 'SA'
      ? planSerieAPlayOffs(
          preview,
          previewScores,
          snapshot.season,
          context.serieAUefaFinalistTeamIds,
        )
      : rank(preview, previewScores);
  if (previewRanking === null || calendar === null) return null;

  const perRunTailUpperBound = Math.min(
    1,
    calendar.tailUpperBound + serieAPlayOffs.tailUpperBound,
  );

  let phase: LeagueSimulation['status'] = 'ready';
  let unavailable: LeagueSimulationUnavailability | null = null;

  function isUnresolvedGroup(group: RankingGroup): boolean {
    return (
      (group.teamIds.length !== 1 || group.from !== group.to) &&
      !(snapshot.competitionCode === 'PL' && group.reason === 'shared-position')
    );
  }

  function pause(
    reason: LeagueSimulationUnavailability['reason'],
    groups: readonly RankingGroup[] = [],
    events: readonly SerieAPlayOffEvent[] = [],
  ): null {
    phase = 'unavailable';
    unavailable = {
      run: accumulator!.completedRuns + 1,
      reason,
      groups: groups.filter(isUnresolvedGroup).map((group) => ({
        from: group.from,
        to: group.to,
        teamIds: [...group.teamIds],
        reason: group.reason,
      })),
      playOffEvents: structuredClone([...events]),
    };
    return null;
  }

  function resolveRun(
    rows: readonly ProjectedSeasonStats[],
    scores: readonly SeasonFixtureScore[],
  ): Ranking | null {
    if (snapshot.competitionCode === 'SA') {
      const plan = planSerieAPlayOffs(
        rows,
        scores,
        snapshot.season,
        context.serieAUefaFinalistTeamIds,
      );
      if (plan === null) return pause('ranking-unavailable');
      const eligible = plan.preliminary.groups.filter(
        (group) => group.reason === 'drawing-of-lots-required',
      );
      const lots =
        eligible.length === 0
          ? null
          : createSeasonLotsSampler(eligible).sample(random);
      const selected =
        lots === null || plan.events.length === 0
          ? plan
          : planSerieAPlayOffs(
              rows,
              scores,
              snapshot.season,
              context.serieAUefaFinalistTeamIds,
              lots,
            );
      if (selected === null) return pause('ranking-unavailable');

      const playable: {
        kind: SerieAPlayOffEvent['kind'];
        sampler: KnockoutSampler;
      }[] = [];
      for (const event of selected.events) {
        if (
          event.selection === 'ordered-pair-known' &&
          event.decision === 'classifica-avulsa-applies'
        )
          continue;
        const selectedPair =
          event.selection === 'ordered-pair-known' &&
          event.decision === 'play-off-required';
        const sampler = selectedPair
          ? serieAPlayOffs.samplers.get(
              playOffKey(
                event.kind,
                event.higherSlot.candidateTeamIds[0]!,
                event.lowerSlot.candidateTeamIds[0]!,
              ),
            )
          : undefined;
        if (sampler === undefined)
          return pause('serie-a-play-off-context-required', [], [event]);
        if (sampler === null)
          return pause('serie-a-play-off-sampling-unavailable', [], [event]);
        playable.push({ kind: event.kind, sampler });
      }
      const outcomes = playable.map(({ kind, sampler }) => {
        const { legs, shootout } = sampler.sample(random);
        return { kind, legs, shootout };
      });
      return (
        rankSerieASeason(
          rows,
          scores,
          snapshot.season,
          context.serieAUefaFinalistTeamIds,
          lots,
          outcomes,
        ) ?? pause('ranking-unavailable')
      );
    }
    let ranked = rank(rows, scores);
    if (ranked === null) return pause('ranking-unavailable');
    if (snapshot.competitionCode === 'FL1') {
      const unresolved = ranked.groups.filter((group) => group.teamIds.length > 1);
      if (unresolved.some((group) => group.reason !== 'drawing-of-lots-required'))
        return pause('ranking-unresolved', ranked.groups);
      const eligible = unresolved.filter(
        (group) => group.reason === 'drawing-of-lots-required',
      );
      if (eligible.length > 0) {
        const lots = createSeasonLotsSampler(eligible).sample(random);
        ranked = rankLigue1Season(
          rows,
          scores,
          snapshot.season,
          context.ligue1Discipline,
          lots,
        );
        if (ranked === null) return pause('ranking-unavailable');
      }
    }
    return ranked.groups.some(isUnresolvedGroup)
      ? pause('ranking-unresolved', ranked.groups)
      : ranked;
  }

  return {
    get completedRuns() {
      return accumulator.completedRuns;
    },
    get status() {
      return phase;
    },
    get unavailability() {
      return unavailable === null ? null : structuredClone(unavailable);
    },
    advance(maxRuns = 1) {
      if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0)
        throw new RangeError('batch size must be a positive safe integer');
      if (phase !== 'ready' && phase !== 'running') return;
      phase = 'running';
      const limit = Math.min(maxRuns, snapshot.runs - accumulator.completedRuns);
      try {
        for (let index = 0; index < limit; index += 1) {
          const scores = calendar.sample(random);
          const rows = projectSeasonStats(snapshot.baseline, scores);
          if (rows === null)
            throw new RangeError(
              'prepared baseline no longer reconciles with known results',
            );
          const ranked = resolveRun(rows, scores);
          if (ranked === null) return;
          accumulator.addRun(rows, ranked.groups);
        }
        if (accumulator.status === 'complete') phase = 'complete';
      } catch (error) {
        phase = 'failed';
        throw error;
      }
    },
    cancel() {
      if (phase === 'ready' || phase === 'running') phase = 'cancelled';
    },
    result() {
      if (phase !== 'complete') return null;
      const forecast = accumulator.summarize()!;
      return {
        algorithm: LEAGUE_SIMULATION_ALGORITHM,
        inputSnapshot: structuredClone(snapshot),
        versions: {
          random: SEEDED_RANDOM_ALGORITHM,
          calendar: calendar.algorithm,
          score: calendar.scoreSamplingAlgorithm,
          ranking: rankingAlgorithm,
          lots: SEASON_LOTS_SAMPLING_ALGORITHM,
          knockout:
            serieAPlayOffs.samplers.size === 0 ? null : KNOCKOUT_SAMPLING_ALGORITHM,
        },
        lotPolicy: 'simulate-eligible-uniform-lots',
        samplingBounds: {
          perRun: perRunTailUpperBound,
          allRuns: Math.min(1, perRunTailUpperBound * snapshot.runs),
        },
        forecast,
      };
    },
  };
}
