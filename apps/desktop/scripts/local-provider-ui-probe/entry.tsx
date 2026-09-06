import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BuiltInFeaturesPanel } from '../../src/renderer/settings/built-in-features-panel';
import { initUiLanguage, setUiLanguagePreference } from '../../src/renderer/i18n';
import '../../src/renderer/bootstrap-styles';
import '../../src/renderer/settings/settings.css';
import '../../src/renderer/desktop/31-extensions.css';

const root = createRoot(document.getElementById('root')!);
(window as any).mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
const localProvider = {
  installed: true, enabled: true, available: true, running: false, starting: false,
  runtime: { installed: true, version: 'b10621', downloadBytes: 641907910 },
  hardware: { checking: true, gpu: { name: 'NVIDIA GeForce RTX 3090', memoryBytes: 24 * 1024 ** 3, freeMemoryBytes: 22 * 1024 ** 3 } },
  activeRequests: 0, queuedRequests: 0, idleTtlSeconds: 3600, installations: [],
  models: [{ id: 'qwen', name: 'Qwen3.8 27B Q4_K_M', installed: true, present: true,
    sizeBytes: 18973870432, estimatedVramBytes: 23622320128, contextWindow: 32768,
    supportsFunctionCalling: true, loadTimeMs: 3200, inference: { firstResponseMs: 180, tokensPerSecond: 34.2 } }],
};
const api = { readCapabilities: async () => [{ ok: true, value: { localProvider } }] };
const run = async () => ({ localProvider });
async function settle() {
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish();
  }
}
(window as any).localProviderProbe = {
  async render(theme: string, mobile: boolean) {
    setUiLanguagePreference('ko');
    await initUiLanguage();
    document.documentElement.dataset.mixdogTheme = theme;
    document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', mobile);
    document.documentElement.style.setProperty('--mx-device-scale', '1');
    flushSync(() => root.render(<div className="app-shell" key={`${theme}-${mobile}`}>
      <BuiltInFeaturesPanel api={api as any} data={{ toolModules: { localProvider } }} snapshot={{} as any}
        pending="" run={run as any} />
    </div>));
    (document.querySelector('[data-built-in-feature="localProvider"]') as HTMLElement).click();
    await settle();
  },
  settle,
};
