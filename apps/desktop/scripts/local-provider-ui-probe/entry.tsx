import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BuiltInFeaturesPanel } from '../../src/renderer/settings/built-in-features-panel';
import { initUiLanguage, setUiLanguagePreference } from '../../src/renderer/i18n';
import '../../src/renderer/bootstrap-styles';
import '../../src/renderer/settings/settings.css';
import '../../src/renderer/desktop/31-extensions.css';
import '../../src/renderer/desktop/28-usage-explorer.css';
import { settleFrames } from '../probe-settle';

const root = createRoot(document.getElementById('root')!);
(window as any).mixdogDesktop = { async setTitleBarDim() {}, rendererDiagnostic() {} };
const localProvider = {
  installed: true,
  enabled: true,
  available: true,
  // A loaded but idle model stays deletable; a failed download can be discarded.
  running: true,
  starting: false,
  activeModel: 'qwen',
  runtime: { installed: true, version: 'b10621', downloadBytes: 641907910 },
  hardware: {
    checking: true,
    gpu: { name: 'NVIDIA GeForce RTX 3090', memoryBytes: 24 * 1024 ** 3, freeMemoryBytes: 22 * 1024 ** 3 },
  },
  activeRequests: 0,
  queuedRequests: 0,
  idleTtlSeconds: 3600,
  installations: [
    {
      jobId: 'running-download',
      phase: 'model',
      modelId: 'gemma',
      state: 'running',
      percent: 42,
      receivedBytes: 3100000000,
      totalBytes: 7300000000,
    },
    {
      jobId: 'failed-download',
      phase: 'model',
      modelId: 'llama',
      state: 'failed',
      error: '[local-provider] download interrupted: network connection lost',
    },
  ],
  models: [
    {
      id: 'gemma',
      name: 'Gemma 4 12B Q4_K_M',
      installed: false,
      present: false,
      sizeBytes: 7300000000,
      contextWindow: 32768,
    },
    {
      id: 'llama',
      name: 'Llama 4 8B Q5_K_M',
      installed: false,
      present: false,
      sizeBytes: 5700000000,
      contextWindow: 32768,
    },
    {
      id: 'qwen',
      name: 'Qwen3.8 27B Q4_K_M',
      installed: true,
      present: true,
      sizeBytes: 18973870432,
      estimatedVramBytes: 23622320128,
      contextWindow: 32768,
      defaultContextWindow: 32768,
      minContextWindow: 16384,
      maxContextWindow: 262144,
      configuredContextWindow: null,
      supportsFunctionCalling: true,
      loadTimeMs: 3200,
      inference: { firstResponseMs: 180, tokensPerSecond: 34.2 },
    },
  ],
};
const api = { readCapabilities: async () => [{ ok: true, value: { localProvider } }] };
const run = async (capability: string) =>
  capability === 'getLocalProviderModelDetails'
    ? {
        confirmationToken: 'probe-confirmation',
        files: [{ path: 'C:\\Users\\me\\.mixdog\\data\\local-provider\\models\\qwen.gguf', size: 18973870432 }],
      }
    : { localProvider };
const noop = () => {};
const asyncNoop = async () => {};
const settle = () => settleFrames();
(window as any).localProviderProbe = {
  async render(theme: string, mobile: boolean) {
    setUiLanguagePreference('ko');
    await initUiLanguage();
    document.documentElement.dataset.mixdogTheme = theme;
    document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', mobile);
    document.documentElement.style.setProperty('--mx-device-scale', '1');
    flushSync(() =>
      root.render(
        <div className="app-shell" key={`${theme}-${mobile}`}>
          <BuiltInFeaturesPanel
            api={api as any}
            data={{ toolModules: { localProvider } }}
            snapshot={{} as any}
            pending=""
            run={run as any}
            route={asyncNoop}
            setFast={asyncNoop}
            confirm={noop}
            notice={noop}
            updaterState={{ status: 'disabled' }}
            checkDesktopUpdate={asyncNoop}
            installDesktopUpdate={asyncNoop}
          />
        </div>
      )
    );
    (document.querySelector('[data-built-in-feature="localProvider"]') as HTMLElement).click();
    await settle();
  },
  settle,
};
