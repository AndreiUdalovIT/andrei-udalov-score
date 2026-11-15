import type { ModelMatch } from './matches';

export type PredictionTiming = {
  dataCutoff: Date;
  calculatedAt: Date;
  publishedAt: Date;
};

type PredictionFixture = Pick<
  ModelMatch,
  'status' | 'utcDate' | 'homeTeamId' | 'awayTeamId'
>;

/**
 * Use the latest fixture state and the database publication time.
 * The storage operation must enforce these rules atomically when inserting.
 */
export function canPublishPrediction(
  fixture: Readonly<PredictionFixture>,
  { dataCutoff, calculatedAt, publishedAt }: Readonly<PredictionTiming>,
): boolean {
  if (
    (fixture.status !== 'SCHEDULED' && fixture.status !== 'TIMED') ||
    fixture.homeTeamId === null ||
    fixture.awayTeamId === null ||
    fixture.homeTeamId === fixture.awayTeamId
  ) {
    return false;
  }

  const cutoff = dataCutoff.getTime();
  const calculated = calculatedAt.getTime();
  const published = publishedAt.getTime();
  const kickoff = fixture.utcDate.getTime();

  return (
    [cutoff, calculated, published, kickoff].every(Number.isFinite) &&
    cutoff <= calculated &&
    calculated <= published &&
    published < kickoff
  );
}
