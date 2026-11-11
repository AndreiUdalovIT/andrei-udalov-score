import { Clock } from 'lucide-react';

import { SyncTime } from '@/components/common/sync-time';

import { cn } from '@/lib/utils';

/**
 * A relative age of the site's last successful sync; hidden while it is unknown.
 */
export function SyncIndicator({
  lastSyncedAt,
  className,
}: {
  /** ISO timestamp; null means incomplete or unavailable journal coverage. */
  lastSyncedAt: string | null;
  className?: string;
}) {
  if (!lastSyncedAt) return null;

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <Clock aria-hidden="true" className="size-3.5" />
      <span>
        <span className="sr-only">Данные обновлены </span>
        <SyncTime
          value={lastSyncedAt}
          className="data-[stale=true]:text-status-live"
        />
      </span>
    </span>
  );
}
