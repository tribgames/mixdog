import { createHash, randomBytes } from 'crypto';
import { mergeNormalizedContentEntries } from '../loop/steering.mjs';
import { isDeliveredCompletion, logDuplicateSkip } from './delivered-completions.mjs';
import { isInternalRuntimeNotificationText, promptContentText } from './prompt-utils.mjs';

const STALE_USER_INJECTION_TTL_MS = 30 * 60 * 1000;
const PENDING_PROCESS_START_MS = Date.now();
const LIFECYCLE_TOKEN = Symbol('pendingLifecycleToken');

export const COMPLETION_NOTIFICATION_KIND = 'completion_notification';
export const PENDING_MODE_PROMPT = 'prompt';
export const PENDING_MODE_TASK_NOTIFICATION = 'task-notification';

export function stampLifecycleToken(entry, token) {
    if (!entry || typeof entry !== 'object' || !token) return entry;
    try {
        Object.defineProperty(entry, LIFECYCLE_TOKEN, {
            value: token, enumerable: false, configurable: true, writable: true,
        });
    } catch { /* frozen entry: the claim map still carries the token */ }
    return entry;
}

export function entryLifecycleToken(entry) {
    const token = entry && typeof entry === 'object' ? entry[LIFECYCLE_TOKEN] : null;
    return typeof token === 'string' && token ? token : null;
}

export function carryLifecycleToken(target, source) {
    const token = entryLifecycleToken(source);
    return token ? stampLifecycleToken(target, token) : target;
}

export function newPendingMessageId() {
    return randomBytes(12).toString('hex');
}

export function pendingMessageId(entry) {
    return typeof entry?.id === 'string' && entry.id ? entry.id : null;
}

export function isCompletionNotificationEntry(entry) {
    return Boolean(entry) && typeof entry === 'object'
        && entry.notificationKind === COMPLETION_NOTIFICATION_KIND;
}

/** Queue mode of an entry: completion-marked rows are task notifications,
 *  everything else is a prompt the user (or a caller acting as one) sent. */
export function pendingEntryMode(entry) {
    if (entry?.mode === PENDING_MODE_TASK_NOTIFICATION || isCompletionNotificationEntry(entry)) {
        return PENDING_MODE_TASK_NOTIFICATION;
    }
    return PENDING_MODE_PROMPT;
}

export function completionExecutionId(entry) {
    const value = typeof entry?.executionId === 'string' ? entry.executionId.trim() : '';
    return value || null;
}

function normalizeExecution(value, executionId = null) {
    const source = value && typeof value === 'object' ? value : {};
    const clean = (field) => {
        const text = typeof source[field] === 'string' ? source[field].trim() : '';
        return text || null;
    };
    const id = clean('id') || executionId || null;
    const surface = clean('surface');
    const status = clean('status');
    const resultType = clean('resultType');
    if (!id && !surface && !status && !resultType) return null;
    return {
        ...(surface ? { surface } : {}),
        ...(id ? { id } : {}),
        ...(status ? { status } : {}),
        ...(resultType ? { resultType } : {}),
    };
}

function executionFromCompletionMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    return normalizeExecution({
        surface: meta.execution_surface,
        id: meta.execution_id,
        status: meta.status,
        resultType: meta.type,
    });
}

function completionEntryFields(entry) {
    const executionId = completionExecutionId(entry);
    const execution = normalizeExecution(entry?.execution, executionId);
    return {
        notificationKind: COMPLETION_NOTIFICATION_KIND,
        mode: PENDING_MODE_TASK_NOTIFICATION,
        ...(executionId ? { executionId } : {}),
        ...(execution ? { execution } : {}),
    };
}

export function completionWasDelivered(entry, site) {
    if (!isCompletionNotificationEntry(entry)) return false;
    const executionId = completionExecutionId(entry);
    const text = pendingMessageText(entry);
    if (!isDeliveredCompletion({ executionId, text })) return false;
    logDuplicateSkip(site, { executionId, text });
    return true;
}

/** Canonical tagger for deferred tool and agent completion notifications. */
export function markCompletionEntry(text, options = {}) {
    const value = typeof text === 'string'
        ? text
        : (text && typeof text === 'object' ? (text.text || text.content || '') : '');
    const content = String(value ?? '');
    const executionId = String(options?.executionId || options?.meta?.execution_id || '').trim();
    const identity = executionId ? `execution:${executionId}` : `content:${content}`;
    const id = `completion_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    const execution = normalizeExecution({
        ...(executionFromCompletionMeta(options?.meta) || {}),
        ...(options?.execution && typeof options.execution === 'object' ? options.execution : {}),
    }, executionId);
    return {
        id,
        content,
        text: content,
        notificationKind: COMPLETION_NOTIFICATION_KIND,
        mode: PENDING_MODE_TASK_NOTIFICATION,
        ...(executionId ? { executionId } : {}),
        ...(execution ? { execution } : {}),
        enqueuedAt: Date.now(),
    };
}

export function isStaleUserInjection(entry, now = Date.now()) {
    if (isCompletionNotificationEntry(entry)) return false;
    const enqueuedAt = Number(entry?.enqueuedAt) || 0;
    if (enqueuedAt <= 0 || enqueuedAt >= PENDING_PROCESS_START_MS) return false;
    return (now - enqueuedAt) > STALE_USER_INJECTION_TTL_MS;
}

export function lateDeliveryText(text, entry, now = Date.now()) {
    const value = String(text ?? '');
    if (!value.trim()) return value;
    const enqueuedAt = Number(entry?.enqueuedAt) || 0;
    const ageMinutes = Math.max(1, Math.round((now - enqueuedAt) / 60000));
    const age = ageMinutes >= 120 ? `~${Math.round(ageMinutes / 60)}h` : `~${ageMinutes}m`;
    return `[late delivery: queued ${age} ago, before the current session owner started]\n${value}`;
}

export function normalizePendingMessageEntry(entry) {
    if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? { content: text, text } : null;
    }
    if (Array.isArray(entry)) {
        if (entry.length === 0) return null;
        const text = promptContentText(entry).trim();
        return { content: entry, text };
    }
    if (!entry || typeof entry !== 'object') return null;
    const identity = {
        id: pendingMessageId(entry),
        enqueuedAt: Number(entry.enqueuedAt) || Date.now(),
    };
    const entryOptions = entry.options && typeof entry.options === 'object'
        ? { options: entry.options }
        : {};
    const marker = entry.notificationKind === COMPLETION_NOTIFICATION_KIND
        ? {
            ...completionEntryFields(entry),
            enqueuedAt: Number(entry.enqueuedAt) || Date.now(),
        }
        : null;
    const content = Object.prototype.hasOwnProperty.call(entry, 'content')
        ? entry.content
        : (typeof entry.message === 'string'
            ? entry.message
            : (typeof entry.text === 'string' ? entry.text : null));
    if (content == null) return null;
    const text = typeof entry.text === 'string' ? entry.text.trim() : promptContentText(content).trim();
    let out = null;
    if (Array.isArray(content)) out = content.length > 0 ? { content, text, ...entryOptions } : null;
    else if (typeof content === 'string') {
        const value = content.trim();
        out = value ? { content: value, text: text || value, ...entryOptions } : null;
    } else {
        const fallback = promptContentText(content).trim();
        out = fallback ? { content: fallback, text: text || fallback, ...entryOptions } : null;
    }
    if (!out) return null;
    return carryLifecycleToken(marker ? { ...out, ...identity, ...marker } : { ...out, ...identity }, entry);
}

export function pendingMessageText(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    return normalized ? String(normalized.text || promptContentText(normalized.content) || '').trim() : '';
}

export function pendingMessageQueueEntry(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    if (!normalized) return null;
    return carryLifecycleToken({
        ...normalized,
        text: normalized.text || promptContentText(normalized.content).trim(),
        id: normalized.id || newPendingMessageId(),
        enqueuedAt: Number(normalized.enqueuedAt) || Date.now(),
    }, entry);
}

function persistedHandoffFields(entry) {
    const handoffAt = Number(entry?.handoffAt) || 0;
    if (handoffAt <= 0) return null;
    const handoffPid = Number(entry?.handoffPid) || 0;
    return { handoffAt, ...(handoffPid > 0 ? { handoffPid } : {}) };
}

export function normalizePersistedEntry(entry) {
    const base = normalizePersistedEntryBase(entry);
    if (!base) return null;
    const handoff = persistedHandoffFields(entry);
    return handoff ? { ...base, ...handoff } : base;
}

function normalizePersistedEntryBase(entry) {
    if (typeof entry === 'string') {
        const message = entry.trim();
        return message ? {
            id: newPendingMessageId(),
            message,
            enqueuedAt: Date.now(),
        } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const id = pendingMessageId(entry) || newPendingMessageId();
    const enqueuedAt = Number(entry.enqueuedAt) || Date.now();
    if (isCompletionNotificationEntry(entry)) {
        const message = (typeof entry.message === 'string' && entry.message.trim())
            ? entry.message.trim()
            : pendingMessageText(entry);
        return message
            ? {
                id,
                message,
                ...completionEntryFields(entry),
                enqueuedAt,
            }
            : null;
    }
    if (typeof entry.message === 'string') {
        const message = entry.message.trim();
        return message ? { id, message, enqueuedAt } : null;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'content')) {
        const normalized = normalizePendingMessageEntry(entry);
        if (!normalized) return null;
        if (typeof normalized.content === 'string' && !normalized.options) {
            return { id, message: normalized.text || normalized.content, enqueuedAt };
        }
        return {
            id,
            content: normalized.content,
            text: normalized.text,
            ...(normalized.options ? { options: normalized.options } : {}),
            enqueuedAt,
        };
    }
    const text = pendingMessageText(entry);
    return text ? { id, message: text, enqueuedAt } : null;
}

export function modelVisiblePendingMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map(pendingMessageQueueEntry)
        .filter(Boolean)
        .filter((message) => !isInternalRuntimeNotificationText(
            message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'content')
                ? message.content
                : message,
        ));
}

export function _mergePendingMessageEntries(entries) {
    const source = Array.isArray(entries) ? entries : [];
    const ordered = [
        ...source.filter((entry) => !isCompletionNotificationEntry(entry)),
        ...source.filter(isCompletionNotificationEntry),
    ];
    return mergeNormalizedContentEntries(
        ordered.map(normalizePendingMessageEntry).filter(Boolean),
        promptContentText,
    );
}

export function _groupPendingMessageEntries(entries) {
    const source = Array.isArray(entries) ? entries : [];
    const prompts = source.filter((entry) => pendingEntryMode(entry) === PENDING_MODE_PROMPT);
    const notifications = source.filter((entry) => pendingEntryMode(entry) === PENDING_MODE_TASK_NOTIFICATION);
    const groups = [];
    const idsOf = (list) => list.map((entry) => pendingMessageId(entry)).filter(Boolean);
    if (prompts.length > 0) {
        const merged = mergeNormalizedContentEntries(
            prompts.map(normalizePendingMessageEntry).filter(Boolean),
            promptContentText,
        );
        if (merged?.content) {
            groups.push({ ...merged, mode: PENDING_MODE_PROMPT, ids: idsOf(prompts), entries: prompts });
        }
    }
    for (const entry of notifications) {
        const normalized = normalizePendingMessageEntry(entry);
        if (!normalized) continue;
        const merged = mergeNormalizedContentEntries([normalized], promptContentText);
        if (!merged?.content) continue;
        groups.push({
            ...merged,
            mode: PENDING_MODE_TASK_NOTIFICATION,
            ...(normalized.execution ? { execution: normalized.execution } : {}),
            ids: idsOf([entry]),
            entries: [entry],
        });
    }
    return groups;
}
