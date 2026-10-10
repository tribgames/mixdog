// Dedicated preview frame for remote HTML page previews (GET /preview-frame).
// The app embeds it as <iframe sandbox="allow-scripts"> and posts one HTML
// document into it. The page's own response CSP carries `sandbox allow-scripts`
// (opaque origin, never same-origin) and permits inline/data:/blob: content, so
// previewed scripts run while the frame cannot reach the app's storage, pairing
// token or relay socket. The page is static and public: no cookies are read or
// set, and nothing in it is user data.
export const PREVIEW_FRAME_PATH = '/preview-frame';

export const PREVIEW_FRAME_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
    "style-src 'unsafe-inline' https: data: blob:",
    'img-src https: data: blob:',
    'font-src https: data: blob:',
    'media-src https: data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; '),
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

export const PREVIEW_FRAME_HTML = `<!doctype html>
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
