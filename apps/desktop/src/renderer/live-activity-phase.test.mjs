/**
 * live-activity-phase.test.mjs — the coding transcript's working band keeps
 * the last phase through a short gap instead of switching or blanking, and
 * plays its entrance once per turn, not again on a remount.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null);
after(restore);
const { createRoot } = await import('react-dom/client');
const { ENTERED_ACTIVITY_TURN_LIMIT, LiveActivity } = await import('./transcript-status.tsx');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(t) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => act(async () => root.unmount()));
  const render = (props) => act(async () => root.render(React.createElement(LiveActivity, props)));
  return { host, root, render };
}

const spinner = (fields) => ({ spinner: { active: true, startedAt: Date.now() - 2_000, ...fields } });

test('a new phase paints after 150 ms, once the painted one stood 650 ms', async (t) => {
  const { host, render } = mount(t);
  const mode = () => host.querySelector('.live-activity')?.getAttribute('data-mode') ?? null;
  await render({ snapshot: spinner({ mode: 'compacting' }) });
  assert.equal(mode(), 'compacting', 'the first phase paints at once');
  await render({ snapshot: spinner({ mode: 'tool-use' }) });
  assert.equal(mode(), 'compacting', 'a switch waits');
  await act(async () => sleep(400));
  assert.equal(mode(), 'compacting', 'the painted phase stands 650 ms');
  await act(async () => sleep(350));
  assert.equal(mode(), 'tool-use', 'then the new phase paints');
  // A phase one publication long never paints.
  await act(async () => sleep(700));
  await render({ snapshot: spinner({ mode: 'thinking' }) });
  await render({ snapshot: spinner({ mode: 'tool-use' }) });
  await act(async () => sleep(250));
  assert.equal(mode(), 'tool-use', 'the brief phase was skipped');
  // After the dwell, a switch takes only the 150 ms delay.
  await render({ snapshot: spinner({ mode: 'thinking' }) });
  await act(async () => sleep(100));
  assert.equal(mode(), 'tool-use');
  await act(async () => sleep(120));
  assert.equal(mode(), 'thinking');
});

test('a phase withdrawn before it paints never paints later; the painted phase stays', async (t) => {
  const { host, render } = mount(t);
  const mode = () => host.querySelector('.live-activity')?.getAttribute('data-mode') ?? null;
  await render({ snapshot: spinner({ mode: 'compacting' }) });
  await render({ snapshot: spinner({ mode: 'tool-use' }) });
  await render({ snapshot: {} });
  await act(async () => sleep(900));
  assert.equal(mode(), 'compacting', 'the withdrawn phase did not paint');
  await render({ snapshot: spinner({ mode: 'thinking' }) });
  await render({ snapshot: { commandStatus: { active: true, mode: 'resuming', startedAt: Date.now() } } });
  await act(async () => sleep(900));
  assert.equal(mode(), 'compacting', 'a resume cancels the pending phase too');
});

test('with no phase published, the last painted phase holds while the turn works', async (t) => {
  const { host, render } = mount(t);
  const mode = () => host.querySelector('.live-activity')?.getAttribute('data-mode') ?? null;
  await render({ snapshot: spinner({ mode: 'compacting' }) });
  await render({ snapshot: {} });
  await act(async () => sleep(900));
  assert.equal(mode(), 'compacting', 'held through the gap');
  await render({ snapshot: { commandStatus: { active: true, mode: 'resuming', startedAt: Date.now() } } });
  await act(async () => sleep(900));
  assert.equal(mode(), 'compacting', 'a resume mid-turn does not blank the band');
  const fresh = mount(t);
  await fresh.render({ snapshot: { commandStatus: { active: true, mode: 'resuming', startedAt: Date.now() } } });
  assert.equal(fresh.host.querySelector('.live-activity'), null, 'a resume with nothing painted paints nothing');
});

test('the entrance plays once per turn, not again when the band remounts', async (t) => {
  const animated = (host) => host.querySelector('.live-activity-status')?.getAttribute('data-animate') === 'true';
  const props = (turnKey) => ({
    snapshot: { sessionId: 'enter-s', ...spinner({ mode: 'requesting', startedAt: Date.now() + 5_000 }) },
    turnKey,
  });
  const first = mount(t);
  await first.render(props('enter-t'));
  assert.equal(animated(first.host), true, 'work that starts on screen enters');
  await act(async () => first.root.unmount());
  const again = mount(t);
  await again.render(props('enter-t'));
  assert.equal(animated(again.host), false, 'a remount of the same turn does not replay it');
  const next = mount(t);
  await next.render(props('enter-next'));
  assert.equal(animated(next.host), true, 'the next turn enters');
});

test('the record of entered turns keeps the most recent ones; a working turn stays in it', async (t) => {
  const animated = (host) => host.querySelector('.live-activity-status')?.getAttribute('data-animate') === 'true';
  const props = (turnKey) => ({
    snapshot: { sessionId: 'bound-s', ...spinner({ mode: 'requesting', startedAt: Date.now() + 5_000 }) },
    turnKey,
  });
  const old = mount(t);
  await old.render(props('old'));
  await act(async () => old.root.unmount());
  const working = mount(t);
  await working.render(props('working'));
  for (let index = 0; index < ENTERED_ACTIVITY_TURN_LIMIT; index += 1) {
    const other = document.createElement('div');
    const root = createRoot(other);
    await act(async () => root.render(React.createElement(LiveActivity, props(`other-${index}`))));
    await act(async () => root.unmount());
    // The working band commits again as it ticks.
    if (index % 32 === 31) await working.render(props('working'));
  }
  const oldAgain = mount(t);
  await oldAgain.render(props('old'));
  assert.equal(animated(oldAgain.host), true, 'a turn past the bound is forgotten');
  const workingAgain = mount(t);
  await workingAgain.render(props('working'));
  assert.equal(animated(workingAgain.host), false, 'the working turn does not replay');
});
