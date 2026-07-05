import crypto from 'node:crypto'
import { isInternalRuntimeNotificationText, isModelVisibleToolCompletionWrapper } from '../../shared/tool-execution-contract.mjs'

// Side-effect-free helpers for ingest_session (recall fast-track hydration).
// Extracted from memory/index.mjs so the pure logic (stable identity, sensitive
// redaction, role/content shaping) can be unit-tested without importing the
// MCP server entrypoint and its heavy boot-time side effects.

// Roles we persist from an in-memory session transcript (conversation only).
// Map provider/runtime spellings onto canonical roles; only user/assistant are
// kept so recall-fasttrack memory does not duplicate protected system prefix.
const INGEST_SESSION_ROLES = new Set(['user', 'assistant'])

export function normalizeIngestRole(role) {
  const raw = String(role || '').trim().toLowerCase()
  if (!raw) return null
  let canonical = raw
  if (raw === 'tool_result' || raw === 'function' || raw === 'tool-result') canonical = 'tool'
  else if (raw === 'human') canonical = 'user'
  else if (raw === 'ai' || raw === 'model') canonical = 'assistant'
  return INGEST_SESSION_ROLES.has(canonical) ? canonical : null
}

// Extract the first textual content block from a message content field.
export function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (typeof item === 'string') return item
    if (item?.type === 'text' && typeof item.text === 'string') return item.text
  }
  return ''
}

// Collect durable tool-call / tool-result ids for identity + pairing.
function toolIdentityIds(m) {
  const ids = []
  if (Array.isArray(m?.toolCalls)) {
    for (const tc of m.toolCalls) { if (tc?.id) ids.push(String(tc.id)) }
  }
  if (m?.toolCallId) ids.push(String(m.toolCallId))
  return ids
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
  const toolIds = toolIdentityIds(m)
  // Only an ORIGINAL, caller-supplied timestamp counts as durable identity.
  const rawTs = m?.ts ?? m?.timestamp
  const originalTs = (typeof rawTs === 'number' && Number.isFinite(rawTs)) || (typeof rawTs === 'string' && rawTs.trim())
    ? String(rawTs)
    : ''
  // Untimestamped, textually-identical turns previously collapsed to one row
  // (same hash). Fold a stable ORDINAL (caller-supplied turn/index) into the
  // identity so genuine repeats persist as distinct rows. The ordinal is only
  // used when no durable original ts exists — a timestamped turn keeps its
  // compaction-stable identity independent of array position.
  const ordinalPart = originalTs ? '' : (Number.isFinite(Number(ordinal)) ? String(Math.floor(Number(ordinal))) : '')
  const identity = [role, originalTs, ordinalPart, toolIds.join(','), content].join('\u0000')
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return `session:${sessionId}:${hash}`
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
  let turn = Number.isFinite(Number(prevMaxTurn)) ? Math.max(0, Math.floor(Number(prevMaxTurn))) : 0
  return {
    peekNext() { return turn + 1 },
    next() { turn += 1; return turn },
    current() { return turn },
  }
}

// Sensitive tool-arg key matcher (mirrors compact.mjs SENSITIVE_TOOL_ARG_KEY_RE):
// api_key/authorization/auth/cookie/credential/password/secret/token, etc.
const SENSITIVE_ARG_KEY_RE = /(?:^|[_-])(?:api[_-]?key|authorization|auth|cookie|credential|passwd|password|refresh[_-]?token|secret|token)(?:$|[_-])/i
const SENSITIVE_KEY_WORD = '(?:api[_-]?key|authorization|auth|cookie|credential|passwd|password|refresh[_-]?token|secret|token)'
// Full key matcher: the sensitive WORD may carry a prefix and/or suffix segment
// joined by `_`/`-` so prefixed variants like `access_token`, `access-token`,
// `x-api-key`, and `bearer_token` are matched as whole keys (not just the bare
// word at key start). Mirrors compact.mjs SENSITIVE_TOOL_ARG_KEY_FULL.
const SENSITIVE_KEY_FULL = `(?:[A-Za-z0-9_-]*[_-])?${SENSITIVE_KEY_WORD}(?:[_-][A-Za-z0-9_-]*)?`
const TOOL_ARG_MAX_CHARS = 400

// Recursively redact sensitive values by key. Sensitive keys collapse to
// [redacted] regardless of value shape so nested secrets never survive.
export function redactToolArgValue(value, key = '', depth = 0) {
  if (SENSITIVE_ARG_KEY_RE.test(String(key || ''))) return '[redacted]'
  if (value == null) return value
  if (typeof value === 'bigint') return String(value)
  // Defense-in-depth: a non-sensitive KEY can still carry a secret embedded in
  // its string VALUE (e.g. `{ headers: "authorization: Bearer ..." }`). Run raw
  // key:value redaction on string values so embedded secrets never survive.
  if (typeof value === 'string') return redactRawArgString(value)
  if (typeof value !== 'object') return value
  if (depth >= 4) return Array.isArray(value) ? `[array:${value.length}]` : '[object]'
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item, idx) => redactToolArgValue(item, String(idx), depth + 1))
  }
  const out = {}
  for (const k of Object.keys(value)) out[k] = redactToolArgValue(value[k], k, depth + 1)
  return out
}

// Redact `key: value` / `key=value` pairs inside a raw (non-JSON) arg string.
// Unlike a single greedy regex, this consumes the WHOLE secret value after the
// key — including spaces, `Bearer ` prefixes, quoted values with internal
// spaces, and `;`-separated cookie pairs — so no secret fragment leaks.
function redactRawArgString(text) {
  const keyRe = new RegExp(`((?:^|[\\s,{(])["']?${SENSITIVE_KEY_FULL}["']?\\s*[:=]\\s*)`, 'gi')
  let out = ''
  let last = 0
  let match
  while ((match = keyRe.exec(text)) !== null) {
    const prefixEnd = match.index + match[0].length
    out += text.slice(last, prefixEnd)
    // Determine where the secret value ends. Quoted values run to the closing
    // quote; unquoted values run to the next separator that ends a field. For
    // Authorization we also swallow a leading `Bearer `/`Basic ` scheme word so
    // nothing after it survives.
    let i = prefixEnd
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : ''
    if (quote) {
      i += 1
      while (i < text.length && text[i] !== quote) i += 1
      if (i < text.length) i += 1 // include closing quote
    } else {
      // Unquoted: stop at a comma, closing brace/paren, or newline. Spaces and
      // `;` inside the value are part of the secret (Bearer tokens, cookies).
      while (i < text.length && !/[,)}\n]/.test(text[i])) i += 1
    }
    out += '[redacted]'
    last = i
    keyRe.lastIndex = i
  }
  out += text.slice(last)
  return out
}

// Produce a readable, redacted, length-capped string for tool-call arguments.
// Object/JSON args are walked key-by-key so nested secrets are caught; a raw
// non-JSON string has its key:value secret pairs redacted before truncation.
export function redactToolArgString(rawArgs) {
  if (rawArgs == null) return ''
  let parsed = rawArgs
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    if (/^[[{]/.test(trimmed)) {
      try { parsed = JSON.parse(trimmed) } catch { parsed = trimmed }
    } else {
      parsed = trimmed
    }
  }
  let out
  if (parsed && typeof parsed === 'object') {
    try { out = JSON.stringify(redactToolArgValue(parsed)) }
    catch { out = '[unserializable args]' }
  } else {
    out = redactRawArgString(String(parsed))
  }
  return out.slice(0, TOOL_ARG_MAX_CHARS)
}

// Build a readable, role-aware content string for a session message so the
// structured handoff preserves assistant tool_calls and tool_result bodies
// (not just plain text). Keeps valid tool-call/tool-result pairing legible by
// tagging each with its toolCallId, while redacting sensitive argument values.
export function sessionMessageContent(m) {
  const parts = []
  const base = firstTextContent(m?.content)
  if (base && base.trim()) parts.push(base.trim())
  if (m?.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
    for (const tc of m.toolCalls.slice(0, 8)) {
      const name = tc?.name || tc?.function?.name || tc?.id || 'tool'
      const id = tc?.id ? ` id=${tc.id}` : ''
      const argStr = redactToolArgString(tc?.arguments ?? tc?.function?.arguments)
      parts.push(`[tool_call ${name}${id}]${argStr ? ` ${argStr}` : ''}`)
    }
  }
  const isTool = m?.role === 'tool' || normalizeIngestRole(m?.role) === 'tool'
  if (isTool && m?.toolCallId && parts.length) {
    parts[0] = `[tool_result id=${m.toolCallId}] ${parts[0]}`
  } else if (isTool && m?.toolCallId) {
    parts.push(`[tool_result id=${m.toolCallId}]`)
  }
  return parts.join('\n')
}

// ── Pure-conversation ingest shaping ──────────────────────────────────────
//
// ingest_session persists ONLY real conversation (human prompts + model reply
// prose). sessionMessageContent (above) is the structured-handoff shaper that
// inlines tool_call / tool_result traces and is consumed by smoke tests; it is
// intentionally LEFT UNCHANGED. The functions below are ingest-only and strip
// everything that is mechanical/synthetic so memory episode rows are pure
// conversation with zero loss of genuine human/model text.

// Mirror of compact.mjs SUMMARY_PREFIX (the compaction handoff anchor). Copied
// locally rather than imported because compact.mjs lives under
// agent/orchestrator/session and pulls in heavy context/offload modules —
// importing it into the memory layer would create a layering dependency (memory
// → orchestrator) and risk a boot-time cycle. Keep this string byte-identical
// to compact.mjs:9; if that anchor changes, update this copy.
const SUMMARY_PREFIX_INGEST = 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. You also retain the preserved recent turns that follow.'

// Anchored strip of the deterministic user-turn prefix envelopes that
// manager.mjs prepends to the SINGLE real user message (manager.mjs:3166-3201
// via prefixUserTurnContent / prefixSessionStartContent / buildSessionStartBlock).
// Zero-loss design: every rule is anchored to the START of the message and only
// removes the EXACT shapes manager.mjs produces. A `# Task` / `# Session` etc.
// appearing mid-message in the human's own text is never touched. When in
// doubt the rules UNDER-strip (leave content) rather than delete human text.
function stripUserTurnPrefixEnvelopes(text) {
  let out = String(text ?? '')
  // 1) Leading `# Session` block (buildSessionStartBlock: `# Session\nCwd: ...
  //    \nModel: ...\nWorkflow: ...`, joined by prefixSessionStartContent with a
  //    trailing `\n\n`). FIELD-ANCHORED: only strip when the line(s) right after
  //    `# Session\n` are EXACTLY the fixed fields buildSessionStartBlock emits
  //    (`Cwd: `, `Model: `, `Workflow: `, each on its own line) before the
  //    blank-line terminator. A human doc that merely STARTS with a `# Session`
  //    heading followed by free prose in any language (e.g. `meeting notes`) does NOT match
  //    — its next line is not a `Cwd:/Model:/Workflow:` field — so it is
  //    preserved verbatim (zero-loss). Anchored ^.
  out = out.replace(/^# Session\n(?:(?:Cwd|Model|Workflow): [^\n]*\n)+(?:\n|$)/, '')
  // 2) Leading `# Additional context\n<body>\n\n` (manager.mjs:3168). Anchored
  //    to start; body runs up to the next `# ` section boundary or end. The
  //    `\n\n` separator manager.mjs emits is included.
  out = out.replace(/^# Additional context\n[\s\S]*?(?=\n# |$)/, '')
  out = out.replace(/^\n+/, '')
  // 3) Leading `# Prefetch\n<body>\n\n` (manager.mjs:3171). Same anchoring.
  out = out.replace(/^# Prefetch\n[\s\S]*?(?=\n# |$)/, '')
  out = out.replace(/^\n+/, '')
  // 4) Leading `# Task\n` marker (prefixUserTurnContent: `${contextBlock}# Task\n${content}`).
  //    Remove ONLY the marker line; everything after it is the human prompt and
  //    is preserved verbatim. Anchored ^ so a `# Task` in the human's own prose
  //    (after real text precedes it) is never removed.
  out = out.replace(/^# Task\n/, '')
  return out
}

// Ingest-only message shaper: returns ONLY the human/model prose text, NEVER
// inlining tool_call / tool_result traces. For user messages, the deterministic
// manager.mjs prefix envelopes are stripped so only the human's actual prompt
// remains. The <system-reminder> block is left in place here because
// cleanMemoryText already removes it downstream (text-utils.cjs:28).
export function sessionMessageContentForIngest(m) {
  const base = firstTextContent(m?.content)
  if (!base) return ''
  if (normalizeIngestRole(m?.role) === 'user') {
    return stripUserTurnPrefixEnvelopes(base)
  }
  return base
}

// Head-line shape of toolCompletionInstruction() (tool-execution-contract.mjs)
// as it is ACTUALLY persisted by mgr.enqueuePendingMessage — UNQUOTED, no
// `> ` prefix on the Result body (real DB rows look like:
// "The async shell task <id> has finished (completed, exit 0) - review this
// result in your next step.\nResult:\nbackground task\ntask_id: ...").
// isModelVisibleToolCompletionWrapper only matches the QUOTED (`> `) shape
// mirrored via the notify-wrapper's own quoting, so it misses this unquoted
// persisted form. The instruction head alone is a sufficient, unambiguous
// fingerprint (only the runtime ever emits this exact phrase).
const UNQUOTED_TOOL_COMPLETION_HEAD_RE = /^The async (?:shell task|agent task|\S+ execution|\S+) .*has finished\b.*review this result in your next step/i

// Exported so memory.mjs's one-time cleanup (ensureCurrentSchemaExtensions)
// can confirm SQL-prefiltered candidate rows with the SAME predicate the live
// ingest filter uses, rather than re-deriving the regex.
export function isUnquotedToolCompletionHead(text) {
  return UNQUOTED_TOOL_COMPLETION_HEAD_RE.test(String(text ?? '').trimStart())
}

// Row-exclusion predicate for ingest_session. Synthetic / non-conversation
// rows (reference-files injections, compaction summaries, protected-context
// `.` acks, internal runtime nudges) are dropped ENTIRELY — they are noise,
// not conversation. Mirrors the predicates in manager.mjs / compact.mjs but is
// reimplemented locally to avoid a memory→orchestrator layering dependency.
export function shouldExcludeIngestMessage(m) {
  if (!m || typeof m !== 'object') return true
  const role = normalizeIngestRole(m?.role)
  const raw = firstTextContent(m?.content)
  // `Reference files:` synthetic user rows (manager.mjs isReferenceFilesMessage).
  if (role === 'user' && typeof raw === 'string' && /^Reference files:\s*/i.test(raw.trimStart())) {
    return true
  }
  // Attachment-only placeholder rows (e.g. Discord backend discord.mjs:724
  // `"(attachment)"` fallback when a message carries no text, only files).
  // Carries zero retrievable content — excluded so recall isn't polluted
  // with bare "(attachment)" memory rows.
  if (role === 'user' && typeof raw === 'string' && raw.trim() === '(attachment)') {
    return true
  }
  // Compaction summary user rows (compact.mjs isSummaryMessage / SUMMARY_PREFIX).
  if (role === 'user' && typeof raw === 'string' && raw.startsWith(SUMMARY_PREFIX_INGEST)) {
    return true
  }
  // Protected-context `.` ack assistant rows (compact.mjs isProtectedContextAckMessage):
  // a bare `.` with no tool calls. cleanMemoryText leaves a lone `.` non-empty
  // (no \p{L}\p{N}), so it would otherwise survive the empty-skip — exclude it.
  if (role === 'assistant' && typeof raw === 'string' && raw.trim() === '.' && !Array.isArray(m?.toolCalls)) {
    return true
  }
  // Internal runtime nudge `[mixdog-runtime] ...` user rows (loop.mjs:2014-2020)
  // and other internal runtime notifications (tool-execution-contract).
  if (role === 'user') {
    const text = typeof raw === 'string' ? raw : ''
    if (/^\[mixdog-runtime\]/.test(text.trimStart())) return true
    if (isInternalRuntimeNotificationText(text)) return true
    // Model-visible tool-completion mirror rows (mgr.enqueuePendingMessage of
    // modelVisibleToolCompletionMessage — "The async shell/agent task ... has
    // finished ... - review this result in your next step.\n\nResult:\n> ...").
    // These are runtime notifications, not conversation, on both ingest paths.
    if (isModelVisibleToolCompletionWrapper(text)) return true
    // Unquoted persisted form of the same wrapper (see comment above).
    if (isUnquotedToolCompletionHead(text)) return true
  }
  return false
}
