import { createHash } from 'node:crypto';
import { estimateTokens } from './token-estimate.mjs';
import { createContextFingerprinter } from './context-fingerprint.mjs';
import {
  isFinalizedProviderRequestTools,
  providerNativeToolPrefixCount,
} from '../../../../session-runtime/provider-request-tools.mjs';
import { contentFileDescriptors, contentImageDescriptors, contentToText } from '../providers/media-normalization.mjs';

export {
  dedupToolResultBodies,
  foldUserTextIntoToolResultTail,
  reconcileDedupStubs,
  sanitizeAnthropicContentPairs,
  sanitizeToolPairs,
} from './context-tool-pairs.mjs';

export {
  DEFAULT_COMPACTION_BUFFER_TOKENS,
  DEFAULT_COMPACTION_BUFFER_RATIO,
  DEFAULT_MAIN_COMPACTION_BUFFER_RATIO,
  MAX_COMPACTION_BUFFER_RATIO,
  normalizeCompactionBufferRatio,
  resolveBufferRatioCandidate,
  resolveCompactBufferRatio,
  resolveMainCompactBufferRatio,
  compactionBufferTokensForBoundary,
  isPersistedZeroBufferTelemetry,
  isLegacyDefaultBufferTelemetry,
  compactBufferConfigForBoundary,
  resolveCompactBufferTokens,
  resolveMainCompactBufferTokens,
  resolveCompactTriggerTokens,
  resolveSessionCompactPolicy,
} from './context-compaction-policy.mjs';

// ---------------------------------------------------------------------------
// Token estimation lives in ./token-estimate.mjs — a conservative
// Unicode-aware heuristic. It is accurate ENOUGH because context pressure is
// anchored on the provider usage baseline (the exact prompt-token count the
// provider reports for the previous request) and the heuristic only prices the
// delta appended since then. Measured across 5,552 real deltas the worst
// underestimate was 2,985 tokens (1.5% of a 200K window) with a +6.5%
// aggregate bias toward overcounting.
//
// providerTokenCalibration() below reconciles that estimate with actual
// billing at the provider-aware aggregation boundary (compaction pressure /
// context gauge), never inside the provider-agnostic per-message memo.
// ---------------------------------------------------------------------------

// Billed-prompt / estimate ratio per provider family. Env overrides let a
// deployment recalibrate without a code change; values are clamped to a
// plausible band.
//
// The Anthropic factor was 1.9 while opaque replay blobs were projected as a
// fixed marker — that is, while a transcript's entire reasoning stream (15-35%
// of it) was priced at zero, and the multiplier was silently covering the gap.
// Now that those blobs carry their measured cost, the ratio was re-measured
// against the provider's own token counter on twenty real transcripts:
// 1.23-1.40, median 1.32 (previously 1.72-2.48 — a fifth of the spread, since
// the multiplier no longer has to absorb a variable amount of reasoning).
// 1.4 covers the measured maximum without double counting.
//
// Only Anthropic-style providers can be calibrated against reported usage at
// all, because only they resend the whole transcript every turn. OpenAI/xAI
// chain requests through previous_response_id and send just the tail, so their
// reported input is a fraction of the conversation (measured at 0.59-0.77 of
// the local estimate) while the context the model actually reasons over is the
// full chain. Their factor stays neutral: the estimate is already the right
// answer for the gauge, and scaling it to reported input would understate the
// window.
function calibrationEnv(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(3, Math.max(0.25, n)) : null;
}
export function providerTokenCalibration(provider) {
  const p = String(provider || '').toLowerCase();
  if (p.startsWith('anthropic')) return calibrationEnv('MIXDOG_TOKEN_CALIBRATION_ANTHROPIC') ?? 1.4;
  if (p.startsWith('gemini') || p.startsWith('google'))
    return calibrationEnv('MIXDOG_TOKEN_CALIBRATION_GEMINI') ?? 1.15;
  return calibrationEnv('MIXDOG_TOKEN_CALIBRATION_DEFAULT') ?? 1.0;
}
// Standard vision models cap an image at 1568px on the longest edge AND at
// 1568 visual tokens, downscaling anything larger before it is processed. No
// image can therefore be billed above that ceiling, which makes it both the
// maximum and the honest flat allowance for an image whose dimensions we never
// learned. Known dimensions are billed exactly, through the real vision
// formula (w*h/750, i.e. 28x28 patches).
const IMAGE_TOKEN_ALLOWANCE = 1_568;

export { estimateTokens };

// Opaque replay payloads (Anthropic thinking signatures, OpenAI encrypted
// reasoning blobs, redacted data) are long base64-ish strings that ARE billed
// proportionally to their serialized length — see the measurement below. They
// were previously replaced with a fixed marker, which priced a provider's
// entire reasoning stream at nearly zero. Project them at their measured cost
// instead. Projection is KEY-SCOPED: only fields that structurally carry
// opaque replay
// material (signatures / encrypted / redacted / raw data blobs) are eligible,
// so genuine long model text (e.g. Gemini thought text) keeps its real cost.
const OPAQUE_PAYLOAD_KEY_RE = /signature|encrypted|redacted|^data$|^blob$/i;
const OPAQUE_PAYLOAD_RE = /^[A-Za-z0-9+/_=-]{64,}$/;

// An opaque blob is billed like the base64 it is — proportional to its length.
// Measured on five real transcripts against the provider's own token counter
// (thinking blocks removed, difference taken): 3.43-4.04 bytes per token,
// median 3.67. Both earlier treatments were wrong in opposite directions: the
// estimator's dense-run floor prices a 64+ char run at 0.65/char (~2.4x the
// measured cost), while replacing the blob with a fixed marker priced it at
// nearly zero — and reasoning is 15-35% of a long transcript.
//
// So project the blob onto a string the estimator reads at its measured cost:
// plain lowercase words on one line, which trips none of the dense/structured
// floors and therefore estimates at exactly chars/4. The conservative end of
// the measured band keeps the estimator's never-read-low contract.
const OPAQUE_BYTES_PER_TOKEN = 3.43;
const OPAQUE_WORD = 'opaque ';
function opaquePayloadProjection(length) {
  const tokens = Math.ceil(length / OPAQUE_BYTES_PER_TOKEN);
  const chars = tokens * 4;
  return OPAQUE_WORD.repeat(Math.ceil(chars / OPAQUE_WORD.length)).slice(0, chars);
}

function stripOpaquePayloads(value, depth = 0, keyHint = '') {
  if (typeof value === 'string') {
    return OPAQUE_PAYLOAD_KEY_RE.test(keyHint) && value.length >= 64 && OPAQUE_PAYLOAD_RE.test(value)
      ? opaquePayloadProjection(value.length)
      : value;
  }
  if (depth >= 8 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripOpaquePayloads(v, depth + 1, keyHint));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = stripOpaquePayloads(v, depth + 1, k);
  return out;
}
function nativeBlocksEstimateText(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((block) => {
      const images = contentImageDescriptors(block);
      if (images.length) {
        return JSON.stringify(
          images.map(({ width, height, detail }) => ({
            type: 'image',
            width,
            height,
            detail,
          }))
        );
      }
      try {
        return JSON.stringify(stripOpaquePayloads(block));
      } catch {
        return String(block ?? '');
      }
    })
    .join('\n');
}
function messageEstimateText(m) {
  if (!m || typeof m !== 'object') return '';
  // Multimodal image payloads remain on the live message for provider sends,
  // but their base64/data-url JSON is not text and must not dominate local
  // context estimates. Use the same media-aware text projection for every
  // estimate consumer (live gauge, compaction fallback, and summaries).
  let text = contentToText(m.content, '');
  if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
    try {
      text += `\n${JSON.stringify(m.toolCalls)}`;
    } catch {
      text += `\n[${m.toolCalls.length} tool calls]`;
    }
  }
  const providerReplayItems =
    m.role === 'assistant' && Array.isArray(m.providerReplay?.items) ? m.providerReplay.items : null;
  if (providerReplayItems?.length) {
    text += `\n${nativeBlocksEstimateText(providerReplayItems)}`;
  }
  // Anthropic adaptive-thinking blocks round-trip verbatim (thinking text +
  // signature / redacted data) and are re-sent on tool-continuation turns, so
  // they consume real input tokens. Count them or trim/compact undercounts.
  if (!providerReplayItems && m.role === 'assistant' && Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length) {
    text += `\n${nativeBlocksEstimateText(m.thinkingBlocks)}`;
  }
  // Some provider adapters replay their native assistant representation
  // instead of content/toolCalls. Project it through the media normalizer so
  // text/tool metadata and opaque reasoning are counted without base64 image
  // bytes dominating the estimate.
  if (!providerReplayItems && m.role === 'assistant' && Array.isArray(m.assistantBlocks) && m.assistantBlocks.length) {
    text += `\n${nativeBlocksEstimateText(m.assistantBlocks)}`;
  }
  if (!providerReplayItems && m.role === 'assistant' && Array.isArray(m.reasoningItems) && m.reasoningItems.length) {
    text += `\n${nativeBlocksEstimateText(m.reasoningItems)}`;
  }
  // Provider-scoped replay metadata is never sent to a different provider,
  // but Gemini replays signed thought parts on subsequent Gemini turns.
  const geminiThoughtParts = m.role === 'assistant' ? m.providerMetadata?.gemini?.thoughtParts : null;
  if (!providerReplayItems && Array.isArray(geminiThoughtParts) && geminiThoughtParts.length) {
    text += `\n${nativeBlocksEstimateText(geminiThoughtParts)}`;
  }
  if (m.role === 'tool' && m.toolCallId) text += `\n${m.toolCallId}`;
  return text;
}
// Wire reality for replay-carrying assistants: the SAME provider replays
// providerReplay.items INSTEAD of content/toolCalls, while a different
// provider sends content/toolCalls without the replay envelope. Summing both
// halves double-counted the assistant's own output and tool args in every
// estimate-fallback window. Meter max(base, replay) instead: neither wire
// projection is ever undercounted and nothing is counted twice.
// messageEstimateText itself stays byte-identical — prefix signatures and
// fingerprints hash the full concatenation and must not shift across deploys.
function messageTextTokens(m, precomputedText = null) {
  const text = precomputedText ?? messageEstimateText(m);
  const replayItems =
    m?.role === 'assistant' && Array.isArray(m.providerReplay?.items) && m.providerReplay.items.length
      ? m.providerReplay.items
      : null;
  const fullTokens = estimateTokens(text);
  if (!replayItems) return fullTokens;
  const replayTokens = estimateTokens(nativeBlocksEstimateText(replayItems));
  return Math.max(fullTokens - replayTokens, replayTokens);
}
function imageDescriptorAllowance(descriptor) {
  if (descriptor.width && descriptor.height) {
    // Anthropic vision cost: tokens = (width * height) / 750, capped at the
    // allowance above because the provider downscales past it. Real pixel
    // dimensions ARE the billed quantity, so they replace the unknown-image
    // floor in both directions. Holding a 1280x720 screenshot at a 2000-token
    // floor overstated its true 1229-token cost by 63% and pulled compaction
    // forward against a budget that was never actually spent.
    const formula = Math.ceil((descriptor.width * descriptor.height) / 750);
    return Math.min(IMAGE_TOKEN_ALLOWANCE, formula);
  }
  // Unknown-size images: flat conservative allowance.
  return IMAGE_TOKEN_ALLOWANCE;
}
function messageImageDescriptors(m) {
  if (!m || typeof m !== 'object') return [];
  return [
    ...contentImageDescriptors(m.content),
    ...(m.role === 'assistant' ? contentImageDescriptors(m.assistantBlocks) : []),
    ...(m.role === 'assistant' ? contentImageDescriptors(m.providerReplay?.items) : []),
  ];
}
function messageImageAllowance(m) {
  if (!m || typeof m !== 'object') return 0;
  return messageImageDescriptors(m).reduce((sum, descriptor) => sum + imageDescriptorAllowance(descriptor), 0);
}
// Inline document (PDF) allowance: Anthropic bills ~1,500-3,000 tokens per
// page and a typical PDF page is ~50-100KB, so ~bytes/16 with a floor and a
// cap. The base64 payload itself is excluded from text estimates (see
// jsonFallbackFromPart), so this allowance is the document's entire cost.
const FILE_TOKEN_ALLOWANCE_FLOOR = 1_500;
const FILE_MAX_TOKEN_ALLOWANCE = 300_000;
function fileDescriptorAllowance(descriptor) {
  return Math.min(
    FILE_MAX_TOKEN_ALLOWANCE,
    Math.max(FILE_TOKEN_ALLOWANCE_FLOOR, Math.ceil((descriptor.sizeBytes || 0) / 16))
  );
}
function messageFileAllowance(m) {
  if (!m || typeof m !== 'object') return 0;
  return contentFileDescriptors(m.content).reduce((sum, descriptor) => sum + fileDescriptorAllowance(descriptor), 0);
}
// An attachment is billed on its own terms — an image on its pixels, a document
// on its bytes — and those allowances are exactly what estimateMessageTokens()
// adds on top of the text. Expose them per item so the context inspector can
// price a pasted screenshot as its own row instead of letting it hide inside
// the message that carried it.
export function messageAttachmentBreakdown(m) {
  if (!m || typeof m !== 'object') return { tokens: 0, items: [] };
  const items = [
    ...messageImageDescriptors(m).map((descriptor) => ({
      kind: 'image',
      // Pixels when the wire carried them; an unsized image has no detail to
      // add beyond its kind, so it says nothing rather than repeating itself.
      label: descriptor.width && descriptor.height ? `${descriptor.width}×${descriptor.height}` : '',
      tokens: imageDescriptorAllowance(descriptor),
    })),
    ...contentFileDescriptors(m.content).map((descriptor) => ({
      kind: 'file',
      label: String(descriptor.mimeType || 'file'),
      tokens: fileDescriptorAllowance(descriptor),
    })),
  ];
  return { tokens: items.reduce((sum, item) => sum + item.tokens, 0), items };
}
// The one per-message meter: replay-aware text tokens plus the image AND
// document allowances. The gauge summary and the compaction pressure estimate
// must price a message identically.
function meteredMessageTokens(m, precomputedText = null) {
  return messageTextTokens(m, precomputedText) + messageImageAllowance(m) + messageFileAllowance(m) + 4;
}
// Compaction, pressure and budget checks re-price the same live message
// objects many times per turn. Memoize the meter per message object, validated
// against a structural snapshot of every field the meter reads: a flat,
// pre-order record of the plain object/array skeleton and its primitive leaves
// (strings are shared, never copied). Validation walks the live fields against
// it without allocating, so an in-place edit anywhere below a message — a
// streamed block, restored tool arguments, a reordered key — misses the memo
// and re-meters. Values outside plain data (Date, Map, class instances, deep
// or cyclic graphs) are never snapshotted and always re-meter.
const METERED_MESSAGE_FIELDS = Object.freeze([
  'role',
  'toolCallId',
  'content',
  'toolCalls',
  'thinkingBlocks',
  'assistantBlocks',
  'reasoningItems',
  'providerMetadata',
  'providerReplay',
]);
const METER_SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_OBJECT = Object.freeze({});
const SNAPSHOT_ARRAY = Object.freeze({});
const meteredMessageMemo = new WeakMap();

function plainObjectPrototype(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function snapshotMeteredValue(value, out, depth) {
  if (value === null || typeof value !== 'object') {
    out.push(value);
    return true;
  }
  if (depth >= METER_SNAPSHOT_MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const length = value.length;
    out.push(SNAPSHOT_ARRAY, length);
    for (let index = 0; index < length; index += 1) {
      if (!snapshotMeteredValue(value[index], out, depth + 1)) return false;
    }
    return true;
  }
  if (!plainObjectPrototype(value)) return false;
  out.push(SNAPSHOT_OBJECT, 0);
  const countIndex = out.length - 1;
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    out.push(key);
    if (!snapshotMeteredValue(value[key], out, depth + 1)) return false;
    count += 1;
  }
  out[countIndex] = count;
  return true;
}

// Returns the snapshot index after `value`, or -1 when `value` differs.
function matchMeteredValue(value, snapshot, index) {
  const recorded = snapshot[index];
  if (recorded === SNAPSHOT_ARRAY) {
    const length = snapshot[index + 1];
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) return -1;
    let next = index + 2;
    for (let item = 0; item < length && next >= 0; item += 1) next = matchMeteredValue(value[item], snapshot, next);
    return next;
  }
  if (recorded === SNAPSHOT_OBJECT) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !plainObjectPrototype(value)) return -1;
    const count = snapshot[index + 1];
    let next = index + 2;
    let seen = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (seen === count || snapshot[next] !== key) return -1;
      next = matchMeteredValue(value[key], snapshot, next + 1);
      if (next < 0) return -1;
      seen += 1;
    }
    return seen === count ? next : -1;
  }
  if (value !== null && typeof value === 'object') return -1;
  return Object.is(value, recorded) ? index + 1 : -1;
}

function snapshotMeteredMessage(m) {
  const out = [];
  for (let field = 0; field < METERED_MESSAGE_FIELDS.length; field += 1) {
    if (!snapshotMeteredValue(m[METERED_MESSAGE_FIELDS[field]], out, 0)) return null;
  }
  return out;
}

function meteredMessageUnchanged(m, snapshot) {
  let index = 0;
  for (let field = 0; field < METERED_MESSAGE_FIELDS.length && index >= 0; field += 1) {
    index = matchMeteredValue(m[METERED_MESSAGE_FIELDS[field]], snapshot, index);
  }
  return index >= 0;
}

// The message's current memo entry, or null when it cannot be snapshotted. An
// entry stays the same object exactly while the metered fields are unchanged,
// so its identity also validates anything else derived from those fields.
function meteredMessageEntry(m) {
  if (!m || typeof m !== 'object') return null;
  const cached = meteredMessageMemo.get(m);
  if (cached && meteredMessageUnchanged(m, cached.snapshot)) return cached;
  const snapshot = snapshotMeteredMessage(m);
  if (!snapshot) {
    meteredMessageMemo.delete(m);
    return null;
  }
  const entry = { snapshot, tokens: undefined };
  meteredMessageMemo.set(m, entry);
  return entry;
}

export function estimateMessageTokens(m) {
  const entry = meteredMessageEntry(m);
  if (!entry) return meteredMessageTokens(m);
  entry.tokens ??= meteredMessageTokens(m);
  return entry.tokens;
}

function isReasoningBlock(block) {
  return ['thinking', 'redacted_thinking', 'reasoning'].includes(block?.type) || block?.thought === true;
}

// Split the current message's existing estimate, never add generation usage.
// Use the same replay precedence and opaque-payload meter as the total.
export function messageReasoningBreakdown(message) {
  if (message?.role !== 'assistant') return { tokens: 0, blocks: [], message };
  const blocks = [];
  const withoutReasoning = (items) => {
    if (!Array.isArray(items)) return items;
    blocks.push(...items.filter(isReasoningBlock));
    return items.filter((block) => !isReasoningBlock(block));
  };
  const visible = { ...message, content: withoutReasoning(message.content) };
  if (Array.isArray(message.providerReplay?.items)) {
    visible.providerReplay = { ...message.providerReplay, items: withoutReasoning(message.providerReplay.items) };
  } else {
    for (const key of ['thinkingBlocks', 'assistantBlocks', 'reasoningItems']) {
      if (Array.isArray(message[key])) visible[key] = withoutReasoning(message[key]);
    }
    const gemini = message.providerMetadata?.gemini;
    if (Array.isArray(gemini?.thoughtParts)) {
      visible.providerMetadata = {
        ...message.providerMetadata,
        gemini: { ...gemini, thoughtParts: withoutReasoning(gemini.thoughtParts) },
      };
    }
  }
  return {
    tokens: blocks.length ? Math.max(0, messageTextTokens(message) - messageTextTokens(visible)) : 0,
    blocks,
    message: visible,
  };
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// Context status is polled while the agent loop mutates and replaces message
// arrays. Keep the accumulated summary per transcript: a replacement array
// whose first message is the same object continues from the latest summary of
// that transcript instead of re-metering it. The tail (previous and current)
// is fully re-fingerprinted on every sync, because streaming and failed-call
// argument restoration edit it in place; every earlier entry is confirmed by
// its own identity plus the identity of each estimator-visible field.
// Producer invariant: compaction copies message/call objects, transcript repair
// replaces array entries, stored-tool-args replaces `arguments` only on the
// in-flight assistant turn, and MCP reload replaces tool descriptors; settled
// nested non-string payloads are not mutated in place without replacing their
// containing reference.
const contextMessageMemo = new WeakMap();
const contextTranscriptMemo = new WeakMap();
const contextTranscriptLineage = new WeakMap();
let contextTranscriptRevision = 0;

const { contextMessageFingerprint, sameContextMessageFingerprint, contextMessageFieldsUnchanged } =
  createContextFingerprinter({
    nativeBlocksEstimateText,
    contentImageDescriptors,
  });

// A system reminder's tokens split by section bucket; `otherTokens` is
// whatever the sections do not account for.
function reminderBucketsFor(text, tokens) {
  const buckets = { tokens, otherTokens: tokens };
  let sectionTokens = 0;
  for (const section of splitMarkdownSections(stripSystemReminder(text))) {
    const bucket = reminderSectionBucket(section);
    const sectionTokenCount = estimateTokens(section);
    buckets[bucket] = (buckets[bucket] || 0) + sectionTokenCount;
    sectionTokens += sectionTokenCount;
  }
  buckets.otherTokens = Math.max(0, tokens - sectionTokens);
  return buckets;
}

function systemWorkflowTokensOf(text) {
  let total = 0;
  for (const section of splitMarkdownSections(text)) {
    if (reminderSectionBucket(section) === 'workflow') total += estimateTokens(section);
  }
  return total;
}

function toolCallTokensOf(toolCalls) {
  try {
    return estimateTokens(JSON.stringify(toolCalls));
  } catch {
    return estimateTokens(`[${toolCalls.length} tool calls]`);
  }
}

function contextMessageContribution(message) {
  const cached = message && typeof message === 'object' ? contextMessageMemo.get(message) : null;
  const fingerprint = contextMessageFingerprint(message, cached?.fingerprint);
  if (cached && sameContextMessageFingerprint(cached.fingerprint, fingerprint)) return cached.contribution;
  const role = ['system', 'user', 'assistant', 'tool'].includes(fingerprint.role) ? fingerprint.role : 'other';
  const text = messageEstimateText(message);
  const tokens = meteredMessageTokens(message, text);
  const contribution = {
    role,
    tokens,
    reasoningTokens: messageReasoningBreakdown(message).tokens,
    reminderBuckets: null,
    systemWorkflowTokens: 0,
    toolCallCount: 0,
    toolCallTokens: 0,
    toolResultCount: role === 'tool' ? 1 : 0,
    toolResultTokens: role === 'tool' ? tokens : 0,
  };
  if (
    role === 'user' &&
    String(text || '')
      .trim()
      .startsWith('<system-reminder>')
  ) {
    contribution.reminderBuckets = reminderBucketsFor(text, tokens);
  }
  if (role === 'system') contribution.systemWorkflowTokens = systemWorkflowTokensOf(text);
  if (fingerprint.role === 'assistant' && Array.isArray(message?.toolCalls) && message.toolCalls.length) {
    contribution.toolCallCount = message.toolCalls.length;
    contribution.toolCallTokens = toolCallTokensOf(message.toolCalls);
  }
  if (message && typeof message === 'object') {
    contextMessageMemo.set(message, { fingerprint, contribution });
  }
  return contribution;
}

function emptyContextSummaryState() {
  return {
    rows: {
      system: { count: 0, tokens: 0 },
      user: { count: 0, tokens: 0 },
      assistant: { count: 0, tokens: 0 },
      tool: { count: 0, tokens: 0 },
      other: { count: 0, tokens: 0 },
    },
    semantic: {
      system: { count: 0, tokens: 0 },
      chat: { count: 0, tokens: 0 },
      assistant: { count: 0, tokens: 0 },
      reasoning: { count: 0, tokens: 0 },
      toolResults: { count: 0, tokens: 0 },
      reminders: { count: 0, tokens: 0, otherTokens: 0 },
      workflow: { tokens: 0 },
      memory: { tokens: 0 },
      workspace: { tokens: 0 },
      environment: { tokens: 0 },
      other: { tokens: 0 },
    },
    estimatedTokens: 0,
    toolCallCount: 0,
    toolCallTokens: 0,
    toolResultCount: 0,
    toolResultTokens: 0,
  };
}

function applyContextMessageContribution(state, contribution, direction) {
  const { role, tokens } = contribution;
  state.estimatedTokens += direction * tokens;
  state.rows[role].count += direction;
  state.rows[role].tokens += direction * tokens;
  if (role === 'system') {
    state.semantic.system.count += direction;
    state.semantic.system.tokens += direction * (tokens - contribution.systemWorkflowTokens);
    state.semantic.workflow.tokens += direction * contribution.systemWorkflowTokens;
  } else if (role === 'user') {
    if (contribution.reminderBuckets) {
      state.semantic.reminders.count += direction;
      state.semantic.reminders.tokens += direction * contribution.reminderBuckets.tokens;
      state.semantic.reminders.otherTokens += direction * contribution.reminderBuckets.otherTokens;
      for (const bucket of ['workflow', 'memory', 'workspace', 'environment', 'other']) {
        state.semantic[bucket].tokens += direction * (contribution.reminderBuckets[bucket] || 0);
      }
    } else {
      state.semantic.chat.count += direction;
      state.semantic.chat.tokens += direction * tokens;
    }
  } else if (role === 'assistant') {
    state.semantic.assistant.count += direction;
    state.semantic.assistant.tokens += direction * (tokens - contribution.reasoningTokens);
    state.semantic.reasoning.count += direction * (contribution.reasoningTokens > 0 ? 1 : 0);
    state.semantic.reasoning.tokens += direction * contribution.reasoningTokens;
  } else if (role === 'tool') {
    state.semantic.toolResults.count += direction;
    state.semantic.toolResults.tokens += direction * tokens;
  }
  state.toolCallCount += direction * contribution.toolCallCount;
  state.toolCallTokens += direction * contribution.toolCallTokens;
  state.toolResultCount += direction * contribution.toolResultCount;
  state.toolResultTokens += direction * contribution.toolResultTokens;
}

function contextSummaryResult(state, count) {
  return {
    count,
    estimatedTokens: state.estimatedTokens,
    roles: copySummaryRows(state.rows),
    semantic: copySummaryRows(state.semantic),
    toolCallCount: state.toolCallCount,
    toolCallTokens: state.toolCallTokens,
    toolResultCount: state.toolResultCount,
    toolResultTokens: state.toolResultTokens,
  };
}

export function stripSystemReminder(text) {
  return String(text || '')
    .replace(/^\s*<system-reminder>\s*/i, '')
    .replace(/\s*<\/system-reminder>\s*$/i, '')
    .trim();
}

export function splitMarkdownSections(text) {
  const sections = [];
  let current = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^#\s+/.test(line) && current.length) {
      const body = current.join('\n').trim();
      if (body) sections.push(body);
      current = [line];
    } else {
      current.push(line);
    }
  }
  const tail = current.join('\n').trim();
  if (tail) sections.push(tail);
  return sections;
}

export function reminderSectionBucket(section) {
  const heading = String(section.match(/^#\s+([^\n]+)/)?.[1] || '')
    .trim()
    .toLowerCase();
  if (heading.includes('core memory')) return 'memory';
  if (heading.includes('active workflow') || heading.includes('available agents') || heading.includes('workflow'))
    return 'workflow';
  if (heading.includes('workspace')) return 'workspace';
  if (heading.includes('environment')) return 'environment';
  return 'other';
}

function copySummaryRows(rows) {
  return Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, { ...row }]));
}

// A replacement array starts from its transcript's latest summary; the sync
// below then re-meters only the entries that differ from it.
function forkContextTranscript(parent) {
  return {
    refs: parent.refs.slice(),
    contributions: parent.contributions.slice(),
    state: { ...parent.state, rows: copySummaryRows(parent.state.rows), semantic: copySummaryRows(parent.state.semantic) },
    revision: parent.revision,
    result: parent.result,
    signatures: new Map([...parent.signatures].map(([kind, entries]) => [kind, new Map(entries)])),
  };
}

function contextTranscriptFor(messages) {
  let transcript = contextTranscriptMemo.get(messages);
  if (!transcript) {
    const head = messages[0];
    const parent = head && typeof head === 'object' ? contextTranscriptLineage.get(head) : null;
    transcript = parent
      ? forkContextTranscript(parent)
      : {
          refs: [],
          contributions: [],
          state: emptyContextSummaryState(),
          revision: 0,
          result: null,
          signatures: new Map(),
        };
    contextTranscriptMemo.set(messages, transcript);
  }
  return transcript;
}

// Entry `index` below the previous and current tails keeps its contribution
// while it is the same message whose measured fields are the same references.
function settledContextEntry(transcript, messages, index) {
  const message = messages[index];
  if (transcript.refs[index] !== message || !message || typeof message !== 'object') return false;
  const cached = contextMessageMemo.get(message);
  return (
    !!cached &&
    cached.contribution === transcript.contributions[index] &&
    contextMessageFieldsUnchanged(message, cached.fingerprint)
  );
}

function syncContextTranscript(messages) {
  const transcript = contextTranscriptFor(messages);
  const { refs, contributions, state } = transcript;
  const previousCount = refs.length;
  const count = messages.length;
  const settledCount = Math.max(0, Math.min(previousCount, count) - 1);
  let changed = transcript.result === null;
  for (let index = 0; index < count; index += 1) {
    if (index < settledCount && settledContextEntry(transcript, messages, index)) continue;
    const message = messages[index];
    const contribution = contextMessageContribution(message);
    refs[index] = message;
    const previous = index < previousCount ? contributions[index] : undefined;
    if (previous === contribution) continue;
    if (previous) applyContextMessageContribution(state, previous, -1);
    contributions[index] = contribution;
    applyContextMessageContribution(state, contribution, 1);
    changed = true;
  }
  for (let index = count; index < previousCount; index += 1) {
    applyContextMessageContribution(state, contributions[index], -1);
    changed = true;
  }
  refs.length = count;
  contributions.length = count;
  if (changed) {
    contextTranscriptRevision += 1;
    transcript.revision = contextTranscriptRevision;
    transcript.result = contextSummaryResult(state, count);
  }
  const head = messages[0];
  if (head && typeof head === 'object') contextTranscriptLineage.set(head, transcript);
  return transcript;
}

export function summarizeContextMessages(messages) {
  if (!Array.isArray(messages)) return contextSummaryResult(emptyContextSummaryState(), 0);
  return syncContextTranscript(messages).result;
}

// A stable warm-cache generation for consumers that cache a derived view of
// the whole transcript. Revisions are unique across transcripts and advance
// whenever any entry's contribution changes.
export function contextMessagesRevision(messages) {
  if (!Array.isArray(messages)) return 0;
  return syncContextTranscript(messages).revision;
}

export function summarizeContextMessagesAtRevision(messages, revision) {
  if (Array.isArray(messages)) {
    const cached = contextTranscriptMemo.get(messages);
    if (cached && cached.refs.length === messages.length && cached.revision === revision && cached.result)
      return cached.result;
  }
  return summarizeContextMessages(messages);
}

// Hash only estimator/provider-visible projections. In particular, images
// contribute their visual count but never their raw data-url/base64 bytes.
const CONTEXT_SIGNATURE_COUNTS_MAX = 4;

function samePrefixContributions(previous, current, end) {
  if (previous.length !== end) return false;
  for (let index = 0; index < end; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  return true;
}

// Incremental prefix hashing. A signature is sha256 over
// JSON(identity(message)) + '\0' for each message in order, so the hash state
// after k messages is reusable by any transcript that starts with the same k
// messages. Each `kind` keeps one chain per head message: the messages it has
// absorbed (object + metered-memo entry, which together prove the identity
// projection is unchanged — identities read only METERED_MESSAGE_FIELDS), a
// hash state every SIGNATURE_CHECKPOINT_INTERVAL messages, and the state after
// the last one. A new turn therefore serializes only the messages it appended
// or edited, never the settled transcript before them; the digest is exactly
// the one a from-scratch hash produces.
const SIGNATURE_CHECKPOINT_INTERVAL = 64;
const signatureChains = new WeakMap();

function signatureChainFor(list, kind) {
  const head = list[0];
  if (!head || typeof head !== 'object') return null;
  let chains = signatureChains.get(head);
  if (!chains) {
    chains = new Map();
    signatureChains.set(head, chains);
  }
  let chain = chains.get(kind);
  if (!chain) {
    const origin = createHash('sha256');
    chain = { refs: [], entries: [], checkpoints: [origin], tail: origin };
    chains.set(kind, chain);
  }
  return chain;
}

function hashMessageIdentity(hash, identity) {
  hash.update(JSON.stringify(identity));
  hash.update('\0');
}

function transcriptPrefixDigest(list, end, kind, messageIdentity) {
  const chain = signatureChainFor(list, kind);
  if (!chain) {
    const hash = createHash('sha256');
    for (let index = 0; index < end; index += 1) hashMessageIdentity(hash, messageIdentity(list[index]));
    return hash.digest('hex');
  }
  const limit = Math.min(chain.refs.length, end);
  let valid = 0;
  while (
    valid < limit &&
    list[valid] === chain.refs[valid] &&
    meteredMessageEntry(list[valid]) === chain.entries[valid]
  ) {
    valid += 1;
  }
  if (valid < limit) {
    // Rewind to the last checkpoint inside the still-valid prefix.
    const keep = Math.floor(valid / SIGNATURE_CHECKPOINT_INTERVAL);
    chain.checkpoints.length = keep + 1;
    chain.refs.length = keep * SIGNATURE_CHECKPOINT_INTERVAL;
    chain.entries.length = chain.refs.length;
    chain.tail = chain.checkpoints[keep];
  }
  const chained = chain.refs.length;
  let start = chained;
  let hash;
  if (end >= chained) {
    hash = chain.tail.copy();
  } else {
    const checkpoint = Math.floor(end / SIGNATURE_CHECKPOINT_INTERVAL);
    start = checkpoint * SIGNATURE_CHECKPOINT_INTERVAL;
    hash = chain.checkpoints[checkpoint].copy();
  }
  // Absorb appended messages into the chain; commit only after every identity
  // serialized, so a throwing identity leaves the chain consistent.
  let extending = start === chained;
  const refs = [];
  const entries = [];
  const checkpoints = [];
  let tail = null;
  for (let index = start; index < end; index += 1) {
    const message = list[index];
    if (extending) {
      const entry = meteredMessageEntry(message);
      if (entry) {
        refs.push(message);
        entries.push(entry);
      } else {
        extending = false;
        tail = hash.copy();
      }
    }
    hashMessageIdentity(hash, messageIdentity(message));
    if (extending && (index + 1) % SIGNATURE_CHECKPOINT_INTERVAL === 0) checkpoints.push(hash.copy());
  }
  if (refs.length) {
    for (let index = 0; index < refs.length; index += 1) {
      chain.refs.push(refs[index]);
      chain.entries.push(entries[index]);
    }
    for (const checkpoint of checkpoints) chain.checkpoints.push(checkpoint);
    chain.tail = tail || hash.copy();
  }
  return hash.digest('hex');
}

// The memoized signature over the first `count` messages. An unchanged
// prefix (the same contribution objects) is answered from the transcript's
// `kind` signatures, carried across array replacement, instead of re-hashing
// a whole transcript on every pressure check; otherwise the digest comes from
// the incremental `kind` chain and is remembered per prefix length, most
// recent CONTEXT_SIGNATURE_COUNTS_MAX kept.
function memoizedTranscriptSignature(messages, count, kind, messageIdentity) {
  const list = Array.isArray(messages) ? messages : [];
  const end = Math.max(0, Math.min(list.length, Number.isInteger(count) ? count : list.length));
  let signatures = null;
  let transcript = null;
  if (Array.isArray(messages)) {
    transcript = syncContextTranscript(messages);
    signatures = transcript.signatures.get(kind);
    const previous = signatures?.get(end);
    if (previous && samePrefixContributions(previous.contributions, transcript.contributions, end)) {
      signatures.delete(end);
      signatures.set(end, previous);
      return previous.signature;
    }
  }
  const signature = transcriptPrefixDigest(list, end, kind, messageIdentity);
  if (transcript) {
    const contributions = transcript.contributions.slice(0, end);
    signatures ||= new Map();
    if (signatures.has(end)) signatures.delete(end);
    signatures.set(end, { contributions, signature });
    while (signatures.size > CONTEXT_SIGNATURE_COUNTS_MAX) {
      const oldest = signatures.keys().next().value;
      if (oldest === undefined) break;
      signatures.delete(oldest);
    }
    transcript.signatures.set(kind, signatures);
  }
  return signature;
}

export function contextMessagesSignature(messages, count = messages?.length) {
  return memoizedTranscriptSignature(messages, count, 'exact', (message) => [
    message?.role || '',
    message?.toolCallId || '',
    messageEstimateText(message),
    messageImageAllowance(message),
    messageImageDescriptors(message),
  ]);
}

// Storage-form-independent transcript identity.
//
// A provider baseline is recorded against the LIVE message objects, while every
// cold reader sees the same transcript after the disk projection replaced inline
// media with `[Image omitted from stored history: …]` placeholders. The exact
// signature above therefore CANNOT survive that round-trip, and treating the
// difference as a mutated transcript drops the gauge onto the whole-transcript
// estimate — measured at 1.1x-4.9x the provider's own prompt across real stored
// sessions. This projection reduces media to a per-message count and collapses
// whitespace, so both storage forms of one transcript hash identically while any
// real change to role, tool identity, or text still changes the hash.
const STORED_MEDIA_PLACEHOLDER_RE = /\[(?:Image|File) omitted from stored history[^\]]*\]/g;

function messageShapeText(message) {
  let placeholders = 0;
  const text = messageEstimateText(message).replace(STORED_MEDIA_PLACEHOLDER_RE, () => {
    placeholders += 1;
    return ' ';
  });
  return { text: text.replace(/\s+/g, ' ').trim(), placeholders };
}

export function contextMessagesShapeSignature(messages, count = messages?.length) {
  return memoizedTranscriptSignature(messages, count, 'shape', (message) => {
    const shape = messageShapeText(message);
    return [
      message?.role || '',
      message?.toolCallId || '',
      shape.text,
      messageImageDescriptors(message).length + shape.placeholders,
    ];
  });
}

const toolSchemaAnalysisMemo = new WeakMap();

function isDeferredToolSchema(tool) {
  return tool?.deferLoading === true || tool?.defer_loading === true;
}

function serializeToolSchemas(tools, { excludeDeferred = false } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const nativePrefixCount = providerNativeToolPrefixCount(list);
  try {
    const wire = [];
    list.forEach((tool, index) => {
      const deferred = isDeferredToolSchema(tool);
      if (excludeDeferred && deferred) return;
      if (index < nativePrefixCount) {
        wire.push(tool);
        return;
      }
      const wireTool = {
        name: tool?.name,
        description: tool?.description,
        input_schema: tool?.inputSchema ?? tool?.input_schema ?? tool?.parameters ?? tool?.schema,
      };
      if (deferred) wireTool.defer_loading = true;
      wire.push(wireTool);
    });
    return JSON.stringify(wire);
  } catch {
    return list
      .filter((tool) => !(excludeDeferred && isDeferredToolSchema(tool)))
      .map((t) => String(t?.name ?? ''))
      .join('');
  }
}

export function toolSchemaSignature(tools) {
  return analyzeToolSchemas(tools).signature;
}

function analyzeToolSchemas(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const cached = Array.isArray(tools) ? toolSchemaAnalysisMemo.get(tools) : null;
  if (cached && isFinalizedProviderRequestTools(tools)) return cached;
  const text = serializeToolSchemas(list);
  const signature = createHash('sha256').update(text).digest('hex');
  if (cached && cached.signature === signature) return cached;
  // defer_loading schemas ride the wire but the API excludes them from
  // context-token calculation and prompt-cache keys, so metering them at
  // full weight inflated the request reserve. The SIGNATURE keeps hashing
  // the full serialization (a deferred tool joining/leaving must still
  // re-fingerprint the surface); only the token cost drops deferred entries.
  const meterText = list.some(isDeferredToolSchema) ? serializeToolSchemas(list, { excludeDeferred: true }) : text;
  const analysis = { signature, tokens: estimateTokens(meterText) };
  if (Array.isArray(tools)) toolSchemaAnalysisMemo.set(tools, analysis);
  return analysis;
}

/**
 * Estimate the token cost of the tool/function schemas a provider appends to
 * the request body. These are NOT part of `messages` (they're a separate
 * argument to provider.send), so estimateMessagesTokens() ignores them
 * entirely — a transcript that "fits" by message tokens can still overflow
 * once N tool schemas are serialized into the same request. Best-effort
 * chars/4 over the JSON-serialized definitions.
 */
export function estimateToolSchemaTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return analyzeToolSchemas(tools).tokens;
}

/**
 * Total request-side bytes the caller should reserve out of the context window
 * before compaction. Only serialized tool schemas are counted; providers do
 * not expose a stable framing cost, so no synthetic fixed allowance is added.
 */
export function estimateRequestReserveTokens(tools) {
  return estimateToolSchemaTokens(tools);
}

/**
 * Live/current context numerator SSOT: transcript estimate + request reserve.
 * Provider-reported usage is excluded (secondary metadata only).
 * Empty / no-activity transcript returns 0 so fresh sessions do not show
 * reserve-only phantom usage.
 *
 * @param {unknown[]} messages
 * @param {unknown[]|number} toolsOrReserve tool list or precomputed reserve tokens
 * @param {{ messageCount?: number, estimatedMessageTokens?: number, provider?: string }} [opts]
 */
export function estimateTranscriptContextUsage(messages, toolsOrReserve, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const count = Number.isFinite(Number(opts.messageCount)) ? Number(opts.messageCount) : list.length;
  if (count <= 0 || list.length === 0) return 0;
  const messageTokens = Number.isFinite(Number(opts.estimatedMessageTokens))
    ? Number(opts.estimatedMessageTokens)
    : summarizeContextMessages(list).estimatedTokens;
  const reserve =
    typeof toolsOrReserve === 'number' && Number.isFinite(toolsOrReserve)
      ? Math.max(0, toolsOrReserve)
      : estimateRequestReserveTokens(toolsOrReserve);
  // Provider-aware calibration reconciles the o200k estimate with actual
  // billing (see providerTokenCalibration). No provider → neutral 1.0.
  return Math.round((messageTokens + reserve) * providerTokenCalibration(opts.provider));
}
