import { WebhookServer } from '../webhook.mjs';
import { EventPipeline } from '../event-pipeline.mjs';

// Webhook server + event pipeline behind the owned runtime's automation. Both
// instances live on the worker (get/set) so file-level reference semantics
// are preserved; this module only decides when each one runs.
export function createAutomationServices({
  getConfig,
  getWebhookServer,
  setWebhookServer,
  getEventPipeline,
  setEventPipeline,
  wireWebhookHandlers,
  wireEventQueueHandlers,
}) {
  function shouldRunEventPipeline() {
    return (
      getConfig().webhook?.enabled === true ||
      (Array.isArray(getConfig().events?.rules) && getConfig().events.rules.length > 0)
    );
  }
  function ensureEventPipeline() {
    if (!getEventPipeline()) {
      setEventPipeline(new EventPipeline(getConfig().events, getConfig().channelId));
      wireEventQueueHandlers(getEventPipeline().getQueue());
    }
    return getEventPipeline();
  }
  function ensureWebhookServer() {
    if (!getWebhookServer()) {
      setWebhookServer(new WebhookServer(getConfig().webhook));
    }
    wireWebhookHandlers();
    return getWebhookServer();
  }
  async function stopWebhookAndEventRuntime() {
    if (getWebhookServer()) {
      await getWebhookServer().stop();
      setWebhookServer(null);
    }
    if (getEventPipeline()) {
      getEventPipeline().stop();
      setEventPipeline(null);
    }
  }
  function syncEventPipeline(reload) {
    if (!shouldRunEventPipeline()) {
      if (getEventPipeline()) {
        getEventPipeline().stop();
        setEventPipeline(null);
      }
      return;
    }
    const pipeline = ensureEventPipeline();
    if (reload) {
      pipeline.reloadConfig(getConfig().events, getConfig().channelId);
      wireEventQueueHandlers(pipeline.getQueue());
    }
    pipeline.start();
  }
  // server.reloadConfig is async (it awaits the current server's close()
  // before re-listening). start() is chained onto its resolution so the bound
  // port is not raced — a synchronous start() here would re-listen before
  // close() finishes and surface EADDRINUSE on the same port.
  function reloadWebhookServer(server) {
    server
      .reloadConfig(getConfig().webhook, { autoStart: false })
      .then(() => {
        // A stop / deactivate landing during the async close()+reload window
        // nulls out the worker's server (and webhook.enabled may have flipped
        // off). Without this guard the continuation would re-listen and
        // resurrect an orphan listener that no teardown tracks.
        if (getWebhookServer() !== server || getConfig().webhook?.enabled !== true) {
          try {
            server.stop();
          } catch {}
          return;
        }
        wireWebhookHandlers();
        server.start();
      })
      .catch((err) => {
        process.stderr.write(
          `mixdog channels: webhook reload failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      });
  }
  function syncWebhookServer(reload) {
    if (getConfig().webhook?.enabled !== true) {
      if (getWebhookServer()) {
        getWebhookServer().stop();
        setWebhookServer(null);
      }
      return;
    }
    const server = ensureWebhookServer();
    if (reload) reloadWebhookServer(server);
    else server.start();
  }
  function syncWebhookAndEventRuntime({ reload = false } = {}) {
    syncEventPipeline(reload);
    syncWebhookServer(reload);
  }
  return { syncWebhookAndEventRuntime, stopWebhookAndEventRuntime };
}
