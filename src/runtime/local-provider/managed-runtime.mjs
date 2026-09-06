import {
  LOCAL_PROVIDER_BUILTIN_ID,
  LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_MANIFEST,
  detectLocalProviderHardware,
  installedLocalProviderModels,
  localProviderCatalogStatus,
} from './catalog.mjs';
import {
  downloadVerifiedLocalAsset,
  installLocalProviderModel,
  installLocalProviderRuntime,
} from './asset-installer.mjs';
import {
  ensureLocalProviderServer,
  localProviderServerStatus,
  stopLocalProviderServer,
  configureLocalProviderIdleTtl,
} from './server.mjs';
import { localProviderInstallStatus, cancelLocalInstallation } from './install-progress.mjs';
import { resumableLocalInstallations } from './resumable-installations.mjs';

export function localProviderStatus(options = {}) {
  const catalog = localProviderCatalogStatus(options);
  return {
    ...catalog,
    ...localProviderServerStatus(),
    installations: resumableLocalInstallations(catalog, localProviderInstallStatus(options.dataDir), options.dataDir),
  };
}

export {
  LOCAL_PROVIDER_BUILTIN_ID,
  LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_MANIFEST as localProviderManifestForTest,
  detectLocalProviderHardware,
  downloadVerifiedLocalAsset,
  ensureLocalProviderServer,
  installedLocalProviderModels,
  installLocalProviderModel,
  installLocalProviderRuntime,
  stopLocalProviderServer,
  configureLocalProviderIdleTtl,
  cancelLocalInstallation,
};
