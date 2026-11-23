// Follow at the end of a session's running turn in the real pane over the real lane store and its positioned window
// (test-support/session-switch-*): it holds in every frame of the turn, whatever the pane's size does meanwhile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { launchSwitchBrowser, openSwitchPage, paneFrames } from './test-support/session-switch-rig.mjs';

let browser;
test.before(async () => {
  browser = await launchSwitchBrowser();
});
test.after(() => browser?.close());

async function rig(t, options) {
  const page = await openSwitchPage(browser, options);
  t.after(async () => {
    const { errors } = page;
    await page.close();
    assert.deepEqual(errors, []);
  });
  return page;
}

/** A long turn's steps: paragraphs streamed and stored between runs of tools that start, finish and fold into the
 *  turn's trace, each a function the page runs with `rig`. */
function longTurn(id) {
  const steps = [new Function('rig', `rig.core.prompt('${id}')`)];
  for (let round = 0; round < 6; round += 1) {
    for (let chunk = 0; chunk < 4; chunk += 1) {
      const words = `Paragraph ${round}.${chunk} with enough words to wrap across the column a few times over. `.repeat(3);
      steps.push(new Function('rig', `rig.core.stream('${id}', ${JSON.stringify(`${words}\n\n`)})`));
    }
    steps.push(new Function('rig', `rig.core.reply('${id}', { storedId: '${id}-x${round}' })`));
    for (let k = 0; k < 5; k += 1) {
      const call = JSON.stringify({ name: ['grep', 'read', 'apply_patch'][k % 3], input: { path: `src/f${k}.ts`, pattern: `p${k}` } });
      steps.push(new Function('rig', `rig.core.tool('${id}', '${id}-run${round}.${k}', { ...${call}, done: false })`));
      steps.push(new Function('rig', `rig.core.tool('${id}', '${id}-run${round}.${k}', ${call})`));
    }
  }
  return steps;
}

const SIZES = [
  { width: 900, height: 820 },
  { width: 1180, height: 820 },
  { width: 1180, height: 680 },
  { width: 1400, height: 820 },
  { width: 1180, height: 820 },
];

test("a long turn at the end of a session longer than its window: follow holds in every frame while the pane's size changes", async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => {
    window.__releases = [];
    window.mixdogDesktop.perfLog = (line) => {
      if (line.startsWith('transcript-follow-release')) window.__releases.push(line);
    };
  });
  const lost = [];
  for (const [index, step] of longTurn('A').entries()) {
    if (index % 5 === 4) await p.page.setViewport(SIZES[Math.floor(index / 5) % SIZES.length]);
    const frames = paneFrames(await p.frames(step, { count: 10 }));
    frames.forEach((view, at) => {
      if (!view.following) lost.push(`step ${index} frame ${at}: not following, gap ${view.gap}`);
    });
    const rest = frames.at(-1);
    if (Math.abs(rest.gap) > 1) lost.push(`step ${index} at rest: the end is ${rest.gap}px below the view`);
  }
  assert.deepEqual(await p.run(() => window.__releases), [], 'follow is never released');
  assert.deepEqual(lost.slice(0, 10), [], 'every frame follows the end');
});
