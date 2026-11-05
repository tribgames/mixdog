// Every request header is kept; only credential VALUES are redacted (the
// authorization scheme word stays). Two values are hub artefacts, not adapter
// behaviour, and are normalized so recordings are reproducible:
//   host / :authority -> the original origin's host (the adapter's, not the loopback port)
//   sec-websocket-key -> '<handshake-nonce>' (random per connection)
// `x-bench-origin` (added by the fetch redirect) becomes the record's `origin`.
const CREDENTIAL_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key)$|token|secret|password|credential/i;
// Per-request random identifiers the adapters mint (x-client-request-id, ...):
// the header stays, its value becomes a typed placeholder (shape kept, bytes not).
const RANDOM_ID_NAME = /(request|trace|span|correlation|client)-?id$/i;
const redactValue =(value) => {
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const scheme = /^(Bearer|Basic|Digest|Token)\s+\S/i.exec(text);
  return scheme ? `${scheme[1]} <redacted>` : '<redacted>';
};
export const cleanHeaders = (headers, origin = null) => {
  const out = {};
  const originHost = origin ? new URL(origin).host : null;
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'x-bench-origin') continue;
    if (CREDENTIAL_NAME.test(k)) out[k] = redactValue(v);
    else if ((k === 'host' || k === ':authority') && originHost) out[k] = originHost;
    else if (k === 'sec-websocket-key') out[k] = '<handshake-nonce>';
    else if (RANDOM_ID_NAME.test(k) && typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v)) out[k] = '<random:hex32>';
    else if (RANDOM_ID_NAME.test(k) && typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) out[k] = '<random:uuid>';
    else out[k] = v;
  }
  return out;
};
