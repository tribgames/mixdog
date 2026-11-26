import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const xtermState = {
  terminals: [],
  fits: [],
  webgls: [],
  disposeOrder: [],
};
globalThis.__mixdogXtermTestState = xtermState;

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;

const xtermStubUrl = dataModule(`
  export class Terminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.element = null;
      this.textarea = null;
      this.disposed = false;
      this.writes = [];
      this.addons = [];
      this.modes = { applicationCursorKeysMode: false };
      this.buffer = { active: { type: 'normal', baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, getLine: () => null } };
      globalThis.__mixdogXtermTestState.terminals.push(this);
    }
    loadAddon(addon) { this.addons.push(addon); }
    attachCustomKeyEventHandler() {}
    open(container) {
      const el = container.ownerDocument.createElement('div');
      el.className = 'xterm';
      const screen = container.ownerDocument.createElement('div');
      screen.className = 'xterm-screen';
      el.appendChild(screen);
      this.element = el;
      container.appendChild(el);
    }
    write(data, cb) {
      if (this.disposed) throw new Error('write after dispose');
      this.writes.push(String(data));
      cb?.();
    }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; }
    scrollToLine(line) { this.buffer.active.viewportY = line; }
    refresh() {}
    reset() { this.writes.length = 0; }
    focus() {}
    paste(text) { this.writes.push(String(text)); }
    onData() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    dispose() {
      globalThis.__mixdogXtermTestState.disposeOrder.push('term.dispose');
      this.disposed = true;
      this.element?.remove();
    }
  }
`);

const fitStubUrl = dataModule(`
  export class FitAddon {
    constructor() {
      this.disposed = false;
      globalThis.__mixdogXtermTestState.fits.push(this);
    }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
    fit() {}
    dispose() { this.disposed = true; }
  }
`);

const webglStubUrl = dataModule(`
  export class WebglAddon {
    constructor() {
      this.disposed = false;
      globalThis.__mixdogXtermTestState.webgls.push(this);
    }
    onContextLoss() {
      return {
        dispose() {
          globalThis.__mixdogXtermTestState.disposeOrder.push('contextLoss.dispose');
        },
      };
    }
    clearTextureAtlas() {}
    dispose() {
      globalThis.__mixdogXtermTestState.disposeOrder.push('webgl.dispose');
      this.disposed = true;
    }
  }
`);

const emptyCssUrl = dataModule('');

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@xterm/xterm') return { url: xtermStubUrl, shortCircuit: true };
    if (specifier === '@xterm/addon-fit') return { url: fitStubUrl, shortCircuit: true };
    if (specifier === '@xterm/addon-webgl') return { url: webglStubUrl, shortCircuit: true };
    if (specifier.endsWith('.css')) return { url: emptyCssUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
test.after(() => hooks.deregister());

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'],
});
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

function installFakeDesktop() {
  const replays = new Map();
  const attachedTabs = new Set();
  const dataListeners = new Set();
  const sizeOwnerListeners = new Set();
  const ensured = [];
  const detached = [];
  const disposed = [];
  const acked = [];

  window.mixdogDesktop = {
    termEnsure: async (id) => {
      const tabId = id || 'generated-1';
      ensured.push(tabId);
      if (!replays.has(tabId)) replays.set(tabId, '');
      attachedTabs.add(tabId);
      return { id: tabId, replay: replays.get(tabId) };
    },
    termAttach: async (id) => {
      if (!replays.has(id)) return null;
      attachedTabs.add(id);
      return { id, replay: replays.get(id) };
    },
    termDetach: (id) => {
      detached.push(id);
      attachedTabs.delete(id);
    },
    termDispose: async (id) => {
      disposed.push(id);
      attachedTabs.delete(id);
      replays.delete(id);
    },
    termAcknowledge: (id, charCount) => {
      acked.push({ id, charCount });
    },
    termResize: () => {},
    termWrite: () => {},
    termFocus: () => {},
    termProfiles: async () => [],
    subscribeTermData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    subscribeTermSizeOwner: (listener) => {
      sizeOwnerListeners.add(listener);
      return () => sizeOwnerListeners.delete(listener);
    },
    subscribeTermActivity: () => () => {},
  };

  return {
    ensured,
    detached,
    disposed,
    acked,
    attachedTabs,
    dataListeners,
    sizeOwnerListeners,
    replays,
    emitOutput(id, data) {
      replays.set(id, (replays.get(id) || '') + data);
      if (!attachedTabs.has(id)) return;
      for (const listener of [...dataListeners]) listener({ id, data });
    },
  };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 15)));

const { default: TerminalPane, disposeTerminalPane, prewarmTerminal } = await import('./TerminalPane.tsx');
const { createTerminalApi } = await import('./core-direct/api-terminal.ts');
const { terminalPaneModule } = await import('./lazy-widgets.ts');
await terminalPaneModule.load();
const { SessionTerminalTabs } = await import('./SessionTerminalTabs.tsx');
const { openSessionTerminalTab, selectSessionTerminalTab, getSessionTerminalTabs } = await import(
  './session-terminal-tabs.ts'
);

test('hiding a TerminalPane disposes xterm, FitAddon and WebGL while keeping the PTY alive and restoring output from replay on reopen', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  xtermState.webgls.length = 0;
  const desktop = installFakeDesktop();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-1', cwd: 'C:/proj', active: true }));
    });
    await flush();

    assert.equal(xtermState.terminals.length, 1);
    assert.equal(xtermState.fits.length, 1);
    const firstTerm = xtermState.terminals[0];
    const firstFit = xtermState.fits[0];
    assert.equal(firstTerm.disposed, false);
    assert.equal(firstFit.disposed, false);

    desktop.emitOutput('term-1', 'hello\r\n');
    await flush();
    assert.equal(firstTerm.writes.join(''), 'hello\r\n');

    // Unmount (terminal hidden): xterm, FitAddon and WebGL are disposed, feed is detached, PTY is NOT disposed.
    await act(async () => {
      root.render(null);
    });
    assert.equal(firstTerm.disposed, true, 'xterm Terminal must be disposed when hidden');
    assert.equal(firstFit.disposed, true, 'FitAddon must be disposed when hidden');
    assert.equal(desktop.sizeOwnerListeners.size, 0, 'size-owner listener releases when no terminals are mounted');
    assert.equal(desktop.dataListeners.size, 0, 'no output listener remains subscribed while hidden');
    assert.deepEqual(desktop.detached, ['term-1'], 'hiding detaches this window from the terminal feed');
    assert.deepEqual(desktop.disposed, [], 'hiding a terminal must not dispose its core PTY');

    // Output produced while hidden accumulates in the core PTY without delivering to the detached window.
    desktop.emitOutput('term-1', 'while-hidden\r\n');
    assert.equal(firstTerm.writes.join(''), 'hello\r\n');

    // Show again: fresh xterm mounts and restores full output from the core's PTY replay.
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-1', cwd: 'C:/proj', active: true }));
    });
    await flush();

    assert.equal(xtermState.terminals.length, 2);
    const secondTerm = xtermState.terminals[1];
    assert.equal(secondTerm.disposed, false);
    assert.equal(secondTerm.writes.join(''), 'hello\r\nwhile-hidden\r\n');

    // Live output resumes on the restored xterm.
    desktop.emitOutput('term-1', 'after-return\r\n');
    await flush();
    assert.equal(secondTerm.writes.join(''), 'hello\r\nwhile-hidden\r\nafter-return\r\n');

    // Explicit close disposes both xterm and the backend PTY.
    await act(async () => {
      await disposeTerminalPane('term-1');
    });
    assert.equal(secondTerm.disposed, true);
    assert.deepEqual(desktop.disposed, ['term-1']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting a reopened TerminalPane before ensure, replay, or viewport restore completes preserves saved localStorage view state', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const saved = { cols: 120, rows: 35, scrollY: 42, atBottom: false };
  window.localStorage.setItem('mixdog.desktop-terminal-view.v1', JSON.stringify({ 'term-saved': saved }));

  let resolveEnsure;
  const desktop = installFakeDesktop();
  desktop.replays.set('term-saved', 'line1\r\nline2\r\n');
  window.mixdogDesktop.termEnsure = (id) =>
    new Promise((resolve) => {
      resolveEnsure = () => {
        desktop.attachedTabs.add(id);
        resolve({ id, replay: desktop.replays.get(id) });
      };
    });

  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400 });
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Mount and unmount BEFORE termEnsure resolves: default 80x24 / scrollY:0 must NOT overwrite localStorage.
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-saved', cwd: 'C:/proj', active: true }));
    });
    await act(async () => {
      root.render(null);
    });
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem('mixdog.desktop-terminal-view.v1'))['term-saved'],
      saved,
      'unmounting before termEnsure settles must not clobber saved view state'
    );
    // Late ensure answer after unmount detaches the feed instead of disposing the PTY.
    resolveEnsure();
    await flush();
    assert.deepEqual(desktop.detached, ['term-saved']);
    assert.deepEqual(desktop.disposed, []);

    // 2. Mount and let termEnsure resolve, but unmount BEFORE the deferred replay write finishes.
    let finishReplayWrite;
    const realWrite = xtermState.terminals[0].constructor.prototype.write;
    xtermState.terminals[0].constructor.prototype.write = function (data, cb) {
      this.writes.push(String(data));
      finishReplayWrite = cb;
    };
    try {
      await act(async () => {
        root.render(React.createElement(TerminalPane, { terminalId: 'term-saved', cwd: 'C:/proj', active: true }));
      });
      resolveEnsure();
      await flush();
      assert.equal(typeof finishReplayWrite, 'function', 'replay write is still pending');
      await act(async () => {
        root.render(null);
      });
      finishReplayWrite();
      assert.deepEqual(
        JSON.parse(window.localStorage.getItem('mixdog.desktop-terminal-view.v1'))['term-saved'],
        saved,
        'unmounting mid-replay must not clobber saved view state'
      );
    } finally {
      xtermState.terminals[0].constructor.prototype.write = realWrite;
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.localStorage.removeItem('mixdog.desktop-terminal-view.v1');
  }
});

test('switching tabs in SessionTerminalTabs releases the inactive tab xterm and restores it from replay on switch back', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const desktop = installFakeDesktop();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(SessionTerminalTabs, { sessionId: 'tab-mem', cwd: 'C:/proj', active: true }));
    });
    await flush();

    const tab1Id = getSessionTerminalTabs('tab-mem').activeId;
    assert.equal(xtermState.terminals.length, 1);
    const tab1First = xtermState.terminals[0];
    desktop.emitOutput(tab1Id, 'tab1-output\r\n');
    await flush();
    assert.equal(tab1First.writes.join(''), 'tab1-output\r\n');

    // Opening tab 2 unmounts tab 1's xterm without disposing tab 1's PTY.
    let tab2;
    await act(async () => {
      tab2 = openSessionTerminalTab('tab-mem', '', 'C:/proj');
    });
    await flush();

    assert.equal(tab1First.disposed, true, 'inactive tab xterm must be released on tab switch');
    assert.deepEqual(desktop.disposed, []);
    assert.equal(xtermState.terminals.length, 2);
    const tab2Term = xtermState.terminals[1];
    assert.equal(tab2Term.disposed, false);
    desktop.emitOutput(tab2.id, 'tab2-output\r\n');
    await flush();
    assert.equal(tab2Term.writes.join(''), 'tab2-output\r\n');

    // Switching back to tab 1 disposes tab 2's xterm and restores tab 1's output from replay.
    await act(async () => {
      selectSessionTerminalTab('tab-mem', tab1Id);
    });
    await flush();

    assert.equal(tab2Term.disposed, true);
    assert.equal(xtermState.terminals.length, 3);
    const tab1Restored = xtermState.terminals[2];
    assert.equal(tab1Restored.writes.join(''), 'tab1-output\r\n');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting TerminalPane disposes Terminal before WebglAddon to avoid synchronous DOM renderer fallback', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  xtermState.webgls.length = 0;
  xtermState.disposeOrder.length = 0;
  installFakeDesktop();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-webgl-order', cwd: 'C:/proj', active: true }));
    });
    await flush();
    assert.equal(xtermState.webgls.length, 1, 'WebGL addon loaded while active');

    // Unmounting drops context-loss listener first, disposes Terminal before WebglAddon so xterm sees _isDisposed.
    xtermState.disposeOrder.length = 0;
    await act(async () => {
      root.render(null);
    });
    const contextIdx = xtermState.disposeOrder.indexOf('contextLoss.dispose');
    const termIdx = xtermState.disposeOrder.indexOf('term.dispose');
    const webglIdx = xtermState.disposeOrder.indexOf('webgl.dispose');
    assert.ok(contextIdx >= 0 && termIdx >= 0 && webglIdx >= 0, `unexpected dispose order: ${xtermState.disposeOrder}`);
    assert.ok(contextIdx < termIdx, `contextLoss must dispose before Terminal: ${xtermState.disposeOrder}`);
    assert.ok(termIdx < webglIdx, `Terminal must dispose before standalone WebglAddon: ${xtermState.disposeOrder}`);

    // Contrast: hiding while mounted (active=false) still releases WebglAddon without disposing Terminal.
    xtermState.disposeOrder.length = 0;
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-webgl-hide', cwd: 'C:/proj', active: true }));
    });
    await flush();
    xtermState.disposeOrder.length = 0;
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-webgl-hide', cwd: 'C:/proj', active: false }));
    });
    assert.deepEqual(xtermState.disposeOrder, ['contextLoss.dispose', 'webgl.dispose']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting TerminalPane while shell-change termDispose is pending skips spawning a replacement PTY', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const desktop = installFakeDesktop();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId: 'term-shell-race',
          cwd: 'C:/proj',
          shell: 'pwsh',
          active: true,
        })
      );
    });
    await flush();
    assert.equal(desktop.ensured.length, 1);

    let resolveDispose;
    window.mixdogDesktop.termDispose = (id) => {
      desktop.disposed.push(id);
      return new Promise((resolve) => {
        resolveDispose = resolve;
      });
    };

    // Change shell to trigger termDispose, then unmount before termDispose settles.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId: 'term-shell-race',
          cwd: 'C:/proj',
          shell: 'bash',
          active: true,
        })
      );
    });
    await flush();
    assert.equal(typeof resolveDispose, 'function', 'shell change awaits termDispose');

    await act(async () => {
      root.render(null);
    });
    resolveDispose();
    await flush();

    assert.deepEqual(desktop.disposed, ['term-shell-race']);
    assert.equal(desktop.ensured.length, 1, 'disposed pane must not call termEnsure after awaiting termDispose');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting TerminalPane while ensure is pending and immediately remounting does not detach the reopened feed', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const desktop = installFakeDesktop();
  desktop.replays.set('term-remount', 'initial\r\n');
  const resolvers = [];
  window.mixdogDesktop.termEnsure = (id) =>
    new Promise((resolve) => {
      desktop.ensured.push(id);
      resolvers.push(() => {
        desktop.attachedTabs.add(id);
        resolve({ id, replay: desktop.replays.get(id) });
      });
    });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // Mount 1 starts termEnsure, then unmounts before ensure resolves.
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-remount', cwd: 'C:/proj', active: true }));
    });
    assert.equal(resolvers.length, 1);

    await act(async () => {
      root.render(null);
    });

    // Mount 2 immediately remounts before Mount 1's ensure resolves.
    await act(async () => {
      root.render(React.createElement(TerminalPane, { terminalId: 'term-remount', cwd: 'C:/proj', active: true }));
    });
    assert.equal(resolvers.length, 2);

    // Mount 2 settles and receives live output; then stale Mount 1's ensure settles late.
    resolvers[1]();
    await flush();
    const reopenedTerm = xtermState.terminals[1];
    desktop.emitOutput('term-remount', 'before-late-resolve\r\n');
    await flush();
    assert.equal(reopenedTerm.writes.join(''), 'initial\r\nbefore-late-resolve\r\n');

    resolvers[0]();
    await flush();
    assert.deepEqual(desktop.detached, [], 'stale disposed mount must not detach the active reopened feed');
    assert.equal(desktop.attachedTabs.has('term-remount'), true);

    desktop.emitOutput('term-remount', 'after-late-resolve\r\n');
    await flush();
    assert.equal(reopenedTerm.writes.join(''), 'initial\r\nbefore-late-resolve\r\nafter-late-resolve\r\n');

    // Unmounting the reopened mount detaches the feed once.
    await act(async () => {
      root.render(null);
    });
    assert.deepEqual(desktop.detached, ['term-remount']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('stale ensure resolving while an unbound replacement mount is pending still detaches if the replacement fails and unmounts', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const desktop = installFakeDesktop();
  desktop.replays.set('term-orphan-ensure', 'initial\r\n');
  const pending = [];
  window.mixdogDesktop.termEnsure = (id) =>
    new Promise((resolve, reject) => {
      desktop.ensured.push(id);
      pending.push({
        resolve: () => {
          desktop.attachedTabs.add(id);
          resolve({ id, replay: desktop.replays.get(id) });
        },
        reject: (err) => reject(err),
      });
    });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // Mount 1 starts termEnsure and unmounts before it settles.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, { terminalId: 'term-orphan-ensure', cwd: 'C:/proj', active: true })
      );
    });
    assert.equal(pending.length, 1);

    await act(async () => {
      root.render(null);
    });

    // Mount 2 mounts immediately (view.id is still null while its ensure is in flight).
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, { terminalId: 'term-orphan-ensure', cwd: 'C:/proj', active: true })
      );
    });
    assert.equal(pending.length, 2);

    // Mount 1's stale ensure settles FIRST while Mount 2 is actively binding: ownership transfers to Mount 2.
    pending[0].resolve();
    await flush();
    assert.deepEqual(desktop.detached, [], 'active replacement holds handoff ownership while binding');

    // When Mount 2's ensure fails, Mount 2 immediately releases the handed-off PTY without leaving it orphaned.
    pending[1].reject(new Error('replacement ensure failed'));
    await flush();
    assert.deepEqual(
      desktop.detached,
      ['term-orphan-ensure'],
      'failed unbound replacement must immediately detach the handed-off PTY'
    );
    await act(async () => {
      root.render(null);
    });

    assert.equal(
      desktop.attachedTabs.has('term-orphan-ensure'),
      false,
      'live PTY feed must not remain attached without a reader'
    );
    assert.deepEqual(desktop.disposed, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('stale prewarm resolving while an unbound replacement mount is pending still detaches when the replacement fails or unmounts', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const desktop = installFakeDesktop();
  desktop.replays.set('term-orphan-prewarm', 'warm\r\n');

  let resolvePrewarm;
  window.mixdogDesktop.termAttach = (id) =>
    new Promise((resolve) => {
      resolvePrewarm = () => {
        desktop.attachedTabs.add(id);
        resolve({ id, replay: desktop.replays.get(id) });
      };
    });
  let rejectReplacement;
  window.mixdogDesktop.termEnsure = (id) =>
    new Promise((_resolve, reject) => {
      desktop.ensured.push(id);
      rejectReplacement = () => reject(new Error('replacement ensure failed'));
    });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // Prewarm starts attaching view1; Mount 1 adopts view1 and unmounts before prewarm settles.
    const warmPromise = prewarmTerminal('term-orphan-prewarm');
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, { terminalId: 'term-orphan-prewarm', cwd: 'C:/proj', active: true })
      );
    });
    await act(async () => {
      root.render(null);
    });

    // Replacement Mount 2 mounts with an unbound view2 (view2.id === null) while its ensure is in flight.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, { terminalId: 'term-orphan-prewarm', cwd: 'C:/proj', active: true })
      );
    });

    // Stale prewarm settles while Mount 2 is actively binding -> hands off to Mount 2 instead of detaching early.
    resolvePrewarm();
    assert.equal(await warmPromise, false);
    assert.deepEqual(desktop.detached, []);

    // Replacement fails -> Mount 2 detaches the handed-off PTY immediately, and unmounting leaves no orphan.
    rejectReplacement();
    await flush();
    assert.deepEqual(desktop.detached, ['term-orphan-prewarm']);
    await act(async () => {
      root.render(null);
    });
    assert.equal(desktop.attachedTabs.has('term-orphan-prewarm'), false);
    assert.deepEqual(desktop.disposed, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('two overlapping termAttach calls sharing one feed promise do not unsubscribe the replacement across the bind gap', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;

  const calls = [];
  const eventListeners = new Set();
  let attachCalls = 0;
  let resolveAttach;
  const api = createTerminalApi({
    connection: {
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onReplaced: () => () => {},
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'terminal/attach') {
        attachCalls += 1;
        if (attachCalls === 1) {
          return new Promise((resolve) => {
            resolveAttach = () =>
              resolve({
                id: params.tabId,
                replay: 'shared-replay\r\n',
                subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
              });
          });
        }
        return {
          id: params.tabId,
          replay: 'shared-replay\r\n',
          subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 2 },
        };
      }
      return {};
    },
  });
  // Wrap termAttach without signal propagation to reproduce two overlapping termAttach calls sharing one feed promise.
  window.mixdogDesktop = { ...api, termAttach: (id) => api.termAttach(id) };

  const emitDelta = (tab, text, seq) => {
    const event = {
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: tab, bytesB64: Buffer.from(text).toString('base64') },
        feed: { id: `process:${tab}`, epoch: 'e1', seq },
      },
    };
    for (const listener of [...eventListeners]) listener(event);
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // Stale warm-up #1 starts termAttach on view1, then a mount adopts and immediately unmounts view1.
    const staleWarm = prewarmTerminal('term-shared-attach');
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId: 'term-shared-attach',
          cwd: 'C:/proj',
          active: false,
          attachOnly: true,
        })
      );
    });
    await act(async () => {
      root.render(null);
    });

    // Replacement warm-up #2 starts termAttach on view2 while the single underlying terminal/attach RPC is in flight.
    const replacementWarm = prewarmTerminal('term-shared-attach');
    assert.equal(
      calls.filter((c) => c.method === 'terminal/attach').length,
      1,
      'both termAttach calls share one underlying feed attach promise'
    );

    // Resolve the single shared attach promise: both API tokens release before either view resumes.
    resolveAttach();
    const [staleOk, replacementOk] = await Promise.all([staleWarm, replacementWarm]);
    assert.equal(staleOk, false);
    assert.equal(replacementOk, true);
    assert.equal(
      calls.filter((c) => c.method === 'feed/unsubscribe').length,
      0,
      'stale warm-up must not unsubscribe the replacement across the token-release/bind gap'
    );

    // Replacement view2 is bound and still receives live PTY output.
    const replacementTerm = xtermState.terminals.at(-1);
    emitDelta('term-shared-attach', 'live-after-handoff\r\n', 2);
    await flush();
    assert.equal(replacementTerm.writes.join(''), 'shared-replay\r\nlive-after-handoff\r\n');

    // Mounting and unmounting view2 cleanly detaches once.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId: 'term-shared-attach',
          cwd: 'C:/proj',
          active: true,
          attachOnly: true,
        })
      );
    });
    await flush();
    await act(async () => {
      root.render(null);
    });
    assert.equal(calls.filter((c) => c.method === 'feed/unsubscribe').length, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting the last replacement while its own termEnsure is stalled detaches immediately without waiting for timeout', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;

  const calls = [];
  let ensureCount = 0;
  const api = createTerminalApi(
    {
      connection: {
        onEvent: () => () => {},
        onReplaced: () => () => {},
        onStoreChange: () => () => {},
        notify: () => {},
        whenSynced: async () => undefined,
        snapshot: () => ({ status: 'ready', entries: [] }),
        protocolClient: () => ({ store: { section: () => undefined } }),
      },
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'terminal/ensure') {
          ensureCount += 1;
          if (ensureCount === 1) return { id: params.tabId, replay: 'm1\r\n' };
          // Replacement mount's termEnsure stalls indefinitely.
          return new Promise(() => {});
        }
        if (method === 'terminal/attach') {
          return {
            id: params.tabId,
            replay: 'm1\r\n',
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        return {};
      },
    },
    { deferredDetachTimeoutMs: 10_000 }
  );
  window.mixdogDesktop = api;

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // Outgoing consumer attaches the live feed first.
    await api.termEnsure('term-unmount-immediate', null, null);
    assert.equal(ensureCount, 1);

    // Replacement TerminalPane mounts; its own termEnsure stalls indefinitely.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, { terminalId: 'term-unmount-immediate', cwd: 'C:/proj', active: true })
      );
    });
    assert.equal(ensureCount, 2);

    // Outgoing consumer detaches while the replacement's termEnsure is in flight -> deferred instead of immediate.
    api.termDetach('term-unmount-immediate');
    assert.equal(calls.filter((c) => c.method === 'feed/unsubscribe').length, 0);

    // Unmounting the last replacement must drop its own inflight token via AbortSignal and detach IMMEDIATELY (0ms, not 10s).
    await act(async () => {
      root.render(null);
    });
    assert.deepEqual(
      calls.filter((c) => c.method === 'feed/unsubscribe').map((c) => c.params),
      [{ feedId: 'process:term-unmount-immediate' }],
      'unmounting the last replacement must detach immediately instead of waiting for deferredDetachTimeoutMs'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('mounting a prewarmed attach-only pane does not lose or duplicate PTY output printed during mount', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;

  const calls = [];
  const eventListeners = new Set();
  const api = createTerminalApi({
    connection: {
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onReplaced: () => () => {},
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'terminal/attach') {
        return {
          id: params.tabId,
          replay: 'boot\r\n',
          terminal: { core: 'run-1', incarnation: 1 },
          subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
        };
      }
      if (method === 'terminal/ensure') {
        return {
          id: params.tabId,
          replay: 'boot\r\nduring-mount\r\nafter-mount\r\n',
          terminal: { core: 'run-1', incarnation: 1 },
        };
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const emitDelta = (tab, text, seq) => {
    const event = {
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: {
          processHandle: tab,
          bytesB64: Buffer.from(text).toString('base64'),
          terminal: { core: 'run-1', incarnation: 1 },
        },
        feed: { id: `process:${tab}`, epoch: 'e1', seq },
      },
    };
    for (const listener of [...eventListeners]) listener(event);
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    assert.equal(await prewarmTerminal('term-prewarm-live'), true);
    assert.equal(calls.filter((c) => c.method === 'terminal/attach').length, 1);

    // Mount attach-only pane adopting the prewarmed view while PTY prints live output.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId: 'term-prewarm-live',
          cwd: 'C:/proj',
          active: false,
          attachOnly: true,
        })
      );
      emitDelta('term-prewarm-live', 'during-mount\r\n', 1);
    });
    await flush();
    emitDelta('term-prewarm-live', 'after-mount\r\n', 2);
    await flush();

    assert.equal(
      calls.filter((c) => c.method === 'terminal/attach').length,
      1,
      'attach-only mount must not trigger a redundant snapshot-discarding refresh on an already-live prewarmed view'
    );
    const term = xtermState.terminals[0];
    assert.equal(term.writes.join(''), 'boot\r\nduring-mount\r\nafter-mount\r\n');

    // Opening the pane for real (attachOnly=false) runs termEnsure without losing or duplicating output.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId: 'term-prewarm-live',
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await flush();
    emitDelta('term-prewarm-live', 'after-open\r\n', 3);
    await flush();

    assert.equal(calls.filter((c) => c.method === 'terminal/attach').length, 1);
    assert.equal(term.writes.join(''), 'boot\r\nduring-mount\r\nafter-mount\r\nafter-open\r\n');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting the last unbound view while its feed attach is stalled unwants and detaches the feed before reconnect', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;

  const calls = [];
  const replaced = new Set();
  let resolveStalledAttach;
  const api = createTerminalApi({
    connection: {
      onEvent: () => () => {},
      onReplaced: (listener) => {
        replaced.add(listener);
        return () => replaced.delete(listener);
      },
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'terminal/ensure') {
        return { id: params.tabId, replay: 'initial\r\n' };
      }
      if (method === 'terminal/attach') {
        return new Promise((resolve) => {
          resolveStalledAttach = () =>
            resolve({
              id: params.tabId,
              replay: 'initial\r\n',
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            });
        });
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // First mount resolves terminal/ensure (marking the tab wanted) and stalls in terminal/attach while view.id is still null.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, { terminalId: 'term-unbound-stalled', cwd: 'C:/proj', active: true })
      );
    });
    await flush();
    assert.equal(typeof resolveStalledAttach, 'function', 'mount reached terminal/attach');

    // Unmount the sole unbound view -> must immediately unwant and detach the feed.
    await act(async () => {
      root.render(null);
    });
    assert.deepEqual(
      calls.filter((c) => c.method === 'feed/unsubscribe').map((c) => c.params),
      [{ feedId: 'process:term-unbound-stalled' }],
      'unmounting the last unbound view must detach its stalled attach immediately'
    );

    // Link replacement must NOT reattach the hidden tab.
    calls.length = 0;
    for (const listener of replaced) listener();
    await flush();
    assert.deepEqual(calls, [], 'unmounted unbound tab must not remain wanted across reconnect');

    // Even if the stalled attach settles late, it does not resurrect the tab.
    resolveStalledAttach();
    await flush();
    assert.equal(calls.filter((c) => c.method === 'terminal/attach').length, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('prewarmed pane recovers and applies snapshot replay after a failed relink on both attach-only mount and real open', async () => {
  for (const scenario of ['attach-only', 'real-open']) {
    xtermState.terminals.length = 0;
    xtermState.fits.length = 0;
    const terminalId = `term-prewarm-failed-relink-${scenario}`;

    const calls = [];
    const eventListeners = new Set();
    const replaced = new Set();
    let attachCount = 0;
    const api = createTerminalApi({
      connection: {
        onEvent: (listener) => {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
        onReplaced: (listener) => {
          replaced.add(listener);
          return () => replaced.delete(listener);
        },
        onStoreChange: () => () => {},
        notify: () => {},
        whenSynced: async () => undefined,
        snapshot: () => ({ status: 'ready', entries: [] }),
        protocolClient: () => ({ store: { section: () => undefined } }),
      },
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'terminal/attach') {
          attachCount += 1;
          if (attachCount === 1) {
            return {
              id: params.tabId,
              replay: 'boot\r\n',
              terminal: { core: 'run-1', incarnation: 1 },
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            };
          }
          if (attachCount === 2) {
            throw new Error('relink failed');
          }
          return {
            id: params.tabId,
            replay: 'boot\r\nprinted-during-gap\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
          };
        }
        if (method === 'terminal/ensure') {
          return {
            id: params.tabId,
            replay: 'boot\r\nprinted-during-gap\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
          };
        }
        return {};
      },
    });
    window.mixdogDesktop = api;

    const emitDelta = (tab, text, epoch, seq) => {
      const event = {
        type: 'notification',
        notification: {
          method: 'process/outputDelta',
          params: {
            processHandle: tab,
            bytesB64: Buffer.from(text).toString('base64'),
            terminal: { core: 'run-1', incarnation: 1 },
          },
          feed: { id: `process:${tab}`, epoch, seq },
        },
      };
      for (const listener of [...eventListeners]) listener(event);
    };

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      // 1. Prewarm binds view.id and attaches on e1.
      assert.equal(await prewarmTerminal(terminalId), true);
      assert.equal(api.isTerminalAttached(terminalId), true);
      const term = xtermState.terminals[0];
      assert.equal(term.writes.join(''), 'boot\r\n');

      // 2. Link drops and relink fails -> feed is no longer attached, yet prewarmed view.id is still set.
      for (const listener of replaced) listener();
      await flush();
      assert.equal(attachCount, 2);
      assert.equal(api.isTerminalAttached(terminalId), false);

      // 3. Mount (either attach-only or real open) must detect !isTerminalAttached, recover, and apply snapshot replay.
      await act(async () => {
        root.render(
          React.createElement(TerminalPane, {
            terminalId,
            cwd: 'C:/proj',
            active: scenario === 'real-open',
            attachOnly: scenario === 'attach-only',
          })
        );
      });
      await flush();

      assert.equal(attachCount, 3, `${scenario}: mount must re-attach after failed relink`);
      assert.equal(api.isTerminalAttached(terminalId), true);
      assert.equal(
        term.writes.join(''),
        'boot\r\nprinted-during-gap\r\n',
        `${scenario}: snapshot replay must replace stale prewarm screen with output printed during gap`
      );

      // 4. Subsequent live output on e2 streams cleanly.
      emitDelta(terminalId, 'live-after-recovery\r\n', 'e2', 1);
      await flush();
      assert.equal(term.writes.join(''), 'boot\r\nprinted-during-gap\r\nlive-after-recovery\r\n');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('mounting a prewarmed pane during a pending relink does not duplicate replay output or double-reset', async () => {
  for (const mode of ['replay', 'snapshot']) {
    for (const mountKind of ['attach-only', 'real-open']) {
      xtermState.terminals.length = 0;
      xtermState.fits.length = 0;
      const terminalId = `term-prewarm-relink-${mode}-${mountKind}`;

      const eventListeners = new Set();
      const replaced = new Set();
      let attachCount = 0;
      let resolveRelink;
      let resolveRelinkStarted;
      const relinkStarted = new Promise((resolve) => {
        resolveRelinkStarted = resolve;
      });
      const api = createTerminalApi({
        connection: {
          onEvent: (listener) => {
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
          },
          onReplaced: (listener) => {
            replaced.add(listener);
            return () => replaced.delete(listener);
          },
          onStoreChange: () => () => {},
          notify: () => {},
          whenSynced: async () => undefined,
          snapshot: () => ({ status: 'ready', entries: [] }),
          protocolClient: () => ({ store: { section: () => undefined } }),
        },
        call: async (method, params) => {
          if (method === 'terminal/attach') {
            attachCount += 1;
            if (attachCount === 1) {
              return {
                id: params.tabId,
                replay: 'boot\r\n',
                terminal: { core: 'run-1', incarnation: 1 },
                subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
              };
            }
            resolveRelinkStarted();
            return new Promise((resolve) => {
              resolveRelink = resolve;
            });
          }
          if (method === 'terminal/ensure') {
            return {
              id: params.tabId,
              replay: 'boot\r\nmissed-during-outage\r\n',
              terminal: { core: 'run-1', incarnation: 1 },
            };
          }
          return {};
        },
      });
      window.mixdogDesktop = api;

      const emitDelta = (tab, text, epoch, seq) => {
        const event = {
          type: 'notification',
          notification: {
            method: 'process/outputDelta',
            params: {
              processHandle: tab,
              bytesB64: Buffer.from(text).toString('base64'),
              terminal: { core: 'run-1', incarnation: 1 },
            },
            feed: { id: `process:${tab}`, epoch, seq },
          },
        };
        for (const listener of [...eventListeners]) listener(event);
      };

      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);

      try {
        // 1. Prewarm binds view.id and renders initial snapshot.
        assert.equal(await prewarmTerminal(terminalId), true);
        const term = xtermState.terminals[0];
        assert.equal(term.writes.join(''), 'boot\r\n');

        // 2. Link drops -> relink is now in flight (isTerminalAttached is false).
        for (const listener of replaced) listener();
        await relinkStarted;
        assert.equal(attachCount, 2);
        assert.equal(api.isTerminalAttached(terminalId), false);

        // 3. Mount prewarmed pane while relink is still pending (joins the pending relink).
        await act(async () => {
          root.render(
            React.createElement(TerminalPane, {
              terminalId,
              cwd: 'C:/proj',
              active: mountKind === 'real-open',
              attachOnly: mountKind === 'attach-only',
            })
          );
        });
        await flush();
        assert.equal(attachCount, 2, `${mode}/${mountKind}: mount must join the pending relink`);

        if (mode === 'replay') {
          // 4a. Relink resolves in replay mode: missed output arrives as continuation frames.
          resolveRelink({
            id: terminalId,
            replay: 'boot\r\nmissed-during-outage\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'replay', epoch: 'e1', startSeq: 1 },
          });
          emitDelta(terminalId, 'missed-during-outage\r\n', 'e1', 1);
          await flush();
          assert.equal(
            term.writes.join(''),
            'boot\r\nmissed-during-outage\r\n',
            `${mode}/${mountKind}: replay-mode relink must not duplicate missed output`
          );
        } else {
          // 4b. Relink resolves in snapshot mode with a post-cut delta queued right behind it.
          emitDelta(terminalId, 'after-snap\r\n', 'e2', 2);
          resolveRelink({
            id: terminalId,
            replay: 'boot\r\nsnap-outage\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 2 },
          });
          await flush();
          assert.equal(
            term.writes.join(''),
            'boot\r\nsnap-outage\r\nafter-snap\r\n',
            `${mode}/${mountKind}: snapshot-mode relink must redraw once and keep post-cut deltas`
          );
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    }
  }
});

test('real open on a prewarmed pane applies snapshot replay when ensure spawns a replacement PTY under the same tab id', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const terminalId = 'term-prewarm-replacement-pty';

  const eventListeners = new Set();
  let attachCount = 0;
  let resolveEnsure;
  let resolveEnsureStarted;
  const ensureStarted = new Promise((resolve) => {
    resolveEnsureStarted = resolve;
  });
  const api = createTerminalApi({
    connection: {
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onReplaced: () => () => {},
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      if (method === 'terminal/attach') {
        attachCount += 1;
        if (attachCount === 1) {
          return {
            id: params.tabId,
            replay: 'old-shell\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        return {
          id: params.tabId,
          replay: 'replacement-shell\r\n',
          terminal: { core: 'run-1', incarnation: 2 },
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      }
      if (method === 'terminal/ensure') {
        resolveEnsureStarted();
        return new Promise((resolve) => {
          resolveEnsure = resolve;
        });
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const emitDelta = (tab, text, epoch, seq, incarnation) => {
    const event = {
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: {
          processHandle: tab,
          bytesB64: Buffer.from(text).toString('base64'),
          terminal: { core: 'run-1', incarnation },
        },
        feed: { id: `process:${tab}`, epoch, seq },
      },
    };
    for (const listener of [...eventListeners]) listener(event);
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Prewarm attaches incarnation 1 (old shell). Feed is actively attached.
    assert.equal(await prewarmTerminal(terminalId), true);
    assert.equal(api.isTerminalAttached(terminalId), true);
    const term = xtermState.terminals[0];
    assert.equal(term.writes.join(''), 'old-shell\r\n');

    // 2. Real open starts while feed is STILL attached to incarnation 1.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId,
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await ensureStarted;

    // 3. During terminal/ensure, old shell exits and server spawns replacement incarnation 2 under the SAME tab id.
    resolveEnsure({
      id: terminalId,
      replay: 'replacement-shell\r\n',
      terminal: { core: 'run-1', incarnation: 2 },
    });
    await flush();

    assert.equal(attachCount, 2, 'joinOrAttach must attach the replacement PTY incarnation');
    assert.equal(
      term.writes.join(''),
      'replacement-shell\r\n',
      'pane must reset stale old-shell output and render the replacement PTY snapshot'
    );

    // 4. Subsequent live output on incarnation 2 streams cleanly.
    emitDelta(terminalId, 'after-respawn\r\n', 'e2', 1, 2);
    await flush();
    assert.equal(term.writes.join(''), 'replacement-shell\r\nafter-respawn\r\n');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('reattached snapshot reset runs inside the write pump barrier so queued old-shell writes cannot land after reset', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const terminalId = 'term-write-pump-reset-barrier';

  const eventListeners = new Set();
  let attachCount = 0;
  const api = createTerminalApi({
    connection: {
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onReplaced: () => () => {},
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      if (method === 'terminal/attach') {
        attachCount += 1;
        if (attachCount === 1) {
          return {
            id: params.tabId,
            replay: 'old-boot\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        return {
          id: params.tabId,
          replay: 'new-snapshot\r\n',
          terminal: { core: 'run-1', incarnation: 2 },
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      }
      if (method === 'terminal/ensure') {
        return {
          id: params.tabId,
          replay: 'new-snapshot\r\n',
          terminal: { core: 'run-1', incarnation: 2 },
        };
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const emitDelta = (tab, text, epoch, seq, incarnation) => {
    const event = {
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: {
          processHandle: tab,
          bytesB64: Buffer.from(text).toString('base64'),
          terminal: { core: 'run-1', incarnation },
        },
        feed: { id: `process:${tab}`, epoch, seq },
      },
    };
    for (const listener of [...eventListeners]) listener(event);
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Prewarm binds incarnation 1.
    assert.equal(await prewarmTerminal(terminalId), true);
    const term = xtermState.terminals[0];
    assert.equal(term.writes.join(''), 'old-boot\r\n');

    // 2. Intercept term.write and term.reset so we can hold async xterm parser callbacks
    //    and observe the exact order of writes and resets.
    const trace = [];
    const heldCallbacks = [];
    const origWrite = term.write.bind(term);
    const origReset = term.reset.bind(term);
    term.write = (data, cb) => {
      trace.push(`write:${data}`);
      origWrite(data);
      if (cb) heldCallbacks.push(cb);
    };
    term.reset = () => {
      trace.push('reset');
      origReset();
    };

    // 3. Emit an active old write and queue >64 KiB + old-tail behind it in TerminalWritePump.pending.
    emitDelta(terminalId, 'old-head|', 'e1', 1, 1);
    await new Promise((r) => setTimeout(r, 15));
    const bigPad = 'x'.repeat(70 * 1024);
    emitDelta(terminalId, bigPad, 'e1', 2, 1);
    await new Promise((r) => setTimeout(r, 15));
    emitDelta(terminalId, 'old-tail|', 'e1', 3, 1);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(
      trace.some((entry) => entry.includes('old-tail|')),
      false,
      'old-tail must be queued in TerminalWritePump.pending behind the active write'
    );

    // 4. Mount real open whose ensure spawns replacement incarnation 2.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId,
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await flush();

    // Reset must NOT have fired synchronously before the queued old-tail drained!
    assert.equal(trace.includes('reset'), false, 'term.reset must wait inside the write pump barrier');

    // 5. Emit post-snapshot live output for incarnation 2 while the barrier is still pending.
    emitDelta(terminalId, 'after-new\r\n', 'e2', 1, 2);
    await new Promise((r) => setTimeout(r, 15));

    // 6. Drain every held xterm parser callback in order.
    while (heldCallbacks.length > 0) {
      heldCallbacks.shift()();
    }
    await flush();

    const oldTailIdx = trace.findIndex((entry) => entry.startsWith('write:') && entry.includes('old-tail|'));
    const resetIdx = trace.indexOf('reset');
    const newSnapIdx = trace.indexOf('write:new-snapshot\r\n');
    const afterNewIdx = trace.indexOf('write:after-new\r\n');
    assert.ok(oldTailIdx !== -1 && resetIdx !== -1 && newSnapIdx !== -1 && afterNewIdx !== -1);
    assert.ok(oldTailIdx < resetIdx, 'queued old-tail must drain before reset');
    assert.ok(resetIdx < newSnapIdx && newSnapIdx < afterNewIdx, 'reset must precede new snapshot and live output');
    assert.equal(
      term.writes.join(''),
      'new-snapshot\r\nafter-new\r\n',
      'final terminal screen must contain only the replacement snapshot and subsequent output'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('reconnect snapshot and pre-subscribe live output arriving before first pane binds render completely and reconcile backpressure', async () => {
  for (const scenario of ['pre-subscribe-70k', 'pre-subscribe-300k']) {
    xtermState.terminals.length = 0;
    xtermState.fits.length = 0;
    const terminalId = `term-reconnect-snapshot-ack-${scenario}`;

    const eventListeners = new Set();
    const replaced = new Set();
    const flowCalls = [];
    let attachCount = 0;
    let rejectFirstAttach;
    let resolveFirstAttachStarted;
    const firstAttachStarted = new Promise((resolve) => {
      resolveFirstAttachStarted = resolve;
    });
    const snapshotText = 'S'.repeat(200_000);
    const liveText = 'L'.repeat(scenario === 'pre-subscribe-300k' ? 300_000 : 70_000);

    const api = createTerminalApi({
      connection: {
        onEvent: (listener) => {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
        onReplaced: (listener) => {
          replaced.add(listener);
          return () => replaced.delete(listener);
        },
        onStoreChange: () => () => {},
        notify: () => {},
        whenSynced: async () => undefined,
        snapshot: () => ({ status: 'ready', entries: [] }),
        protocolClient: () => ({ store: { section: () => undefined } }),
      },
      call: async (method, params) => {
        if (method === 'terminal/pause' || method === 'terminal/resume') {
          flowCalls.push(method);
          return {};
        }
        if (method === 'terminal/ensure') {
          return {
            id: params.tabId,
            replay: 'initial',
            terminal: { core: 'run-1', incarnation: 1 },
          };
        }
        if (method === 'terminal/attach') {
          attachCount += 1;
          if (attachCount === 1) {
            resolveFirstAttachStarted();
            return new Promise((_resolve, reject) => {
              rejectFirstAttach = reject;
            });
          }
          return {
            id: params.tabId,
            replay: snapshotText,
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
          };
        }
        return {};
      },
    });
    window.mixdogDesktop = api;

    const emitDelta = (tab, text, epoch, seq) => {
      const event = {
        type: 'notification',
        notification: {
          method: 'process/outputDelta',
          params: {
            processHandle: tab,
            bytesB64: Buffer.from(text).toString('base64'),
            terminal: { core: 'run-1', incarnation: 1 },
          },
          feed: { id: `process:${tab}`, epoch, seq },
        },
      };
      for (const listener of [...eventListeners]) listener(event);
    };

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      // 1. Mount first pane (not prewarmed -> not yet subscribed to term data).
      await act(async () => {
        root.render(
          React.createElement(TerminalPane, {
            terminalId,
            cwd: 'C:/proj',
            active: true,
            attachOnly: false,
          })
        );
      });
      await firstAttachStarted;

      const term = xtermState.terminals[0];
      const heldCallbacks = [];
      const origWrite = term.write.bind(term);
      term.write = (data, cb) => {
        origWrite(data);
        if (cb) heldCallbacks.push(cb);
      };

      // 2. Link replaces while the first pane is still binding: relink resolves with a 200k snapshot,
      //    AND live output arrives BEFORE the original attach rejects and BEFORE TerminalPane subscribes.
      for (const listener of replaced) listener();
      await flush();
      emitDelta(terminalId, liveText, 'e2', 1);
      // Wait well past the 5ms coalescer window while TerminalPane is still unsubscribed.
      await new Promise((r) => setTimeout(r, 20));

      if (scenario === 'pre-subscribe-300k') {
        assert.deepEqual(
          flowCalls,
          ['terminal/pause'],
          '300k pre-subscribe live output must still apply backpressure while waiting for pane subscribe'
        );
      } else {
        assert.deepEqual(flowCalls, [], 'pre-subscribe 200k snapshot + 70k live must not count unsubscribed reset');
      }

      // 3. Now original attach rejects -> termEnsure resolves with relink session, TerminalPane binds & subscribes.
      rejectFirstAttach(new Error('old link dropped'));
      await flush();

      // 4. Drain every xterm write callback in order.
      for (let guard = 0; guard < 15 && heldCallbacks.length > 0; guard += 1) {
        while (heldCallbacks.length > 0) heldCallbacks.shift()();
        await new Promise((r) => setTimeout(r, 10));
      }

      const rendered = term.writes.join('');
      assert.equal(
        rendered.length,
        snapshotText.length + liveText.length,
        `${scenario}: zero pre-subscribe live bytes may be dropped`
      );
      assert.equal(rendered.startsWith(snapshotText), true, `${scenario}: snapshot must precede live output`);
      assert.equal(
        rendered.endsWith(liveText),
        true,
        `${scenario}: all pre-subscribe live output must follow snapshot`
      );

      if (scenario === 'pre-subscribe-300k') {
        assert.deepEqual(
          flowCalls,
          ['terminal/pause', 'terminal/resume'],
          'acknowledging delivered pre-subscribe live output must resume the paused PTY'
        );
      } else {
        assert.deepEqual(flowCalls, [], '70k live output must not leave the PTY paused');
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('stale xterm acknowledgement from an old shell does not prematurely resume its replacement PTY', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const terminalId = 'term-stale-ack-replacement';

  const eventListeners = new Set();
  const flowCalls = [];
  let attachCount = 0;
  const api = createTerminalApi({
    connection: {
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onReplaced: () => () => {},
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      if (method === 'terminal/pause' || method === 'terminal/resume') {
        flowCalls.push(method);
        return {};
      }
      if (method === 'terminal/attach') {
        attachCount += 1;
        if (attachCount === 1) {
          return {
            id: params.tabId,
            replay: 'old-boot\r\n',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        return {
          id: params.tabId,
          replay: 'new-boot\r\n',
          terminal: { core: 'run-1', incarnation: 2 },
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      }
      if (method === 'terminal/ensure') {
        return {
          id: params.tabId,
          replay: 'new-boot\r\n',
          terminal: { core: 'run-1', incarnation: 2 },
        };
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const emitDelta = (tab, text, epoch, seq, incarnation) => {
    const event = {
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: {
          processHandle: tab,
          bytesB64: Buffer.from(text).toString('base64'),
          terminal: { core: 'run-1', incarnation },
        },
        feed: { id: `process:${tab}`, epoch, seq },
      },
    };
    for (const listener of [...eventListeners]) listener(event);
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Prewarm old shell (incarnation 1).
    assert.equal(await prewarmTerminal(terminalId), true);
    const term = xtermState.terminals[0];
    const oldCallbacks = [];
    const newCallbacks = [];
    let capturePhase = 'old';
    const origWrite = term.write.bind(term);
    term.write = (data, cb) => {
      origWrite(data);
      if (cb) (capturePhase === 'old' ? oldCallbacks : newCallbacks).push(cb);
    };

    // 2. Old shell emits 250,000 chars whose xterm parse callbacks remain pending.
    emitDelta(terminalId, 'O'.repeat(250_000), 'e1', 1, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(oldCallbacks.length > 0, 'old shell write must be pending in xterm');

    // 3. Real open spawns replacement incarnation 2 -> clears old buffer accounting and advances generation.
    capturePhase = 'new';
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId,
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await flush();

    // 4. Replacement shell emits 270,000 chars -> triggers terminal/pause.
    const newLive = 'N'.repeat(270_000);
    emitDelta(terminalId, newLive, 'e2', 1, 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(flowCalls, ['terminal/pause']);

    // 5. Old shell's pending xterm parse callbacks now finish (acking 250k with old generation).
    //    They must be ignored and MUST NOT send terminal/resume before replacement output is parsed!
    while (oldCallbacks.length > 0) oldCallbacks.shift()();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(
      flowCalls,
      ['terminal/pause'],
      'stale old-shell acknowledgement must not prematurely resume replacement PTY'
    );

    // 6. Now drain replacement shell's xterm parse callbacks -> terminal/resume fires cleanly.
    for (let guard = 0; guard < 15 && newCallbacks.length > 0; guard += 1) {
      while (newCallbacks.length > 0) newCallbacks.shift()();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(flowCalls, ['terminal/pause', 'terminal/resume']);
    assert.equal(term.writes.join(''), `new-boot\r\n${newLive}`);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unmounting the sole unbound pane after a background relink succeeded detaches and unsubscribes the recovered feed', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const terminalId = 'term-sole-unbound-relink-unmount';

  const calls = [];
  const replaced = new Set();
  let attachCount = 0;
  let resolveFirstAttachStarted;
  const firstAttachStarted = new Promise((resolve) => {
    resolveFirstAttachStarted = resolve;
  });
  const api = createTerminalApi({
    connection: {
      onEvent: () => () => {},
      onReplaced: (listener) => {
        replaced.add(listener);
        return () => replaced.delete(listener);
      },
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'terminal/ensure') {
        return {
          id: params.tabId,
          replay: 'initial',
          terminal: { core: 'run-1', incarnation: 1 },
        };
      }
      if (method === 'terminal/attach') {
        attachCount += 1;
        if (attachCount === 1) {
          resolveFirstAttachStarted();
          return new Promise(() => {});
        }
        return {
          id: params.tabId,
          replay: 'recovered-snap',
          terminal: { core: 'run-1', incarnation: 1 },
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Mount sole pane -> original attach #1 stays pending, view.id is still null.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId,
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await firstAttachStarted;

    // 2. Link replaces -> relink attach #2 succeeds and marks feed attached while view.id is still null.
    for (const listener of replaced) listener();
    await flush();
    assert.equal(attachCount, 2);
    assert.equal(api.isTerminalAttached(terminalId), true);

    // 3. Sole unbound pane unmounts -> abort must detach the unclaimed recovered feed and send feed/unsubscribe.
    calls.length = 0;
    await act(async () => {
      root.render(null);
    });
    await flush();

    assert.equal(api.isTerminalAttached(terminalId), false, 'unmounting sole unbound pane must detach relinked feed');
    assert.deepEqual(
      calls.map((c) => [c.method, c.params]),
      [['feed/unsubscribe', { feedId: `process:${terminalId}` }]],
      'unmounting sole unbound pane must unsubscribe recovered server feed'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('delayed first attach after chained relinks renders latest relink C snapshot and live output without losing C bytes', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;
  const terminalId = 'term-chained-relink-latest-snapshot';

  const replaced = new Set();
  const events = new Set();
  let attachCount = 0;
  let rejectFirstAttach;
  let resolveFirstAttachStarted;
  const firstAttachStarted = new Promise((resolve) => {
    resolveFirstAttachStarted = resolve;
  });

  const api = createTerminalApi({
    connection: {
      onEvent: (listener) => {
        events.add(listener);
        return () => events.delete(listener);
      },
      onReplaced: (listener) => {
        replaced.add(listener);
        return () => replaced.delete(listener);
      },
      onStoreChange: () => () => {},
      notify: () => {},
      whenSynced: async () => undefined,
      snapshot: () => ({ status: 'ready', entries: [] }),
      protocolClient: () => ({ store: { section: () => undefined } }),
    },
    call: async (method, params) => {
      if (method === 'terminal/ensure') {
        return {
          id: params.tabId,
          replay: 'initial-ensure',
          terminal: { core: 'run-1', incarnation: 1 },
        };
      }
      if (method === 'terminal/attach') {
        attachCount += 1;
        if (attachCount === 1) {
          resolveFirstAttachStarted();
          return new Promise((_, reject) => {
            rejectFirstAttach = reject;
          });
        }
        if (attachCount === 2) {
          return {
            id: params.tabId,
            replay: 'snap-B',
            terminal: { core: 'run-1', incarnation: 1 },
            subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
          };
        }
        return {
          id: params.tabId,
          replay: 'snap-C-unique|',
          terminal: { core: 'run-1', incarnation: 1 },
          subscription: { mode: 'snapshot', epoch: 'e3', startSeq: 1 },
        };
      }
      return {};
    },
  });
  window.mixdogDesktop = api;

  const emitOutput = (chunk, epoch, seq) => {
    const bytesB64 = Buffer.from(chunk, 'utf8').toString('base64');
    for (const listener of events) {
      listener({
        type: 'notification',
        notification: {
          method: 'process/outputDelta',
          params: { processHandle: terminalId, terminal: { core: 'run-1', incarnation: 1 }, bytesB64 },
          feed: { id: `process:${terminalId}`, epoch, seq },
        },
      });
    }
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Mount pane: first attach A stays pending while view is still unbound.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          terminalId,
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await firstAttachStarted;

    // 2. Relink B succeeds with snapshot B + live delta B1.
    for (const listener of replaced) listener();
    await flush();
    assert.equal(attachCount, 2);
    emitOutput('delta-B1', 'e2', 1);

    // 3. Relink C succeeds with newer snapshot C + live delta C1.
    for (const listener of replaced) listener();
    await flush();
    assert.equal(attachCount, 3);
    emitOutput('delta-C1', 'e3', 1);

    // 4. Original attach A finally rejects: pane must bind C's snapshot + C's live output (zero B bytes).
    rejectFirstAttach(new Error('link A dropped'));
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    const term = xtermState.terminals.at(-1);
    assert.ok(term, 'xterm instance must exist');
    assert.equal(
      term.writes.join(''),
      'snap-C-unique|delta-C1',
      'pane must render latest relink C snapshot followed by C live output without losing C bytes'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('switching terminal tabs on phone releases size-owner before deleting terminalViews entry on unmount', async () => {
  xtermState.terminals.length = 0;
  xtermState.fits.length = 0;

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const actions = [];

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      platform: 'iPhone',
      maxTouchPoints: 5,
    },
    configurable: true,
  });
  Object.defineProperty(window, 'innerWidth', {
    value: 390,
    configurable: true,
  });

  window.mixdogDesktop = {
    remoteTermSizeOwner: true,
    termEnsure: async (id) => ({ id: id ?? 'tab-1', replay: '' }),
    termAttach: async (id) => ({ id, replay: '' }),
    termResize: (id, cols, rows, owner) => {
      actions.push({ type: 'resize', id, cols, rows, owner });
    },
    termDetach: (id) => {
      actions.push({ type: 'detach', id });
    },
    termDispose: async () => {},
    termAcknowledge: () => {},
    subscribeTermData: () => () => {},
    subscribeTermExit: () => () => {},
    subscribeTermSizeOwner: () => () => {},
    subscribeTermCommands: () => () => {},
  };

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    // 1. Mount active phone TerminalPane for tab-1 and wait for termEnsure to bind view.id.
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          key: 'phone-tab-1',
          terminalId: 'phone-tab-1',
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await flush();

    // 2. Switch to another terminal tab so phone-tab-1 unmounts directly.
    actions.length = 0;
    await act(async () => {
      root.render(
        React.createElement(TerminalPane, {
          key: 'phone-tab-2',
          terminalId: 'phone-tab-2',
          cwd: 'C:/proj',
          active: true,
          attachOnly: false,
        })
      );
    });
    await flush();

    const releaseIdx = actions.findIndex(
      (a) => a.type === 'resize' && a.id === 'phone-tab-1' && a.cols === 0 && a.rows === 0 && a.owner === true
    );
    const detachIdx = actions.findIndex((a) => a.type === 'detach' && a.id === 'phone-tab-1');
    assert.ok(
      releaseIdx >= 0,
      `expected phone size-owner release on tab switch unmount, saw ${JSON.stringify(actions)}`
    );
    assert.ok(detachIdx >= 0, `expected termDetach on tab switch unmount, saw ${JSON.stringify(actions)}`);
    assert.ok(
      releaseIdx < detachIdx,
      `size-owner release (${releaseIdx}) must run before view release/detach (${detachIdx})`
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
  }
});
