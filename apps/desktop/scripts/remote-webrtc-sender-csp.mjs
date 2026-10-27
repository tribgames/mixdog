// The live-view sender page's production CSP, stamped into its built document.
//
// The built page is a file:// document, which has no response headers for the
// session's onHeadersReceived to rewrite, so its policy has to travel in the
// document itself. The page only needs its own module script (WebRTC, canvas
// and WebCodecs are not fetches), so everything else is closed: no remote
// connection, image, style, frame or worker, and no inline or eval script.
//
// The dev server serves the page over http, where the main process's response
// header carries the (looser, HMR-capable) development policy instead
// (src/main/remote-webrtc/sender-session.ts); the placeholder is dropped there.
export const REMOTE_WEBRTC_SENDER_CSP =
  "default-src 'none'; script-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";

export const REMOTE_WEBRTC_SENDER_CSP_PLACEHOLDER = '<!--mixdog-sender-csp-->';

/** The document with the policy as a meta tag (a build) or without (the dev server). */
export function stampRemoteWebrtcSenderCsp(html, built) {
  return html.replace(
    REMOTE_WEBRTC_SENDER_CSP_PLACEHOLDER,
    built ? `<meta http-equiv="Content-Security-Policy" content="${REMOTE_WEBRTC_SENDER_CSP}" />` : ''
  );
}

/** Vite plugin: stamps the sender document only; other pages carry no placeholder. */
export function remoteWebrtcSenderCspPlugin() {
  let built = false;
  return {
    name: 'mixdog-remote-webrtc-sender-csp',
    configResolved(config) {
      built = config.command === 'build';
    },
    transformIndexHtml: {
      // Before Vite adds its own tags, so the policy precedes every script.
      order: 'pre',
      handler(html) {
        return stampRemoteWebrtcSenderCsp(html, built);
      },
    },
  };
}
