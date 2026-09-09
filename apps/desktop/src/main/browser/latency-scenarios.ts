/** Separate local latency samples: input-only must never stand in for a
 * pointer-bearing form. Assertions own outcomes, not wall-clock thresholds. */
import assert from 'node:assert/strict';
import type { BrowserCommandTiming } from './timing';
import { runBrowserParallelLatencyScenarios } from './parallel-latency-scenarios';

export async function runBrowserLatencyScenarios(
  command: (input: Record<string, unknown>) => Promise<{ text: string; timing?: BrowserCommandTiming }>,
  origin: string,
  progress: (message: string) => void,
) {
  const tab = 'latency-scenarios';
  const measurementTurn = Date.now();
  const run = (input: Record<string, unknown>) => command({ ...input, tab, background: true, turn_id: measurementTurn });
  await run({ action: 'navigate', url: origin });
  try {
    await run({ action: 'evaluate', script: `(() => {
      document.body.innerHTML = '<label>First<input id="first"></label><label>Last<input id="last"></label>'
        + '<label>Plan<select id="plan"><option value="a">Basic</option><option value="b">Plus</option></select></label>'
        + '<label>Agree<input type="checkbox" id="agree"></label><button id="save">Save</button><output id="result"></output>';
      let saves = 0;
      document.getElementById('save').onclick = () => {
        document.getElementById('result').textContent = 'Saved ' + (++saves);
      };
    })()` });
    const inputs = [
      { action: 'fill', target: { name: 'First', exact: true }, text: 'Jae' },
      { action: 'fill', target: { name: 'Last', exact: true }, text: 'Young' },
      { action: 'select', target: { name: 'Plan', exact: true }, values: ['b'] },
    ];
    const only = await run({ action: 'sequence', steps: inputs });
    assert.match(only.text, /value="Jae"/);
    assert.match(only.text, /value="Young"/);
    assert.match(only.text, /value="Plus"/);
    progress(`latency scenario input-only ${JSON.stringify(only.timing)}`);
    // Give both forms the same starting values; resetting is outside the sample.
    await run({ action: 'evaluate', script: `(() => {
      document.getElementById('first').value = '';
      document.getElementById('last').value = '';
      document.getElementById('plan').value = 'a';
    })()` });
    const batch = await run({
      action: 'fill',
      fields: inputs.map(({ target, text, values }) => ({ target, ...(values ? { values } : { text }) })),
    });
    assert.match(batch.text, /value="Jae"/);
    assert.match(batch.text, /value="Young"/);
    assert.match(batch.text, /value="Plus"/);
    progress(`latency scenario fill-fields ${JSON.stringify(batch.timing)}`);
    const mixed = await run({
      action: 'sequence',
      steps: [
        ...inputs.map((step) => step.action === 'fill' ? { ...step, text: step.text + ' mixed' } : step),
        { action: 'fill', target: { name: 'Agree', exact: true }, checked: true },
        { action: 'click', target: { name: 'Save', exact: true } },
        { action: 'wait', text: 'Saved 1' },
      ],
      expect: { text: 'Saved 1' },
    });
    assert.match(mixed.text, /value="Jae mixed"/);
    assert.match(mixed.text, /value="Young mixed"/);
    assert.match(mixed.text, /checked=true/);
    assert.match(mixed.text, /Saved 1/);
    assert.equal(mixed.timing?.mouseEvents?.mouseReleased?.count, 2);
    progress(`latency scenario check-and-save ${JSON.stringify(mixed.timing)}`);
    await assert.rejects(run({
      action: 'click', target: { name: 'Save', exact: true },
      expect: { text: 'unreachable result', timeoutMs: 500 },
    }), (error: Error & { timing?: BrowserCommandTiming }) => {
      assert.match(error.message, /Postcondition failed[\s\S]*Saved 2/);
      assert.ok(error.timing && error.timing.commandMs > 0);
      assert.equal(error.timing.mouseEvents?.mouseReleased?.count, 1);
      progress(`latency scenario failed-condition ${JSON.stringify(error.timing)}`);
      return true;
    });
  } finally {
    await command({ action: 'close_tab', tab });
  }
  await runBrowserParallelLatencyScenarios(command, origin, progress);
}
