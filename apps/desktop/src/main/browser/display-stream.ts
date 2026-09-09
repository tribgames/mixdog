/** Consume compositor frames lazily: retain only the latest native image and
 * encode it only when the visible pane asks. No capture loop or focus changes. */
import type { NativeImage, WebContents } from 'electron';
import type { BrowserScreenshotCapture } from './screenshot';

export function createBrowserDisplayStream(
  encode: (image: NativeImage) => BrowserScreenshotCapture,
) {
  type Stream = {
    key: string;
    viewport?: { width: number; height: number };
    latest?: NativeImage;
    encoded?: BrowserScreenshotCapture;
    waiting?: { resolve(image: NativeImage): void; reject(error: Error): void };
    idle?: ReturnType<typeof setTimeout>;
    close(): void;
  };
  const streams = new WeakMap<WebContents, Stream>();
  return async function sample(
    guest: WebContents, key: string, viewport?: { width: number; height: number },
  ): Promise<BrowserScreenshotCapture> {
    let stream = streams.get(guest);
    if (!stream) {
      const entry: Stream = {
        key, viewport,
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
        if (entry.viewport && (size.width !== entry.viewport.width || size.height !== entry.viewport.height)) return;
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
      stream.viewport = viewport;
      stream.latest = undefined;
      stream.encoded = undefined;
    }
    if (stream.encoded) return stream.encoded;
    let image = stream.latest;
    if (!image) {
      const next = new Promise<NativeImage>((resolve, reject) => {
        stream!.waiting = { resolve, reject };
      });
      guest.invalidate();
      image = await next;
    }
    if (stream.key !== key) throw new Error('Browser page changed during capture.');
    const size = image.getSize();
    if (viewport && (size.width !== viewport.width || size.height !== viewport.height)) {
      throw new Error('Browser page changed during capture.');
    }
    const result = encode(image);
    // A newer paint may have arrived while the first one was being awaited.
    if (stream.latest === image) stream.encoded = result;
    return result;
  };
}
