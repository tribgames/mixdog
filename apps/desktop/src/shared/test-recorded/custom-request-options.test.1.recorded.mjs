// Node b6f10295a src/runtime/agent/orchestrator/providers/custom-provider.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./custom-request-options.test.1.recorded.json', import.meta.url), 'utf8'));
export const CUSTOM_PROVIDER_PROTOCOLS = replay(table, "CUSTOM_PROVIDER_PROTOCOLS");
export const CUSTOM_PROVIDER_SCHEMA_VERSION = replay(table, "CUSTOM_PROVIDER_SCHEMA_VERSION");
export const CUSTOM_REASONING_LEVELS = replay(table, "CUSTOM_REASONING_LEVELS");
export const assertCustomReasoningPatch = replay(table, "assertCustomReasoningPatch");
export const canonicalReasoningLevel = replay(table, "canonicalReasoningLevel");
export const createCustomProvider = replay(table, "createCustomProvider");
export const effectiveCustomModelRows = replay(table, "effectiveCustomModelRows");
export const normalizeCustomProviderConfig = replay(table, "normalizeCustomProviderConfig");
