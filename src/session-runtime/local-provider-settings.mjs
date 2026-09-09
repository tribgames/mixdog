import { localIdleTtlSeconds } from '../runtime/local-provider/request-queue.mjs';
import { createLocalModelApi } from './local-model-api.mjs';
import { setLocalProviderContext } from '../runtime/local-provider/server.mjs';

export function createLocalProviderSettings({
  getConfig, saveConfigAndAdopt, getLocalProviderStatus, prepareLocalProviderModel,
  refreshLocalProviderCatalog, cancelLocalProviderInstallation, configureLocalProviderIdleTtl,
}) {
  let commandError = null;
  return {
    status: () => ({ installationCommandError: commandError }),
    methods: {
      ...createLocalModelApi({ refreshLocalProviderCatalog }),
      async setLocalProviderContext(modelId, tokens) {
        await setLocalProviderContext(modelId, tokens);
        await refreshLocalProviderCatalog?.();
        return this.getToolModuleSettings();
      },
      async installLocalProviderModel(modelId) {
        await prepareLocalProviderModel?.(modelId);
        await refreshLocalProviderCatalog?.();
        return this.getToolModuleSettings();
      },
      startLocalProviderInstallation(phase, modelId) {
        if (phase !== 'runtime' && phase !== 'model') throw new TypeError('phase must be runtime or model.');
        if (phase === 'model' && !(getLocalProviderStatus?.().models || []).some((model) => model.id === modelId)) {
          throw new TypeError('modelId must identify a model in the Local Provider catalog.');
        }
        if (phase === 'runtime' && modelId != null && modelId !== '') throw new TypeError('runtime installation does not accept modelId.');
        commandError = null;
        const pending = phase === 'runtime' ? this.installBuiltinFeature('localProvider') : this.installLocalProviderModel(modelId);
        void Promise.resolve(pending).catch((error) => {
          // Explicit pauses are represented by the shared installation job.
          const paused = (getLocalProviderStatus?.().installations || []).some((entry) =>
            entry.phase === phase && (phase === 'runtime' || entry.modelId === modelId) && entry.state === 'paused');
          if (!paused) commandError = String(error?.message || error);
        });
        return this.getToolModuleSettings();
      },
      cancelLocalProviderInstallation(jobId) {
        if (typeof jobId !== 'string' || !jobId.trim()) throw new TypeError('jobId is required.');
        cancelLocalProviderInstallation(jobId);
        return this.getToolModuleSettings();
      },
      setLocalProviderIdleTtl(seconds) {
        const idleTtlSeconds = localIdleTtlSeconds(seconds);
        const config = getConfig();
        saveConfigAndAdopt({ ...config, providers: { ...config.providers,
          'mixdog-local': { ...config.providers?.['mixdog-local'], idleTtlSeconds } } });
        configureLocalProviderIdleTtl?.(idleTtlSeconds);
        return this.getToolModuleSettings();
      },
    },
  };
}
