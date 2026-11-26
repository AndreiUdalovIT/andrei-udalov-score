import { expect, test } from '@playwright/test';

test('sections navigate, highlight the current route and support browser history', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Udalov Score');

  const navigation = page.getByRole('navigation', { name: 'Разделы' });
  const leagues = navigation.getByRole('link', { name: 'Лиги', exact: true });
  await leagues.click();
  await expect(page).toHaveURL('/leagues/pl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('АПЛ');
  await expect(leagues).toHaveAttribute('aria-current', 'page');

  const calendar = navigation.getByRole('link', { name: 'Календарь', exact: true });
  await calendar.click();
  await expect(page).toHaveURL('/calendar');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Календарь');
  await expect(calendar).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page).toHaveURL('/leagues/pl');
  await expect(leagues).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
});

test('a direct leagues link redirects to the default league', async ({ page }) => {
  await page.goto('/leagues');
  await expect(page).toHaveURL('/leagues/pl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('АПЛ');
});

test('an unknown URL returns 404 and offers a way home', async ({ page }) => {
  const response = await page.goto('/this-page-does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Страница не найдена',
  );
  await page.getByRole('link', { name: 'На главную', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Udalov Score');
});

test('the skip link transfers keyboard focus to the main content', async ({
  page,
  browserName,
}) => {
  await page.goto('/');
  const skipLink = page.getByRole('link', { name: 'Перейти к содержимому' });
  if (browserName === 'webkit') {
    // Native tab-to-links preferences vary by OS (Windows skips links even with Alt).
    // Test activation here; Chromium and Firefox also verify the first Tab stop.
    await skipLink.focus();
  } else {
    await page.keyboard.press('Tab');
  }
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});

test('the compact desktop menu opens a section', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Сравнение', exact: true }).click();
  await expect(page).toHaveURL('/compare');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сравнение');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('search explains that the feature is still in development', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Поиск команд и лиг/ }).click();
  await expect(
    page.getByText('Поиск команд и лиг появится на этапе 4', { exact: true }),
  ).toBeVisible();
});

for (const width of [360, 768, 1024, 1100, 1440]) {
  test(`the shell fits ${width}px and exposes the appropriate navigation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Профиль');
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('radio', { name: 'Системная' })).toBeChecked();

    const navigation = page.getByRole('navigation', { name: 'Разделы' });
    if (width < 1024) {
      await expect(navigation.getByRole('link')).toHaveCount(5);
      await expect(navigation.getByRole('link', { name: 'Войти' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(navigation).toBeInViewport();
    } else if (width < 1100) {
      await expect(
        page.getByRole('button', { name: 'Меню', exact: true }),
      ).toBeVisible();
      await expect(navigation).toHaveCount(0);
    } else {
      await expect(
        navigation.getByRole('link', { name: 'Сравнение' }),
      ).toBeVisible();
    }

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}
