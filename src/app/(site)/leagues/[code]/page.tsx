import type { Metadata } from 'next';
import { notFound, unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';

import { EmptyState } from '@/components/common/empty-state';
import { SeasonForecastPanel } from '@/components/football/season-forecast-panel';
import {
  competitionConfig,
  siteCompetitionCodes,
  type SiteCompetitionCode,
} from '@/lib/config/competitions';

export const metadata: Metadata = { title: 'Лига' };

async function PublishedSeasonForecast({ code }: { code: SiteCompetitionCode }) {
  if (!process.env.DATABASE_URL) {
    return <EmptyState title="Данные прогноза недоступны" />;
  }

  let published;
  try {
    const { getCurrentSeasonForecast } =
      await import('@/server/queries/season-forecasts');
    published = await getCurrentSeasonForecast(code);
  } catch (error) {
    unstable_rethrow(error);
    console.error('season forecast could not be loaded');
    return <EmptyState title="Не удалось загрузить прогноз сезона" />;
  }

  if (published === null) {
    return <EmptyState title="Опубликованного прогноза на этот сезон пока нет" />;
  }

  return (
    <SeasonForecastPanel
      key={published.id}
      published={published.forecast}
      teamNames={published.teamNames}
    />
  );
}

async function LeagueContent({
  params,
}: Pick<PageProps<'/leagues/[code]'>, 'params'>) {
  const { code: slug } = await params;
  const code = siteCompetitionCodes.find(
    (candidate) => competitionConfig[candidate].slug === slug,
  );
  if (code === undefined) notFound();

  return (
    <div className="space-y-4 py-6">
      <h1 className="text-h1 font-semibold">{competitionConfig[code].label}</h1>
      <section aria-labelledby="season-forecast-heading" className="space-y-3">
        <h2 id="season-forecast-heading" className="text-h2 font-semibold">
          Прогноз сезона
        </h2>
        <Suspense
          fallback={
            <p className="text-body-sm text-muted-foreground">Загружаем прогноз…</p>
          }
        >
          <PublishedSeasonForecast code={code} />
        </Suspense>
      </section>
    </div>
  );
}

export default function LeaguePage({ params }: PageProps<'/leagues/[code]'>) {
  return (
    <Suspense>
      <LeagueContent params={params} />
    </Suspense>
  );
}
