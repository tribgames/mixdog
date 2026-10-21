import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  readStudioAssetReferences,
  removeStudioAssetReferences,
  type StudioReferenceStore,
} from './studio-draft-cache';
import type { StudioMediaJob, StudioReference } from './studio-media-state';
import type { createStudioGenerationActions } from './studio-pane-generation';
import type { createStudioMediaActions } from './studio-pane-media-actions';
import { mediaFile } from './studio-pane-support';
import {
  callCapability,
  errorText,
  type MediaAsset,
  type MediaKind,
  type StudioApi,
  type StudioOptions,
} from './studio-support';

type GenerationActions = ReturnType<typeof createStudioGenerationActions>;

/** A gallery asset's detail actions: remove it, reuse its recipe in the
 *  composer, add it as a reference, or queue its saved request again. */
export function createStudioAssetActions({
  addFiles,
  api,
  promptRef,
  readOriginalMedia,
  referenceStore,
  removeAsset,
  selected,
  setError,
  setHoverId,
  setJobs,
  setKind,
  setLaneId,
  setModel,
  setOptions,
  setPrompt,
  setRefs,
  setSelected,
  startQueuedRequest,
}: {
  addFiles: GenerationActions['addFiles'];
  api: StudioApi;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  readOriginalMedia: ReturnType<typeof createStudioMediaActions>['readOriginalMedia'];
  referenceStore?: StudioReferenceStore;
  removeAsset(asset: MediaAsset): void;
  selected: MediaAsset | null;
  setError(error: string): void;
  setHoverId(id: string): void;
  setJobs: Dispatch<SetStateAction<StudioMediaJob[]>>;
  setKind(kind: MediaKind): void;
  setLaneId(laneId: string): void;
  setModel(model: string): void;
  setOptions: Dispatch<SetStateAction<StudioOptions>>;
  setPrompt(prompt: string): void;
  setRefs(refs: StudioReference[]): void;
  setSelected(asset: MediaAsset | null): void;
  startQueuedRequest: GenerationActions['startQueuedRequest'];
}) {
  const remove = async (asset: MediaAsset) => {
    setHoverId('');
    try {
      await callCapability(api, 'deleteMediaAsset', [asset.id]);
      await removeStudioAssetReferences(asset.id, referenceStore);
      if (selected?.id === asset.id) setSelected(null);
      removeAsset(asset);
      // The run that produced this asset goes with it. A job left behind would
      // re-open its queue slot the moment the asset left the gallery.
      setJobs((current) => current.filter((entry) => entry.assetId !== asset.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  /** The references an asset was generated with, as composer chips. */
  const assetReferences = async (asset: MediaAsset): Promise<StudioReference[]> =>
    (await readStudioAssetReferences(asset.id, referenceStore)).map((reference) => ({
      ...reference,
      url: `data:${reference.mime};base64,${reference.base64}`,
    }));

  // Reuse restores the recipe into the composer — prompt, route, options and
  // references — to edit before the next run instead of repeating it as is.
  const reusePrompt = async (asset: MediaAsset) => {
    const references = await assetReferences(asset);
    setKind(asset.kind);
    setLaneId(asset.lane);
    setModel(asset.model);
    setOptions((current) => ({ ...current, ...(asset.options || {}) }));
    setPrompt(asset.prompt);
    setRefs(references);
    setSelected(null);
    promptRef.current?.focus({ preventScroll: true });
  };

  // The asset joins the next run's references through the same reader as a
  // picked file, so the model's reference cap applies unchanged.
  const addAssetReference = async (asset: MediaAsset) => {
    try {
      await addFiles([mediaFile(asset, await readOriginalMedia(asset))]);
      setSelected(null);
      promptRef.current?.focus({ preventScroll: true });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  // Detail actions: queue the saved request again, hand the file to the OS
  // viewer, or remove it from the gallery.
  const regenerate = async (asset: MediaAsset) => {
    if (!asset.prompt.trim()) return;
    const references = await assetReferences(asset);
    const started = await startQueuedRequest({
      lane: asset.lane,
      kind: asset.kind,
      model: asset.model,
      prompt: asset.prompt.trim(),
      options: { ...(asset.options || {}) },
      references,
    });
    if (started) {
      setKind(asset.kind);
      setSelected(null);
    }
  };

  return { addAssetReference, regenerate, remove, reusePrompt };
}
