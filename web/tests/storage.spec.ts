import { expect, test, type Page } from '@playwright/test';

async function storage(page: Page, scenario = '') {
  await page.goto(`/?mock=1${scenario ? `&mockModels=${scenario}` : ''}`);
  await expect(page.getByLabel('Project title', { exact: true })).toHaveText('Winter Wind');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page.locator('.storage-model')).toHaveCount(7);
}

test('storage usage, model states, download polling and removal confirmation', async ({ page }) => {
  await storage(page, 'states');
  await expect(page.locator('.settings-nav').getByRole('tab')).toHaveText(['General', 'Performance', 'Storage', 'About']);
  await expect(page.getByRole('meter', { name: 'Projects disk usage' })).toHaveAttribute('aria-valuenow', String(50 * 1024 ** 2));
  await expect(page.locator('.usage-legend li')).toHaveText([/^Projects/, /^Models/, /^App/, /^Other/, /^Free/]);
  await expect(page.locator('.storage-free')).toContainText('free of 256 GB');
  await expect(page.locator('.storage-path')).toContainText('ScoreStudio');
  const duet = page.locator('[data-model-key="duet"]');
  const transkun = page.locator('[data-model-key="transkun"]');
  const optional = page.locator('[data-model-key="moe-nops"]');
  const missing = page.locator('[data-model-key="yptf-multi-ps"]');
  await expect(duet).toContainText('Installed');
  await expect(duet.getByRole('button')).toHaveCount(0);
  await expect(transkun).toContainText('Built in');
  await expect(transkun.getByRole('button')).toHaveCount(0);
  await expect(missing).toContainText('Not downloaded');
  await expect(page.locator('[data-model-key="moe-ps"]')).toContainText('Download failed.');
  await missing.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(missing).toContainText(/Downloading \d+%/);
  await expect(missing).toContainText('Installed', { timeout: 10000 });
  await optional.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove model?', exact: true });
  await expect(confirm).toContainText('You can download it again later.');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(optional).toContainText('Installed');
  await optional.getByRole('button', { name: 'Remove', exact: true }).click();
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(optional).toContainText('Not downloaded');
  await page.getByRole('button', { name: 'Download all missing', exact: true }).click();
  await expect(optional).toContainText(/Queued|Downloading/);
  await expect(page.locator('.storage-model').filter({ hasText: 'Not downloaded' })).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator('.storage-model').filter({ hasText: 'Installed' })).toHaveCount(6, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Download all missing', exact: true })).toHaveCount(0);
});

test('delete selected and clear all confirm counts and refresh active project and library', async ({ page }) => {
  await storage(page);
  await page.getByRole('checkbox', { name: 'Select Winter Wind', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Select all', exact: true })).toHaveJSProperty('indeterminate', true);
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
  const first = page.getByRole('dialog', { name: 'Delete 1 project?', exact: true });
  await expect(first).toContainText('This cannot be undone.');
  await first.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.storage-project')).toHaveCount(3);
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await first.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('.storage-project')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.getByLabel('Project title', { exact: true })).toHaveText('Winter Wind (MIDI)');
  await expect(page.locator('.project-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  await expect(page.locator('.storage-project input:checked')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear all projects', exact: true }).click();
  const clear = page.getByRole('dialog', { name: 'Delete 2 projects?', exact: true });
  await expect(clear).toContainText('Delete 2 projects and their editing history? This cannot be undone.');
  await clear.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.storage-project')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear all projects', exact: true }).click();
  await clear.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('.storage-project')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear all projects', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.project-item')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No project selected' })).toBeVisible();
});

test('first-run required and recommended selection, progress and auto-close', async ({ page }) => {
  await page.goto('/?mock=1&mockModels=missing');
  const modal = page.getByRole('dialog', { name: 'Download models', exact: true });
  await expect(modal).toBeVisible();
  const required = modal.getByRole('checkbox', { name: /DuET/ });
  const recommended = modal.getByRole('checkbox', { name: /YourMT3/ });
  await expect(required).toBeChecked(); await expect(required).toBeDisabled();
  await expect(recommended).toBeChecked();
  await expect(modal.locator('.setup-total')).toContainText('1.9 GB');
  await recommended.uncheck();
  await expect(modal.locator('.setup-total')).toContainText('716.8 MB');
  await modal.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(modal.getByRole('progressbar', { name: 'Overall progress', exact: true })).toBeVisible();
  await expect(modal).toContainText(/Downloading \d+%/);
  await expect(modal.getByRole('status')).toHaveText('Models ready', { timeout: 10000 });
  await expect(modal).not.toBeVisible();
  await expect(page.locator('.models-warning')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page.locator('[data-model-key="yptf-multi-ps"]')).toContainText('Not downloaded');
});

test('first-run Later warns, rejected uploads show server detail, Storage resolves missing models', async ({ page }) => {
  await page.goto('/?mock=1&mockModels=missing');
  const modal = page.getByRole('dialog', { name: 'Download models', exact: true });
  await modal.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Models missing — Settings › Storage', exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'Test.mid', mimeType: 'audio/midi', buffer: Buffer.from('fixture') });
  await page.getByRole('dialog', { name: 'New transcription', exact: true }).getByRole('button', { name: 'Piano', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Required models are missing. Download models in Settings › Storage.');
  await page.locator('.models-warning').click();
  await expect(page.getByRole('tab', { name: 'Storage', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-model-key="duet"]').getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('[data-model-key="duet"]')).toContainText('Installed', { timeout: 10000 });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.models-warning')).toHaveCount(0);
});

test('offline download errors offer Retry and complete all selected models', async ({ page }) => {
  await page.goto('/?mock=1&mockModels=offline');
  const modal = page.getByRole('dialog', { name: 'Download models', exact: true });
  await modal.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(modal.getByRole('alert').first()).toHaveText('Download failed. Check your connection and retry.');
  await modal.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(modal.getByRole('status')).toHaveText('Models ready', { timeout: 10000 });
  await expect(modal).not.toBeVisible();
});

test('Later during download keeps polling in the background', async ({ page }) => {
  await page.goto('/?mock=1&mockModels=missing');
  const modal = page.getByRole('dialog', { name: 'Download models', exact: true });
  await modal.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(modal.getByRole('progressbar', { name: 'Overall progress', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.locator('.models-warning')).toHaveCount(0, { timeout: 10000 });
  await expect(modal).toHaveCount(0);
});

test('Docker built-in models have no actions and app size can be calculating', async ({ page }) => {
  await storage(page, 'docker');
  await expect(page.locator('.storage-model .model-state-label')).toHaveText(Array(7).fill('Built in'));
  await expect(page.locator('.storage-model button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download all missing', exact: true })).toHaveCount(0);
  await expect(page.locator('.storage-path')).toHaveText('/data/score-studio');
  await storage(page, 'calculating');
  await expect(page.locator('.usage-legend')).toContainText('Calculating…');
  await expect(page.getByRole('meter', { name: 'App disk usage', exact: true })).toHaveCount(0);
  await expect(page.locator('.usage-legend')).toContainText('819.2 MB', { timeout: 6000 });
  await expect(page.getByRole('meter', { name: 'App disk usage', exact: true })).toHaveAttribute('aria-valuenow', String(Math.round(0.8 * 1024 ** 3)));
});

test('late model reads cannot overwrite a download and rejected requests can retry', async ({ page }) => {
  await storage(page);
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/lib/api.ts')!.name;
    const { api } = await import(path);
    const read = api.models;
    let slow = true;
    api.models = async () => {
      const snapshot = await read();
      if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 1500)); }
      return snapshot;
    };
    const download = api.downloadModels;
    let reject = true;
    api.downloadModels = async (keys: string[]) => {
      if (reject) { reject = false; throw new Error('Connection unavailable'); }
      return download(keys);
    };
  });
  const row = page.locator('[data-model-key="yptf-multi-ps"]');
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.storage-error')).toContainText('Connection unavailable');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByRole('tab', { name: 'Storage', exact: true }).click();
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(row).toContainText('Installed', { timeout: 10000 });
  await expect(page.locator('.storage-error')).toHaveCount(0);
});

test('Storage and first-run fit both languages and themes at desktop and phone sizes', async ({ page }) => {
  for (const lang of ['en', 'zh-CN']) {
    await page.addInitScript(language => localStorage.setItem('score-studio:lang', language), lang);
    for (const width of [1440, 375]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(value => localStorage.setItem('score-theme', value), theme);
        await page.goto('/?mock=1&mockModels=missing');
        const modal = page.locator('.model-download');
        await expect(modal).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(modal.locator('.setup-model')).toHaveCount(2);
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await expect(modal).toContainText(lang === 'en' ? 'Recommended' : '推荐');
        await expect.poll(() => modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: `test-results/models-${lang}-${width}-${theme}.png` });
        await modal.getByRole('button', { name: lang === 'en' ? 'Later' : '稍后', exact: true }).click();
        if (width === 375) await page.getByRole('button', { name: lang === 'en' ? 'Projects' : '项目', exact: true }).click();
        await page.locator('.models-warning').click();
        await expect(page.locator('.storage-model')).toHaveCount(7);
        await expect(page.locator('.storage-panel')).toContainText(lang === 'en' ? 'Not downloaded' : '未下载');
        await expect.poll(() => page.locator('.app-settings').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect.poll(() => page.locator('.settings-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `test-results/storage-${lang}-${width}-${theme}.png` });
        await page.locator('.storage-project-actions').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/storage-projects-${lang}-${width}-${theme}.png` });
      }
    }
  }
});
