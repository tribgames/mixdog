// The TUI-side footer against the text Node rendered (b6f10295a `renderStatusline`, recorded by
// footer-golden/record.mjs): each scenario's data files are written to a data dir, read by the footer's inputs
// and rendered with the recorded clock, width and zone.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SCENARIOS, T0 } from './footer-golden/scenarios.mjs';

process.env.TZ = 'UTC';
process.env.COLORTERM = 'truecolor';
const { createFooterInputs } = await import('./footer-inputs.mjs');
const { createFooterRenderer } = await import('./footer-render.mjs');

const golden = JSON.parse(readFileSync(new URL('./footer-golden/node-footer.golden.json', import.meta.url), 'utf8'));

test('the golden covers every scenario, recorded from b6f10295a', () => {
  assert.equal(golden.recordedFrom, 'b6f10295a');
  assert.deepEqual(
    golden.scenarios.map((s) => s.name),
    SCENARIOS.map((s) => s.name)
  );
});

for (const scenario of SCENARIOS) {
  test(`footer text equals Node's: ${scenario.name}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'footer-render-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(scenario.files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    // mixdogd writes no gateway-usage.local.jsonl: the usage ledger's requests stand in for its events.
    const eventsText = scenario.files['gateway-usage.local.jsonl'] || '';
    const events = eventsText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const inputs = createFooterInputs({
      dataDir: dir,
      now: () => T0,
      readUsageRequests: async ({ model }) => ({ requests: events.filter((e) => e.model === model) }),
    });
    const render = createFooterRenderer();
    const { provider, model } = scenario.args;
    let text = '';
    for (let i = 0; i < 3; i += 1) {
      const data = await inputs.read(provider, model);
      text = render(
        { ...scenario.args, shellStatus: { count: 0, unconfirmed: 0, elapsedLabel: '' } },
        data,
        { now: T0, cols: scenario.cols, processStartedAt: T0 - 200, isPidAlive: () => true }
      );
    }
    const expected = golden.scenarios.find((s) => s.name === scenario.name).expected;
    assert.equal(text, expected);
  });
}
