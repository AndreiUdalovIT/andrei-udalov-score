import Link from 'next/link';
import { Suspense } from 'react';

import { Button } from '@/components/ui/button';

import { Logo } from './logo';
import { NavLinks, NavMenu } from './nav-links';
import { SearchField, SearchIconButton } from './search-button';
import { SiteSyncIndicator, SiteSyncLogo } from './site-sync';
import { ThemeToggle } from './theme-toggle';

/**
 * Four layouts switched by CSS alone, no JS measuring the window:
 * below 1024 — compact mobile header (sections live in the bottom tab bar);
 * 1024–1099 — sections behind «Меню», search as an icon;
 * 1100–1279 — sections in a row, sync time moves into the logo tooltip;
 * from 1280 — full header with the search field and the sync indicator.
 */
export function Header() {
  return (
    <>
      <header className="hidden border-b bg-background lg:block">
        <div
          className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-8 nav:gap-6"
        >
          <Suspense fallback={<Logo />}>
            <SiteSyncLogo />
          </Suspense>
          <NavLinks className="hidden nav:flex" />
          <NavMenu className="nav:hidden" />
          <div className="flex-1" />
          <SearchField className="hidden xl:flex" />
          <SearchIconButton className="xl:hidden" />
          <div className="flex shrink-0 items-center gap-2">
            <Suspense fallback={null}>
              <SiteSyncIndicator className="hidden h-9 px-2.5 text-body-sm xl:flex" />
            </Suspense>
            <ThemeToggle />
            {/* Until sign-in exists (stage 5), «Войти» leads to the profile stub. */}
            <Button asChild>
              <Link href="/profile">Войти</Link>
            </Button>
          </div>
        </div>
      </header>

      <header
        className="sticky top-0 z-20 flex h-14 items-center gap-2.5 border-b
          bg-background pr-2 pl-4 lg:hidden"
      >
        <Logo short />
        <div className="flex-1" />
        <Suspense fallback={null}>
          <SiteSyncIndicator className="text-caption" />
        </Suspense>
        <SearchIconButton mobile />
      </header>
    </>
  );
}
