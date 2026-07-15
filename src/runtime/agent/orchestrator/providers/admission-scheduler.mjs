import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const PROVIDER_ACCOUNT_CONCURRENCY = 64;

function abortError(signal, fallback = 'provider request canceled') {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error(String(signal?.reason || fallback));
}

/**
 * FIFO, unbounded admission queue. Limits are fixed per provider/account key;
 * failures never resize a lane, so a 429/timeout affects only its own request.
 */
export class ProviderAdmissionScheduler {
    constructor({ concurrency = PROVIDER_ACCOUNT_CONCURRENCY } = {}) {
        this.concurrency = Math.max(1, Math.floor(Number(concurrency) || PROVIDER_ACCOUNT_CONCURRENCY));
        this.lanes = new Map();
        this.running = new Set();
        this.closedReason = null;
        this.context = new AsyncLocalStorage();
    }

    run(key, task, { signal = null } = {}) {
        const laneKey = String(key || 'provider:default');
        // Provider-local recovery may recursively call this.send(). It already
        // owns a slot, so reacquiring the same lane could deadlock a full wave.
        if (this.context.getStore() === laneKey) return Promise.resolve().then(() => task(signal));
        if (this.closedReason) return Promise.reject(this.closedReason);
        if (signal?.aborted) return Promise.reject(abortError(signal));

        const lane = this.lanes.get(laneKey) || { active: 0, queue: [] };
        this.lanes.set(laneKey, lane);
        return new Promise((resolve, reject) => {
            const item = { task, signal, resolve, reject, canceled: false, onAbort: null };
            if (signal) {
                item.onAbort = () => {
                    if (item.started || item.canceled) return;
                    item.canceled = true;
                    const index = lane.queue.indexOf(item);
                    if (index >= 0) lane.queue.splice(index, 1);
                    this._detach(item);
                    item.task = null;
                    reject(abortError(signal));
                    this._drain(laneKey, lane);
                };
                signal.addEventListener('abort', item.onAbort, { once: true });
            }
            lane.queue.push(item);
            this._drain(laneKey, lane);
        });
    }

    _drain(key, lane) {
        while (lane.active < this.concurrency && lane.queue.length) {
            const item = lane.queue.shift();
            if (item.canceled) {
                this._detach(item);
                continue;
            }
            if (item.signal?.aborted) {
                item.canceled = true;
                this._detach(item);
                item.reject(abortError(item.signal));
                continue;
            }
            item.started = true;
            this._detach(item);
            lane.active += 1;
            const controller = new AbortController();
            const running = { controller, parentSignal: item.signal, parentAbort: null };
            if (item.signal) {
                running.parentAbort = () => {
                    try { controller.abort(item.signal.reason); } catch {}
                };
                item.signal.addEventListener('abort', running.parentAbort, { once: true });
            }
            this.running.add(running);
            this.context.run(key, () => Promise.resolve().then(() => item.task(controller.signal)))
                .then(item.resolve, item.reject)
                .finally(() => {
                    if (running.parentAbort && running.parentSignal) {
                        try { running.parentSignal.removeEventListener('abort', running.parentAbort); } catch {}
                    }
                    this.running.delete(running);
                    lane.active -= 1;
                    if (lane.active === 0 && lane.queue.length === 0) this.lanes.delete(key);
                    else this._drain(key, lane);
                });
        }
        if (lane.active === 0 && lane.queue.length === 0) this.lanes.delete(key);
    }

    _detach(item) {
        if (item.onAbort && item.signal) {
            try { item.signal.removeEventListener('abort', item.onAbort); } catch {}
            item.onAbort = null;
        }
    }

    shutdown(reason = new Error('provider scheduler shutting down')) {
        if (!this.closedReason) {
            this.closedReason = reason instanceof Error ? reason : new Error(String(reason));
        }
        for (const lane of this.lanes.values()) {
            for (const item of lane.queue.splice(0)) {
                if (item.canceled) continue;
                item.canceled = true;
                this._detach(item);
                item.task = null;
                item.reject(this.closedReason);
            }
        }
        for (const running of this.running) {
            try { running.controller.abort(this.closedReason); } catch {}
        }
    }
}

function digest(value) {
    return createHash('sha256').update(String(value || '')).digest('hex');
}

export function providerAdmissionKey(providerName, provider) {
    const name = String(providerName || provider?.name || 'provider');
    const identity = provider?.tokens?.account_id
        || provider?.tokens?.user_id
        || provider?.credentials?.accountId
        || provider?.credentials?.account_id
        || provider?.credentials?.userId
        || provider?.credentials?.user_id
        || provider?.config?.accountId
        || provider?.config?.account_id
        || provider?.apiKey
        || provider?.config?.apiKey
        // OAuth access tokens rotate. Prefer stable account identity above and
        // a stable refresh credential below so a refresh cannot open a second
        // 64-wide lane while old-token requests are still running.
        || provider?.tokens?.refresh_token
        || provider?.credentials?.refreshToken
        || provider?.tokens?.access_token
        || provider?.credentials?.accessToken
        || 'default';
    return `${name}:${digest(identity)}`;
}

export const providerAdmissionScheduler = new ProviderAdmissionScheduler();
const WRAPPED = Symbol.for('mixdog.providerAdmissionWrapped');

export function wrapProviderAdmission(provider, providerName, scheduler = providerAdmissionScheduler) {
    if (!provider || typeof provider.send !== 'function' || provider[WRAPPED]) return provider;
    const originalSend = provider.send;
    Object.defineProperty(provider, WRAPPED, { value: true });
    provider.send = function admittedProviderSend(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        const key = providerAdmissionKey(providerName, this);
        return scheduler.run(key, (admissionSignal) => {
            // Admission is the common request-clock boundary for WS/SSE/HTTP.
            // Queue wait therefore cannot consume first-byte or agent-watchdog
            // time. Provider-local retry remains the sole retry owner.
            try { opts.onStageChange?.('requesting'); } catch {}
            return originalSend.call(this, messages, model, tools, {
                ...opts,
                signal: admissionSignal,
            });
        }, { signal });
    };
    return provider;
}

globalThis.__mixdogShutdownProviderAdmission = (reason = 'process shutdown') => {
    providerAdmissionScheduler.shutdown(new Error(String(reason)));
};
