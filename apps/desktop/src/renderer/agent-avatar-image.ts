// Custom avatar images, prepared in the renderer before they leave it. A
// still picture (PNG, JPG or a still WebP) is decoded by an <img> and redrawn
// cover-cropped as a 256px square PNG, which also drops its metadata. An
// animation (GIF, APNG, animated WebP) keeps its bytes — it must be square and
// at most 512px — and brings its first frame as a PNG (createImageBitmap
// decodes an animation's first frame) for reduced motion and still views.
// SVG is never accepted: its markup could carry script.
import {
  AGENT_AVATAR_IMAGE_MAX_BYTES,
  AGENT_AVATAR_IMAGE_MAX_SIDE,
  avatarImageInfo,
} from '../../../../src/runtime/shared/agent-avatar.mjs';
import { t } from './i18n';

export const AGENT_AVATAR_IMAGE_TYPES = ['image/png', 'image/gif', 'image/webp', 'image/jpeg'] as const;
const SIZE = 256;

/** One state's new image: its data URL, and an animation's first frame. */
export interface AvatarStateUpload {
  data: string;
  poster?: string;
}

/** Why a picked file cannot be an avatar image, or '' when it can. */
export function agentAvatarFileProblem(file: Pick<File, 'type' | 'size'>): string {
  if (!(AGENT_AVATAR_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return t('Only PNG, GIF, WebP or JPG images can be used.');
  }
  if (file.size > AGENT_AVATAR_IMAGE_MAX_BYTES) return t('The image must be 1 MB or smaller.');
  return '';
}

/** `source` cover-cropped onto a `size` square, as a PNG data URL. */
function squarePng(source: CanvasImageSource, width: number, height: number, size: number): string {
  const side = Math.min(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t('Could not read the image.'));
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

/** A still picture as a cover-cropped square PNG data URL. */
export async function rasterizeAgentAvatar(file: File): Promise<string> {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    await image.decode();
    return squarePng(image, image.naturalWidth || SIZE, image.naturalHeight || SIZE, SIZE);
  } catch {
    throw new Error(t('Could not read the image.'));
  } finally {
    URL.revokeObjectURL(source);
  }
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** A picked file as one state's upload (see the header). */
export async function prepareAgentAvatarImage(file: File): Promise<AvatarStateUpload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = avatarImageInfo(bytes);
  if (!info?.animated) return { data: await rasterizeAgentAvatar(file) };
  if (info.width !== info.height) throw new Error(t('An animated image must be square.'));
  if (info.width > AGENT_AVATAR_IMAGE_MAX_SIDE) throw new Error(t('An animated image must be 512px or smaller.'));
  let poster: string;
  try {
    const frame = await createImageBitmap(file);
    poster = squarePng(frame, frame.width, frame.height, info.width);
    frame.close();
  } catch {
    throw new Error(t('Could not read the image.'));
  }
  return { data: `data:image/${info.format};base64,${base64(bytes)}`, poster };
}
