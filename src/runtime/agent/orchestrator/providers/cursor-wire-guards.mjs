const SCHEMA_ANNOTATIONS = new Set([
    '$comment',
    '$id',
    '$schema',
    'default',
    'deprecated',
    'description',
    'examples',
    'readOnly',
    'title',
    'writeOnly',
]);

export const MAX_CONNECT_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_CHECKPOINT_BYTES = 48 * 1024 * 1024;
export const MAX_TOOL_TEXT_BYTES = 512 * 1024;
export const MAX_TOOL_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_USER_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CONVERSATION_BLOB_BYTES = 128 * 1024 * 1024;
export const MAX_CONVERSATION_BLOB_ENTRIES = 512;
export const MAX_INDIVIDUAL_BLOB_BYTES = 32 * 1024 * 1024;

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(max, Math.floor(parsed));
}

export function resolveCursorStreamTuning(env = process.env) {
    return {
        idleTimeoutMs: boundedInteger(env.MIXDOG_CURSOR_STREAM_IDLE_TIMEOUT_MS, 180_000),
        parkTimeoutMs: boundedInteger(env.MIXDOG_CURSOR_STREAM_PARK_TIMEOUT_MS, 45_000, { min: 1_000 }),
        maxRetries: boundedInteger(env.MIXDOG_CURSOR_STREAM_IDLE_MAX_RETRIES, 5, { max: 10 }),
    };
}

function slimSchema(value, depth = 0) {
    if (value == null || depth > 12) return value;
    if (Array.isArray(value)) return value.map((entry) => slimSchema(entry, depth + 1));
    if (typeof value !== 'object') return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (SCHEMA_ANNOTATIONS.has(key) || child === undefined) continue;
        if (key === 'additionalProperties' && child === true) continue;
        if (key === 'required' && Array.isArray(child) && child.length === 0) continue;
        output[key] = slimSchema(child, depth + 1);
    }
    return output;
}

function conciseDescription(value) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= 120) return normalized;
    const sentence = normalized.match(/^.{24,117}?[.!?](?:\s|$)/)?.[0]?.trim();
    return sentence || `${normalized.slice(0, 117)}...`;
}

export function prepareCursorToolDefinition(tool) {
    const fn = tool?.function || tool || {};
    const inputSchema = fn.parameters && typeof fn.parameters === 'object'
        ? slimSchema(fn.parameters)
        : { type: 'object', properties: {} };
    return {
        name: fn.name,
        description: conciseDescription(fn.description),
        inputSchema,
    };
}

function truncateUtf8(value, maxBytes) {
    const text = String(value ?? '');
    const encoded = Buffer.from(text, 'utf8');
    if (encoded.length <= maxBytes) return text;
    const notice = Buffer.from('\n\n[Mixdog truncated this Cursor tool result to stay within the wire limit.]');
    const end = Math.max(0, maxBytes - notice.length);
    const clipped = encoded.subarray(0, end).toString('utf8').replace(/\uFFFD$/u, '');
    return `${clipped}${notice.toString('utf8')}`;
}

export function capCursorToolResult(result) {
    const media = [];
    let mediaBytes = 0;
    for (const image of Array.isArray(result?.media) ? result.media : []) {
        const bytes = image?.data instanceof Uint8Array ? image.data : null;
        if (!bytes || bytes.byteLength > MAX_TOOL_MEDIA_BYTES) continue;
        if (mediaBytes + bytes.byteLength > MAX_TOOL_MEDIA_BYTES) break;
        media.push(image);
        mediaBytes += bytes.byteLength;
    }
    return {
        ...result,
        content: truncateUtf8(result?.content, MAX_TOOL_TEXT_BYTES),
        media,
    };
}

export function assertCursorUserImages(images) {
    for (const image of images || []) {
        const size = image?.data?.byteLength || 0;
        if (size > MAX_USER_IMAGE_BYTES) {
            const error = new Error(`Cursor image exceeds ${MAX_USER_IMAGE_BYTES} bytes`);
            error.code = 'cursor_payload_too_large';
            throw error;
        }
    }
}

function blobBytes(blobs) {
    let total = 0;
    for (const value of blobs.values()) total += value?.byteLength || 0;
    return total;
}

export function storeCursorBlob(blobs, key, value) {
    const data = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (data.byteLength > MAX_INDIVIDUAL_BLOB_BYTES) {
        const error = new Error(`Cursor blob exceeds ${MAX_INDIVIDUAL_BLOB_BYTES} bytes`);
        error.code = 'cursor_payload_too_large';
        throw error;
    }
    if (blobs.has(key)) blobs.delete(key);
    blobs.set(key, data);
    while (
        blobs.size > MAX_CONVERSATION_BLOB_ENTRIES
        || blobBytes(blobs) > MAX_CONVERSATION_BLOB_BYTES
    ) {
        const oldest = blobs.keys().next().value;
        if (oldest === undefined || (oldest === key && blobs.size === 1)) break;
        blobs.delete(oldest);
    }
    return data;
}

export function createCursorByteQueue() {
    let chunks = [];
    let chunkIndex = 0;
    let chunkOffset = 0;
    let byteLength = 0;

    const compact = () => {
        if (chunkIndex < 64) return;
        chunks = chunks.slice(chunkIndex);
        chunkIndex = 0;
    };
    const copy = (count, consume) => {
        if (count > byteLength) throw new Error('Cursor byte queue underflow');
        const output = Buffer.allocUnsafe(count);
        let written = 0;
        let index = chunkIndex;
        let offset = chunkOffset;
        while (written < count) {
            const chunk = chunks[index];
            const take = Math.min(count - written, chunk.length - offset);
            chunk.copy(output, written, offset, offset + take);
            written += take;
            offset += take;
            if (offset === chunk.length) {
                index += 1;
                offset = 0;
            }
        }
        if (consume) {
            chunkIndex = index;
            chunkOffset = offset;
            byteLength -= count;
            compact();
        }
        return output;
    };

    return {
        get byteLength() { return byteLength; },
        append(value) {
            const chunk = Buffer.from(value);
            if (!chunk.length) return;
            chunks.push(chunk);
            byteLength += chunk.length;
        },
        peek(count) { return copy(count, false); },
        read(count) { return copy(count, true); },
    };
}

export function createCursorStreamWatchdog({ idleTimeoutMs, parkTimeoutMs, onTimeout }) {
    let timer = null;
    let stopped = false;
    const arm = (timeoutMs, kind) => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (stopped || timeoutMs <= 0) return;
        timer = setTimeout(() => onTimeout(kind), timeoutMs);
        timer.unref?.();
    };
    return {
        start() { arm(idleTimeoutMs, 'idle'); },
        progress(kind) {
            if (kind === 'work') arm(idleTimeoutMs, 'idle');
            else if (kind === 'park') arm(parkTimeoutMs, 'park');
        },
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

export function cursorInteractionProgress(update) {
    if (!update) return 'none';
    if (update.heartbeat) return 'liveness';
    if (update.textDelta?.text || update.thinkingDelta?.text) return 'work';
    if (
        update.tokenDelta
        || update.toolCallStarted
        || update.toolCallCompleted
        || update.partialToolCall
        || update.toolCallDelta
        || update.thinkingCompleted
        || update.summary
        || update.summaryStarted
        || update.summaryCompleted
        || update.stepStarted
        || update.stepCompleted
        || update.turnEnded
    ) return 'work';
    return 'none';
}

export function isRetryableCursorStreamError(error) {
    const status = Number(error?.httpStatus || error?.status || 0);
    if ([400, 401, 403, 404, 429].includes(status)) return false;
    if (error?.name === 'AbortError') return false;
    return status === 0 || status >= 500;
}
