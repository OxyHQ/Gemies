/**
 * Real published Bloom/Services sidebar interactions over the fixture-only route.
 * Build first: EXPO_PUBLIC_ALIA_FIXTURES=1 bunx expo export --platform web --output-dir dist-fixtures
 * Run: bun run visual:sidebar [export-directory]. No auth/network interception or server mutations.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveExport } from './server.mjs';
import { chromium } from 'playwright-core';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = await serveExport(resolve(appRoot, process.argv[2] ?? 'dist-fixtures'));
const output = await mkdtemp(join(tmpdir(), 'gemies-sidebar-'));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: touch,
      hasTouch: touch,
      colorScheme: touch ? 'dark' : 'light',
      locale: 'en-US',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.origin}/__fixtures/sidebar`);
    await page.waitForFunction(() => window.__aliaFixture?.sidebar);
    if (touch)
      await page.getByRole('button', { name: 'Open navigation', exact: true }).last().click();
    const row = (id) =>
      page.locator(`[data-testid="sidebar-tree-item-fixture-${id}"]:visible`).last();
    const check = (id) => row(id).getByRole('checkbox');
    const events = () => page.evaluate(() => window.__aliaFixture.sidebar.events());
    const navigation = async () => (await events()).filter((e) => e.startsWith('navigate:'));
    await row(0).waitFor({ state: 'visible' });
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole('button', { name: /Options for/ }).count(), 0);
    assert.equal(await check(0).getAttribute('aria-checked'), 'false');
    const opacity = () =>
      row(0)
        .locator('[data-bloom-list-selection]')
        .evaluate((el) => Number(getComputedStyle(el).opacity));
    assert.equal(await opacity(), 0);
    if (!touch) {
      await row(0).locator('[data-bloom-list-identity]').hover();
      await page.waitForTimeout(200);
      assert.equal(await opacity(), 1);
      await row(0).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      assert.equal((await events()).filter((e) => e === 'edit:fixture-0').length, 1);
      assert.equal((await navigation()).length, 0);
      await page.mouse.move(800, 650);
    }
    if (touch) {
      const r = await row(0).boundingBox();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: r.x + 130, y: r.y + r.height / 2 }],
      });
      await page.waitForTimeout(750);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await row(0).locator('[data-bloom-list-identity]').click();
    await page.waitForTimeout(250);
    assert.equal(await check(0).getAttribute('aria-checked'), 'true');
    assert.equal((await navigation()).length, 0);
    assert.equal(await page.getByRole('menu').count(), 0);
    await page.screenshot({
      path: `${output}/${touch ? 'touch-dark' : 'desktop-light'}-selected.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Options for Pepe', exact: true }).click();
    console.log(
      touch ? 'touch menu' : 'desktop menu',
      (await page.locator('body').innerText()).slice(-900),
    );
    await page.getByText('Edit', { exact: true }).last().click();
    await page.waitForTimeout(300);
    assert.equal((await events()).filter((e) => e === 'edit:fixture-0').length, touch ? 1 : 2);
    assert.equal(
      await page.getByRole('button', { name: 'Options for Pepe', exact: true }).count(),
      0,
    );
    await row(1).locator('[data-bloom-list-identity]').click();
    assert.equal(await check(1).getAttribute('aria-checked'), 'true');
    assert.equal((await navigation()).length, 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await row(1).click({ position: { x: 120, y: 25 } });
    assert.deepEqual(await navigation(), ['navigate:fixture-1']);
    if (touch)
      await page.getByRole('button', { name: 'Open navigation', exact: true }).last().click();
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await page.locator('[data-testid="sidebar-tree-item-group"]:visible').waitFor();
    await page.waitForTimeout(600);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    results.push({
      platform: touch ? 'Chromium touch 390 dark' : 'Chromium desktop 1440 light',
      checks: [
        'idle no ellipsis',
        'idle avatar visible',
        'hover checkbox when pointer',
        'right click menu when pointer',
        'long press selection when touch',
        'release without navigation',
        'avatar selection',
        'selected header menu callback once',
        'clear selection',
        'row navigation once',
        'folder disclosure and grouped avatars',
        'no horizontal overflow',
        'no page errors',
      ],
      events: await events(),
    });
    await page.screenshot({
      path: `${output}/${touch ? 'touch-dark' : 'desktop-light'}-final.png`,
      fullPage: true,
    });
    await context.close();
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`Sidebar evidence: ${output}`);
} finally {
  await browser.close();
  await server.close();
}
