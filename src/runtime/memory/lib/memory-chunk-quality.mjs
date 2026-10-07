import { createHash } from 'node:crypto';
import { estimateTokens } from '../../agent/orchestrator/session/token-estimate.mjs';
import { VALID_CATEGORY } from './memory-categories.mjs';

const CHUNK_QUALITY_VERSION = 1;
export const CYCLE1_INPUT_TOKEN_BUDGET = 16000;

// The compression rules are the cycle1-agent role rules
// (rules/agent/40-cycle1-agent.md): they ride the role's system prompt, which
// every call shares and providers cache, so a request carries only its own
// length target and the rows.

// A window whose rows estimate below this is left RAW without an AI call. Its
// summary must be shorter than the rows, which such sources almost never allow
// (ledger 2026-09-23..10-07: 9 of 2,745 committed chunks), while these windows
// made up most of the calls that returned nothing.
const CYCLE1_MIN_SOURCE_TOKENS = 30;

// Writing guides only; acceptance stays "shorter than the source" so the ratio
// can be measured before it is tightened.
function cycle1LengthRule(rows, rewrite) {
  const sourceTokens = chunkCompression('', rows).sourceTokens;
  if (rewrite) {
    return `Rewrite: the previous summary of these rows was longer than the rows themselves (${sourceTokens} runtime-estimated tokens). Keep it under ${Math.max(20, Math.floor(sourceTokens / 2))} tokens: the request, the final answer or decision and any verified result, nothing else.`;
  }
  return `Length target: about ${Math.max(60, Math.floor(sourceTokens / 3))} runtime-estimated tokens in total, roughly one third of the source. A short source needs no filler; its summary must still be shorter than the source.`;
}

// Rows are grouped under one `# session <id>` line per run of the same
// session instead of repeating the id inside every row.
export function chunkSourceText(rows) {
  const lines = [];
  let session;
  rows.forEach((row, i) => {
    const rowSession = row.session_id ?? null;
    if (i === 0 || rowSession !== session) {
      session = rowSession;
      lines.push(`# session ${session ?? 'unknown'}`);
    }
    lines.push(
      `@${i + 1} ${JSON.stringify({
        ts: row.ts ?? null,
        role: row.role ?? null,
        ...(row.element ? { topic: String(row.element) } : {}),
        content: String(row.content ?? ''),
      })}`
    );
  });
  return lines.join('\n');
}

export function cycle1SourceBudget(inputTokenBudget = CYCLE1_INPUT_TOKEN_BUDGET) {
  const budget = Number(inputTokenBudget);
  if (!Number.isFinite(budget) || budget < 4096) throw new Error('cycle1 input_token_budget must be at least 4096');
  // There is no second source-comparison request. Reserve only prompt overhead.
  return Math.floor(budget - 2048);
}

export function buildCycle1ChunkPrompt(rows, { rewrite = false } = {}) {
  return [cycle1LengthRule(rows, rewrite), '', chunkSourceText(rows)].join('\n');
}

export function partitionCycle1Rows(rows, sourceBudget, maxRows = 50) {
  const packets = [];
  let packet = [];
  for (const row of rows) {
    if (
      packet.length &&
      (packet.length >= maxRows || estimateTokens(chunkSourceText([...packet, row])) > sourceBudget)
    ) {
      packets.push(packet);
      packet = [];
    }
    packet.push(row);
  }
  if (packet.length) packets.push(packet);
  return packets;
}

export function parseCycle1LineFormat(raw) {
  const lines = String(raw ?? '')
    .trim()
    .split('\n')
    .filter((line) => line.trim());
  if (!lines.length) return null;
  const chunks = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4 || !/^\d+(?:\s*,\s*\d+)*$/.test(parts[0].trim())) {
      chunks.push({ _idxList: [], _parseError: 'invalid_line_format' });
      continue;
    }
    const indexes = parts[0].split(',').map((value) => Number(value.trim()));
    chunks.push({
      _idxList: indexes,
      element: parts[1].trim(),
      category: parts[2].trim().toLowerCase(),
      summary: parts.slice(3).join('|').trim(),
    });
  }
  return chunks;
}

export function validateCycle1Grouping(chunks, rows) {
  const used = new Set();
  const counts = new Map();
  const accepted = [];
  const invalid = [];
  for (const chunk of chunks || []) {
    for (const n of new Set(chunk._idxList || [])) counts.set(n, (counts.get(n) || 0) + 1);
  }
  for (const chunk of chunks || []) {
    const indexes = chunk._idxList || [];
    let reason = chunk._parseError;
    if (!reason && (!indexes.length || indexes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > rows.length))) {
      reason = 'out_of_range_idx';
    }
    if (!reason && (indexes.some((n) => counts.get(n) > 1) || new Set(indexes).size !== indexes.length)) {
      reason = 'duplicate_member_ids';
    }
    if (!reason && (!chunk.element || !chunk.summary || !VALID_CATEGORY.has(chunk.category)))
      reason = 'incomplete_fields';
    if (!reason && new Set(indexes.map((n) => rows[n - 1].session_id ?? null)).size !== 1) reason = 'mixed_sessions';
    if (reason) {
      invalid.push({
        reason,
        idx_list: indexes,
        member_ids: [
          ...new Set(
            indexes
              .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= rows.length)
              .map((n) => Number(rows[n - 1].id))
          ),
        ],
      });
    } else {
      accepted.push(chunk);
      for (const n of indexes) used.add(n);
    }
  }
  const omitted = rows.map((_, i) => i + 1).filter((n) => !used.has(n));
  const errors = [...new Set(invalid.map((item) => item.reason))];
  if (omitted.length) errors.push('omitted_rows');
  return { valid: errors.length === 0 && !!chunks?.length, errors, omitted, accepted, invalid };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalMembers(members) {
  return members
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => [
      String(row.id),
      row.session_id ?? null,
      String(row.ts),
      row.role ?? null,
      String(row.content ?? ''),
    ]);
}

function chunkCompression(summary, members) {
  const sourceTokens = estimateTokens(members.map((row) => String(row.content ?? '')).join('\n'));
  const summaryTokens = estimateTokens(String(summary ?? '').trim());
  return { sourceTokens, summaryTokens, shorter: summaryTokens > 0 && summaryTokens < sourceTokens };
}

export function makeChunkQuality(summary, members) {
  const { sourceTokens, summaryTokens } = chunkCompression(summary, members);
  return {
    version: CHUNK_QUALITY_VERSION,
    verification: 'structural',
    memberIds: members.map((row) => String(row.id)).sort(),
    sourceHash: hash(JSON.stringify(canonicalMembers(members))),
    summaryHash: hash(String(summary).trim()),
    sourceTokens,
    summaryTokens,
    verifiedAt: Date.now(),
  };
}

// Legacy chunks are eligible without an AI-verification record. Cheap source,
// membership and size checks still apply. Known stale provenance is not ignored.
export function assessChunkQuality(root, members = root?.members) {
  const source = Array.isArray(members) ? members : [];
  const reasons = [];
  if (!source.length || source.some((row) => row.content == null || row.id == null)) reasons.push('missing_source');
  if (new Set(source.map((row) => String(row.id))).size !== source.length) reasons.push('duplicate_members');
  if (new Set(source.map((row) => row.session_id ?? null)).size > 1) reasons.push('mixed_sessions');
  const compression = chunkCompression(root?.summary, source);
  if (!compression.shorter) reasons.push('not_shorter');
  const quality = root?.chunk_quality;
  if (quality) {
    if (
      quality.version !== CHUNK_QUALITY_VERSION ||
      !['structural', 'source-comparison'].includes(quality.verification)
    ) {
      reasons.push('invalid_provenance');
    }
    const expected = makeChunkQuality(root?.summary, source);
    if (
      quality.sourceHash !== expected.sourceHash ||
      JSON.stringify(quality.memberIds) !== JSON.stringify(expected.memberIds)
    ) {
      reasons.push('source_changed');
    }
    if (quality.summaryHash !== expected.summaryHash) reasons.push('summary_changed');
  }
  return { usable: reasons.length === 0, reasons, provenance: quality?.verification ?? 'legacy', ...compression };
}

// Splitting is reversible, including whitespace, surrogate pairs and a final
// short fragment. A fragment is never committed independently of its source row.
export function splitCycle1Row(row, sourceBudget) {
  const content = String(row.content ?? '');
  const fragments = [];
  let offset = 0;
  while (offset < content.length) {
    let low = 1;
    let high = content.length - offset;
    let length = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (estimateTokens(chunkSourceText([{ ...row, content: content.slice(offset, offset + mid) }])) <= sourceBudget) {
        length = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (length > 0 && /[\uD800-\uDBFF]/.test(content[offset + length - 1]) && offset + length < content.length)
      length -= 1;
    if (length < 1) throw new Error('cycle1 row metadata exceeds source token budget');
    fragments.push({ ...row, content: content.slice(offset, offset + length) });
    offset += length;
  }
  return fragments.length ? fragments : [row];
}

/**
 * One packet in, its accepted chunks out: prompt the model, parse and
 * validate the grouping, and separate the chunks that actually compressed
 * from the ones that came back longer than their rows. `stats` and
 * `failures` are the caller's own accumulators.
 */
function createCycle1PacketGenerator({ callLlm, request, signal, inputTokenBudget, stats, failures }) {
  const call = async (prompt) => {
    signal?.throwIfAborted();
    if (estimateTokens(prompt) > inputTokenBudget) throw new Error('cycle1 prompt exceeds input token budget');
    const started = Date.now();
    stats.groupingCalls += 1;
    try {
      const response = await callLlm({ ...request, mode: 'cycle1', signal }, prompt);
      signal?.throwIfAborted();
      return response;
    } finally {
      const elapsed = Date.now() - started;
      stats.llmMs += elapsed;
    }
  };

  async function generatePacket(packet, { rewrite = false } = {}) {
    const parsed = parseCycle1LineFormat(await call(buildCycle1ChunkPrompt(packet, { rewrite })));
    const validity = validateCycle1Grouping(parsed, packet);
    failures.push(...validity.invalid);
    if (!parsed) failures.push({ reason: 'unparseable_response', member_ids: packet.map((row) => Number(row.id)) });
    const chunks = [];
    const expanded = [];
    for (const chunk of validity.accepted) {
      const shorter = chunkCompression(
        chunk.summary,
        chunk._idxList.map((n) => packet[n - 1])
      ).shorter;
      (shorter ? chunks : expanded).push(chunk);
    }
    return { chunks, expanded };
  }

  // A grouping that came back longer than its rows gets one rewrite of just
  // those rows, so a brief exchange is condensed instead of falling back to
  // the hourly retry. A rewrite that is still longer leaves the rows RAW.
  async function generateWithRewrite(packet) {
    const generated = await generatePacket(packet);
    if (!generated.expanded.length) return generated.chunks;
    stats.retries += 1;
    const subset = generated.expanded
      .flatMap((chunk) => chunk._idxList)
      .sort((a, b) => a - b)
      .map((n) => packet[n - 1]);
    const original = new Map(packet.map((row, i) => [row, i + 1]));
    const rewritten = await generatePacket(subset, { rewrite: true });
    return [
      ...generated.chunks,
      ...rewritten.chunks.map((chunk) => ({
        ...chunk,
        _idxList: chunk._idxList.map((n) => original.get(subset[n - 1])),
      })),
    ];
  }

  return { generatePacket, generateWithRewrite };
}

export async function generateCycle1Chunks(
  rows,
  {
    callLlm,
    request = {},
    inputTokenBudget = CYCLE1_INPUT_TOKEN_BUDGET,
    signal = request.signal,
  } = {}
) {
  const startedAt = Date.now();
  const stats = { groupingCalls: 0, verificationCalls: 0, llmMs: 0, verificationMs: 0, retries: 0, fragments: 0 };
  const sourceBudget = cycle1SourceBudget(inputTokenBudget);
  const failures = [];
  const result = (candidates) => projectCycle1Result({ candidates, rows, failures, stats, startedAt });
  const { generatePacket, generateWithRewrite } = createCycle1PacketGenerator({
    callLlm,
    request,
    signal,
    inputTokenBudget,
    stats,
    failures,
  });

  let chunks = [];
  if (!rows.length || chunkCompression('', rows).sourceTokens < CYCLE1_MIN_SOURCE_TOKENS) return result([]);
  try {
    if (estimateTokens(chunkSourceText(rows)) > sourceBudget) {
      if (rows.length !== 1) {
        const indexes = new Map(rows.map((row, i) => [String(row.id), i + 1]));
        for (const packet of partitionCycle1Rows(rows, sourceBudget)) {
          const generated = await generateCycle1Chunks(packet, { callLlm, request, inputTokenBudget, signal });
          for (const key of Object.keys(stats)) stats[key] += Number(generated.stats[key] || 0);
          failures.push(...generated.invalidChunks);
          chunks.push(
            ...generated.chunks.map((chunk) => ({
              ...chunk,
              _idxList: chunk.members.map((member) => indexes.get(String(member.id))),
            }))
          );
        }
        return result(chunks);
      }
      const fragments = splitCycle1Row(rows[0], sourceBudget);
      stats.fragments = fragments.length;
      const parts = [];
      for (const fragment of fragments) {
        const generated = await generatePacket([fragment]);
        // Uncompressible fragments remain verbatim inside the complete row;
        // no fragment, including a short final condition, disappears.
        if (!generated.chunks.length && failures.length) return result([]);
        parts.push(generated.chunks[0] || { element: '', category: 'fact', summary: fragment.content });
      }
      const summary = parts
        .map((part, i) => `${i && (part.element || parts[i - 1].element) ? '\n' : ''}${part.summary}`)
        .join('');
      if (chunkCompression(summary, rows).shorter) {
        const metadata = parts.find((part) => part.element);
        if (metadata) chunks = [{ ...metadata, _idxList: [1], summary }];
      }
    } else chunks = await generateWithRewrite(rows);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    failures.push({
      reason: 'llm_error',
      member_ids: rows.map((row) => Number(row.id)),
      error: String(error?.message || error),
    });
    chunks = [];
  }
  return result(chunks);
}

/**
 * What one cycle1 pass reports: the accepted chunks with their members and
 * quality, the rows left raw, the recorded failures and the call stats.
 */
function projectCycle1Result({ candidates, rows, failures, stats, startedAt }) {
  const covered = new Set();
  const accepted = candidates
    .map((chunk) => {
      const members = chunk._idxList
        .slice()
        .sort((a, b) => a - b)
        .map((n) => rows[n - 1]);
      for (const member of members) covered.add(String(member.id));
      return { ...chunk, members, quality: makeChunkQuality(chunk.summary, members) };
    })
    .sort((a, b) => Math.min(...a._idxList) - Math.min(...b._idxList));
  return {
    chunks: accepted,
    rawRowIds: rows.filter((row) => !covered.has(String(row.id))).map((row) => Number(row.id)),
    invalidChunks: failures,
    stats: { ...stats, totalMs: Date.now() - startedAt },
  };
}
