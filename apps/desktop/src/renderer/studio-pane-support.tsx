import type { Dispatch, SetStateAction } from 'react';
import { t } from './i18n';
import type { StudioOptionRow, StudioSliderRow } from './StudioRouteMenu';
import { runStudioThumbnailTask } from './studio-thumbnail-task';
import {
  callCapability,
  type modelControls,
  pillLabel,
  type posterFromVideo,
  thumbFromImage,
  type MediaAsset,
  type MediaAssetRead,
  type MediaKind,
  type StudioApi,
  type StudioOptions,
} from './studio-support';

// Thumbnails are round-trip bound, not byte bound: a strictly sequential loop
// paid one full relay round trip per tile.
const THUMB_CONCURRENCY = 4;
export const EAGER_THUMB_COUNT = 12;
export const STUDIO_NARROW_PANE = 760;
// Gallery density steps: columns per row. The slider presents these in reverse
// so moving right follows the familiar smaller → larger thumbnail direction.
export const TILE_SIZES = [3, 4, 5, 6] as const;
export const TILE_SIZE_KEY = 'mixdog.studio-tile-size';
export const RATIO_CACHE_KEY = 'mixdog.studio-tile-ratios';
let videoPosterFallbackTail: Promise<void> = Promise.resolve();

function scheduleVideoPosterFallback<T>(task: () => Promise<T>): Promise<T> {
  const result = videoPosterFallbackTail.then(task, task);
  videoPosterFallbackTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function thumbnailPayload(dataUrl: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mime: match[1], base64: match[2] } : null;
}

/** One asset's original bytes and their media type. */
export interface MediaBytes {
  bytes: ArrayBuffer;
  mime: string;
}

export function base64Bytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** A named file for the device share sheet or the reference reader. */
export function mediaFile(asset: MediaAsset, media: MediaBytes): File {
  const extension = media.mime.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || (asset.kind === 'video' ? 'mp4' : 'png');
  return new File([media.bytes], `mixdog-${asset.id}.${extension}`, { type: media.mime });
}

/** Fallback thumbnail hydration ONLY: tiles normally load their rendition
 *  straight from the byte lane. This queue exists for hosts without that lane,
 *  and pulls the server-side rendition through the RPC surface instead. Local
 *  image misses read ONE original at a time through direct IPC and shrink it
 *  here: using a second mixdog-media:// URL merely joined the same delayed
 *  custom-protocol queue. Remote hosts keep the glyph rather than pulling a
 *  full-size asset across the link. Returns its own teardown. */
export function startStudioThumbnailHydration({
  api,
  assetUrl,
  captureVideoPoster,
  failedThumbsRef,
  loadedThumbsRef,
  localTransport,
  setDurations,
  setFailedThumbs,
  setThumbs,
  thumbFallbacks,
  thumbsRef,
  visibleAssets,
}: {
  api: StudioApi | undefined;
  assetUrl: (assetId: string, variant: string) => string;
  captureVideoPoster: typeof posterFromVideo;
  failedThumbsRef: { current: Record<string, boolean> };
  loadedThumbsRef: { current: Record<string, boolean> };
  localTransport: boolean;
  setDurations: Dispatch<SetStateAction<Record<string, number>>>;
  setFailedThumbs: (next: Record<string, boolean>) => void;
  setThumbs: (next: Record<string, string>) => void;
  thumbFallbacks: Record<string, true>;
  thumbsRef: { current: Record<string, string> };
  visibleAssets: MediaAsset[];
}): () => void {
  let stopped = false;
  const controller = new AbortController();
  // The active mode owns this queue: a global first-24 cutoff would strand
  // older clips whenever newer images occupied those slots.
  const queue = visibleAssets.filter(
    (asset, assetIndex) =>
      !loadedThumbsRef.current[asset.id] &&
      !thumbsRef.current[asset.id] &&
      !failedThumbsRef.current[asset.id] &&
      (thumbFallbacks[asset.id] ||
        !assetUrl(asset.id, 'thumb') ||
        // Hidden/unfocused Electron windows throttle short timers, so waiting
        // for onStall recreated a multi-second spinner. Hydrate only the eager
        // local image window immediately; one worker bounds original decoding.
        (localTransport && asset.kind === 'image' && assetIndex < EAGER_THUMB_COUNT))
  );
  const rememberDuration = (id: string, seconds: number) => {
    if (!seconds) return;
    setDurations((current) => (current[id] ? current : { ...current, [id]: seconds }));
  };
  const rememberThumb = (asset: MediaAsset, url: string, durationSeconds = 0): void => {
    // The direct request can win while fallback is decoding. In that case
    // keep the already-painted image instead of swapping sources and briefly
    // showing a second loader.
    if (!url || stopped || loadedThumbsRef.current[asset.id]) return;
    thumbsRef.current = { ...thumbsRef.current, [asset.id]: url };
    setThumbs(thumbsRef.current);
    const payload = thumbnailPayload(url);
    if (!payload || !localTransport) return;
    void callCapability(api, 'cacheMediaThumbnail', [
      asset.id,
      {
        ...payload,
        durationSeconds,
      },
    ]).catch(() => undefined);
  };
  const hydrate = async (asset: MediaAsset, signal: AbortSignal): Promise<void> => {
    if (localTransport && asset.kind === 'image') {
      const result = (await callCapability(api, 'readMediaAsset', [
        asset.id,
        {
          variant: 'thumb',
          allowOriginal: true,
          generate: false,
        },
      ])) as MediaAssetRead | null;
      if (signal.aborted) return;
      if (!result?.base64) throw new Error('thumbnail data unavailable');
      const raw = `data:${result.mime || asset.mime || 'image/png'};base64,${result.base64}`;
      const thumbnail = result.variant === 'thumb' ? raw : await thumbFromImage(raw, 420, signal);
      if (signal.aborted) return;
      if (!thumbnail) throw new Error('thumbnail decode failed');
      rememberThumb(asset, thumbnail);
      return;
    }
    const result = (await callCapability(api, 'readMediaAsset', [
      asset.id,
      {
        variant: 'thumb',
        // Chromium can capture a still when the host cannot build a video
        // rendition. Only local IPC may pay for the original clip bytes.
        allowOriginal: localTransport && asset.kind === 'video',
      },
    ])) as MediaAssetRead | null;
    if (signal.aborted) return;
    if (!result?.base64) throw new Error('thumbnail data unavailable');
    // Runtime metadata only carries a duration for some lanes; the poster
    // probe is authoritative for the tile badge.
    let durationSeconds = Number(result.durationSeconds) || 0;
    const raw = `data:${result.mime || (asset.kind === 'video' ? 'video/mp4' : 'image/png')};base64,${result.base64}`;
    const needsVideoPoster =
      asset.kind === 'video' &&
      (result.downgraded || result.variant !== 'thumb' || String(result.mime || '').startsWith('video/'));
    if (needsVideoPoster) {
      // One decoder at a time: retaining a live <video> per tile previously
      // exhausted Windows GPU resources and blacked the renderer window.
      const poster = await scheduleVideoPosterFallback(() => {
        if (signal.aborted) throw new Error('thumbnail hydration cancelled');
        return captureVideoPoster(raw);
      });
      if (signal.aborted) return;
      if (!poster.url) throw new Error('thumbnail decode failed');
      durationSeconds = poster.duration || durationSeconds;
      rememberDuration(asset.id, durationSeconds);
      rememberThumb(asset, poster.url, durationSeconds);
      return;
    }
    rememberDuration(asset.id, durationSeconds);
    rememberThumb(asset, raw, durationSeconds);
  };
  void (async () => {
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const asset = queue.shift();
        if (!asset) return;
        try {
          await runStudioThumbnailTask((signal) => hydrate(asset, signal), controller.signal);
        } catch {
          if (stopped) return;
          // A failed attempt is terminal for this pane, not an endless spinner
          // or an implicit retry whenever another asset updates the gallery.
          failedThumbsRef.current = { ...failedThumbsRef.current, [asset.id]: true };
          setFailedThumbs(failedThumbsRef.current);
        }
      }
    };
    await Promise.all(Array.from({ length: localTransport ? 1 : THUMB_CONCURRENCY }, () => worker()));
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}

/** The selected model's control contract as composer rows. Raw lane
 *  vocabulary ("auto", "1k") reads as noise next to the model name, so rows
 *  show a cased label while the value stays native. */
export function studioRouteRows({
  controls,
  disabled,
  kind,
  options,
  setOptions,
}: {
  controls: ReturnType<typeof modelControls>;
  disabled: boolean;
  kind: MediaKind;
  options: StudioOptions;
  setOptions: Dispatch<SetStateAction<StudioOptions>>;
}): { routeRows: StudioOptionRow[]; durationSlider: StudioSliderRow | null } {
  const optionRow = (
    id: string,
    label: string,
    values: readonly string[],
    current: string,
    onPick: (value: string) => void
  ): StudioOptionRow => ({
    id,
    label,
    options: values.map((value) => ({ value, label: pillLabel(value) })),
    value: current,
    valueLabel: pillLabel(current),
    disabled,
    onPick,
  });
  const routeRows: StudioOptionRow[] = [
    ...(controls.aspectRatio?.length
      ? [
          optionRow('aspectRatio', t('Aspect'), controls.aspectRatio, options.aspectRatio, (value) =>
            setOptions((current) => ({ ...current, aspectRatio: value }))
          ),
        ]
      : []),
    ...(controls.resolution?.length
      ? [
          optionRow(
            'resolution',
            t('Resolution'),
            controls.resolution,
            options.resolution || controls.resolution[0],
            (value) => setOptions((current) => ({ ...current, resolution: value }))
          ),
        ]
      : []),
    ...(controls.size?.length
      ? [
          optionRow('size', t('Size'), controls.size, options.size, (value) =>
            setOptions((current) => ({ ...current, size: value }))
          ),
        ]
      : []),
    ...(controls.quality?.length
      ? [
          optionRow('quality', t('Quality'), controls.quality, options.quality, (value) =>
            setOptions((current) => ({ ...current, quality: value }))
          ),
        ]
      : []),
    ...(kind === 'video' && controls.durations?.length
      ? [
          optionRow(
            'duration',
            t('Duration'),
            controls.durations.map((value) => `${value}s`),
            `${options.duration}s`,
            (value) =>
              setOptions((current) => ({
                ...current,
                duration: Number.parseInt(value, 10) || current.duration,
              }))
          ),
        ]
      : []),
  ];
  const durationSlider: StudioSliderRow | null =
    kind === 'video' && !controls.durations?.length && controls.durationRange
      ? {
          label: t('Duration'),
          min: controls.durationRange[0] ?? 1,
          max: controls.durationRange[1] ?? 15,
          value: options.duration,
          disabled,
          onChange: (next) => setOptions((current) => ({ ...current, duration: next })),
        }
      : null;
  return { routeRows, durationSlider };
}
