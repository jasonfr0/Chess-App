import { test, expect } from '@playwright/test';

const boardFen = (page: import('@playwright/test').Page) => page.locator('.board').getAttribute('data-fen');

test('works offline after the service worker has installed', async ({ page, context }) => {
  await page.goto('./?seed=7');
  // Wait for the service worker to control the page (precache complete), reloading once if needed.
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();

  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible();
  await expect(page.locator('.board')).toBeVisible();

  // 1.a3 is not the top move (Node Stockfish: about 38 cp worse than d4, outside its top three) and
  // not a mistake, so the coach explains the stronger option, which Claude would upgrade if reachable.
  await page.locator('.board [data-square="a2"]').click();
  await page.locator('.board [data-square="a3"]').click();
  await expect.poll(() => boardFen(page)).toContain(' b ');
  await expect.poll(() => boardFen(page), { timeout: 10_000 }).toContain(' w ');

  await expect(page.locator('.coach .last-move')).toContainText('A stronger option was', { timeout: 20_000 });
  await expect(page.locator('.coach .offline')).toBeVisible();
  // The user's turn again: the stronger move's green arrow is gone.
  await expect.poll(() => page.locator('.board').getAttribute('data-arrows')).toMatch(/^(blue)?$/);
});
