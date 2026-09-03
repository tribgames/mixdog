import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sanitizeForWire } from './session-wire-values.mjs';

const requireDesktopModule = createRequire(import.meta.url);

async function loadDesktopServiceModule(moduleUrl) {
  const parsed = new URL(moduleUrl);
  if (!parsed.pathname.toLowerCase().endsWith('.cjs')) {
    return import(moduleUrl);
  }
  // Node's CJS bridge ignores URL search parameters and otherwise returns the
  // previous install's cached exports after an in-place desktop update. Keep
  // already-instantiated adapters alive, but load this newly keyed artifact
  // from disk for the new desktop build.
  const modulePath = fileURLToPath(parsed);
  const resolved = requireDesktopModule.resolve(modulePath);
  delete requireDesktopModule.cache[resolved];
  return requireDesktopModule(resolved);
}

function subscriberToken(ctx) {
  return ctx && ctx.clientToken ? String(ctx.clientToken) : '';
}

function desktopEventKey(desktopId, message) {
  const kind = String(message?.kind || 'event');
  if (kind === 'session-state') {
    return `desktop-event:${desktopId}:${kind}:${String(message?.sessionId || '')}`;
  }
  // Service events are NOT one lane. Under one shared `desktop-event` key a
  // terminal flood clobbered LSP/folder events — and every other terminal —
  // whenever the stream backed up, because the backlog is latest-wins per
  // key. Name (and terminal id) keep each producer on its own key.
  if (kind === 'desktop-event') {
    const name = String(message?.name || '');
    const terminalId = name === 'terminal-data' ? String(message?.value?.id || '') : '';
    return `desktop-event:${desktopId}:${kind}:${name}${terminalId ? `:${terminalId}` : ''}`;
  }
  return `desktop-event:${desktopId}:${kind}`;
}

export class DesktopServiceRegistry {
  #runtime;
  #onFrame;
  #log;
  #onExternalClientsChanged;
  #onReady;
  #servicesById = new Map();
  #servicesByModule = new Map();
  #servicePromises = new Map();
  #closed = false;

  constructor({
    runtime = null,
    onFrame = () => {},
    log = () => {},
    onExternalClientsChanged = () => {},
    onReady = () => {},
  } = {}) {
    this.#runtime = runtime;
    this.#onFrame = onFrame;
    this.#log = log;
    this.#onExternalClientsChanged = onExternalClientsChanged;
    this.#onReady = onReady;
  }

  #publish(desktopId, message) {
    const wire = sanitizeForWire(message);
    const service = this.#servicesById.get(desktopId);
    if (!wire || !service) return;
    this.#onFrame({
      type: 'desktop-event',
      key: desktopEventKey(desktopId, wire),
      desktopId,
      message: wire,
    }, service.subscribers);
  }

  #require(desktopId) {
    const id = String(desktopId || '');
    const service = this.#servicesById.get(id);
    if (!service) throw new Error('desktop service is not initialized');
    return service;
  }

  async #initialize({ desktopId, moduleUrl, options = {} } = {}) {
    if (this.#closed) throw new Error('session service is closed');
    const requestedId = String(desktopId || '').trim();
    if (!requestedId || !/^[A-Za-z0-9_-]+$/.test(requestedId)) {
      throw new TypeError('desktopId is invalid');
    }
    const requestedModule = String(moduleUrl || '').trim();
    let parsed;
    try { parsed = new URL(requestedModule); }
    catch { throw new TypeError('desktop service moduleUrl is invalid'); }
    if (parsed.protocol !== 'file:') {
      throw new TypeError('desktop service moduleUrl must be a file URL');
    }
    const existingByModule = this.#servicesByModule.get(requestedModule);
    if (existingByModule) return existingByModule;
    const existingById = this.#servicesById.get(requestedId);
    if (existingById) {
      if (existingById.moduleUrl !== requestedModule) {
        throw new Error(`desktopId ${requestedId} is already bound to another service module`);
      }
      return existingById;
    }
    const pending = this.#servicePromises.get(requestedModule);
    if (pending) return pending;
    const loading = (async () => {
      const loaded = await loadDesktopServiceModule(requestedModule);
      if (typeof loaded.createDesktopService !== 'function') {
        throw new TypeError('desktop service module has no createDesktopService export');
      }
      const instance = await loaded.createDesktopService({
        options: sanitizeForWire(options) || {},
        runtime: this.#runtime,
        emit: (message) => this.#publish(requestedId, message),
        onClientCountChanged: () => {
          try { this.#onExternalClientsChanged(); } catch {}
        },
      });
      if (!instance || typeof instance.invoke !== 'function'
        || typeof instance.control !== 'function') {
        throw new TypeError('desktop service adapter is invalid');
      }
      if (this.#closed) {
        try { await instance.dispose?.('session service is closed'); } catch {}
        throw new Error('session service is closed');
      }
      const record = {
        desktopId: requestedId,
        moduleUrl: requestedModule,
        instance,
        subscribers: new Set(),
      };
      this.#servicesById.set(requestedId, record);
      this.#servicesByModule.set(requestedModule, record);
      this.#log(`desktop service loaded id=${requestedId} module=${requestedModule}`);
      return record;
    })();
    this.#servicePromises.set(requestedModule, loading);
    try {
      return await loading;
    } finally {
      if (this.#servicePromises.get(requestedModule) === loading) {
        this.#servicePromises.delete(requestedModule);
      }
    }
  }

  async init(params = {}, ctx = null) {
    const service = await this.#initialize(params);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    return { desktopId: service.desktopId };
  }

  async invoke({ desktopId, method, args = [] } = {}, ctx = null) {
    const service = this.#require(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    const name = String(method || '');
    if (!name) throw new TypeError('desktop service method is required');
    return sanitizeForWire(await service.instance.invoke(
      name,
      Array.isArray(args) ? args : [],
    )) ?? null;
  }

  async control({ desktopId, message } = {}, ctx = null) {
    const service = this.#require(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    await service.instance.control(sanitizeForWire(message) || {});
    return { ok: true };
  }

  ready({ desktopId } = {}, ctx = null) {
    const service = this.#require(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    this.#onReady({ desktopId: service.desktopId, clientToken: token || null });
    return { ok: true };
  }

  async unsubscribe({ desktopId } = {}, ctx = null) {
    const service = this.#require(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.delete(token);
    return { ok: true, unsubscribed: true };
  }

  releaseClient(clientToken) {
    const token = String(clientToken || '');
    if (!token) return;
    for (const service of this.#servicesById.values()) {
      service.subscribers.delete(token);
    }
  }

  async dispose(reason = 'service stop') {
    this.#closed = true;
    const services = [...new Set(this.#servicesById.values())];
    this.#servicesById.clear();
    this.#servicesByModule.clear();
    this.#servicePromises.clear();
    for (const service of services) {
      if (!service?.instance?.dispose) continue;
      try { await service.instance.dispose(reason); }
      catch (error) {
        this.#log(`desktop service dispose failed: ${error?.message || error}`);
      }
    }
  }

  get externalClientCount() {
    let total = 0;
    for (const service of this.#servicesById.values()) {
      const count = Number(service?.instance?.clientCount ?? 0);
      if (Number.isSafeInteger(count) && count > 0) total += count;
    }
    return total;
  }
}
