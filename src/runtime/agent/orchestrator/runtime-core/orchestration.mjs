import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeOrchestrationMode } from '../../../shared/orchestration.mjs';
import { mixdogRoot, resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { decodeInstructionFile } from '../../../../lib/instruction-text.cjs';

/** Agent mode's fixed delegation block, in place of the orchestration mode. */
export const AGENT_MODE_DELEGATION = `# Delegation

Handle conversation yourself. Do quick lookups and small edits yourself. Hand
self-contained investigation, writing or implementation to sub-agents
(\`agent\`); their reports return to this chat. Open a new agent task session
(\`session create\`) only for a big plan, multi-step work across many files or
stages that needs its own Lead, with a self-contained brief: start it when
already requested, otherwise suggest it. Then relay the result in your own
words. Promise a follow-up only when the session result allows it.`;

/** An agent-mode Lead's contact catalog intro: the user's other bots. */
export const MIXY_CONTACTS_INTRO = `The user's other bots. Hand one a request with \`session send\` to its chat and a
self-contained brief.`;

const modeFileName = (mode) => `${normalizeOrchestrationMode(mode)}.md`;

/** The shipped mode file (<root>/orchestration/<mode>.md). */
export const shippedOrchestrationPath = (mode) => join(mixdogRoot(), 'orchestration', modeFileName(mode));
/** The user's replacement (<data>/orchestration/<mode>.md). */
export const userOrchestrationPath = (mode) => join(resolvePluginData(), 'orchestration', modeFileName(mode));

// A file's text (CRLF → LF, trailing whitespace trimmed), null when it does not
// exist, or { problem } when it cannot serve as the prompt (instruction-text.cjs).
// promptRulesRevision reads every mode on each check, so a read is reused while
// the file's identity (mtime, ctime, inode, size) is unchanged — but only once
// the file is older than the timestamp granularity: a file written moments ago
// can change again within the same tick without any of those moving.
const SETTLED_MS = 2000;
const fileCache = new Map();
export function readInstructionFile(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : { problem: 'unreadable' };
  }
  const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.size}`;
  const hit = fileCache.get(file);
  if (hit?.key === key && hit.settled) return hit.value;
  let value;
  try {
    if (!stat.isFile()) value = { problem: 'unreadable' };
    else {
      const decoded = decodeInstructionFile(readFileSync(file));
      value = decoded.problem ? decoded : { text: decoded.text.replace(/\r\n/g, '\n').trimEnd() };
    }
  } catch {
    value = { problem: 'unreadable' };
  }
  fileCache.set(file, { key, value, settled: Date.now() - stat.mtimeMs > SETTLED_MS });
  return value;
}

/**
 * Where a mode's text comes from: the user's file when it is usable, else the
 * shipped one. `problem` says why a user file that exists was passed over
 * (empty, too-large, not-text, unreadable); `text` is the prompt text.
 */
export function orchestrationModeSource(value) {
  const mode = normalizeOrchestrationMode(value);
  const user = readInstructionFile(userOrchestrationPath(mode));
  if (user?.text) return { mode, source: 'user', text: user.text };
  const shipped = readInstructionFile(shippedOrchestrationPath(mode));
  return {
    mode,
    source: 'default',
    text: shipped?.text ?? '',
    ...(user?.problem ? { problem: user.problem } : {}),
  };
}

export function orchestrationInstructions(value) {
  return orchestrationModeSource(value).text;
}
