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

  // The user's turn again: the "stronger option" feedback folds away so it names no move during
  // this decision, and the stronger move's green arrow is gone.
  const head = page.locator('.coach .last-move').getByRole('button', { name: /Your last move/ });
  await expect(head).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 });
  await expect(page.locator('.coach .last-move')).not.toContainText('A stronger option was');
  await expect(page.locator('.coach .offline')).toBeVisible();
  await expect.poll(() => page.locator('.board').getAttribute('data-arrows')).toMatch(/^(blue)?$/);
  // Re-expanding shows it again (a move it names then counts as helped), still without the arrow.
  await head.click();
  await expect(page.locator('.coach .last-move')).toContainText('A stronger option was');
  await expect.poll(() => page.locator('.board').getAttribute('data-arrows')).toMatch(/^(blue)?$/);
});
