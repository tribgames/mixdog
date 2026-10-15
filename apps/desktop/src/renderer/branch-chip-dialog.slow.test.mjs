import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Native focus order and form submission require Chromium: jsdom's selector
// engine can return grouped selectors in selector order rather than DOM order.
test('branch name popup keeps keyboard focus and never submits the chat composer', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BranchChip } from './BranchChip';
        import { initUiLanguage, setUiLanguagePreference } from './i18n';
        window.branchCalls = [];
        window.composerSubmits = 0;
        const workspace = {
          projectPath: '/p', repoCommonDir: '/p/.git', cwd: '/p',
          worktreeId: null, branch: 'main', baseCommit: null,
          mergeTarget: 'main', revision: 3, transition: { state: 'idle', txId: null },
        };
        window.prompt = () => { throw new Error('Native prompt must not be used'); };
        window.mixdogDesktop = {
          rendererDiagnostic() {},
          async invokeCapability(request) {
            if (request.capability === 'getBranchMenu') {
              return { value: { workspace, branches: [], occupancy: [], retainedWorktree: null }, snapshot: null };
            }
            if (request.capability === 'selectBranch') {
              window.branchCalls.push(request);
              if (window.failNextBranch) {
                window.failNextBranch = false;
                throw new Error('Branch creation failed');
              }
              workspace.branch = request.args[0].branch;
              workspace.revision++;
              return { value: { workspace, revision: workspace.revision }, snapshot: null };
            }
            throw new Error('Unexpected capability: ' + request.capability);
          },
        };
        setUiLanguagePreference('en');
        initUiLanguage().then(() => {
          createRoot(document.getElementById('root')).render(
            <div className="pane-cell">
              <form onSubmit={event => { event.preventDefault(); window.composerSubmits++; }}>
                <BranchChip sessionId="s1" projectPath="/p" onOpenSession={() => {}} />
              </form>
            </div>
          );
        });
      `,
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = '.branch-name-dialog input';
  const submit = '.branch-name-dialog button[type="submit"]';
  const openDialog = async () => {
    await page.waitForSelector('.branch-chip-trigger', { timeout: 5000 }).catch(error => {
      assert.deepEqual(pageErrors, [], 'the fixture must render without errors');
      throw error;
    });
    await page.click('.branch-chip-trigger');
    await page.waitForSelector('.branch-menu [data-kind="create"]');
    await page.click('.branch-menu [data-kind="create"]');
    await page.waitForSelector(input);
    assert.equal(await page.$eval(input, node => document.activeElement === node), true);
  };
  await openDialog();
  assert.equal(await page.$('.branch-menu'), null);
  assert.equal(await page.$eval('.branch-name-dialog', node => node.parentElement.className), 'pane-dialog-layer');
  await page.keyboard.type('feat/popup');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  assert.equal(await page.$eval(submit, node => document.activeElement === node), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.$eval(input, node => document.activeElement === node), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.branch-name-dialog', { hidden: true });
  assert.equal(await page.$eval('.branch-chip-trigger', node => document.activeElement === node), true);
  assert.deepEqual(await page.evaluate(() => window.branchCalls), []);

  await openDialog();
  await page.keyboard.type('feat/popup');
  await page.evaluate(() => { window.failNextBranch = true; });
  await page.click(submit);
  await page.waitForSelector('.branch-name-dialog [role="alert"]');
  assert.match(await page.$eval('.branch-name-dialog [role="alert"]', node => node.textContent), /Branch creation failed/);
  assert.equal(await page.$eval(input, node => document.activeElement === node), true);
  assert.equal(await page.$eval(input, node => node.value), 'feat/popup');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.branch-name-dialog', { hidden: true });
  assert.deepEqual(await page.evaluate(() => window.branchCalls), [
    { capability: 'selectBranch', args: [{ branch: 'feat/popup', create: true, expectedRevision: 3 }], sessionId: 's1' },
    { capability: 'selectBranch', args: [{ branch: 'feat/popup', create: true, expectedRevision: 3 }], sessionId: 's1' },
  ]);
  assert.equal(await page.evaluate(() => window.composerSubmits), 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(await page.$eval('.branch-chip-trigger', node => document.activeElement === node), true);
});
