import crypto, { createHash } from 'node:crypto';
import http2 from 'node:http2';

const API_URL = process.env.CURSOR_API_URL || 'https://api2.cursor.sh';
const CLIENT_VERSION = process.env.MIXDOG_CURSOR_CLIENT_VERSION || 'cli-2026.08.11-e8db854';
const RUN_PATH = '/agent.v1.AgentService/Run';
const MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';
const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';
const USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const PLAN_PATH = '/aiserver.v1.DashboardService/GetPlanInfo';
const END_STREAM_FLAG = 2;
const MAX_CONNECT_FRAME_BYTES = 64 * 1024 * 1024;
const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

function fields(entries) {
    return Object.fromEntries(entries.map(([name, no, type, options = {}]) => [
        no,
        { name, no, type, ...options },
    ]));
}

const map = (key, value) => ({ map: [key, value] });
const repeated = { repeated: true };

// This intentionally describes only the interoperable fields Mixdog reads or writes.
// Unknown fields are skipped so Cursor can evolve the surrounding protocol independently.
const SCHEMAS = {
    ConversationStateStructure: fields([
        ['rootPromptMessagesJson', 1, 'bytes', repeated],
        ['tokenDetails', 5, 'ConversationTokenDetails'],
        ['turns', 8, 'bytes', repeated],
    ]),
    ConversationTokenDetails: fields([
        ['usedTokens', 1, 'uint'],
        ['maxTokens', 2, 'uint'],
    ]),
    UserMessage: fields([
        ['text', 1, 'string'],
        ['messageId', 2, 'string'],
        ['selectedContext', 3, 'SelectedContext'],
    ]),
    SelectedContext: fields([['selectedImages', 1, 'SelectedImage', repeated]]),
    SelectedImage: fields([
        ['uuid', 2, 'string'],
        ['mimeType', 7, 'string'],
        ['data', 8, 'bytes'],
    ]),
    UserMessageAction: fields([['userMessage', 1, 'UserMessage']]),
    ResumeAction: fields([]),
    ConversationAction: fields([
        ['userMessageAction', 1, 'UserMessageAction'],
        ['resumeAction', 2, 'ResumeAction'],
    ]),
    ThinkingDetails: fields([]),
    ModelDetails: fields([
        ['modelId', 1, 'string'],
        ['thinkingDetails', 2, 'ThinkingDetails'],
        ['displayModelId', 3, 'string'],
        ['displayName', 4, 'string'],
        ['displayNameShort', 5, 'string'],
        ['aliases', 6, 'string', repeated],
        ['maxMode', 7, 'bool'],
    ]),
    RequestedModel: fields([
        ['modelId', 1, 'string'],
        ['maxMode', 2, 'bool'],
        ['parameters', 3, 'RequestedModelParameterValue', repeated],
    ]),
    RequestedModelParameterValue: fields([
        ['id', 1, 'string'],
        ['value', 2, 'string'],
    ]),
    McpToolDefinition: fields([
        ['name', 1, 'string'],
        ['description', 2, 'string'],
        ['inputSchema', 3, 'bytes'],
        ['providerIdentifier', 4, 'string'],
        ['toolName', 5, 'string'],
        ['inputSchemaJson', 6, 'string'],
    ]),
    McpTools: fields([['mcpTools', 1, 'McpToolDefinition', repeated]]),
    AgentRunRequest: fields([
        ['conversationState', 1, 'raw'],
        ['action', 2, 'ConversationAction'],
        ['modelDetails', 3, 'ModelDetails'],
        ['mcpTools', 4, 'McpTools'],
        ['conversationId', 5, 'string'],
        ['customSystemPrompt', 8, 'string'],
        ['requestedModel', 9, 'RequestedModel'],
    ]),
    ClientHeartbeat: fields([]),
    AgentClientMessage: fields([
        ['runRequest', 1, 'AgentRunRequest'],
        ['execClientMessage', 2, 'ExecClientMessage'],
        ['kvClientMessage', 3, 'KvClientMessage'],
        ['execClientControlMessage', 5, 'ExecClientControlMessage'],
        ['clientHeartbeat', 7, 'ClientHeartbeat'],
    ]),
    TextDeltaUpdate: fields([['text', 1, 'string']]),
    ToolCall: fields([['mcpToolCall', 15, 'McpToolCall']]),
    McpToolCall: fields([
        ['args', 1, 'McpArgs'],
        ['result', 2, 'McpResult'],
        ['description', 3, 'string'],
    ]),
    ToolCallStartedUpdate: fields([
        ['callId', 1, 'string'],
        ['toolCall', 2, 'ToolCall'],
        ['modelCallId', 3, 'string'],
    ]),
    ToolCallCompletedUpdate: fields([
        ['callId', 1, 'string'],
        ['toolCall', 2, 'ToolCall'],
        ['modelCallId', 3, 'string'],
    ]),
    ToolCallDeltaUpdate: fields([
        ['callId', 1, 'string'],
        ['toolCallDelta', 2, 'raw'],
        ['modelCallId', 3, 'string'],
    ]),
    PartialToolCallUpdate: fields([
        ['callId', 1, 'string'],
        ['toolCall', 2, 'ToolCall'],
        ['argsTextDelta', 3, 'string'],
        ['modelCallId', 4, 'string'],
    ]),
    ThinkingDeltaUpdate: fields([['text', 1, 'string']]),
    TokenDeltaUpdate: fields([['tokens', 1, 'int']]),
    TurnEndedUpdate: fields([]),
    InteractionUpdate: fields([
        ['textDelta', 1, 'TextDeltaUpdate'],
        ['toolCallStarted', 2, 'ToolCallStartedUpdate'],
        ['toolCallCompleted', 3, 'ToolCallCompletedUpdate'],
        ['thinkingDelta', 4, 'ThinkingDeltaUpdate'],
        ['partialToolCall', 7, 'PartialToolCallUpdate'],
        ['tokenDelta', 8, 'TokenDeltaUpdate'],
        ['turnEnded', 14, 'TurnEndedUpdate'],
        ['toolCallDelta', 15, 'ToolCallDeltaUpdate'],
    ]),
    AgentServerMessage: fields([
        ['interactionUpdate', 1, 'InteractionUpdate'],
        ['execServerMessage', 2, 'ExecServerMessage'],
        ['conversationCheckpointUpdate', 3, 'raw'],
        ['kvServerMessage', 4, 'KvServerMessage'],
    ]),
    GetUsableModelsResponse: fields([['models', 1, 'ModelDetails', repeated]]),
    AvailableModelsRequest: fields([
        ['includeLongContextModels', 2, 'bool'],
        ['useModelParameters', 5, 'bool'],
        ['includeHiddenModels', 6, 'bool'],
        ['doNotUseMarkdown', 7, 'bool'],
        ['variantsWillBeShownInExplodedList', 8, 'bool'],
    ]),
    AvailableModelsResponse: fields([
        ['models', 2, 'AvailableModel', repeated],
        ['useModelParameters', 11, 'bool'],
    ]),
    AvailableModel: fields([
        ['name', 1, 'string'],
        ['defaultOn', 2, 'bool'],
        ['supportsAgent', 5, 'bool'],
        ['tooltipData', 8, 'AvailableModelTooltip'],
        ['supportsThinking', 9, 'bool'],
        ['supportsImages', 10, 'bool'],
        ['autoContextMaxTokens', 12, 'int'],
        ['autoContextExtendedMaxTokens', 13, 'int'],
        ['contextTokenLimit', 15, 'int'],
        ['clientDisplayName', 17, 'string'],
        ['serverModelName', 18, 'string'],
        ['inputboxShortModelName', 24, 'string'],
        ['parameterDefinitions', 29, 'ModelParameterDefinition', repeated],
        ['variants', 30, 'ModelVariantConfig', repeated],
        ['isHidden', 35, 'bool'],
        ['legacySlugs', 36, 'string', repeated],
        ['idAliases', 37, 'string', repeated],
        ['tagline', 39, 'string'],
        ['vendorName', 41, 'string'],
    ]),
    AvailableModelTooltip: fields([
        ['primaryText', 1, 'string'],
        ['secondaryText', 2, 'string'],
        ['markdownContent', 7, 'string'],
    ]),
    ModelParameterDefinition: fields([
        ['id', 1, 'string'],
        ['name', 2, 'string'],
        ['markdownTooltip', 3, 'string'],
        ['parameterType', 4, 'ModelParameterType'],
    ]),
    ModelParameterType: fields([
        ['booleanParameter', 1, 'BooleanParameterDefinition'],
        ['enumParameter', 2, 'EnumParameterDefinition'],
    ]),
    BooleanParameterDefinition: fields([
        ['values', 1, 'BooleanParameterValue', repeated],
    ]),
    BooleanParameterValue: fields([
        ['value', 1, 'string'],
        ['displayName', 2, 'string'],
        ['blockedByAdminAllowlist', 6, 'bool'],
    ]),
    EnumParameterDefinition: fields([
        ['values', 1, 'EnumParameterValue', repeated],
    ]),
    EnumParameterValue: fields([
        ['value', 1, 'string'],
        ['displayName', 2, 'string'],
        ['blockedByAdminAllowlist', 4, 'bool'],
        ['markdownTooltip', 5, 'string'],
    ]),
    ModelVariantConfig: fields([
        ['parameterValues', 1, 'RequestedModelParameterValue', repeated],
        ['displayName', 2, 'string'],
        ['isMaxMode', 3, 'bool'],
        ['isDefaultMaxConfig', 4, 'bool'],
        ['isDefaultNonMaxConfig', 5, 'bool'],
        ['displayNameOutsidePicker', 8, 'string'],
        ['variantStringRepresentation', 9, 'string'],
        ['legacySlug', 11, 'string'],
    ]),
    CursorPlanUsage: fields([
        ['totalSpend', 1, 'int'],
        ['includedSpend', 2, 'int'],
        ['bonusSpend', 3, 'int'],
        ['remaining', 4, 'int'],
        ['limit', 5, 'int'],
        ['bonusTooltip', 7, 'string'],
        ['autoSpend', 8, 'int'],
        ['apiSpend', 9, 'int'],
        ['autoLimit', 10, 'int'],
        ['apiLimit', 11, 'int'],
        ['autoPercentUsed', 12, 'double'],
        ['apiPercentUsed', 13, 'double'],
        ['totalPercentUsed', 14, 'double'],
    ]),
    CursorSpendLimitUsage: fields([
        ['totalSpend', 1, 'int'],
        ['pooledLimit', 2, 'int'],
        ['pooledUsed', 3, 'int'],
        ['pooledRemaining', 4, 'int'],
        ['individualLimit', 5, 'int'],
        ['individualUsed', 6, 'int'],
        ['individualRemaining', 7, 'int'],
        ['limitType', 8, 'string'],
        ['overallLimit', 9, 'int'],
        ['overallUsed', 10, 'int'],
        ['overallRemaining', 11, 'int'],
    ]),
    CursorCurrentPeriodUsage: fields([
        ['billingCycleStart', 1, 'int'],
        ['billingCycleEnd', 2, 'int'],
        ['planUsage', 3, 'CursorPlanUsage'],
        ['spendLimitUsage', 4, 'CursorSpendLimitUsage'],
        ['displayThreshold', 5, 'int'],
        ['enabled', 6, 'bool'],
        ['displayMessage', 7, 'string'],
        ['autoModelSelectedDisplayMessage', 11, 'string'],
        ['namedModelSelectedDisplayMessage', 12, 'string'],
        ['autoBucketModels', 13, 'string', repeated],
    ]),
    CursorPlanInfo: fields([
        ['planName', 1, 'string'],
        ['includedAmountCents', 2, 'int'],
        ['price', 3, 'string'],
        ['billingCycleEnd', 4, 'int'],
        ['planOwner', 5, 'int'],
    ]),
    CursorPlanInfoResponse: fields([['planInfo', 1, 'CursorPlanInfo']]),

    ShellArgs: fields([
        ['command', 1, 'string'],
        ['workingDirectory', 2, 'string'],
        ['timeout', 3, 'int'],
        ['toolCallId', 4, 'string'],
    ]),
    WriteArgs: fields([
        ['path', 1, 'string'],
        ['fileText', 2, 'string'],
        ['toolCallId', 3, 'string'],
        ['fileBytes', 5, 'bytes'],
    ]),
    DeleteArgs: fields([
        ['path', 1, 'string'],
        ['toolCallId', 2, 'string'],
    ]),
    GrepArgs: fields([
        ['pattern', 1, 'string'],
        ['path', 2, 'string'],
        ['glob', 3, 'string'],
        ['outputMode', 4, 'string'],
        ['headLimit', 10, 'int'],
        ['multiline', 11, 'bool'],
        ['toolCallId', 14, 'string'],
    ]),
    ReadArgs: fields([
        ['path', 1, 'string'],
        ['toolCallId', 2, 'string'],
        ['offset', 4, 'int'],
        ['limit', 5, 'uint'],
    ]),
    LsArgs: fields([
        ['path', 1, 'string'],
        ['toolCallId', 3, 'string'],
    ]),
    DiagnosticsArgs: fields([
        ['path', 1, 'string'],
        ['toolCallId', 2, 'string'],
    ]),
    RequestContextArgs: fields([]),
    McpArgs: fields([
        ['name', 1, 'string'],
        ['args', 2, map('string', 'bytes')],
        ['toolCallId', 3, 'string'],
        ['providerIdentifier', 4, 'string'],
        ['toolName', 5, 'string'],
    ]),
    BackgroundShellSpawnArgs: fields([
        ['command', 1, 'string'],
        ['workingDirectory', 2, 'string'],
        ['toolCallId', 3, 'string'],
    ]),
    FetchArgs: fields([
        ['url', 1, 'string'],
        ['toolCallId', 2, 'string'],
    ]),
    WriteShellStdinArgs: fields([
        ['shellId', 1, 'uint'],
        ['chars', 2, 'string'],
    ]),
    ExecServerMessage: fields([
        ['id', 1, 'uint'],
        ['shellArgs', 2, 'ShellArgs'],
        ['writeArgs', 3, 'WriteArgs'],
        ['deleteArgs', 4, 'DeleteArgs'],
        ['grepArgs', 5, 'GrepArgs'],
        ['readArgs', 7, 'ReadArgs'],
        ['lsArgs', 8, 'LsArgs'],
        ['diagnosticsArgs', 9, 'DiagnosticsArgs'],
        ['requestContextArgs', 10, 'RequestContextArgs'],
        ['mcpArgs', 11, 'McpArgs'],
        ['shellStreamArgs', 14, 'ShellArgs'],
        ['execId', 15, 'string'],
        ['backgroundShellSpawnArgs', 16, 'BackgroundShellSpawnArgs'],
        ['fetchArgs', 20, 'FetchArgs'],
        ['writeShellStdinArgs', 23, 'WriteShellStdinArgs'],
    ]),

    RequestContext: fields([
        ['tools', 7, 'McpToolDefinition', repeated],
        ['cloudRule', 16, 'string'],
        ['fileContents', 20, map('string', 'string')],
    ]),
    RequestContextSuccess: fields([['requestContext', 1, 'RequestContext']]),
    RequestContextResult: fields([['success', 1, 'RequestContextSuccess']]),
    McpTextContent: fields([['text', 1, 'string']]),
    McpImageContent: fields([
        ['data', 1, 'bytes'],
        ['mimeType', 2, 'string'],
    ]),
    McpToolResultContentItem: fields([
        ['text', 1, 'McpTextContent'],
        ['image', 2, 'McpImageContent'],
    ]),
    McpSuccess: fields([
        ['content', 1, 'McpToolResultContentItem', repeated],
        ['isError', 2, 'bool'],
    ]),
    McpError: fields([['error', 1, 'string']]),
    McpResult: fields([
        ['success', 1, 'McpSuccess'],
        ['error', 2, 'McpError'],
    ]),
    ReadSuccess: fields([
        ['path', 1, 'string'],
        ['content', 2, 'string'],
        ['totalLines', 3, 'int'],
        ['fileSize', 4, 'int'],
        ['truncated', 6, 'bool'],
    ]),
    ReadRejected: fields([
        ['path', 1, 'string'],
        ['reason', 2, 'string'],
    ]),
    ReadResult: fields([
        ['success', 1, 'ReadSuccess'],
        ['rejected', 3, 'ReadRejected'],
    ]),
    WriteSuccess: fields([
        ['path', 1, 'string'],
        ['linesCreated', 2, 'int'],
        ['fileSize', 3, 'int'],
    ]),
    WriteRejected: fields([
        ['path', 1, 'string'],
        ['reason', 2, 'string'],
    ]),
    WriteResult: fields([
        ['success', 1, 'WriteSuccess'],
        ['rejected', 6, 'WriteRejected'],
    ]),
    DeleteRejected: fields([
        ['path', 1, 'string'],
        ['reason', 2, 'string'],
    ]),
    DeleteResult: fields([['rejected', 6, 'DeleteRejected']]),
    FetchSuccess: fields([
        ['url', 1, 'string'],
        ['content', 2, 'string'],
        ['statusCode', 3, 'int'],
        ['contentType', 4, 'string'],
    ]),
    FetchError: fields([
        ['url', 1, 'string'],
        ['error', 2, 'string'],
    ]),
    FetchResult: fields([
        ['success', 1, 'FetchSuccess'],
        ['error', 2, 'FetchError'],
    ]),
    ShellSuccess: fields([
        ['command', 1, 'string'],
        ['workingDirectory', 2, 'string'],
        ['exitCode', 3, 'int'],
        ['signal', 4, 'string'],
        ['stdout', 5, 'string'],
        ['stderr', 6, 'string'],
    ]),
    ShellRejected: fields([
        ['command', 1, 'string'],
        ['workingDirectory', 2, 'string'],
        ['reason', 3, 'string'],
        ['isReadonly', 4, 'bool'],
    ]),
    ShellResult: fields([
        ['success', 1, 'ShellSuccess'],
        ['rejected', 4, 'ShellRejected'],
    ]),
    ShellStreamStdout: fields([['data', 1, 'string']]),
    ShellStreamExit: fields([['code', 1, 'uint']]),
    ShellStreamStart: fields([]),
    ShellStream: fields([
        ['stdout', 1, 'ShellStreamStdout'],
        ['exit', 3, 'ShellStreamExit'],
        ['start', 4, 'ShellStreamStart'],
    ]),
    LsDirectoryTreeNodeFile: fields([['name', 1, 'string']]),
    LsDirectoryTreeNode: fields([
        ['absPath', 1, 'string'],
        ['childrenDirs', 2, 'LsDirectoryTreeNode', repeated],
        ['childrenFiles', 3, 'LsDirectoryTreeNodeFile', repeated],
        ['childrenWereProcessed', 4, 'bool'],
        ['fullSubtreeExtensionCounts', 5, map('string', 'int')],
        ['numFiles', 6, 'int'],
    ]),
    LsSuccess: fields([['directoryTreeRoot', 1, 'LsDirectoryTreeNode']]),
    LsRejected: fields([
        ['path', 1, 'string'],
        ['reason', 2, 'string'],
    ]),
    LsResult: fields([
        ['success', 1, 'LsSuccess'],
        ['rejected', 3, 'LsRejected'],
    ]),
    GrepFileCount: fields([
        ['file', 1, 'string'],
        ['count', 2, 'int'],
    ]),
    GrepCountResult: fields([
        ['counts', 1, 'GrepFileCount', repeated],
        ['totalFiles', 2, 'int'],
        ['totalMatches', 3, 'int'],
        ['clientTruncated', 4, 'bool'],
        ['ripgrepTruncated', 5, 'bool'],
    ]),
    GrepFilesResult: fields([
        ['files', 1, 'string', repeated],
        ['totalFiles', 2, 'int'],
        ['clientTruncated', 3, 'bool'],
        ['ripgrepTruncated', 4, 'bool'],
    ]),
    GrepContentMatch: fields([
        ['lineNumber', 1, 'int'],
        ['content', 2, 'string'],
        ['contentTruncated', 3, 'bool'],
        ['isContextLine', 4, 'bool'],
    ]),
    GrepFileMatch: fields([
        ['file', 1, 'string'],
        ['matches', 2, 'GrepContentMatch', repeated],
    ]),
    GrepContentResult: fields([
        ['matches', 1, 'GrepFileMatch', repeated],
        ['totalLines', 2, 'int'],
        ['totalMatchedLines', 3, 'int'],
        ['clientTruncated', 4, 'bool'],
        ['ripgrepTruncated', 5, 'bool'],
    ]),
    GrepUnionResult: fields([
        ['count', 1, 'GrepCountResult'],
        ['files', 2, 'GrepFilesResult'],
        ['content', 3, 'GrepContentResult'],
    ]),
    GrepSuccess: fields([
        ['pattern', 1, 'string'],
        ['path', 2, 'string'],
        ['outputMode', 3, 'string'],
        ['workspaceResults', 4, map('string', 'GrepUnionResult')],
    ]),
    GrepError: fields([['error', 1, 'string']]),
    GrepResult: fields([
        ['success', 1, 'GrepSuccess'],
        ['error', 2, 'GrepError'],
    ]),
    DiagnosticsResult: fields([]),
    BackgroundShellSpawnResult: fields([['rejected', 3, 'ShellRejected']]),
    WriteShellStdinError: fields([['error', 1, 'string']]),
    WriteShellStdinResult: fields([['error', 2, 'WriteShellStdinError']]),
    ExecClientMessage: fields([
        ['id', 1, 'uint'],
        ['shellResult', 2, 'ShellResult'],
        ['writeResult', 3, 'WriteResult'],
        ['deleteResult', 4, 'DeleteResult'],
        ['grepResult', 5, 'GrepResult'],
        ['readResult', 7, 'ReadResult'],
        ['lsResult', 8, 'LsResult'],
        ['diagnosticsResult', 9, 'DiagnosticsResult'],
        ['requestContextResult', 10, 'RequestContextResult'],
        ['mcpResult', 11, 'McpResult'],
        ['shellStream', 14, 'ShellStream'],
        ['execId', 15, 'string'],
        ['backgroundShellSpawnResult', 16, 'BackgroundShellSpawnResult'],
        ['fetchResult', 20, 'FetchResult'],
        ['writeShellStdinResult', 23, 'WriteShellStdinResult'],
    ]),
    ExecClientStreamClose: fields([['id', 1, 'uint']]),
    ExecClientControlMessage: fields([['streamClose', 1, 'ExecClientStreamClose']]),
    GetBlobArgs: fields([['blobId', 1, 'bytes']]),
    SetBlobArgs: fields([
        ['blobId', 1, 'bytes'],
        ['blobData', 2, 'bytes'],
    ]),
    GetBlobResult: fields([['blobData', 1, 'bytes']]),
    SetBlobResult: fields([]),
    KvServerMessage: fields([
        ['id', 1, 'uint'],
        ['getBlobArgs', 2, 'GetBlobArgs'],
        ['setBlobArgs', 3, 'SetBlobArgs'],
    ]),
    KvClientMessage: fields([
        ['id', 1, 'uint'],
        ['getBlobResult', 2, 'GetBlobResult'],
        ['setBlobResult', 3, 'SetBlobResult'],
    ]),
    JsonValue: fields([
        ['nullValue', 1, 'int'],
        ['numberValue', 2, 'double'],
        ['stringValue', 3, 'string'],
        ['boolValue', 4, 'bool'],
        ['structValue', 5, 'JsonStruct'],
        ['listValue', 6, 'JsonList'],
    ]),
    JsonStruct: fields([['fields', 1, map('string', 'JsonValue')]]),
    JsonList: fields([['values', 1, 'JsonValue', repeated]]),
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function encodeVarint(value) {
    let current = BigInt(value ?? 0);
    if (current < 0) current = BigInt.asUintN(64, current);
    const bytes = [];
    do {
        let byte = Number(current & 0x7fn);
        current >>= 7n;
        if (current) byte |= 0x80;
        bytes.push(byte);
    } while (current);
    return Uint8Array.from(bytes);
}

function encodeTag(no, wireType) {
    return encodeVarint((BigInt(no) << 3n) | BigInt(wireType));
}

function isMessageType(type) {
    return Object.hasOwn(SCHEMAS, type);
}

function wireTypeFor(type) {
    if (type === 'double') return 1;
    if (['string', 'bytes', 'raw'].includes(type) || isMessageType(type)) return 2;
    return 0;
}

function scalarBytes(type, value) {
    if (type === 'string') return textEncoder.encode(String(value));
    if (type === 'bytes' || type === 'raw') return value instanceof Uint8Array ? value : new Uint8Array(value);
    if (type === 'double') {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, Number(value), true);
        return new Uint8Array(buffer);
    }
    if (type === 'bool') return encodeVarint(value ? 1 : 0);
    if (type === 'int' || type === 'uint') return encodeVarint(value);
    if (isMessageType(type)) return encodeMessage(type, value);
    throw new Error(`Unknown Cursor protobuf type: ${type}`);
}

function shouldWrite(type, value) {
    if (value == null) return false;
    if (isMessageType(type) || type === 'raw' || type === 'bytes') return true;
    if (type === 'string') return value !== '';
    // Explicit scalar defaults still carry presence inside protobuf oneofs.
    // In particular, google.protobuf.Value encodes false, 0, and null as
    // selected alternatives rather than as an empty (invalid) Value message.
    return true;
}

function encodeField(no, type, value) {
    const wireType = wireTypeFor(type);
    const payload = scalarBytes(type, value);
    if (wireType === 2) return concatBytes([encodeTag(no, wireType), encodeVarint(payload.length), payload]);
    return concatBytes([encodeTag(no, wireType), payload]);
}

function encodeMapField(no, [keyType, valueType], value) {
    const parts = [];
    for (const [key, entryValue] of Object.entries(value || {})) {
        const entry = concatBytes([
            encodeField(1, keyType, key),
            encodeField(2, valueType, entryValue),
        ]);
        parts.push(concatBytes([encodeTag(no, 2), encodeVarint(entry.length), entry]));
    }
    return parts;
}

function encodeMessage(type, value = {}) {
    const schema = SCHEMAS[type];
    if (!schema) throw new Error(`Unknown Cursor protobuf message: ${type}`);
    const parts = [];
    for (const descriptor of Object.values(schema)) {
        const fieldValue = value[descriptor.name];
        if (descriptor.type?.map) {
            parts.push(...encodeMapField(descriptor.no, descriptor.type.map, fieldValue));
            continue;
        }
        const values = descriptor.repeated ? (Array.isArray(fieldValue) ? fieldValue : []) : [fieldValue];
        for (const item of values) {
            if (shouldWrite(descriptor.type, item)) parts.push(encodeField(descriptor.no, descriptor.type, item));
        }
    }
    return concatBytes(parts);
}

class ProtoReader {
    constructor(bytes) {
        this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.offset = 0;
    }

    get done() {
        return this.offset >= this.bytes.length;
    }

    varint() {
        let value = 0n;
        let shift = 0n;
        while (!this.done) {
            const byte = this.bytes[this.offset++];
            value |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) return value;
            shift += 7n;
            if (shift > 70n) throw new Error('Invalid Cursor protobuf varint');
        }
        throw new Error('Truncated Cursor protobuf varint');
    }

    bytesValue() {
        const length = Number(this.varint());
        const end = this.offset + length;
        if (end > this.bytes.length) throw new Error('Truncated Cursor protobuf field');
        const value = this.bytes.subarray(this.offset, end);
        this.offset = end;
        return value;
    }

    skip(wireType) {
        if (wireType === 0) {
            this.varint();
            return;
        }
        if (wireType === 1) {
            const end = this.offset + 8;
            if (end > this.bytes.length) throw new Error('Truncated Cursor protobuf field');
            this.offset = end;
            return;
        }
        if (wireType === 2) {
            const length = Number(this.varint());
            const end = this.offset + length;
            if (end > this.bytes.length) throw new Error('Truncated Cursor protobuf field');
            this.offset = end;
            return;
        }
        if (wireType === 5) {
            const end = this.offset + 4;
            if (end > this.bytes.length) throw new Error('Truncated Cursor protobuf field');
            this.offset = end;
            return;
        }
        throw new Error(`Unsupported Cursor protobuf wire type: ${wireType}`);
    }
}

function rewriteConversationState(checkpoint, rootPromptMessagesJson, turns = []) {
    const preserved = [];
    if (checkpoint?.length) {
        const reader = new ProtoReader(checkpoint);
        while (!reader.done) {
            const start = reader.offset;
            const tag = reader.varint();
            const no = Number(tag >> 3n);
            reader.skip(Number(tag & 7n));
            if (no !== 1 && no !== 8) preserved.push(checkpoint.subarray(start, reader.offset));
        }
    }
    const replacement = [
        ...rootPromptMessagesJson.map((value) => encodeField(1, 'bytes', value)),
        ...turns.map((value) => encodeField(8, 'bytes', value)),
    ];
    return concatBytes([...preserved, ...replacement]);
}

function decodeScalar(reader, type, wireType) {
    if (type === 'string') return textDecoder.decode(reader.bytesValue());
    if (type === 'bytes' || type === 'raw') return new Uint8Array(reader.bytesValue());
    if (type === 'double') {
        if (wireType !== 1) throw new Error('Invalid Cursor protobuf double');
        const value = new DataView(reader.bytes.buffer, reader.bytes.byteOffset + reader.offset, 8).getFloat64(0, true);
        reader.offset += 8;
        return value;
    }
    if (type === 'bool') return reader.varint() !== 0n;
    if (type === 'int') return Number(BigInt.asIntN(64, reader.varint()));
    if (type === 'uint') return Number(reader.varint());
    if (isMessageType(type)) return decodeMessage(type, reader.bytesValue());
    throw new Error(`Unknown Cursor protobuf type: ${type}`);
}

function decodeMapEntry(bytes, [keyType, valueType]) {
    const reader = new ProtoReader(bytes);
    let key = '';
    let value = valueType === 'string' ? '' : undefined;
    while (!reader.done) {
        const tag = reader.varint();
        const no = Number(tag >> 3n);
        const wireType = Number(tag & 7n);
        if (no === 1) key = decodeScalar(reader, keyType, wireType);
        else if (no === 2) value = decodeScalar(reader, valueType, wireType);
        else reader.skip(wireType);
    }
    return [String(key), value];
}

function decodeMessage(type, bytes) {
    const schema = SCHEMAS[type];
    if (!schema) throw new Error(`Unknown Cursor protobuf message: ${type}`);
    const reader = new ProtoReader(bytes);
    const output = {};
    while (!reader.done) {
        const tag = reader.varint();
        const no = Number(tag >> 3n);
        const wireType = Number(tag & 7n);
        const descriptor = schema[no];
        if (!descriptor) {
            reader.skip(wireType);
            continue;
        }
        if (descriptor.type?.map) {
            const [key, value] = decodeMapEntry(reader.bytesValue(), descriptor.type.map);
            output[descriptor.name] ||= {};
            output[descriptor.name][key] = value;
            continue;
        }
        const value = decodeScalar(reader, descriptor.type, wireType);
        if (descriptor.repeated) {
            output[descriptor.name] ||= [];
            output[descriptor.name].push(value);
        } else {
            output[descriptor.name] = value;
        }
    }
    return output;
}

function jsonToProtoValue(value) {
    if (value === null) return { nullValue: 0 };
    if (Array.isArray(value)) return { listValue: { values: value.map(jsonToProtoValue) } };
    if (typeof value === 'object') {
        return {
            structValue: {
                fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonToProtoValue(entry)])),
            },
        };
    }
    if (typeof value === 'boolean') return { boolValue: value };
    if (typeof value === 'number') return { numberValue: value };
    return { stringValue: String(value) };
}

function protoValueToJson(value) {
    if (Object.hasOwn(value, 'nullValue')) return null;
    if (Object.hasOwn(value, 'numberValue')) return value.numberValue;
    if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
    if (Object.hasOwn(value, 'boolValue')) return value.boolValue;
    if (value.structValue) {
        return Object.fromEntries(Object.entries(value.structValue.fields || {}).map(([key, entry]) => [key, protoValueToJson(entry)]));
    }
    if (value.listValue) return (value.listValue.values || []).map(protoValueToJson);
    return null;
}

function encodeJsonValue(value) {
    return encodeMessage('JsonValue', jsonToProtoValue(value));
}

function decodeJsonValue(bytes) {
    return protoValueToJson(decodeMessage('JsonValue', bytes));
}

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
    let timeout = setTimeout(() => close(new Error('Cursor connection timed out')), 30_000);

    const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => close(new Error('Cursor stream timed out')), 120_000);
    };
    const finish = (error = null) => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
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
    request.on('error', (error) => finish(error));
    session.on('error', (error) => finish(error));

    return {
        get alive() { return !closed; },
        write(bytes) {
            if (closed) return;
            resetTimeout();
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
    const frame = Buffer.alloc(5 + bytes.length);
    frame[0] = flags;
    frame.writeUInt32BE(bytes.length, 1);
    frame.set(bytes, 5);
    return frame;
}

function createFrameParser(onMessage, onEnd) {
    let pending = Buffer.alloc(0);
    const parse = (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
            const flags = pending[0];
            const length = pending.readUInt32BE(1);
            if (length > MAX_CONNECT_FRAME_BYTES) {
                throw cursorError(`Cursor frame exceeds ${MAX_CONNECT_FRAME_BYTES} bytes`, { code: 'protocol_error' });
            }
            if (pending.length < length + 5) return;
            const payload = pending.subarray(5, length + 5);
            pending = pending.subarray(length + 5);
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
        if (pending.length) {
            throw cursorError('Cursor stream ended with a truncated frame', { code: 'protocol_error' });
        }
    };
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
        const fn = tool.function || tool;
        const inputSchema = fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} };
        return {
            name: fn.name,
            description: fn.description || '',
            inputSchema: encodeJsonValue(inputSchema),
            inputSchemaJson: JSON.stringify(inputSchema),
            providerIdentifier: 'mixdog',
            toolName: fn.name,
        };
    }).filter((tool) => tool.name);
}

const conversations = new Map();
const activeRuns = new Map();
const MEMORY_TTL_MS = 30 * 60_000;

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
    conversation.blobs.set(Buffer.from(id).toString('hex'), data);
    return id;
}

function buildRunRequest({ model, modelParameters = [], systems, history, userText, userImages = [], tools, conversation }) {
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
                parameters: modelParameters,
            },
            mcpTools: { mcpTools: tools },
            conversationId: conversation.id,
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
        conversation.blobs.set(Buffer.from(blobId).toString('hex'), blobData);
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
            ...(args.workingDirectory ? { workdir: args.workingDirectory } : {}),
            ...(args.timeout ? { timeout_ms: args.timeout } : {}),
        }), 'shellResult'],
        ['shellStreamArgs', ['shell', 'bash'], (_tool, args) => ({
            command: args.command || '',
            ...(args.workingDirectory ? { workdir: args.workingDirectory } : {}),
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
            success: { requestContext: { tools, cloudRule, fileContents: {} } },
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
        throw new Error('Cursor requested an unsupported native tool');
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

function createStreamResponse({ bridge, heartbeat, conversation, tools, cloudRule, model, key }) {
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
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
                sawTurnEnded: false,
            };
            const send = (event) => {
                if (!state.closed) controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            const finish = (reason = 'stop') => {
                if (state.closed) return;
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
                state.closed = true;
                controller.error(error instanceof Error ? error : new Error(String(error)));
            };
            const processMessage = (bytes) => {
                const message = decodeMessage('AgentServerMessage', bytes);
                if (message.interactionUpdate) {
                    const update = message.interactionUpdate;
                    if (update.textDelta?.text) {
                        const delta = filter.process(update.textDelta.text);
                        if (delta.reasoning) send(completionChunk(id, model, { reasoning_content: delta.reasoning }));
                        if (delta.content) send(completionChunk(id, model, { content: delta.content }));
                    }
                    if (update.thinkingDelta?.text) {
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
                    if (update.turnEnded) state.sawTurnEnded = true;
                    state.outputTokens += update.tokenDelta?.tokens || 0;
                } else if (message.kvServerMessage) {
                    handleKvMessage(bridge, message.kvServerMessage, conversation);
                } else if (message.conversationCheckpointUpdate) {
                    conversation.checkpoint = message.conversationCheckpointUpdate;
                    try {
                        const checkpoint = decodeMessage('ConversationStateStructure', conversation.checkpoint);
                        state.totalTokens = checkpoint.tokenDetails?.usedTokens || state.totalTokens;
                    } catch {}
                } else if (message.execServerMessage) {
                    handleExecMessage(bridge, message.execServerMessage, tools, cloudRule, (pending) => {
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
                        activeRuns.set(key, { bridge, heartbeat, conversation, tools, cloudRule, pending: state.pending });
                        finish('tool_calls');
                    });
                }
            };
            const frameParser = createFrameParser(
                (bytes) => {
                    try { processMessage(bytes); } catch (error) { fail(error); bridge.close(error); }
                },
                (bytes) => {
                    state.sawEnd = true;
                    const error = parseEndStream(bytes);
                    if (error) {
                        fail(error);
                        bridge.close(error);
                    }
                    else if (state.pending.length === 0) {
                        if (!state.sawTurnEnded) {
                            const incomplete = cursorError('Cursor stream ended before turnEnded', {
                                code: 'incomplete_stream',
                            });
                            fail(incomplete);
                            bridge.close(incomplete);
                        } else {
                            finish();
                            bridge.close();
                        }
                    }
                },
            );
            bridge.onData((chunk) => {
                try { frameParser(chunk); } catch (error) { fail(error); bridge.close(error); }
            });
            bridge.onClose((error) => {
                clearInterval(heartbeat);
                if (activeRuns.get(key)?.bridge === bridge) activeRuns.delete(key);
                if (!state.closed) {
                    let closeError = error;
                    if (!closeError) {
                        try { frameParser.finish(); } catch (frameError) { closeError = frameError; }
                    }
                    if (!closeError && !state.sawEnd) {
                        closeError = cursorError('Cursor stream closed before its end frame', { code: 'protocol_error' });
                    }
                    if (closeError) fail(closeError);
                    else finish();
                }
            });
        },
        cancel(reason) {
            clearInterval(heartbeat);
            if (activeRuns.get(key)?.bridge === bridge) activeRuns.delete(key);
            bridge.close(reason instanceof Error ? reason : new Error('Cursor stream cancelled'));
        },
    });
    return new Response(stream, { headers: SSE_HEADERS });
}

function startRun(accessToken, requestBytes) {
    const bridge = openCursorStream({ accessToken });
    bridge.write(connectFrame(requestBytes));
    const heartbeat = setInterval(() => bridge.write(heartbeatFrame()), 5_000);
    heartbeat.unref?.();
    return { bridge, heartbeat };
}

function resumeRun(active, toolResults, userText, model, key) {
    const lastExecId = active.pending.at(-1)?.exec?.execId;
    for (const pending of active.pending) {
        const result = toolResults.find((entry) => entry.toolCallId === pending.toolCallId);
        const payload = result
            ? { ...result, content: String(result.content ?? '') }
            : { content: 'Tool result not provided', media: [], isError: true };
        if (userText && pending.exec.execId === lastExecId) {
            payload.content += `\n\n<user_message>\n${userText}\n</user_message>`;
        }
        sendToolResult(active.bridge, pending, payload, Boolean(result) && result.isError !== true);
    }
    active.pending = [];
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
    const sessionId = String(body.mixdog_session_id || '');
    const key = runKey(model, body.messages, sessionId);
    const active = activeRuns.get(key);
    if (active && parsed.toolResults.length && active.bridge.alive) {
        activeRuns.delete(key);
        return resumeRun(active, parsed.toolResults, parsed.userText, model, key);
    }
    if (active) {
        activeRuns.delete(key);
        clearInterval(active.heartbeat);
        active.bridge.close(new Error('Cursor run superseded'));
    }
    const convKey = conversationKey(body.messages, sessionId);
    const conversation = getConversation(convKey);
    const toolDefinitions = buildToolDefinitions(body.tools);
    const requestBytes = buildRunRequest({
        model,
        systems: parsed.systems,
        history: parsed.history,
        userText: parsed.userText,
        userImages: parsed.userImages,
        tools: toolDefinitions,
        conversation,
    });
    const { bridge, heartbeat } = startRun(accessToken, requestBytes);
    return createStreamResponse({
        bridge,
        heartbeat,
        conversation,
        tools: toolDefinitions.map((definition, index) => ({
            ...definition,
            inputSchemaObject: body.tools?.[index]?.function?.parameters || {},
        })),
        cloudRule: parsed.systems.join('\n\n') || undefined,
        model,
        key,
    });
}

const FALLBACK_MODELS = [
    { id: 'composer-1.5', name: 'Composer 1.5', reasoning: true, contextWindow: 200_000 },
    { id: 'claude-4.6-opus-high', name: 'Claude 4.6 Opus', reasoning: true, contextWindow: 200_000 },
    { id: 'claude-4.6-sonnet-medium', name: 'Claude 4.6 Sonnet', reasoning: true, contextWindow: 200_000 },
    { id: 'gpt-5.4-medium', name: 'GPT-5.4', reasoning: true, contextWindow: 272_000 },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', reasoning: true, contextWindow: 1_000_000 },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast 1', reasoning: false, contextWindow: 128_000 },
];
const AUTO_MODEL = { id: 'auto', name: 'Auto', reasoning: false, contextWindow: 200_000 };
let cachedModels = null;

function unwrapUnaryBody(body) {
    if (body.length < 5) return body;
    const length = body.readUInt32BE(1);
    if ((body[0] & 1) === 0 && (body[0] & END_STREAM_FLAG) === 0 && body.length >= length + 5) {
        return body.subarray(5, length + 5);
    }
    return body;
}

function normalizeModels(models) {
    const byId = new Map();
    for (const model of models || []) {
        const id = String(model.modelId || '').trim();
        if (!id) continue;
        const aliases = Array.isArray(model.aliases) ? model.aliases : [];
        byId.set(id, {
            id,
            name: model.displayName || model.displayNameShort || model.displayModelId || aliases[0] || id,
            reasoning: Boolean(model.thinkingDetails),
            contextWindow: 200_000,
        });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeParameterizedModels(models) {
    const byId = new Map();
    for (const model of models || []) {
        const id = String(model.name || model.serverModelName || '').trim();
        if (!id || model.isHidden === true) continue;
        const parameterDefinitions = (model.parameterDefinitions || []).map((definition) => {
            const booleanValues = definition.parameterType?.booleanParameter?.values || [];
            const enumValues = definition.parameterType?.enumParameter?.values || [];
            const values = [...booleanValues, ...enumValues]
                .filter((value) => value?.blockedByAdminAllowlist !== true && String(value?.value || '').trim())
                .map((value) => ({
                    value: String(value.value),
                    label: String(value.displayName
                        || (booleanValues.length
                            ? (String(value.value) === 'true' ? 'On' : String(value.value) === 'false' ? 'Off' : value.value)
                            : value.value)),
                    ...(value.markdownTooltip ? { description: value.markdownTooltip } : {}),
                }));
            return {
                id: String(definition.id || '').trim(),
                name: String(definition.name || definition.id || '').trim(),
                kind: booleanValues.length ? 'boolean' : 'enum',
                values,
                ...(definition.markdownTooltip ? { description: definition.markdownTooltip } : {}),
            };
        }).filter((definition) => definition.id && definition.values.length);
        const variants = (model.variants || []).map((variant) => ({
            parameters: Object.fromEntries((variant.parameterValues || [])
                .map((value) => [String(value.id || '').trim(), String(value.value ?? '')])
                .filter(([key]) => key)),
            displayName: String(variant.displayNameOutsidePicker || variant.displayName || '').trim(),
            default: variant.isDefaultNonMaxConfig === true,
            variantString: String(variant.variantStringRepresentation || '').trim(),
            legacySlug: String(variant.legacySlug || '').trim(),
        }));
        const tooltip = model.tooltipData || {};
        byId.set(id, {
            id,
            name: model.clientDisplayName || model.inputboxShortModelName || id,
            description: model.tagline || tooltip.markdownContent || tooltip.secondaryText || '',
            contextWindow: Number(model.contextTokenLimit || model.autoContextMaxTokens || 0) || undefined,
            supportsVision: model.supportsImages === true,
            supportsReasoning: parameterDefinitions.some((definition) => definition.id === 'effort' || definition.id === 'reasoning')
                || model.supportsThinking === true,
            parameterDefinitions,
            variants,
            aliases: [...new Set([
                ...(model.legacySlugs || []),
                ...(model.idAliases || []),
                ...variants.flatMap((variant) => variant.legacySlug ? [variant.legacySlug] : []),
            ].map((value) => String(value || '').trim()).filter(Boolean))],
        });
    }
    return [...byId.values()];
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

function centsToUsd(value) {
    const cents = Number(value);
    return Number.isFinite(cents) ? Math.round(cents) / 100 : 0;
}

function cursorUsagePercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return null;
    // Cursor's dashboard protobuf already reports percentage points:
    // 0.118 means 0.118%, and the official CLI rounds any positive value below
    // one up to 1% only at presentation time.
    const normalized = Math.max(0, Math.min(100, percent));
    return Math.round(normalized * 10_000) / 10_000;
}

function normalizeCursorUsage(usage = {}, planResponse = {}) {
    const plan = planResponse.planInfo || {};
    const included = usage.planUsage || {};
    const spendLimit = usage.spendLimitUsage || {};
    const resetAt = Number(usage.billingCycleEnd || plan.billingCycleEnd || 0) || null;
    const includedLimitCents = Number(included.limit || plan.includedAmountCents || 0);
    const includedUsedCents = Number(included.totalSpend || 0);
    const includedRemainingCents = Number(
        included.remaining ?? Math.max(0, includedLimitCents - includedUsedCents),
    );
    const hasIncludedBalance = includedLimitCents > 0 || includedUsedCents > 0 || includedRemainingCents > 0;
    const includedBalance = hasIncludedBalance ? {
        source: 'cursor-dashboard',
        remainingUsd: centsToUsd(includedRemainingCents),
        usedUsd: centsToUsd(includedUsedCents),
        limitUsd: centsToUsd(includedLimitCents),
    } : null;
    const quotaWindows = [];
    const progressWindows = [
        ['Basic', included.autoPercentUsed],
        ['API', included.apiPercentUsed],
    ].filter(([, value]) => Number.isFinite(Number(value)));
    if (progressWindows.length) {
        for (const [label, value] of progressWindows) {
            quotaWindows.push({
                label,
                source: 'cursor-dashboard',
                usedPct: cursorUsagePercent(value),
                ...(resetAt ? { resetAt } : {}),
            });
        }
    } else if (hasIncludedBalance) {
        quotaWindows.push({
            label: plan.planName ? `${plan.planName} included` : 'Included usage',
            source: 'cursor-dashboard',
            limitUsd: includedBalance.limitUsd,
            usedUsd: includedBalance.usedUsd,
            remainingUsd: includedBalance.remainingUsd,
            ...(resetAt ? { resetAt } : {}),
        });
    }
    const extraLimitCents = Number(
        spendLimit.overallLimit || spendLimit.individualLimit || spendLimit.pooledLimit || 0,
    );
    const extraUsedCents = Number(
        spendLimit.overallUsed || spendLimit.individualUsed || spendLimit.pooledUsed || spendLimit.totalSpend || 0,
    );
    const extraRemainingCents = Number(
        spendLimit.overallRemaining || spendLimit.individualRemaining || spendLimit.pooledRemaining || 0,
    );
    if (extraLimitCents > 0 || extraUsedCents > 0 || extraRemainingCents > 0) {
        quotaWindows.push({
            label: 'Usage-based spend',
            source: 'cursor-dashboard',
            limitUsd: centsToUsd(extraLimitCents),
            usedUsd: centsToUsd(extraUsedCents),
            remainingUsd: centsToUsd(extraRemainingCents),
            ...(resetAt ? { resetAt } : {}),
        });
    }
    return {
        source: 'cursor-dashboard',
        quotaWindows,
        ...(includedBalance ? { balance: includedBalance } : {}),
        plan: {
            name: plan.planName || '',
            price: plan.price || '',
            includedUsd: centsToUsd(plan.includedAmountCents || includedLimitCents),
            resetAt,
        },
        enabled: usage.enabled === true,
        detail: usage.displayMessage || '',
    };
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
    activeRunPendingCount: (key) => activeRuns.get(key)?.pending?.length || 0,
    normalizeCursorUsage,
    normalizeParameterizedModels,
});
