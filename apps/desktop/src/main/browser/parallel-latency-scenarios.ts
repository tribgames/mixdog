import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { BrowserCommandTiming } from './timing';

export async function runBrowserParallelLatencyScenarios(
  dispatch: (input: Record<string, unknown>) => Promise<{ text: string; timing?: BrowserCommandTiming }>,
  origin: string,
  progress: (message: string) => void,
) {
  const measurementTurn = Date.now();
  const command = (input: Record<string, unknown>) => dispatch({ ...input, turn_id: measurementTurn });
  const tabs = ['parallel-latency-a', 'parallel-latency-b'];
  try {
    await Promise.all(tabs.map(async tab => {
      await command({ action: 'navigate', url: origin, background: true, tab });
      await command({ action: 'evaluate', tab, background: true, script: `(() => {
        document.body.innerHTML = '<label>Name<input id="name"></label><button id="save">Save</button><output id="result"></output>';
        document.getElementById('save').onclick = () => {
          const value = document.getElementById('name').value;
          setTimeout(() => { document.getElementById('result').textContent = 'Saved ' + value; }, 200);
        };
      })()` });
    }));
    const work = (tab: string, value: string) => command({
      action: 'sequence', tab, background: true,
      steps: [
        { action: 'fill', target: { name: 'Name', exact: true }, text: value },
        { action: 'click', target: { name: 'Save', exact: true } },
        { action: 'wait', text: 'Saved ' + value },
      ],
    });
    const sequentialAt = performance.now();
    for (const tab of tabs) assert.match((await work(tab, 'sequential')).text, /Saved sequential/);
    const sequentialMs = performance.now() - sequentialAt;
    const parallelAt = performance.now();
    const results = await Promise.all(tabs.map(tab => work(tab, 'parallel')));
    const parallelMs = performance.now() - parallelAt;
    for (const result of results) assert.match(result.text, /Saved parallel/);
    progress(`latency independent-tab sequences ${JSON.stringify({
      sequentialMs, parallelMs, tabs: tabs.length, simulatedResponseMs: 200,
    })}`);
  } finally {
    await Promise.all(tabs.map(tab => command({ action: 'close_tab', tab })));
  }
}
