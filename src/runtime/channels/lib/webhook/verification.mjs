import { logWebhook } from './log.mjs';
import { extractSignature, verifySignature } from './signature.mjs';

/** Log the reason, answer the sender with it, and report "not verified". */
function reject(res, status, payload, note) {
  logWebhook(note);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
  return false;
}

function verifySignedRequest(name, secret, parser, body, headers, res) {
  const signature = extractSignature(headers, parser);
  if (!signature) {
    return reject(
      res,
      403,
      { ok: false, error: 'missing signature' },
      `${name}: rejected \u2014 no signature header found`
    );
  }
  if (!verifySignature(secret, body, signature, parser)) {
    return reject(res, 403, { ok: false, error: 'invalid signature' }, `${name}: rejected \u2014 signature mismatch`);
  }
  return true;
}

function verifyUnsignedRequest({
  name,
  endpoint,
  isTableEndpoint,
  parser,
  config,
  res,
  isWarningShown,
  markWarningShown,
}) {
  // Fail closed: if a parser is explicitly configured (implying a
  // signed integration), reject unsigned requests with 401.
  if (parser) {
    return reject(
      res,
      401,
      { error: 'webhook secret required for signed parser' },
      `${name}: rejected \u2014 parser "${parser}" configured but no secret set`
    );
  }
  // A registered table endpoint (interactive enqueue / delegate dispatch)
  // is privileged. With no per-endpoint secret/parser AND no global
  // secret/parser there is no signature mode to fall back on, so accepting
  // would inject attacker-controlled input. Fail closed.
  if (isTableEndpoint) {
    return reject(
      res,
      401,
      { error: 'webhook secret required for endpoint' },
      `${name}: rejected (table endpoint requires a webhook secret)`
    );
  }
  // Config-file endpoints used to accept unsigned bodies with a warning. The
  // payload reaches an agent, so unauthenticated input now needs an explicit
  // opt-in (endpoint `allowUnsigned: true`, or config.allowUnsignedWebhooks).
  const allowUnsigned =
    endpoint?.allowUnsigned === true ||
    config.endpoints?.[name]?.allowUnsigned === true ||
    config.allowUnsignedWebhooks === true;
  if (!allowUnsigned) {
    return reject(
      res,
      401,
      { error: 'webhook secret required for endpoint' },
      `${name}: rejected \u2014 unsigned request and no secret configured`
    );
  }
  if (!isWarningShown()) {
    markWarningShown();
    logWebhook(`warning \u2014 unsigned webhooks explicitly allowed, skipping signature verification`);
  }
  return true;
}

function createWebhookVerifier({ getConfig, isWarningShown, markWarningShown }) {
  return function verifyRequest({ name, endpoint, isTableEndpoint, secret, body, headers, res }) {
    const config = getConfig();
    // `secret` is pre-resolved by the caller (readEndpointSecret → global
    // fallback); the per-endpoint secret now lives in the webhooks.endpoints
    // row and is never projected through loadEndpointConfig.
    const parser = endpoint?.parser || config.endpoints?.[name]?.parser;
    if (secret) return verifySignedRequest(name, secret, parser, body, headers, res);
    return verifyUnsignedRequest({
      name,
      endpoint,
      isTableEndpoint,
      parser,
      config,
      res,
      isWarningShown,
      markWarningShown,
    });
  };
}

export { createWebhookVerifier };
