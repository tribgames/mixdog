import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resourceAdmission } from '../../../shared/resource-admission.mjs';

// Normal provider traffic is not concurrency-gated. Independent sessions and
// accounts start immediately; a finite limit exists only when an operator
// explicitly configures one, or after that account reports a real 429.
export const PROVIDER_ACCOUNT_CONCURRENCY = Infinity;
export const PROVIDER_ACCOUNT_MAX_QUEUE = 1024;
// Only transient burst windows are coordinated locally. Longer subscription
// quota windows are provider-authoritative and must be checked on every new
// request because their scope can differ by model.
export const PROVIDER_COOLDOWN_FAIL_FAST_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const currentAdmission = new AsyncLocalStorage();
const PRIORITY_RANK = Object.freeze({
    'user-blocking': 0,
    'user-visible': 1,
    'best-effort': 2,
});

function normalizePriority(value) {
    const key = String(value || 'user-visible').toLowerCase();
    return Object.hasOwn(PRIORITY_RANK, key) ? key : 'user-visible';
}

export function currentProviderAdmissionOwner() {
    const active = currentAdmission.getStore();
    return active?.ownerKey ? String(active.ownerKey) : null;
}

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

function providerLabelForLane(key) {
    const prefix = String(key).split(':', 1)[0];
    const lower = prefix.toLowerCase();
    if (lower === 'anthropic-oauth') return 'Anthropic OAuth';
    if (lower === 'anthropic') return 'Anthropic';
    return prefix;
}

// Compact duration without spaces/colons so err-text's `retryAfter=([^\s:]+)`
// capture keeps the full value (e.g. 1h42m, 3m20s, 45s).
function formatCooldownMs(ms) {
    const totalSec = Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const totalMin = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (totalMin < 60) return sec ? `${totalMin}m${sec}s` : `${totalMin}m`;
    const hr = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    return min ? `${hr}h${min}m` : `${hr}h`;
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

class ProviderAdmissionQueueOverflowError extends Error {
    constructor(key, maxQueue) {
        super(`provider admission queue full for ${key} (maximum ${maxQueue})`);
        this.name = 'ProviderAdmissionQueueOverflowError';
        this.code = 'EPROVIDERQUEUEFULL';
        this.laneKey = key;
        this.maxQueue = maxQueue;
    }
}

/**
 * Deterministic refusal while a long rate-limit cooldown is active. Surfaced
 * to the caller immediately (turn fails with a visible error) instead of
 * silently parking the request until the quota window resets. httpStatus 429
 * routes it through the existing quota/rate-limit error presentation.
 */
class ProviderCooldownError extends Error {
    constructor(key, cooldownUntil, now) {
        const remaining = Math.max(0, Number(cooldownUntil) - Number(now));
        super(
            `${providerLabelForLane(key)} rate-limit cooldown active; retryAfter=${formatCooldownMs(remaining)} — `
            + 'wait for the quota window reset, or re-login / switch the provider account to continue now.',
        );
        this.name = 'ProviderCooldownError';
        this.code = 'EPROVIDERCOOLDOWN';
        this.httpStatus = 429;
        this.laneKey = key;
        this.cooldownUntil = cooldownUntil;
        this.retryAfterMs = remaining;
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
        const parsedConcurrency = Math.floor(Number(concurrency));
        this.concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
            ? parsedConcurrency
            : Infinity;
        this.maxQueue = configuredQueueBound(maxQueue);
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.lanes = new Map();
        this.running = new Set();
        this.reportedRateLimits = new WeakSet();
        this.closedReason = null;
        this.context = currentAdmission;
        // Cooldown listeners observe locally-recorded 429 cooldowns and
        // credential-driven resets so every runtime using one account sees
        // the same quota window.
        this.cooldownListeners = new Set();
    }

    /** Observe cooldown/reset events. Returns an unsubscribe function. */
    onCooldownEvent(listener) {
        if (typeof listener !== 'function') return () => {};
        this.cooldownListeners.add(listener);
        return () => this.cooldownListeners.delete(listener);
    }

    _emitCooldownEvent(event) {
        for (const listener of [...this.cooldownListeners]) {
            try { listener(event); } catch { /* observer must not break admission */ }
        }
    }

    /**
     * Apply a cooldown recorded by ANOTHER process (shard broadcast). Extends
     * the local lane's park window without re-emitting (no feedback loops) and
     * without touching the adaptive limit — only the reporting process saw the
     * actual 429. Returns true when the lane's window moved forward.
     */
    applyExternalCooldown(key, cooldownUntil) {
        const laneKey = String(key || '');
        const until = Number(cooldownUntil) || 0;
        const now = this.now();
        if (!laneKey || until <= now || this.closedReason) return false;
        if (until - now > PROVIDER_COOLDOWN_FAIL_FAST_MS) return false;
        const lane = this.lanes.get(laneKey) || {
            active: 0,
            queue: [],
            adaptive: isAnthropicLane(laneKey),
            limit: this.concurrency,
            cooldownUntil: 0,
            recoverySuccesses: 0,
            recoveryTarget: null,
            cooldownTimer: null,
            fairCursor: null,
        };
        if (!lane.adaptive || until <= lane.cooldownUntil) return false;
        this.lanes.set(laneKey, lane);
        lane.cooldownUntil = until;
        lane.recoverySuccesses = 0;
        this._scheduleCooldown(laneKey, lane);
        return true;
    }

    run(key, task, {
        signal = null,
        onCooldownWait = null,
        ownerKey = null,
        priority = 'user-visible',
    } = {}) {
        const laneKey = String(key || 'provider:default');
        const owner = String(ownerKey || 'anonymous').trim().slice(0, 240) || 'anonymous';
        const taskPriority = normalizePriority(priority);
        // Provider-local recovery may recursively call this.send(). It already
        // owns a slot, so reacquiring the same lane could deadlock a full wave.
        const current = this.context.getStore();
        if (current?.scheduler === this && current.key === laneKey) {
            return Promise.resolve().then(() => task(signal, {
                queueWaitMs: 0,
                active: current.lane.active,
                queued: current.lane.queue.length,
                limit: Number.isFinite(current.lane.limit) ? current.lane.limit : null,
            }));
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
            recoveryTarget: null,
            cooldownTimer: null,
            fairCursor: null,
        };
        this.lanes.set(laneKey, lane);
        if (lane.queue.length >= this.maxQueue) {
            return Promise.reject(new ProviderAdmissionQueueOverflowError(laneKey, this.maxQueue));
        }
        return new Promise((resolve, reject) => {
            const item = {
                task,
                signal,
                resolve,
                reject,
                canceled: false,
                onAbort: null,
                ownerKey: owner,
                priority: taskPriority,
                queuedAt: this.now(),
            };
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
            // Short-cooldown visibility: this request just parked behind an
            // active burst cooldown. Tell
            // the caller how long the silent wait will be so the UI can show
            // "rate-limited" instead of looking stalled.
            if (!item.started && !item.canceled && lane.adaptive
                && typeof onCooldownWait === 'function') {
                const waitMs = lane.cooldownUntil - this.now();
                if (waitMs > 250) {
                    try { onCooldownWait(waitMs); } catch { /* display-only */ }
                }
            }
        });
    }

    _nextQueueIndex(lane) {
        if (!lane.queue.length) return -1;
        const bestRank = Math.min(...lane.queue.map((item) =>
            PRIORITY_RANK[normalizePriority(item.priority)]));
        const eligible = lane.queue
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => PRIORITY_RANK[normalizePriority(item.priority)] === bestRank);
        const owners = [];
        for (const { item } of eligible) {
            const owner = item.ownerKey || 'anonymous';
            if (!owners.includes(owner)) owners.push(owner);
        }
        let selected = owners[0] || 'anonymous';
        if (owners.length > 1) {
            const prior = owners.indexOf(lane.fairCursor);
            selected = owners[(prior + 1 + owners.length) % owners.length];
        }
        lane.fairCursor = selected;
        return eligible.find(({ item }) => (item.ownerKey || 'anonymous') === selected)?.index
            ?? eligible[0].index;
    }

    _drain(key, lane) {
        if (lane.adaptive && lane.cooldownUntil > this.now()) {
            this._scheduleCooldown(key, lane);
            return;
        }
        while (lane.active < lane.limit && lane.queue.length) {
            const index = this._nextQueueIndex(lane);
            if (index < 0) break;
            const [item] = lane.queue.splice(index, 1);
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
            const admission = {
                scheduler: this,
                key,
                lane,
                ownerKey: item.ownerKey,
                priority: item.priority,
                rateLimited: false,
            };
            const admissionMetrics = {
                queueWaitMs: Math.max(0, this.now() - item.queuedAt),
                active: lane.active,
                queued: lane.queue.length,
                limit: Number.isFinite(lane.limit) ? lane.limit : null,
            };
            this.context.run(admission, () => Promise.resolve().then(() =>
                item.task(controller.signal, admissionMetrics)))
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

    snapshot() {
        const now = this.now();
        return {
            concurrency: Number.isFinite(this.concurrency) ? this.concurrency : null,
            lanes: [...this.lanes.entries()].map(([key, lane]) => ({
                key,
                active: lane.active,
                queued: lane.queue.length,
                owners: new Set(lane.queue.map((item) => item.ownerKey || 'anonymous')).size,
                limit: Number.isFinite(lane.limit) ? lane.limit : null,
                cooldownMs: Math.max(0, lane.cooldownUntil - now),
                oldestWaitMs: lane.queue.reduce(
                    (oldest, item) => Math.max(oldest, Math.max(0, now - (item.queuedAt || now))),
                    0,
                ),
            })),
        };
    }

    _recordFailure(key, lane, error) {
        if (!lane.adaptive) return false;
        const status = Number(error?.httpStatus || error?.status || error?.response?.status || 0);
        if (status !== 429) return false;
        const now = this.now();
        const delayMs = retryAfterMs(error, now);
        // A long Retry-After can describe a model-specific subscription pool.
        // Do not let one model's quota response suppress fresh requests to
        // another model; the provider remains authoritative on every turn.
        if (delayMs > PROVIDER_COOLDOWN_FAIL_FAST_MS) return false;
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            if (this.reportedRateLimits.has(error)) return false;
            this.reportedRateLimits.add(error);
        }
        const observed = Number.isFinite(lane.limit)
            ? lane.limit
            : Math.max(1, lane.active);
        lane.recoveryTarget = Math.max(
            Number(lane.recoveryTarget) || 0,
            observed,
        );
        lane.limit = Math.max(1, Math.floor(observed / 2));
        lane.recoverySuccesses = 0;
        lane.cooldownUntil = Math.max(
            lane.cooldownUntil,
            Math.min(Number.MAX_SAFE_INTEGER, now + delayMs),
        );
        this._scheduleCooldown(key, lane);
        this._emitCooldownEvent({ type: 'cooldown', key, cooldownUntil: lane.cooldownUntil });
        return true;
    }

    _rejectQueueForCooldown(key, lane) {
        if (!lane.queue.length) return;
        for (const item of lane.queue.splice(0)) {
            if (item.canceled) {
                this._detach(item);
                continue;
            }
            item.canceled = true;
            this._detach(item);
            item.task = null;
            item.reject(new ProviderCooldownError(key, lane.cooldownUntil, this.now()));
        }
    }

    /**
     * Clear rate-limit cooldowns (optionally for one provider). Called when
     * provider credentials change — a re-login / account switch invalidates
     * the old account's quota window, so requests must flow again immediately.
     * Returns the number of lanes reset.
     */
    resetCooldowns(providerName = null) {
        const wanted = providerName ? String(providerName).toLowerCase() : null;
        let resetCount = 0;
        for (const [key, lane] of [...this.lanes]) {
            if (!lane.adaptive) continue;
            if (wanted && String(key).split(':', 1)[0].toLowerCase() !== wanted) continue;
            if (lane.cooldownUntil <= this.now() && lane.limit >= this.concurrency) continue;
            lane.cooldownUntil = 0;
            lane.limit = this.concurrency;
            lane.recoverySuccesses = 0;
            lane.recoveryTarget = null;
            if (lane.cooldownTimer) {
                this.clearTimer(lane.cooldownTimer);
                lane.cooldownTimer = null;
            }
            resetCount += 1;
            this._drain(key, lane);
        }
        // resetCount gating terminates cross-process echo: a broadcast-driven
        // second reset finds nothing to clear and emits nothing.
        if (resetCount > 0) {
            this._emitCooldownEvent({ type: 'reset', provider: providerName ? String(providerName) : null });
        }
        return resetCount;
    }

    _recordSuccess(lane) {
        if (!lane.adaptive || !Number.isFinite(lane.limit)) return;
        lane.recoverySuccesses += 1;
        if (lane.recoverySuccesses >= lane.limit) {
            lane.limit += 1;
            lane.recoverySuccesses = 0;
            if (lane.recoveryTarget && lane.limit >= lane.recoveryTarget) {
                lane.limit = this.concurrency;
                lane.recoveryTarget = null;
            }
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

/**
 * Process-wide cooldown reset on the shared scheduler. Wired to provider auth
 * mutations (login / API-key save / forget) so switching accounts resumes
 * chat without a process restart.
 */
export function resetProviderAdmissionCooldowns(providerName = null) {
    return providerAdmissionScheduler.resetCooldowns(providerName);
}

export function wrapProviderAdmission(provider, providerName, scheduler = providerAdmissionScheduler) {
    if (!provider || typeof provider.send !== 'function' || provider[WRAPPED]) return provider;
    const originalSend = provider.send;
    Object.defineProperty(provider, WRAPPED, { value: true });
    provider.send = function admittedProviderSend(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        const key = providerAdmissionKey(providerName, this);
        // Provider queueing and network wait consume no local CPU slot. The
        // resource controller reacquires the agent lease before model output
        // continues through local context/tool processing.
        return resourceAdmission.runYielded(() =>
            scheduler.run(key, (admissionSignal, admissionMetrics) => {
                // Admission is the common request-clock boundary for WS/SSE/HTTP.
                // Queue wait therefore cannot consume first-byte or agent-watchdog
                // time. Provider-local retry remains the sole retry owner.
                try { opts.onStageChange?.('requesting'); } catch {}
                return originalSend.call(this, messages, model, tools, {
                    ...opts,
                    signal: admissionSignal,
                    _providerAdmission: admissionMetrics,
                });
            }, {
                signal,
                ownerKey: opts.admissionOwner || opts.sessionId || null,
                priority: opts.admissionPriority || 'user-visible',
                onCooldownWait: (waitMs) => {
                    // Display-only: the TUI/desktop 'reconnecting' stage already
                    // renders a custom verb, so no new stage vocabulary is needed.
                    const secs = Math.max(1, Math.ceil(waitMs / 1000));
                    try {
                        opts.onStageChange?.('reconnecting', { message: `Rate-limited — waiting ~${secs}s for the provider window` });
                    } catch { /* display-only */ }
                },
            })
        );
    };
    return provider;
}

globalThis.__mixdogShutdownProviderAdmission = (reason = 'process shutdown') => {
    providerAdmissionScheduler.shutdown(new Error(String(reason)));
};
