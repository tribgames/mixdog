import { logWebhook } from './log.mjs';
import {
  loadEndpointConfig,
  readEndpointSecret,
  claimDelivery,
  updateDeliveryStatus,
} from '../../../shared/webhooks-db.mjs';
import { contentDeliveryId, extractDeliveryId, buildHeadersSummary } from './deliveries.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function parseEndpointName(url) {
  const rawName = url.slice('/webhook/'.length).split('?')[0];
  let name = '';
  try {
    name = decodeURIComponent(rawName);
  } catch {
    name = rawName;
  }
  return { rawName, name };
}

function rejectRequest(req, res, status, error) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
  try {
    req.destroy();
  } catch {}
}

function collectRawBody(req, res) {
  return new Promise((resolve) => {
    const bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      if (bodyTooLarge) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buf.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large', limit: MAX_BODY_BYTES }));
        } catch {}
        try {
          req.destroy();
        } catch {}
        resolve(null);
        return;
      }
      bodyChunks.push(buf);
    });
    req.on('end', () => {
      if (bodyTooLarge) return;
      resolve(bodyChunks.length === 1 ? bodyChunks[0] : Buffer.concat(bodyChunks, bodyBytes));
    });
  });
}

function normalizeHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k.toLowerCase()] = v;
  }
  return headers;
}

async function resolveWebhookEndpoint(name, rawBody, headers, res, { getConfig, verifyRequest }) {
  // Endpoint def from the PG webhooks.endpoints table; a global
  // config.endpoints entry is the fallback for parser-only endpoints.
  const dbEndpoint = await loadEndpointConfig(name);
  const config = getConfig();
  const endpoint = dbEndpoint || config.endpoints?.[name] || null;
  if (endpoint?.enabled === false) {
    logWebhook(`rejected: disabled endpoint ${name}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'disabled endpoint' }));
    return null;
  }
  // Endpoint registration gate. An endpoint is registered iff a table
  // row exists OR a global config.endpoints entry is present. eventPipeline
  // routing is reachable only through a registered endpoint.
  if (!endpoint) {
    logWebhook(`rejected: unknown endpoint ${name}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown endpoint' }));
    return null;
  }
  // Raw secret is fetched via the single explicit secret-read path;
  // loadEndpointConfig only exposes a `secretSet` flag, never the value.
  const secret = (await readEndpointSecret(name)) || config.secret;
  if (
    !verifyRequest({
      name,
      endpoint,
      isTableEndpoint: !!dbEndpoint,
      secret,
      body: rawBody,
      headers,
      res,
    })
  )
    return null;
  return { dbEndpoint };
}

async function claimWebhookDelivery(name, rawBody, body, headers) {
  // Claim identity = the sender's own delivery id BOUND to the digest of
  // the authenticated body. Keying on the digest alone made dedup permanent
  // per content: two legitimately distinct deliveries with an identical
  // payload (a repeated ping, a re-run of the same job) were suppressed
  // forever. Binding the id to the body still makes a replay of a captured
  // body under its original delivery id a duplicate.
  const bodyDigestId = contentDeliveryId(rawBody);
  const sourceDeliveryId = extractDeliveryId(headers);
  const deliveryId = sourceDeliveryId ? `${String(sourceDeliveryId).slice(0, 120)}:${bodyDigestId}` : bodyDigestId;
  // Atomic claim + dedup in one step: INSERT ... ON CONFLICT DO NOTHING.
  // A concurrent duplicate POST of the same id loses the race
  // (claimed:false) and is rejected flat, so the first run is never
  // double-dispatched. All summary fields are captured on this single
  // INSERT; later transitions are status-only updates.
  const claim = await claimDelivery(name, deliveryId, {
    status: 'received',
    event: headers['x-github-event'] || null,
    headersSummary: buildHeadersSummary(headers),
    payloadPreview: String(body || '').slice(0, 512),
  });
  return { claim, deliveryId };
}

const REQUEST_HANDLED = Symbol('webhook request handled');

async function parseWebhookBody(name, body, headers, deliveryId, res) {
  // JSON content-type gate. Webhook handlers below assume parsed is
  // a plain object; an x-www-form-urlencoded body would parse to a
  // string and let downstream `parsed?.action` lookups silently miss
  // the actionable-event filter.
  const ctype = String(headers['content-type'] || '').toLowerCase();
  const looksJson = ctype.includes('application/json') || ctype.includes('+json');
  if (body && !looksJson) {
    logWebhook(`${name}: rejected — non-JSON content-type "${ctype || '<none>'}"`);
    // Terminal failed row resolves the `received` claim so retries don't
    // dedup forever.
    await updateDeliveryStatus(name, deliveryId, 'failed', {
      error: `unsupported content-type: ${ctype || '<none>'}`,
    });
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported content-type', expected: 'application/json' }));
    return REQUEST_HANDLED;
  }
  const parsed = body ? JSON.parse(body) : {};
  const eventType = headers['x-github-event'] || null;
  // Invariant: skip self-generated GitHub issue_comment events. All
  // mixdog-authored issue comments are prefixed with "[mixdog "
  // (e.g. "[mixdog reviewer] ..."), so a comment.body starting with
  // that marker is guaranteed to be our own dispatch and forwarding
  // it would create a self-trigger loop.
  if (
    eventType === 'issue_comment' &&
    typeof parsed?.comment?.body === 'string' &&
    parsed.comment.body.startsWith('[mixdog ')
  ) {
    await updateDeliveryStatus(name, deliveryId, 'self-comment-skip');
    logWebhook(`${name}: self-comment-skip ${deliveryId}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'self-comment-skip', id: deliveryId }));
    return REQUEST_HANDLED;
  }
  return parsed;
}

async function processWebhookBody(req, res, name, rawBody, { getConfig, verifyRequest, handleWebhook }) {
  let deliveryId;
  try {
    const headers = normalizeHeaders(req);
    const body = rawBody.length === 0 ? '' : rawBody.toString('utf8');
    const request = await resolveWebhookEndpoint(name, rawBody, headers, res, { getConfig, verifyRequest });
    if (!request) return;
    const { dbEndpoint } = request;
    const claim = await claimWebhookDelivery(name, rawBody, body, headers);
    ({ deliveryId } = claim);
    if (!claim.claim.claimed) {
      logWebhook(`${name}: dedup ${deliveryId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'dedup', id: deliveryId }));
      return;
    }
    const parsed = await parseWebhookBody(name, body, headers, deliveryId, res);
    if (parsed === REQUEST_HANDLED) return;
    await updateDeliveryStatus(name, deliveryId, 'pending');
    await handleWebhook(name, parsed, headers, res, deliveryId, dbEndpoint);
  } catch (err) {
    logWebhook(`JSON parse error for ${name}: ${err}`);
    // Terminal failed row: a 400 return must close out the `received` claim
    // so retries don't loop on dedup.
    const _id = typeof deliveryId === 'string' && deliveryId ? deliveryId : null;
    if (_id) {
      try {
        await updateDeliveryStatus(name, _id, 'failed', { error: `invalid JSON: ${err?.message || err}` });
      } catch (e2) {
        process.stderr.write(
          `mixdog webhook: failed to mark delivery ${name}/${_id} failed \u2014 ${e2?.message || e2}\n`
        );
      }
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
  }
}

async function handleWebhookPost(req, res, { getConfig, verifyRequest, handleWebhook }) {
  const { rawName, name } = parseEndpointName(req.url);
  // Strict name sanitize. Invariant: endpoint names are [a-zA-Z0-9_-]
  // up to 64 chars. Anything else (path traversal "..", NUL,
  // encoded slashes, empty) is rejected before any body read or
  // table lookup so probes / scans cannot reach later stages.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    logWebhook(`rejected: invalid endpoint name "${rawName}"`);
    rejectRequest(req, res, 404, 'invalid endpoint name');
    return;
  }
  // Registration pre-gate. Reject unknown endpoint names before
  // streaming up to MAX_BODY_BYTES of payload. Body-dependent checks
  // (signature verify, JSON parse, dedup) remain inside the body handler.
  // Endpoint defs now come from the PG webhooks.endpoints table. The
  // request stream stays paused (no 'data' listener attached yet) across
  // the await, so no body bytes are lost.
  let endpointPreCheck = null;
  try {
    endpointPreCheck = (await loadEndpointConfig(name)) || getConfig().endpoints?.[name] || null;
  } catch (err) {
    logWebhook(`${name}: endpoint lookup failed \u2014 ${err?.message || err}`);
    rejectRequest(req, res, 500, 'internal error');
    return;
  }
  if (endpointPreCheck?.enabled === false) {
    logWebhook(`rejected: disabled endpoint ${name}`);
    rejectRequest(req, res, 404, 'disabled endpoint');
    return;
  }
  if (!endpointPreCheck) {
    logWebhook(`rejected: unknown endpoint ${name}`);
    rejectRequest(req, res, 404, 'unknown endpoint');
    return;
  }
  const rawBody = await collectRawBody(req, res);
  if (rawBody === null) return;
  await processWebhookBody(req, res, name, rawBody, { getConfig, verifyRequest, handleWebhook });
}

function createWebhookRequestHandler(options) {
  return {
    handlePost: (req, res) => handleWebhookPost(req, res, options),
  };
}

export { MAX_BODY_BYTES, collectRawBody, createWebhookRequestHandler, parseEndpointName };
