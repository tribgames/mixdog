// Desktop byte lane: `mixdog-media://asset/<id>?variant=thumb`.
//
// The gallery used to pull every tile through the IPC surface as base64,
// which meant re-transferring and re-decoding the whole grid on each visit.
// A protocol handler makes tiles ordinary cacheable resources: Chromium
// fetches them in parallel, keeps them in its own cache, and asks for byte
// ranges when a <video> seeks.
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

import { protocol } from 'electron';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import type { DesktopEngineHost } from './engine-host-api';
import {
  FILE_PREVIEW_SCHEME,
  resolveFilePreview,
} from './file-preview';
import { forgetMediaFileTarget, resolveMediaFileTarget } from './media-source';

export const MEDIA_SCHEME = FILE_PREVIEW_SCHEME;

/** Must run before app ready: a non-privileged scheme cannot stream or be
 *  fetched, so ranges (video seeking) would never reach the handler. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

function headerStrings(headers: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function registerMediaProtocol(host: Pick<DesktopEngineHost, 'invokeCapability'>): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, 'Bad request.');
    }
    const previewToken = url.hostname === 'preview'
      ? (url.pathname.replace(/^\/+/, '').split('/', 1)[0] || '')
      : '';
    const preview = previewToken && /^[0-9a-f-]{36}$/i.test(previewToken)
      ? resolveFilePreview(previewToken)
      : null;
    if (url.hostname === 'preview' && !preview) return textResponse(404, 'Not found.');
    const assetId = preview ? previewToken : url.pathname.replace(/^\/+/, '');
    const variant = url.searchParams.get('variant') || 'original';
    if (!preview && (url.hostname !== 'asset' || !/^[0-9a-fA-F-]{8,64}$/.test(assetId))) {
      return textResponse(404, 'Not found.');
    }
    let target;
    if (preview) {
      target = { path: preview.path, mime: preview.mime };
    } else {
      try {
        // Local Chromium can shrink an original through Studio's bounded
        // fallback and cache the result. Probe only an existing rendition
        // here so a cold sharp/ffmpeg import never holds the visible tile.
        // Remote byte lanes keep the default generate=true path because they
        // must not transfer full-size originals merely to build thumbnails.
        target = await resolveMediaFileTarget(host, assetId, variant, { generate: false });
      } catch {
        return textResponse(500, 'Media resolution failed.');
      }
    }
    if (!target) return textResponse(404, 'Not found.');
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
      assetId,
      variant,
      rangeHeader: request.headers.get('range'),
      ifNoneMatch: request.headers.get('if-none-match'),
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
