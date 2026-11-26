// Desktop byte lane: `mixdog-media://asset/<id>?variant=thumb`.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

import { type OnBeforeSendHeadersListenerDetails, protocol, type Session, session } from 'electron';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import { PAGE_THUMB_HOST, readBrowserPageThumbnail } from './browser/page-thumbnail-disk';
import type { DesktopService } from './desktop-service-contract';
import { FILE_PREVIEW_SCHEME, ensureFilePreviewFile, filePreviewServable, resolveFilePreview } from './file-preview';
import { forgetMediaFileTarget, resolveMediaFileTarget } from './media-source';

export const MEDIA_SCHEME = FILE_PREVIEW_SCHEME;

/** Must run before app ready: a non-privileged scheme cannot stream or be
 *  fetched, so ranges (video seeking) would never reach the handler. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function headerStrings(headers: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

const PAGE_THUMB_PROOF_HEADER = 'x-mixdog-page-thumb-proof';

function trustedRendererOrigin(): string | null {
  const raw = process.env.ELECTRON_RENDERER_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const localHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (!localHost || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isTrustedPageThumbOrigin(raw: string): boolean {
  if (!raw || raw === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true;
  const devOrigin = trustedRendererOrigin();
  return devOrigin !== null && parsed.origin === devOrigin;
}

function stripPageThumbProofHeader(headers: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== PAGE_THUMB_PROOF_HEADER) cleaned[key] = value;
  }
  return cleaned;
}

function isTrustedPageThumbRequester(
  details: OnBeforeSendHeadersListenerDetails,
  isShellWebContents: (webContentsId: number) => boolean
): boolean {
  if (details.resourceType !== 'image') return false;
  if (typeof details.webContentsId !== 'number' || !isShellWebContents(details.webContentsId)) return false;
  if (details.referrer && !isTrustedPageThumbOrigin(details.referrer)) return false;
  try {
    const frame = details.frame && !details.frame.isDestroyed() ? details.frame : null;
    if (!frame || frame.parent !== null) return false;
    return isTrustedPageThumbOrigin(frame.url);
  } catch {
    return false;
  }
}

function proofMatches(expected: Buffer, provided: string | null): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided, 'utf8');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function isTrustedPageThumbRequest(request: Request, expectedProof: Buffer): boolean {
  if (!proofMatches(expectedProof, request.headers.get(PAGE_THUMB_PROOF_HEADER))) return false;
  const origin = request.headers.get('origin');
  if (origin !== null && !isTrustedPageThumbOrigin(origin)) return false;
  const referer = request.headers.get('referer') || request.referrer || null;
  if (referer !== null && referer !== 'about:client' && !isTrustedPageThumbOrigin(referer)) return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode === 'navigate') return false;
  if (mode === 'cors' && origin === null) return false;
  const dest = request.headers.get('sec-fetch-dest');
  if (dest !== null && dest !== '' && dest !== 'image') return false;
  return true;
}

type FilePreview = NonNullable<ReturnType<typeof resolveFilePreview>>;

interface MediaRequestTarget {
  assetId: string;
  variant: string;
  target: { path: string; mime: string };
  preview: FilePreview | null;
}

async function resolveMediaRequest(
  host: Pick<DesktopService, 'invokeCapability'>,
  url: URL
): Promise<MediaRequestTarget | Response> {
  const previewToken = url.hostname === 'preview' ? url.pathname.replace(/^\/+/, '').split('/', 1)[0] || '' : '';
  const preview = previewToken && /^[0-9a-f-]{36}$/i.test(previewToken) ? resolveFilePreview(previewToken) : null;
  if (url.hostname === 'preview' && !preview) return textResponse(404, 'Not found.');
  if (preview) await ensureFilePreviewFile(preview);
  if (preview && !(await filePreviewServable(preview))) return textResponse(404, 'Not found.');
  const assetId = preview ? previewToken : url.pathname.replace(/^\/+/, '');
  const variant = url.searchParams.get('variant') || 'original';
  if (!preview && (url.hostname !== 'asset' || !/^[0-9a-fA-F-]{8,64}$/.test(assetId))) {
    return textResponse(404, 'Not found.');
  }
  let target: MediaRequestTarget['target'] | null;
  if (preview) {
    target = { path: preview.path, mime: preview.mime };
  } else {
    try {
      target = await resolveMediaFileTarget(host, assetId, variant, { generate: false });
    } catch {
      return textResponse(500, 'Media resolution failed.');
    }
  }
  return target ? { assetId, variant, target, preview } : textResponse(404, 'Not found.');
}

export interface MediaProtocolOptions {
  session?: Pick<Session, 'protocol' | 'webRequest'>;
  isShellWebContents?: (webContentsId: number) => boolean;
}

export function registerMediaProtocol(
  host: Pick<DesktopService, 'invokeCapability'>,
  options: MediaProtocolOptions = {}
): void {
  const targetSession = options.session ?? session.defaultSession;
  const isShellWebContents = options.isShellWebContents ?? (() => false);
  const pageThumbProof = randomBytes(16).toString('hex');
  const pageThumbProofBuf = Buffer.from(pageThumbProof, 'utf8');
  // Packaged `file://` shell image loads omit Origin and Referer on custom schemes,
  // so stamp an unforgeable main-process proof only for the registered shell's top-level image frames.
  targetSession.webRequest.onBeforeSendHeaders(
    { urls: [`${MEDIA_SCHEME}://${PAGE_THUMB_HOST}/*`] },
    (details, callback) => {
      const requestHeaders = stripPageThumbProofHeader(details.requestHeaders);
      if (isTrustedPageThumbRequester(details, isShellWebContents)) {
        requestHeaders[PAGE_THUMB_PROOF_HEADER] = pageThumbProof;
      }
      callback({ requestHeaders });
    }
  );
  const targetProtocol = targetSession.protocol ?? protocol;
  targetProtocol.handle(MEDIA_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, 'Bad request.');
    }
    if (url.hostname === PAGE_THUMB_HOST) {
      if (!isTrustedPageThumbRequest(request, pageThumbProofBuf)) return textResponse(403, 'Forbidden.');
      const token = url.searchParams.get('t') || '';
      if (!token) return textResponse(403, 'Forbidden.');
      const fileName = url.pathname.replace(/^\/+/, '').split('/', 1)[0] || '';
      const thumb = await readBrowserPageThumbnail(fileName, token);
      if (!thumb) return textResponse(404, 'Not found.');
      const version = url.searchParams.get('v') || '0';
      const plan = mediaResponsePlan({
        size: thumb.bytes.length,
        mime: thumb.mime,
        assetId: `page-thumb-${fileName}`,
        variant: version,
        rangeHeader: request.headers.get('range'),
        ifNoneMatch: request.headers.get('if-none-match'),
        ifRange: request.headers.get('if-range'),
      });
      const headers = {
        ...headerStrings(plan.headers),
        'X-Content-Type-Options': 'nosniff',
      };
      if (plan.status >= 300 || request.method === 'HEAD' || thumb.bytes.length === 0) {
        return new Response(null, { status: plan.status, headers });
      }
      const slice = thumb.bytes.subarray(plan.start, plan.end + 1);
      return new Response(new Uint8Array(slice), { status: plan.status, headers });
    }
    const resolved = await resolveMediaRequest(host, url);
    if (resolved instanceof Response) return resolved;
    const { assetId, variant, target, preview } = resolved;
    let size: number;
    try {
      size = statSync(target.path).size;
    } catch {
      if (!preview) forgetMediaFileTarget(assetId, variant);
      return textResponse(404, 'Not found.');
    }
    const plan = mediaResponsePlan({
      size,
      mime: target.mime,
      assetId: preview ? `${assetId}.${preview.generation}` : assetId,
      variant,
      rangeHeader: request.headers.get('range'),
      ifNoneMatch: request.headers.get('if-none-match'),
      ifRange: request.headers.get('if-range'),
      // A converted preview can be regenerated with other bytes: it is revalidated, never kept as immutable.
      ...(preview?.regenerate ? { cacheControl: 'private, no-cache' } : {}),
    });
    const headers = {
      ...headerStrings(plan.headers),
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    };
    if (plan.status >= 300 || request.method === 'HEAD' || size === 0) {
      return new Response(null, { status: plan.status, headers });
    }
    const stream = createReadStream(target.path, { start: plan.start, end: plan.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: plan.status,
      headers,
    });
  });
}
