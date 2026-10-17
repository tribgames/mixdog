function stableItemKey(item, index) {
  if (item?.id !== undefined && item?.id !== null) return String(item.id);
  return `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
}

import { transcriptTurnKeys } from '../../../../src/runtime/shared/transcript-turn-keys.mjs';
export { transcriptTurnKeys };

export function turnReviewScope(items) {
  const transcript = Array.isArray(items) ? items : [];
  let activeStart = -1;
  let latestStart = -1;
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind === 'user' && activeStart < 0) {
      activeStart = index;
      latestStart = index;
    }
    if (item?.kind === 'turndone') activeStart = -1;
  }
  const startIndex = activeStart >= 0 ? activeStart : latestStart;
  let hasActivity = false;
  for (let index = startIndex + 1; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item && item.kind !== 'user') {
      hasActivity = true;
      break;
    }
  }
  return {
    startIndex,
    key: startIndex >= 0 ? stableItemKey(transcript[startIndex], startIndex) : 'none',
    hasActivity,
    // Rows without the prompt that opened their turn: the daemon's
    // byte-budgeted transcript tail cut it off, so every row left still
    // belongs to that turn.
    truncated: startIndex < 0 && transcript.length > 0,
  };
}

export function shouldShowFastControl(routeFastCapable, selectedModelFastCapable) {
  return routeFastCapable === true || selectedModelFastCapable === true;
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
    if (outcome.terminalStatus === 'failed' || (!outcome.terminalStatus && outcome.explicitFailure))
      failed.push(turnKey);
  }

  const current = {
    failedTurnKeys: failed,
    activeToastTurns: {},
    turnKeys,
  };
  return {
    scope,
    ...current,
    scopes: {
      [scope]: current,
    },
  };
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
  allowNonEmpty = false,
} = {}) {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
  if (shiftKey || ctrlKey || metaKey || altKey || selectionStart !== selectionEnd) return false;
  const text = String(value || '');
  const start = Math.max(0, Number(selectionStart) || 0);
  const end = Math.max(start, Number(selectionEnd) || start);
  if (!historyActive && !allowNonEmpty && text.length > 0) return false;
  if (key === 'ArrowUp') {
    return text.lastIndexOf('\n', Math.max(0, start - 1)) === -1;
  }
  return historyActive && text.indexOf('\n', end) === -1;
}

// Enter grammar for the composer: Shift/Ctrl/Meta/Alt+Enter break the line and
// plain Enter sends. Only the modifier state at the Enter keydown counts, so a
// Shift still held from typing '?' keeps Shift+Enter a newline.
export function isComposerNewlineChord({
  key = '',
  shiftKey = false,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
} = {}) {
  if (key !== 'Enter') return false;
  return Boolean(shiftKey || ctrlKey || metaKey || altKey);
}

export function shouldInterruptPrompt({ turnBusy = false, pendingSubmissionId = '', draftMode = false } = {}) {
  return Boolean(turnBusy || (!draftMode && String(pendingSubmissionId || '').trim()));
}

export function shouldBlockPromptSubmit({ submitting = false, slashCommand = false } = {}) {
  // Sessions and drafts both take another prompt into the same engine queue
  // immediately: a draft's follow-up joins the session its first submit is
  // minting. Only slash commands need a single acknowledgement owner.
  return Boolean(submitting && slashCommand);
}

export function hasSendablePromptContent({ text = '', attachments = [] } = {}) {
  return Boolean(
    String(text || '').trim() ||
      (Array.isArray(attachments) &&
        attachments.some((attachment) => attachment && (!attachment.token || attachment.chipOnly === true)))
  );
}

export function shouldStopComposerGeneration({ turnBusy = false, text = '', attachments = [] } = {}) {
  return Boolean(turnBusy && !hasSendablePromptContent({ text, attachments }));
}

export function approvalInstanceKey(id) {
  return String(id || 'approval');
}

export function isApprovalDismissKey(key) {
  return key === 'Escape';
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
    for (
      index += 1;
      index < lines.length && !/^\*\*\* (?:Add|Delete|Update|End) (?:File:|Patch)/.test(lines[index]);
      index += 1
    ) {
      if (!/^\*\*\* Move to: /.test(lines[index])) body.push(lines[index]);
    }
    index -= 1;
    const oldName = operation === 'Add' ? '/dev/null' : `a/${fileName}`;
    const newName = operation === 'Delete' ? '/dev/null' : `b/${fileName}`;
    let mode = '';
    if (operation === 'Add') mode = 'new file mode 100644';
    else if (operation === 'Delete') mode = 'deleted file mode 100644';
    let patchBody = body.join('\n').replace(/\n+$/, '');
    if (operation === 'Add' && patchBody && !/^@@/m.test(patchBody)) {
      const added = patchBody.split('\n').filter((line) => line.startsWith('+')).length;
      patchBody = `@@ -0,0 +1,${added} @@\n${patchBody}`;
    }
    sections.push(
      [`diff --git a/${fileName} b/${fileName}`, mode, `--- ${oldName}`, `+++ ${newName}`, patchBody]
        .filter(Boolean)
        .join('\n')
    );
  }
  return sections.length ? sections.join('\n') : input;
}

const RANGED_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

// V4A apply_patch hunks carry bare `@@` (or `@@ <context>`) headers with no
// line ranges. The Shiki diff renderer rejects rangeless headers, so every
// consumer fell back to the raw <pre> patch text. renderPatch rewrites those
// headers with synthetic ranges (counts are accurate, positions approximate)
// for RENDERING ONLY; `patch` stays byte-faithful for copy actions.
function renderablePatch(section, hunks) {
  if (hunks.length === 0 || hunks.every((hunk) => RANGED_HUNK_HEADER.test(hunk))) return section;
  const headerEnd = section.search(/^@@/m);
  const header = headerEnd > 0 ? section.slice(0, headerEnd) : '';
  let oldStart = 1;
  let newStart = 1;
  const rebuilt = hunks.map((hunk) => {
    const [head, ...rest] = hunk.split('\n');
    while (rest.length && rest.at(-1) === '') rest.pop();
    // Blank context lines must carry the leading space a valid diff requires.
    const body = rest.map((line) => (line === '' ? ' ' : line));
    const counted = body.filter((line) => !line.startsWith('\\'));
    const oldCount = counted.filter((line) => !line.startsWith('+')).length;
    const newCount = counted.filter((line) => !line.startsWith('-')).length;
    const declared = head.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (declared) {
      oldStart = Number(declared[1]) + Number(declared[2] ?? 1);
      newStart = Number(declared[3]) + Number(declared[4] ?? 1);
      return hunk;
    }
    const context = head
      .replace(/^@@+\s*/, '')
      .replace(/\s*@@\s*$/, '')
      .trim();
    const rewritten = [
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${context ? ` ${context}` : ''}`,
      ...body,
    ].join('\n');
    oldStart += oldCount;
    newStart += newCount;
    return rewritten;
  });
  return `${header}${rebuilt.join('\n')}\n`;
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

export function diffFileStatus(section) {
  const text = String(section || '');
  if (/^Binary files /m.test(text)) return 'binary';
  if (/^rename from /m.test(text) || /^rename to /m.test(text)) return 'R';
  if (/^copy from /m.test(text) || /^copy to /m.test(text)) return 'C';
  if (/^new file mode /m.test(text) || /^---\s+\/dev\/null(?:\s|$)/m.test(text)) return 'A';
  if (/^deleted file mode /m.test(text) || /^\+\+\+\s+\/dev\/null(?:\s|$)/m.test(text)) return 'D';
  if (/^(old mode|new mode) /m.test(text)) return 'T';
  if (/^… \[diff truncated for display\]$/m.test(text)) return 'M';
  return '';
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
  const status = diffFileStatus(section) || (hunks.length > 0 ? 'M' : '');
  return {
    oldFile: { fileName: oldName, content: '' },
    newFile: { fileName: newName, content: '' },
    hunks,
    patch: section,
    renderPatch: renderablePatch(section, hunks),
    renderable: hunks.length > 0,
    status,
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
    for (let match = plainHeader.exec(normalized); match; match = plainHeader.exec(normalized))
      starts.push(match.index);
  }
  if (starts.length === 0) return [parseFileSection(normalized)];
  const sections = starts.map((start, index) => normalized.slice(start, starts[index + 1] ?? normalized.length));
  const lead = normalized.slice(0, starts[0]);
  if (starts[0] > 0 && hasLeadingDiffContent(lead)) sections.unshift(lead);
  return sections.map(parseFileSection);
}

// Lines a patch adds and removes, counted inside its hunks only, so file
// headers ("--- a/x", "+++ b/x") never count as changed lines.
export function patchLineCounts(patch) {
  let additions = 0;
  let deletions = 0;
  for (const file of parseUnifiedDiff(patch)) {
    for (const hunk of file.hunks) {
      for (const line of hunk.split('\n').slice(1)) {
        if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

// The files a patch changes as the turn review counts them: lines added and
// removed inside each hunk (header lines excluded), its status, and the parsed
// part itself. A part without a name, or a bare `diff --git` header with no
// change and no status, is not a file change.
export function analyzePatchFiles(patch) {
  return parseUnifiedDiff(patch).flatMap((part) => {
    const name = String(part.newFile?.fileName || '');
    if (!name) return [];
    let additions = 0;
    let deletions = 0;
    for (const line of part.hunks.join('\n').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    const status = String(part.status || '');
    if (additions === 0 && deletions === 0 && !status) return [];
    return [
      { name, additions, deletions, lineStats: additions + deletions > 0, status, binary: status === 'binary', part },
    ];
  });
}

// Everything the transcript row and the turn review read from one call's diff,
// without the diff text. The host sends this in place of a long diff in the
// phone's copy; the renderer reads the same answers from it that it reads from
// the text, so both surfaces show the same counts, verb, path and files.
export function patchDigest(patch) {
  const parts = parseUnifiedDiff(patch);
  const first = parts[0];
  return {
    counts: patchLineCounts(patch),
    statuses: parts.map((part) => part.status),
    targetPath: first ? (first.status === 'D' ? first.oldFile.fileName : first.newFile.fileName) : '',
    files: analyzePatchFiles(patch).map(({ part: _part, ...file }) => file),
  };
}

/** The two file names a `diff --git a/<old> b/<new>` section header carries. */
export function diffSectionNames(section) {
  return (/^diff --git a\/(.+?) b\/(.+)$/m.exec(section)?.slice(1) ?? []).map((name) => name.trim());
}

// A git-form patch (it starts at a `diff --git` header) as one digest per file
// section, each with the names its header gives. A call that landed in a batch
// carries the whole batch's patch and its row shows only its own file's
// sections, so a reader picks sections by name and merges their digests.
export function patchSectionDigests(patch) {
  return patch
    .split(/^(?=diff --git )/m)
    .map((section) => ({ names: diffSectionNames(section), ...patchDigest(section) }));
}

// The digest of several sections read as one patch: what patchDigest answers
// for their text joined.
export function mergePatchDigests(digests) {
  return {
    counts: {
      additions: digests.reduce((total, digest) => total + digest.counts.additions, 0),
      deletions: digests.reduce((total, digest) => total + digest.counts.deletions, 0),
    },
    statuses: digests.flatMap((digest) => digest.statuses),
    targetPath: digests[0]?.targetPath ?? '',
    files: digests.flatMap((digest) => digest.files),
  };
}

// First `max` lines of a patch that still parses: a cut inside a hunk leaves
// header counts the diff view rejects (it then fell back to raw text), so the
// last hunk's counts are rewritten to the lines kept, and a file section left
// without any hunk body is dropped.
export function capPatchLines(patch, max) {
  const lines = String(patch || '').split('\n');
  // A "\ No newline at end of file" marker is not a drawn row: a patch whose
  // drawn rows fit is not cut, however many markers it carries.
  if (lines.filter((line) => !line.startsWith('\\')).length <= max) return { text: patch, cut: false };
  const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  // Walk the patch by its own structure: a hunk owns exactly the rows its
  // header counts, and everything outside hunks is a file's header block.
  let drawn = 0;
  let index = 0;
  let headerStart = 0; // first line of the file header block being read
  let fileHasHunk = false;
  let hunk = null; // { at, oldLeft, newLeft }
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      if (!line.startsWith('\\')) {
        if (drawn >= max) break;
        drawn += 1;
      }
      if (line.startsWith('+')) hunk.newLeft -= 1;
      else if (line.startsWith('-')) hunk.oldLeft -= 1;
      else if (!line.startsWith('\\')) {
        hunk.oldLeft -= 1;
        hunk.newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith('\\')) continue;
    const header = HUNK.exec(line);
    if (drawn >= max) break;
    drawn += 1;
    if (header) {
      hunk = { at: index, oldLeft: Number(header[2] ?? 1), newLeft: Number(header[4] ?? 1) };
      fileHasHunk = true;
    } else if (hunk || line.startsWith('diff --git ')) {
      // A non-hunk line after a finished hunk opens the next file's header.
      if (hunk || fileHasHunk) headerStart = index;
      hunk = null;
      fileHasHunk = false;
    }
  }
  const kept = lines.slice(0, index);
  if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
    // Cut inside a hunk: count what was kept, or drop a hunk left bodiless.
    const body = kept.slice(hunk.at + 1).filter((line) => !line.startsWith('\\'));
    const header = HUNK.exec(kept[hunk.at]);
    if (body.length === 0) {
      const earlierHunk = kept.slice(headerStart, hunk.at).some((line) => HUNK.test(line));
      kept.length = earlierHunk ? hunk.at : headerStart;
    } else if (header) {
      const oldCount = body.filter((line) => !line.startsWith('+')).length;
      const newCount = body.filter((line) => !line.startsWith('-')).length;
      kept[hunk.at] = `@@ -${header[1]},${oldCount} +${header[3]},${newCount} @@${header[5]}`;
    }
  } else if (!hunk) {
    // Cut inside a file's header block, before any of its hunks: drop it.
    kept.length = headerStart;
  }
  return { text: kept.join('\n'), cut: true };
}

// Startup/reload navigation restore plan. The persisted LAST VIEWED selection
// (localStorage) outranks the host engine's current session: the engine-first
// order made every renderer reload (crash recovery, dev HMR) yank a draft or
// other view onto whatever session the engine happened to hold — perceived as
// the window force-switching to a background session (user report). An absent
// stored id is MEANINGFUL: the user last viewed a non-session surface (New
// task draft), so no session is restored. A stale or not-yet-confirmed stored
// id also stays on New task: a partial startup catalog must never make the
// engine's unrelated current session steal the user's selection.
export function startupRestorePlan({ storedSessionId = '', storedSessionKnown = false, engineSessionId = '' } = {}) {
  const stored = String(storedSessionId || '');
  const engine = String(engineSessionId || '');
  if (stored && storedSessionKnown === true) {
    return stored === engine
      ? { action: 'activate', sessionId: stored, clearStored: false }
      : { action: 'resume', sessionId: stored, clearStored: false };
  }
  if (stored) {
    return { action: 'fallback', sessionId: '', clearStored: true };
  }
  return { action: 'fallback', sessionId: '', clearStored: false };
}
