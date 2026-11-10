// Devin (Cascade API) protobuf messages.
//
// Object shape contract for callers:
//   - field names are the descriptor names below (lowerCamelCase);
//   - enums are plain numbers (see DEVIN_ENUMS);
//   - nested messages are plain objects, repeated fields are arrays;
//   - integer widths follow the descriptor type: int32/uint32/enum take and
//     decode to integer numbers (uint32 rejects negatives); int64/uint64 take
//     bigint, integer number or decimal string and decode to bigint (uint64
//     rejects negatives);
//   - every repeated element is written, empty strings and zeros included;
//   - a oneof is written as sibling fields of which exactly one is set
//     (ChatToolChoice.optionName | ChatToolChoice.toolName);
//   - decoded objects carry only fields present on the wire: absent fields are
//     undefined, so read them with a default (`msg.deltaText || ''`).
// Encoding is canonical proto3: implicit-presence fields holding their type
// default are omitted; `presence` fields are written whenever set.
// Only fields this client reads or writes are listed; everything else decodes
// into `$unknown` and is ignored.
import { createProtobufCodec, presence, protobufFields as fields, repeated } from './wire-protobuf-codec.mjs';

const packedEnumList = { repeated: true, enum: 'DisplayOption' };
const enumOf = (name) => ({ enum: name });

export const DEVIN_ENUMS = Object.freeze({
  ChatMessageSource: Object.freeze({ UNSPECIFIED: 0, USER: 1, SYSTEM: 2, UNKNOWN: 3, TOOL: 4, SYSTEM_PROMPT: 5 }),
  ChatMessageRequestType: Object.freeze({ UNSPECIFIED: 0, GENERAL: 1, CASCADE: 5 }),
  ConversationalPlannerMode: Object.freeze({ UNSPECIFIED: 0, DEFAULT: 1, READ_ONLY: 2, NO_TOOL: 3 }),
  CacheControlType: Object.freeze({ UNSPECIFIED: 0, EPHEMERAL: 1 }),
  StopReason: Object.freeze({
    UNSPECIFIED: 0,
    INCOMPLETE: 1,
    STOP_PATTERN: 2,
    MAX_TOKENS: 3,
    MIN_LOG_PROB: 4,
    MAX_NEWLINES: 5,
    EXIT_SCOPE: 6,
    NONFINITE_LOGIT_OR_PROB: 7,
    FIRST_NON_WHITESPACE_LINE: 8,
    PARTIAL: 9,
    FUNCTION_CALL: 10,
    CONTENT_FILTER: 11,
    NON_INSERTION: 12,
    ERROR: 13,
  }),
  // 6-8 are wire values newer than the published enum names.
  DisplayOption: Object.freeze({
    UNSPECIFIED: 0,
    ARENA: 1,
    BATTLE_GROUP_ONLY: 2,
    MODEL_ROUTER: 3,
    QUICK_REVIEW: 4,
    INTERNAL_DEFAULT: 6,
    UNCLASSIFIED: 7,
    NORMAL: 8,
  }),
  ModelDimensionKind: Object.freeze({ UNSPECIFIED: 0, COST: 1, COST_FUZZY: 2 }),
});

export const DEVIN_SCHEMAS = Object.freeze({
  Metadata: fields([
    ['ideName', 1, 'string'],
    ['extensionVersion', 2, 'string'],
    ['apiKey', 3, 'string'],
    ['locale', 4, 'string'],
    ['os', 5, 'string'],
    ['ideVersion', 7, 'string'],
    ['requestId', 9, 'uint64'],
    ['sessionId', 10, 'string'],
    ['extensionName', 12, 'string'],
    ['userAgent', 13, 'string'],
    ['userJwt', 21, 'string'],
    ['ideType', 28, 'string'],
    ['supportedModelDisplays', 30, 'enum', packedEnumList],
  ]),

  // exa.auth_pb.AuthService/GetUserJwt
  GetUserJwtRequest: fields([['metadata', 1, 'Metadata']]),
  GetUserJwtResponse: fields([
    ['userJwt', 1, 'string'],
    ['customApiServerUrl', 2, 'string'],
  ]),

  // exa.api_server_pb.ApiServerService/GetCliModelConfigs
  GetCliModelConfigsRequest: fields([['metadata', 1, 'Metadata']]),
  GetCliModelConfigsResponse: fields([
    ['clientModelConfigs', 1, 'ClientModelConfig', repeated],
    ['defaultOverrideModelConfig', 3, 'DefaultOverrideModelConfig'],
  ]),
  DefaultOverrideModelConfig: fields([
    ['versionId', 2, 'string'],
    ['modelUid', 3, 'string'],
  ]),
  ClientModelConfig: fields([
    ['label', 1, 'string'],
    ['creditMultiplier', 3, 'float'],
    ['disabled', 4, 'bool'],
    ['supportsImages', 5, 'bool'],
    ['isPremium', 7, 'bool'],
    ['isBeta', 9, 'bool'],
    ['isRecommended', 11, 'bool'],
    ['apiProvider', 14, 'enum', enumOf('APIProvider')],
    ['isNew', 15, 'bool'],
    ['maxTokens', 18, 'int32'],
    ['isCapacityLimited', 20, 'bool'],
    ['modelUid', 22, 'string'],
    ['modelInfo', 23, 'ModelInfo'],
    ['description', 27, 'string', presence],
    ['modelFamilyMetadata', 30, 'ModelFamilyMetadata'],
    ['isDefaultModelInFamily', 31, 'bool'],
    ['modelDimensions', 32, 'ModelDimension', repeated],
    ['disabledReason', 33, 'ModelDisabledReason'],
  ]),
  ModelInfo: fields([
    ['maxTokens', 4, 'int32'],
    ['modelFeatures', 6, 'ModelFeatures'],
    ['apiProvider', 7, 'enum', enumOf('APIProvider')],
    ['modelName', 8, 'string'],
    ['chatModelName', 12, 'string'],
    ['maxOutputTokens', 13, 'int32'],
    ['modelUid', 17, 'string'],
    ['harnessUids', 20, 'string', repeated],
    ['displayOption', 22, 'enum', enumOf('DisplayOption')],
    ['modelFamilyUid', 23, 'string'],
    ['isModelRouter', 25, 'bool'],
  ]),
  ModelFeatures: fields([
    ['supportsImages', 11, 'bool'],
    ['supportsToolCalls', 12, 'bool'],
    ['supportsThinking', 15, 'bool'],
    ['supportsParallelToolCalls', 21, 'bool'],
    ['interleaveThinking', 24, 'bool'],
    ['preserveThinking', 25, 'bool'],
  ]),
  ModelDimension: fields([
    ['label', 1, 'string'],
    ['value', 2, 'float'],
    ['denominator', 3, 'string'],
    ['kind', 6, 'enum', enumOf('ModelDimensionKind')],
    ['info', 7, 'string', presence],
  ]),
  ModelFamilyMetadata: fields([
    ['modelFamilyLabel', 1, 'string'],
    ['entries', 2, 'ModelFamilyMetadataEntry', repeated],
    ['isDefaultModelInFamily', 3, 'bool'],
  ]),
  ModelFamilyMetadataEntry: fields([
    ['key', 1, 'string'],
    ['value', 2, 'ModelFamilyMetadataValue'],
  ]),
  ModelFamilyMetadataValue: fields([
    ['order', 1, 'int32'],
    ['name', 2, 'string'],
  ]),
  ModelDisabledReason: fields([
    ['shortReason', 1, 'string'],
    ['description', 2, 'string', presence],
  ]),

  // exa.api_server_pb.ApiServerService/AssignModel: resolves a router uid into
  // a concrete chat uid plus the JWT the following chat request carries.
  AssignModelRequest: fields([
    ['metadata', 1, 'Metadata'],
    ['modelRouterUid', 2, 'string'],
    ['cascadeId', 3, 'string'],
    ['chatMessagePrompt', 5, 'ChatMessagePrompt'],
  ]),
  AssignModelResponse: fields([['assignment', 1, 'ModelAssignment']]),
  ModelAssignment: fields([
    ['assignmentJwt', 1, 'string'],
    ['modelUid', 2, 'string'],
    ['harnessUids', 3, 'string', repeated],
  ]),

  // exa.api_server_pb.ApiServerService/GetChatMessage (server-streaming)
  GetChatMessageRequest: fields([
    ['metadata', 1, 'Metadata'],
    ['prompt', 2, 'string'],
    ['chatMessagePrompts', 3, 'ChatMessagePrompt', repeated],
    ['requestType', 7, 'enum', enumOf('ChatMessageRequestType')],
    ['configuration', 8, 'CompletionConfiguration'],
    ['tools', 10, 'ChatToolDefinition', repeated],
    ['disableParallelToolCalls', 11, 'bool'],
    ['toolChoice', 12, 'ChatToolChoice'],
    ['systemPromptCacheOptions', 13, 'PromptCacheOptions'],
    ['chatModelName', 14, 'string'],
    ['cascadeId', 16, 'string'],
    ['promptId', 17, 'string'],
    ['plannerMode', 20, 'enum', enumOf('ConversationalPlannerMode')],
    ['chatModelUid', 21, 'string'],
    ['executionId', 22, 'string'],
    ['modelAssignmentJwt', 26, 'string', presence],
  ]),
  ChatMessagePrompt: fields([
    ['messageId', 1, 'string'],
    ['source', 2, 'enum', enumOf('ChatMessageSource')],
    ['prompt', 3, 'string'],
    ['numTokens', 4, 'uint32'],
    ['safeForCodeTelemetry', 5, 'bool'],
    ['toolCalls', 6, 'ChatToolCall', repeated],
    ['toolCallId', 7, 'string'],
    ['promptCacheOptions', 8, 'PromptCacheOptions'],
    ['toolResultIsError', 9, 'bool'],
    ['images', 10, 'ImageData', repeated],
    ['thinking', 11, 'string'],
    ['signature', 12, 'string'],
    ['thinkingRedacted', 13, 'bool'],
    ['outputId', 15, 'string'],
    ['thinkingId', 16, 'string'],
    ['geminiThoughtSignature', 17, 'bytes'],
    ['signatureType', 18, 'string'],
    ['phase', 19, 'string'],
  ]),
  ChatToolCall: fields([
    ['id', 1, 'string'],
    ['name', 2, 'string'],
    ['argumentsJson', 3, 'string'],
    ['invalidJsonStr', 4, 'string'],
    ['invalidJsonErr', 5, 'string'],
    ['isCustomToolCall', 6, 'bool'],
  ]),
  // oneof choice: set exactly one of optionName ('auto' | 'none' | 'required') or toolName.
  ChatToolChoice: fields([
    ['optionName', 1, 'string', presence],
    ['toolName', 2, 'string', presence],
  ]),
  ChatToolDefinition: fields([
    ['name', 1, 'string'],
    ['description', 2, 'string'],
    ['jsonSchemaString', 3, 'string'],
    ['serverName', 6, 'string'],
    ['readOnlyHint', 7, 'bool', presence],
    ['strict', 12, 'bool'],
  ]),
  ImageData: fields([
    ['base64Data', 1, 'string'],
    ['mimeType', 2, 'string'],
    ['caption', 3, 'string'],
  ]),
  PromptCacheOptions: fields([['type', 1, 'enum', enumOf('CacheControlType')]]),
  CompletionConfiguration: fields([
    ['numCompletions', 1, 'uint64'],
    ['maxTokens', 2, 'uint64'],
    ['maxNewlines', 3, 'uint64'],
    ['minLogProbability', 4, 'double'],
    ['temperature', 5, 'double'],
    ['firstTemperature', 6, 'double'],
    ['topK', 7, 'uint64'],
    ['topP', 8, 'double'],
    ['stopPatterns', 9, 'string', repeated],
    ['seed', 10, 'uint64'],
    ['serviceTier', 17, 'string'],
  ]),
  GetChatMessageResponse: fields([
    ['messageId', 1, 'string'],
    ['deltaText', 3, 'string'],
    ['deltaTokens', 4, 'uint32'],
    ['stopReason', 5, 'enum', enumOf('StopReason')],
    ['deltaToolCalls', 6, 'ChatToolCall', repeated],
    ['usage', 7, 'ModelUsageStats'],
    ['redact', 8, 'bool'],
    ['deltaThinking', 9, 'string'],
    ['deltaSignature', 10, 'string'],
    ['thinkingRedacted', 11, 'bool'],
    ['latency', 12, 'double'],
    ['creditCost', 14, 'int32'],
    ['outputId', 15, 'string'],
    ['thinkingId', 16, 'string'],
    ['requestId', 17, 'string'],
    ['committedCreditCost', 18, 'int32'],
    ['geminiThoughtSignature', 20, 'bytes'],
    ['deltaSignatureType', 21, 'string'],
    ['committedAcuCost', 22, 'double'],
    ['actualModelUid', 23, 'string', presence],
    ['phase', 25, 'string'],
    ['committedQuotaCostBasisPoints', 26, 'int64', presence],
    ['committedOverageCostCents', 27, 'int64', presence],
  ]),
  ModelUsageStats: fields([
    ['inputTokens', 2, 'uint64'],
    ['outputTokens', 3, 'uint64'],
    ['cacheWriteTokens', 4, 'uint64'],
    ['cacheReadTokens', 5, 'uint64'],
    ['apiProvider', 6, 'enum', enumOf('APIProvider')],
    ['messageId', 7, 'string'],
    ['modelUid', 9, 'string'],
    ['billingModelUid', 10, 'string'],
    ['requestedModelUid', 11, 'string'],
  ]),
});

const codec = createProtobufCodec(DEVIN_SCHEMAS, {
  label: 'Devin protobuf',
  strict: true,
  omitDefaults: true,
  packed: true,
});

export function encodeDevinMessage(typeName, object = {}) {
  return codec.encodeMessage(typeName, object);
}

export function decodeDevinMessage(typeName, bytes) {
  return codec.decodeMessage(typeName, bytes);
}
