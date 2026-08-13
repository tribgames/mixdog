// Header helpers retained after the webhook store moved to PG
import { createHash } from "node:crypto";

// (src/runtime/shared/webhooks-db.mjs). The file-based endpoint config,
// secret side-file, deliveries.jsonl log and the fs.watch cache are retired
// from the serving path; only these pure helpers remain.

function extractDeliveryId(headers) {
  return headers["x-github-delivery"]
    || headers["x-delivery-id"]
    || headers["x-request-id"]
    || null;
}

function contentDeliveryId(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  return `body-sha256-${createHash("sha256").update(body).digest("hex")}`;
}

function buildHeadersSummary(headers) {
  const summary = {};
  if (headers["x-github-event"]) summary.event_type = headers["x-github-event"];
  const sourceDeliveryId = extractDeliveryId(headers);
  if (sourceDeliveryId) summary.delivery_id = sourceDeliveryId;
  summary.signature_present = Boolean(
    headers["x-hub-signature-256"] || headers["x-signature-256"]
      || headers["stripe-signature"] || headers["sentry-hook-signature"]
  );
  if (headers["content-type"]) summary.content_type = headers["content-type"];
  return summary;
}

export { extractDeliveryId, contentDeliveryId, buildHeadersSummary };
