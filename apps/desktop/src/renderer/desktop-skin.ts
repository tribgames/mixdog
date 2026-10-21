// Skins (Settings → Display): a background picture under the shell plus an
// accent color taken from it. Device-local like the theme; the CSS lives in
// desktop/33-skin.css and reuses the Mica translucency plumbing.
import glassFlow from './skins/glass-flow.jpg';
import nightCity from './skins/night-city.jpg';
import springWindow from './skins/spring-window.jpg';
import techStudio from './skins/tech-studio.jpg';
import glassFlowLoop from './skins/glass-flow.webm';
import nightCityLoop from './skins/night-city.webm';
import springWindowLoop from './skins/spring-window.webm';
import techStudioLoop from './skins/tech-studio.webm';

import {
  castOfColor,
  clampTransparency,
  DEFAULT_MAIN_TRANSPARENCY,
  DEFAULT_TRANSPARENCY,
  focalOfPoint,
  hslToHex,
  LEGACY_DIM_TRANSPARENCY,
  resolvePalette,
  rgbToHsl,
  type SkinCast,
  type SkinPlate,
  type SkinTheme,
} from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';
import { subscribeUserTheme, userThemeAccent } from './appearance/user-theme';
import { syncSkinBootSnapshot } from './skin-boot-snapshot';
import { deleteCustomSkinMedia, putCustomSkinMedia, readCustomSkinMedia } from './skin-media-store';
import { type SkinMotion, syncSkinMotion } from './skin-motion';
import { isRemoteBrowserRenderer } from './remote-ui-projection';

export type SkinId = 'none' | 'custom' | (string & {});
export type { SkinPlate };

const IMAGES: Record<string, string> = {
  'glass-flow.jpg': glassFlow,
  'night-city.jpg': nightCity,
  'spring-window.jpg': springWindow,
  'tech-studio.jpg': techStudio,
};

const LOOPS: Record<string, string> = {
  'glass-flow.webm': glassFlowLoop,
  'night-city.webm': nightCityLoop,
  'spring-window.webm': springWindowLoop,
  'tech-studio.webm': techStudioLoop,
};

export const BUILTIN_SKINS = SKIN_MANIFEST.map((entry) => ({
  ...entry,
  image: IMAGES[entry.file],
  video: LOOPS[entry.loop],
}));

const SKIN_KEY = 'mixdog.desktop.skin.v1';
const CUSTOM_IMAGE_KEY = 'mixdog.desktop.skin-custom-image.v1';
/** Read-only fallback: the single slider of earlier builds (both sliders inherit it). */
const SKIN_TRANSPARENCY_KEY = 'mixdog.desktop.skin-transparency.v1';
const SKIN_OUTER_TRANSPARENCY_KEY = 'mixdog.desktop.skin-transparency-outer.v1';
const SKIN_MAIN_TRANSPARENCY_KEY = 'mixdog.desktop.skin-transparency-main.v1';
/** Read-only fallback: older builds stored soft / normal / strong here. */
const LEGACY_SKIN_DIM_KEY = 'mixdog.desktop.skin-dim.v1';
const FALLBACK_PICTURE = '#808080';
const SKIN_PLATE_KEY = 'mixdog.desktop.skin-plate.v1';
const SKIN_PHOTO_KEY = 'mixdog.desktop.skin-photo.v1';
const SKIN_ACCENT_KEY = 'mixdog.desktop.skin-accent.v1';
const CUSTOM_META_KEY = 'mixdog.desktop.skin-custom-meta.v1';
const CHANGE_EVENT = 'mixdog:skin-changed';
const CUSTOM_MAX_EDGE = 2560;
const FALLBACK_ACCENT = '#1967d2';

/** "Add my picture" takes stills, animated GIFs and short videos, each at most
    CUSTOM_MEDIA_MAX_BYTES; a video at most CUSTOM_VIDEO_MAX_SECONDS. */
export const CUSTOM_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const CUSTOM_VIDEO_MAX_SECONDS = 20;
export const CUSTOM_MEDIA_ACCEPT = 'image/*,video/mp4,video/webm';
export type CustomMediaKind = 'image' | 'gif' | 'video';
export type CustomMediaProblem = 'type' | 'size' | 'duration';

/** A picked file the custom skin refuses; `problem` names why. */
export class CustomSkinMediaError extends Error {
  constructor(readonly problem: CustomMediaProblem) {
    super(`Custom skin media refused: ${problem}`);
  }
}

/** A built-in's colours and focal point come from the manifest; a custom
    image's are stored with it (the legacy skin record carried accent/cast). */
type StoredSkin = { id: SkinId; accent: string; cast?: SkinCast };
/** `motion`: the custom skin moves (its media is in skin-media-store.ts and
    the stored picture is its poster); `rev` tells one saved media from the next. */
type CustomMeta = {
  accent: string;
  cast: SkinCast;
  focal: string;
  picture?: string;
  motion?: 'video' | 'gif';
  rev?: number;
};

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(): StoredSkin {
  try {
    const parsed = JSON.parse(storage()?.getItem(SKIN_KEY) || 'null') as Partial<StoredSkin> | null;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.accent === 'string') {
      return { id: parsed.id, accent: parsed.accent, cast: parsed.cast };
    }
  } catch {
    // A malformed entry falls back to no skin.
  }
  return { id: 'none', accent: FALLBACK_ACCENT };
}

function customImage(): string | null {
  return storage()?.getItem(CUSTOM_IMAGE_KEY) || null;
}

function skinImage(id: SkinId): string | null {
  if (id === 'custom') return customImage();
  return BUILTIN_SKINS.find((skin) => skin.id === id)?.image ?? null;
}

/** Transparency of one plate family, 0-100 (higher shows more of the
    picture): its own key, else the old single value (which both sliders
    inherit; or the older soft / normal / strong), else the default. The old
    keys stay for older builds. */
function readTransparency(key: string, fallback: number): number {
  const store = storage();
  for (const stored of [store?.getItem(key), store?.getItem(SKIN_TRANSPARENCY_KEY)]) {
    if (stored && Number.isFinite(Number(stored))) return clampTransparency(Number(stored));
  }
  return LEGACY_DIM_TRANSPARENCY[store?.getItem(LEGACY_SKIN_DIM_KEY) ?? ''] ?? fallback;
}

/** Outer panels: window frame, titlebar band, rail, left side panel, side dock. */
export function getSkinOuterTransparency(): number {
  return readTransparency(SKIN_OUTER_TRANSPARENCY_KEY, DEFAULT_TRANSPARENCY);
}

/** Main panel: the conversation veil and the cards on it (composer, status island). */
export function getSkinMainTransparency(): number {
  return readTransparency(SKIN_MAIN_TRANSPARENCY_KEY, DEFAULT_MAIN_TRANSPARENCY);
}

function storeTransparency(entries: Array<[string, number]>): void {
  for (const [key, value] of entries) storage()?.setItem(key, String(clampTransparency(value)));
  applyCurrent();
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

export function setSkinOuterTransparency(transparency: number): void {
  storeTransparency([[SKIN_OUTER_TRANSPARENCY_KEY, transparency]]);
}

export function setSkinMainTransparency(transparency: number): void {
  storeTransparency([[SKIN_MAIN_TRANSPARENCY_KEY, transparency]]);
}

/** Both sliders at once. */
export function setSkinTransparency(transparency: number): void {
  storeTransparency([
    [SKIN_OUTER_TRANSPARENCY_KEY, transparency],
    [SKIN_MAIN_TRANSPARENCY_KEY, transparency],
  ]);
}

/** Every skin starts with light glass, including a custom image. */
export function defaultSkinPlate(id: SkinId): SkinPlate {
  return SKIN_MANIFEST.find((entry) => entry.id === id)?.plate ?? 'light';
}

/** The plate in effect: this device's override, else the skin's manifest default. */
export function getSkinPlate(): SkinPlate {
  const stored = storage()?.getItem(SKIN_PLATE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'tint') return stored;
  return defaultSkinPlate(getSkinId());
}

/** This device's accent override (a #rrggbb colour), or null for "from the picture". */
export function getSkinAccent(): string | null {
  const stored = storage()?.getItem(SKIN_ACCENT_KEY);
  return stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored.toLowerCase() : null;
}

/** The override still goes through the contrast guard (fitAccent) when painted. */
export function setSkinAccent(accent: string | null): void {
  if (accent) storage()?.setItem(SKIN_ACCENT_KEY, accent.toLowerCase());
  else storage()?.removeItem(SKIN_ACCENT_KEY);
  applyCurrent();
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

export function setSkinPlate(plate: SkinPlate): void {
  storage()?.setItem(SKIN_PLATE_KEY, plate);
  applyCurrent();
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

export function getSkinPhoto(): boolean {
  return storage()?.getItem(SKIN_PHOTO_KEY) !== 'off';
}

/** Off keeps the palette (plates, accent) and hides only the picture. */
export function setSkinPhoto(on: boolean): void {
  storage()?.setItem(SKIN_PHOTO_KEY, on ? 'on' : 'off');
  applyCurrent();
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

/** Back to defaults: no skin, normal strength, light glass and picture's own
    accent, picture on. */
export function resetSkin(): void {
  for (const key of [
    SKIN_TRANSPARENCY_KEY,
    SKIN_OUTER_TRANSPARENCY_KEY,
    SKIN_MAIN_TRANSPARENCY_KEY,
    LEGACY_SKIN_DIM_KEY,
    SKIN_PLATE_KEY,
    SKIN_PHOTO_KEY,
    SKIN_ACCENT_KEY,
  ]) {
    storage()?.removeItem(key);
  }
  save({ id: 'none', accent: FALLBACK_ACCENT });
}

/** A skin is painted on the app. */
export function skinActive(): boolean {
  return getSkinId() !== 'none';
}

export function getSkinId(): SkinId {
  const { id } = readStored();
  return skinImage(id) ? id : 'none';
}

export function hasCustomSkin(): boolean {
  return Boolean(customImage());
}

export function subscribeSkin(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

const SKIN_PROPS = [
  '--mx-skin-image',
  '--mx-skin-pos',
  '--mx-skin-accent',
  '--mx-skin-on-accent',
  '--mx-skin-tint',
  '--mx-skin-ink',
  '--mx-skin-ink-muted',
  '--mx-skin-frame-amount',
  '--mx-skin-veil-amount',
  '--mx-skin-panel-amount',
  '--mx-skin-card-amount',
  '--mx-skin-rule-amount',
  '--mx-skin-edge-amount',
  '--mx-skin-edge-strong-amount',
  '--mx-skin-fill-amount',
  '--mx-skin-fill-strong-amount',
  '--mx-skin-chrome-ink',
  '--mx-skin-chrome-muted',
];

function customMeta(): CustomMeta | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(CUSTOM_META_KEY) || 'null') as Partial<CustomMeta> | null;
    if (parsed && typeof parsed.accent === 'string' && parsed.cast && typeof parsed.focal === 'string') {
      return {
        accent: parsed.accent,
        cast: parsed.cast,
        focal: parsed.focal,
        picture: parsed.picture,
        motion: parsed.motion === 'video' || parsed.motion === 'gif' ? parsed.motion : undefined,
        rev: parsed.rev,
      };
    }
  } catch {
    // A malformed entry falls back to the legacy record below.
  }
  return null;
}

/** The custom picture as a data URL (null when none was added). */
export function getCustomSkinImage(): string | null {
  return customImage();
}

/** Where the custom picture's subject sits ('x% y%'); the picture's centre by default. */
export function getCustomSkinFocal(): string {
  return customMeta()?.focal ?? 'center';
}

/** Colours of a skin: a built-in's from the manifest, a custom image's from
    its saved extraction (old saves derive the cast from the accent). */
function skinColors(id: SkinId): { accent: string; cast: SkinCast; focal: string; picture?: string } {
  const builtin = SKIN_MANIFEST.find((entry) => entry.id === id);
  if (builtin) {
    return { accent: builtin.accent, cast: builtin.cast, focal: builtin.focal, picture: builtin.picture };
  }
  const meta = customMeta();
  if (meta) return meta;
  const stored = readStored();
  return { accent: stored.accent, cast: stored.cast ?? castOfColor(stored.accent), focal: 'center' };
}

export type SkinSettings = {
  outerTransparency: number;
  mainTransparency: number;
  plate: SkinPlate;
  accent: string | null;
};

/** The CSS variables a skin paints (the real app on <html>, the Settings
    preview on its own element): plate tone x theme x strength x accent
    override through the contrast guard. `none` paints the neutral theme.
    A user JSON theme's accent is the default accent (over the picture's);
    this device's accent override still wins, and the guard runs last. */
export function skinVars(id: SkinId, settings: SkinSettings, theme: SkinTheme): Record<string, string> | null {
  const image = skinImage(id);
  const themeAccent = userThemeAccent(theme);
  const colors: { accent: string; cast: SkinCast; focal: string; picture?: string } = image
    ? skinColors(id)
    : { accent: FALLBACK_ACCENT, cast: { hue: 0, sat: 0 }, focal: 'center' };
  const palette = resolvePalette({
    // None applies no skin colours at all, so an accent override has no part in it.
    accent: image ? (settings.accent ?? themeAccent ?? colors.accent) : (themeAccent ?? FALLBACK_ACCENT),
    cast: colors.cast,
    plate: image ? settings.plate : theme,
    theme,
    outerTransparency: settings.outerTransparency,
    mainTransparency: settings.mainTransparency,
    picture: colors.picture ?? FALLBACK_PICTURE,
  });
  const percent = (amount: number) => `${Math.round(amount * 1000) / 10}%`;
  return {
    '--mx-skin-image': image ? `url("${image}")` : 'none',
    '--mx-skin-pos': colors.focal,
    '--mx-skin-accent': palette.accent,
    '--mx-skin-on-accent': palette.onAccent,
    '--mx-skin-tint': palette.tint,
    '--mx-skin-ink': palette.ink,
    '--mx-skin-ink-muted': palette.muted,
    '--mx-skin-frame-amount': percent(palette.amounts.frame),
    '--mx-skin-veil-amount': percent(palette.amounts.veil),
    '--mx-skin-panel-amount': percent(palette.amounts.panel),
    '--mx-skin-card-amount': percent(palette.cardAmount),
    '--mx-skin-rule-amount': percent(palette.marks.rule),
    '--mx-skin-edge-amount': percent(palette.marks.edge),
    '--mx-skin-edge-strong-amount': percent(palette.marks.edgeStrong),
    '--mx-skin-fill-amount': percent(palette.marks.fill),
    '--mx-skin-fill-strong-amount': percent(palette.marks.fillStrong),
    '--mx-skin-chrome-ink': palette.chromeInk,
    '--mx-skin-chrome-muted': palette.chromeMuted,
  };
}

export function currentSkinSettings(): SkinSettings {
  return {
    outerTransparency: getSkinOuterTransparency(),
    mainTransparency: getSkinMainTransparency(),
    plate: getSkinPlate(),
    accent: getSkinAccent(),
  };
}

export function currentSkinTheme(): SkinTheme {
  return document.documentElement.dataset.mixdogTheme === 'light' ? 'light' : 'dark';
}

let themeObserver: MutationObserver | null = null;

/** The moving layer of a skin, or null for a still one (or with the photo
    off). A built-in's loop plays in the desktop app only: a phone or browser
    on the relay would pull every loop over it, so it keeps the picture. The
    custom media is this device's own file, so it plays everywhere. */
function skinMotion(id: SkinId): SkinMotion | null {
  if (!getSkinPhoto()) return null;
  const builtin = BUILTIN_SKINS.find((skin) => skin.id === id);
  if (builtin) {
    return isRemoteBrowserRenderer()
      ? null
      : { key: id, kind: 'video', poster: builtin.image, source: () => builtin.video };
  }
  const meta = id === 'custom' ? customMeta() : null;
  const poster = customImage();
  if (!meta?.motion || !poster) return null;
  return {
    key: `custom:${meta.rev ?? 0}`,
    kind: meta.motion === 'gif' ? 'image' : 'video',
    poster,
    source: readCustomSkinMedia,
  };
}

/** Paint the stored skin on <html> (the contrast guard depends on the plate,
    strength, accent and the current theme), then record it for the next
    first paint (skin-boot-snapshot.ts). */
function applyCurrent(): void {
  paintCurrent();
  syncSkinBootSnapshot();
}

function paintCurrent(): void {
  const root = document.documentElement;
  const id = getSkinId();
  syncSkinMotion(skinMotion(id), paintCurrent);
  if (!skinImage(id)) {
    delete root.dataset.mixdogSkin;
    delete root.dataset.mixdogSkinPlate;
    delete root.dataset.mixdogSkinPhoto;
    for (const name of SKIN_PROPS) root.style.removeProperty(name);
    return;
  }
  const settings = currentSkinSettings();
  root.dataset.mixdogSkin = id;
  root.dataset.mixdogSkinPlate = settings.plate;
  if (getSkinPhoto()) delete root.dataset.mixdogSkinPhoto;
  else root.dataset.mixdogSkinPhoto = 'off';
  for (const [name, value] of Object.entries(skinVars(id, settings, currentSkinTheme()) ?? {})) {
    root.style.setProperty(name, value);
  }
}

let userThemeWindow: Window | null = null;

/** Boot: paint the stored skin synchronously; repaint when the theme flips
    or a user theme (its accent) changes. */
export function applyStoredSkin(): void {
  applyCurrent();
  if (userThemeWindow !== window) {
    userThemeWindow = window;
    subscribeUserTheme(applyCurrent);
  }
  if (themeObserver || typeof MutationObserver === 'undefined') return;
  themeObserver = new MutationObserver(applyCurrent);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mixdog-theme'] });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

/** Custom image only (built-ins are in skin-manifest.ts): the image's
    dominant vivid hue, normalized to a button-ready tone, plus its overall
    cast: the saturation-weighted circular mean hue of every pixel. */
function extractColors(image: HTMLImageElement): {
  accent: string;
  cast: SkinCast;
  swatches: string[];
  picture: string;
} {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return {
      accent: FALLBACK_ACCENT,
      cast: castOfColor(FALLBACK_ACCENT),
      swatches: [FALLBACK_ACCENT],
      picture: FALLBACK_PICTURE,
    };
  }
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, h: 0, s: 0 }));
  let x = 0;
  let y = 0;
  let castWeight = 0;
  let castSat = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) {
    sum[0] += pixels[i];
    sum[1] += pixels[i + 1];
    sum[2] += pixels[i + 2];
    const [h, s, l] = rgbToHsl(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
    const castW = s * (1 - Math.abs(l - 0.5));
    x += Math.cos((h * Math.PI) / 180) * castW;
    y += Math.sin((h * Math.PI) / 180) * castW;
    castWeight += castW;
    castSat += s * castW;
    if (s < 0.25 || l < 0.15 || l > 0.9) continue;
    const weight = s * (1 - Math.abs(l - 0.55));
    const bin = bins[Math.floor(h / 15) % 24];
    bin.weight += weight;
    bin.h += h * weight;
    bin.s += s * weight;
  }
  const best = bins.reduce((top, bin) => (bin.weight > top.weight ? bin : top));
  const accent =
    best.weight === 0
      ? FALLBACK_ACCENT
      : hslToHex(best.h / best.weight, Math.max(0.55, Math.min(0.85, best.s / best.weight)), 0.55);
  // Up to four distinct hues, strongest first; the first is the accent.
  const swatches = bins
    .filter((bin) => bin.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((bin) => hslToHex(bin.h / bin.weight, Math.max(0.55, Math.min(0.85, bin.s / bin.weight)), 0.55));
  const count = pixels.length / 4;
  const picture = `#${sum
    .map((v) =>
      Math.round(v / count)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
  if (castWeight === 0) {
    return { accent, cast: castOfColor(accent), swatches: swatches.length ? swatches : [accent], picture };
  }
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return {
    accent,
    picture,
    cast: { hue: Math.round(hue), sat: Math.round((castSat / castWeight) * 100) },
    swatches: swatches.length ? swatches : [accent],
  };
}

/** A custom picture saved before the custom-meta record kept its colours in
    the skin record, which this save is about to overwrite: move them over. */
function migrateLegacyCustomMeta(): void {
  const stored = readStored();
  if (stored.id !== 'custom' || !customImage() || customMeta()) return;
  const meta: CustomMeta = { accent: stored.accent, cast: stored.cast ?? castOfColor(stored.accent), focal: 'center' };
  storage()?.setItem(CUSTOM_META_KEY, JSON.stringify(meta));
}

function save(next: StoredSkin): void {
  migrateLegacyCustomMeta();
  storage()?.setItem(SKIN_KEY, JSON.stringify(next));
  applyCurrent();
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

/** Choose a skin. It brings its own plate (a plate chosen for the previous
    picture would not suit it); strength, accent override and toggles stay. */
export function setSkin(id: SkinId): void {
  storage()?.removeItem(SKIN_PLATE_KEY);
  save({ id: skinImage(id) ? id : 'none', accent: FALLBACK_ACCENT });
}

export type PreparedSkinImage = {
  /** Downscaled JPEG data URL. */
  dataUrl: string;
  accent: string;
  cast: SkinCast;
  /** Average colour of the picture (the plates' contrast guards judge against it). */
  picture: string;
  /** Dominant hues of the picture, strongest first (the first is `accent`). */
  swatches: string[];
  /** A moving pick (video, animated GIF): the file itself; `dataUrl` is its first frame. */
  media?: { blob: Blob; kind: 'video' | 'gif' };
};

/** Types by extension, for a picker that reports none. */
const MEDIA_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  mp4: 'video/mp4',
  png: 'image/png',
  webm: 'video/webm',
  webp: 'image/webp',
};

type PickedFile = { type: string; name: string; size: number };

/** What the custom skin makes of a file; null for one it does not take. */
export function customMediaKind(file: Pick<PickedFile, 'type' | 'name'>): CustomMediaKind | null {
  const type = file.type || MEDIA_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] || '';
  if (type === 'image/gif') return 'gif';
  if (type === 'video/mp4' || type === 'video/webm') return 'video';
  return type.startsWith('image/') ? 'image' : null;
}

/** Why the custom skin refuses a file (its duration once a video's is known), or null. */
export function customMediaProblem(file: PickedFile, seconds?: number): CustomMediaProblem | null {
  if (!customMediaKind(file)) return 'type';
  if (file.size > CUSTOM_MEDIA_MAX_BYTES) return 'size';
  // A duration the file does not state (NaN, Infinity) cannot be held to the limit.
  if (seconds !== undefined && !(seconds <= CUSTOM_VIDEO_MAX_SECONDS)) return 'duration';
  return null;
}

/** A video's first frame, once its metadata (the duration) is known. */
async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(video.error ?? new Error('The video could not be read.')), {
      once: true,
    });
    video.src = src;
  });
  return video;
}

/** Check a picked file, downscale it (a moving one: its first frame, the
    poster) and extract its colours; nothing is stored yet. Throws
    CustomSkinMediaError for a file the limits refuse. */
export async function prepareCustomSkin(file: File): Promise<PreparedSkinImage> {
  const kind = customMediaKind(file);
  const refused = customMediaProblem(file);
  if (refused || !kind) throw new CustomSkinMediaError(refused ?? 'type');
  const url = URL.createObjectURL(file);
  try {
    let frame: { source: CanvasImageSource; width: number; height: number };
    if (kind === 'video') {
      const video = await loadVideo(url);
      const tooLong = customMediaProblem(file, video.duration);
      if (tooLong) throw new CustomSkinMediaError(tooLong);
      frame = { source: video, width: video.videoWidth, height: video.videoHeight };
    } else {
      const image = await loadImage(url);
      frame = { source: image, width: image.naturalWidth, height: image.naturalHeight };
    }
    const scale = Math.min(1, CUSTOM_MAX_EDGE / Math.max(frame.width, frame.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(frame.width * scale);
    canvas.height = Math.round(frame.height * scale);
    canvas.getContext('2d')?.drawImage(frame.source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    const colors = extractColors(await loadImage(dataUrl));
    return kind === 'image' ? { dataUrl, ...colors } : { dataUrl, ...colors, media: { blob: file, kind } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Keep the prepared picture on this device with the chosen subject point
    (fractions 0–1 of the picture) and accent, and switch to it. A moving
    pick's file is stored first (skin-media-store.ts); a still replacing one
    drops it. */
export async function commitCustomSkin(
  prepared: Pick<PreparedSkinImage, 'dataUrl' | 'accent' | 'cast' | 'media'> & { picture?: string },
  point: { x: number; y: number }
): Promise<void> {
  if (prepared.media) await putCustomSkinMedia(prepared.media.blob);
  else if (customMeta()?.motion) await deleteCustomSkinMedia();
  storage()?.setItem(CUSTOM_IMAGE_KEY, prepared.dataUrl);
  const meta: CustomMeta = {
    accent: prepared.accent,
    cast: prepared.cast,
    focal: focalOfPoint(point.x, point.y),
    picture: prepared.picture,
  };
  if (prepared.media) {
    meta.motion = prepared.media.kind;
    meta.rev = Date.now();
  }
  storage()?.setItem(CUSTOM_META_KEY, JSON.stringify(meta));
  setSkin('custom');
}
