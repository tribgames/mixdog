export function mergeTranscript(items, streamingTail) {
  const settled = Array.isArray(items) ? items : [];
  if (!streamingTail) return settled;
  const tailId = streamingTail?.id;
  if (tailId !== undefined && tailId !== null) {
    const match = settled.findIndex((item) => item?.id === tailId);
    if (match >= 0) {
      const merged = settled.slice();
      merged[match] = streamingTail;
      return merged;
    }
  }
  return [...settled, streamingTail];
}

function stableItemKey(item, index) {
  if (item?.id !== undefined && item?.id !== null) return String(item.id);
  return `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
}

export function transcriptTurnKeys(items) {
  const transcript = Array.isArray(items) ? items : [];
  const keys = [];
  let activeTurn = null;
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind === 'user') activeTurn = `turn:${stableItemKey(item, index)}`;
    if (!activeTurn) activeTurn = `segment:${stableItemKey(item, index)}`;
    keys.push(activeTurn);
    if (item?.kind === 'turndone') activeTurn = null;
  }
  return keys;
}

function explicitTranscriptFailure(item) {
  const kind = String(item?.kind || '').toLowerCase();
  const status = String(item?.status || '').toLowerCase();
  const tone = String(item?.tone || '').toLowerCase();
  return kind === 'error' || status === 'error' || status === 'failed' || tone === 'error';
}

export function reconcileTurnFailures(_previous, items, _toasts, scope = '') {
  const transcript = Array.isArray(items) ? items : [];
  const turnKeys = transcriptTurnKeys(transcript);
  const outcomes = new Map();
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    const turnKey = turnKeys[index];
    if (!turnKey) continue;
    const outcome = outcomes.get(turnKey) || { explicitFailure: false, terminalStatus: '' };
    if (item?.kind === 'turndone') {
      outcome.terminalStatus = String(item.status || '').toLowerCase();
      if (!outcome.terminalStatus && explicitTranscriptFailure(item)) outcome.explicitFailure = true;
    } else if (explicitTranscriptFailure(item)) {
      outcome.explicitFailure = true;
    }
    outcomes.set(turnKey, outcome);
  }

  const failed = [];
  for (const [turnKey, outcome] of outcomes) {
    // A turndone item is the core's authoritative final outcome. Cancelled turns
    // are intentionally not converted to failures; TranscriptRow renders those
    // as interrupted. Before turndone exists, an explicit transcript error may
    // still surface a pending failure. Ephemeral UI toasts never affect either.
    if (outcome.terminalStatus === 'failed'
      || (!outcome.terminalStatus && outcome.explicitFailure)) failed.push(turnKey);
  }

  const current = {
    failedTurnKeys: failed,
    activeToastTurns: {},
  };
  return {
    scope,
    ...current,
    scopes: {
      [scope]: current,
    },
  };
}

export function shouldAutoFollow({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 }, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function followAfterScroll(current, programmatic, viewport) {
  return programmatic ? current : shouldAutoFollow(viewport);
}

export function isScrollIntentKey(key) {
  return ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key);
}

export function shouldNavigatePromptHistory({
  key = '',
  value = '',
  selectionStart = 0,
  selectionEnd = selectionStart,
  shiftKey = false,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
  historyActive = false,
} = {}) {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
  if (shiftKey || ctrlKey || metaKey || selectionStart !== selectionEnd) return false;
  const text = String(value || '');
  const start = Math.max(0, Number(selectionStart) || 0);
  const end = Math.max(start, Number(selectionEnd) || start);
  if (altKey) return true;
  if (key === 'ArrowUp') return !text.trim() || start === 0;
  return historyActive && end === text.length;
}

export function mergeModelCatalog(current, incoming) {
  const models = new Map();
  for (const option of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const provider = String(option?.provider || '').trim();
    const model = String(option?.model || '').trim();
    if (!provider || !model) continue;
    models.set(`${provider}\n${model}`, option);
  }
  return [...models.values()];
}

export function approvalInstanceKey(id) {
  return String(id || 'approval');
}

export function isApprovalDismissKey(key) {
  return key === 'Escape';
}

export function focusTrapIndex(currentIndex, count, backwards = false) {
  if (count <= 0) return -1;
  if (currentIndex < 0) return backwards ? count - 1 : 0;
  return (currentIndex + (backwards ? -1 : 1) + count) % count;
}

export function draftAfterSubmission(currentDraft, submittedText, accepted) {
  return accepted === true && currentDraft === submittedText ? '' : currentDraft;
}

export async function attemptApproval(resolve, approved) {
  try {
    const result = await resolve(approved);
    return result !== false && result !== undefined;
  } catch {
    return false;
  }
}

export function normalizeApplyPatch(value) {
  const input = String(value || '').replace(/\r\n?/g, '\n');
  if (!/^\*\*\* Begin Patch\s*$/m.test(input)) return input;
  const lines = input.split('\n');
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (!match) continue;
    const [, operation, fileName] = match;
    const body = [];
    for (index += 1; index < lines.length && !/^\*\*\* (?:Add|Delete|Update|End) (?:File:|Patch)/.test(lines[index]); index += 1) {
      if (!/^\*\*\* Move to: /.test(lines[index])) body.push(lines[index]);
    }
    index -= 1;
    const oldName = operation === 'Add' ? '/dev/null' : `a/${fileName}`;
    const newName = operation === 'Delete' ? '/dev/null' : `b/${fileName}`;
    let patchBody = body.join('\n').replace(/\n+$/, '');
    if (operation === 'Add' && patchBody && !/^@@/m.test(patchBody)) {
      const added = patchBody.split('\n').filter((line) => line.startsWith('+')).length;
      patchBody = `@@ -0,0 +1,${added} @@\n${patchBody}`;
    }
    sections.push([
      `diff --git a/${fileName} b/${fileName}`,
      `--- ${oldName}`,
      `+++ ${newName}`,
      patchBody,
    ].filter(Boolean).join('\n'));
  }
  return sections.length ? sections.join('\n') : input;
}

function namesFor(section) {
  const gitNames = section.match(/^diff --git "?(?:a\/)?(.+?)"? "?(?:b\/)?(.+?)"?$/m);
  const oldName = section.match(/^---\s+"?(?:a\/)?(.+?)"?(?:\t.*)?$/m)?.[1];
  const newName = section.match(/^\+\+\+\s+"?(?:b\/)?(.+?)"?(?:\t.*)?$/m)?.[1];
  return {
    oldName: oldName && oldName !== '/dev/null' ? oldName : gitNames?.[1] || 'before',
    newName: newName && newName !== '/dev/null' ? newName : gitNames?.[2] || oldName || 'after',
  };
}

function parseFileSection(section) {
  const lines = section.replace(/\r\n?/g, '\n').split('\n');
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) hunks.push(current.join('\n'));
  const { oldName, newName } = namesFor(section);
  return {
    oldFile: { fileName: oldName, content: '' },
    newFile: { fileName: newName, content: '' },
    hunks,
    patch: section,
    renderable: hunks.length > 0,
  };
}

function hasLeadingDiffContent(prefix) {
  const normalized = prefix.replace(/\r\n?/g, '\n');
  if (/^@@(?:\s|$)/m.test(normalized)) return true;
  return /^---\s.+\n\+\+\+\s.+$/m.test(normalized);
}

export function parseUnifiedDiff(patch) {
  const normalized = String(patch || '').replace(/\r\n?/g, '\n');
  const starts = [];
  const marker = /^diff --git .+$/gm;
  for (let match = marker.exec(normalized); match; match = marker.exec(normalized)) starts.push(match.index);
  if (starts.length === 0) {
    const plainHeader = /^---\s.+\n\+\+\+\s.+$/gm;
    for (let match = plainHeader.exec(normalized); match; match = plainHeader.exec(normalized)) starts.push(match.index);
  }
  const sections = starts.length === 0
    ? [normalized]
    : [
      ...(starts[0] > 0 && hasLeadingDiffContent(normalized.slice(0, starts[0]))
        ? [normalized.slice(0, starts[0])]
        : []),
      ...starts.map((start, index) => normalized.slice(start, starts[index + 1] ?? normalized.length)),
    ];
  return sections.map(parseFileSection);
}
