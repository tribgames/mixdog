// The shape of a capability call as the desktop's host checked it (ipc-validation.ts requiredDesktopCapabilityRequest), shared with
// the phone's protocol adapters, which answer the same calls without a host in between: the request's fields, its arguments'
// count and size, the per-capability rules, and the addressed session, in that order.
import { requiredString } from './scm-input';

export const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_STRUCTURED_STRING_TOTAL = 32_000_000;
const CAPABILITY_REQUEST_KEYS = new Set(['capability', 'args', 'sessionId']);

export function requireAllowedKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} contains an unsupported field.`);
  }
}

export const optionalPlainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function validateStructuredValue(value: unknown, state = { strings: 0, nodes: 0 }, depth = 0): void {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 12) throw new TypeError('structured input is too large.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('structured input contains an invalid number.');
    return;
  }
  if (typeof value === 'string') {
    state.strings += value.length;
    if (state.strings > MAX_STRUCTURED_STRING_TOTAL) throw new TypeError('structured input is too large.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 5_000) throw new TypeError('structured input contains too many entries.');
    for (const entry of value) validateStructuredValue(entry, state, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new TypeError('structured input is invalid.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 5_000) throw new TypeError('structured input contains too many fields.');
  for (const [key, entry] of entries) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new TypeError('structured input contains an invalid field.');
    }
    validateStructuredValue(entry, state, depth + 1);
  }
}

/** Arity of the turn and session review capabilities, merged into the IPC arity table. */
export const TURN_REVIEW_CAPABILITY_ARITY = {
  getSessionReviewDiff: [0, 0],
  getSessionReviewFilePatch: [1, 2],
  getTurnReviewDiff: [0, 1],
  getTurnReviewFilePatch: [1, 1],
  revertTurnReview: [0, 1],
  revertTurnReviewFile: [1, 2],
  getTurnChanges: [1, 1],
  revertTurnChanges: [3, 3],
  reapplyTurnChanges: [3, 3],
} as const;

export function validateTurnCapabilityArgs(capability: string, args: readonly unknown[]): void {
  // A /btw side question: one non-empty question text.
  if (capability === 'askSide') requiredString(args[0], 'side question', MAX_PROMPT_LENGTH);
  if (capability === 'getTurnReviewDiff' && args[0] !== undefined) {
    // The turn review bar asks for `{ refresh, known, summary, poll }`: whether
    // to re-read the worktree before diffing, the tag of the review it already
    // shows, whether a collapsed bar can go without the patch text, and
    // whether its interval timer (`poll: 'background'`) sent the read.
    // Anything else is not a review option.
    const options = optionalPlainRecord(args[0]);
    if (
      !options ||
      Object.entries(options).some(([key, option]) => {
        if (key === 'refresh' || key === 'summary') return typeof option !== 'boolean';
        if (key === 'poll') return option !== 'background';
        return key !== 'known' || typeof option !== 'string' || !/^[a-f0-9]{32}$/.test(option);
      })
    ) {
      throw new TypeError('turn review options are invalid.');
    }
  }
  if (capability === 'getSessionReviewFilePatch' || capability === 'getTurnReviewFilePatch') {
    // `[file, oldPath?]`: one listed file (and a rename's source) of a review.
    requiredString(args[0], 'file', 4_096);
    if (args[1] !== undefined) requiredString(args[1], 'oldPath', 4_096);
  }
  if (capability === 'getTurnChanges') {
    // `{ checkpointId, patch?, file? }`: one turn's recorded changes.
    const options = optionalPlainRecord(args[0]);
    if (!options) throw new TypeError('turn changes options are invalid.');
    requiredString(options.checkpointId, 'checkpointId', 512);
    for (const [key, option] of Object.entries(options)) {
      if (key === 'checkpointId') continue;
      if (key === 'patch' && typeof option === 'boolean') continue;
      if (key === 'file' && typeof option === 'string' && option.length <= 4_096) continue;
      throw new TypeError('turn changes options are invalid.');
    }
  }
  if (capability === 'revertTurnChanges' || capability === 'reapplyTurnChanges') {
    // `[checkpointId, file | null, revision]`.
    requiredString(args[0], 'checkpointId', 512);
    if (args[1] !== null) requiredString(args[1], 'file', 4_096);
    if (typeof args[2] !== 'number' || !Number.isSafeInteger(args[2]) || args[2] < 0) {
      throw new TypeError('revision must be a non-negative integer.');
    }
  }
}

export interface CapabilityRequestRules<C extends string> {
  /** Whether the name is a capability the caller serves. */
  known(name: string): name is C;
  arity(capability: C): readonly [number, number];
  /** The capability's own argument rules (the request is passed for a rule that compares an argument with its session). */
  validate(capability: C, args: unknown[], input: Record<string, unknown>): void;
  /** The addressed session's id, or a throw (desktop-state.ts requiredSessionId). */
  sessionId(value: unknown): string;
}

/** A capability call `{ capability, args?, sessionId? }`: its checks in the host's order, the session id last. */
export function requiredCapabilityRequest<C extends string>(
  value: unknown,
  rules: CapabilityRequestRules<C>
): { capability: C; args: unknown[]; sessionId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('capability request is invalid.');
  }
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, CAPABILITY_REQUEST_KEYS, 'capability request');
  if (typeof input.capability !== 'string' || !rules.known(input.capability)) {
    throw new TypeError('capability is unavailable.');
  }
  const capability = input.capability;
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args)) throw new TypeError('capability arguments must be an array.');
  const [minimum, maximum] = rules.arity(capability);
  if (args.length < minimum || args.length > maximum) {
    throw new TypeError(`capability ${capability} received an invalid number of arguments.`);
  }
  validateStructuredValue(args);
  rules.validate(capability, args, input);
  const sessionId =
    input.sessionId === undefined || input.sessionId === null || input.sessionId === ''
      ? undefined
      : rules.sessionId(input.sessionId);
  return { capability, args, ...(sessionId ? { sessionId } : {}) };
}
