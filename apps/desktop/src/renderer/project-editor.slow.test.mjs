import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

test('project memory opens from one catalog, survives tabs and refreshes all scopes after writes', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { ProjectsPane } from './ProjectsView';
        import { WorkflowsPane } from './WorkflowsView';
        import { ActivityRailNavigation } from './activity-rail-navigation';
        import { Folder, Layers3 } from 'lucide-react';
        const requests = [];
        const reads = [];
        const writes = [];
        window.fixture = { requests, reads, writes };
        let railPins = { pins: ['sessions', 'agents', 'schedules'], revision: 1 };
        const railPinListeners = new Set();
        window.mixdogDesktop = {
          rendererDiagnostic() {}, setTitleBarDimmed() {},
          readActivityRailPins: async () => railPins,
          updateActivityRailPins: async pins => {
            railPins = { pins, revision: railPins.revision + 1 };
            for (const listener of railPinListeners) listener(railPins);
            return railPins;
          },
          subscribeActivityRailPins: listener => {
            railPinListeners.add(listener);
            return () => railPinListeners.delete(listener);
          },
          invokeCapability: async () => ({ value: [] }),
        };
        const root = createRoot(document.getElementById('root'));
        window.localStorage.setItem('mixdog.desktop.activity-rail-pins.v1', JSON.stringify(['sessions', 'agents', 'schedules']));
        function Fixture() {
          const [section, setSection] = useState('projects');
          return <>
          <style>{'.activity-rail-navigation { display:flex; flex-direction:column; width:48px } .activity-rail-navigation > button { width:48px; height:44px; flex-shrink:0 }'}</style>
          <ActivityRailNavigation
            entries={[
              { id: 'projects', label: 'Projects', icon: Folder },
              { id: 'workflows', label: 'Workflow', icon: Layers3 },
            ]}
            activeId={section} onSelect={setSection}
          />
          <div hidden={section !== 'projects'}><ProjectsPane
            active={section === 'projects'}
            projects={[{ path: 'a', name: 'Alpha' }, { path: 'b', name: 'Beta' }, { path: 'empty', name: 'Empty' }]}
            selectedProjectPath="a"
            onChooseFolder={async () => null} onCreateProject={async () => {}}
            onRename={() => {}} onRemove={() => {}}
            onMemoryControl={input => {
              if (input.op === 'list') {
                reads.push(input);
                return new Promise((resolve, reject) => { requests.push({ resolve, reject }); });
              }
              writes.push(input);
              return Promise.resolve('core saved');
            }}
          /></div>
          <div hidden={section !== 'workflows'}><WorkflowsPane active={section === 'workflows'} /></div>
          </>;
        }
        flushSync(() => root.render(<Fixture />));
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
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><div id="root"></div></body></html>',
    })
  );
  await page.goto('http://mixdog.test');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.click('[data-activity-more]');
  await page.waitForFunction(() => document.activeElement?.dataset.actionId === 'projects');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.pinId), 'projects');
  await page.keyboard.press('Enter');
  assert.equal(
    await page.$eval('[data-activity-more]', (button) => button.previousElementSibling.dataset.sideView),
    'projects'
  );
  assert.equal(await page.$eval('[data-pin-id="projects"]', (button) => button.getAttribute('aria-checked')), 'true');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="menu"]', { hidden: true });
  assert.equal(await page.$eval('[data-activity-more]', (button) => button === document.activeElement), true);
  await page.click('[data-activity-more]');
  await page.click('[data-pin-id="workflows"]');
  await page.click('[data-activity-more]');
  await page.evaluate(() => {
    window.fixture.dragEvents = [];
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) {
      document.addEventListener(type, (event) => {
        window.fixture.dragEvents.push({
          type,
          id: event.target.closest('[data-side-view]')?.dataset.sideView,
          clientY: event.clientY,
          types: [...event.dataTransfer.types],
          accepted: event.defaultPrevented,
        });
      });
    }
  });
  const source = await page.$eval('[data-side-view="workflows"]', (button) => {
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const target = await page.$eval('[data-side-view="projects"]', (button) => {
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 4 };
  });
  await page.setDragInterception(true);
  await page.mouse.dragAndDrop(source, target);
  await page.setDragInterception(false);
  await page
    .waitForFunction(
      () => document.querySelector('.activity-rail-navigation > button')?.dataset.sideView === 'workflows',
      { timeout: 5000 }
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        order: [...document.querySelectorAll('.activity-rail-navigation > [data-side-view]')].map(
          (button) => button.dataset.sideView
        ),
        events: window.fixture.dragEvents.slice(-20),
      }));
      throw new Error(`${error.message}; drag state: ${JSON.stringify(state)}`, { cause: error });
    });
  assert.deepEqual(
    await page.$$eval('.activity-rail-navigation > [data-side-view]', (buttons) =>
      buttons.map((button) => button.dataset.sideView)
    ),
    ['workflows', 'projects']
  );
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mixdog.desktop.activity-rail-pins.v1'))),
    ['sessions', 'agents', 'schedules', 'workflows', 'projects']
  );
  assert.equal(
    await page.$eval('[data-activity-more]', (button) => button === button.parentElement.lastElementChild),
    true
  );
  assert.equal(await page.$eval('.projects-pane', (panel) => panel.getAttribute('data-surface-active')), 'true');
  // All rows, including a row clicked during warm-up, share this one read.
  await page
    .waitForFunction(() => window.fixture?.reads.length === 1, { timeout: 5000 })
    .catch((error) => {
      throw new Error(`${error.message}; page errors: ${pageErrors.join('; ')}`);
    });
  const open = async (name) => {
    await page.evaluate((name) => {
      [...document.querySelectorAll('.projects-row')].find((row) => row.textContent.includes(name)).click();
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
  const settle = async (index, entries) => {
    await page.evaluate(
      ({ index, entries }) => {
        window.fixture.requests[index].resolve(
          JSON.stringify({
            entries,
            nextOffset: null,
            projectScopes: [
              { path: 'a', projectId: 'alpha-scope' },
              { path: 'b', projectId: 'beta-scope' },
              { path: 'empty', projectId: 'empty-scope' },
            ],
          })
        );
      },
      { index, entries }
    );
  };
  const alpha = { id: 1, summary: 'Alpha memory', project_id: 'alpha-scope', index_revision: 'alpha-v1' };
  const beta = { id: 1, summary: 'Beta memory', project_id: 'beta-scope', index_revision: 'beta-v1' };
  await open('Alpha');
  assert.equal(await page.$eval('.projects-edit-dialog', (el) => /Loading|로딩/.test(el.textContent)), true);
  assert.equal(await page.$('[aria-label="Instructions markdown"]'), null);
  await close();
  await open('Beta');
  await close();
  await open('Alpha');
  assert.equal(await page.evaluate(() => window.fixture.reads.length), 1);
  assert.deepEqual(
    await page.evaluate(() => ({
      scope: window.fixture.reads[0].project_id,
      paths: window.fixture.reads[0].project_paths,
    })),
    { scope: '*', paths: ['a', 'b', 'empty'] }
  );
  await settle(0, [alpha, beta]);
  await page.waitForFunction(() => document.querySelector('.core-memory-edit textarea')?.value === 'Alpha memory');
  // Saving an unchanged cached form must not overwrite newer disk content.
  await page.click('.projects-edit-dialog button[type="submit"]');
  await page.waitForSelector('.projects-edit-dialog', { hidden: true });
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 0);
  await open('Beta');
  assert.equal(await page.$eval('.core-memory-edit textarea', (el) => el.value), 'Beta memory');
  await close();
  await open('Empty');
  assert.equal(await page.$eval('.projects-memory-editor', (el) => el.getAttribute('aria-busy')), 'false');
  assert.equal(await page.$('.core-memory-edit'), null);
  await close();
  await open('Alpha');
  assert.equal(await page.evaluate(() => window.fixture.reads.length), 1);
  // Switching destinations closes the portal but retains the warmed catalog.
  await page.click('[data-activity-more]');
  await page.click('[data-action-id="workflows"]');
  await page.waitForSelector('.projects-edit-dialog', { hidden: true });
  await page.waitForSelector('.projects-pane[data-surface-active="false"]');
  await page.click('[data-side-view="projects"]');
  await page.waitForFunction(() => window.fixture.reads.length === 2);
  await open('Alpha');
  assert.equal(
    await page.$eval('.core-memory-edit textarea', (el) => el.value),
    'Alpha memory',
    'a pending background refresh must not hide cached text'
  );
  await page.$eval('.core-memory-edit textarea', (el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.type('.core-memory-edit textarea', ' edited');
  assert.deepEqual(pageErrors, [], 'typing into a cached memory must not unmount the editor');
  await page.select('[aria-label="Memory scope"]', '');
  await page.click('.core-memory-actions button');
  await page.waitForFunction(() => window.fixture.writes.length === 1);
  assert.deepEqual(
    await page.evaluate(() => ({
      op: window.fixture.writes[0].op,
      from: window.fixture.writes[0].cwd,
      to: window.fixture.writes[0].target_project_id,
      verbatim: window.fixture.writes[0].verbatim,
      revision: window.fixture.writes[0].index_revision,
      summary: window.fixture.writes[0].summary,
    })),
    { op: 'edit', from: 'a', to: 'common', verbatim: true, revision: 'alpha-v1', summary: 'Alpha memory edited' }
  );
  await page.waitForFunction(() => window.fixture.reads.length === 3);
  const moved = { id: 1, summary: 'Alpha memory edited', project_id: null, index_revision: 'common-v2' };
  await settle(2, [moved, beta]);
  await page.waitForFunction(() => !document.querySelector('.core-memory-edit'));
  await close();
  // A pre-save refresh finishing later cannot undo the move in the cache.
  await settle(1, [alpha, beta]);
  await open('Common Memory');
  assert.equal(await page.$eval('.core-memory-edit textarea', (el) => el.value), 'Alpha memory edited');
  assert.equal(await page.evaluate(() => window.fixture.reads.length), 3);
  await page.click('.core-memory-actions button.danger');
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 1);
  await page.click('.core-memory-actions button.danger');
  await page.waitForFunction(() => window.fixture.writes.length === 2);
  assert.deepEqual(
    await page.evaluate(() => ({
      op: window.fixture.writes[1].op,
      scope: window.fixture.writes[1].project_id,
      revision: window.fixture.writes[1].index_revision,
    })),
    { op: 'delete', scope: 'common', revision: 'common-v2' }
  );
  await page.waitForFunction(() => window.fixture.reads.length === 4);
  await settle(3, [beta]);
  await page.waitForFunction(() => !document.querySelector('.core-memory-edit'));
  await page.click('[aria-label="Add memory"]');
  await page.type('.projects-memory-add-row textarea', 'New Beta rule');
  await page.select('.projects-memory-add-row select', 'b');
  await page.click('.projects-memory-add-row .core-memory-actions button');
  await page.waitForFunction(() => window.fixture.reads.length === 5);
  assert.deepEqual(await page.evaluate(() => window.fixture.writes[2]), {
    action: 'core',
    op: 'add',
    summary: 'New Beta rule',
    verbatim: true,
    cwd: 'b',
  });
  await settle(4, [
    { ...beta, index_revision: 'beta-v2' },
    { id: 2, summary: 'New Beta rule', project_id: 'beta-scope', index_revision: 'beta-v2' },
  ]);
  await page.waitForSelector('.projects-memory-add-row', { hidden: true });
  await close();
  await open('Beta');
  assert.deepEqual(await page.$$eval('.core-memory-edit textarea', (els) => els.map((el) => el.value)), [
    'Beta memory',
    'New Beta rule',
  ]);
  assert.equal(await page.evaluate(() => window.fixture.reads.length), 5);
  assert.deepEqual(pageErrors, []);
});
