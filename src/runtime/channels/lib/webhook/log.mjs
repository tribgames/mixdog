import { join } from "path";
import { appendFileSync } from "fs";
import { appendFile } from "fs/promises";
import { DATA_DIR } from "../config.mjs";

const WEBHOOK_LOG = join(DATA_DIR, "webhook.log");
let webhookLogBuffer = [];
let webhookLogTimer = null;
function flushWebhookLog() {
  if (webhookLogTimer) {
    clearTimeout(webhookLogTimer);
    webhookLogTimer = null;
  }
  if (!webhookLogBuffer.length) return;
  const lines = webhookLogBuffer.join("");
  webhookLogBuffer = [];
  void appendFile(WEBHOOK_LOG, lines).catch(() => {});
}
try {
  process.on("beforeExit", flushWebhookLog);
  process.on("exit", () => {
    if (!webhookLogBuffer.length) return;
    try { appendFileSync(WEBHOOK_LOG, webhookLogBuffer.join("")); } catch {}
    webhookLogBuffer = [];
  });
} catch {}
function logWebhook(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`mixdog webhook: ${msg}
`);
  } catch {
  }
  webhookLogBuffer.push(line);
  if (!webhookLogTimer) {
    webhookLogTimer = setTimeout(flushWebhookLog, 1000);
    webhookLogTimer.unref?.();
  }
}

export { WEBHOOK_LOG, flushWebhookLog, logWebhook };
