import 'server-only';

import { unstable_rethrow } from 'next/navigation';
import { cache } from 'react';

import { LocalTime } from '@/components/common/local-time';

import { Logo } from './logo';
import { SyncIndicator } from './sync-indicator';

// Share one journal snapshot across the header and footer in a server render.
const getLastSyncedAt = cache(async () => {
  if (!process.env.DATABASE_URL) return null;

  try {
    const { getSiteLastSyncedAt } = await import('@/server/queries/sync-status');
    return (await getSiteLastSyncedAt())?.toISOString() ?? null;
  } catch (error) {
    unstable_rethrow(error);
    console.error('site sync time could not be loaded');
    return null;
  }
});

export async function SiteSyncLogo() {
  const lastSyncedAt = await getLastSyncedAt();
  const title = lastSyncedAt
    ? `Данные обновлены ${new Date(lastSyncedAt).toLocaleString('ru-RU', { timeZone: 'UTC' })} UTC`
    : undefined;

  return <Logo title={title} />;
}

export async function SiteSyncIndicator({ className }: { className?: string }) {
  const lastSyncedAt = await getLastSyncedAt();
  return <SyncIndicator lastSyncedAt={lastSyncedAt} className={className} />;
}

export async function SiteSyncTimestamp() {
  const lastSyncedAt = await getLastSyncedAt();
  if (!lastSyncedAt) return null;

  return (
    <span>
      Обновлено{' '}
      <LocalTime
        value={lastSyncedAt}
        options={{
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }}
      />
    </span>
  );
}
