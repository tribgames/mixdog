// Steering-message normalization/merge helpers.
// Merges queued steering entries into a single content payload + display text.

function steeringContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image') return '[Image]';
        return part?.text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

function steeringEntryMetadata(entry) {
  if (!entry || typeof entry !== 'object') return {};
  let sourceIds = [];
  if (Array.isArray(entry.ids)) sourceIds = entry.ids;
  else if (entry.id !== undefined && entry.id !== null) sourceIds = [entry.id];
  const ids = [...new Set(sourceIds.filter((id) => id !== undefined && id !== null))];
  const submittedAt = Number(entry.submittedAt);
  return {
    ...(ids.length ? { ids } : {}),
    ...(Number.isFinite(submittedAt) && submittedAt > 0 ? { submittedAt } : {}),
    ...(Array.isArray(entry.images) && entry.images.length ? { images: entry.images } : {}),
    ...(entry.transcriptMeta && typeof entry.transcriptMeta === 'object'
      ? { transcriptMeta: { ...entry.transcriptMeta } }
      : {}),
    // Queue mode + execution provenance (pending-messages): a task
    // notification keeps its identity through the merge so the loop can
    // store it apart from what the user typed.
    ...(typeof entry.mode === 'string' && entry.mode ? { mode: entry.mode } : {}),
    ...(entry.execution && typeof entry.execution === 'object' ? { execution: { ...entry.execution } } : {}),
  };
}

function normalizeSteeringEntry(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text ? { content: text, text } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const metadata = steeringEntryMetadata(entry);
  const content = Object.hasOwn(entry, 'content') ? entry.content : entry;
  const text = typeof entry.text === 'string' ? entry.text.trim() : steeringContentText(content).trim();
  if (Array.isArray(content)) return content.length > 0 ? { content, text, ...metadata } : null;
  if (typeof content === 'string') {
    const value = content.trim();
    return value ? { content: value, text: text || value, ...metadata } : null;
  }
  const fallback = steeringContentText(content).trim();
  return fallback ? { content: fallback, text: text || fallback, ...metadata } : null;
}

function mergeSteeringMetadata(entries) {
  const ids = [...new Set(entries.flatMap((entry) => (Array.isArray(entry.ids) ? entry.ids : [])))];
  const submittedTimes = entries
    .map((entry) => Number(entry.submittedAt))
    .filter((value) => Number.isFinite(value) && value > 0);
  const images = entries.flatMap((entry) => (Array.isArray(entry.images) ? entry.images : []));
  const transcriptMeta = entries.find(
    (entry) => entry.transcriptMeta && typeof entry.transcriptMeta === 'object'
  )?.transcriptMeta;
  // A merged message is a task notification only when EVERY part is one;
  // any typed text in the batch makes it the user's turn (callers group
  // by mode before merging, so mixed batches are the legacy path).
  const notification = entries.length > 0 && entries.every((entry) => entry.mode === 'task-notification');
  const execution = notification
    ? entries.find((entry) => entry.execution && typeof entry.execution === 'object')?.execution
    : null;
  return {
    ...(ids.length ? { ids } : {}),
    ...(submittedTimes.length ? { submittedAt: Math.min(...submittedTimes) } : {}),
    ...(images.length ? { images } : {}),
    ...(transcriptMeta ? { transcriptMeta: { ...transcriptMeta } } : {}),
    ...(notification ? { mode: 'task-notification' } : {}),
    ...(execution ? { execution: { ...execution } } : {}),
  };
}

// Shared merge core for queued user input. N already-normalized
// {content, text} entries collapse into ONE turn message — all-string content
// stays a joined string, anything structured becomes a parts array — plus the
// newline-joined display text. The loop's steering queue and the cross-process
// pending-message spool both route through this, so the two can never drift on
// how queued input reaches a turn. `contentText` is the caller's own
// content→text projection (attachment-aware for prompts, plain for steering).
export function mergeNormalizedContentEntries(normalized, contentText) {
  if (normalized.length === 0) return null;
  const displayText = normalized
    .map((entry) => entry.text || contentText(entry.content))
    .filter((text) => String(text || '').trim())
    .join('\n');
  if (normalized.every((entry) => typeof entry.content === 'string')) {
    return {
      content: normalized
        .map((entry) => entry.content)
        .filter(Boolean)
        .join('\n'),
      text: displayText,
      count: normalized.length,
    };
  }
  const parts = [];
  for (const entry of normalized) {
    if (typeof entry.content === 'string') {
      if (entry.content.trim()) parts.push({ type: 'text', text: entry.content });
    } else if (Array.isArray(entry.content)) {
      parts.push(...entry.content);
    } else {
      const text = contentText(entry.content);
      if (text.trim()) parts.push({ type: 'text', text });
    }
    parts.push({ type: 'text', text: '\n' });
  }
  while (parts.length && parts[parts.length - 1]?.type === 'text' && parts[parts.length - 1]?.text === '\n')
    parts.pop();
  return { content: parts, text: displayText || contentText(parts), count: normalized.length };
}

export function mergeSteeringEntries(entries) {
  const normalized = (Array.isArray(entries) ? entries : []).map(normalizeSteeringEntry).filter(Boolean);
  const merged = mergeNormalizedContentEntries(normalized, steeringContentText);
  return merged ? { ...merged, ...mergeSteeringMetadata(normalized) } : null;
}

// Append one merged steering entry to the transcript and report it to the host.
function injectSteeringEntry(merged, { messages, opts, stage, onSkillPrompt }) {
  const submissionIds = Array.isArray(merged.ids) ? merged.ids : [];
  const rawSubmittedAt = Number(merged.submittedAt);
  const submittedAt = Number.isFinite(rawSubmittedAt) && rawSubmittedAt > 0 ? rawSubmittedAt : undefined;
  const injectedAt = Date.now();
  const steeringTranscriptMeta =
    merged.transcriptMeta && typeof merged.transcriptMeta === 'object'
      ? { at: submittedAt ?? injectedAt, ...merged.transcriptMeta }
      : null;
  // Tag steering-origin user messages so provider lowering keeps them
  // distinct from preceding tool results. Keep each queued command as
  // its own user turn instead of collapsing priority/mode buckets
  // together.
  // A drained task notification is the runtime reporting, not the
  // user speaking: it keeps the user role the wire needs but is
  // stored under its own source with its execution provenance, so
  // envelope classification and the transcript never mistake it
  // for typed input.
  const notification = merged.mode === 'task-notification';
  const execution =
    notification && merged.execution && typeof merged.execution === 'object' ? { ...merged.execution } : null;
  messages.push({
    role: 'user',
    content: merged.content,
    meta: {
      source: notification ? 'task-notification' : 'steering',
      ...(execution ? { execution } : {}),
      ...(submissionIds.length ? { submissionIds } : {}),
      ...(steeringTranscriptMeta ? { transcript: steeringTranscriptMeta } : {}),
    },
  });
  if (!notification) onSkillPrompt(merged.content);
  const text = merged.text || steeringContentText(merged.content);
  try {
    opts.onSteerMessage?.(text, {
      ids: submissionIds,
      submittedAt,
      injectedAt,
      stage,
      ...(notification ? { mode: 'task-notification' } : {}),
      ...(execution ? { execution } : {}),
      ...(Array.isArray(merged.images) && merged.images.length ? { images: merged.images } : {}),
      ...(steeringTranscriptMeta ? { transcriptMeta: steeringTranscriptMeta } : {}),
    });
  } catch {}
  return {
    count: Number(merged.count) || 1,
    textLength: String(text || '').length,
    queueWaitMs: submittedAt === undefined ? 0 : injectedAt - submittedAt,
  };
}

// Drain of the host's queued steering/prompt entries into the live transcript.
// The drain is synchronous (terminal guards depend on that) and returns whether
// anything was injected. `onSkillPrompt` receives each typed entry so the loop
// can run its policy-checked skill selection before the next provider snapshot.
export function createSteeringDrain({ messages, opts, sessionId, onSkillPrompt }) {
  return function drainSteeringIntoMessages(stage = 'mid-turn', options = {}) {
    if (typeof opts.drainSteering !== 'function') return false;
    let steerMsgs = [];
    // The stage rides along so the host can scope which queues a drain may
    // consume (mid-turn tool-batch boundary vs the terminal pending-input
    // check that precedes the stop hooks).
    try {
      steerMsgs = opts.drainSteering(sessionId, { ...options, stage }) || [];
    } catch {
      steerMsgs = [];
    }
    const mergedMessages = [];
    for (const entry of Array.isArray(steerMsgs) ? steerMsgs : []) {
      const merged = mergeSteeringEntries([entry]);
      if (merged) mergedMessages.push(merged);
    }
    if (mergedMessages.length === 0) return false;
    if (typeof options.beforeAppend === 'function') {
      try {
        options.beforeAppend();
      } catch {
        /* best-effort hook */
      }
    }
    let totalCount = 0;
    let totalTextLen = 0;
    let maxQueueWaitMs = 0;
    for (const merged of mergedMessages) {
      const injected = injectSteeringEntry(merged, { messages, opts, stage, onSkillPrompt });
      totalCount += injected.count;
      totalTextLen += injected.textLength;
      maxQueueWaitMs = Math.max(maxQueueWaitMs, injected.queueWaitMs);
    }
    if (sessionId) {
      try {
        process.stderr.write(
          `[steer] sess=${sessionId} injected ${stage} user message(s)` +
            ` (merged=${totalCount} len=${totalTextLen} waitMs=${Math.max(0, maxQueueWaitMs)})\n`
        );
      } catch {}
    }
    return true;
  };
}
