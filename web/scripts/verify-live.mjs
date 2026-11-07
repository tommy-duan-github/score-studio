import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Read-only verification against live projects: node scripts/verify-live.mjs <projectId> [<projectId> ...]
const base = process.env.STUDIO_LIVE_URL ?? 'http://127.0.0.1:5175';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await fs.mkdir('test-results', { recursive: true });

try {
  await page.goto(base);
  await page.locator('.paper svg').first().waitFor({ timeout: 90000 });
  for (const id of process.argv.slice(2)) {
    const project = await (await page.request.get(`${base}/api/projects/${id}`)).json();
    const doc = await (await page.request.get(`${base}/api/projects/${id}/doc`)).json();
    await page.locator(`.project-item[data-project-id="${id}"] .project-select`).click();
    await page.locator(`.score-canvas[data-project-id="${id}"] .paper svg`).first().waitFor({ timeout: 90000 });
    await page.waitForFunction(title => document.querySelector('.project-title')?.value === title, project.title);
    await page.locator('.paper svg').first().waitFor({ timeout: 90000 });
    const note = page.locator(`g.note[id="n${doc.notes[0].id}"]`).first();
    await note.waitFor();
    await note.click();
    assert.equal(await page.locator('.count').innerText(), '1 selected');
    assert.equal(await page.locator('.score-canvas').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    const pieces = await page.locator(`g.note[id^="n${doc.notes[0].id}-t"]`).count();
    if (pieces) assert.equal(await page.locator(`g.note.selected[id^="n${doc.notes[0].id}-t"]`).count(), pieces);
    const continuation = page.locator('g.note[id*="-t"]').first();
    if (await continuation.count()) {
      const base = (await continuation.getAttribute('id')).split('-t')[0];
      await page.locator(`g.note[id="${base}"]`).first().click();
      const total = await page.locator(`g.note[id="${base}"], g.note[id^="${base}-t"]`).count();
      await page.waitForFunction(({ base, total }) => document.querySelectorAll(`g.note.selected[id="${base}"], g.note.selected[id^="${base}-t"]`).length === total, { base, total });
    }
    assert.equal(await page.getByRole('radio', { name: 'Original audio', exact: true }).count(), doc.meta.has_audio ? 1 : 0);
    await page.getByRole('tab', { name: 'Review', exact: false }).click();
    const unsupported = doc.review.flatMap(item => item.options).filter(option => option.supported === false).length;
    assert.equal(await page.locator('.review-options button:disabled').count(), unsupported);
    await page.getByRole('tab', { name: 'Note', exact: true }).click();
    if (doc.meta.has_audio) {
      const before = await page.locator('.transport-time').innerText();
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(before => document.querySelector('.transport-time')?.textContent !== before, before);
      assert.equal(await page.locator('.playhead').isVisible(), true);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      assert.equal(await page.locator('g.note.sounding').count(), 0);
    }
    await page.screenshot({ path: `test-results/live-${id}.png` });
    console.log(JSON.stringify({ id, pages: await page.locator('.paper').count(), engravedNotes: await page.locator('g.note').count(), unsupported, audio: doc.meta.has_audio }));
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
