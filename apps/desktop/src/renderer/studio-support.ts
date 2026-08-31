import type { DesktopApi, DesktopCapability } from '../shared/contract';

export type MediaKind = 'image' | 'video';
export const MEDIA_KINDS: MediaKind[] = ['image', 'video'];
export type StudioApi = Partial<Pick<
  DesktopApi,
  'invokeCapability' | 'mediaUrl' | 'openAttachmentImage' | 'openMediaAsset' | 'openMediaFolder'
>>;
export type RecordValue = Record<string, unknown>;

export interface MediaModel {
  id: string;
  label: string;
  /** Effective controls for this model (lane defaults + model overrides). */
  controls?: MediaControls;
}

export interface MediaControls {
  aspectRatio?: string[];
  resolution?: string[];
  size?: string[];
  quality?: string[];
  durationRange?: [number, number];
  durations?: number[];
  /** How many reference images this model accepts. */
  maxReferences?: number;
}

export interface MediaKindSpec {
  models: MediaModel[];
  defaultModel: string;
  controls: MediaControls;
}

export interface MediaLane {
  id: string;
  label: string;
  authType: string;
  authProvider: string;
  authenticated: boolean;
  kinds: MediaKind[];
  image: MediaKindSpec | null;
  video: MediaKindSpec | null;
}

export interface MediaJob {
  id: string;
  status: 'running' | 'done' | 'failed' | 'canceled';
  kind: MediaKind;
  lane: string;
  model: string;
  options?: Partial<StudioOptions>;
  progress: number;
  assetId: string | null;
  error: string | null;
  /** Epoch ms the runtime accepted the job; drives the elapsed-time rail. */
  startedAt?: number;
}

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  lane: string;
  model: string;
  prompt: string;
  options?: Partial<StudioOptions>;
  mime: string;
  bytes: number;
  createdAt: number;
  durationSeconds?: number;
}

export interface StudioOptions {
  aspectRatio: string;
  resolution: string;
  size: string;
  quality: string;
  duration: number;
}

/**
 * One readMediaAsset answer.
 *
 * `variant` is what the host actually produced, not what was asked for: a host
 * without sharp/ffmpeg cannot build a rendition and either reports the miss
 * (`available: false`) or returns the original marked `downgraded`.
 */
export interface MediaAssetRead {
  base64?: string;
  mime?: string;
  variant?: string;
  available?: boolean;
  downgraded?: boolean;
  durationSeconds?: number;
}

/** True when media bytes ride local IPC (desktop), false behind the LAN
 *  bridge / relay. Only a local host may afford shrinking a full-size asset
 *  in the renderer; over the wire that IS the cost being removed. */
export function mediaTransportIsLocal(): boolean {
  return !(window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
}

/**
 * Direct byte-lane URL for an asset/rendition, or '' when this host has none.
 *
 * Everything about the gallery's cost model follows from using it: the DOM
 * fetches media itself, the browser caches and revalidates it, and a <video>
 * seeks with byte ranges instead of downloading the whole clip first.
 */
export function mediaUrl(api: StudioApi | undefined, assetId: string, variant: string): string {
  try {
    return api?.mediaUrl?.(assetId, variant) || '';
  } catch {
    return '';
  }
}

export function mediaVariantKey(assetId: string, variant: string): string {
  return `${assetId}:${variant}`;
}

/**
 * One probe that answers "does THIS host serve the byte lane at all".
 *
 * Without it the gallery learns the answer tile by tile, from a failed image
 * load per asset — and a host that was merely mid-reconnect strands those
 * assets on the RPC payload for the rest of the session. Local (Electron)
 * transport always serves it, so only a remote surface pays the round trip.
 */
export async function probeMediaLane(api: StudioApi | undefined): Promise<boolean> {
  if (mediaTransportIsLocal()) return true;
  const url = mediaUrl(api, 'healthz', 'original');
  if (!url) return false;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

export const DEFAULT_STUDIO_OPTIONS: StudioOptions = {
  aspectRatio: 'auto',
  resolution: '',
  size: 'auto',
  quality: 'auto',
  duration: 5,
};

/**
 * Stable gallery ratio before a thumbnail or video poster decodes.
 *
 * Generated assets carry their requested aspect in metadata. Falling back by
 * media kind keeps a new tile from painting square and resizing a frame later.
 */
export function mediaFrameRatio(media: Pick<MediaAsset, 'kind' | 'options'> | Pick<MediaJob, 'kind' | 'options'>): number {
  return parseAspect(String(media.options?.aspectRatio || ''))
    || (media.kind === 'video' ? 16 / 9 : 1);
}

/** Keep the generation slot until its indexed asset can replace it in place. */
export function shouldKeepMediaJobSlot(job: MediaJob | null, assets: MediaAsset[], kind: MediaKind): boolean {
  if (!job || job.kind !== kind) return false;
  if (job.status === 'running' || job.status === 'failed') return true;
  return job.status === 'done' && (!job.assetId || !assets.some((asset) => asset.id === job.assetId));
}

/** Only send controls the selected MODEL actually declares. */
export function requestOptions(controls: MediaControls, kind: MediaKind, options: StudioOptions): RecordValue {
  const payload: RecordValue = {};
  if (controls.aspectRatio?.length) payload.aspectRatio = options.aspectRatio;
  if (controls.resolution?.length) payload.resolution = options.resolution || controls.resolution[0];
  if (controls.size?.length) payload.size = options.size;
  if (controls.quality?.length) payload.quality = options.quality;
  if (kind === 'video' && (controls.durationRange || controls.durations?.length)) {
    // Clamp at the boundary: the UI may still hold a value from another model.
    if (controls.durations?.length) {
      payload.duration = controls.durations.includes(options.duration)
        ? options.duration
        : controls.durations[0];
    } else if (controls.durationRange) {
      const [min, max] = controls.durationRange;
      payload.duration = Math.min(max, Math.max(min, options.duration));
    }
  }
  return payload;
}

/** Controls for the selected model, falling back to the lane defaults. */
export function modelControls(spec: MediaKindSpec | null, model: string): MediaControls {
  if (!spec) return {};
  return spec.models.find((entry) => entry.id === model)?.controls || spec.controls || {};
}

export function laneSpec(lane: MediaLane | null, kind: MediaKind): MediaKindSpec | null {
  if (!lane) return null;
  return kind === 'video' ? lane.video : lane.image;
}

/** Resolve a model that belongs to the active media contract before paint. */
export function resolveStudioModel(spec: MediaKindSpec | null, model: string): string {
  if (!spec) return '';
  if (spec.models.some((entry) => entry.id === model)) return model;
  if (spec.models.some((entry) => entry.id === spec.defaultModel)) return spec.defaultModel;
  return spec.models[0]?.id || '';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function assetLabel(asset: MediaAsset): string {
  const parts = [asset.model, formatBytes(asset.bytes)];
  if (asset.durationSeconds) parts.push(`${asset.durationSeconds}s`);
  return parts.filter(Boolean).join(' · ');
}

/** Capability call helper: unwraps { value } and normalizes errors to strings. */
export async function callCapability(
  api: StudioApi | undefined,
  capability: DesktopCapability,
  args: unknown[] = [],
): Promise<unknown> {
  if (!api?.invokeCapability) return undefined;
  const result = await api.invokeCapability({ capability, args });
  return result?.value;
}

export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** '16:9' → 1.78; 'auto' or anything unparsable → 0 (caller picks a default). */
export function parseAspect(value: string): number {
  const match = /^(\d+)\s*:\s*(\d+)$/.exec(String(value || '').trim());
  if (!match) return 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 0;
}

export interface JustifiedTile {
  asset: MediaAsset;
  width: number;
  height: number;
}

// Task uses an 800px outer column with a 32px composer inset on each side.
// Studio tiles occupy that same inner line, rather than protruding to the
// outer column edges.
export const STUDIO_GRID_MAX_WIDTH = 736;
export const STUDIO_GRID_GAP = 12;

/** Exact target height for a gallery density step. Keeping the fractional
 *  pixel is important: rounding 3-up down by one third made three square
 *  tiles total 735px, so the row solver incorrectly admitted a fourth tile. */
export function studioTargetRowHeight(
  columns: number,
  width = STUDIO_GRID_MAX_WIDTH,
  gap = STUDIO_GRID_GAP,
): number {
  const count = Math.max(1, Math.trunc(columns) || 1);
  return Math.max(1, (Math.max(1, width) - gap * (count - 1)) / count);
}

/**
 * Justified rows (Flickr/Google Photos grammar).
 *
 * Pack tiles at a target height until the row would overflow, then solve the
 * row height so the widths add up to EXACTLY the container width. flex-grow
 * cannot do this: it stretches widths while the height stays fixed, which
 * crops every tile and leaves one item per row.
 */
export function justifiedRows(
  assets: MediaAsset[],
  ratios: Record<string, number>,
  containerWidth: number,
  targetHeight: number,
  gap = 12,
  packingWidth = containerWidth,
): JustifiedTile[][] {
  const width = Math.max(1, containerWidth);
  const packWidth = Math.max(1, packingWidth);
  const rows: JustifiedTile[][] = [];
  let current: MediaAsset[] = [];
  let ratioSum = 0;
  // Height of the last SOLVED row: the trailing row matches it instead of the
  // raw target, otherwise a short last row towers over the rows above it.
  let solvedHeight = 0;

  const flush = (isLast: boolean) => {
    if (!current.length) return;
    const gaps = gap * (current.length - 1);
    let height = (width - gaps) / ratioSum;
    if (isLast) {
      const cap = solvedHeight || targetHeight;
      if (height > cap) height = cap;
    } else {
      solvedHeight = height;
    }
    rows.push(current.map((asset) => ({
      asset,
      width: (ratios[asset.id] || 1) * height,
      height,
    })));
    current = [];
    ratioSum = 0;
  };

  for (const asset of assets) {
    current.push(asset);
    ratioSum += ratios[asset.id] || 1;
    const gaps = gap * (current.length - 1);
    // A dock animation changes the solved width every frame. Packing against
    // a stable width keeps the same assets in each row while their dimensions
    // interpolate, instead of throwing a tile between rows mid-transition.
    if (ratioSum * targetHeight + gaps >= packWidth) flush(false);
  }
  flush(true);
  return rows;
}

/**
 * Grab a still from a video data URL.
 *
 * Keeping live <video> elements in the gallery kept a decoder alive per tile;
 * on Windows that stack blacked the window out whenever another layer
 * repainted (slider drags). A one-shot canvas grab leaves only images behind.
 */
export interface VideoPoster {
  url: string;
  /** Clip length in seconds, read off the decoded metadata. */
  duration: number;
}

export function posterFromVideo(dataUrl: string, maxEdge = 420): Promise<VideoPoster> {
  return grabFirstFrame(dataUrl, maxEdge);
}

/**
 * Downscale a still to a gallery-sized JPEG.
 *
 * Full-resolution base64 stills (2-4 MP each) kept the whole grid in GPU
 * memory; a repaint storm (dragging the duration slider) then took the window
 * down. Tiles only ever need ~420px.
 */
export function thumbFromImage(dataUrl: string, maxEdge = 420): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onerror = () => reject(new Error('thumbnail decode failed'));
    image.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      } catch (reason) {
        reject(reason);
      }
    };
    image.src = dataUrl;
  });
}

function grabFirstFrame(sourceUrl: string, maxEdge: number): Promise<VideoPoster> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason instanceof Error ? reason : new Error('poster capture failed'));
    };
    video.onerror = () => fail(new Error('video decode failed'));
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
      } catch (reason) {
        fail(reason);
      }
    };
    video.onseeked = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(video.videoWidth || 1, video.videoHeight || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((video.videoWidth || maxEdge) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || maxEdge) * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas unavailable');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const poster = canvas.toDataURL('image/jpeg', 0.72);
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration) : 0;
        cleanup();
        resolve({ url: poster, duration });
      } catch (reason) {
        fail(reason);
      }
    };
    video.src = sourceUrl;
  });
}
