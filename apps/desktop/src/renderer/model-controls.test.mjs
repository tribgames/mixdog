import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['HTMLElement', 'Node'],
  actEnvironment: false,
});
globalThis.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.HTMLElement.prototype.attachEvent = () => {};
globalThis.HTMLElement.prototype.detachEvent = () => {};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

const model = {
  provider: 'openai',
  model: 'gpt-fast-handoff-test',
  display: 'Fast handoff test',
  effortOptions: [
    { value: 'high', label: 'High' },
    { value: 'low', label: 'Low' },
  ],
  fastCapable: true,
  fastEfforts: ['high'],
  fastPreferred: false,
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function option(label) {
  return [...document.querySelectorAll('[role="menuitemradio"]')].find((button) => button.textContent.includes(label));
}

const requests = [];
let availableModels = [model];
let providerSetup = { api: [{ id: 'openai', authenticated: true }] };
window.mixdogDesktop = {
  rendererDiagnostic() {},
  listProviderModels: async () => availableModels,
  invokeCapability: async ({ capability }) => {
    assert.equal(capability, 'getProviderSetup');
    return {
      value: providerSetup,
      snapshot: null,
    };
  },
  setFast(enabled) {
    const request = deferred();
    requests.push({ enabled, request });
    return request.promise;
  },
  // A followed session whose lane these tests never feed: an answered call's preview stays until the stream shows its state.
  sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
};

const { ModelSelector } = await import('./model-controls.tsx');
const { _bootWarmupPendingForTest } = await import('./boot-warmup.ts');
const { invalidateSharedModelCatalogRequest } = await import('./model-catalog-cache.ts');
const { createSessionLane } = await import('../shared/core-lanes/session-lane.ts');
const { sessionReducer } = await import('../../../../packages/protocol-client/src/session-state.ts');
const { createSessionLaneStore, defaultSessionLaneStore, useSessionLane } = await import('./session-lane-store.ts');
const { desktopConversationShellSnapshotsEqual } = await import('./desktop-snapshot-store.ts');

test.beforeEach(() => {
  requests.length = 0;
  availableModels = [model];
  providerSetup = { api: [{ id: 'openai', authenticated: true }] };
  window.localStorage.clear();
  invalidateSharedModelCatalogRequest();
});

test('a mounted picker follows model and effort route feeds, not the running session model', async () => {
  const next = { ...model, model: 'gpt-next-route', display: 'Next route' };
  availableModels = [model, next];
  const id = 'picker-route-feed';
  let route = { provider: model.provider, model: model.model, effort: 'low', fast: false, autoEffort: false };
  let fold = sessionReducer.initial({ thread: { id }, state: { route }, items: [], hasOlder: false });
  const listeners = new Set();
  const client = {
    pendingServerRequests: () => [],
    store: { thread: () => ({ feed: { id, epoch: 'e1', seq: 1 }, order: 1, state: fold }), section: () => undefined },
  };
  const lane = createSessionLane({
    protocol: {
      client: () => client,
      onStoreChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onEvent: () => () => {},
      onReplaced: () => () => {},
      call: async () => ({ threads: [] }),
    },
  });
  const store = createSessionLaneStore();
  const stop = store.start((listener) => lane.subscribeSessionStates(listener));
  const publish = async (patch) =>
    act(async () => {
      let off;
      const published = new Promise((resolve) => {
        off = store.subscribe(id, resolve);
      });
      route = { ...route, ...patch };
      // The core publishes the route change and then the frame that carries it (the lane projects at the frame).
      for (const note of [
        { method: 'thread/route/updated', params: { threadId: id, value: route } },
        { method: 'thread/frame', params: { threadId: id, structureChanged: false } },
      ]) {
        fold = sessionReducer.apply(fold, note);
        for (const listener of listeners) listener({ type: 'thread', threadId: id });
      }
      await published;
      off();
    });
  function Harness() {
    const snapshot = useSessionLane(id, store, desktopConversationShellSnapshotsEqual);
    return React.createElement(ModelSelector, {
      ...snapshot,
      sessionId: id,
      fastCapable: true,
      modelDisabled: false,
      tuningDisabled: false,
      invokeResult: (action) => action(),
      applySnapshot() {},
      onOpenSettings() {},
    });
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await publish({});
    await act(async () => root.render(React.createElement(Harness)));
    assert.match(host.querySelector('.model-trigger').textContent, /Fast handoff test/);
    // Another control selects next/high while a running turn still uses the old model.
    await publish({ model: next.model, effort: 'high', sessionProvider: model.provider, sessionModel: model.model });
    assert.match(host.querySelector('.model-trigger').textContent, /Next route/);
    await act(async () => host.querySelector('.model-trigger').click());
    const effortRow = () =>
      [...document.querySelectorAll('.route-sheet-row')].find((row) => row.textContent.includes('Reasoning effort'));
    assert.match(effortRow().textContent, /High/);
    await publish({ effort: 'low' });
    assert.match(effortRow().textContent, /Low/);
    await publish({ model: model.model, effort: 'high' });
    assert.match(host.querySelector('.model-trigger').textContent, /Fast handoff test/);
    assert.match(effortRow().textContent, /High/);
  } finally {
    await act(async () => root.unmount());
    stop();
    lane.dispose();
    store.clear();
    host.remove();
  }
});

/** One followed session's ordered stream (the client library's fold, the desktop lane, the window's lane store) under the real
 *  picker. Every note the core sends moves the connection's received position; the lane publishes at the core's frames. */
async function mountedStreamPicker(id, state, body) {
  let seq = 1;
  let epoch = { epoch: 'e1', order: 1 };
  let fold = sessionReducer.initial({ thread: { id }, state, items: [], hasOlder: false });
  const listeners = new Set();
  const client = {
    pendingServerRequests: () => [],
    store: {
      thread: () => ({ feed: { id, epoch: epoch.epoch, seq }, order: epoch.order, state: fold }),
      section: () => undefined,
    },
  };
  const lane = createSessionLane({
    protocol: {
      client: () => client,
      onStoreChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onEvent: () => () => {},
      onReplaced: () => () => {},
      call: async () => ({ threads: [] }),
    },
  });
  const store = defaultSessionLaneStore;
  const stop = store.start((listener) => lane.subscribeSessionStates(listener));
  const oldPosition = window.mixdogDesktop.sessionStreamPosition;
  /** The position the connection has received (every note counted), as `sessionStreamPosition` answers it. */
  const received = () => ({ epoch: epoch.epoch, seq, order: epoch.order });
  const waitForPosition = (mark) => {
    if (store.streamReached(id, mark)) return Promise.resolve();
    return new Promise((resolve) => {
      const off = store.subscribeStreamPosition(id, () => {
        if (!store.streamReached(id, mark)) return;
        off();
        resolve();
      });
    });
  };
  window.mixdogDesktop.sessionStreamPosition = async (sessionId) => (sessionId === id ? received() : null);
  const settleFrames = () => new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  const announce = () => {
    for (const listener of listeners) listener({ type: 'thread', threadId: id });
  };
  /** Notes the core sends, received and folded in order; with `frame`, the frame that closes them follows. */
  const stream = (notes, { frame = true } = {}) =>
    act(async () => {
      for (const note of [
        ...notes,
        ...(frame ? [{ method: 'thread/frame', params: { structureChanged: false } }] : []),
      ]) {
        seq += 1;
        fold = sessionReducer.apply(fold, { ...note, params: { threadId: id, ...note.params } });
        announce();
      }
      if (frame) await waitForPosition(received());
      else await settleFrames();
    });
  /** The subscription is replaced (a resume after a reconnect): a new epoch, received after every earlier one, with its snapshot. */
  const resubscribe = (next) => {
    epoch = { epoch: `e${epoch.order + 1}`, order: epoch.order + 1 };
    seq = 1;
    fold = sessionReducer.initial({ thread: { id }, state: next, items: [], hasOlder: false });
    announce();
    const mark = received();
    return waitForPosition(mark).then(() => mark);
  };
  function Harness() {
    const snapshot = useSessionLane(id, store, desktopConversationShellSnapshotsEqual);
    if (!snapshot) return null;
    return React.createElement(ModelSelector, {
      ...snapshot,
      sessionId: id,
      fastCapable: true,
      modelDisabled: false,
      tuningDisabled: false,
      invokeResult: async (action) => {
        try {
          return await action();
        } catch {
          return undefined;
        }
      },
      applySnapshot() {},
      onOpenSettings() {},
      onRoutePreferenceApplied() {},
    });
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await stream([]);
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => host.querySelector('.model-trigger').click());
    await body({ host, stream, received, resubscribe, settleFrames });
  } finally {
    await act(async () => root.unmount());
    stop();
    lane.dispose();
    store.clear();
    host.remove();
    window.mixdogDesktop.sessionStreamPosition = oldPosition;
  }
}

const sheetRow = (label) =>
  [...document.querySelectorAll('.route-sheet-row')].find((row) => row.textContent.includes(label));

test('after a quota hop the composer keeps the edited conversation’s speed, effort and model when reopened', async () => {
  const primary = {
    ...model,
    provider: 'anthropic-oauth',
    model: 'fable',
    display: 'Fable',
    fastCapable: false,
    fastEfforts: [],
  };
  const fallback = {
    ...model,
    provider: 'openai-oauth',
    model: 'gpt-6.2-astra',
    display: 'Astra',
    fastEfforts: ['low', 'high'],
  };
  availableModels = [primary, fallback];
  providerSetup = { oauth: [primary, fallback].map(({ provider: id }) => ({ id, authenticated: true, usable: true })) };
  const id = 'stream-hop';
  const initial = {
    provider: primary.provider,
    model: primary.model,
    effort: 'high',
    fast: false,
    autoEffort: false,
    modelParameters: {},
  };
  const note = (value) => ({ method: 'thread/route/updated', params: { value } });
  const oldSetRoute = window.mixdogDesktop.setModelRoute;
  const oldFast = window.mixdogDesktop.setFast;
  const oldInvoke = window.mixdogDesktop.invokeCapability;
  const writes = [];
  const write = (pick, session) => {
    const answer = deferred();
    writes.push({ session, pick, answer });
    return answer.promise;
  };
  window.mixdogDesktop.setModelRoute = write;
  window.mixdogDesktop.setFast = (fast, session) => write({ fast }, session);
  window.mixdogDesktop.invokeCapability = (input) =>
    input.capability === 'setEffort'
      ? write({ effort: input.args[0], autoEffort: false }, input.sessionId)
      : oldInvoke(input);
  try {
    await mountedStreamPicker(id, { route: initial }, async ({ host, stream }) => {
      await act(async () => sheetRow('Reasoning effort').click());
      await act(async () => option('Low').click());
      const primaryWrite = writes.shift();
      assert.deepEqual(primaryWrite.pick, { effort: 'low', autoEffort: false });
      let selected = { ...initial, provider: fallback.provider, model: fallback.model };
      await stream([note(selected)]);
      await act(async () => primaryWrite.answer.resolve({}));
      assert.match(host.querySelector('.model-trigger').textContent, /Astra/);
      const pick = async (row, click, expected, shown) => {
        await act(async () => sheetRow(row).click());
        await act(async () => click());
        assert.ok(shown(), 'immediate preview');
        const write = writes.shift();
        assert.ok(write);
        assert.equal(write.session, id);
        for (const [key, value] of Object.entries(expected)) assert.equal(write.pick[key], value, key);
        selected = { ...selected, ...write.pick };
        await stream([note(selected)]);
        await act(async () => write.answer.resolve({}));
        await act(async () => host.querySelector('.model-trigger').click());
        await stream([{ method: 'thread/runtime/updated', params: { value: { busy: true } } }]);
        await act(async () => host.querySelector('.model-trigger').click());
        if (row !== 'Model') await act(async () => sheetRow(row).click());
        assert.ok(shown(), 'the reopened picker shows the published selection');
      };
      await pick(
        'Speed',
        () => option('Fast').click(),
        { fast: true },
        () => option('Fast')?.getAttribute('aria-checked') === 'true'
      );
      await pick(
        'Reasoning effort',
        () => option('Low').click(),
        { effort: 'low' },
        () => option('Low')?.getAttribute('aria-checked') === 'true'
      );
      await pick(
        'Model',
        () =>
          [...document.querySelectorAll('.model-group--provider [role="option"]')]
            .find((b) => b.textContent.includes(primary.display))
            .click(),
        { provider: primary.provider, model: primary.model },
        () => host.querySelector('.model-trigger').textContent.includes(primary.display)
      );
    });
  } finally {
    window.mixdogDesktop.setModelRoute = oldSetRoute;
    window.mixdogDesktop.setFast = oldFast;
    window.mixdogDesktop.invokeCapability = oldInvoke;
  }
});

// The review's sequence: this window picks, another device changes the same setting, both reach this window's stream before
// its own call answers, and the late answer must not put the pick back: once it answered, only the stream's value shows.
for (const setting of ['speed', 'model', 'effort', 'context']) {
  test(`a late ${setting} answer cannot mask what another device set after it on the stream`, async () => {
    const second = { ...model, model: 'gpt-stream-second', display: 'Stream second' };
    const windowed = { ...model, contextWindow: 400_000 };
    availableModels = setting === 'context' ? [windowed] : [model, second];
    const route = {
      provider: model.provider,
      model: model.model,
      effort: 'high',
      fast: false,
      autoEffort: false,
      modelParameters: {},
    };
    const routeNote = (patch) => ({ method: 'thread/route/updated', params: { value: { ...route, ...patch } } });
    const contextNote = (contextPercent) => ({
      method: 'thread/context/updated',
      params: { value: { contextPercent } },
    });
    const call = deferred();
    const oldSetRoute = window.mixdogDesktop.setModelRoute;
    const oldSetFast = window.mixdogDesktop.setFast;
    const oldInvoke = window.mixdogDesktop.invokeCapability;
    window.mixdogDesktop.setModelRoute = () => call.promise;
    window.mixdogDesktop.setFast = () => call.promise;
    window.mixdogDesktop.invokeCapability = (input) =>
      input.capability === 'setEffort' ? call.promise : oldInvoke(input);
    // What each setting's pick is, what this window's own mutation then publishes, what the other device publishes after it,
    // what the late answer would claim, and what the picker shows.
    const cases = {
      speed: {
        open: async () => sheetRow('Speed').click(),
        pick: async () => option('Fast').click(),
        own: [routeNote({ fast: true })],
        other: [routeNote({ fast: false })],
        answer: { ...route, fast: true },
        shows: (value) =>
          (value === 'pick' ? option('Fast') : option('Standard')).getAttribute('aria-checked') === 'true',
      },
      model: {
        open: async () => sheetRow('Model').click(),
        pick: async () =>
          [...document.querySelectorAll('[role="option"]')]
            .find((button) => button.textContent.includes(second.display))
            .click(),
        own: [routeNote({ model: second.model })],
        other: [routeNote({ model: model.model })],
        answer: { ...route, model: second.model },
        shows: (value, host) =>
          host.querySelector('.model-trigger').textContent.includes(value === 'pick' ? second.display : model.display),
      },
      effort: {
        open: async () => sheetRow('Reasoning effort').click(),
        pick: async () => option('Low').click(),
        own: [routeNote({ effort: 'low' })],
        other: [routeNote({ effort: 'high' })],
        answer: { value: 'low', snapshot: { ...route, effort: 'low' } },
        shows: (value) => option(value === 'pick' ? 'Low' : 'High').getAttribute('aria-checked') === 'true',
      },
      context: {
        open: async () => sheetRow('Context').click(),
        // At 50% of a 400K window the pane offers its default (100%).
        pick: async () => document.querySelector('.route-context-reset').click(),
        own: [contextNote(100)],
        other: [contextNote(30)],
        answer: { ...route, contextPercent: 100 },
        shows: (value) =>
          document.querySelector('.route-context-head strong').textContent === (value === 'pick' ? '100%' : '30%'),
      },
    };
    const step = cases[setting];
    const state = { route, context: { contextPercent: 50 } };
    try {
      await mountedStreamPicker(`stream-${setting}`, state, async ({ host, stream }) => {
        await act(step.open);
        await act(step.pick);
        assert.ok(step.shows('pick', host), 'the pick shows at once');
        // The pick's own mutation, then the other device's change, both framed before this window's call answers.
        await stream(step.own);
        await stream(step.other);
        assert.ok(step.shows('pick', host), 'while its call runs, the pick is previewed');
        await act(async () => call.resolve(step.answer));
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        assert.ok(step.shows('other', host), 'the answer ends the preview: the stream already carries a newer value');
        await stream([{ method: 'thread/runtime/updated', params: { value: { busy: false } } }]);
        assert.ok(step.shows('other', host), 'and it stays');
      });
    } finally {
      window.mixdogDesktop.setModelRoute = oldSetRoute;
      window.mixdogDesktop.setFast = oldSetFast;
      window.mixdogDesktop.invokeCapability = oldInvoke;
    }
  });
}

test('an answered pick stays previewed until the stream shows the state its call produced', async () => {
  const call = deferred();
  const oldFast = window.mixdogDesktop.setFast;
  window.mixdogDesktop.setFast = () => call.promise;
  availableModels = [model];
  const route = {
    provider: model.provider,
    model: model.model,
    effort: 'high',
    fast: false,
    autoEffort: false,
    modelParameters: {},
  };
  try {
    await mountedStreamPicker('stream-held', { route }, async ({ stream }) => {
      await act(async () => sheetRow('Speed').click());
      await act(async () => option('Fast').click());
      // The call's mutation reached the connection, but its frame has not: the lane still shows the old state.
      await stream([{ method: 'thread/route/updated', params: { value: { ...route, fast: true } } }], { frame: false });
      await act(async () => call.resolve({ ...route, fast: true }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(
        option('Fast').getAttribute('aria-checked'),
        'true',
        'no flash of the old value between answer and frame'
      );
      await stream([]);
      assert.equal(option('Fast').getAttribute('aria-checked'), 'true', 'the stream shows it');
      await stream([{ method: 'thread/route/updated', params: { value: { ...route, fast: false } } }]);
      assert.equal(
        option('Standard').getAttribute('aria-checked'),
        'true',
        'the preview has ended: the stream owns the value'
      );
    });
  } finally {
    window.mixdogDesktop.setFast = oldFast;
  }
});

// The core frames none of stage, model-request or tool-batch notes (phone_frame.rs): the position the call reads can sit on one.
test('an answer read at a trailing note that schedules no frame still ends its preview', async () => {
  const call = deferred();
  const oldFast = window.mixdogDesktop.setFast;
  window.mixdogDesktop.setFast = () => call.promise;
  availableModels = [model];
  const route = {
    provider: model.provider,
    model: model.model,
    effort: 'high',
    fast: false,
    autoEffort: false,
    modelParameters: {},
  };
  try {
    await mountedStreamPicker('stream-trailing', { route }, async ({ stream, received, settleFrames }) => {
      await act(async () => sheetRow('Speed').click());
      await act(async () => option('Fast').click());
      // The pick's own mutation, another device turning it off, then telemetry: the call answers with the feed quiet after it.
      await stream([{ method: 'thread/route/updated', params: { value: { ...route, fast: true } } }]);
      await stream([{ method: 'thread/route/updated', params: { value: { ...route, fast: false } } }]);
      await stream([{ method: 'thread/stage/updated', params: { value: { stage: 'requesting' } } }], { frame: false });
      const markAt = received().seq;
      await act(async () => call.resolve({ ...route, fast: true }));
      await act(async () => {
        await settleFrames();
        await Promise.resolve();
      });
      assert.equal(received().seq, markAt, 'nothing arrived after the note');
      assert.equal(
        option('Standard').getAttribute('aria-checked'),
        'true',
        'the preview ended at the note, not stranded past it'
      );
    });
  } finally {
    window.mixdogDesktop.setFast = oldFast;
  }
});

test('an answer whose position read races a replaced subscription still ends its preview', async () => {
  const call = deferred();
  const oldFast = window.mixdogDesktop.setFast;
  window.mixdogDesktop.setFast = () => call.promise;
  availableModels = [model];
  const route = {
    provider: model.provider,
    model: model.model,
    effort: 'high',
    fast: false,
    autoEffort: false,
    modelParameters: {},
  };
  try {
    await mountedStreamPicker('stream-epoch', { route }, async ({ stream, resubscribe }) => {
      await act(async () => sheetRow('Speed').click());
      await act(async () => option('Fast').click());
      // While the answered call reads its position, the subscription is replaced (epoch B, whose snapshot already carries
      // another device turning it off) and the lane publishes B; the read then names B.
      const positionRead = deferred();
      window.mixdogDesktop.sessionStreamPosition = () => {
        const mark = resubscribe({ route: { ...route, fast: false } });
        positionRead.resolve(mark);
        return mark;
      };
      await act(async () => {
        call.resolve({ ...route, fast: true });
        await positionRead.promise;
      });
      assert.equal(
        option('Standard').getAttribute('aria-checked'),
        'true',
        "B's snapshot reached the mark: the stream's value shows"
      );
      await stream([{ method: 'thread/runtime/updated', params: { value: { busy: false } } }]);
      assert.equal(option('Standard').getAttribute('aria-checked'), 'true', 'and a later frame of B keeps it');
    });
  } finally {
    window.mixdogDesktop.setFast = oldFast;
  }
});

test('a cold selected route never flashes its raw id or Select model while the full catalog is outstanding', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const oldList = window.mixdogDesktop.listProviderModels;
  const full = deferred();
  window.mixdogDesktop.listProviderModels = () => full.promise;
  try {
    await act(async () =>
      root.render(
        React.createElement(ModelSelector, {
          provider: model.provider,
          model: model.model,
          effort: 'high',
          fast: false,
          fastCapable: true,
          modelDisabled: false,
          tuningDisabled: false,
          invokeResult: (work) => work(),
          applySnapshot() {},
          onOpenSettings() {},
        })
      )
    );
    assert.ok(host.querySelector('[role="status"][aria-busy="true"]'));
    assert.doesNotMatch(host.textContent, /gpt-fast-handoff-test|Select model/);
    await act(async () => full.resolve([model]));
    assert.match(host.querySelector('.model-trigger').textContent, /Fast handoff test/);
    assert.equal(host.querySelector('[aria-busy="true"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop.listProviderModels = oldList;
  }
});

test('a mounted composer keeps its model list through an empty catalog answer until a real one replaces it (#205)', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const oldList = window.mixdogDesktop.listProviderModels;
  let answer = [model];
  window.mixdogDesktop.listProviderModels = async () => answer;
  const trigger = () => host.querySelector('.model-trigger').textContent;
  try {
    await act(async () =>
      root.render(
        React.createElement(ModelSelector, {
          provider: model.provider,
          model: model.model,
          effort: 'high',
          fast: false,
          fastCapable: true,
          modelDisabled: false,
          tuningDisabled: false,
          invokeResult: (work) => work(),
          applySnapshot() {},
          onOpenSettings() {},
        })
      )
    );
    assert.match(trigger(), /Fast handoff test/);

    // The daemon's boot-time miss: nothing listed. The composer keeps what it shows.
    answer = [];
    await act(async () => invalidateSharedModelCatalogRequest());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.match(trigger(), /Fast handoff test/);
    assert.equal(host.querySelector('[role="status"][aria-busy="true"]'), null);

    // The retry brings the real catalog, which replaces the shown list.
    answer = [{ ...model, display: 'Refilled catalog entry' }];
    await act(async () => invalidateSharedModelCatalogRequest());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.match(trigger(), /Refilled catalog entry/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop.listProviderModels = oldList;
    invalidateSharedModelCatalogRequest();
  }
});

for (const [id, levels] of [
  ['command-code/deepseek/deepseek-v4.1-flash', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['google-antigravity/gemini-3.8-flash', ['low', 'medium', 'high']],
]) {
  test(`full catalog controls survive reopening and remounting ${id}`, async () => {
    const provider = 'custom-catalog-authority';
    const fullModel = {
      ...model,
      provider,
      model: id,
      display: id,
      fastCapable: false,
      effortOptions: levels.map((value) => ({ value, label: value })),
      contextWindow: 450000,
    };
    const quickModel = { ...fullModel, effortOptions: [], contextWindow: 0 };
    const full = deferred();
    const oldList = window.mixdogDesktop.listProviderModels;
    window.mixdogDesktop.listProviderModels = ({ quick }) => (quick ? Promise.resolve([quickModel]) : full.promise);
    providerSetup = { api: [{ id: provider, authenticated: true, custom: true }] };
    const host = document.createElement('main');
    document.body.append(host);
    let root = createRoot(host);
    const selector = () =>
      React.createElement(ModelSelector, {
        provider,
        model: id,
        effort: 'medium',
        fast: false,
        fastCapable: false,
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: (work) => work(),
        applySnapshot() {},
        onOpenSettings() {},
      });
    const row = (label) =>
      [...document.querySelectorAll('.route-sheet-row')].find((button) => button.textContent.includes(label));
    try {
      await act(async () => root.render(selector()));
      await act(async () => host.querySelector('.model-trigger').click());
      assert.equal(row('Reasoning effort'), undefined, 'quick rows may initially lack tuning metadata');
      await act(async () => full.resolve([fullModel]));
      assert.ok(row('Reasoning effort'));
      assert.ok(row('Context'));

      await act(async () => row('Model').click());
      assert.ok(row('Reasoning effort'), 'reopening Model must not restore the thin quick answer');
      assert.ok(row('Context'));
      await act(async () => row('Reasoning effort').click());
      assert.deepEqual(
        [...document.querySelectorAll('[role="menuitemradio"]')].map((button) => button.textContent),
        levels
      );

      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () => root.render(selector()));
      await act(async () => host.querySelector('.model-trigger').click());
      assert.ok(row('Reasoning effort'), 'a remount must retain the resolved full catalog');
      assert.ok(row('Context'));
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.mixdogDesktop.listProviderModels = oldList;
    }
  });
}

test('fast mode stays optimistic until the authoritative snapshot paints', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let applyAuthoritativeFast;

  function Harness() {
    const [fast, setFast] = useState(false);
    // The session's stream shows the switch.
    applyAuthoritativeFast = () => setFast(true);
    return React.createElement(ModelSelector, {
      provider: model.provider,
      model: model.model,
      effort: 'high',
      fast,
      fastCapable: true,
      modelParameters: {},
      contextPercent: 100,
      modelDisabled: false,
      tuningDisabled: false,
      sessionId: 'session-fast-handoff',
      invokeResult: async (action) => {
        try {
          return await action();
        } catch {
          return undefined;
        }
      },
      applySnapshot() {},
      onOpenSettings() {},
      onRoutePreferenceApplied() {},
    });
  }

  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => document.querySelector('.model-trigger').click());
    const speedRow = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
      button.textContent.includes('Speed')
    );
    assert.ok(speedRow);
    await act(async () => speedRow.click());

    await act(async () => option('Fast').click());
    assert.equal(requests[0].enabled, true);
    assert.equal(option('Fast').getAttribute('aria-checked'), 'true');

    await act(async () =>
      requests[0].request.resolve({
        provider: model.provider,
        model: model.model,
        effort: 'high',
        fast: true,
      })
    );
    assert.equal(
      option('Fast').getAttribute('aria-checked'),
      'true',
      'IPC completion must not expose the stale false prop before snapshot paint'
    );

    await act(async () => applyAuthoritativeFast());
    assert.equal(option('Fast').getAttribute('aria-checked'), 'true');

    await act(async () => option('Standard').click());
    assert.equal(requests[1].enabled, false);
    assert.equal(option('Standard').getAttribute('aria-checked'), 'true');

    await act(async () => requests[1].request.reject(new Error('setFast failed')));
    assert.equal(
      option('Fast').getAttribute('aria-checked'),
      'true',
      'a failed request must roll back to the authoritative value'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

for (const recovery of ['local-install', 'desktop-reconnect', 'proxy-poll']) {
  test(`a mounted picker refreshes its provider setup and models after ${recovery}`, async (t) => {
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    const localModel = {
      provider: 'mixdog-local',
      model: 'qwen3.8-27b-q4-k-m',
      display: 'Qwen3.8 27B Q4_K_M',
      effortOptions: [],
      fastCapable: false,
      modelParameterOptions: [],
      parameterVariants: [],
      defaultModelParameters: {},
      savedModelParameters: {},
    };

    let retry;
    if (recovery !== 'local-install') {
      providerSetup = { managedByClient: true, unavailable: true, api: [], local: [] };
    }
    if (recovery === 'proxy-poll') {
      const schedule = window.setInterval.bind(window);
      t.mock.method(window, 'setInterval', (callback, ms, ...args) => {
        if (ms === 7_000) {
          retry = callback;
          return 700007;
        }
        return schedule(callback, ms, ...args);
      });
    }
    try {
      await act(async () =>
        root.render(
          React.createElement(ModelSelector, {
            provider: model.provider,
            model: model.model,
            effort: 'high',
            fast: false,
            fastCapable: true,
            modelParameters: {},
            contextPercent: 100,
            modelDisabled: false,
            tuningDisabled: false,
            sessionId: 'session-local-provider-refresh',
            invokeResult: async (action) => await action(),
            applySnapshot() {},
            onOpenSettings() {},
            onRoutePreferenceApplied() {},
          })
        )
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      availableModels = [model, localModel];
      providerSetup = {
        managedByClient: recovery !== 'local-install',
        api: [{ id: 'openai', authenticated: true, usable: true }],
        local: [{ id: 'mixdog-local', detected: true, enabled: true, usable: true }],
      };
      await act(async () => {
        if (recovery === 'local-install') invalidateSharedModelCatalogRequest();
        else if (recovery === 'desktop-reconnect') window.dispatchEvent(new window.Event('mixdog:remote-reconnected'));
        else {
          assert.ok(retry, 'failed proxy setup schedules a retry');
          retry();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => document.querySelector('.model-trigger').click());
      const modelRow = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
        button.textContent.includes('Model')
      );
      assert.ok(modelRow);
      await act(async () => modelRow.click());
      const localOption = [...document.querySelectorAll('[role="option"]')].find((button) =>
        button.textContent.includes('Qwen3.8 27B')
      );
      assert.ok(localOption);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
}

for (const outcome of ['success', 'failure']) {
  test(`model selection closes immediately and a late ${outcome} cannot disturb a newer menu or preference`, async () => {
    const second = { ...model, model: 'gpt-second-menu-test', display: 'Second menu test' };
    const third = { ...model, model: 'gpt-third-menu-test', display: 'Third menu test' };
    availableModels = [model, second, third];
    const oldSetRoute = window.mixdogDesktop.setModelRoute;
    const writes = [];
    const remembered = [];
    window.mixdogDesktop.setModelRoute = (selection) => {
      const request = deferred();
      writes.push({ selection, request });
      return request.promise;
    };
    const initial = {
      provider: model.provider,
      model: model.model,
      effort: 'high',
      fast: false,
      modelParameters: {},
    };
    let paint;
    function Harness() {
      const [snapshot, setSnapshot] = useState(initial);
      paint = setSnapshot;
      return React.createElement(ModelSelector, {
        ...snapshot,
        sessionId: 'session-model-menu',
        fastCapable: true,
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: async (action) => {
          try {
            return await action();
          } catch {
            return undefined;
          }
        },
        applySnapshot: setSnapshot,
        onOpenSettings() {},
        onRoutePreferenceApplied: (selection) => remembered.push(selection.model),
      });
    }
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    const row = (label) =>
      [...document.querySelectorAll('.route-sheet-row')].find((button) => button.textContent.includes(label));
    const choose = async (entry) => {
      await act(async () => row('Model').click());
      const button = [...document.querySelectorAll('.model-group--provider [role="option"]')].find((candidate) =>
        candidate.textContent.includes(entry.display)
      );
      assert.ok(button);
      await act(async () => button.click());
      assert.equal(
        document.querySelector('.route-sheet-flyout--model').hidden,
        true,
        'catalog closes on selection, not on acknowledgement'
      );
      assert.ok(document.querySelector('.model-trigger').textContent.includes(entry.display));
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => document.querySelector('.model-trigger').click());
      const sheet = document.querySelector('.route-sheet');
      await choose(second);
      await choose(third);
      await act(async () => paint({ ...initial, busy: true, commandBusy: true }));
      assert.ok(document.querySelector('.model-trigger').textContent.includes(third.display));
      await act(async () => writes[1].request.resolve({ ...initial, ...writes[1].selection }));
      await act(async () => row('Reasoning effort').click());
      const effort = option('High');
      assert.ok(effort);
      await act(async () => {
        if (outcome === 'success') {
          writes[0].request.resolve({ ...initial, ...writes[0].selection });
        } else {
          writes[0].request.reject(new Error('old selection failed'));
        }
      });
      assert.equal(document.querySelector('.route-sheet'), sheet);
      assert.equal(option('High'), effort, 'late replies must leave the newly opened menu intact');
      assert.ok(document.querySelector('.model-trigger').textContent.includes(third.display));
      assert.deepEqual(remembered, [third.model]);
      assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog.desktop-recent-models')), [
        `model:${third.provider}:${third.model}`,
      ]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.mixdogDesktop.setModelRoute = oldSetRoute;
    }
  });
}

test('a typed catalog filter does not survive the picker closing', async () => {
  const second = { ...model, model: 'gpt-typed-filter-test', display: 'Typed filter test' };
  availableModels = [model, second];
  const oldSetRoute = window.mixdogDesktop.setModelRoute;
  window.mixdogDesktop.setModelRoute = async (selection) => ({
    provider: selection.provider,
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    fast: selection.fast === true,
    modelParameters: {},
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const searchInput = () => document.querySelector('.route-sheet-flyout--model .model-search input');
  const catalogRows = () =>
    [...document.querySelectorAll('.route-sheet-flyout--model [role="option"]')].map((button) => button.textContent);
  const openModelPane = async () => {
    if (document.querySelector('.model-trigger').getAttribute('aria-expanded') !== 'true') {
      await act(async () => document.querySelector('.model-trigger').click());
    }
    const modelRow = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
      button.textContent.includes('Model')
    );
    assert.ok(modelRow);
    await act(async () => modelRow.click());
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(ModelSelector, {
          provider: model.provider,
          model: model.model,
          effort: 'high',
          fast: false,
          fastCapable: true,
          modelParameters: {},
          contextPercent: 100,
          modelDisabled: false,
          tuningDisabled: false,
          sessionId: 'session-typed-filter',
          invokeResult: async (action) => {
            try {
              return await action();
            } catch {
              return undefined;
            }
          },
          applySnapshot() {},
          onOpenSettings() {},
          onRoutePreferenceApplied() {},
        })
      )
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.ok(document.querySelector('.model-trigger').textContent.includes(model.display));
    assert.equal(searchInput(), null, 'the current model is shown without mounting the list');
    assert.deepEqual(_bootWarmupPendingForTest(), [], 'an unused model selector schedules no hidden mount');
    await openModelPane();
    // The native setter keeps React's value tracker honest, so the dispatched
    // input event reaches the picker's onInput instead of being deduped.
    await act(async () => {
      const input = searchInput();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Typed filter');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(
      catalogRows().map((text) => text.includes('Typed filter test')),
      [true],
      'the typed filter trims the catalog to its match'
    );

    await act(async () => document.querySelector('.route-sheet-flyout--model [role="option"]').click());
    assert.equal(document.querySelector('.route-sheet-flyout--model').hidden, true, 'selection closes the catalog');

    await openModelPane();
    assert.equal(searchInput().value, '', 'a closed picker must not keep its typed filter');
    assert.ok(
      catalogRows().some((text) => text.includes('Fast handoff test')),
      'the reopened catalog lists every model again'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop.setModelRoute = oldSetRoute;
  }
});

for (const field of ['model', 'effort']) {
  test(`${field} selection survives busy snapshots and delayed acknowledgement, but rolls back on failure`, async () => {
    const secondModel = { ...model, model: 'gpt-second-handoff-test', display: 'Second handoff test' };
    availableModels = [model, secondModel];
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    const oldInvoke = window.mixdogDesktop.invokeCapability;
    const oldSetRoute = window.mixdogDesktop.setModelRoute;
    let request;
    let requestedSelection;
    let paint;
    const initial = {
      provider: model.provider,
      model: model.model,
      effort: 'high',
      fast: false,
      modelParameters: {},
      contextPercent: 100,
    };
    window.mixdogDesktop.setModelRoute = (selection) => {
      requestedSelection = selection;
      request = deferred();
      return request.promise;
    };
    window.mixdogDesktop.invokeCapability = (input) => {
      if (input.capability !== 'setEffort') return oldInvoke(input);
      requestedSelection = { effort: input.args[0] };
      request = deferred();
      return request.promise;
    };
    function Harness() {
      const [snapshot, setSnapshot] = useState(initial);
      paint = setSnapshot;
      return React.createElement(ModelSelector, {
        ...snapshot,
        fastCapable: true,
        sessionId: 'session-busy-selection',
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: async (action) => {
          try {
            return await action();
          } catch {
            return undefined;
          }
        },
        applySnapshot() {},
        onOpenSettings() {},
        onRoutePreferenceApplied() {},
      });
    }
    const openModelPane = async () => {
      if (document.querySelector('.model-trigger').getAttribute('aria-expanded') !== 'true') {
        await act(async () => document.querySelector('.model-trigger').click());
      }
      const row = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
        button.textContent.includes('Model')
      );
      await act(async () => row.click());
    };
    const choose = async (next) => {
      if (field === 'model') {
        await openModelPane();
        const label = next ? secondModel.display : model.display;
        const entry = [...document.querySelectorAll('[role="option"]')].find((button) =>
          button.textContent.includes(label)
        );
        assert.ok(entry);
        await act(async () => entry.click());
      } else {
        await act(async () => option(next ? 'Low' : 'High').click());
      }
    };
    const assertChosen = () => {
      if (field === 'model') {
        assert.ok(document.querySelector('.model-trigger').textContent.includes(secondModel.display));
      } else {
        assert.equal(option('Low').getAttribute('aria-checked'), 'true');
      }
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      if (field === 'effort') {
        await act(async () => document.querySelector('.model-trigger').click());
        const row = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
          button.textContent.includes('Reasoning effort')
        );
        await act(async () => row.click());
      }
      await choose(true);
      assertChosen();
      await act(async () => paint({ ...initial, busy: true }));
      assertChosen();
      const resolved = { ...initial, ...requestedSelection };
      await act(async () => request.resolve(field === 'effort' ? { value: 'low', snapshot: resolved } : resolved));
      assertChosen();
      await act(async () => paint({ ...initial, busy: true, spinner: { text: 'working' } }));
      assertChosen();
      const completedRequest = request;
      await choose(false);
      assert.notEqual(
        request,
        completedRequest,
        'a completed mutation must allow another selection even before its snapshot paints'
      );
      // The session's stream shows the first pick; the second one fails and the stream's value shows again.
      await act(async () => paint(resolved));
      await act(async () => request.reject(new Error('route update failed')));
      assertChosen();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.mixdogDesktop.invokeCapability = oldInvoke;
      window.mixdogDesktop.setModelRoute = oldSetRoute;
    }
  });
}

test('an explicit effort pick on an Auto route turns its Auto effort off, in a session and in a draft', async () => {
  const { publishAutoEffort } = await import('./auto-effort-store.ts');
  const autoModel = {
    ...model,
    model: 'gpt-auto-effort-pick-test',
    display: 'Pick test model',
    fastCapable: false,
    autoEffortCapable: true,
  };
  availableModels = [autoModel];
  window.mixdogDesktop.routeAutoEffort = true;
  const master = { installed: true, enabled: true, supported: true };
  publishAutoEffort({ autoEffort: master });
  const oldInvoke = window.mixdogDesktop.invokeCapability;
  let request;
  const effortCalls = [];
  window.mixdogDesktop.invokeCapability = (input) => {
    if (input.capability === 'getToolModuleSettings') return Promise.resolve({ value: { autoEffort: master } });
    if (input.capability !== 'setEffort') return oldInvoke(input);
    effortCalls.push(input.args);
    request = deferred();
    return request.promise;
  };
  const applied = [];
  const drafts = [];
  const host = document.createElement('main');
  document.body.append(host);
  let root = createRoot(host);
  const selector = (extra) =>
    React.createElement(ModelSelector, {
      provider: autoModel.provider,
      model: autoModel.model,
      effort: 'high',
      fast: false,
      fastCapable: false,
      autoEffort: true,
      modelParameters: {},
      modelDisabled: false,
      tuningDisabled: false,
      invokeResult: (work) => work(),
      applySnapshot() {},
      onOpenSettings() {},
      ...extra,
    });
  const pickLow = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(host.querySelector('.model-trigger').textContent, /Auto/);
    await act(async () => host.querySelector('.model-trigger').click());
    const row = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
      button.textContent.includes('Reasoning effort')
    );
    await act(async () => row.click());
    await act(async () => option('Low').click());
  };
  try {
    await act(async () =>
      root.render(selector({ sessionId: 'session-auto-pick', onRoutePreferenceApplied: (s) => applied.push(s) }))
    );
    await pickLow();
    assert.deepEqual(effortCalls, [['low']]);
    assert.doesNotMatch(host.querySelector('.model-trigger').textContent, /Auto/, 'the picked level previews at once');
    await act(async () =>
      request.resolve({
        value: 'low',
        snapshot: {
          provider: autoModel.provider,
          model: autoModel.model,
          effort: 'low',
          fast: false,
          autoEffort: false,
        },
      })
    );
    assert.equal(applied.at(-1).effort, 'low');
    assert.equal(applied.at(-1).autoEffort, false, 'the remembered route keeps Auto off');

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(selector({ onDraftSelection: (s) => drafts.push(s) })));
    await pickLow();
    assert.equal(drafts.at(-1).effort, 'low');
    assert.equal(drafts.at(-1).autoEffort, false, 'a new task started from the draft keeps the picked level');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop.invokeCapability = oldInvoke;
    delete window.mixdogDesktop.routeAutoEffort;
    publishAutoEffort({ autoEffort: { installed: false, enabled: false, supported: true } });
  }
});

test('a route picker that opts out of Auto shows only the effort levels', async () => {
  const { ModelRouteEditor } = await import('./ModelRouteEditor.tsx');
  const { publishAutoEffort } = await import('./auto-effort-store.ts');
  const oldFlag = window.mixdogDesktop.routeAutoEffort;
  window.mixdogDesktop.routeAutoEffort = true;
  publishAutoEffort({ autoEffort: { installed: true, enabled: true, supported: true } });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(ModelRouteEditor, {
          models: [model],
          value: { provider: model.provider, model: model.model, effort: 'high' },
          onChange() {},
        })
      )
    );
    await act(async () => host.querySelector('.model-trigger').click());
    const effort = [...document.querySelectorAll('.route-sheet-row')].find((row) =>
      row.textContent.includes('Reasoning effort')
    );
    await act(async () => effort.click());
    assert.ok(option('High'));
    assert.equal(document.querySelector('[data-effort-option^="auto"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop.routeAutoEffort = oldFlag;
    publishAutoEffort({ autoEffort: { installed: false, enabled: false, supported: true } });
  }
});

const ultraModel = {
  ...model,
  model: 'gpt-ultra-test',
  display: 'Ultra test',
  fastEfforts: ['high', 'low'],
  modelParameterOptions: [
    {
      id: 'serviceTier',
      label: 'Speed',
      kind: 'enum',
      options: [
        { value: 'priority', label: 'Fast' },
        { value: 'ultrafast', label: 'Ultrafast' },
      ],
    },
  ],
};

async function openSpeedPane(selectorProps) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  availableModels = [model, ultraModel];
  await act(async () =>
    root.render(
      React.createElement(ModelSelector, {
        effort: 'high',
        fastCapable: true,
        contextPercent: 100,
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: (work) => work(),
        applySnapshot() {},
        onOpenSettings() {},
        ...selectorProps,
      })
    )
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => document.querySelector('.model-trigger').click());
  const speedRow = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
    button.textContent.includes('Speed')
  );
  await act(async () => speedRow.click());
  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the speed pane offers Ultrafast only for models with the serviceTier option and routes it', async () => {
  const drafts = [];
  const plain = await openSpeedPane({
    provider: model.provider,
    model: model.model,
    fast: false,
    modelParameters: {},
    onDraftSelection: (selection) => drafts.push(selection),
  });
  assert.equal(option('Ultrafast'), undefined);
  assert.ok(option('Standard') && option('Fast'));
  await plain.cleanup();

  const ultra = await openSpeedPane({
    provider: ultraModel.provider,
    model: ultraModel.model,
    fast: true,
    modelParameters: { serviceTier: 'priority' },
    onDraftSelection: (selection) => drafts.push(selection),
  });
  assert.equal(option('Fast').getAttribute('aria-checked'), 'true');
  assert.equal(option('Ultrafast').getAttribute('aria-checked'), 'false');
  assert.match(option('Ultrafast').textContent, /Fastest speed, highest usage/);
  assert.equal(document.body.textContent.includes('Speed'), true);
  await act(async () => option('Ultrafast').click());
  assert.equal(drafts.at(-1).fast, true);
  assert.equal(drafts.at(-1).modelParameters.serviceTier, 'ultrafast');
  await act(async () => option('Standard').click());
  assert.equal(drafts.at(-1).fast, false);
  await ultra.cleanup();

  const selected = await openSpeedPane({
    provider: ultraModel.provider,
    model: ultraModel.model,
    fast: true,
    modelParameters: { serviceTier: 'ultrafast' },
    onDraftSelection: (selection) => drafts.push(selection),
  });
  assert.equal(option('Ultrafast').getAttribute('aria-checked'), 'true');
  assert.equal(option('Fast').getAttribute('aria-checked'), 'false');
  await act(async () => option('Fast').click());
  assert.equal(drafts.at(-1).modelParameters.serviceTier, 'priority');
  assert.equal(drafts.at(-1).fast, true);
  await selected.cleanup();
});

test('a model without a Speed row gets a generic Service tier row; the Ultrafast Speed row does not', async () => {
  const tierModel = {
    ...model,
    model: 'vertex-tier-test',
    display: 'Tier test',
    fastCapable: false,
    fastEfforts: [],
    modelParameterOptions: [
      {
        id: 'serviceTier',
        label: 'Service tier',
        kind: 'enum',
        options: [
          { value: 'standard', label: 'Standard' },
          { value: 'flex', label: 'Flex' },
          { value: 'priority', label: 'Priority' },
        ],
      },
    ],
  };
  const drafts = [];
  const openSheet = async (target, fastCapable) => {
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    availableModels = [target];
    await act(async () =>
      root.render(
        React.createElement(ModelSelector, {
          effort: 'high',
          fastCapable,
          contextPercent: 100,
          modelDisabled: false,
          tuningDisabled: false,
          invokeResult: (work) => work(),
          applySnapshot() {},
          onOpenSettings() {},
          provider: target.provider,
          model: target.model,
          fast: false,
          modelParameters: {},
          onDraftSelection: (selection) => drafts.push(selection),
        })
      )
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => document.querySelector('.model-trigger').click());
    return async () => {
      await act(async () => root.unmount());
      host.remove();
    };
  };
  const tierRow = () =>
    [...document.querySelectorAll('.route-sheet-row')].find((button) => button.textContent.includes('Service tier'));

  const closeTier = await openSheet(tierModel, false);
  assert.ok(tierRow());
  await act(async () => tierRow().click());
  assert.ok(option('Standard') && option('Flex') && option('Priority'));
  await act(async () => option('Priority').click());
  assert.equal(drafts.at(-1).modelParameters.serviceTier, 'priority');
  await closeTier();

  const closeUltra = await openSheet(ultraModel, true);
  assert.equal(tierRow(), undefined);
  await closeUltra();
});

test('/fast parsing accepts ultra and executes Ultrafast only when the model offers it', async () => {
  const { parseFastArgument, createSlashExecutor } = await import('./composer-slash-executor.ts');
  assert.equal(parseFastArgument('ultra', false), 'ultrafast');
  assert.equal(parseFastArgument('ON', false), 'fast');
  assert.equal(parseFastArgument('off', true), 'standard');
  assert.equal(parseFastArgument('', true), 'standard');
  assert.equal(parseFastArgument('bogus', false), null);

  const run = async (capable, argument) => {
    const out = { errors: [], notices: [], drafts: [] };
    const ok = await createSlashExecutor({
      draftMode: true,
      turnBusy: false,
      provider: 'openai',
      model: 'm',
      effort: 'high',
      fast: false,
      fastCapable: true,
      modelParameters: {},
      ultrafastCapable: () => capable,
      onDraftModelSelection: (selection) => out.drafts.push(selection),
      setAttachmentError: (message) => out.errors.push(message),
      showNotice: (message) => out.notices.push(message),
      clearNotice() {},
    })(`/fast ${argument}`);
    return { ok, ...out };
  };
  const refused = await run(false, 'ultra');
  assert.equal(refused.ok, false);
  assert.match(refused.errors.at(-1), /Ultrafast is not available/);
  const accepted = await run(true, 'ultra');
  assert.equal(accepted.drafts[0].fast, true);
  assert.equal(accepted.drafts[0].modelParameters.serviceTier, 'ultrafast');
  const on = await run(true, 'on');
  assert.equal(on.drafts[0].modelParameters.serviceTier, 'priority');
  const bad = await run(true, 'nope');
  assert.equal(bad.errors.at(-1), 'Usage: /fast [on|off|ultra]');
});

test('exact context tokens: input parsing, clamping, and the default/stop collapse', async () => {
  const {
    parseContextTokensInput,
    clampContextTokens,
    contextTokensChange,
    routedExactContextTokens,
    exactContextPercent,
  } = await import('./route-editor-context.ts');
  assert.equal(parseContextTokensInput('500'), 500000);
  assert.equal(parseContextTokensInput('500k'), 500000);
  assert.equal(parseContextTokensInput('0.5m'), 500000);
  assert.equal(parseContextTokensInput('abc'), null);
  assert.equal(parseContextTokensInput('1,000'), 1000000);
  for (const malformed of ['500garbage', '1.2.3', '5m0', 'k', '', '-5', '500 kb']) {
    assert.equal(parseContextTokensInput(malformed), null, malformed);
  }
  const max = 872000;
  assert.equal(clampContextTokens(1000, max), 88000);
  assert.equal(clampContextTokens(5_000_000, max), max);
  assert.equal(clampContextTokens(640400, max), 640000);
  const window = { defaultPercent: 60, defaultTokens: 500000, maxTokens: max };
  assert.deepEqual(contextTokensChange(500000, window), { percent: 60 });
  assert.deepEqual(contextTokensChange(max, window), { percent: 100 });
  assert.deepEqual(contextTokensChange(640000, window), { percent: 70, tokens: 640000 });
  assert.equal(exactContextPercent(640000, max), 73.4);
  assert.equal(routedExactContextTokens(500000, 500000, max), 0);
  assert.equal(routedExactContextTokens(640000, 500000, max), 640000);
  assert.equal(routedExactContextTokens(undefined, 500000, max), 0);
});
