import { join } from 'node:path';
import { DATA_DIR } from '../config.mjs';
import { appendBuffered } from '../../../shared/buffered-appender.mjs';

const WEBHOOK_LOG = join(DATA_DIR, 'webhook.log');
function logWebhook(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`mixdog webhook: ${msg}
`);
  } catch {}
  appendBuffered(WEBHOOK_LOG, line);
}

export { logWebhook };
