import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const ORIENTATIONS = [
  { orientation: 'horizontal', next: '{ArrowRight}', previous: '{ArrowLeft}' },
  { orientation: 'vertical', next: '{ArrowDown}', previous: '{ArrowUp}' },
] as const;

describe('Tabs', () => {
  it.each(ORIENTATIONS)(
    'supports $orientation keyboard navigation',
    async ({ orientation, next, previous }) => {
      const user = userEvent.setup();
      render(
        <Tabs defaultValue="table" orientation={orientation}>
          <TabsList aria-label="Лига">
            <TabsTrigger value="table">Таблица</TabsTrigger>
            <TabsTrigger value="matches">Матчи</TabsTrigger>
          </TabsList>
          <TabsContent value="table">Турнирная таблица</TabsContent>
          <TabsContent value="matches">Матчи лиги</TabsContent>
        </Tabs>,
      );

      const table = screen.getByRole('tab', { name: 'Таблица' });
      const matches = screen.getByRole('tab', { name: 'Матчи' });

      expect(screen.getByRole('tablist', { name: 'Лига' })).toHaveAttribute(
        'aria-orientation',
        orientation,
      );

      await user.tab();
      expect(table).toHaveFocus();

      await user.keyboard(next);
      await waitFor(() => {
        expect(matches).toHaveFocus();
        expect(matches).toHaveAttribute('aria-selected', 'true');
      });
      expect(screen.getByRole('tabpanel', { name: 'Матчи' })).toBeVisible();

      await user.keyboard(previous);
      await waitFor(() => {
        expect(table).toHaveFocus();
        expect(table).toHaveAttribute('aria-selected', 'true');
      });
      expect(screen.getByRole('tabpanel', { name: 'Таблица' })).toBeVisible();
    },
  );
});
