'use client';

import { useSyncExternalStore } from 'react';

import { getSyncAge } from '@/lib/utils/sync-age';

import { LocalTime } from './local-time';

const MINUTE = 60_000;
const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit' } as const;

function subscribe(onChange: () => void) {
  const timer = window.setInterval(onChange, MINUTE);
  window.addEventListener('focus', onChange);
  document.addEventListener('visibilitychange', onChange);

  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

// A primitive snapshot stays stable between minute boundaries.
const getSnapshot = () => Math.floor(Date.now() / MINUTE) * MINUTE;
const getServerSnapshot = () => null;

/** Exact local time during SSR; relative age after hydration, refreshed each minute. */
export function SyncTime({
  value,
  className,
}: {
  value: string | null;
  className?: string;
}) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!value || !Number.isFinite(Date.parse(value))) return null;

  if (now === null) {
    return <LocalTime value={value} options={TIME_OPTIONS} className={className} />;
  }

  const age = getSyncAge(value, now);
  if (!age) return null;

  return (
    <time
      dateTime={value}
      title={`Данные обновлены ${new Date(value).toLocaleString('ru-RU')}`}
      data-stale={age.isStale}
      className={className}
    >
      {age.label}
    </time>
  );
}
