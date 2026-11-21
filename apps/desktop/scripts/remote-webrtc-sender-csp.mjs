// A file:// document has no response headers for onHeadersReceived to rewrite, so the production CSP is stamped into the built page.
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
