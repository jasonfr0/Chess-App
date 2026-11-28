import { test, expect, type Page } from '@playwright/test';
import { Chess } from 'chess.js';

// Same position as smoke.spec.ts: White to move, Ba6?? (f1-a6) drops the bishop.
const HANGING_FEN = 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';

const TEACH_LABEL = "Teaching game · doesn't count toward your level";

const boardFen = (page: Page) => page.locator('.board').getAttribute('data-fen');
const boardArrows = (page: Page) => page.locator('.board').getAttribute('data-arrows');

/** True once the piece on `square` has finished animating into it. */
async function settled(page: Page, square: string): Promise<boolean> {
  const sq = await page.locator(`.board [data-square="${square}"]`).boundingBox();
  const piece = await page.locator(`.board [data-square="${square}"] [data-piece]`).first().boundingBox();
  return !!sq && !!piece && Math.abs(sq.x - piece.x) < 2 && Math.abs(sq.y - piece.y) < 2;
}

async function tapMove(page: Page, from: string, to: string) {
  await expect.poll(() => settled(page, from)).toBe(true);
  await page.locator(`.board [data-square="${from}"]`).click();
  await page.locator(`.board [data-square="${to}"]`).click();
}

async function startTeaching(page: Page) {
  await page.getByRole('radio', { name: 'Play to learn' }).click();
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect(page.getByText(TEACH_LABEL)).toBeVisible();
}

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

test('plays a teaching turn', async ({ page }) => {
  await page.goto('./?seed=7');
  await startTeaching(page);

  const coach = page.locator('.teach-panel');
  await expect(coach.getByRole('heading', { name: 'Good options' })).toBeVisible({ timeout: 20_000 });
  const first = coach.locator('ol.options li').first();
  await expect(first).toBeVisible();
  expect(await boardArrows(page)).toContain('green');

  // Convert the first option's SAN to squares with the board's current position.
  const san = (await first.locator('strong').innerText()).trim();
  const fen = (await boardFen(page))!;
  const move = new Chess(fen).move(san);
  const optionsBefore = await coach.locator('ol.options').innerText();

  await tapMove(page, move.from, move.to);
  await expect(coach.getByRole('heading', { name: 'Your last move' })).toBeVisible({ timeout: 20_000 });
  await expect(coach.locator('.last-move')).toContainText(/✓ (Good|Book) move\./);

  // The opponent replies, then a new options list for the new position appears.
  await expect.poll(() => boardFen(page), { timeout: 10_000 }).not.toBe(fen);
  await expect.poll(async () => (await boardFen(page))?.split(' ')[1], { timeout: 20_000 }).toBe('w');
  await expect(coach.getByRole('heading', { name: 'Good options' })).toBeVisible({ timeout: 20_000 });
  await expect(coach.locator('ol.options li').first()).toBeVisible();
  await expect.poll(() => coach.locator('ol.options').innerText()).not.toBe(optionsBefore);

  await page.reload();
  await expect(page.getByText(TEACH_LABEL)).toBeVisible();
});

test('a teaching mistake shows the better move at once', async ({ page }) => {
  await page.goto(`./?seed=7&fen=${encodeURIComponent(HANGING_FEN)}`);
  await startTeaching(page);
  await expect.poll(() => boardFen(page)).toBe(HANGING_FEN);

  await tapMove(page, 'f1', 'a6');
  const card = page.getByRole('alertdialog');
  await expect(card).toBeVisible({ timeout: 20_000 });
  const better = card.locator('.section', { has: page.getByRole('heading', { name: 'Better move' }) }).locator('p');
  await expect(better).not.toBeEmpty();
  await expect(card.getByRole('button', { name: 'Show me' })).toHaveCount(0);

  await card.getByRole('button', { name: 'Take it back' }).click();
  await expect(card).toBeHidden();
  expect(await boardFen(page)).toBe(HANGING_FEN);
  await expect(page.locator('.teach-panel').getByRole('heading', { name: 'Good options' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.teach-panel ol.options li').first()).toBeVisible();
});

test('fits a 360px screen during a teaching turn', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('./?seed=7');
  await startTeaching(page);
  await expect(page.locator('.teach-panel').getByRole('heading', { name: 'Good options' })).toBeVisible({ timeout: 20_000 });
  await noHorizontalScroll(page);
});
