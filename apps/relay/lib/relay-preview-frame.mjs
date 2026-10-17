// Dedicated preview frame for remote HTML page previews (GET /preview-frame).
// The app embeds it as <iframe sandbox="allow-scripts allow-forms
// allow-modals" referrerpolicy="no-referrer"> and posts one HTML document into
// it. The response CSP repeats that sandbox (never allow-same-origin, top
// navigation or popups): the page runs in an opaque origin and cannot reach
// the app's storage, pairing token or relay socket.
//
// Outside network is on, over https only, like a visualize page on the
// desktop: CDN scripts/styles, web fonts, images, media, live fetches and
// https embeds load. `form-action`, `base-uri` and `object-src` stay 'none'.
// The relay's own origin is covered by `https:` (CSP cannot exclude it); it
// is unreachable WITH credentials, which is what matters:
//  - the relay's cookies are SameSite=Lax, and a request from an opaque
//    origin is cross-site, so no relay cookie is attached to its fetches,
//    subresources or nested frame navigations (Lax only rides top-level
//    navigations, which this sandbox forbids);
//  - as defence in depth the relay ignores cookie credentials on any
//    cross-site request that is not a top-level navigation, and on any
//    `Origin: null` request (static-http.mjs `cookieCredentialAllowed`);
//  - the other credentials (Authorization bearer, `?token=`) live in the
//    app's storage, which the opaque frame cannot read;
//  - relay responses carry `Cross-Origin-Resource-Policy: same-origin` and
//    no CORS grant, so the frame cannot read them either.
// The app also answers a page's requests for its own project files over
// postMessage (the page bridge). The page is static and public: no cookies
// are read or set, and nothing in it is user data.
export const PREVIEW_FRAME_PATH = '/preview-frame';

export const PREVIEW_FRAME_CSP = [
  'sandbox allow-scripts allow-forms allow-modals',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data: https:",
  "style-src 'unsafe-inline' data: https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  'connect-src https:',
  // Embeds (YouTube, maps): https only, and they inherit this sandbox.
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

const PREVIEW_FRAME_HEADERS = Object.freeze({
  'Content-Security-Policy': PREVIEW_FRAME_CSP,
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

const PREVIEW_FRAME_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Preview</title>
<script>
(function () {
  var received = false;
  window.addEventListener('message', function (event) {
    if (received || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'mixdog-preview-document' || typeof data.html !== 'string') return;
    received = true;
    document.open();
    document.write(data.html);
    document.close();
  });
  window.parent.postMessage({ type: 'mixdog-preview-ready' }, '*');
})();
</script>
`;

/** Answer a GET/HEAD for the preview frame. */
export function sendPreviewFrame(request, response) {
  response.writeHead(200, {
    ...PREVIEW_FRAME_HEADERS,
    'Content-Length': Buffer.byteLength(PREVIEW_FRAME_HTML),
  });
  response.end(request.method === 'HEAD' ? undefined : PREVIEW_FRAME_HTML);
}
