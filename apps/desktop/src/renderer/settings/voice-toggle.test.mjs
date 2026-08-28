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

function context({ run, snapshot = null, voice = {} }) {
  return {
    api: {},
    data: {
      profile: { languages: [], experienceLevels: [] },
      toolModules: { webSearch: { enabled: true }, memory: { enabled: true } },
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

test('voice switch confirms missing downloads and shows live byte progress', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const install = deferred();
  const calls = [];
  const run = async (capability) => {
    calls.push(capability);
    return install.promise;
  };
  const render = (next) => act(async () => {
    root.render(React.createElement(CategoryPanel, {
      category: 'general',
      context: next,
    }));
  });

  try {
    await render(context({ run }));
    const voiceSwitch = document.querySelector('input[aria-label="Voice transcription"]');
    assert.ok(voiceSwitch);
    assert.equal(voiceSwitch.checked, false);

    await act(async () => voiceSwitch.click());
    assert.equal(calls.length, 0);
    assert.ok(document.querySelector('#voice-settings-install-title'));

    const installButton = document.querySelector('.voice-install-dialog button.primary');
    assert.ok(installButton);
    await act(async () => installButton.click());
    assert.deepEqual(calls, ['toggleVoice']);

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
    const progress = document.querySelector('.voice-install-progress-bar');
    assert.ok(progress);
    assert.equal(progress.getAttribute('aria-valuenow'), '42');
    assert.equal(progress.querySelector('span').style.width, '42%');

    await act(async () => install.resolve({ enabled: true, installed: true }));
    assert.equal(document.querySelector('.voice-install-dialog'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('failed voice installation stays actionable with retry', async () => {
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
        category: 'general',
        context: context({ run }),
      }));
    });
    await act(async () => document.querySelector('input[aria-label="Voice transcription"]').click());
    await act(async () => document.querySelector('.voice-install-dialog button.primary').click());
    assert.match(document.querySelector('#voice-settings-install-title').textContent, /Failed/);

    const retry = document.querySelector('.voice-install-dialog button.primary');
    assert.equal(retry.textContent, 'Retry');
    await act(async () => retry.click());
    assert.equal(calls, 2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
