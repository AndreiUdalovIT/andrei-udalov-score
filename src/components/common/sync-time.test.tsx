import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SyncTime } from './sync-time';

const NOW = Date.parse('2026-11-09T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('updates the age and stale state, then releases its timer on unmount', () => {
  const { unmount } = render(<SyncTime value="2026-11-09T04:01:00Z" />);
  expect(screen.getByText('7 ч назад')).toHaveAttribute('data-stale', 'false');

  act(() => vi.advanceTimersByTime(60_000));

  expect(screen.getByText('8 ч назад')).toHaveAttribute('data-stale', 'true');
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('refreshes after returning to a tab without waiting for its timer', () => {
  render(<SyncTime value="2026-11-09T12:00:00Z" />);
  expect(screen.getByText('только что')).toBeInTheDocument();

  vi.setSystemTime(NOW + 3 * 3_600_000);
  fireEvent.focus(window);
  expect(screen.getByText('3 ч назад')).toBeInTheDocument();

  vi.setSystemTime(NOW + 4 * 3_600_000);
  fireEvent(document, new Event('visibilitychange'));
  expect(screen.getByText('4 ч назад')).toBeInTheDocument();
});

it('hydrates an exact server time into a relative age without recovery errors', async () => {
  const value = '2026-11-09T10:00:00Z';
  const container = document.createElement('div');
  container.innerHTML = renderToString(<SyncTime value={value} />);
  document.body.append(container);

  expect(container.querySelector('time')).toHaveAttribute('datetime', value);
  expect(container.querySelector('time')).not.toHaveAttribute('data-stale');

  vi.setSystemTime(NOW + 3_600_000);
  const errors: unknown[] = [];
  let root: Root | undefined;

  try {
    await act(async () => {
      root = hydrateRoot(container, <SyncTime value={value} />, {
        onRecoverableError: (error) => errors.push(error),
      });
    });

    expect(container.querySelector('time')).toHaveTextContent('3 ч назад');
    expect(errors).toEqual([]);
  } finally {
    act(() => root?.unmount());
    container.remove();
  }
});
