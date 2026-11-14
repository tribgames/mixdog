/** Fitting a capture to the budget the core asked for and encoding it. Pure: the image is any object shaped like Electron's
 *  NativeImage, so nothing here loads Electron. */
import { computerCaptureSize } from "../../../shared/core-src/runtime/computer-bridge/capture-size.mjs";

export interface Size {
  width: number;
  height: number;
}

export interface PixelImage {
  getSize(): Size;
  isEmpty(): boolean;
  resize(options: {
    width: number;
    height: number;
    quality?: "good" | "better" | "best";
  }): PixelImage;
  crop(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): PixelImage;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
}

export type PixelFormat = "jpeg" | "png";

/** The size a `width` x `height` capture is delivered at: the encoder budget of `computerCaptureSize` for `maxWidth`, then
 *  scaled down further, keeping the shape, when `maxHeight` is smaller than the result. */
export function fitSize(
  size: Size,
  maxWidth: number,
  maxHeight?: number,
): Size {
  const fitted = computerCaptureSize(size.width, size.height, maxWidth) as Size;
  if (maxHeight === undefined || fitted.height <= maxHeight) return fitted;
  const scale = maxHeight / fitted.height;
  return {
    width: Math.max(1, Math.floor(fitted.width * scale)),
    height: Math.max(1, maxHeight),
  };
}

export function fitImage(
  image: PixelImage,
  maxWidth: number,
  maxHeight?: number,
): PixelImage {
  const size = image.getSize();
  const fitted = fitSize(size, maxWidth, maxHeight);
  return size.width === fitted.width && size.height === fitted.height
    ? image
    : image.resize({ ...fitted, quality: "best" });
}

export interface EncodedImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

/** The image as the format's bytes; `quality` (1..100) applies to JPEG only. */
export function encodeImage(
  image: PixelImage,
  format: PixelFormat,
  quality: number,
): EncodedImage {
  const bytes = format === "png" ? image.toPNG() : image.toJPEG(quality);
  if (bytes.byteLength === 0)
    throw new Error("empty_frame: the capture encoded to no bytes");
  return { bytes, mimeType: format === "png" ? "image/png" : "image/jpeg" };
}
