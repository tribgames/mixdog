// Argument shapes of the conversation-import capabilities (contract-import.ts).
// Shape only: paths, ids and sources are resolved and checked by the runtime.
import { DESKTOP_IMPORT_CAPABILITIES, type DesktopImportCapability } from '../shared/contract-import';

/** Arity per capability, merged into the IPC arity table: one object argument each. */
export const IMPORT_CAPABILITY_ARITY = {
  listImportableConversations: [1, 1],
  getConversationImportJobs: [0, 1],
  registerConversationImportFile: [1, 1],
  startConversationImport: [1, 1],
  cancelConversationImport: [1, 1],
} as const satisfies Record<DesktopImportCapability, readonly [number, number]>;

const IMPORT_CAPABILITY_SET = new Set<string>(DESKTOP_IMPORT_CAPABILITIES);
const MAX_TEXT = 4096;
const MAX_IDS = 100_000;

export function isImportCapability(capability: string): capability is DesktopImportCapability {
  return IMPORT_CAPABILITY_SET.has(capability);
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function allowKeys(input: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} contains an unsupported field.`);
  }
}

function text(value: unknown, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function source(value: unknown, name: string): void {
  if (value !== 'codex' && value !== 'claude' && value !== 'devin') {
    throw new TypeError(`${name} must be codex, claude or devin.`);
  }
}

function optionalText(input: Record<string, unknown>, key: string, name: string): void {
  if (input[key] !== undefined) text(input[key], `${name}.${key}`);
}

function optionalTimestamp(input: Record<string, unknown>, key: string, name: string): void {
  const value = input[key];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name}.${key} must be an epoch millisecond number.`);
  }
}

function idList(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new TypeError(`${name} must be a list of ids.`);
  for (const id of value) text(id, `${name} entry`);
}

/** Throws TypeError when `args` (already arity-checked) do not fit `capability`. */
export function validateImportCapabilityArgs(capability: DesktopImportCapability, args: unknown[]): void {
  switch (capability) {
    case 'listImportableConversations': {
      const name = 'listImportableConversations input';
      const input = objectArg(args[0], name);
      allowKeys(input, ['source', 'query', 'project', 'modifiedAfter', 'modifiedBefore', 'cursor', 'limit'], name);
      source(input.source, `${name}.source`);
      if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > MAX_TEXT)) {
        throw new TypeError(`${name}.query must be a string.`);
      }
      optionalText(input, 'project', name);
      optionalText(input, 'cursor', name);
      optionalTimestamp(input, 'modifiedAfter', name);
      optionalTimestamp(input, 'modifiedBefore', name);
      if (
        input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)
      ) {
        throw new TypeError(`${name}.limit must be between 1 and 100.`);
      }
      return;
    }
    case 'getConversationImportJobs': {
      if (args[0] === undefined) return;
      const input = objectArg(args[0], 'getConversationImportJobs input');
      allowKeys(input, ['jobId'], 'getConversationImportJobs input');
      optionalText(input, 'jobId', 'getConversationImportJobs input');
      return;
    }
    case 'registerConversationImportFile': {
      const input = objectArg(args[0], 'registerConversationImportFile input');
      allowKeys(input, ['source', 'path'], 'registerConversationImportFile input');
      source(input.source, 'registerConversationImportFile input.source');
      text(input.path, 'registerConversationImportFile input.path');
      return;
    }
    case 'startConversationImport': {
      const input = objectArg(args[0], 'startConversationImport input');
      allowKeys(input, ['requestId', 'selection'], 'startConversationImport input');
      text(input.requestId, 'startConversationImport input.requestId');
      const selection = objectArg(input.selection, 'startConversationImport input.selection');
      if ('ids' in selection) {
        allowKeys(selection, ['ids'], 'startConversationImport selection');
        idList(selection.ids, 'startConversationImport selection.ids');
      } else {
        allowKeys(selection, ['viewId', 'excludeIds'], 'startConversationImport selection');
        text(selection.viewId, 'startConversationImport selection.viewId');
        idList(selection.excludeIds, 'startConversationImport selection.excludeIds');
      }
      return;
    }
    case 'cancelConversationImport': {
      const input = objectArg(args[0], 'cancelConversationImport input');
      allowKeys(input, ['jobId'], 'cancelConversationImport input');
      text(input.jobId, 'cancelConversationImport input.jobId');
      return;
    }
  }
}
