/** The pixels behind page identity: the site icon a page declared, read
 *  through the browser's own session (its HTTP cache first), and a small
 *  screenshot of the page itself. */
import { nativeImage, type WebContents } from 'electron';
import { fetchDeclaredFavicon, looksLikeSvg } from './favicon-fetch';

/** 2x of the 104×66 card thumbnail. */
export const PAGE_THUMBNAIL_SIZE = { width: 208, height: 132 } as const;
const FAVICON_PIXELS = 32;
const DATA_FAVICON_MAX_CHARS = 16 * 1024;
const CAPTURE_TIMEOUT_MS = 4000;

/** A decoded icon re-encoded for storage: SVG kept only when it is real SVG
 *  markup, anything else only when it decodes to pixels (as a 32px PNG). */
function storableFavicon(bytes: Buffer, type: string): string | null {
  if (!bytes.length) return null;
  if (type === 'image/svg+xml') {
    if (!looksLikeSvg(bytes.toString('utf8'))) return null;
    const data = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
    return data.length <= DATA_FAVICON_MAX_CHARS ? data : null;
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  return image.resize({ width: FAVICON_PIXELS, height: FAVICON_PIXELS, quality: 'best' }).toDataURL();
}

/** The icon the page at `pageUrl` declared, as a data URL, or null. A remote
 *  icon is read through the page's own session, as the page would load it
 *  (see favicon-fetch). */
export async function readBrowserFavicon(
  session: Electron.Session,
  url: string,
  pageUrl: string
): Promise<string | null> {
  const data = /^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*?)(;base64)?,(.*)$/is.exec(url);
  if (data) {
    if (url.length > DATA_FAVICON_MAX_CHARS) return null;
    let bytes: Buffer;
    try {
      bytes = data[3] ? Buffer.from(data[4], 'base64') : Buffer.from(decodeURIComponent(data[4]), 'utf8');
    } catch {
      return null;
    }
    return storableFavicon(bytes, data[1].toLowerCase());
  }
  const icon = await fetchDeclaredFavicon((target, init) => session.fetch(target, init), url, pageUrl);
  return icon ? storableFavicon(icon.bytes, icon.type) : null;
}

/** The top of the page at the card's aspect, as a JPEG data URL, or null
 *  when the page has not painted. */
export async function captureBrowserPageThumbnail(guest: WebContents): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const image = await Promise.race([
    guest.capturePage(undefined, { stayHidden: true }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!image || image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const aspect = PAGE_THUMBNAIL_SIZE.width / PAGE_THUMBNAIL_SIZE.height;
  const cropHeight = Math.min(height, Math.round(width / aspect));
  const cropWidth = Math.min(width, Math.round(cropHeight * aspect));
  if (cropWidth < 1 || cropHeight < 1) return null;
  const thumbnail = image
    .crop({ x: 0, y: 0, width: cropWidth, height: cropHeight })
    .resize({ ...PAGE_THUMBNAIL_SIZE, quality: 'good' });
  return `data:image/jpeg;base64,${thumbnail.toJPEG(72).toString('base64')}`;
}
