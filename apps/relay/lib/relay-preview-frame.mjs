// Dedicated preview frame for remote HTML page previews (GET /preview-frame).
// The app embeds it as <iframe sandbox="allow-scripts allow-forms
// allow-modals" referrerpolicy="no-referrer"> and posts one HTML document into
// it. The response CSP repeats that sandbox (never allow-same-origin, top
// navigation or popups): the page runs in an opaque origin and cannot reach
// the app's storage, pairing token or relay socket.
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
