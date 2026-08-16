function fields(entries) {
    return Object.fromEntries(entries.map(([name, no, type, options = {}]) => [
        no,
        { name, no, type, ...options },
    ]));
}

const map = (key, value) => ({ map: [key, value] });
const repeated = { repeated: true };

// Only the fields read or written by the provider are described here.
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
    McpInstructions: fields([
        ['serverName', 1, 'string'],
        ['instructions', 2, 'string'],
    ]),
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
    StepCompletedUpdate: fields([]),
    InteractionUpdate: fields([
        ['textDelta', 1, 'TextDeltaUpdate'],
        ['toolCallStarted', 2, 'ToolCallStartedUpdate'],
        ['toolCallCompleted', 3, 'ToolCallCompletedUpdate'],
        ['thinkingDelta', 4, 'ThinkingDeltaUpdate'],
        ['partialToolCall', 7, 'PartialToolCallUpdate'],
        ['tokenDelta', 8, 'TokenDeltaUpdate'],
        ['turnEnded', 14, 'TurnEndedUpdate'],
        ['toolCallDelta', 15, 'ToolCallDeltaUpdate'],
        ['stepCompleted', 17, 'StepCompletedUpdate'],
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
    BooleanParameterDefinition: fields([['values', 1, 'BooleanParameterValue', repeated]]),
    BooleanParameterValue: fields([
        ['value', 1, 'string'],
        ['displayName', 2, 'string'],
        ['blockedByAdminAllowlist', 6, 'bool'],
    ]),
    EnumParameterDefinition: fields([['values', 1, 'EnumParameterValue', repeated]]),
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
        ['mcpInstructions', 14, 'McpInstructions', repeated],
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

export function encodeMessage(type, value = {}) {
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

export function rewriteConversationState(checkpoint, rootPromptMessagesJson, turns = []) {
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

export function decodeMessage(type, bytes) {
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

export function encodeJsonValue(value) {
    return encodeMessage('JsonValue', jsonToProtoValue(value));
}

export function decodeJsonValue(bytes) {
    return protoValueToJson(decodeMessage('JsonValue', bytes));
}
