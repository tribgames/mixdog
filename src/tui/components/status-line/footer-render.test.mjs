// The TUI-side footer against the text Node rendered (b6f10295a `renderStatusline`, recorded by
// footer-golden/record.mjs): each scenario's data files are written to a data dir, read by the footer's inputs
// and rendered with the recorded clock, width and zone.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { LIFECYCLE, SCENARIOS, T0 } from './footer-golden/scenarios.mjs';

process.env.TZ = 'UTC';
process.env.COLORTERM = 'truecolor';
const { createCatalogWarmth } = await import('./catalog-warmth.mjs');
const { createFooterInputs } = await import('./footer-inputs.mjs');
const { createFooterRenderer } = await import('./footer-render.mjs');

const golden = JSON.parse(readFileSync(new URL('./footer-golden/node-footer.golden.json', import.meta.url), 'utf8'));

test('the golden covers every scenario, recorded from b6f10295a', () => {
  assert.match(golden.recordedFrom, /^b6f10295a[0-9a-f]{31}$/);
  assert.deepEqual(
    golden.scenarios.map((s) => s.name),
    SCENARIOS.map((s) => s.name)
  );
});

function writeScenarioFiles(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'footer-render-'));
  for (const [name, content] of Object.entries(scenario.files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  for (const [name, content] of Object.entries(scenario.configFiles || {})) {
    mkdirSync(dirname(join(dir, 'config', name)), { recursive: true });
    writeFileSync(join(dir, 'config', name), content);
  }
  return dir;
}

const lifecycleGolden = JSON.parse(readFileSync(new URL('./footer-golden/node-lifecycle.golden.json', import.meta.url), 'utf8'));
const { listWithCatalogWarmth } = await import('./catalog-warmth.mjs');

for (const scenario of LIFECYCLE) {
  test(`warm lifecycle equals Node's: ${scenario.name}`, async (t) => {
    const dir = writeScenarioFiles(scenario);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // The core's background load ends at the gate; the full list call awaits the warming it started.
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const warmth = createCatalogWarmth({ dataDir: () => dir, whenReady: () => gate });
    const inputs = createFooterInputs({ dataDir: dir, configDir: join(dir, 'config'), env: {}, now: () => T0, warmth });
    const footer = createFooterRenderer({ routeMetaLoaded: true });
    const { provider, model } = scenario.args;
    const render = async () => {
      const data = await inputs.read(provider, model);
      const text = footer.render({ ...scenario.args, shellStatus: NO_SHELLS }, data, {
        now: T0,
        cols: scenario.cols,
        processStartedAt: T0 - 200,
        isPidAlive: () => true,
      });
      footer.flush();
      return text;
    };
    const list = listWithCatalogWarmth(async () => [], warmth);
    const texts = [await render()];
    await list({ quick: true });
    texts.push(await render());
    open();
    await list({});
    texts.push(await render());
    assert.deepEqual(texts, lifecycleGolden.scenarios.find((s) => s.name === scenario.name).expected);
  });
}

const NO_SHELLS ={ count: 0, unconfirmed: 0, elapsedLabel: '' };

for (const scenario of SCENARIOS) {
  const recorded = golden.scenarios.find((s) => s.name === scenario.name);
  test(`footer text equals Node's: ${scenario.name}`, async (t) => {
    const dir = writeScenarioFiles(scenario);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let clock = T0;
    // The pricing catalogs are resident only once a model list has been loaded (`warm`).
    const warmth = createCatalogWarmth({ dataDir: () => dir });
    if (scenario.warm) await warmth.warm();
    const inputs = createFooterInputs({ dataDir: dir, configDir: join(dir, 'config'), env: {}, now: () => clock, warmth });
    const { provider, model } = scenario.args;
    const step = (footer, now) => {
      clock = now;
      return inputs.read(provider, model).then((data) => ({
        text: footer.render({ ...scenario.args, shellStatus: NO_SHELLS }, data, {
          now,
          cols: scenario.cols,
          processStartedAt: T0 - 200,
          isPidAlive: () => true,
        }),
        footer,
      }));
    };
    if (scenario.steps) {
      // The first renders: the text at each offset, the refreshes it queued running between the renders.
      const footer = createFooterRenderer();
      const texts = [];
      for (const advance of scenario.steps) {
        texts.push((await step(footer, T0 + advance)).text);
        footer.flush();
      }
      assert.deepEqual(texts, recorded.expected);
      return;
    }
    // The settled text: a footer that has had its first refresh, rendered with its refreshes run.
    const footer = createFooterRenderer({ routeMetaLoaded: true });
    let text = '';
    for (let i = 0; i < 3; i += 1) {
      text = (await step(footer, T0)).text;
      footer.flush();
    }
    assert.equal(text, recorded.expected);
  });
}
