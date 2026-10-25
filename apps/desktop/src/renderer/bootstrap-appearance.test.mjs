// The renderer entry (bootstrap.tsx) paints the saved fonts and theme before it
// asks React for the first render: saved settings are already on the root at
// the moment render() is called. Everything else the entry installs is stubbed;
// the font and theme code is the real thing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';
import { THEME_SCHEMA_URL } from './appearance/theme-file';

const noop = () => () => {};
const stub = (namedExports) => ({ namedExports });
const Nothing = () => null;

const STUBS = {
  './process-shim.ts': {},
  './remote-shim.ts': {},
  './font-faces-styles.ts': {},
  './bootstrap-styles.ts': {},
  './webview-zoom.ts': {},
  './App.tsx': { App: Nothing },
  './AppUpdateBanner.tsx': { AppUpdateBanner: Nothing },
  './RemoteClaimPrompt.tsx': { RemoteClaimPrompt: Nothing },
  './RendererRecovery.tsx': {
    DesktopErrorBoundary: ({ children }) => children,
    installGlobalRendererDiagnostics: noop,
  },
  './remote-ui-projection.ts': { isNativeDesktopWindow: () => false },
  './shell-viewport.ts': { installShellViewport: noop },
  './focus-modality.ts': { installFocusModality: noop },
  './mobile-surface.ts': { installMobileSurfaceMarker: noop },
  './motion-visibility.ts': { installMotionVisibility: noop },
  './decorative-motion-sync.ts': { installDecorativeMotionSync: noop },
  './chat-text-size-preference.ts': { installChatTextSize: noop },
  './scrollbar-metrics.ts': { installScrollbarMetrics: noop },
  './boot-metrics.ts': { markBootStage() {} },
  './font-warmup.ts': { scheduleFontWarmup() {} },
  './session-lane-store.ts': { defaultSessionLaneStore: { start() {} } },
};

const THEME = JSON.stringify({
  $schema: THEME_SCHEMA_URL,
  name: 'Harbor',
  defs: { night: '#0f1720', paper: '#f6f3ea' },
  roles: { background: { dark: 'night', light: 'paper' }, text: { dark: '#e6edf3', light: '#1d232b' } },
});

test('the entry applies the saved fonts and theme before the first render', async (t) => {
  // Registered on the test context: restored when the test ends.
  let atFirstRender = null;
  t.mock.module('react-dom/client', {
    namedExports: {
      createRoot: () => ({
        render() {
          const root = document.documentElement;
          atFirstRender = {
            ui: root.style.getPropertyValue('--mx-font-ui-user'),
            scale: root.style.getPropertyValue('--mx-ui-scale'),
            themeSheet: document.getElementById('mixdog-user-theme')?.textContent ?? '',
          };
        },
      }),
    },
  });
  for (const [file, exports] of Object.entries(STUBS)) t.mock.module(file, stub(exports));
  const { window, document } = installTestDom(t, { actEnvironment: false, expose: ['MutationObserver'] });
  document.documentElement.dataset.mixdogTheme = 'dark';
  window.localStorage.setItem('mixdog.desktop.fonts.v1', JSON.stringify({ ui: 'Inter', uiScale: 0.9 }));
  window.localStorage.setItem(
    'mixdog.desktop.user-themes.v1',
    JSON.stringify([{ id: 'harbor', name: 'Harbor', source: THEME }])
  );
  window.localStorage.setItem('mixdog.desktop.user-theme.v1', 'harbor');

  await import('./bootstrap.tsx');

  assert.ok(atFirstRender, 'the entry asked React to render');
  assert.equal(atFirstRender.ui, '"Inter",');
  assert.equal(atFirstRender.scale, '0.9');
  assert.match(atFirstRender.themeSheet, /--mx-bg-deep: #0f1720;/);
});
