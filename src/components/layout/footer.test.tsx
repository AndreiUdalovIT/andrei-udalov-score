import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { Footer } from './footer';

vi.mock('./site-sync', () => ({ SiteSyncTimestamp: () => null }));

it('tells screen readers which links open a new tab', () => {
  render(<Footer />);
  const external = screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('target') === '_blank');

  // GitHub, Telegram and the data source.
  expect(external).toHaveLength(3);
  for (const link of external) {
    expect(link).toHaveAccessibleName(/\(откроется в новой вкладке\)$/);
  }
});
