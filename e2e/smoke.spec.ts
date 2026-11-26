import { test, expect, type Page } from '@playwright/test';

// White to move after 1.e4 e5 2.Nf3 d6: Ba6?? drops the bishop to bxa6 / Nxa6.
// Checked with Node Stockfish + classifyMove at level full: flagged, blunder, hanging_piece, take_back.
const HANGING_FEN = 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';

// White to move: the black queen on d4 is en prise to the knight. Checked with Node Stockfish
// (depth 14, MultiPV 3): Nxd4 +789 cp, next best Nc3 +266, so Nxd4 is the top move by a wide margin.
const QUEEN_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/3qP3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
// White to move: Qxf7 is mate.
const MATE_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

const boardFen = (page: Page) => page.locator('.board').getAttribute('data-fen');
const boardArrows = (page: Page) => page.locator('.board').getAttribute('data-arrows');

/** Before the user moves nothing may name or mark a move: no "best" text, and only the blue arrow for their move. */
async function expectNoMoveGiven(page: Page) {
  await expect(page.locator('.coach').getByText(/\bbest\b/i)).toHaveCount(0);
  expect(await boardArrows(page)).toMatch(/^(blue)?$/);
}

/** True once the piece on `square` has finished animating into it (a ?fen= start animates from the initial position). */
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

test('plays a coached game, resumes after reload, fits a 360px screen', async ({ page }) => {
  await page.goto('./?seed=7');
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible();
  await expect(page.locator('.coach')).toContainText('Think about');
  await expectNoMoveGiven(page);

  await tapMove(page, 'e2', 'e4');
  await expect.poll(() => boardFen(page)).toContain(' b ');
  // The opponent (real Stockfish) replies within 10s.
  await expect.poll(() => boardFen(page), { timeout: 10_000 }).toContain(' w ');
  await expect(page.locator('.coach .what')).not.toBeEmpty({ timeout: 20_000 });
  await expect(page.locator('.coach')).toContainText('Think about');
  await expect(page.locator('.coach .last-move')).toContainText('Book move');
  await expect(page.getByText(/\bbest\b/i)).toHaveCount(0);
  await expectNoMoveGiven(page);

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

test('playing the top move gets the top-move feedback', async ({ page }) => {
  await page.goto(`./?seed=7&fen=${encodeURIComponent(QUEEN_FEN)}`);
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect.poll(() => boardFen(page)).toBe(QUEEN_FEN);
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible();
  await expect(page.locator('.coach')).toContainText('Think about');
  await expectNoMoveGiven(page);

  await tapMove(page, 'f3', 'd4');
  const last = page.locator('.coach .last-move');
  await expect(last).toContainText("✓ That's the top move. Do you see why it works?", { timeout: 20_000 });
  await expect(last.getByRole('button', { name: 'Yes, I got it' })).toBeVisible();
  await last.getByRole('button', { name: 'Explain it' }).click();
  await expect(last.locator('.section-body p').nth(1)).not.toBeEmpty();
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible({ timeout: 20_000 });
  await expectNoMoveGiven(page);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(360);
});

test('playing mate shows the game-over recap', async ({ page }) => {
  await page.goto(`./?seed=7&fen=${encodeURIComponent(MATE_FEN)}`);
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await expect.poll(() => boardFen(page)).toBe(MATE_FEN);
  await expect(page.getByRole('status').filter({ hasText: 'Your move.' })).toBeVisible();
  await tapMove(page, 'h5', 'f7');
  await expect(page.getByRole('region', { name: /game over/i })).toBeVisible({ timeout: 20_000 });
});
