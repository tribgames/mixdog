import type { Dispatch, SetStateAction } from 'react';
import { t } from './i18n';
import { materializeDroppedFiles } from './file-drag';
import type { QueuedMediaRequest, StudioMediaJob, StudioReference } from './studio-media-state';
import {
  callCapability,
  errorText,
  type MediaJob,
  type MediaKind,
  type MediaLane,
  type modelControls,
  requestOptions,
  type StudioApi,
  type StudioOptions,
} from './studio-support';

// Composer-side actions: reference images in, queued generation runs out.
export function createStudioGenerationActions({
  activeModel,
  api,
  controls,
  kind,
  lane,
  maxRefs,
  options,
  prompt,
  refs,
  setError,
  setJobs,
  setRefs,
}: {
  activeModel: string;
  api: StudioApi | undefined;
  controls: ReturnType<typeof modelControls>;
  kind: MediaKind;
  lane: MediaLane | null;
  maxRefs: number;
  options: StudioOptions;
  prompt: string;
  refs: StudioReference[];
  setError: (message: string) => void;
  setJobs: Dispatch<SetStateAction<StudioMediaJob[]>>;
  setRefs: Dispatch<SetStateAction<StudioReference[]>>;
}) {
  const openReference = async (reference: StudioReference, index: number) => {
    const extension = reference.mime.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png';
    try {
      await api?.openAttachmentImage?.(reference.url, `reference-${index + 1}.${extension}`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const picked = [...files].filter((file) => file.type.startsWith('image/')).slice(0, maxRefs - refs.length);
    const loaded = await Promise.all(
      picked.map(
        (file) =>
          new Promise<{ base64: string; mime: string; url: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
              const url = String(reader.result || '');
              resolve({ base64: url.split(',')[1] || '', mime: file.type || 'image/png', url });
            };
            reader.readAsDataURL(file);
          })
      )
    );
    setRefs((current) => [...current, ...loaded.filter((entry) => entry.base64)].slice(0, maxRefs));
  };
  const addDroppedFiles = async (transfer: DataTransfer) => {
    const loaded = await materializeDroppedFiles(window.mixdogDesktop, transfer, Math.max(0, maxRefs - refs.length));
    const images = loaded.files.filter((file) => file.type.startsWith('image/'));
    if (!images.length) {
      setError(loaded.errors[0] || t('Drop an image file to add a reference.'));
      return;
    }
    setError(loaded.errors[0] || '');
    await addFiles(images);
  };

  const startQueuedRequest = async (request: QueuedMediaRequest): Promise<boolean> => {
    setError('');
    try {
      const started = (await callCapability(api, 'startMediaJob', [
        {
          lane: request.lane,
          kind: request.kind,
          model: request.model,
          prompt: request.prompt,
          options: { ...request.options },
          references: request.references.map((ref) => ({
            base64: ref.base64,
            mime: ref.mime,
          })),
        },
      ])) as MediaJob | undefined;
      if (started) {
        setJobs((current) => [{ ...started, request }, ...current]);
        return true;
      }
      // An empty answer used to return silently, so Generate looked like a
      // dead button with nothing to read anywhere (user: 생성이 안 되는데
      // 오류도 안 뜬다).
      setError(t('Generation did not start — the runtime returned no job.'));
    } catch (reason) {
      setError(errorText(reason));
    }
    return false;
  };

  const generate = async () => {
    // No busy guard: a second Generate queues another run behind the first.
    if (!lane || !prompt.trim()) return;
    // Capture every mutable composer field before crossing the async bridge.
    // Later prompt/reference edits belong only to the next queue slot.
    await startQueuedRequest({
      lane: lane.id,
      kind,
      model: activeModel,
      prompt: prompt.trim(),
      options: { ...requestOptions(controls, kind, options) },
      references: refs.map((ref) => ({ ...ref })),
    });
  };

  const dismissJob = (id: string) => setJobs((current) => current.filter((entry) => entry.id !== id));

  const cancel = async (id: string) => {
    try {
      await callCapability(api, 'cancelMediaJob', [id]);
      // A cancel is deliberate: drop the slot instead of leaving a dead tile.
      dismissJob(id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return { addDroppedFiles, addFiles, cancel, dismissJob, generate, openReference, startQueuedRequest };
}
