import crypto from 'node:crypto';
import {
  isInternalRuntimeNotificationText,
  isModelVisibleToolCompletionWrapper,
} from '../../shared/tool-execution-contract.mjs';

// Side-effect-free helpers for fresh-context ingest_session hydration.
// The pure logic (stable identity, sensitive redaction, role/content shaping)
// is unit-tested without importing the MCP server entrypoint and its heavy
// boot-time side effects.

// Roles we persist from an in-memory session transcript (conversation only).
// Map provider/runtime spellings onto canonical roles; only user/assistant are
// kept so the Memory handoff does not duplicate protected system prefix.
const INGEST_SESSION_ROLES = new Set(['user', 'assistant']);

export function normalizeIngestRole(role) {
  const raw = String(role || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === 'human') return 'user';
  if (raw === 'ai' || raw === 'model') return 'assistant';
  if (raw === 'tool_result' || raw === 'function' || raw === 'tool-result') return null;
  return INGEST_SESSION_ROLES.has(raw) ? raw : null;
}

// Extract the first textual content block from a message content field.
function firstTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (typeof item === 'string') return item;
    if (item?.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return '';
}

export function allTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

// Collect durable tool-call / tool-result ids for identity + pairing.
function toolIdentityIds(m) {
  const ids = [];
  if (Array.isArray(m?.toolCalls)) {
    for (const tc of m.toolCalls) {
      if (tc?.id) ids.push(String(tc.id));
    }
  }
  if (m?.toolCallId) ids.push(String(m.toolCallId));
  return ids;
}

// Build a stable, content-derived source_ref for a session message so the
// ON CONFLICT DO NOTHING insert is idempotent across compaction reindexing.
//
// Identity hashes ONLY durable/original fields: role, tool-call/result ids, the
// ORIGINAL message timestamp (m.ts / m.timestamp) when actually present, and the
// shaped content. It never folds in a synthesized Date.now() fallback ts or the
// volatile loop index, so the same untimestamped message produces the same ref
// regardless of its position after compaction shrinks/reindexes the transcript.
// Two textually identical untimestamped plain messages intentionally dedupe to
// one row (stable dedupe preferred over positional separation).
export function stableSessionSourceRef(sessionId, m, role, content, ordinal) {
  const toolIds = toolIdentityIds(m);
  // Only an ORIGINAL, caller-supplied timestamp counts as durable identity.
  const rawTs = m?.ts ?? m?.timestamp;
  const originalTs =
    (typeof rawTs === 'number' && Number.isFinite(rawTs)) || (typeof rawTs === 'string' && rawTs.trim())
      ? String(rawTs)
      : '';
  // Untimestamped, textually-identical turns previously collapsed to one row
  // (same hash). Fold a stable ORDINAL (caller-supplied turn/index) into the
  // identity so genuine repeats persist as distinct rows. The ordinal is only
  // used when no durable original ts exists — a timestamped turn keeps its
  // compaction-stable identity independent of array position.
  const ordinalPart = !originalTs && Number.isFinite(Number(ordinal)) ? String(Math.floor(Number(ordinal))) : '';
  const identity = [role, originalTs, ordinalPart, toolIds.join(','), content].join('\u0000');
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return `session:${sessionId}:${hash}`;
}

// Monotonic source_turn allocator for ingest_session. source_turn must be a
// running continuation order INDEPENDENT of the current (post-compaction)
// array index: a freshly appended turn must sort AFTER every previously
// ingested row, even though compaction reset its array index to a low value.
// Seed `prevMaxTurn` from MAX(source_turn) for the session, then call
// next() once per actually-inserted row. Re-ingested (ON CONFLICT) rows keep
// their original turn and must NOT advance the counter, so the caller only
// invokes next() when a row was truly inserted.
export function createIngestTurnAllocator(prevMaxTurn = 0) {
  let turn = Number.isFinite(Number(prevMaxTurn)) ? Math.max(0, Math.floor(Number(prevMaxTurn))) : 0;
  return {
    peekNext() {
      return turn + 1;
    },
    next() {
      turn += 1;
      return turn;
    },
    current() {
      return turn;
    },
  };
}

// ── Pure-conversation ingest shaping ──────────────────────────────────────
//
// ingest_session persists ONLY real conversation (human prompts + model reply
// prose), stripping mechanical/synthetic content without losing genuine
// human/model text.

// Stable leading sentence of compact.mjs SUMMARY_PREFIX. Copied
// locally rather than imported because compact.mjs lives under
// agent/orchestrator/session and pulls in heavy context/offload modules —
// importing it into the memory layer would create a layering dependency (memory
// → orchestrator) and risk a boot-time cycle. Keeping only the durable anchor
// recognizes both legacy and current summary instructions.
const SUMMARY_PREFIX_INGEST = 'A previous model worked on this task and produced the compacted handoff summary below.';

// Anchored strip of the deterministic user-turn prefix envelopes that
// manager.mjs prepends to the SINGLE real user message (manager.mjs:3166-3201
// via prefixUserTurnContent / prefixSessionStartContent / buildSessionStartBlock).
// Zero-loss design: every rule is anchored to the START of the message and only
// removes the EXACT shapes manager.mjs produces. A `# Task` / `# Session` etc.
// appearing mid-message in the human's own text is never touched. When in
// doubt the rules UNDER-strip (leave content) rather than delete human text.
const LEADING_NAMED_SECTIONS = ['Project Instructions', 'Additional context', 'Prefetch'];

function stripLeadingNamedSection(text, heading) {
  return text
    .replace(new RegExp(`^# ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=\\n# |$)`), '')
    .replace(/^\n+/, '');
}

function stripUserTurnPrefixEnvelopes(text) {
  let out = String(text ?? '');
  // Leading `# Session` block (buildSessionStartBlock: `# Session\nCwd: ...
  //    \nModel: ...\nWorkflow: ...`, joined by prefixSessionStartContent with a
  //    trailing `\n\n`). FIELD-ANCHORED: only strip when the line(s) right after
  //    `# Session\n` are EXACTLY the fixed fields buildSessionStartBlock emits
  //    (`Cwd: `, `Model: `, `Workflow: `, each on its own line) before the
  //    blank-line terminator. A human doc that merely STARTS with a `# Session`
  //    heading followed by free prose in any language (e.g. `meeting notes`) does NOT match
  //    — its next line is not a `Cwd:/Model:/Workflow:` field — so it is
  //    preserved verbatim (zero-loss). Anchored ^.
  out = out.replace(/^# Session\n(?:(?:Cwd|Model|Workflow): [^\n]*\n)+(?:\n|$)/, '');
  // Named manager.mjs sections are the same start-anchored shape: heading, body
  // to the next `# ` boundary, then the blank-line separator. Project
  // Instructions / Additional context / Prefetch share that grammar; `# Task`
  // is only the marker line.
  for (const heading of LEADING_NAMED_SECTIONS) out = stripLeadingNamedSection(out, heading);
  out = out.replace(/^# Task\n/, '');
  return out;
}

// Ingest-only message shaper: returns ONLY the human/model prose text, NEVER
// inlining tool_call / tool_result traces. For user messages, the deterministic
// manager.mjs prefix envelopes are stripped so only the human's actual prompt
// remains. The <system-reminder> block is left in place here because
// cleanMemoryText already removes it downstream (text-utils.cjs:28).
export function sessionMessageContentForIngest(m) {
  const base = allTextContent(m?.content);
  if (!base) return '';
  if (normalizeIngestRole(m?.role) === 'user') {
    return stripUserTurnPrefixEnvelopes(base);
  }
  return base;
}

// Head-line shape of toolCompletionInstruction() as persisted by
// mgr.enqueuePendingMessage — unquoted, with no `> ` prefix on Result.
// isModelVisibleToolCompletionWrapper only matches the QUOTED (`> `) shape
// mirrored via the notify-wrapper's own quoting, so it misses this unquoted
// persisted form. The instruction head alone is a sufficient, unambiguous
// fingerprint (only the runtime ever emits this exact phrase).
const UNQUOTED_TOOL_COMPLETION_HEAD_RE = /^Async .+ finished\./i;

// Exported so memory.mjs's one-time cleanup (ensureCurrentSchemaExtensions)
// can confirm SQL-prefiltered candidate rows with the SAME predicate the live
// ingest filter uses, rather than re-deriving the regex.
export function isUnquotedToolCompletionHead(text) {
  return UNQUOTED_TOOL_COMPLETION_HEAD_RE.test(String(text ?? '').trimStart());
}

// Row-exclusion predicate for ingest_session. Synthetic / non-conversation
// rows (reference-files injections, compaction summaries, protected-context
// `.` acks, internal runtime nudges) are dropped ENTIRELY — they are noise,
// not conversation. Mirrors the predicates in manager.mjs / compact.mjs but is
// reimplemented locally to avoid a memory→orchestrator layering dependency.
function isExcludedUserIngestText(m, text) {
  const trimmedStart = text.trimStart();
  const metaSource = String(m?.meta?.source || '');
  // `Reference files:` synthetic user rows (manager.mjs isReferenceFilesMessage).
  if (/^Reference files:\s*/i.test(trimmedStart)) return true;
  // Attachment-only placeholder rows (e.g. Discord provider discord.mjs:724
  // `"(attachment)"` fallback when a message carries no text, only files).
  if (text.trim() === '(attachment)') return true;
  // Compaction summary user rows (compact.mjs isSummaryMessage / SUMMARY_PREFIX).
  if (metaSource === 'compact-summary') return true;
  if (text.startsWith(SUMMARY_PREFIX_INGEST) && /\nmessages=\d+\s+(?:sha256=|compact_type=)/.test(text)) return true;
  // Injected Skill-body user rows (context/collect.mjs buildSkillToolEnvelope).
  // The full SKILL.md body is delivered as ONE role:'user' message flagged
  // `meta:'skill'` inside a `<skill>` envelope. Mirrors compact/messages.mjs
  // isInjectedSkillBodyMessage; the meta marker and the content prefix are
  // both honoured so a tail rebuild that drops meta still excludes the body.
  if (m?.meta === 'skill' || trimmedStart.startsWith('<skill>')) return true;
  if (['compact-active-turn-continuation', 'compact-execution-recovery'].includes(metaSource)) return true;
  if (text.includes('<active-turn-continuation>')) return true;
  // Internal runtime nudge `[mixdog-runtime] ...` user rows and other
  // internal runtime notifications (tool-execution-contract), including both
  // quoted and unquoted tool-completion wrappers.
  if (/^\[mixdog-runtime\]/.test(trimmedStart)) return true;
  if (isInternalRuntimeNotificationText(text)) return true;
  if (isModelVisibleToolCompletionWrapper(text)) return true;
  if (isUnquotedToolCompletionHead(text)) return true;
  return false;
}

export function shouldExcludeIngestMessage(m) {
  if (!m || typeof m !== 'object') return true;
  const role = normalizeIngestRole(m?.role);
  const text = firstTextContent(m?.content);
  if (role === 'user') return isExcludedUserIngestText(m, text);
  // Protected-context `.` ack assistant rows (compact.mjs isProtectedContextAckMessage):
  // a bare `.` with no tool calls. cleanMemoryText leaves a lone `.` non-empty
  // (no \p{L}\p{N}), so it would otherwise survive the empty-skip — exclude it.
  return role === 'assistant' && text.trim() === '.' && !Array.isArray(m?.toolCalls);
}

// Project a live session transcript to the exact fields ingest_session can
// consume before it crosses a process/HTTP boundary. Tool results, system
// prefixes, media blocks, and full tool-call arguments can make a mature
// transcript exceed the memory service's bounded request-body guard even
// though ingest_session discards all of them after parsing. Keep genuine
// conversation text plus only the durable identity fields used by
// stableSessionSourceRef; the owner-side ingest pipeline still performs the
// canonical shaping/cleaning exactly once.
export function projectSessionMessagesForIngest(messages) {
  if (!Array.isArray(messages)) return [];
  const projected = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = normalizeIngestRole(m.role);
    if (!role || shouldExcludeIngestMessage(m)) continue;
    const content = sessionMessageContentForIngest(m);
    if (!content?.trim()) continue;
    const next = { role, content };
    if (Object.hasOwn(m, 'ts')) next.ts = m.ts;
    if (Object.hasOwn(m, 'timestamp')) next.timestamp = m.timestamp;
    if (m.toolCallId) next.toolCallId = m.toolCallId;
    if (Array.isArray(m.toolCalls)) {
      const ids = m.toolCalls.filter((tc) => tc?.id).map((tc) => ({ id: tc.id }));
      if (ids.length > 0) next.toolCalls = ids;
    }
    projected.push(next);
  }
  return projected;
}
