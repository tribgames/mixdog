// Skins (Settings → Display): a background picture under the shell plus an
// accent color taken from it. Device-local like the theme; the CSS lives in
// desktop/33-skin.css and reuses the Mica translucency plumbing.
import nightCity from './skins/night-city.jpg';
import springWindow from './skins/spring-window.jpg';
import sunsetMeadow from './skins/sunset-meadow.jpg';

export type SkinId = 'none' | 'custom' | (string & {});

export const BUILTIN_SKINS: ReadonlyArray<{ id: string; label: string; image: string }> = [
  { id: 'sunset-meadow', label: 'Sunset meadow', image: sunsetMeadow },
  { id: 'spring-window', label: 'Spring window', image: springWindow },
  { id: 'night-city', label: 'Night city', image: nightCity },
];

const SKIN_KEY = 'mixdog.desktop.skin.v1';
const CUSTOM_IMAGE_KEY = 'mixdog.desktop.skin-custom-image.v1';
const SKIN_DIM_KEY = 'mixdog.desktop.skin-dim.v1';
const CHANGE_EVENT = 'mixdog:skin-changed';
const CUSTOM_MAX_EDGE = 2560;
const FALLBACK_ACCENT = '#1967d2';

/** hue (deg) and saturation (0–100) of the picture's overall cast; the CSS
    derives the panel tint and the ink of both themes from it. */
type SkinCast = { hue: number; sat: number };
type StoredSkin = { id: SkinId; accent: string; cast?: SkinCast };

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

export type SkinDim = 'soft' | 'normal' | 'strong';

export function getSkinDim(): SkinDim {
  const stored = storage()?.getItem(SKIN_DIM_KEY);
  return stored === 'soft' || stored === 'strong' ? stored : 'normal';
}

/** How strongly the panels tint and blur the picture behind text. */
export function setSkinDim(dim: SkinDim): void {
  storage()?.setItem(SKIN_DIM_KEY, dim);
  document.documentElement.dataset.mixdogSkinDim = dim;
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
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

/** Readable ink on the accent fill (relative luminance threshold). */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1a1a1a' : '#ffffff';
}

const SKIN_PROPS = ['--mx-skin-image', '--mx-skin-accent', '--mx-skin-on-accent', '--mx-skin-hue', '--mx-skin-sat'];

/** Skins saved before the cast existed take it from their accent. */
function castOf(accent: string): SkinCast {
  const [h, s] = rgbToHsl(
    ...([1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255) as [number, number, number])
  );
  return { hue: Math.round(h), sat: Math.round(s * 100) };
}

function applySkin(id: SkinId, accent: string, cast: SkinCast = castOf(accent)): void {
  const root = document.documentElement;
  const image = skinImage(id);
  if (!image) {
    delete root.dataset.mixdogSkin;
    delete root.dataset.mixdogSkinDim;
    for (const name of SKIN_PROPS) root.style.removeProperty(name);
    return;
  }
  root.dataset.mixdogSkin = id;
  root.dataset.mixdogSkinDim = getSkinDim();
  root.style.setProperty('--mx-skin-image', `url("${image}")`);
  root.style.setProperty('--mx-skin-accent', accent);
  root.style.setProperty('--mx-skin-on-accent', inkOn(accent));
  root.style.setProperty('--mx-skin-hue', String(cast.hue));
  root.style.setProperty('--mx-skin-sat', String(cast.sat));
}

/** Boot: paint the stored skin synchronously (its colors were saved with it). */
export function applyStoredSkin(): void {
  const stored = readStored();
  applySkin(getSkinId(), stored.accent, stored.cast);
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[channel(0), channel(8), channel(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The image's dominant vivid hue, normalized to a button-ready tone, plus
    its overall cast: the saturation-weighted circular mean hue of every
    pixel (the panels take this tint, as the reference skins do). */
function extractColors(image: HTMLImageElement): { accent: string; cast: SkinCast } {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { accent: FALLBACK_ACCENT, cast: castOf(FALLBACK_ACCENT) };
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, h: 0, s: 0 }));
  let x = 0;
  let y = 0;
  let castWeight = 0;
  let castSat = 0;
  for (let i = 0; i < pixels.length; i += 4) {
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
  if (castWeight === 0) return { accent, cast: castOf(accent) };
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { accent, cast: { hue: Math.round(hue), sat: Math.round((castSat / castWeight) * 100) } };
}

function save(next: StoredSkin): void {
  storage()?.setItem(SKIN_KEY, JSON.stringify(next));
  applySkin(next.id, next.accent, next.cast);
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

export async function setSkin(id: SkinId): Promise<void> {
  const image = skinImage(id);
  if (!image) {
    save({ id: 'none', accent: FALLBACK_ACCENT });
    return;
  }
  save({ id, ...extractColors(await loadImage(image)) });
}

/** Downscale the picked picture, keep it on this device and switch to it. */
export async function setCustomSkin(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, CUSTOM_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    storage()?.setItem(CUSTOM_IMAGE_KEY, canvas.toDataURL('image/jpeg', 0.86));
    save({ id: 'custom', ...extractColors(image) });
  } finally {
    URL.revokeObjectURL(url);
  }
}
