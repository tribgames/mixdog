import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.React = React;
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
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
};

const { CategoryPanel } = await import('./capability-panels.tsx');

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function context({ run, snapshot = null, voice = {}, api = {}, toolModules = {} }) {
  return {
    api: {
      readSettings: async () => ({
        autoClear: true,
        autoCompact: true,
        keepAwake: true,
        usagePinned: false,
        computerControl: false,
        computerObserveOnly: false,
        browserControl: false,
        computerInstalled: false,
        browserInstalled: false,
      }),
      ...api,
    },
    data: {
      profile: { languages: [], experienceLevels: [] },
      toolModules: {
        webSearch: { enabled: true },
        memory: { enabled: true, installed: true },
        git: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
        ...toolModules,
      },
      recap: { enabled: true },
      theme: 'basic',
      voice: {
        enabled: false,
        installed: false,
        busy: false,
        components: { whisper: false, model: false, ffmpeg: false },
        ...voice,
      },
    },
    snapshot,
    pending: '',
    run,
    async route() {},
    async setFast() {},
    confirm() {},
    notice() {},
    updaterState: { status: 'disabled' },
    async checkDesktopUpdate() {},
    async installDesktopUpdate() {},
  };
}

// Built-in rows carry no control; the install pill / progress / switch live
// in the feature's detail dialog, which the row opens.
const openFeature = (id) => act(async () => {
  document.querySelector(`[data-built-in-feature="${id}"] .extensions-row-open`).click();
});

test('voice installs inline with live progress and enables on completion', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const install = deferred();
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return install.promise;
  };
  const render = (next) => act(async () => {
    root.render(React.createElement(CategoryPanel, {
      category: 'builtins',
      context: next,
    }));
  });

  try {
    await render(context({ run }));
    await openFeature('voice');
    const installButton = document.querySelector(
      '[data-feature-id="voice"] button[aria-label="Install Voice transcription"]',
    );
    assert.ok(installButton);
    await act(async () => installButton.click());
    assert.deepEqual(calls, [['toggleVoice', [true]]]);

    await render(context({
      run,
      snapshot: {
        progressHint: {
          text: '⬇ Voice model ▓▓▓░░░ 42%',
          tone: 'info',
          percent: 42,
        },
      },
    }));
    // The progress paints in the control slot, where the toggle will land.
    const progress = document.querySelector('[data-feature-id="voice"] [role="progressbar"]');
    assert.ok(progress);
    assert.equal(progress.getAttribute('aria-valuenow'), '42');
    assert.equal(progress.querySelector('.built-in-feature-progress-bar > span').style.width, '42%');

    await act(async () => install.resolve({ enabled: true, installed: true }));
    assert.ok(document.querySelector('[data-feature-id="voice"] input[aria-label="Voice transcription"]'));
    assert.equal(document.querySelector('[role="progressbar"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('failed inline voice installation stays actionable with retry', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { enabled: false, installed: false, result: { ok: false } };
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({ run }),
      }));
    });
    await openFeature('voice');
    await act(async () => document.querySelector('[data-feature-id="voice"] button').click());
    const retry = document.querySelector('[data-feature-id="voice"] button');
    assert.equal(retry.textContent, 'Retry');
    await act(async () => retry.click());
    assert.equal(calls, 2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('voice disable keeps the installed runtime and leaves an off toggle', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return { enabled: false, installed: true };
  };
  const render = (voice) => act(async () => {
    root.render(React.createElement(CategoryPanel, {
      category: 'builtins',
      context: context({ run, voice }),
    }));
  });

  try {
    await render({ enabled: true, installed: true });
    await openFeature('voice');
    const toggle = document.querySelector('[data-feature-id="voice"] input[aria-label="Voice transcription"]');
    assert.equal(toggle.checked, true);
    await act(async () => toggle.click());
    assert.deepEqual(calls, [['toggleVoice', [false]]]);

    await render({ enabled: false, installed: true });
    const disabled = document.querySelector('[data-feature-id="voice"] input[aria-label="Voice transcription"]');
    assert.ok(disabled);
    assert.equal(disabled.checked, false);
    assert.equal(document.querySelector(
      '[data-feature-id="voice"] button[aria-label="Install Voice transcription"]',
    ), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('missing Git dependency installs inline and enables the tool on completion', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const dependency = deferred();
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return { git: { enabled: true } };
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({
          run,
          api: {
            gitCliStatus: async () => ({ installed: false }),
            installGitCli: async () => dependency.promise,
          },
        }),
      }));
    });
    await openFeature('git');
    const install = document.querySelector(
      '[data-feature-id="git"] button[aria-label="Install Git"]',
    );
    assert.ok(install);
    await act(async () => {
      install.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // A system install reports no percent: the slot bar runs indeterminate.
    assert.ok(document.querySelector(
      '[data-feature-id="git"] [role="progressbar"] .built-in-feature-progress-bar.is-indeterminate',
    ));

    await act(async () => dependency.resolve({ installed: true, version: '2.50.1' }));
    assert.deepEqual(calls, [['setBuiltinToolEnabled', ['git', true]]]);
    assert.ok(document.querySelector('[data-feature-id="git"] input[aria-label="Git"]'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('system Git alone does not bypass the Mixdog install marker', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({
          run: async () => ({}),
          toolModules: { git: { enabled: true, installed: false } },
          api: { gitCliStatus: async () => ({ installed: true, version: '2.50.1' }) },
        }),
      }));
    });
    await openFeature('git');
    assert.ok(document.querySelector('[data-feature-id="git"] button[aria-label="Install Git"]'));
    assert.equal(document.querySelector('[data-feature-id="git"] input[aria-label="Git"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('missing LibreOffice dependency installs inline before the Office feature', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const dependency = deferred();
  const calls = [];
  const apiCalls = [];
  // Each render builds a fresh api object, which re-runs the status effect —
  // so the probe answers from the current dependency state instead of
  // rewinding a just-finished install.
  let dependencyState = { installed: false };
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return { office: { enabled: true, installed: true } };
  };
  const render = (toolModules) => act(async () => {
    root.render(React.createElement(CategoryPanel, {
      category: 'builtins',
      context: context({
        run,
        toolModules,
        api: {
          libreOfficeStatus: async () => dependencyState,
          installLibreOffice: async () => {
            apiCalls.push('installLibreOffice');
            return dependency.promise;
          },
        },
      }),
    }));
  });

  try {
    await render({ office: { enabled: false, installed: false } });
    await openFeature('office');
    const install = document.querySelector(
      '[data-feature-id="office"] button[aria-label="Install Office"]',
    );
    assert.ok(install);
    await act(async () => install.click());
    // The dependency phase reports no percent: the slot bar runs indeterminate,
    // and the feature install itself waits for LibreOffice to land.
    assert.ok(document.querySelector(
      '[data-feature-id="office"] [role="progressbar"] .built-in-feature-progress-bar.is-indeterminate',
    ));
    assert.deepEqual(calls, []);

    dependencyState = { installed: true, version: '25.2.1.2' };
    await act(async () => dependency.resolve(dependencyState));
    assert.deepEqual(apiCalls, ['installLibreOffice']);
    assert.deepEqual(calls, [['installBuiltinFeature', ['office']]]);
    // The capability result refreshes toolModules; the card then shows the
    // toggle without exposing dependency version metadata.
    await render({ office: { enabled: true, installed: true } });
    assert.ok(document.querySelector('[data-feature-id="office"] input[aria-label="Office"]'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a present LibreOffice skips the dependency step of the Office install', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const apiCalls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return { office: { enabled: true, installed: true } };
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({
          run,
          toolModules: { office: { enabled: false, installed: false } },
          api: {
            libreOfficeStatus: async () => ({ installed: true, version: '25.2.1.2' }),
            installLibreOffice: async () => {
              apiCalls.push('installLibreOffice');
              return { installed: true };
            },
          },
        }),
      }));
    });
    await openFeature('office');
    await act(async () => document.querySelector('[data-feature-id="office"] button').click());
    assert.deepEqual(apiCalls, []);
    assert.deepEqual(calls, [['installBuiltinFeature', ['office']]]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('an uninstalled built-in installs through the shared capability', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return { memory: { enabled: true, installed: true } };
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({
          run,
          toolModules: { memory: { enabled: false, installed: false } },
        }),
      }));
    });
    await openFeature('memory');
    const install = document.querySelector(
      '[data-feature-id="memory"] button[aria-label="Install Memory"]',
    );
    assert.ok(install);
    await act(async () => install.click());
    assert.deepEqual(calls, [['installBuiltinFeature', ['memory']]]);
    // The capability result refreshes the toolModules section; the card's
    // control slot then swaps the Install pill for the live toggle.
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({
          run,
          toolModules: { memory: { enabled: true, installed: true } },
        }),
      }));
    });
    assert.ok(document.querySelector('[data-feature-id="memory"] input[aria-label="Memory"]'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('built-in feature switches route to their existing authoritative settings', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    if (capability === 'setMemoryToolsEnabled') {
      return { memory: { enabled: args[0] } };
    }
    if (capability === 'setBuiltinToolEnabled') {
      return { [args[0]]: { enabled: args[1] } };
    }
    return {};
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({
          run,
          voice: { enabled: true, installed: true },
        }),
      }));
    });
    await openFeature('memory');
    await act(async () => document.querySelector('[data-feature-id="memory"] input').click());
    await openFeature('office');
    await act(async () => document.querySelector('[data-feature-id="office"] input').click());
    assert.equal(document.querySelector('input[aria-label="Observation only"]'), null);
    assert.deepEqual(calls, [
      ['setMemoryToolsEnabled', [false]],
      ['setBuiltinToolEnabled', ['office', false]],
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Browser Use install survives OFF and can be turned back ON without reinstalling', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let settings = {
    autoClear: true,
    autoCompact: true,
    keepAwake: true,
    usagePinned: false,
    computerControl: false,
    computerObserveOnly: false,
    browserControl: false,
    computerInstalled: false,
    browserInstalled: false,
  };
  const api = {
    readSettings: async () => settings,
    updateSetting: async (key, value) => {
      settings = { ...settings, [key]: value };
      return settings;
    },
    gitCliStatus: async () => ({ installed: true }),
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({ run: async () => ({}), api }),
      }));
    });
    await openFeature('browser');
    const install = document.querySelector(
      '[data-feature-id="browser"] button[aria-label="Install Browser Use"]',
    );
    assert.ok(install);
    await act(async () => {
      install.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(settings.browserInstalled, true);
    assert.equal(settings.browserControl, true);

    let toggle = document.querySelector('[data-feature-id="browser"] input[aria-label="Browser Use"]');
    assert.equal(toggle.checked, true);
    await act(async () => toggle.click());
    assert.equal(settings.browserControl, false);
    assert.equal(settings.browserInstalled, true);
    assert.equal(document.querySelector(
      '[data-feature-id="browser"] button[aria-label="Install Browser Use"]',
    ), null);

    toggle = document.querySelector('[data-feature-id="browser"] input[aria-label="Browser Use"]');
    await act(async () => toggle.click());
    assert.equal(settings.browserControl, true);
    assert.equal(settings.browserInstalled, true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Computer Use install survives OFF and can be turned back ON without reinstalling', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const originalUserAgent = navigator.userAgent;
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  });
  let settings = {
    autoClear: true,
    autoCompact: true,
    keepAwake: true,
    usagePinned: false,
    computerControl: false,
    computerObserveOnly: false,
    browserControl: false,
    computerInstalled: false,
    browserInstalled: false,
  };
  const api = {
    readSettings: async () => settings,
    updateSetting: async (key, value) => {
      settings = { ...settings, [key]: value };
      return settings;
    },
    gitCliStatus: async () => ({ installed: true }),
  };

  try {
    await act(async () => {
      root.render(React.createElement(CategoryPanel, {
        category: 'builtins',
        context: context({ run: async () => ({}), api }),
      }));
    });
    await openFeature('computer');
    const install = document.querySelector(
      '[data-feature-id="computer"] button[aria-label="Install Computer Use"]',
    );
    assert.ok(install);
    assert.equal(install.disabled, false);
    await act(async () => {
      install.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(settings.computerInstalled, true);
    assert.equal(settings.computerControl, true);

    let toggle = document.querySelector('[data-feature-id="computer"] input[aria-label="Computer Use"]');
    assert.equal(toggle.checked, true);
    await act(async () => toggle.click());
    assert.equal(settings.computerControl, false);
    assert.equal(settings.computerInstalled, true);
    assert.equal(document.querySelector(
      '[data-feature-id="computer"] button[aria-label="Install Computer Use"]',
    ), null);

    toggle = document.querySelector('[data-feature-id="computer"] input[aria-label="Computer Use"]');
    await act(async () => toggle.click());
    assert.equal(settings.computerControl, true);
    assert.equal(settings.computerInstalled, true);
  } finally {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    await act(async () => root.unmount());
    host.remove();
  }
});

test('runtime-backed Built-ins stay installed through OFF and ON', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  let toolModules = {
    memory: { enabled: true, installed: true },
    git: { enabled: true, installed: true },
    office: { enabled: true, installed: true },
  };
  let voice = { enabled: true, installed: true };
  const api = {
    gitCliStatus: async () => ({ installed: true }),
    libreOfficeStatus: async () => ({ installed: true }),
  };
  const run = async (capability, args) => {
    calls.push([capability, args]);
    if (capability === 'setMemoryToolsEnabled') {
      toolModules = { ...toolModules, memory: { enabled: args[0], installed: true } };
      return { memory: toolModules.memory };
    }
    if (capability === 'setBuiltinToolEnabled') {
      const id = args[0];
      toolModules = { ...toolModules, [id]: { enabled: args[1], installed: true } };
      return { [id]: toolModules[id] };
    }
    if (capability === 'toggleVoice') {
      voice = { enabled: args[0], installed: true };
      return voice;
    }
    return {};
  };
  const render = () => act(async () => {
    root.render(React.createElement(CategoryPanel, {
      category: 'builtins',
      context: context({ run, toolModules, voice, api }),
    }));
  });

  try {
    await render();
    for (const id of ['memory', 'git', 'office', 'voice']) {
      const label = id === 'voice' ? 'Voice transcription'
        : id[0].toUpperCase() + id.slice(1);
      await openFeature(id);
      let toggle = document.querySelector(`[data-feature-id="${id}"] input[aria-label="${label}"]`);
      assert.equal(toggle.checked, true, `${id} starts on`);

      await act(async () => toggle.click());
      await render();
      toggle = document.querySelector(`[data-feature-id="${id}"] input[aria-label="${label}"]`);
      assert.ok(toggle, `${id} stays installed after OFF`);
      assert.equal(toggle.checked, false, `${id} turns off`);
      assert.equal(document.querySelector(
        `[data-feature-id="${id}"] button[aria-label="Install ${label}"]`,
      ), null);

      await act(async () => toggle.click());
      await render();
      toggle = document.querySelector(`[data-feature-id="${id}"] input[aria-label="${label}"]`);
      assert.equal(toggle.checked, true, `${id} turns back on`);
    }
    assert.deepEqual(calls.slice(-8), [
      ['setMemoryToolsEnabled', [false]],
      ['setMemoryToolsEnabled', [true]],
      ['setBuiltinToolEnabled', ['git', false]],
      ['setBuiltinToolEnabled', ['git', true]],
      ['setBuiltinToolEnabled', ['office', false]],
      ['setBuiltinToolEnabled', ['office', true]],
      ['toggleVoice', [false]],
      ['toggleVoice', [true]],
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
