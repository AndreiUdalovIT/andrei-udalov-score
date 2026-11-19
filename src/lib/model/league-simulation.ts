import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { SiteCompetitionCode } from '@/lib/config/competitions';

import {
  BUNDESLIGA_RANKING_ALGORITHM,
  rankBundesligaSeason,
} from './bundesliga-ranking';
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

export const LEAGUE_SIMULATION_ALGORITHM = 'seeded-fixed-rate-league-simulation-v1';

type FixedContext = {
  readonly laLigaFairPlay?: readonly Readonly<LaLigaFairPlayRank>[];
  readonly ligue1Discipline?: readonly Readonly<Ligue1DisciplinaryPoints>[];
  readonly serieAUefaFinalistTeamIds?: readonly number[] | null;
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
  };
};

type RankingGroup = LeagueForecastPositionGroup & { readonly reason: string };
type Ranking = { algorithm: string; groups: readonly RankingGroup[] };

export type LeagueSimulationUnavailability = {
  run: number;
  reason:
    | 'ranking-unavailable'
    | 'ranking-unresolved'
    | 'serie-a-play-off-context-required';
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
 * Withhold the entire forecast at the first unresolved scenario. No runs are
 * skipped or resampled. Serie A games/shootouts are not sampled in this version;
 * required play-offs or missing finalist context stop with explicit diagnostics.
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
      (context.serieAUefaFinalistTeamIds?.length ?? 0) > 0)
  )
    throw new RangeError('fixed final context must belong to the selected league');

  const calendar = createSeasonCalendarSampler(snapshot.fixtures, snapshot.sampling);
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
      case 'SA':
        return rankSerieASeason(
          rows,
          scores,
          snapshot.season,
          context.serieAUefaFinalistTeamIds,
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

  let phase: LeagueSimulation['status'] = 'ready';
  let unavailable: LeagueSimulationUnavailability | null = null;

  function pause(
    reason: LeagueSimulationUnavailability['reason'],
    groups: readonly RankingGroup[] = [],
    events: readonly SerieAPlayOffEvent[] = [],
  ): null {
    phase = 'unavailable';
    unavailable = {
      run: accumulator!.completedRuns + 1,
      reason,
      groups: groups
        .filter((group) => group.teamIds.length !== 1 || group.from !== group.to)
        .map((group) => ({
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
      const ranked = rankSerieASeason(
        rows,
        scores,
        snapshot.season,
        context.serieAUefaFinalistTeamIds,
        lots,
      );
      if (ranked !== null) return ranked;
      const selected = planSerieAPlayOffs(
        rows,
        scores,
        snapshot.season,
        context.serieAUefaFinalistTeamIds,
        lots,
      );
      return pause('serie-a-play-off-context-required', [], selected?.events ?? []);
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
    return ranked.groups.some(
      (group) => group.teamIds.length !== 1 || group.from !== group.to,
    )
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
        },
        lotPolicy: 'simulate-eligible-uniform-lots',
        samplingBounds: {
          perRun: calendar.tailUpperBound,
          allRuns: Math.min(1, calendar.tailUpperBound * snapshot.runs),
        },
        forecast,
      };
    },
  };
}
