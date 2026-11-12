// `node:http2` as the product sees it in the recorder world (lib/h2-world.mjs resolves the product's `node:http2` to this file):
// a client session to `https://host[:port]` connects, in clear text, to the world's h2c hub instead, and each stream it opens names
// the origin the product addressed in an `x-bench-origin` header (the HTTP/2 twin of the `fetch` redirect in
// lib/provider-case-recorder.mjs). Without a hub the real `node:http2` is used.
import * as real from 'node:http2';

export const ORIGIN_HEADER = 'x-bench-origin';

export function connect(authority, options, listener) {
  const hub = globalThis.__worldH2;
  if (!hub) return real.connect(authority, options, listener);
  const origin = new URL(String(authority)).origin;
  const { ALPNProtocols, servername, ca, ...rest } = options ?? {};
  const session = real.connect(`http://127.0.0.1:${hub.port}`, rest, listener);
  const request = session.request.bind(session);
  session.request = (headers, requestOptions) => request({ ...headers, [ORIGIN_HEADER]: origin }, requestOptions);
  return session;
}

export const { constants, createServer, createSecureServer, getDefaultSettings, getPackedSettings, getUnpackedSettings, sensitiveHeaders } = real;
export default { ...real.default, connect };
