import crypto, { createHash } from 'node:crypto';
import http2 from 'node:http2';
import {
    AUTO_MODEL,
    FALLBACK_MODELS,
    normalizeCursorUsage,
    normalizeModels,
    normalizeParameterizedModels,
} from './cursor-wire-normalization.mjs';
import {
    decodeJsonValue,
    decodeMessage,
    encodeJsonValue,
    encodeMessage,
    rewriteConversationState,
} from './cursor-wire-protobuf.mjs';
import {
    MAX_CHECKPOINT_BYTES,
    MAX_CONNECT_FRAME_BYTES,
    assertCursorUserImages,
    capCursorToolResult,
    createCursorByteQueue,
    createCursorStreamWatchdog,
    cursorInteractionProgress,
    isRetryableCursorStreamError,
    prepareCursorToolDefinition,
    resolveCursorStreamTuning,
    storeCursorBlob,
} from './cursor-wire-guards.mjs';
import {
    buildCursorExecThrow,
    buildCursorInteractionResponse,
} from './cursor-wire-interactions.mjs';
import { markProviderRecoveryExhausted } from './retry-classifier.mjs';

const API_URL = process.env.CURSOR_API_URL || 'https://api2.cursor.sh';
const CLIENT_VERSION = process.env.MIXDOG_CURSOR_CLIENT_VERSION || 'cli-2026.08.11-e8db854';
const RUN_PATH = '/agent.v1.AgentService/Run';
const MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';
const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';
const USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const PLAN_PATH = '/aiserver.v1.DashboardService/GetPlanInfo';
const END_STREAM_FLAG = 2;
const H2_PING_INTERVAL_MS = 20_000;
const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function rpcHeaders(accessToken, path, unary) {
    return {
        ':method': 'POST',
        ':path': path,
        'content-type': unary ? 'application/proto' : 'application/connect+proto',
        te: 'trailers',
        authorization: `Bearer ${accessToken}`,
        'x-ghost-mode': 'true',
        'x-cursor-client-version': CLIENT_VERSION,
        'x-cursor-client-type': 'cli',
        'x-request-id': crypto.randomUUID(),
        ...(unary ? {} : { 'connect-protocol-version': '1' }),
    };
}

function cursorError(message, { status = 0, code = '', retryAfter = null } = {}) {
    const error = new Error(message);
    if (status) {
        error.status = status;
        error.httpStatus = status;
    }
    if (code) {
        error.code = code;
        error.cursorCode = code;
    }
    if (retryAfter != null && retryAfter !== '') {
        const headers = { 'retry-after': String(retryAfter) };
        error.retryAfter = retryAfter;
        error.headers = headers;
        error.response = { status, headers };
    }
    return error;
}

function openCursorStream({ accessToken, path = RUN_PATH, url = API_URL }) {
    const session = http2.connect(url);
    const request = session.request(rpcHeaders(accessToken, path, false));
    let dataHandler = null;
    let closeHandler = null;
    let closed = false;
    let status = 0;
    let retryAfter = null;
    let closeError = null;
    let timeout = setTimeout(() => close(cursorError(
        'Cursor connection timed out',
        { code: 'connection_timeout' },
    )), 30_000);
    const configuredIdle = Number(process.env.MIXDOG_CURSOR_H2_IDLE_TIMEOUT_MS);
    const idleTimeoutMs = Number.isFinite(configuredIdle) && configuredIdle > 0
        ? Math.floor(configuredIdle)
        : 0;
    const ping = setInterval(() => {
        if (closed || session.closed || session.destroyed) return;
        try { session.ping(() => {}); } catch {}
    }, H2_PING_INTERVAL_MS);
    ping.unref?.();

    const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = idleTimeoutMs > 0
            ? setTimeout(() => close(cursorError(
                'Cursor H2 stream timed out',
                { code: 'stream_idle_timeout' },
            )), idleTimeoutMs)
            : null;
    };
    const finish = (error = null) => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        clearInterval(ping);
        closeError = error || (status >= 400
            ? cursorError(`Cursor request failed (${status})`, { status, retryAfter })
            : null);
        try { request.close(); } catch {}
        try { session.close(); } catch {}
        closeHandler?.(closeError);
    };
    const close = (error = null) => {
        if (closed) return;
        try { request.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        try { session.destroy(); } catch {}
        finish(error);
    };

    request.on('response', (headers) => {
        status = Number(headers[':status'] || 0);
        retryAfter = headers['retry-after'] ?? null;
        resetTimeout();
    });
    request.on('data', (chunk) => {
        resetTimeout();
        dataHandler?.(Buffer.from(chunk));
    });
    request.on('end', () => finish());
    request.on('aborted', () => finish(cursorError('Cursor stream was aborted', { code: 'stream_aborted' })));
    request.on('error', (error) => finish(error));
    session.on('error', (error) => finish(error));
    session.on('goaway', (errorCode) => {
        finish(cursorError(`Cursor GOAWAY (${errorCode})`, { code: 'goaway' }));
    });

    return {
        get alive() { return !closed; },
        write(bytes) {
            if (closed) return;
            // Deliberately NOT resetTimeout(): frames written here (client
            // heartbeat every 5s, tool results) are OUR traffic and say nothing
            // about the server still being alive. Refreshing the deadline on
            // every write let a silent server hold the connection open
            // indefinitely, defeating the 120s silence bound this transport
            // owns. Only 'response'/'data' from the server re-arm it.
            request.write(bytes);
        },
        close,
        onData(handler) { dataHandler = handler; },
        onClose(handler) {
            closeHandler = handler;
            if (closed) queueMicrotask(() => handler(closeError));
        },
    };
}

async function callCursorUnary({ accessToken, path, body, url = API_URL, timeoutMs = 5_000 }) {
    return new Promise((resolve, reject) => {
        const session = http2.connect(url);
        const request = session.request(rpcHeaders(accessToken, path, true));
        const chunks = [];
        let status = 0;
        let retryAfter = null;
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('Cursor request timed out')), timeoutMs);
        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try { request.close(); } catch {}
            try { session.close(); } catch {}
            if (error) reject(error);
            else if (status >= 400) reject(cursorError(`Cursor request failed (${status})`, { status, retryAfter }));
            else resolve(Buffer.concat(chunks));
        };
        request.on('response', (headers) => {
            status = Number(headers[':status'] || 0);
            retryAfter = headers['retry-after'] ?? null;
        });
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => finish());
        request.on('error', finish);
        session.on('error', finish);
        request.end(body);
    });
}

function connectFrame(bytes, flags = 0) {
    if (bytes.length > MAX_CONNECT_FRAME_BYTES) {
        throw cursorError(`Cursor frame exceeds ${MAX_CONNECT_FRAME_BYTES} bytes`, {
            code: 'cursor_payload_too_large',
        });
    }
    const frame = Buffer.alloc(5 + bytes.length);
    frame[0] = flags;
    frame.writeUInt32BE(bytes.length, 1);
    frame.set(bytes, 5);
    return frame;
}

function createFrameParser(onMessage, onEnd) {
    const pending = createCursorByteQueue();
    const parse = (chunk) => {
        pending.append(chunk);
        while (pending.byteLength >= 5) {
            const header = pending.peek(5);
            const flags = header[0];
            const length = header.readUInt32BE(1);
            if (length > MAX_CONNECT_FRAME_BYTES) {
                throw cursorError(`Cursor frame exceeds ${MAX_CONNECT_FRAME_BYTES} bytes`, { code: 'protocol_error' });
            }
            if (pending.byteLength < length + 5) return;
            pending.read(5);
            const payload = pending.read(length);
            if (flags & 1) {
                throw cursorError('Cursor returned an unsupported compressed frame', { code: 'protocol_error' });
            }
            if (flags & ~END_STREAM_FLAG) {
                throw cursorError(`Cursor returned unsupported frame flags: ${flags}`, { code: 'protocol_error' });
            }
            if (flags & END_STREAM_FLAG) onEnd(payload);
            else onMessage(payload);
        }
    };
    parse.finish = () => {
        if (pending.byteLength) {
            throw cursorError('Cursor stream ended with a truncated frame', { code: 'protocol_error' });
        }
    };
    parse.bufferedBytes = () => pending.byteLength;
    return parse;
}

function parseEndStream(bytes) {
    try {
        const payload = JSON.parse(textDecoder.decode(bytes));
        if (!payload?.error) return null;
        const code = String(payload.error.code || 'error');
        const status = {
            unauthenticated: 401,
            permission_denied: 403,
            not_found: 404,
            resource_exhausted: 429,
            invalid_argument: 400,
            internal: 500,
            unavailable: 503,
        }[code] || 0;
        return cursorError(`Cursor ${code}: ${payload.error.message || 'request failed'}`, {
            status,
            code,
            retryAfter: payload.error.retryAfter
                ?? payload.error.retry_after
                ?? payload.metadata?.['retry-after']
                ?? payload.metadata?.retryAfter
                ?? null,
        });
    } catch {
        return cursorError('Cursor returned an invalid end-stream frame', { code: 'protocol_error' });
    }
}

function deterministicUuid(seed) {
    const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function textContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    return content.filter((part) => part?.type === 'text' && part.text).map((part) => part.text).join('\n');
}

function imagePart(value) {
    const url = value?.type === 'image_url'
        ? (typeof value.image_url === 'string' ? value.image_url : value.image_url?.url)
        : value?.type === 'image' && value.data
            ? `data:${value.mimeType || value.media_type || 'application/octet-stream'};base64,${value.data}`
            : '';
    const match = String(url || '').match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (!match) return null;
    return {
        url,
        mimeType: match[1],
        data: new Uint8Array(Buffer.from(match[2], 'base64')),
    };
}

function rootContent(content) {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    const output = [];
    for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === 'text' && part.text) output.push({ type: 'text', text: part.text });
        else {
            const image = imagePart(part);
            if (image) output.push({ type: 'image', image: image.url, mediaType: image.mimeType });
        }
    }
    return output;
}

function parseMessages(messages = []) {
    const systems = [];
    const history = [];
    const toolResults = [];
    const toolNames = new Map();
    for (const message of messages) {
        const text = textContent(message.content);
        if (message.role === 'system') systems.push(text);
        else if (message.role === 'tool') {
            const toolCallId = message.tool_call_id || '';
            const media = (message.mixdog_tool_media || []).map(imagePart).filter(Boolean);
            const isError = message.mixdog_tool_error === true;
            const toolName = toolNames.get(toolCallId) || '';
            toolResults.push({ toolCallId, content: text, media, isError });
            history.push({
                role: 'tool',
                id: toolCallId,
                content: [{
                    type: 'tool-result',
                    toolName,
                    toolCallId,
                    result: [text, ...media.map((item) => `[${item.mimeType} image]`)].filter(Boolean).join('\n'),
                    ...(isError ? { isError: true } : {}),
                }],
            });
        } else if (message.role === 'assistant') {
            const content = rootContent(message.content);
            for (const call of message.tool_calls || []) {
                const id = call?.id || '';
                const name = call?.function?.name || '';
                let args = {};
                try { args = JSON.parse(call?.function?.arguments || '{}'); } catch {}
                if (id) toolNames.set(id, name);
                content.push({ type: 'tool-call', toolCallId: id, toolName: name, args });
            }
            if (content.length) history.push({ role: 'assistant', content });
        } else if (message.role === 'developer') {
            systems.push(text);
        } else if (message.role === 'user') {
            history.push({ role: 'user', content: rootContent(message.content), text });
        }
    }
    let userText = '';
    let userImages = [];
    if (history.at(-1)?.role === 'user') {
        const active = history.pop();
        userText = active.text || '';
        userImages = active.content
            .map((part) => part.type === 'image' ? imagePart({ type: 'image_url', image_url: { url: part.image } }) : null)
            .filter(Boolean);
    }
    return { systems: systems.filter(Boolean), history, toolResults, userText, userImages };
}

function buildToolDefinitions(tools = []) {
    return tools.map((tool) => {
        const prepared = prepareCursorToolDefinition(tool);
        return {
            name: prepared.name,
            description: prepared.description,
            inputSchema: encodeJsonValue(prepared.inputSchema),
            inputSchemaJson: JSON.stringify(prepared.inputSchema),
            providerIdentifier: 'mixdog',
            toolName: prepared.name,
        };
    }).filter((tool) => tool.name);
}

function selectToolsForChoice(tools = [], toolChoice) {
    if (toolChoice === 'none') return [];
    const name = toolChoice && typeof toolChoice === 'object'
        ? toolChoice.function?.name || toolChoice.name
        : null;
    return typeof name === 'string' && name
        ? tools.filter((tool) => tool?.function?.name === name)
        : tools;
}

function requestModelParameters(body) {
    return (Array.isArray(body?.mixdog_model_parameters) ? body.mixdog_model_parameters : [])
        .map((entry) => ({
            id: String(entry?.id || '').trim(),
            value: String(entry?.value ?? ''),
        }))
        .filter((entry) => entry.id);
}

const conversations = new Map();
const activeRuns = new Map();
const MEMORY_TTL_MS = 30 * 60_000;

function forgetActiveRun(key, expected = null) {
    const active = activeRuns.get(key);
    if (!active || (expected && active !== expected)) return false;
    activeRuns.delete(key);
    if (active.expiryTimer) clearTimeout(active.expiryTimer);
    delete active.expiryTimer;
    return true;
}

function storeActiveRun(key, active) {
    const prior = activeRuns.get(key);
    if (prior && prior !== active) forgetActiveRun(key, prior);
    if (active.expiryTimer) clearTimeout(active.expiryTimer);
    active.expiryTimer = setTimeout(() => {
        if (!forgetActiveRun(key, active)) return;
        clearInterval(active.heartbeat);
        active.bridge.close(new Error('Cursor pending tool batch expired'));
    }, MEMORY_TTL_MS);
    active.expiryTimer.unref?.();
    activeRuns.set(key, active);
}

// Tear down one stored run: drop it from the registry, stop its 5s heartbeat
// interval, and close the Cursor bridge it was holding open.
function closeActiveRun(key, active, error) {
    if (!forgetActiveRun(key, active)) return false;
    clearInterval(active.heartbeat);
    try { active.bridge.close(error); } catch { /* already closing */ }
    return true;
}

// A pending tool batch deliberately outlives its HTTP response: the bridge and
// heartbeat stay up so the next request can resume the same Cursor run. That
// connection belongs to the session that opened it, so a session close / turn
// abort must reclaim it instead of leaving it connected until MEMORY_TTL_MS
// (30 minutes) expires.
export function closeCursorRunsForSession(sessionId, reason = 'session_closed') {
    const scope = String(sessionId || '').trim();
    if (!scope) return 0;
    let closed = 0;
    for (const [key, active] of [...activeRuns]) {
        if (String(active?.sessionId || '') !== scope) continue;
        if (closeActiveRun(key, active, new Error(`Cursor run closed (${reason})`))) closed += 1;
    }
    return closed;
}

// Process-wide drain (shutdown / exit): no run may keep the daemon's Cursor
// sockets and heartbeat intervals alive past teardown.
export function drainCursorRuns(reason = 'shutdown') {
    let closed = 0;
    for (const [key, active] of [...activeRuns]) {
        if (closeActiveRun(key, active, new Error(`Cursor run drained (${reason})`))) closed += 1;
    }
    return closed;
}

// Session-close / drain hooks. Both globals are shared with the openai WS pool,
// so chain the previously registered handler instead of overwriting it: whoever
// loads first stays reachable, in either import order.
const _priorCursorSessionCloseHook = globalThis.__mixdogCloseProviderConnectionsForSession;
globalThis.__mixdogCloseProviderConnectionsForSession = (sessionId, reason) => {
    try { _priorCursorSessionCloseHook?.(sessionId, reason); } finally {
        closeCursorRunsForSession(sessionId, reason);
    }
};
const _priorCursorDrainHook = globalThis.__mixdogDrainProviderConnections;
globalThis.__mixdogDrainProviderConnections = (reason) => {
    try { _priorCursorDrainHook?.(reason); } finally { drainCursorRuns(reason); }
};
process.on('exit', () => { drainCursorRuns('process-exit'); });

function conversationKey(messages, sessionId = '') {
    const scope = String(sessionId || '').trim();
    if (scope) {
        return createHash('sha256').update(`cursor-session:${scope}`).digest('hex').slice(0, 20);
    }
    const firstUser = messages.find((message) => message.role === 'user');
    return createHash('sha256').update(`cursor:${textContent(firstUser?.content).slice(0, 300)}`).digest('hex').slice(0, 20);
}

function runKey(model, messages, sessionId = '') {
    return `${model}:${conversationKey(messages, sessionId)}`;
}

function getConversation(key) {
    const now = Date.now();
    for (const [storedKey, value] of conversations) {
        if (now - value.lastAccess > MEMORY_TTL_MS) conversations.delete(storedKey);
    }
    let conversation = conversations.get(key);
    if (!conversation) {
        conversation = {
            id: deterministicUuid(`cursor-conversation:${key}`),
            checkpoint: null,
            blobs: new Map(),
            lastAccess: now,
        };
        conversations.set(key, conversation);
    }
    conversation.lastAccess = now;
    return conversation;
}

function storeBlob(conversation, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const id = new Uint8Array(createHash('sha256').update(data).digest());
    storeCursorBlob(conversation.blobs, Buffer.from(id).toString('hex'), data);
    return id;
}

function buildRunRequest({ model, modelParameters = [], maxMode = false, systems, history, userText, userImages = [], tools, conversation }) {
    assertCursorUserImages(userImages);
    const prompts = systems.length ? systems : ['You are a helpful assistant.'];
    const rootPromptMessagesJson = [];
    for (const content of prompts) {
        rootPromptMessagesJson.push(storeBlob(conversation, textEncoder.encode(JSON.stringify({ role: 'system', content }))));
    }
    for (const entry of history) {
        rootPromptMessagesJson.push(storeBlob(conversation, textEncoder.encode(JSON.stringify(entry))));
    }
    const stateBytes = rewriteConversationState(conversation.checkpoint, rootPromptMessagesJson);
    const cursorModel = model === 'auto' ? 'default' : model;
    const action = userText || userImages.length
        ? {
            userMessageAction: {
                userMessage: {
                    text: userText,
                    messageId: crypto.randomUUID(),
                    selectedContext: {
                        ...(userImages.length ? {
                            selectedImages: userImages.map((image) => ({
                                uuid: crypto.randomUUID(),
                                mimeType: image.mimeType,
                                data: image.data,
                            })),
                        } : {}),
                    },
                },
            },
        }
        : { resumeAction: {} };
    return encodeMessage('AgentClientMessage', {
        runRequest: {
            conversationState: stateBytes,
            action,
            requestedModel: {
                modelId: cursorModel,
                maxMode: maxMode === true,
                parameters: modelParameters,
            },
            mcpTools: { mcpTools: tools },
            conversationId: conversation.id,
            // NOTE: AgentRunRequest.customSystemPrompt (field 8) is a dead
            // channel on the current cloud endpoint: the server maps it to an
            // internal `--system-prompt` agent flag its binary rejects with
            // invalid_argument (400). Harness parity is carried by the
            // requestContext cloudRule instead (see handleExecMessage).
        },
    });
}

function heartbeatFrame() {
    return connectFrame(encodeMessage('AgentClientMessage', { clientHeartbeat: {} }));
}

function sendClientMessage(bridge, message) {
    bridge.write(connectFrame(encodeMessage('AgentClientMessage', message)));
}

function sendExecResult(bridge, exec, resultName, value) {
    sendClientMessage(bridge, {
        execClientMessage: {
            id: exec.id,
            execId: exec.execId || '',
            [resultName]: value,
        },
    });
}

function handleKvMessage(bridge, message, conversation) {
    if (message.getBlobArgs) {
        const key = Buffer.from(message.getBlobArgs.blobId || []).toString('hex');
        sendClientMessage(bridge, {
            kvClientMessage: {
                id: message.id,
                getBlobResult: conversation.blobs.has(key) ? { blobData: conversation.blobs.get(key) } : {},
            },
        });
    } else if (message.setBlobArgs) {
        const { blobId = new Uint8Array(), blobData = new Uint8Array() } = message.setBlobArgs;
        storeCursorBlob(conversation.blobs, Buffer.from(blobId).toString('hex'), blobData);
        sendClientMessage(bridge, { kvClientMessage: { id: message.id, setBlobResult: {} } });
    }
}

function toolByNames(tools, names) {
    return tools.find((tool) => names.includes(tool.name));
}

function argumentName(tool, candidates, fallback) {
    const properties = tool?.inputSchemaObject?.properties || {};
    return candidates.find((name) => Object.hasOwn(properties, name)) || fallback;
}

function redirectNativeExec(exec, tools) {
    const cases = [
        ['readArgs', ['read'], (tool, args) => ({
            [argumentName(tool, ['file_path', 'filePath', 'path'], 'file_path')]: args.path || '',
            ...(args.offset ? { offset: args.offset } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
        }), 'readResult'],
        ['writeArgs', ['write'], (tool, args) => ({
            [argumentName(tool, ['file_path', 'filePath', 'path'], 'file_path')]: args.path || '',
            [argumentName(tool, ['content', 'file_text', 'text'], 'content')]: args.fileBytes?.length
                ? textDecoder.decode(args.fileBytes)
                : (args.fileText || ''),
        }), 'writeResult'],
        ['fetchArgs', ['web_fetch', 'webfetch', 'fetch'], (_tool, args) => ({ url: args.url || '' }), 'fetchResult'],
        ['shellArgs', ['shell', 'bash'], (_tool, args) => ({
            command: args.command || '',
            ...(args.timeout ? { timeout_ms: args.timeout } : {}),
        }), 'shellResult'],
        ['shellStreamArgs', ['shell', 'bash'], (_tool, args) => ({
            command: args.command || '',
            ...(args.timeout ? { timeout_ms: args.timeout } : {}),
        }), 'shellStreamResult'],
        ['lsArgs', ['glob'], (_tool, args) => ({ pattern: '*', path: args.path || '' }), 'lsResult'],
        ['grepArgs', ['grep'], (_tool, args) => ({
            pattern: args.pattern || '.',
            ...(args.path ? { path: args.path } : {}),
            ...(args.glob ? { glob: args.glob } : {}),
            mode: args.outputMode || 'content',
        }), 'grepResult'],
    ];
    for (const [caseName, names, build, resultType] of cases) {
        if (!exec[caseName]) continue;
        const tool = toolByNames(tools, names);
        if (!tool) return null;
        const args = exec[caseName];
        return {
            exec,
            toolCallId: args.toolCallId || crypto.randomUUID(),
            toolName: tool.name,
            decodedArgs: JSON.stringify(build(tool, args)),
            native: { resultType, args },
        };
    }
    return null;
}

function decodeMcpArgs(args = {}) {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => {
        try { return [key, decodeJsonValue(value)]; } catch { return [key, textDecoder.decode(value)]; }
    }));
}

const UNAVAILABLE = 'Tool not available in this environment. Use a Mixdog tool instead.';
function handleExecMessage(bridge, exec, tools, cloudRule, onToolCall) {
    if (exec.requestContextArgs) {
        sendExecResult(bridge, exec, 'requestContextResult', {
            success: {
                requestContext: {
                    tools,
                    mcpInstructions: [],
                    // Cursor's rules channel: without it the server-side agent
                    // treats the client as ruleless and applies only its own
                    // harness policy (user report: policies ignored vs direct).
                    ...(cloudRule ? { cloudRule } : {}),
                    fileContents: {},
                },
            },
        });
        return;
    }
    if (exec.mcpArgs) {
        const args = exec.mcpArgs;
        const requestedName = args.toolName || args.name;
        const tool = toolByNames(tools, [requestedName]);
        if (!tool) {
            sendExecResult(bridge, exec, 'mcpResult', {
                error: { error: `Tool not available: ${requestedName || 'unknown'}` },
            });
            return;
        }
        onToolCall({
            exec,
            toolCallId: args.toolCallId || crypto.randomUUID(),
            toolName: tool.name,
            decodedArgs: JSON.stringify(decodeMcpArgs(args.args)),
        });
        return;
    }
    const redirect = redirectNativeExec(exec, tools);
    if (redirect) {
        onToolCall(redirect);
        return;
    }
    if (exec.readArgs) {
        sendExecResult(bridge, exec, 'readResult', { rejected: { path: exec.readArgs.path || '', reason: UNAVAILABLE } });
    } else if (exec.writeArgs) {
        sendExecResult(bridge, exec, 'writeResult', { rejected: { path: exec.writeArgs.path || '', reason: UNAVAILABLE } });
    } else if (exec.deleteArgs) {
        sendExecResult(bridge, exec, 'deleteResult', { rejected: { path: exec.deleteArgs.path || '', reason: UNAVAILABLE } });
    } else if (exec.lsArgs) {
        sendExecResult(bridge, exec, 'lsResult', { rejected: { path: exec.lsArgs.path || '', reason: UNAVAILABLE } });
    } else if (exec.grepArgs) {
        sendExecResult(bridge, exec, 'grepResult', { error: { error: UNAVAILABLE } });
    } else if (exec.fetchArgs) {
        sendExecResult(bridge, exec, 'fetchResult', { error: { url: exec.fetchArgs.url || '', error: UNAVAILABLE } });
    } else if (exec.shellArgs || exec.shellStreamArgs) {
        const args = exec.shellArgs || exec.shellStreamArgs;
        sendExecResult(bridge, exec, 'shellResult', {
            rejected: { command: args.command || '', workingDirectory: args.workingDirectory || '', reason: UNAVAILABLE },
        });
    } else if (exec.backgroundShellSpawnArgs) {
        const args = exec.backgroundShellSpawnArgs;
        sendExecResult(bridge, exec, 'backgroundShellSpawnResult', {
            rejected: { command: args.command || '', workingDirectory: args.workingDirectory || '', reason: UNAVAILABLE },
        });
    } else if (exec.writeShellStdinArgs) {
        sendExecResult(bridge, exec, 'writeShellStdinResult', { error: { error: UNAVAILABLE } });
    } else if (exec.diagnosticsArgs) {
        sendExecResult(bridge, exec, 'diagnosticsResult', {});
    } else {
        sendClientMessage(bridge, buildCursorExecThrow(exec, 'Unsupported Cursor native exec'));
        return false;
    }
}

function parseListedPaths(text, rootPath) {
    const root = {
        absPath: rootPath || '.',
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: true,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
    };
    for (const raw of text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const name = raw.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
        if (!name) continue;
        root.childrenFiles.push({ name });
        root.numFiles += 1;
        const dot = name.lastIndexOf('.');
        if (dot > 0) {
            const extension = name.slice(dot + 1);
            root.fullSubtreeExtensionCounts[extension] = (root.fullSubtreeExtensionCounts[extension] || 0) + 1;
        }
    }
    return root;
}

function parseGrepResult(text, args) {
    const mode = args.outputMode || 'content';
    if (mode === 'files_with_matches') {
        const files = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        return { files: { files, totalFiles: files.length } };
    }
    if (mode === 'count') {
        const counts = [];
        let totalMatches = 0;
        for (const line of text.split(/\r?\n/)) {
            const match = line.match(/^(.*):(\d+)$/);
            if (!match) continue;
            const count = Number(match[2]);
            counts.push({ file: match[1], count });
            totalMatches += count;
        }
        return { count: { counts, totalFiles: counts.length, totalMatches } };
    }
    const byFile = new Map();
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) continue;
        if (!byFile.has(match[1])) byFile.set(match[1], []);
        byFile.get(match[1]).push({ lineNumber: Number(match[2]), content: match[3] });
    }
    const matches = [...byFile].map(([file, fileMatches]) => ({ file, matches: fileMatches }));
    return {
        content: {
            matches,
            totalLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
            totalMatchedLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
        },
    };
}

function sendToolResult(bridge, pending, result, ok) {
    result = capCursorToolResult(result);
    const { exec, native } = pending;
    const text = String(result?.content ?? '');
    const media = Array.isArray(result?.media) ? result.media : [];
    if (!native) {
        sendExecResult(bridge, exec, 'mcpResult', ok ? {
            success: {
                content: [
                    { text: { text } },
                    ...media.map((image) => ({
                        image: { data: image.data, mimeType: image.mimeType },
                    })),
                ],
                isError: false,
            },
        } : {
            error: { error: text || 'Tool failed' },
        });
        return;
    }
    const args = native.args;
    if (!ok) {
        if (native.resultType === 'readResult') {
            sendExecResult(bridge, exec, 'readResult', {
                rejected: { path: args.path || '', reason: text || 'Read failed' },
            });
        } else if (native.resultType === 'writeResult') {
            sendExecResult(bridge, exec, 'writeResult', {
                rejected: { path: args.path || '', reason: text || 'Write failed' },
            });
        } else if (native.resultType === 'fetchResult') {
            sendExecResult(bridge, exec, 'fetchResult', {
                error: { url: args.url || '', error: text || 'Fetch failed' },
            });
        } else if (native.resultType === 'lsResult') {
            sendExecResult(bridge, exec, 'lsResult', {
                rejected: { path: args.path || '', reason: text || 'List failed' },
            });
        } else if (native.resultType === 'grepResult') {
            sendExecResult(bridge, exec, 'grepResult', { error: { error: text || 'Grep failed' } });
        } else if (native.resultType === 'shellStreamResult') {
            sendExecResult(bridge, exec, 'shellStream', { start: {} });
            if (text) sendExecResult(bridge, exec, 'shellStream', { stdout: { data: text } });
            sendExecResult(bridge, exec, 'shellStream', { exit: { code: 1 } });
            sendClientMessage(bridge, { execClientControlMessage: { streamClose: { id: exec.id } } });
        } else {
            sendExecResult(bridge, exec, 'shellResult', {
                rejected: {
                    command: args.command || '',
                    workingDirectory: args.workingDirectory || '',
                    reason: text || 'Command failed',
                },
            });
        }
        return;
    }
    if (native.resultType === 'readResult') {
        sendExecResult(bridge, exec, 'readResult', {
            success: {
                path: args.path || '',
                content: text,
                totalLines: text ? text.split(/\r?\n/).length : 0,
                fileSize: textEncoder.encode(text).length,
            },
        });
    } else if (native.resultType === 'writeResult') {
        const content = args.fileBytes?.length ? textDecoder.decode(args.fileBytes) : (args.fileText || '');
        sendExecResult(bridge, exec, 'writeResult', {
            success: {
                path: args.path || '',
                linesCreated: content ? content.split(/\r?\n/).length : 0,
                fileSize: textEncoder.encode(content).length,
            },
        });
    } else if (native.resultType === 'fetchResult') {
        sendExecResult(bridge, exec, 'fetchResult', {
            success: { url: args.url || '', content: text, statusCode: 200, contentType: 'text/markdown' },
        });
    } else if (native.resultType === 'shellResult') {
        sendExecResult(bridge, exec, 'shellResult', {
            success: {
                command: args.command || '',
                workingDirectory: args.workingDirectory || '',
                exitCode: 0,
                stdout: text,
            },
        });
    } else if (native.resultType === 'shellStreamResult') {
        sendExecResult(bridge, exec, 'shellStream', { start: {} });
        if (text) sendExecResult(bridge, exec, 'shellStream', { stdout: { data: text } });
        sendExecResult(bridge, exec, 'shellStream', { exit: { code: 0 } });
        sendClientMessage(bridge, { execClientControlMessage: { streamClose: { id: exec.id } } });
    } else if (native.resultType === 'lsResult') {
        sendExecResult(bridge, exec, 'lsResult', {
            success: { directoryTreeRoot: parseListedPaths(text, args.path) },
        });
    } else if (native.resultType === 'grepResult') {
        const outputMode = args.outputMode || 'content';
        sendExecResult(bridge, exec, 'grepResult', {
            success: {
                pattern: args.pattern || '',
                path: args.path || '',
                outputMode,
                workspaceResults: { [args.path || '.']: parseGrepResult(text, args) },
            },
        });
    }
}

function thinkingFilter() {
    let buffer = '';
    let reasoning = false;
    return {
        process(delta) {
            const input = buffer + delta;
            buffer = '';
            let content = '';
            let thought = '';
            let cursor = 0;
            const tags = /<(\/?)(?:think|thinking|reasoning|thought|think_intent)\s*>/gi;
            for (let match; (match = tags.exec(input));) {
                if (reasoning) thought += input.slice(cursor, match.index);
                else content += input.slice(cursor, match.index);
                reasoning = match[1] !== '/';
                cursor = tags.lastIndex;
            }
            const rest = input.slice(cursor);
            const partial = rest.lastIndexOf('<');
            if (partial >= 0 && rest.length - partial < 18 && /^<\/?[a-z_]*$/i.test(rest.slice(partial))) {
                if (reasoning) thought += rest.slice(0, partial);
                else content += rest.slice(0, partial);
                buffer = rest.slice(partial);
            } else {
                if (reasoning) thought += rest;
                else content += rest;
            }
            return { content, reasoning: thought };
        },
        flush() {
            const value = buffer;
            buffer = '';
            return reasoning ? { content: '', reasoning: value } : { content: value, reasoning: '' };
        },
    };
}

function completionChunk(id, model, delta, finishReason = null) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}

function createPendingToolBatchResponse(active, model, key) {
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
    const stream = new ReadableStream({
        start(controller) {
            for (let index = 0; index < active.pending.length; index += 1) {
                const pending = active.pending[index];
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(completionChunk(id, model, {
                    tool_calls: [{
                        index,
                        id: pending.toolCallId,
                        type: 'function',
                        function: { name: pending.toolName, arguments: pending.decodedArgs },
                    }],
                }))}\n\n`));
            }
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(completionChunk(id, model, {}, 'tool_calls'))}\n\n`));
            controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
        cancel(reason) {
            if (!forgetActiveRun(key, active)) return;
            clearInterval(active.heartbeat);
            active.bridge.close(reason instanceof Error ? reason : new Error('Cursor pending tool batch cancelled'));
        },
    });
    return new Response(stream, { headers: SSE_HEADERS });
}

function createStreamResponse({
    bridge,
    heartbeat,
    conversation,
    tools,
    cloudRule,
    model,
    key,
    // Owning session, carried into the stored run so a session close can find
    // and tear down the pending batch's bridge/heartbeat.
    sessionId = '',
    sawTurnEnded = false,
    restart = null,
}) {
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
    let currentBridge = bridge;
    let currentHeartbeat = heartbeat;
    let watchdog = null;
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) {
            const filter = thinkingFilter();
            const state = {
                outputTokens: 0,
                totalTokens: 0,
                pending: [],
                streamedTools: new Map(),
                closed: false,
                sawEnd: false,
                sawTurnEnded: sawTurnEnded === true,
                chunkSeq: 0,
                batchBoundaryChunkSeq: -1,
                batchBoundaryReady: false,
                visibleOutput: false,
            };
            let retryCount = 0;
            const tuning = resolveCursorStreamTuning();
            watchdog = createCursorStreamWatchdog({
                idleTimeoutMs: tuning.idleTimeoutMs,
                parkTimeoutMs: tuning.parkTimeoutMs,
                onTimeout: (kind) => {
                    currentBridge.close(cursorError(
                        kind === 'park'
                            ? 'Cursor stream parked on an unanswered server request'
                            : 'Cursor stream made no forward progress',
                        { code: kind === 'park' ? 'stream_park_timeout' : 'stream_idle_timeout' },
                    ));
                },
            });
            const send = (event) => {
                if (!state.closed) controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            const finish = (reason = 'stop') => {
                if (state.closed) return;
                watchdog.stop();
                const flushed = filter.flush();
                if (flushed.reasoning) send(completionChunk(id, model, { reasoning_content: flushed.reasoning }));
                if (flushed.content) send(completionChunk(id, model, { content: flushed.content }));
                send(completionChunk(id, model, {}, reason));
                const completionTokens = state.outputTokens;
                const totalTokens = state.totalTokens || completionTokens;
                send({
                    ...completionChunk(id, model, {}),
                    choices: [],
                    usage: {
                        prompt_tokens: Math.max(0, totalTokens - completionTokens),
                        completion_tokens: completionTokens,
                        total_tokens: totalTokens,
                    },
                });
                controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
                state.closed = true;
                controller.close();
            };
            const fail = (error) => {
                if (state.closed) return;
                watchdog.stop();
                state.closed = true;
                controller.error(error instanceof Error ? error : new Error(String(error)));
            };
            const finishToolBatch = () => {
                if (state.closed || state.pending.length === 0) return;
                storeActiveRun(key, {
                    bridge: currentBridge,
                    heartbeat: currentHeartbeat,
                    conversation,
                    tools,
                    cloudRule,
                    sessionId,
                    pending: state.pending,
                    sawTurnEnded: state.sawTurnEnded,
                });
                finish('tool_calls');
            };
            const processMessage = (bytes) => {
                const message = decodeMessage('AgentServerMessage', bytes);
                let progress = 'none';
                if (message.interactionUpdate) {
                    const update = message.interactionUpdate;
                    if (update.textDelta?.text) {
                        const delta = filter.process(update.textDelta.text);
                        if (delta.reasoning) {
                            state.visibleOutput = true;
                            send(completionChunk(id, model, { reasoning_content: delta.reasoning }));
                        }
                        if (delta.content) {
                            state.visibleOutput = true;
                            send(completionChunk(id, model, { content: delta.content }));
                        }
                    }
                    if (update.thinkingDelta?.text) {
                        state.visibleOutput = true;
                        send(completionChunk(id, model, { reasoning_content: update.thinkingDelta.text }));
                    }
                    if (update.toolCallStarted?.callId) {
                        state.streamedTools.set(update.toolCallStarted.callId, {
                            status: 'started',
                            modelCallId: update.toolCallStarted.modelCallId || '',
                        });
                    }
                    if (update.partialToolCall?.callId) {
                        state.streamedTools.set(update.partialToolCall.callId, {
                            status: 'partial',
                            modelCallId: update.partialToolCall.modelCallId || '',
                            argsText: update.partialToolCall.argsTextDelta || '',
                        });
                    }
                    if (update.toolCallDelta?.callId && !state.streamedTools.has(update.toolCallDelta.callId)) {
                        state.streamedTools.set(update.toolCallDelta.callId, {
                            status: 'delta',
                            modelCallId: update.toolCallDelta.modelCallId || '',
                        });
                    }
                    if (update.toolCallCompleted?.callId) {
                        state.streamedTools.set(update.toolCallCompleted.callId, {
                            status: 'completed',
                            modelCallId: update.toolCallCompleted.modelCallId || '',
                        });
                    }
                    if (update.turnEnded) {
                        state.sawTurnEnded = true;
                        state.batchBoundaryChunkSeq = state.chunkSeq;
                    }
                    if (update.stepCompleted) state.batchBoundaryChunkSeq = state.chunkSeq;
                    state.outputTokens += update.tokenDelta?.tokens || 0;
                    progress = cursorInteractionProgress(update);
                } else if (message.kvServerMessage) {
                    handleKvMessage(currentBridge, message.kvServerMessage, conversation);
                    progress = 'work';
                } else if (message.conversationCheckpointUpdate) {
                    conversation.checkpoint = message.conversationCheckpointUpdate.byteLength <= MAX_CHECKPOINT_BYTES
                        ? message.conversationCheckpointUpdate
                        : null;
                    state.batchBoundaryChunkSeq = state.chunkSeq;
                    try {
                        const checkpoint = decodeMessage('ConversationStateStructure', conversation.checkpoint);
                        state.totalTokens = checkpoint.tokenDetails?.usedTokens || state.totalTokens;
                    } catch {}
                    progress = 'work';
                } else if (message.execServerMessage) {
                    const handled = handleExecMessage(currentBridge, message.execServerMessage, tools, cloudRule, (pending) => {
                        if (state.pending.some((entry) => entry.toolCallId === pending.toolCallId)) return;
                        state.pending.push(pending);
                        const index = state.pending.length - 1;
                        send(completionChunk(id, model, {
                            tool_calls: [{
                                index,
                                id: pending.toolCallId,
                                type: 'function',
                                function: { name: pending.toolName, arguments: pending.decodedArgs },
                            }],
                        }));
                    });
                    progress = handled === false ? 'park' : 'work';
                } else if (message.interactionQuery) {
                    const outcome = buildCursorInteractionResponse(message.interactionQuery);
                    if (!outcome.handled) {
                        throw cursorError(`Unsupported Cursor interaction query: ${outcome.queryCase}`, {
                            code: 'protocol_drift',
                            status: 400,
                        });
                    }
                    sendClientMessage(currentBridge, outcome.message);
                    progress = 'work';
                } else if (message.execServerControlMessage?.abort) {
                    throw cursorError('Cursor aborted the active exec', { code: 'exec_aborted', status: 400 });
                } else if (message.$unknown?.length) {
                    throw cursorError(
                        `Unsupported Cursor server message field ${message.$unknown[0].no}`,
                        { code: 'protocol_drift', status: 400 },
                    );
                }
                return progress;
            };
            const recoverOrFail = (error) => {
                const retryable = isRetryableCursorStreamError(error);
                const recoveryEligible = !cancelled
                    && typeof restart === 'function'
                    && (!state.visibleOutput || conversation.checkpoint);
                const canRetry = retryCount < tuning.maxRetries
                    && recoveryEligible
                    && retryable;
                if (!canRetry) {
                    // A fresh Cursor run owns its bounded in-place retries. Mark
                    // exhaustion so the outer loop does not multiply that budget.
                    // Resumed tool-result streams have no restart closure; those
                    // intentionally fall through unmarked so the outer loop can
                    // rebuild from the committed assistant/tool-result history.
                    if (retryable && recoveryEligible && retryCount >= tuning.maxRetries) {
                        markProviderRecoveryExhausted(error, {
                            owner: 'cursor-wire',
                            attempts: retryCount + 1,
                        });
                    }
                    fail(error);
                    return;
                }
                retryCount += 1;
                state.sawEnd = false;
                state.batchBoundaryReady = false;
                state.batchBoundaryChunkSeq = -1;
                try {
                    const next = restart({
                        attempt: retryCount,
                        fromCheckpoint: Boolean(conversation.checkpoint),
                        visibleOutput: state.visibleOutput,
                    });
                    attachBridge(next.bridge, next.heartbeat);
                } catch (restartError) {
                    fail(restartError);
                }
            };
            const attachBridge = (nextBridge, nextHeartbeat) => {
                currentBridge = nextBridge;
                currentHeartbeat = nextHeartbeat;
                const ownedBridge = nextBridge;
                const ownedHeartbeat = nextHeartbeat;
                const frameParser = createFrameParser(
                    (bytes) => {
                        const progress = processMessage(bytes);
                        watchdog.progress(progress);
                    },
                    (bytes) => {
                        state.sawEnd = true;
                        const error = parseEndStream(bytes);
                        if (error) {
                            ownedBridge.close(error);
                        } else if (state.pending.length > 0) {
                            // A clean end-stream is also a final tool batch delimiter.
                            state.batchBoundaryReady = true;
                        } else if (!state.sawTurnEnded) {
                            ownedBridge.close(cursorError('Cursor stream ended before turnEnded', {
                                code: 'incomplete_stream',
                            }));
                        } else {
                            finish();
                            ownedBridge.close();
                        }
                    },
                );
                ownedBridge.onData((chunk) => {
                    if (currentBridge !== ownedBridge || state.closed) return;
                    state.chunkSeq += 1;
                    try {
                        frameParser(chunk);
                        if (state.pending.length > 0 && state.batchBoundaryChunkSeq === state.chunkSeq) {
                            state.batchBoundaryReady = true;
                        }
                        // Never hand a partial Connect frame to the next response parser.
                        if (state.batchBoundaryReady && frameParser.bufferedBytes() === 0) {
                            finishToolBatch();
                        }
                    } catch (error) {
                        ownedBridge.close(error);
                    }
                });
                ownedBridge.onClose((error) => {
                    clearInterval(ownedHeartbeat);
                    const active = activeRuns.get(key);
                    if (active?.bridge === ownedBridge) forgetActiveRun(key, active);
                    if (cancelled) return;
                    if (state.closed || currentBridge !== ownedBridge) return;
                    let closeError = error;
                    if (!closeError) {
                        try { frameParser.finish(); } catch (frameError) { closeError = frameError; }
                    }
                    // Cursor commonly closes HTTP/2 immediately after turnEnded without
                    // a separate Connect end frame. The turn is already complete.
                    if (state.sawTurnEnded) {
                        finish();
                        return;
                    }
                    // Tool calls already emitted to the caller remain actionable even if
                    // the parked transport vanished. The next request rebuilds/resumes.
                    if (state.pending.length > 0) {
                        finish('tool_calls');
                        return;
                    }
                    if (!closeError && !state.sawEnd) {
                        closeError = cursorError('Cursor stream closed before its end frame', {
                            code: 'protocol_error',
                        });
                    }
                    if (closeError) recoverOrFail(closeError);
                    else finish();
                });
                watchdog.start();
            };
            attachBridge(bridge, heartbeat);
        },
        cancel(reason) {
            cancelled = true;
            watchdog?.stop();
            clearInterval(currentHeartbeat);
            const active = activeRuns.get(key);
            if (active?.bridge === currentBridge) forgetActiveRun(key, active);
            currentBridge.close(reason instanceof Error ? reason : new Error('Cursor stream cancelled'));
        },
    });
    return new Response(stream, { headers: SSE_HEADERS });
}

function startRun(accessToken, requestBytes) {
    const bridge = openCursorStream({ accessToken });
    try {
        bridge.write(connectFrame(requestBytes));
    } catch (error) {
        bridge.close(error);
        throw error;
    }
    const heartbeat = setInterval(() => bridge.write(heartbeatFrame()), 5_000);
    heartbeat.unref?.();
    return { bridge, heartbeat };
}

function resumeRun(active, toolResults, userText, model, key) {
    const remaining = [];
    const pendingUserText = [active.pendingUserText, userText].filter(Boolean).join('\n\n');
    const lastExecId = active.pending.at(-1)?.exec?.execId;
    let userTextDelivered = false;
    for (const pending of active.pending) {
        const result = toolResults.find((entry) => entry.toolCallId === pending.toolCallId);
        if (!result) {
            remaining.push(pending);
            continue;
        }
        const payload = { ...result, content: String(result.content ?? '') };
        if (pendingUserText && pending.exec.execId === lastExecId) {
            payload.content += `\n\n<user_message>\n${pendingUserText}\n</user_message>`;
            userTextDelivered = true;
        }
        sendToolResult(active.bridge, pending, payload, Boolean(result) && result.isError !== true);
    }
    active.pending = remaining;
    active.pendingUserText = userTextDelivered ? '' : pendingUserText;
    if (remaining.length > 0) {
        storeActiveRun(key, active);
        return createPendingToolBatchResponse(active, model, key);
    }
    active.pendingUserText = '';
    return createStreamResponse({ ...active, model, key });
}

export async function handleChatCompletion(body, accessToken) {
    const parsed = parseMessages(body.messages);
    if (!parsed.userText && parsed.userImages.length === 0
        && parsed.history.length === 0 && parsed.toolResults.length === 0) {
        return new Response(JSON.stringify({ error: { message: 'No user message found' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    const model = body.model || 'auto';
    const modelParameters = requestModelParameters(body);
    const maxMode = body.mixdog_max_mode === true;
    const sessionId = String(body.mixdog_session_id || '');
    const key = runKey(model, body.messages, sessionId);
    const active = activeRuns.get(key);
    if (active && parsed.toolResults.length && active.bridge.alive) {
        forgetActiveRun(key, active);
        return resumeRun(active, parsed.toolResults, parsed.userText, model, key);
    }
    if (active) {
        forgetActiveRun(key, active);
        clearInterval(active.heartbeat);
        active.bridge.close(new Error('Cursor run superseded'));
    }
    const convKey = conversationKey(body.messages, sessionId);
    const conversation = getConversation(convKey);
    const selectedTools = selectToolsForChoice(body.tools, body.tool_choice);
    const toolDefinitions = buildToolDefinitions(selectedTools);
    const runInput = {
        model,
        modelParameters,
        maxMode,
        systems: parsed.systems,
        history: parsed.history,
        userText: parsed.userText,
        userImages: parsed.userImages,
        tools: toolDefinitions,
        conversation,
    };
    const requestBytes = buildRunRequest(runInput);
    const { bridge, heartbeat } = startRun(accessToken, requestBytes);
    return createStreamResponse({
        bridge,
        heartbeat,
        conversation,
        tools: toolDefinitions.map((definition, index) => ({
            ...definition,
            inputSchemaObject: selectedTools[index]?.function?.parameters || {},
        })),
        cloudRule: parsed.systems.join('\n\n') || undefined,
        model,
        key,
        sessionId,
        restart: ({ fromCheckpoint }) => startRun(
            accessToken,
            fromCheckpoint
                ? buildRunRequest({ ...runInput, userText: '', userImages: [] })
                : requestBytes,
        ),
    });
}

let cachedModels = null;

function unwrapUnaryBody(body) {
    if (body.length < 5) return body;
    const length = body.readUInt32BE(1);
    if ((body[0] & 1) === 0 && (body[0] & END_STREAM_FLAG) === 0 && body.length >= length + 5) {
        return body.subarray(5, length + 5);
    }
    return body;
}

export async function getCursorModels(accessToken) {
    if (cachedModels) return cachedModels;
    let discovered = [];
    try {
        const response = await callCursorUnary({
            accessToken,
            path: AVAILABLE_MODELS_PATH,
            body: encodeMessage('AvailableModelsRequest', {
                includeLongContextModels: true,
                useModelParameters: true,
                includeHiddenModels: false,
                doNotUseMarkdown: false,
                variantsWillBeShownInExplodedList: false,
            }),
        });
        const decoded = decodeMessage('AvailableModelsResponse', unwrapUnaryBody(response));
        discovered = decoded.useModelParameters === true
            ? normalizeParameterizedModels(decoded.models)
            : [];
    } catch {}
    if (!discovered.length) {
        try {
            const response = await callCursorUnary({
                accessToken,
                path: MODELS_PATH,
                body: new Uint8Array(),
            });
            discovered = normalizeModels(decodeMessage('GetUsableModelsResponse', unwrapUnaryBody(response)).models);
        } catch {}
    }
    const models = discovered.length ? discovered : FALLBACK_MODELS;
    cachedModels = [AUTO_MODEL, ...models.filter((model) => model.id !== AUTO_MODEL.id)];
    return cachedModels;
}

export async function getCursorUsage(accessToken) {
    const [usageBody, planBody] = await Promise.all([
        callCursorUnary({ accessToken, path: USAGE_PATH, body: new Uint8Array() }),
        callCursorUnary({ accessToken, path: PLAN_PATH, body: new Uint8Array() }).catch(() => null),
    ]);
    const usage = decodeMessage('CursorCurrentPeriodUsage', unwrapUnaryBody(usageBody));
    const plan = planBody
        ? decodeMessage('CursorPlanInfoResponse', unwrapUnaryBody(planBody))
        : {};
    return normalizeCursorUsage(usage, plan);
}

export function clearModelCache() {
    cachedModels = null;
}

export const __cursorWireInternals = Object.freeze({
    encodeMessage,
    decodeMessage,
    encodeJsonValue,
    decodeJsonValue,
    connectFrame,
    createFrameParser,
    createStreamResponse,
    parseEndStream,
    conversationKey,
    runKey,
    rewriteConversationState,
    handleExecMessage,
    sendToolResult,
    resumeRun,
    parseMessages,
    buildRunRequest,
    requestModelParameters,
    selectToolsForChoice,
    activeRunPendingCount: (key) => activeRuns.get(key)?.pending?.length || 0,
    normalizeCursorUsage,
    normalizeParameterizedModels,
});
