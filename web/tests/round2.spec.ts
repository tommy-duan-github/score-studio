import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('inline project and part names, SVG labels and compatible instruments', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  const title = page.getByLabel('Project title', { exact: true });
  await expect(title).toHaveText('Winter Wind');
  await title.focus(); await page.keyboard.press('F2');
  await title.fill('Cancelled'); await title.press('Escape');
  await expect(title).toHaveText('Winter Wind');
  await title.dblclick(); await title.fill('Practice'); await title.press('Enter');
  await expect(title).toHaveText('Practice');
  await title.dblclick(); await title.fill('Practice II');
  await page.getByRole('button', { name: 'Export', exact: true }).focus();
  await expect(title).toHaveText('Practice II');
  await page.locator('[data-project-id="demo-multi"] .project-select').click();
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  const violin = page.locator('.paper-heading').first().getByLabel('Part name: Violin', { exact: true });
  await violin.dblclick(); await violin.fill('Violin I'); await violin.press('Enter');
  await expect(violin).toHaveCount(0);
  await expect(page.locator('.paper-heading').first().getByLabel('Part name: Violin I', { exact: true })).toBeVisible();
  await expect(page.locator('.render-status')).toHaveCount(0);
  const label = page.locator('.paper g.label').filter({ hasText: 'Violin I' }).first();
  await expect(label).toBeVisible(); await label.dblclick();
  const headingEditor = page.locator('.paper-heading input').first();
  await expect(headingEditor).toBeFocused(); await headingEditor.fill('Solo'); await headingEditor.press('Enter');
  await expect(page.locator('.render-status')).toHaveCount(0);
  const noteId = await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/lib/api.ts')!.name;
    const { api } = await import(path);
    const doc = await api.doc('demo-multi');
    return doc.notes.find((note: { part: string }) => note.part === 'P2').id;
  });
  await page.locator(`g.note[id="n${noteId}"]`).first().click();
  const picker = page.getByLabel('Instrument type', { exact: true });
  await expect(picker.locator('option')).not.toContainText(['Electric piano']);
  await picker.selectOption({ label: 'Viola' });
  await expect(page.locator('.paper-heading').first().getByLabel('Part name: Viola', { exact: true })).toBeVisible();
  const part = await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/lib/api.ts')!.name;
    const { api } = await import(path);
    return (await api.doc('demo-multi')).parts.find((part: { id: string }) => part.id === 'P2');
  });
  expect(part).toMatchObject({ program: 41, clef: 'C', kind: 'single' });
  await page.locator(`g.note[id="n${noteId}"]`).first().click();
  await page.keyboard.press('2');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Options for Violin and Piano', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Transcribe again…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Transcribe again', exact: true }).getByRole('button', { name: 'Piano', exact: true }).click();
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  await expect(page.locator('.paper-heading').first().getByLabel('Part name: Piano', { exact: true })).toBeVisible();
  await expect(page.locator('.paper-heading').first().getByLabel('Part name: Viola', { exact: true })).toHaveCount(0);
  await page.locator('g.note[id="n1"]').first().click();
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('settings, top-layer tips, GPU and persisted languages at desktop and phone sizes', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.getByLabel('Project title')).toHaveText('Winter Wind');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Performance', exact: true }).click();
  await page.getByRole('radio', { name: 'Eco', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Background', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Full', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Normal', exact: true })).toBeChecked();
  await expect(page.getByLabel('GPU utilization', { exact: true })).toHaveAttribute('value', '24');
  await page.getByRole('button', { name: 'About GPU', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toContainText('CUDA');
  expect(await page.getByRole('tooltip').evaluate(element => element.matches(':popover-open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['Dark', 'Light']) {
      await page.getByRole('radio', { name: theme, exact: true }).click();
      await page.getByRole('tab', { name: 'Performance', exact: true }).click();
      await expect(page.getByLabel('GPU memory', { exact: true })).toBeVisible();
      await expect.poll(() => page.locator('.app-settings').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/settings-en-${width}-${theme.toLowerCase()}.png` });
      await page.getByRole('tab', { name: 'General', exact: true }).click();
    }
  }
  await page.getByRole('radio', { name: '简体中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['深色', '浅色']) {
      await page.getByRole('radio', { name: theme, exact: true }).click();
      await expect.poll(() => page.locator('.app-settings').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.getByRole('tab', { name: '性能', exact: true }).click();
      await expect(page.getByLabel('显存', { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/settings-zh-${width}-${theme === '深色' ? 'dark' : 'light'}.png` });
      await page.getByRole('tab', { name: '常规', exact: true }).click();
    }
  }
  await page.getByRole('tab', { name: '关于', exact: true }).click();
  await expect(page.getByRole('link', { name: /tommy-duan-github\/score-studio/ })).toHaveAttribute('href', 'https://github.com/tommy-duan-github/score-studio');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'General', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/lib/api.ts')!.name;
    const { api } = await import(path); const performanceStatus = api.performance;
    api.performance = async () => {
      const status = await performanceStatus();
      return { ...status, gpu: { ...status.gpu, available: false, name: null, used_for: [] } };
    };
  });
  await page.getByRole('tab', { name: 'Performance', exact: true }).click();
  await page.getByRole('button', { name: 'About GPU', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toContainText('No CUDA GPU — transcription runs on the CPU');
  await expect(page.getByLabel('GPU utilization', { exact: true })).toHaveCount(0);
});

test('tips remain above mode dialogs, reading mode and phone drawers', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  const topLayerTip = async (text: string) => {
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText(text);
    expect(await tip.evaluate(element => element.matches(':popover-open'))).toBe(true);
    const box = (await tip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  };
  await page.getByRole('button', { name: 'About page layout', exact: true }).focus();
  await topLayerTip('Pages scrolls down'); await page.keyboard.press('Escape');
  await page.locator('input[type=file]').setInputFiles({ name: 'Test.mid', mimeType: 'audio/midi', buffer: Buffer.from('fixture') });
  await page.getByRole('button', { name: 'About transcription mode', exact: true }).focus();
  await topLayerTip('Transkun'); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'New transcription', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reading mode', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 844 });
  await page.getByRole('button', { name: 'Reading controls', exact: true }).click();
  await page.getByRole('button', { name: 'About reading speed', exact: true }).last().focus();
  await topLayerTip('preserving pitch'); await page.keyboard.press('Escape');
  await expect(page.locator('.reading-mode')).toBeVisible();
  await page.getByRole('button', { name: 'Exit reading mode', exact: true }).click();
  await page.getByRole('button', { name: 'Editor panel', exact: true }).click();
  await page.getByRole('button', { name: 'About note selection', exact: true }).focus();
  await topLayerTip('Shift-click'); await page.keyboard.press('Escape');
  await expect(page.locator('.inspector')).toBeInViewport();
});

test('Chinese navigator default and backend progress translations keep unknown details', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('/?mock=1');
  await expect(page.getByLabel('项目标题', { exact: true })).toHaveText('Winter Wind');
  const messages = await page.evaluate(async () => {
    const path = '/src/lib/i18n.ts'; const { t } = await import(path);
    return ['Transcribing audio to notes (Transkun)…', 'Reading rhythm, bars and hands (DuET) — section 3 of 7…', 'Waiting in queue…', 'Done in 171 s', 'Raw backend detail'].map(message => t(message));
  });
  expect(messages).toEqual(['正在将音频转录为音符（Transkun）…', '正在分析节奏、小节与左右手（DuET） — 第 3 / 7 段…', '排队等待中…', '已完成，用时 171 秒', 'Raw backend detail']);
  await context.close();
});

test('rendered WAV is stereo PCM with audible samples and export recovers from failure', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.locator('.paper svg').first()).toBeVisible({ timeout: 90000 });
  // Keep the test quick while exercising the real menu, sampler, Offline renderer and PCM encoder.
  await page.evaluate(async () => {
    // Reuse the app's exact module URL, including Vite's HMR version when present.
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/lib/api.ts')!.name;
    const { api } = await import(path);
    const midi = api.midi;
    api.midi = (doc: { notes: unknown[] }) => midi({ ...doc, notes: doc.notes.slice(0, 8) });
  });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Original audio', exact: false })).toHaveCount(0);
  const download = page.waitForEvent('download', { timeout: 90000 });
  await page.getByRole('menuitem', { name: 'Rendered audio', exact: false }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Winter Wind.wav');
  const bytes = await readFile((await file.path())!);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(22)).toBe(2);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.subarray(44).some(byte => byte !== 0)).toBe(true);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  await page.route('**/samples/salamander/**', route => route.abort());
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rendered audio', exact: false }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
});

test('original audio preserves the upload and extension', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.getByLabel('Project title')).toHaveText('Winter Wind');
  await page.locator('input[type=file]').setInputFiles({ name: 'Recording.flac', mimeType: 'audio/flac', buffer: Buffer.from('mock original recording') });
  await page.getByRole('dialog', { name: 'New transcription' }).getByRole('button', { name: 'Piano', exact: true }).click();
  await expect(page.getByLabel('Project title')).toHaveText('Recording');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const original = page.getByRole('menuitem', { name: 'Original audio', exact: false });
  await expect(original).toContainText('.flac');
  const download = page.waitForEvent('download'); await original.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Recording.flac');
  expect((await readFile((await file.path())!)).toString()).toBe('mock original recording');
});
