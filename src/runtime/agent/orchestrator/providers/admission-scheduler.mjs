import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const PROVIDER_ACCOUNT_CONCURRENCY = 64;
export const PROVIDER_ACCOUNT_MAX_QUEUE = 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const currentAdmission = new AsyncLocalStorage();

function abortError(signal, fallback = 'provider request canceled') {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error(String(signal?.reason || fallback));
}

function configuredQueueBound(value) {
    const configured = value ?? process.env.MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE;
    const parsed = Math.floor(Number(configured));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : PROVIDER_ACCOUNT_MAX_QUEUE;
}

function isAnthropicLane(key) {
    const provider = String(key).split(':', 1)[0].toLowerCase();
    return provider === 'anthropic' || provider === 'anthropic-oauth';
}

function retryAfterMs(error, now) {
    const explicit = Number(error?.retryAfterMs);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    const headers = error?.headers || error?.response?.headers;
    const raw = headers?.get?.('retry-after')
        ?? headers?.['retry-after']
        ?? headers?.['Retry-After'];
    if (raw == null || raw === '') return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(String(raw));
    return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export class ProviderAdmissionQueueOverflowError extends Error {
    constructor(key, maxQueue) {
        super(`provider admission queue full for ${key} (maximum ${maxQueue})`);
        this.name = 'ProviderAdmissionQueueOverflowError';
        this.code = 'EPROVIDERQUEUEFULL';
        this.laneKey = key;
        this.maxQueue = maxQueue;
    }
}

/**
 * Per-account FIFO admission. Anthropic lanes use rate-limit cooldown and
 * additive recovery; other providers retain a fixed concurrency limit.
 */
export class ProviderAdmissionScheduler {
    constructor({
        concurrency = PROVIDER_ACCOUNT_CONCURRENCY,
        maxQueue,
        now = Date.now,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {}) {
        this.concurrency = Math.min(
            PROVIDER_ACCOUNT_CONCURRENCY,
            Math.max(1, Math.floor(Number(concurrency) || PROVIDER_ACCOUNT_CONCURRENCY)),
        );
        this.maxQueue = configuredQueueBound(maxQueue);
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.lanes = new Map();
        this.running = new Set();
        this.reportedRateLimits = new WeakSet();
        this.closedReason = null;
        this.context = currentAdmission;
    }

    run(key, task, { signal = null } = {}) {
        const laneKey = String(key || 'provider:default');
        // Provider-local recovery may recursively call this.send(). It already
        // owns a slot, so reacquiring the same lane could deadlock a full wave.
        const current = this.context.getStore();
        if (current?.scheduler === this && current.key === laneKey) {
            return Promise.resolve().then(() => task(signal));
        }
        if (this.closedReason) return Promise.reject(this.closedReason);
        if (signal?.aborted) return Promise.reject(abortError(signal));

        const lane = this.lanes.get(laneKey) || {
            active: 0,
            queue: [],
            adaptive: isAnthropicLane(laneKey),
            limit: this.concurrency,
            cooldownUntil: 0,
            recoverySuccesses: 0,
            cooldownTimer: null,
        };
        this.lanes.set(laneKey, lane);
        if (lane.queue.length >= this.maxQueue) {
            return Promise.reject(new ProviderAdmissionQueueOverflowError(laneKey, this.maxQueue));
        }
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
        if (lane.adaptive && lane.cooldownUntil > this.now()) {
            this._scheduleCooldown(key, lane);
            return;
        }
        while (lane.active < lane.limit && lane.queue.length) {
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
            const admission = { scheduler: this, key, lane, rateLimited: false };
            this.context.run(admission, () => Promise.resolve().then(() => item.task(controller.signal)))
                .then((value) => {
                    // A retry that eventually succeeds is not evidence that
                    // the lane should begin recovery from the 429 it just saw.
                    if (!admission.rateLimited) this._recordSuccess(lane);
                    item.resolve(value);
                }, (error) => {
                    this._recordFailure(key, lane, error);
                    item.reject(error);
                })
                .finally(() => {
                    if (running.parentAbort && running.parentSignal) {
                        try { running.parentSignal.removeEventListener('abort', running.parentAbort); } catch {}
                    }
                    this.running.delete(running);
                    lane.active -= 1;
                    if (this._canDeleteLane(lane)) this._deleteLane(key, lane);
                    else this._drain(key, lane);
                });
        }
        if (this._canDeleteLane(lane)) this._deleteLane(key, lane);
    }

    _recordFailure(key, lane, error) {
        if (!lane.adaptive) return false;
        const status = Number(error?.httpStatus || error?.status || error?.response?.status || 0);
        if (status !== 429) return false;
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            if (this.reportedRateLimits.has(error)) return false;
            this.reportedRateLimits.add(error);
        }
        lane.limit = Math.max(1, Math.floor(lane.limit / 2));
        lane.recoverySuccesses = 0;
        const now = this.now();
        lane.cooldownUntil = Math.max(
            lane.cooldownUntil,
            Math.min(Number.MAX_SAFE_INTEGER, now + retryAfterMs(error, now)),
        );
        this._scheduleCooldown(key, lane);
        return true;
    }

    _recordSuccess(lane) {
        if (!lane.adaptive || lane.limit >= this.concurrency) return;
        lane.recoverySuccesses += 1;
        if (lane.recoverySuccesses >= lane.limit) {
            lane.limit += 1;
            lane.recoverySuccesses = 0;
        }
    }

    _scheduleCooldown(key, lane) {
        if (lane.cooldownTimer || lane.cooldownUntil <= this.now() || this.closedReason) return;
        lane.cooldownTimer = this.setTimer(() => {
            lane.cooldownTimer = null;
            this._drain(key, lane);
        }, Math.min(MAX_TIMEOUT_MS, Math.max(0, lane.cooldownUntil - this.now())));
        lane.cooldownTimer?.unref?.();
    }

    _canDeleteLane(lane) {
        return lane.active === 0
            && lane.queue.length === 0
            && (!lane.adaptive || lane.cooldownUntil <= this.now());
    }

    _deleteLane(key, lane) {
        if (lane.cooldownTimer) {
            this.clearTimer(lane.cooldownTimer);
            lane.cooldownTimer = null;
        }
        if (this.lanes.get(key) === lane) this.lanes.delete(key);
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
            if (lane.cooldownTimer) {
                this.clearTimer(lane.cooldownTimer);
                lane.cooldownTimer = null;
            }
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

/**
 * Provider retry code may report an Anthropic 429 before retrying internally.
 * Outside the currently admitted Anthropic task this is intentionally a no-op.
 */
export function notifyCurrentAnthropicRateLimit(error) {
    const admission = currentAdmission.getStore();
    if (!admission?.lane?.adaptive || admission.scheduler?.closedReason) return false;
    const recorded = admission.scheduler._recordFailure(admission.key, admission.lane, error);
    if (recorded) admission.rateLimited = true;
    return recorded;
}

function digest(value) {
    return createHash('sha256').update(String(value || '')).digest('hex');
}

export function providerAdmissionKey(providerName, provider) {
    const name = String(providerName || provider?.name || 'provider');
    const stableAnthropicOAuthPath = name.toLowerCase() === 'anthropic-oauth'
        ? (provider?.credentials?.path
            || provider?.config?.credentialsPath
            || provider?.config?.credentials_path)
        : null;
    const identity = provider?.tokens?.account_id
        || provider?.tokens?.user_id
        || provider?.credentials?.accountId
        || provider?.credentials?.account_id
        || provider?.credentials?.userId
        || provider?.credentials?.user_id
        || provider?.config?.accountId
        || provider?.config?.account_id
        // Claude's actual credential snapshot has no user/account id. Its
        // non-secret bound credential path survives both access- and
        // single-use refresh-token rotation and distinguishes configured
        // accounts.
        || stableAnthropicOAuthPath
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
