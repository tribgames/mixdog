import { huggingFaceCatalog } from '../runtime/local-provider/hugging-face.mjs';
import { modelMaintenance } from '../runtime/local-provider/model-maintenance.mjs';

export function createLocalModelApi({ refreshLocalProviderCatalog } = {}) {
  return {
    searchLocalProviderModels(query) { return huggingFaceCatalog().search(query); },
    inspectHuggingFaceModel(options) { return huggingFaceCatalog().inspect(options); },
    registerHuggingFaceModel(previewId, licenseAccepted) {
      return huggingFaceCatalog().register(previewId, licenseAccepted);
    },
    getLocalProviderModelDetails(modelId) { return modelMaintenance().details(modelId); },
    startLocalProviderModelMaintenance(modelId, operation) {
      const job = modelMaintenance().start(modelId, operation, { onComplete: refreshLocalProviderCatalog });
      return { job, localProvider: this.getToolModuleSettings().localProvider };
    },
    async deleteLocalProviderModel(confirmationToken) {
      const result = await modelMaintenance().delete(confirmationToken);
      await refreshLocalProviderCatalog?.();
      return { ...result, localProvider: this.getToolModuleSettings().localProvider };
    },
  };
}
