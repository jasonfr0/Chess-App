import { test, expect, type Page } from '@playwright/test';

// White to move after 1.e4 e5 2.Nf3 d6: Ba6?? drops the bishop to bxa6 / Nxa6.
// Checked with Node Stockfish + classifyMove at level full: flagged, blunder, hanging_piece, take_back.
const HANGING_FEN = 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';

const boardFen = (page: Page) => page.locator('.board').getAttribute('data-fen');

async function tapMove(page: Page, from: string, to: string) {
  await page.locator(`.board [data-square="${from}"]`).click();
  await page.locator(`.board [data-square="${to}"]`).click();
}

test('plays a coached game, resumes after reload, fits a 360px screen', async ({ page }) => {
  await page.goto('./?seed=7');
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible();

  await tapMove(page, 'e2', 'e4');
  await expect.poll(() => boardFen(page)).toContain(' b ');
  // The opponent (real Stockfish) replies within 10s.
  await expect.poll(() => boardFen(page), { timeout: 10_000 }).toContain(' w ');
  await expect(page.locator('.coach .what')).not.toBeEmpty({ timeout: 20_000 });

  const moves = await page.getByLabel('Moves').innerText();
  expect(moves.trim()).toMatch(/^1\.\s*e4 \S+$/); // our move and the opponent's reply
  const fen = await boardFen(page);

  await page.reload();
  await expect(page.getByLabel('Moves')).toHaveText(moves);
  expect(await boardFen(page)).toBe(fen);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(360);
});

test('stops on a hanging move and takes it back', async ({ page }) => {
  await page.goto(`./?seed=7&fen=${encodeURIComponent(HANGING_FEN)}`);
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect.poll(() => boardFen(page)).toBe(HANGING_FEN);

  await tapMove(page, 'f1', 'a6');
  const card = page.getByRole('alertdialog');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Better move');
  await expect(card).toContainText('What it costs');
  await expect(card).toContainText('The lesson');

  await card.getByRole('button', { name: 'Take it back' }).click();
  await expect(card).toBeHidden();
  expect(await boardFen(page)).toBe(HANGING_FEN);
  await expect(page.getByRole('button', { name: 'Hint 1' })).toBeEnabled();
  await page.getByRole('button', { name: 'Hint 1' }).click();
  await expect(page.locator('.hints li')).toHaveCount(1);

  // The retry is judged by the same (still running) engine and the opponent replies.
  // Wait for the take-back animation to put the bishop home before tapping it.
  await expect(page.locator('.board [data-square="f1"] [data-piece="wB"]')).toBeVisible();
  await tapMove(page, 'f1', 'e2');
  await expect(page.getByLabel('Moves')).toContainText('Be2');
  await expect(page.getByLabel('Moves')).toHaveText(/Be2 \S+/, { timeout: 20_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(360);
});
