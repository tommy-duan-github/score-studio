import { expect, test, type Page } from '@playwright/test';

async function openScore(page: Page) {
  await page.goto('/?mock=1');
  await expect(page.getByLabel('Project title')).toHaveValue('Winter Wind');
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  await expect(page.locator('.render-status')).toHaveCount(0);
}

async function saved(page: Page, version: number) {
  await expect(page.locator('.save-state')).toHaveText(`Saved · v${version}`);
  await expect(page.locator('.render-status')).toHaveCount(0);
}

test('engraving, all selection modes, optics, themes and responsive fit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openScore(page);
  expect(await page.locator('.paper').count()).toBeGreaterThan(1);
  expect(await page.locator('g.note[id^="n"]').count()).toBeGreaterThan(1000);
  expect(await page.locator('.score-canvas').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const first = page.locator('g.note[id="n1"]').first();
  const second = page.locator('g.note[id="n2"]').first();
  await first.click();
  await expect(page.locator('.count')).toHaveText('1 selected');
  await expect(first).toHaveClass(/selected/);
  await second.click({ modifiers: ['Shift'] });
  await expect(page.locator('.count')).toHaveText('2 selected');
  await first.click({ modifiers: ['Control'] });
  expect(Number((await page.locator('.count').innerText()).split(' ')[0])).toBeGreaterThan(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.count')).toHaveText('0 selected');
  const box = await first.boundingBox();
  if (!box) throw new Error('Missing note geometry');
  await page.mouse.move(box.x - 3, box.y - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 3, box.y + box.height + 3, { steps: 6 });
  await page.mouse.up();
  await expect(first).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/studio-dark.png' });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'About keyboard shortcuts', exact: true }).focus();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('Space');
  const tipBox = await tip.boundingBox();
  expect(tipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(1000);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  await expect(page.locator('.inspector-tabs .lens-thumb')).toHaveCSS('backdrop-filter', /url/);
  await page.screenshot({ path: 'test-results/studio-light.png' });
  await page.setViewportSize({ width: 1100, height: 800 });
  // Pages keep a fixed size (zoom), so the score column may scroll sideways; the window itself must not.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.score-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/studio-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('note edits, keyboard history, retained selection and scroll', async ({ page }) => {
  await openScore(page);
  const first = page.locator('g.note[id="n1"]').first();
  await first.click();
  await page.keyboard.press('l');
  await saved(page, 2);
  await expect(page.locator('.note-details')).toContainText('Left / 1');
  await expect(first).toHaveClass(/selected/);
  await page.keyboard.press('4');
  await saved(page, 3);
  await expect(page.locator('.note-details')).toContainText('Left / 4');
  await page.keyboard.press('Control+z');
  await saved(page, 4);
  await expect(page.locator('.note-details')).toContainText('Left / 1');
  await page.keyboard.press('Control+Shift+z');
  await saved(page, 5);
  await expect(page.locator('.note-details')).toContainText('Left / 4');
  await page.getByRole('button', { name: '1/2', exact: true }).click();
  await saved(page, 6);
  await page.getByRole('checkbox', { name: 'Dotted duration' }).check();
  await saved(page, 7);
  await expect(page.locator('.note-details')).toContainText('3 quarters');
  await page.getByRole('switch', { name: 'Grace note', exact: true }).check();
  await saved(page, 8);
  await page.getByRole('radio', { name: '♭ Flat', exact: true }).click();
  await saved(page, 9);
  await first.click();
  await page.keyboard.press('ArrowUp');
  await saved(page, 10);
  await page.keyboard.press('Delete');
  await saved(page, 11);
  await expect(page.locator('.note-details')).toContainText('Deleted');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await saved(page, 12);
  await expect(page.locator('.note-details')).not.toContainText('Deleted');
  await page.getByRole('button', { name: 'Reset overrides', exact: true }).click();
  await saved(page, 13);
  await expect(page.locator('.note-details')).toContainText('Right / 1');
  await first.click();
  await page.locator('g.note[id="n2"]').first().click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await saved(page, 14);
  await expect(page.locator('.count')).toHaveText('2 selected');
  await page.locator('.score-canvas').evaluate(element => { element.scrollTop = 900; });
  const before = await page.locator('.score-canvas').evaluate(element => element.scrollTop);
  await page.getByRole('radio', { name: 'Right hand', exact: true }).click();
  await saved(page, 15);
  expect(Math.abs(await page.locator('.score-canvas').evaluate(element => element.scrollTop) - before)).toBeLessThanOrEqual(1);
});

test('review, settings, assistant setup, preview and apply', async ({ page }) => {
  await openScore(page);
  await page.getByRole('tab', { name: 'Review', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Tie the bass', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Keep F major', exact: true }).click();
  await saved(page, 2);
  await expect(page.locator('.review-card.resolved')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/studio-review.png' });
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: '3', exact: true })).toBeChecked();
  await page.getByRole('switch', { name: 'Automatic spelling' }).uncheck();
  await saved(page, 3);
  await page.getByRole('radio', { name: '4', exact: true }).click();
  await saved(page, 4);
  await page.screenshot({ path: 'test-results/studio-settings.png' });
  await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
  await page.getByLabel('API key', { exact: true }).fill('mock-key');
  await page.getByRole('button', { name: 'Connect assistant' }).click();
  await page.getByLabel('Message to assistant').fill('Simplify the opening left hand');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.proposal')).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.preview-note').first()).toBeAttached();
  await page.screenshot({ path: 'test-results/studio-assistant.png' });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await saved(page, 5);
  await expect(page.locator('.preview-note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Applied', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Note', exact: true }).click();
  await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
  await expect(page.locator('.proposal')).toBeVisible();
});

test('upload polling, rename, delete, exports and print-only score', async ({ page }) => {
  await openScore(page);
  await page.locator('input[type=file]').setInputFiles({ name: 'Practice.mid', mimeType: 'audio/midi', buffer: Buffer.from('fixture') });
  await expect(page.getByLabel('Project title')).toHaveValue('Practice');
  await expect(page.locator('.project-item.active progress')).toBeAttached();
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.project-item.active .status-chip')).toHaveText('ready');
  await page.getByRole('button', { name: 'Options for Practice', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('New project name').fill('Practice score');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Project title')).toHaveValue('Practice score');
  for (const format of ['MusicXML', 'MIDI']) {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: format, exact: false }).click();
    expect((await download).suggestedFilename()).toContain(format === 'MIDI' ? '.mid' : '.musicxml');
  }
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.inspector')).toBeHidden();
  await expect(page.locator('.paper').first()).toBeVisible();
  await page.pdf({ path: 'test-results/score.pdf', preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Options for Practice score', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.project-item')).toHaveCount(2);
});

test('title block, reading mode, drawers and one PDF sheet per page', async ({ page }) => {
  await openScore(page);
  // Title block: default title is the project name; composer edits are engraved on page 1.
  await expect(page.locator('.paper').first().locator('.pgHead')).toContainText('Winter Wind');
  await page.getByRole('button', { name: 'Title', exact: true }).click();
  await page.getByRole('textbox', { name: 'Composer', exact: true }).fill('A. Composer');
  await page.getByRole('textbox', { name: 'Composer', exact: true }).press('Enter');
  await saved(page, 2);
  await expect(page.locator('.paper').first().locator('.pgHead')).toContainText('A. Composer');
  // Header text is inserted literally: replacement tokens and markup must not break engraving.
  const notes = await page.locator('.app-shell g.note').count();
  await page.getByRole('textbox', { name: 'Subtitle', exact: true }).fill('Op. $1 $& <b>&amp;');
  await page.getByRole('textbox', { name: 'Subtitle', exact: true }).press('Enter');
  await saved(page, 3);
  await expect(page.locator('.paper').first().locator('.pgHead')).toContainText('Op. $1 $& <b>&amp;');
  expect(await page.locator('.app-shell g.note').count()).toBe(notes);
  await page.keyboard.press('Escape');

  // Reading mode: full-screen pages, compact bar, transposed notation, Esc exits and resets transpose.
  await page.getByRole('button', { name: 'Reading mode', exact: true }).click();
  const reading = page.locator('.reading-mode');
  await expect(reading.locator('.paper svg').first()).toBeVisible({ timeout: 30000 });
  const flat = await reading.locator('.keySig use').first().getAttribute('xlink:href');
  await reading.getByRole('button', { name: 'Transpose up one semitone' }).first().click();
  await reading.getByRole('button', { name: 'Transpose up one semitone' }).first().click();
  await expect.poll(() => reading.locator('.keySig use').first().getAttribute('xlink:href')).not.toBe(flat);
  await reading.getByRole('button', { name: 'Exit reading mode', exact: true }).click();
  await expect(reading).toHaveCount(0);
  await page.getByRole('button', { name: 'Reading mode', exact: true }).click();
  await expect(page.locator('.reading-transpose-value').first()).toHaveText('0');
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(() => page.locator('.reading-transport').evaluate(bar => bar.scrollWidth <= bar.clientWidth
    && bar.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Reading controls', exact: true }).click();
  await page.getByRole('button', { name: 'Exit reading mode', exact: true }).click();
  await expect(page.locator('.reading-mode')).toHaveCount(0);

  // Phone: library and inspector are drawers.
  await expect(page.locator('.sidebar')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Editor panel', exact: true }).click();
  await expect(page.locator('.inspector')).toBeInViewport();
  await page.keyboard.press('Escape');

  // Print: every score page is exactly one A4 sheet (no blank even pages).
  await page.setViewportSize({ width: 1440, height: 1000 });
  const papers = await page.locator('.app-shell .paper').count();
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  // Chrome nests the page tree in nodes of 8 pages; the root node has the largest /Count.
  const counts = [...pdf.toString('latin1').matchAll(/\/Count (\d+)/g)].map(match => Number(match[1]));
  expect(Math.max(...counts)).toBe(papers);
});
