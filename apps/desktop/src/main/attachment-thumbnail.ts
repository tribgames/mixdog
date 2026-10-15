// Thumbnails of stored prompt attachment images, for the renderer and paired
// phones. The blob comes from the service as base64. Where an image decoder is
// available (the Electron main process) the picture is downscaled here; the
// plain-Node service serving phones has none and hands over the original
// (bounded), which the phone's renderer downscales before caching.
export const ATTACHMENT_REF_PATTERN = /^[a-f0-9]{64}$/;
export const THUMBNAIL_MAX_SIDE = 320;
export const THUMBNAIL_FALLBACK_MAX_BYTES = 512 * 1024;
export const REMOTE_ORIGINAL_MAX_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY = 82;

/** The slice of Electron's NativeImage the thumbnail logic uses. */
export interface DecodedImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): DecodedImage;
  toJPEG(quality: number): Buffer;
}
export type ImageDecoder = (buffer: Buffer) => DecodedImage | null | Promise<DecodedImage | null>;

function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    (bytes.toString('latin1', 0, 6) === 'GIF87a' || bytes.toString('latin1', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function isAttachmentRef(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_REF_PATTERN.test(value);
}

export async function readAttachmentThumbnail(
  attachmentRef: unknown,
  readAttachmentImage: (attachmentRef: string) => Promise<string | null>,
  decode: ImageDecoder | null,
  fallbackMaxBytes = THUMBNAIL_FALLBACK_MAX_BYTES
): Promise<string | null> {
  if (!isAttachmentRef(attachmentRef)) return null;
  const base64 = await readAttachmentImage(attachmentRef);
  if (!base64) return null;
  const bytes = Buffer.from(base64, 'base64');
  let image: DecodedImage | null = null;
  try {
    image = decode ? await decode(bytes) : null;
  } catch {
    image = null;
  }
  if (image && !image.isEmpty()) {
    const { width, height } = image.getSize();
    const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(width, height));
    const scaled =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'best',
          })
        : image;
    return `data:image/jpeg;base64,${scaled.toJPEG(JPEG_QUALITY).toString('base64')}`;
  }
  const mime = sniffImageMime(bytes);
  if (!mime || bytes.length > fallbackMaxBytes) return null;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
