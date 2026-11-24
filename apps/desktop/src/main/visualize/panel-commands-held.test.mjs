// The user's panel commands while an agent turn runs (panel-commands.ts, turn-hold.ts `shownAs`): one rule for every
// command on a tab the session shows, by how that tab stands to what the running turn has done to it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { remoteVisualizeState } from '../../shared/visualize.ts';
import { createVisualizeService } from './service.ts';

const SESSION = 's1';

/** A session showing a.html (v1, two kept versions) and b.html (v2, the one shown), then a turn that has done `work`. */
async function during(work) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-held-commands-')));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  const page = join(cwd, 'site', 'a.html');
  writeFileSync(page, '<h1>one</h1>');
  writeFileSync(join(cwd, 'site', 'b.html'), '<h1>b</h1>');
  const other = join(cwd, 'site', 'c.html');
  writeFileSync(other, '<h1>c one</h1>');
  const events = [];
  const hostEvents = [];
  let prepared = 0;
  const service = createVisualizeService({
    versions: { directory: join(root, 'versions') },
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane(target) {
      prepared += 1;
      return `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}?${prepared}`;
    },
    publish: (event) => events.push(structuredClone(event)),
    publishHost: (event) => hostEvents.push(structuredClone(event)),
    watch: () => () => {},
    annotate: async () => [],
    inspect: async () => [],
    capture: async () => Buffer.from('SCREEN'),
    exportBytes: async () => Buffer.from('BYTES'),
    // The save dialog, canceled: an export that runs gets this far.
    chooseExportPath: async () => null,
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 5,
  });
  const run = (action, input) => service.execute({ sessionId: SESSION, cwd, action, input });
  await run('open', { targets: ['site/a.html'] });
  writeFileSync(page, '<h1>two</h1>');
  await run('open', { targets: ['site/a.html'] });
  await run('open', { targets: ['site/b.html'] });
  await service.settled();
  const before = structuredClone(service.snapshot()[0]);
  await service.setTurnActive(SESSION, true);
  await work({ run, page, other });
  events.length = 0;
  hostEvents.length = 0;
  return {
    service,
    events,
    hostEvents,
    before,
    run,
    page,
    other,
    entry: before.history.find((item) => item.label === 'a.html').id,
    cleanup() {
      service.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** What the running turn has done to v1, the tab the user's command is on; `ended`: what its end must then show. */
const STATES = {
  'live as shown': {
    work: ({ run }) => run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } }),
    ended: (tabs) => tabs.some((tab) => tab.id === 'v3'),
  },
  'changed by the turn': {
    async work({ run, page }) {
      writeFileSync(page, '<h1>three</h1>');
      await run('open', { targets: ['site/a.html'], label: 'A reworked' });
    },
    ended: (tabs) => tabs.every((tab) => tab.id !== 'v1' || tab.versions.length === 3),
  },
  'closed by the turn': {
    work: ({ run }) => run('close', { tab: 'v1' }),
    ended: (tabs) => tabs.every((tab) => tab.id !== 'v1'),
  },
  'opened anew by the turn': {
    async work({ run }) {
      await run('close', { tab: 'v1' });
      await run('open', { targets: ['site/a.html'] });
    },
    ended: (tabs) => tabs.every((tab) => tab.id !== 'v1') && tabs.some((tab) => tab.id === 'v3'),
  },
};

const selected = (state) => state.active === 'v1' && state.tabs.map((tab) => tab.id).join() === 'v1,v2';
const closed = (state) => state.active === 'v2' && state.tabs.map((tab) => tab.id).join() === 'v2';
const tab = (state) => state.tabs.find((candidate) => candidate.id === 'v1');

/** Each command of the user's on v1: what it sends, and what the session shows when it ran: on the tab itself
 *  (`live`), or on a picture from before the turn's change (`past`; 'refused' = not run, the reason given). */
const COMMANDS = {
  select: { send: () => ({ action: 'activate' }), live: selected, past: selected },
  'history pick': { send: (t) => ({ tabId: '', action: 'history', entry: t.entry }), live: selected, past: selected },
  reopen: { send: () => ({ action: 'reopen', targets: ['site/a.html'] }), live: selected, past: selected },
  close: { send: () => ({ action: 'close' }), live: closed, past: closed },
  version: {
    send: () => ({ action: 'version', version: 1 }),
    live: (state) => tab(state).version === 1,
    past: 'refused',
  },
  network: {
    send: () => ({ action: 'network', allow: false }),
    live: (state) => tab(state).networkAllowed === undefined,
    past: 'refused',
  },
  restore: {
    send: () => ({ action: 'restore', version: 1 }),
    live: (state) => tab(state).versions.length === 3,
    past: 'refused',
  },
  export: { send: () => ({ action: 'export', format: 'png', pane: 0 }), live: 'runs', past: 'refused' },
};

const files = (state) => state.tabs.map((one) => one.panes.map((pane) => pane.target).join('|'));
const once = (list) => new Set(list).size === list.length;
const ofC = (state) => state.tabs.find((candidate) => candidate.label === 'c.html');
const reads = (t) => [t.service.snapshot()[0], remoteVisualizeState(t.service.hostSnapshot()[0])];
const send = (t, tabId, command) =>
  t.service.command({ sessionId: SESSION, tabId, ...command }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );

/** The turn has opened c.html (two kept versions, the first selected) and an inline visual; the session shows
 *  neither. The user's own open of c.html comes as a chat card or preview tile (reopen); "All visuals" lists a
 *  visual only once the session shows it. */
async function turnOnly() {
  return during(async ({ run, other }) => {
    await run('open', { targets: ['site/c.html'] });
    writeFileSync(other, '<h1>c two</h1>');
    await run('open', { targets: ['site/c.html'] });
    await run('open', { targets: ['site/c.html'], version: 1 });
    await run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
  });
}

test('the user’s open of a file only the running turn has a tab of shows that tab as it is, marked, and nothing else', async () => {
  const t = await turnOnly();
  try {
    const opened = await send(t, '', { action: 'reopen', targets: ['site/c.html'] });
    assert.equal(opened.error, undefined);
    const event = t.events.at(-1);
    assert.equal(event.held, true, 'the hold stays');
    for (const state of [event.state, ...reads(t)]) {
      const own = ofC(state);
      assert.equal(own?.turnWork, true, 'marked as the running turn’s');
      assert.equal(own.version, 1, 'as the turn has it now');
      assert.equal(state.active, own.id);
      assert.equal(state.tabs.length, 3, 'nothing else of the turn');
      assert.ok(once(state.tabs.map((candidate) => candidate.label)), 'no file twice');
    }
    assert.deepEqual(tab(event.state), tab(t.before));
    const id = ofC(event.state).id;
    assert.equal(
      (await t.service.paneText(SESSION, id, 0)).text,
      '<h1>c one</h1>',
      'the source view is of the tab as shown'
    );

    // What acts on the content waits for the turn's end; viewing does not.
    const shown = t.service.snapshot()[0];
    for (const command of [
      { action: 'version', version: 2 },
      { action: 'network', allow: true },
      { action: 'restore', version: 1 },
      { action: 'export', format: 'png', pane: 0 },
    ]) {
      const outcome = await send(t, id, command);
      assert.match(outcome.error?.message ?? '', /running turn is still writing tab/, command.action);
      assert.deepEqual(t.service.snapshot()[0], shown, 'nothing moved');
    }
    assert.equal((await send(t, 'v1', { action: 'activate' })).error, undefined);
    assert.equal((await send(t, id, { action: 'activate' })).error, undefined);
    assert.equal(t.service.snapshot()[0].active, id);
    assert.ok(
      [...t.events, ...t.hostEvents].every((one) => one.held === true),
      'the hold is never lifted'
    );

    // The turn's end shows what the turn made, the version it selected included: the user's view changed nothing.
    t.events.length = 0;
    await t.service.setTurnActive(SESSION, false);
    const end = t.events.at(-1);
    assert.equal(end.held, undefined);
    assert.equal(ofC(end.state).version, 1, 'the version the turn selected');
    assert.equal(ofC(end.state).turnWork, undefined);
    assert.equal(end.state.tabs.length, 4, 'with the rest of the turn’s work');
  } finally {
    t.cleanup();
  }
});

test('the running turn’s tab is seen as it is each time the user asks, and a close of that view leaves the tab to the turn', async () => {
  const t = await turnOnly();
  try {
    await send(t, '', { action: 'reopen', targets: ['site/c.html'] });
    const id = ofC(t.service.snapshot()[0]).id;
    await t.run('open', { targets: ['site/c.html'] });
    assert.equal(ofC(t.service.snapshot()[0]).version, 1, 'the view does not follow the turn by itself');
    await send(t, '', { action: 'reopen', targets: ['site/c.html'] });
    for (const state of reads(t)) {
      assert.notEqual(ofC(state).version, 1, 'asked again: as it is now');
      assert.equal(ofC(state).turnWork, true);
      assert.equal(state.tabs.length, 3);
    }

    assert.equal((await send(t, id, { action: 'close' })).error, undefined);
    for (const state of [t.events.at(-1).state, ...reads(t)]) assert.equal(ofC(state), undefined, 'the view leaves');
    await t.service.setTurnActive(SESSION, false);
    assert.equal(ofC(t.service.snapshot()[0])?.id, id, 'the turn’s tab shows at its end');
  } finally {
    t.cleanup();
  }
});

test('a preview of an ended turn reopened while the next turn, already running, has that file open shows the next turn’s tab, marked', async () => {
  const t = await during(async ({ run }) => {
    await run('open', { targets: ['site/c.html'] });
    await run('close', { tab: 'v3' });
  });
  try {
    const end = t.service.setTurnActive(SESSION, false);
    await t.service.setTurnActive(SESSION, true);
    await end;
    writeFileSync(t.other, '<h1>c next</h1>');
    await t.run('open', { targets: ['site/c.html'] });
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
    assert.equal(ofC(t.service.snapshot()[0]), undefined, 'the next turn’s tab is held');
    t.events.length = 0;
    t.hostEvents.length = 0;

    assert.equal((await send(t, '', { action: 'reopen', targets: ['site/c.html'] })).error, undefined);
    assert.ok(t.events.length > 0 && [...t.events, ...t.hostEvents].every((one) => one.held === true));
    for (const state of [t.events.at(-1).state, ...reads(t)]) {
      assert.equal(ofC(state)?.turnWork, true);
      assert.equal(state.tabs.length, 3, 'nothing else of the next turn');
    }
    const id = ofC(t.service.snapshot()[0]).id;
    assert.match(
      (await send(t, id, { action: 'export', format: 'png', pane: 0 })).error?.message ?? '',
      /still writing/
    );

    await t.service.setTurnActive(SESSION, false);
    const ended = t.service.snapshot()[0];
    assert.equal(ended.held, undefined);
    assert.equal(ofC(ended).turnWork, undefined);
    assert.equal(ended.tabs.length, 4);
  } finally {
    t.cleanup();
  }
});

test('the source view of a tab the running turn moved to another version is of the tab as shown', async () => {
  const t = await during(({ run }) => run('open', { targets: ['site/a.html'], version: 1 }));
  try {
    assert.equal((await t.service.paneText(SESSION, 'v1', 0)).text, '<h1>two</h1>');
    await t.service.setTurnActive(SESSION, false);
    assert.equal((await t.service.paneText(SESSION, 'v1', 0)).text, '<h1>one</h1>', 'at the end: the turn’s selection');
  } finally {
    t.cleanup();
  }
});

for (const [stateName, state] of Object.entries(STATES)) {
  for (const [commandName, command] of Object.entries(COMMANDS)) {
    test(`${commandName} on a tab ${stateName}`, async () => {
      const t = await during(state.work);
      try {
        const live = stateName === 'live as shown';
        const expected = live ? command.live : command.past;
        // The source view of a visible tab is of that tab as shown: its own page, also when the turn closed the tab.
        assert.equal((await t.service.paneText(SESSION, 'v1', 0)).text, readFileSync(t.page, 'utf8'), 'source view');
        const outcome = await t.service.command({ sessionId: SESSION, tabId: 'v1', ...command.send(t) }).then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        const shown = t.service.snapshot()[0];

        // A visible result: the session shows the command's effect, or the user is told why it did not run.
        if (expected === 'refused') {
          assert.match(outcome.error?.message ?? '', /running turn has changed or closed tab v1/);
          assert.deepEqual(
            { ...shown, held: undefined, heldSince: undefined },
            { ...t.before, held: undefined, heldSince: undefined },
            'nothing moved'
          );
        } else {
          assert.equal(outcome.error, undefined);
          if (expected === 'runs') assert.deepEqual(outcome.value, { canceled: true }, 'it ran on the tab');
          else {
            assert.ok(t.events.length > 0, 'published at once');
            assert.ok(expected(t.events.at(-1).state), 'the event shows the effect');
            assert.ok(expected(shown), 'so does a read');
            assert.ok(expected(remoteVisualizeState(t.service.hostSnapshot()[0])), 'and a paired device');
          }
        }

        // Nothing of the running turn shows, in any event or read, and no file shows twice.
        const seen = [...t.events, ...t.hostEvents].map((event) => {
          assert.equal(event.held, true, 'the hold is never lifted');
          return event.state;
        });
        for (const one of [...seen, shown, t.service.hostSnapshot()[0]]) {
          assert.ok(
            one.tabs.every((candidate) => candidate.id === 'v1' || candidate.id === 'v2'),
            'no tab the turn made'
          );
          assert.ok(once(one.tabs.map((candidate) => candidate.label)), 'no file twice');
        }
        for (const one of [...t.events.map((event) => event.state), shown]) {
          assert.ok(once(files(one)), 'no file twice');
          // A picture from before the turn's change stays exactly that picture.
          if (!live && tab(one)) assert.deepEqual(tab(one), tab(t.before), 'the turn’s change of the tab is not shown');
        }

        // The turn's end shows what the turn did, each file once.
        t.events.length = 0;
        await t.service.setTurnActive(SESSION, false);
        const end = t.events.at(-1);
        assert.equal(end.held, undefined);
        assert.ok(once(files(end.state)), 'no file twice at the end');
        assert.ok(state.ended(end.state.tabs), 'the turn’s work shows at its end');
      } finally {
        t.cleanup();
      }
    });
  }
}
