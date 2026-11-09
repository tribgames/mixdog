// Node b6f10295a src/runtime/agent/orchestrator/providers/custom-provider-config.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./custom-provider-section.test.0.recorded.json', import.meta.url), 'utf8'));
export const CUSTOM_API_KEY_ENV_RE = replay(table, "CUSTOM_API_KEY_ENV_RE");
export const CUSTOM_HEADER_LIMIT = replay(table, "CUSTOM_HEADER_LIMIT");
export const CUSTOM_MODEL_OVERRIDE_LIMIT = replay(table, "CUSTOM_MODEL_OVERRIDE_LIMIT");
export const CUSTOM_MODEL_REFUSED_HEADERS = replay(table, "CUSTOM_MODEL_REFUSED_HEADERS");
export const CUSTOM_PROTOCOL_WIRES = replay(table, "CUSTOM_PROTOCOL_WIRES");
export const CUSTOM_PROVIDER_AUTH_MODES = replay(table, "CUSTOM_PROVIDER_AUTH_MODES");
export const CUSTOM_PROVIDER_PROTOCOLS = replay(table, "CUSTOM_PROVIDER_PROTOCOLS");
export const CUSTOM_PROVIDER_SCHEMA_VERSION = replay(table, "CUSTOM_PROVIDER_SCHEMA_VERSION");
export const CUSTOM_PROVIDER_WIRES = replay(table, "CUSTOM_PROVIDER_WIRES");
export const CUSTOM_REASONING_LEVELS = replay(table, "CUSTOM_REASONING_LEVELS");
export const CUSTOM_REASONING_WIRE_FORMATS = replay(table, "CUSTOM_REASONING_WIRE_FORMATS");
export const CUSTOM_REQUEST_BODY_MAX_CHARS = replay(table, "CUSTOM_REQUEST_BODY_MAX_CHARS");
export const CUSTOM_RESERVED_BODY_KEYS = replay(table, "CUSTOM_RESERVED_BODY_KEYS");
export const applyCustomRequestBody = replay(table, "applyCustomRequestBody");
export const assertCustomReasoningPatch = replay(table, "assertCustomReasoningPatch");
export const canonicalReasoningLevel = replay(table, "canonicalReasoningLevel");
export const customRequestHeaders = replay(table, "customRequestHeaders");
export const effectiveCustomModelRows = replay(table, "effectiveCustomModelRows");
export const normalizeCustomProviderConfig = replay(table, "normalizeCustomProviderConfig");
export const resolveCustomRequestExtras = replay(table, "resolveCustomRequestExtras");
