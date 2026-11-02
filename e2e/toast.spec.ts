import { expect, test } from '@playwright/test';

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} toast positioning`, () => {
    test.use({ colorScheme });

    for (const width of [360, 768, 1023]) {
      test(`keeps the bottom navigation accessible at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await expect(page.locator('html')).toHaveClass(
          new RegExp(`\\b${colorScheme}\\b`),
        );

        const navigation = page.getByRole('navigation', { name: 'Разделы' });
        await expect(navigation).toBeVisible();
        await page.getByRole('button', { name: /Поиск команд и лиг/ }).click();

        const toast = page.getByRole('listitem').filter({
          hasText: 'Поиск команд и лиг появится на этапе 4',
        });
        await expect(toast).toBeVisible();
        await expect(toast).toBeInViewport();

        // Poll geometry while Sonner animates the toast into position.
        await expect
          .poll(async () => {
            const toastBox = await toast.boundingBox();
            const navigationBox = await navigation.boundingBox();
            if (!toastBox || !navigationBox) return Number.NEGATIVE_INFINITY;
            return navigationBox.y - (toastBox.y + toastBox.height);
          })
          .toBeGreaterThanOrEqual(12);

        await navigation.getByRole('link', { name: 'Календарь' }).click();
        await expect(page).toHaveURL('/calendar');
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          'Календарь',
        );
      });
    }
  });
}
