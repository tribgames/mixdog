// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/runtime/agent/orchestrator/providers/custom-provider.mjs, recorded from apps/desktop/src/renderer/settings/custom-request-options.test.mjs of that commit run against an exact export of it (record/record.mjs).
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
