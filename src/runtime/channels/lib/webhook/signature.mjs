import * as crypto from 'node:crypto';

const SIGNATURE_HEADERS = {
  github: { header: 'x-hub-signature-256', prefix: 'sha256=' },
  sentry: { header: 'sentry-hook-signature', prefix: '' },
  stripe: { header: 'stripe-signature', prefix: '' },
  generic: { header: 'x-signature-256', prefix: 'sha256=' },
};
function extractSignature(headers, parser) {
  if (parser) {
    const mapping = SIGNATURE_HEADERS[parser];
    if (mapping) {
      const raw = headers[mapping.header];
      if (raw) return mapping.prefix ? raw.replace(mapping.prefix, '') : raw;
    }
  }
  for (const mapping of Object.values(SIGNATURE_HEADERS)) {
    const raw = headers[mapping.header];
    if (raw) return mapping.prefix ? raw.replace(mapping.prefix, '') : raw;
  }
  return null;
}
// Stripe's documented replay tolerance. A captured signature older (or more
// than this skew newer) than the window is rejected even if the HMAC matches.
const STRIPE_TOLERANCE_MS = 5 * 60 * 1000;
// timingSafeEqual throws on length mismatch / malformed hex; wrap so a crafted
// signature header can't crash the request handler.
function hexDigestsEqual(providedHex, expectedHex) {
  try {
    const a = Buffer.from(providedHex, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
function verifySignature(secret, rawBody, signatureValue, parser) {
  if (parser === 'stripe') {
    // Stripe signs `${t}.${payload}`, not the body alone, and the t= field
    // must be validated against the clock: without it a captured (t, v1) pair
    // replays forever. Require BOTH fields, check freshness, then verify the
    // HMAC over the timestamped payload.
    const vMatch = signatureValue.match(/v1=([a-f0-9]+)/);
    const tMatch = signatureValue.match(/t=(\d+)/);
    if (!vMatch || !tMatch) return false;
    const ts = Number(tMatch[1]);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > STRIPE_TOLERANCE_MS) return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${tMatch[1]}.`), Buffer.from(rawBody)]))
      .digest('hex');
    return hexDigestsEqual(vMatch[1], expected);
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return hexDigestsEqual(signatureValue, expected);
}

export { extractSignature, verifySignature };
