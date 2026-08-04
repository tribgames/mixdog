// Header helpers retained after the webhook store moved to PG
// (src/runtime/shared/webhooks-db.mjs). The file-based endpoint config,
// secret side-file, deliveries.jsonl log and the fs.watch cache are retired
// from the serving path; only these two pure functions are still consumed by
// webhook.mjs (delivery-id extraction + the diagnostic headers summary).

function extractDeliveryId(headers) {
  return headers["x-github-delivery"]
    || headers["x-delivery-id"]
    || headers["x-request-id"]
    || null;
}

function buildHeadersSummary(headers) {
  const summary = {};
  if (headers["x-github-event"]) summary.event_type = headers["x-github-event"];
  if (headers["x-github-delivery"]) summary.delivery_id = headers["x-github-delivery"];
  summary.signature_present = Boolean(
    headers["x-hub-signature-256"] || headers["x-signature-256"]
      || headers["stripe-signature"] || headers["sentry-hook-signature"]
  );
  if (headers["content-type"]) summary.content_type = headers["content-type"];
  return summary;
}

export { extractDeliveryId, buildHeadersSummary };
