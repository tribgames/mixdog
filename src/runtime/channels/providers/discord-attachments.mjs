// Attachment download + streaming size-guard extracted from discord.mjs.
// Standalone function; takes inboxDir explicitly instead of `this`.
import { writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, sep } from "path";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function downloadSingleAttachment(att, inboxDir, { timeoutMs = 180_000 } = {}) {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`
    );
  }
  const res = await fetch(att.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`attachment download failed: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error(`attachment download returned empty body: ${att.name ?? att.id}`);
  }
  // Stream the response so an oversized payload is aborted before the
  // full body lands in memory. Buffering via arrayBuffer() first would
  // already exceed MAX_ATTACHMENT_BYTES by the time we checked length.
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_ATTACHMENT_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error(
          `attachment payload too large: exceeded ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB while streaming (${att.name ?? att.id})`
        );
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (received === 0) {
    throw new Error(`attachment download returned empty buffer: ${att.name ?? att.id}`);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), received);
  if (att.size > 0 && buf.length !== att.size) {
    process.stderr.write(`mixdog discord: attachment size mismatch: expected ${att.size} got ${buf.length} (${att.name ?? att.id})\n`);
  }
  const name = att.name ?? `${att.id}`;
  const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  const safeId = String(att.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  mkdirSync(inboxDir, { recursive: true });
  const candidate = join(inboxDir, `${Date.now()}-${safeId}.${ext}`);
  const resolvedInbox = realpathSync(inboxDir);
  if (!candidate.startsWith(resolvedInbox + sep)) {
    throw new Error(`attachment path traversal rejected: ${candidate}`);
  }
  writeFileSync(candidate, buf);
  return candidate;
}

export { MAX_ATTACHMENT_BYTES, downloadSingleAttachment };
