import { logWebhook } from './webhook/log.mjs';
import { SIGNATURE_HEADERS, extractSignature, STRIPE_TOLERANCE_MS, verifySignature } from './webhook/signature.mjs';
import { loadEndpointConfig, updateDeliveryStatus } from '../../shared/webhooks-db.mjs';
import { createWebhookListener, WEBHOOK_BIND_HOST } from './webhook/listener-lifecycle.mjs';
import { createWebhookRequestHandler } from './webhook/request-handler.mjs';
import { createWebhookVerifier } from './webhook/verification.mjs';
import { createWebhookSessionDispatcher } from './webhook/session-dispatch.mjs';

class WebhookServer {
  config;
  eventPipeline = null;
  bridgeDispatch = null;
  noSecretWarned = false;
  listener;
  requestHandler;
  sessionDispatcher;
  constructor(config) {
    this.config = config;
    const verifyRequest = createWebhookVerifier({
      getConfig: () => this.config,
      isWarningShown: () => this.noSecretWarned,
      markWarningShown: () => {
        this.noSecretWarned = true;
      },
    });
    this.sessionDispatcher = createWebhookSessionDispatcher({
      getConfig: () => this.config,
      getBridgeDispatch: () => this.bridgeDispatch,
    });
    this.requestHandler = createWebhookRequestHandler({
      getConfig: () => this.config,
      verifyRequest,
      handleWebhook: (...args) => this.handleWebhook(...args),
    });
    this.listener = createWebhookListener({
      getConfig: () => this.config,
      setConfig: (nextConfig) => {
        this.config = nextConfig;
      },
      handleRequest: (req, res) => this._handleRequest(req, res),
    });
  }
  setEventPipeline(pipeline) {
    this.eventPipeline = pipeline;
  }
  // Invoked for webhook-backed visible automation sessions.
  setBridgeDispatch(fn) {
    this.bridgeDispatch = typeof fn === 'function' ? fn : null;
  }
  // ── HTTP server ───────────────────────────────────────────────────
  start() {
    this.listener.start();
  }
  _handleRequest(req, res) {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/webhook/')) {
      this.requestHandler.handlePost(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
  stop() {
    return this.listener.stop();
  }
  // reloadConfig(webhookCfg, options?)
  async reloadConfig(config, options = {}) {
    await this.listener.reloadConfig(config, options);
  }
  async handleWebhook(name, body, headers, res, deliveryId, endpoint) {
    // A PG endpoint row runs as a VISIBLE webhook session (user decision):
    // no Lead injection, no channel delivery — the run lands in Recent like
    // a schedule run, and its session content IS the result surface.
    // Parser-only endpoints (no table row) fall through to the event
    // pipeline below.
    if (endpoint) {
      const dispatched = await this.sessionDispatcher.dispatchEndpoint({
        name,
        body,
        headers,
        res,
        deliveryId,
        endpoint,
      });
      if (dispatched) return;
    }
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      await updateDeliveryStatus(name, deliveryId, 'done');
      logWebhook(`${name}: routed to event pipeline (id=${deliveryId})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', id: deliveryId }));
      return;
    }
    await updateDeliveryStatus(name, deliveryId, 'failed', { error: 'unknown endpoint' });
    logWebhook(`unknown endpoint: ${name}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown endpoint' }));
  }
  /** Get the webhook URL for an endpoint name */
  getUrl(name) {
    return this.listener.getUrl(name);
  }
}
export {
  WebhookServer,
  WEBHOOK_BIND_HOST,
  // Exported for scripts/webhook-smoke.mjs unit coverage.
  extractSignature,
  verifySignature,
  loadEndpointConfig,
  SIGNATURE_HEADERS,
  STRIPE_TOLERANCE_MS,
};
