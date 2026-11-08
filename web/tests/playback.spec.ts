import { expect, test } from '@playwright/test';

function sample() {
  // A local PCM sample exercises Tone's real decoding, sampler and MIDI
  // scheduling without making the test depend on the public sample host.
  const frames = 22050;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(88200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index += 1) {
    wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 44100) * 1000), 44 + index * 2);
  }
  return wav;
}

test('score sampler playback, sounding notes, keyboard pause and seek', async ({ page }) => {
  let samples = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/samples/salamander/**', async route => {
    samples += 1;
    await route.fulfill({ body: sample(), contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/?mock=1');
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('g.note.sounding').count()).toBeGreaterThan(0);
  expect(samples).toBeGreaterThan(1);
  await expect(page.locator('.playhead')).toBeVisible();
  await expect(page.locator('.transport-time')).not.toHaveText('0:00 / 3:08');
  await page.locator('.score-canvas').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.locator('g.note.sounding')).toHaveCount(0);
  await page.locator('g.note[id="n1"]').first().click();
  await expect(page.locator('.transport-time')).toHaveText('0:00 / 3:08');
  expect(errors).toEqual([]);
});

test('sample failures produce a recoverable error toast', async ({ page }) => {
  await page.route('**/samples/salamander/**', route => route.abort());
  await page.goto('/?mock=1');
  await expect(page.getByLabel('Project title')).toHaveText('Winter Wind');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load piano samples');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('non-Chromium optics fallback and system theme tracking', async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 Firefox/130.0',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/?mock=1');
  await expect(page.getByLabel('Project title')).toHaveText('Winter Wind');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.inspector-tabs')).toHaveClass(/lens-fallback/);
  await expect(page.locator('.blob').first()).toHaveCSS('animation-name', 'none');
  // Wait for the initial WASM engraving before checking the media-query change event.
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  await expect(page.locator('.render-status')).toHaveCount(0);
  await page.bringToFront();
  await page.emulateMedia({ colorScheme: 'light' });
  // Chromium dispatches matchMedia changes during rendering; flush that turn before asserting.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await context.close();
});
