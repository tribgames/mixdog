/** Consume compositor frames lazily: retain only the latest native image and
 * encode it only when the visible pane asks. No capture loop or focus changes. */
import type { NativeImage, WebContents } from 'electron';
import type { BrowserScreenshotCapture } from './screenshot';

export function createBrowserDisplayStream(
  encode: (image: NativeImage) => BrowserScreenshotCapture | Promise<BrowserScreenshotCapture>
) {
  type Stream = {
    key: string;
    pixels?: { width: number; height: number };
    latest?: NativeImage;
    encoded?: BrowserScreenshotCapture;
    waiting?: { resolve(image: NativeImage): void; reject(error: Error): void; promise: Promise<NativeImage> };
    idle?: ReturnType<typeof setTimeout>;
    close(): void;
  };
  const streams = new WeakMap<WebContents, Stream>();
  return async function sample(
    guest: WebContents,
    key: string,
    pixels?: { width: number; height: number }
  ): Promise<BrowserScreenshotCapture> {
    let stream = streams.get(guest);
    if (!stream) {
      const entry: Stream = {
        key,
        pixels,
        close() {
          clearTimeout(entry.idle);
          guest.removeListener('paint', paint);
          guest.removeListener('did-start-navigation', navigation);
          guest.removeListener('destroyed', destroyed);
          streams.delete(guest);
          entry.latest = undefined;
          entry.encoded = undefined;
          entry.waiting?.reject(new Error('Browser display frame is not ready.'));
          entry.waiting = undefined;
        },
      };
      const paint = (_event: unknown, _dirty: unknown, image: NativeImage) => {
        const size = image.getSize();
        if (entry.pixels && (size.width !== entry.pixels.width || size.height !== entry.pixels.height)) {
          // The compositor now paints another geometry (pane resize). A caller
          // waiting for the old size would otherwise wait until its deadline;
          // release it so the pane re-samples with the current geometry.
          entry.waiting?.reject(new Error('Browser page changed during capture.'));
          entry.waiting = undefined;
          return;
        }
        entry.latest = image;
        entry.encoded = undefined;
        entry.waiting?.resolve(image);
        entry.waiting = undefined;
      };
      const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
        if (!main) return;
        entry.key = '';
        entry.latest = undefined;
        entry.encoded = undefined;
        entry.waiting?.reject(new Error('Browser page changed during capture.'));
        entry.waiting = undefined;
      };
      const destroyed = () => entry.close();
      guest.on('paint', paint);
      guest.on('did-start-navigation', navigation);
      guest.once('destroyed', destroyed);
      streams.set(guest, entry);
      stream = entry;
    }
    clearTimeout(stream.idle);
    // No pane reads means no retained pixels or display listeners. Do not
    // stop Chromium painting: independent agent observations still need it.
    stream.idle = setTimeout(() => stream!.close(), 2500);
    stream.idle.unref();
    if (stream.key !== key) {
      stream.key = key;
      stream.pixels = pixels;
      stream.latest = undefined;
      stream.encoded = undefined;
    }
    if (stream.encoded) return stream.encoded;
    let image = stream.latest;
    if (!image) {
      // Concurrent callers for one guest share the pending frame instead of
      // overwriting (and orphaning) each other's waiter.
      let next = stream.waiting?.promise;
      if (!next) {
        const entry = stream;
        next = new Promise<NativeImage>((resolve, reject) => {
          entry.waiting = { resolve, reject, promise: undefined as unknown as Promise<NativeImage> };
        });
        stream.waiting!.promise = next;
        guest.invalidate();
      }
      image = await next;
    }
    if (stream.key !== key) throw new Error('Browser page changed during capture.');
    const size = image.getSize();
    if (pixels && (size.width !== pixels.width || size.height !== pixels.height)) {
      throw new Error('Browser page changed during capture.');
    }
    const result = await encode(image);
    if (streams.get(guest) !== stream || stream.key !== key) {
      throw new Error('Browser page changed during capture.');
    }
    // A newer paint may have arrived while the first one was being awaited.
    if (stream.latest === image) stream.encoded = result;
    return result;
  };
}
