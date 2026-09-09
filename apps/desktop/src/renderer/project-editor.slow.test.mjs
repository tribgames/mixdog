import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

test('memory editor keeps common/project scopes separate and ignores late closed-panel reads', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { ProjectListSection } from './ProjectListSection';
        const requests = { instructions: {}, memories: {} };
        const calls = { instructions: 0, memories: 0, saves: 0 };
        const writes = [];
        const read = (kind, path) => {
          calls[kind]++;
          return new Promise((resolve, reject) => { requests[kind][String(path)] = { resolve, reject }; });
        };
        window.fixture = { requests, calls, writes };
        const root = createRoot(document.getElementById('root'));
        flushSync(() => root.render(<ProjectListSection
          projects={[{ path: 'a', name: 'Alpha' }, { path: 'b', name: 'Beta' }]}
          selectedProjectPath="a"
          onChooseFolder={async () => null} onCreateProject={async () => {}}
          onRename={() => {}} onRemove={() => {}}
          onMemoryControl={input => {
            if (input.op === 'list') return read('memories', input.cwd ?? null);
            writes.push(input);
            return Promise.resolve('core saved');
          }}
        />));
      `,
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    format: 'iife',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => request.respond({
    status: 200, contentType: 'text/html',
    body: '<html><body><div id="root"></div></body></html>',
  }));
  await page.goto('http://mixdog.test');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.fixture?.calls.memories === 3, { timeout: 5000 })
    .catch(error => { throw new Error(`${error.message}; page errors: ${pageErrors.join('; ')}`); });
  const open = async (name) => {
    await page.evaluate((name) => {
      [...document.querySelectorAll('.projects-row')].find(row => row.textContent.includes(name)).click();
    }, name);
    await page.waitForSelector('.projects-edit-dialog');
  };
  const close = async () => {
    await page.waitForFunction(() => {
      const button = document.querySelector('.projects-edit-dialog button.secondary');
      return button && !button.disabled;
    });
    await page.click('.projects-edit-dialog button.secondary');
    await page.waitForSelector('.projects-edit-dialog', { hidden: true });
  };
  const settle = async (kind, path, value) => {
    await page.evaluate(({ kind, path, value }) => {
      window.fixture.requests[kind][path].resolve(value);
    }, { kind, path, value });
  };
  await open('Alpha');
  assert.equal(await page.$eval('.projects-edit-dialog', el => /Loading|로딩/.test(el.textContent)), false);
  assert.equal(await page.$('[aria-label="Instructions markdown"]'), null);
  await settle('memories', 'a', JSON.stringify({ entries: [{ id: 1, summary: 'Alpha memory', source: 'curated', index_revision: 'alpha-v1' }], nextOffset: null }));
  await page.waitForFunction(() => document.querySelector('.core-memory-edit textarea')?.value === 'Alpha memory');
  await close();
  await open('Alpha');
  assert.deepEqual(await page.evaluate(() => ({
    memory: document.querySelector('.core-memory-edit textarea').value,
    calls: window.fixture.calls,
  })), {
    memory: 'Alpha memory',
    calls: { instructions: 0, memories: 3, saves: 0 },
  });
  // Saving an unchanged cached form must not overwrite newer disk content.
  await page.click('.projects-edit-dialog button[type="submit"]');
  await page.waitForSelector('.projects-edit-dialog', { hidden: true });
  assert.equal(await page.evaluate(() => window.fixture.calls.saves), 0);
  await open('Beta');
  await close();
  await open('Alpha');
  await settle('memories', 'b', JSON.stringify({ entries: [{ id: 2, summary: 'Beta memory', source: 'curated' }], nextOffset: null }));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await page.$eval('textarea', el => el.value), 'Alpha memory', 'closed requests cannot replace the current project');
  await page.select('[aria-label="Memory scope"]', '');
  await page.click('.core-memory-actions button');
  await page.waitForFunction(() => window.fixture.writes.length === 1);
  assert.deepEqual(await page.evaluate(() => ({
    op: window.fixture.writes[0].op,
    from: window.fixture.writes[0].cwd,
    to: window.fixture.writes[0].target_project_id,
    verbatim: window.fixture.writes[0].verbatim,
    revision: window.fixture.writes[0].index_revision,
  })), { op: 'edit', from: 'a', to: 'common', verbatim: true, revision: 'alpha-v1' });
  await settle('memories', 'a', JSON.stringify({ entries: [], nextOffset: null }));
  await page.waitForFunction(() => !document.querySelector('.core-memory-edit'));
  await close();
  await open('Common Memory');
  await settle('memories', 'null', JSON.stringify({ entries: [{ id: 1, summary: 'Alpha memory', source: 'curated', index_revision: 'common-v2' }], nextOffset: null }));
  await page.waitForSelector('.core-memory-edit textarea');
  await page.click('.core-memory-actions button.danger');
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 1);
  await page.click('.core-memory-actions button.danger');
  await page.waitForFunction(() => window.fixture.writes.length === 2);
  assert.deepEqual(await page.evaluate(() => ({
    op: window.fixture.writes[1].op, scope: window.fixture.writes[1].project_id,
    revision: window.fixture.writes[1].index_revision,
  })), { op: 'delete', scope: 'common', revision: 'common-v2' });
  await settle('memories', 'null', JSON.stringify({ entries: [], nextOffset: null }));
  await page.waitForFunction(() => !document.querySelector('.core-memory-edit'));
  assert.deepEqual(pageErrors, []);
});
