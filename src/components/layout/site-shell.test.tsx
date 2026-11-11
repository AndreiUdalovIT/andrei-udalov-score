import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { SiteShell } from './site-shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('./site-sync', async () => {
  const { Logo } = await import('./logo');
  return {
    SiteSyncLogo: Logo,
    SiteSyncIndicator: () => null,
    SiteSyncTimestamp: () => null,
  };
});

it('starts the tab order with a link that skips to the content', async () => {
  render(<SiteShell>Страница</SiteShell>);
  await userEvent.setup().tab();

  const skip = screen.getByRole('link', { name: 'Перейти к содержимому' });
  expect(skip).toHaveFocus();
  expect(skip).toHaveAttribute('href', '#content');
  expect(screen.getByRole('main')).toHaveAttribute('id', 'content');
});
