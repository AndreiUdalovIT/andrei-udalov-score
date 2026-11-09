import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import { siteLinks } from '@/lib/config/site';

import { SiteSyncTimestamp } from './site-sync';

const LINK =
  'inline-flex min-h-6 items-center gap-1 font-medium text-foreground hover:text-primary';

/** Opens in a new tab and tells screen readers so; `arrow` — the visible hint. */
function ExternalLink({
  href,
  arrow = true,
  children,
}: {
  href: string;
  arrow?: boolean;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
      {children}
      {arrow && (
        <ArrowUpRight aria-hidden="true" className="size-3 text-muted-foreground" />
      )}
      <span className="sr-only"> (откроется в новой вкладке)</span>
    </a>
  );
}

/** One row from 1024px, two compact rows on mobile; same markup for both. */
export function Footer() {
  return (
    <footer aria-label="О проекте" className="border-t bg-background">
      <div
        className="mx-auto flex max-w-7xl flex-col gap-1.5 px-4 pt-3.5 pb-4
          text-caption text-muted-foreground lg:flex-row lg:flex-wrap lg:items-center
          lg:gap-x-8 lg:gap-y-3 lg:px-8 lg:pt-5 lg:pb-6 lg:text-body-sm"
      >
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 lg:gap-x-4">
          <span className="font-semibold text-foreground">
            Pet-проект Андрея Удалова
          </span>
          <ExternalLink href={siteLinks.github}>GitHub</ExternalLink>
          <ExternalLink href={siteLinks.telegram}>Telegram</ExternalLink>
        </div>

        <div className="hidden flex-1 lg:block" />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:gap-x-4">
          <span>
            Данные —{' '}
            <ExternalLink href={siteLinks.dataSource} arrow={false}>
              football-data.org
            </ExternalLink>
          </span>
          <Suspense fallback={null}>
            <SiteSyncTimestamp />
          </Suspense>
          <Link href={siteLinks.methodology} className={LINK}>
            Методология
          </Link>
        </div>
      </div>
    </footer>
  );
}
