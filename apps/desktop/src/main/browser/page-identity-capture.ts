/** The pixels behind page identity: the site icon a page declared, read
 *  through the browser's own session (its HTTP cache first), and a small
 *  screenshot of the page itself. */
import { nativeImage, type NativeImage, type WebContents } from 'electron';
import type { DesktopBrowserPageIdentity } from '../../shared/contract';
import { fetchDeclaredFavicon, looksLikeSvg } from './favicon-fetch';
import type { BrowserPageIdentityPatch } from './page-identity';
import { fetchPagePreviewMarkup, PREVIEW_IMAGE_MAX_BYTES } from './page-preview';

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
  return cardThumbnail(image, 'top');
}

/** `image` cut to the card's aspect (from its top, or around its center) and
 *  scaled to the card thumbnail, as a JPEG data URL. */
function cardThumbnail(image: NativeImage, anchor: 'top' | 'center'): string | null {
  const { width, height } = image.getSize();
  const aspect = PAGE_THUMBNAIL_SIZE.width / PAGE_THUMBNAIL_SIZE.height;
  const cropHeight = Math.min(height, Math.round(width / aspect));
  const cropWidth = Math.min(width, Math.round(cropHeight * aspect));
  if (cropWidth < 1 || cropHeight < 1) return null;
  const x = anchor === 'center' ? Math.floor((width - cropWidth) / 2) : 0;
  const y = anchor === 'center' ? Math.floor((height - cropHeight) / 2) : 0;
  const thumbnail = image
    .crop({ x, y, width: cropWidth, height: cropHeight })
    .resize({ ...PAGE_THUMBNAIL_SIZE, quality: 'good' });
  return `data:image/jpeg;base64,${thumbnail.toJPEG(72).toString('base64')}`;
}

/** What the page at `url` declares about itself, as identity facts the
 *  store does not have yet (`known`): its preview image as a thumbnail, its
 *  icon and its title. Read through the browser session; null when nothing
 *  usable came back. */
export async function readBrowserPagePreview(
  session: Electron.Session,
  url: string,
  known: DesktopBrowserPageIdentity | null
): Promise<BrowserPageIdentityPatch | null> {
  const fetch = (target: string, init: RequestInit) => session.fetch(target, init);
  const markup = await fetchPagePreviewMarkup(fetch, url);
  if (!markup) return null;
  const [thumbnail, favicon] = await Promise.all([
    markup.image
      ? fetchDeclaredFavicon(fetch, markup.image, markup.url, { maxBytes: PREVIEW_IMAGE_MAX_BYTES }).then((data) => {
          const image = data ? nativeImage.createFromBuffer(data.bytes) : null;
          return image && !image.isEmpty() ? cardThumbnail(image, 'center') : null;
        })
      : null,
    markup.icon && !known?.favicon ? readBrowserFavicon(session, markup.icon, markup.url) : null,
  ]);
  const title = known?.title ? undefined : markup.title;
  if (!thumbnail && !favicon && !title) return null;
  return { ...(thumbnail ? { thumbnail } : {}), ...(favicon ? { favicon } : {}), ...(title ? { title } : {}) };
}
