import type { ChampionsLeagueFinalFixture } from './champions-league-final-simulation';
import type { ChampionsLeagueTwoLegMatchInputs } from './champions-league-two-leg-round';

import type { ChampionsLeagueKnockoutObservation } from './champions-league-knockout-observation';

type Match = ChampionsLeagueKnockoutObservation;
type FixtureStage = Match['stage'];
type Draw = Pick<ChampionsLeagueFinalFixture, 'source' | 'season'>;
type TeamPair = Pick<
  ChampionsLeagueTwoLegMatchInputs,
  'firstTeamId' | 'secondTeamId'
>;

type TwoLegFixture = Draw &
  TeamPair & {
    readonly stage: Exclude<FixtureStage, 'FINAL'>;
    readonly firstLegHomeTeamId: number | null;
  };

type FinalFixture = Draw & {
  readonly silver: { readonly club: { readonly teamId: number } };
  readonly blue: { readonly club: { readonly teamId: number } };
};

type FixtureMatch<Fixtures extends readonly Match[]> =
  | { status: 'matched'; fixtures: Fixtures }
  | {
      status: 'unavailable';
      reason:
        | 'draw-not-confirmed'
        | 'season-mismatch'
        | 'missing-fixtures'
        | 'ambiguous-fixtures'
        | 'conflicting-fixtures';
    };

function fixtureKey(stage: FixtureStage, firstTeamId: number, secondTeamId: number) {
  return (
    stage +
    ':' +
    Math.min(firstTeamId, secondTeamId) +
    ':' +
    Math.max(firstTeamId, secondTeamId)
  );
}

/**
 * Match confirmed draws to the stored fixture states from one season and cutoff.
 * The draw supplies the participants and, when known, the first leg's host.
 * Match dates identify the leg order only when the stored venues agree.
 */
export function createChampionsLeagueKnockoutFixtureLookup(
  season: number,
  observations: readonly Readonly<Match>[],
) {
  const storedFixtures = new Map<string, Match[]>();
  for (const fixture of structuredClone(observations)) {
    const { stage, homeTeamId, awayTeamId } = fixture;
    if (homeTeamId === null || awayTeamId === null || homeTeamId === awayTeamId)
      continue;
    const key = fixtureKey(stage, homeTeamId, awayTeamId);
    const group = storedFixtures.get(key) ?? [];
    group.push(fixture);
    storedFixtures.set(key, group);
  }

  function findFixtures(
    draw: Draw,
    stage: FixtureStage,
    { firstTeamId, secondTeamId }: TeamPair,
    count: 1 | 2,
  ): FixtureMatch<readonly Match[]> {
    if (draw.season !== season)
      return { status: 'unavailable', reason: 'season-mismatch' };
    if (draw.source !== 'official')
      return { status: 'unavailable', reason: 'draw-not-confirmed' };

    const fixtures = storedFixtures.get(
      fixtureKey(stage, firstTeamId, secondTeamId),
    );
    if (fixtures === undefined || fixtures.length < count)
      return { status: 'unavailable', reason: 'missing-fixtures' };
    if (fixtures.length > count)
      return { status: 'unavailable', reason: 'ambiguous-fixtures' };
    return { status: 'matched', fixtures };
  }

  return {
    twoLeg(tie: TwoLegFixture): FixtureMatch<readonly [Match, Match]> {
      const group = findFixtures(tie, tie.stage, tie, 2);
      if (group.status === 'unavailable') return group;

      const [left, right] = group.fixtures;
      const [first, second] =
        left!.utcDate < right!.utcDate ? [left!, right!] : [right!, left!];
      if (
        !(first.utcDate < second.utcDate) ||
        first.matchId === second.matchId ||
        first.homeTeamId !== second.awayTeamId ||
        first.awayTeamId !== second.homeTeamId ||
        (tie.firstLegHomeTeamId !== null &&
          first.homeTeamId !== tie.firstLegHomeTeamId)
      )
        return { status: 'unavailable', reason: 'conflicting-fixtures' };

      return { status: 'matched', fixtures: structuredClone([first, second]) };
    },

    final(fixture: FinalFixture): FixtureMatch<readonly [Match]> {
      const group = findFixtures(
        fixture,
        'FINAL',
        {
          firstTeamId: fixture.silver.club.teamId,
          secondTeamId: fixture.blue.club.teamId,
        },
        1,
      );
      if (group.status === 'unavailable') return group;

      // Preserve the observed orientation of the score at the neutral venue.
      return { status: 'matched', fixtures: [structuredClone(group.fixtures[0]!)] };
    },
  };
}
