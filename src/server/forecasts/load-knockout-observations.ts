import 'server-only';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import {
  championsLeagueKnockoutStages,
  type ChampionsLeagueKnockoutObservation,
} from '@/lib/model/champions-league-knockout-observation';
import { selectTrainingMatches } from '@/lib/model/matches';

import type { matchObservations } from '../db/schema';
import { loadCompetitionMatchObservations } from '../queries/match-observations';

type MatchObservation = typeof matchObservations.$inferSelect;
type ObservedKnockoutScore = NonNullable<
  ChampionsLeagueKnockoutObservation['result']
>;

function isGoalCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function readScore(
  match: MatchObservation,
  before: Date,
): ObservedKnockoutScore | null {
  const [finished] = selectTrainingMatches(
    [{ ...match, id: match.matchId }],
    before,
  );
  const { duration, homeGoals, awayGoals, homePenalties, awayPenalties } = match;
  if (finished === undefined || !isGoalCount(homeGoals) || !isGoalCount(awayGoals))
    return null;

  const { homeTeamId, awayTeamId, homeGoals90, awayGoals90 } = finished;
  const regulation = {
    kind: 'known-result' as const,
    homeTeamId,
    awayTeamId,
    homeGoals90,
    awayGoals90,
  };

  let penalties: ObservedKnockoutScore['penalties'] = null;
  let homeShootoutGoals = 0;
  let awayShootoutGoals = 0;
  if (duration === 'PENALTY_SHOOTOUT') {
    if (
      !isGoalCount(homePenalties) ||
      !isGoalCount(awayPenalties) ||
      homePenalties === awayPenalties
    )
      return null;
    homeShootoutGoals = homePenalties;
    awayShootoutGoals = awayPenalties;
    penalties = {
      kind: 'known-result',
      winnerTeamId: homePenalties > awayPenalties ? homeTeamId : awayTeamId,
    };
  } else if ((homePenalties ?? 0) !== 0 || (awayPenalties ?? 0) !== 0) {
    return null;
  }

  // football-data.org fullTime includes goals in every completed period.
  const homeGoals30 = homeGoals - homeGoals90 - homeShootoutGoals;
  const awayGoals30 = awayGoals - awayGoals90 - awayShootoutGoals;
  if (!isGoalCount(homeGoals30) || !isGoalCount(awayGoals30)) return null;

  if (duration === 'REGULAR') {
    if (homeGoals30 !== 0 || awayGoals30 !== 0) return null;
    return { regulation, extraTime: null, penalties: null };
  }

  if (duration !== 'EXTRA_TIME' && duration !== 'PENALTY_SHOOTOUT') return null;
  return {
    regulation,
    extraTime: { kind: 'known-result', homeGoals30, awayGoals30 },
    penalties,
  };
}

/**
 * Load the latest stored knockout fixture states strictly before the cutoff.
 * The competition API stage does not establish the draw or order of a tie.
 */
export async function loadChampionsLeagueKnockoutObservations(
  season: number,
  before: Date,
): Promise<ChampionsLeagueKnockoutObservation[] | null> {
  const cutoff = new Date(before.getTime());
  if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() > Date.now())
    throw new RangeError(
      'knockout observations require a valid cutoff at or before now',
    );

  if (getCompetitionSeasonConfig('CL', season)?.format !== 'league-phase')
    return null;

  const observations = await loadCompetitionMatchObservations(
    'CL',
    [season],
    cutoff,
  );
  const matches: ChampionsLeagueKnockoutObservation[] = [];
  for (const observation of observations) {
    const stage = championsLeagueKnockoutStages.find(
      (candidate) => candidate === observation.stage,
    );
    if (stage === undefined) continue;

    const { matchId, utcDate, observedAt, status, homeTeamId, awayTeamId } =
      observation;
    matches.push({
      matchId,
      utcDate,
      observedAt,
      status,
      homeTeamId,
      awayTeamId,
      stage,
      result: readScore(observation, cutoff),
    });
  }
  return matches;
}
