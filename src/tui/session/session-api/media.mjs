/**
 * media.mjs — the session object's media/presentation surface: voice
 * (status, toggle, desktop dictation), composer image resize, setup-request
 * claims, the TUI theme, and the media studio passthroughs.
 */
import { listThemes, getThemeSetting, setThemeSetting } from '../../theme.mjs';
import { getVoiceStatus, toggleVoice } from '../../lib/voice-setup.mjs';

const AUDIO_EXTENSIONS = [
  [/ogg/i, 'ogg'],
  [/wav/i, 'wav'],
  [/mp4|m4a/i, 'm4a'],
];

function voiceToggleResult(result) {
  if (typeof result === 'boolean') return { ok: true, enabled: result };
  return result && typeof result === 'object' ? result : { ok: false };
}

export function createSessionMediaApi(bag) {
  const { runtime, getState, set, pushNotice, setProgressHint, routeState } = bag;

  return {
    getVoiceStatus: () => getVoiceStatus(),
    // Desktop push-to-talk dictation: accept a recorded audio payload
    // (base64), stage it as a temp file, and run it through the SAME managed
    // whisper.cpp pipeline the channels use (ffmpeg convert -> whisper server,
    // standard multilingual Q8 model). Returns the transcript text or throws a
    // user-actionable error (e.g. runtime not installed).
    transcribeAudio: async ({ data, mimeType = 'audio/webm' } = {}) => {
      const base64 = String(data || '');
      if (!base64) throw new Error('transcribeAudio: audio payload is required');
      if (base64.length > 40_000_000) throw new Error('transcribeAudio: recording too large');
      const [{ createVoiceTranscription }, { resolvePluginData }, { readSection }, os, path, fsp, crypto] =
        await Promise.all([
          import('../../../runtime/channels/lib/voice-transcription.mjs'),
          import('../../../runtime/shared/plugin-paths.mjs'),
          import('../../../runtime/shared/config.mjs'),
          import('node:os'),
          import('node:path'),
          import('node:fs/promises'),
          import('node:crypto'),
        ]);
      const extension = AUDIO_EXTENSIONS.find(([pattern]) => pattern.test(mimeType))?.[1] ?? 'webm';
      const audioPath = path.join(os.tmpdir(), `mixdog-dictation-${process.pid}-${Date.now()}.${extension}`);
      await fsp.writeFile(audioPath, Buffer.from(base64, 'base64'));
      try {
        const { transcribeVoice } = createVoiceTranscription({
          getConfig: () => ({ voice: readSection('voice') || {} }),
          dataDir: resolvePluginData(),
        });
        const text = await transcribeVoice(audioPath, {
          attachmentId: `dictation-${crypto.randomUUID()}`,
        });
        return typeof text === 'string' ? text : '';
      } finally {
        fsp.rm(audioPath, { force: true }).catch(() => undefined);
      }
    },
    // Desktop composer image attach: run the SAME optional-sharp resize
    // pipeline the TUI paste path uses. The current provider selects the
    // Anthropic 2000px/5MB profile or OpenAI 2048px/1536-patch profile.
    resizeImage: async ({ data, mimeType = 'image/png', filename = '' } = {}) => {
      const base64 = String(data || '');
      if (!base64) throw new Error('resizeImage: image payload is required');
      if (base64.length > 40_000_000) throw new Error('resizeImage: image too large');
      const { imageAttachmentFromBuffer } = await import('../../paste-attachments.mjs');
      const attachment = await imageAttachmentFromBuffer(
        Buffer.from(base64, 'base64'),
        String(mimeType || 'image/png'),
        {
          filename: String(filename || 'Pasted image'),
          provider: routeState().provider || '',
        }
      );
      return {
        data: attachment.content,
        mimeType: attachment.mediaType,
        metadataText: attachment.metadataText || '',
      };
    },
    claimSetupRequest: (id, owner) => runtime.claimSetupRequest(id, owner),
    isSetupRequestActive: (id, owner) => runtime.isSetupRequestActive(id, owner),
    completeSetupRequest: (id, owner, receipt) => runtime.completeSetupRequest(id, owner, receipt),
    toggleVoice: async (enabled) => {
      const result = await toggleVoice({
        pushNotice,
        setProgressHint,
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
      });
      return {
        ...(await getVoiceStatus()),
        result: voiceToggleResult(result),
      };
    },
    // Theme is a TUI-local concern (no runtime round-trip). listThemes returns
    // picker metadata; getTheme reports the active id; setTheme applies the
    // palette in-place + persists ui.theme and bumps a themeEpoch so the React
    // tree re-renders (markdown/status/spinner colorizers re-resolve).
    listThemes: () => listThemes(),
    getTheme: () => getThemeSetting(),
    setTheme: (id, options = {}) => {
      const applied = setThemeSetting(id, options);
      set({ themeEpoch: (getState().themeEpoch || 0) + 1 });
      return applied;
    },
    // Media studio (image/video generation). Reads stay quiet, and there is no
    // notice on start either: the Studio surfaces progress on its own pending
    // tile, and a toast for a user-initiated generation is pure noise.
    listMediaLanes: () => runtime.listMediaLanes?.(),
    getMediaDefault: (kind) => runtime.getMediaDefault?.(kind),
    setMediaDefault: (input) => runtime.setMediaDefault?.(input),
    listMediaAssets: (options) => runtime.listMediaAssets?.(options),
    readMediaAsset: (id, options) => runtime.readMediaAsset?.(id, options),
    cacheMediaThumbnail: (id, input) => runtime.cacheMediaThumbnail?.(id, input),
    resolveMediaFile: (id, options) => runtime.resolveMediaFile?.(id, options),
    getMediaJob: (id) => runtime.getMediaJob?.(id),
    listMediaJobs: () => runtime.listMediaJobs?.(),
    startMediaJob: (input) => runtime.startMediaJob(input),
    cancelMediaJob: (id) => runtime.cancelMediaJob?.(id),
    deleteMediaAsset: (id) => runtime.deleteMediaAsset?.(id),
    openMediaAsset: (id) => runtime.openMediaAsset?.(id),
    openMediaFolder: (id) => runtime.openMediaFolder?.(id),
  };
}
