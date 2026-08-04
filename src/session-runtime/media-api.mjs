/**
 * Media studio API (image / video generation) exposed on the session runtime.
 *
 * The media graph (lane catalog, adapters, asset store) is imported on first
 * use: a session that never opens the Studio must not pay for it at boot.
 */
let laneModule = null;
let jobModule = null;
let storeModule = null;

async function lanes() {
  laneModule ??= await import('../runtime/media/lanes.mjs');
  return laneModule;
}

async function jobs() {
  jobModule ??= await import('../runtime/media/jobs.mjs');
  return jobModule;
}

async function store() {
  storeModule ??= await import('../runtime/media/store.mjs');
  return storeModule;
}

export function createMediaApi() {
  return {
    async listMediaLanes() {
      return (await lanes()).listMediaLanes();
    },
    async startMediaJob(input) {
      return (await jobs()).startMediaJob(input || {});
    },
    async getMediaJob(id) {
      return (await jobs()).getMediaJob(id);
    },
    async listMediaJobs() {
      return (await jobs()).listMediaJobs();
    },
    async cancelMediaJob(id) {
      return (await jobs()).cancelMediaJob(id);
    },
    async listMediaAssets(options) {
      return (await store()).listMediaAssets(options || {});
    },
    async readMediaAsset(id, options) {
      return (await store()).readMediaAsset(id, options || {});
    },
    async cacheMediaThumbnail(id, input) {
      return (await store()).cacheMediaThumbnail(id, input || {});
    },
    async resolveMediaFile(id, options) {
      return (await store()).resolveMediaFile(id, options || {});
    },
    async deleteMediaAsset(id) {
      return (await store()).deleteMediaAsset(id);
    },
    async openMediaAsset(id) {
      return (await store()).openMediaAsset(id);
    },
    async openMediaFolder(id) {
      return (await store()).openMediaFolder(id);
    },
  };
}
