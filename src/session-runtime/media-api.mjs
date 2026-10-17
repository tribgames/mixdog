/**
 * Media studio API (image / video generation) exposed on the session runtime.
 *
 * The media graph (lane catalog, adapters, asset store) is imported on first
 * use: a session that never opens the Studio must not pay for it at boot.
 */
// Each loader keeps its literal import() so bundlers can trace it; only a
// resolved module is cached, so a failed import is retried on the next call.
function lazy(load) {
  let module = null;
  return async () => {
    module ??= await load();
    return module;
  };
}

const lanes = lazy(() => import('../runtime/media/lanes.mjs'));
const jobs = lazy(() => import('../runtime/media/jobs.mjs'));
const store = lazy(() => import('../runtime/media/store.mjs'));
const defaults = lazy(() => import('../runtime/media/defaults.mjs'));
const voice = lazy(() => import('../runtime/channels/lib/voice-setup.mjs'));

export function createMediaApi() {
  return {
    /** Read-only voice state: `voice.enabled` plus the managed whisper/ffmpeg
     *  runtime on disk. */
    async getVoiceStatus() {
      return (await voice()).getVoiceStatus();
    },
    /** Same toggle as the session `toggleVoice` action: enabling installs any
     *  missing whisper/ffmpeg component first. `error` carries the last
     *  warning or failure the toggle reported. */
    async setVoiceEnabled(enabled) {
      const module = await voice();
      let error = null;
      await module.toggleVoice({
        enabled,
        pushNotice: (text, level) => {
          if (level === 'warn' || level === 'error') error = text;
        },
      });
      return { status: await module.getVoiceStatus(), error };
    },
    async listMediaLanes() {
      return (await lanes()).listMediaLanes();
    },
    // The Studio's current selection is the runtime's default: a tool call
    // that omits lane/model follows it. Studio pushes on every settled change.
    async getMediaDefault(kind) {
      return (await defaults()).getMediaDefault(kind);
    },
    async setMediaDefault(input) {
      return (await defaults()).setMediaDefault(input || {});
    },
    // Settings → Built-in → Media generation: the default generator the media
    // tool uses per kind when the chat does not name one.
    async getMediaPins() {
      return (await defaults()).getMediaPins();
    },
    async setMediaPin(input) {
      return (await defaults()).setMediaPin(input || {});
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
    async deleteMediaAssets(filter) {
      return (await store()).deleteMediaAssets(filter || {});
    },
    async openMediaAsset(id) {
      return (await store()).openMediaAsset(id);
    },
    async openMediaFolder(id) {
      return (await store()).openMediaFolder(id);
    },
  };
}
