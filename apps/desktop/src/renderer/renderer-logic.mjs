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

export function shouldAutoFollow({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 }, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function needsBottomPin({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 }, epsilon = 1) {
  return scrollHeight - scrollTop - clientHeight > epsilon;
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
    const context = head.replace(/^@@+\s*/, '').replace(/\s*@@\s*$/, '').trim();
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
    renderPatch: renderablePatch(section, hunks),
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

// ── Structured tool-input rows ───────────────────────────────────
// The expanded tool card renders Input as a key/value grid,
// never a raw JSON dump. Keys listed here
// render first, in this order; unlisted keys follow in natural order.
const TOOL_INPUT_PRIORITY = new Map();
function registerInputPriority(names, keys) {
  for (const name of names) TOOL_INPUT_PRIORITY.set(name, keys);
}
registerInputPriority(['read'], ['path', 'file_path', 'offset', 'limit']);
registerInputPriority(['view_image'], ['path', 'file_path']);
registerInputPriority(['apply_patch'], ['base_path', 'dry_run', 'format', 'fuzzy', 'reject_partial']);
registerInputPriority(['grep'], ['pattern', 'query', 'path', 'glob', 'output_mode', '-C', 'head_limit', 'offset']);
registerInputPriority(['glob'], ['pattern', 'glob', 'path', 'head_limit', 'offset']);
registerInputPriority(['find'], ['query', 'fuzzy', 'path', 'head_limit']);
registerInputPriority(['list', 'ls'], ['path', 'dir', 'head_limit', 'offset']);
registerInputPriority(['explore'], ['query', 'cwd']);
registerInputPriority(['search', 'search_query', 'web_search', 'image_query'],
  ['query', 'site', 'type', 'maxResults', 'contextSize', 'locale']);
registerInputPriority(['web_fetch'], ['url', 'uri', 'maxLength', 'startIndex']);
registerInputPriority(['fetch'], ['url', 'uri', 'channel', 'limit']);
registerInputPriority(['code_graph'], ['mode', 'symbols', 'files', 'depth', 'limit', 'page', 'body']);
registerInputPriority(['agent', 'bridge'],
  ['type', 'agent', 'tag', 'task_id', 'sessionId', 'cwd', 'message', 'prompt', 'context', 'file']);
registerInputPriority(['task'], ['action', 'task_id', 'timeout_ms']);
registerInputPriority(['recall', 'search_memories'],
  ['query', 'period', 'category', 'limit', 'projectScope', 'sort', 'id']);
registerInputPriority(['memory', 'remember', 'save_memory', 'update_memory'],
  ['action', 'op', 'query', 'text', 'value']);
registerInputPriority(['load_tool'], ['names', 'select']);
registerInputPriority(['skill', 'use_skill', 'skill_execute', 'skill_view'], ['name', 'skill', 'skill_name']);
registerInputPriority(['reply'], ['channel', 'channelId', 'text', 'files']);
registerInputPriority(['cwd'], ['action', 'path']);

// Fields whose bulk payload is rendered elsewhere (the diff view) or is
// pure noise in a key/value grid.
const TOOL_INPUT_HIDDEN = new Map([
  ['apply_patch', ['patch']],
]);

const TOOL_INPUT_LONG_VALUE = 96;
const TOOL_INPUT_MAX_ROWS = 32;

function isInputScalar(value) {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function toolInputRow(key, value) {
  const text = String(value);
  return { key, value: text, block: text.includes('\n') || text.length > TOOL_INPUT_LONG_VALUE };
}

// Small objects (e.g. read regions {path,offset,limit}) join as one-liners;
// anything nested falls back to compact JSON.
function compactObjectValue(value) {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length > 0 && entries.every(([, v]) => isInputScalar(v))) {
    return entries.map(([k, v]) => `${k}: ${v}`).join(' · ');
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function toolInputRows(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const normalized = String(name || '').toLowerCase();
  const hidden = new Set(TOOL_INPUT_HIDDEN.get(normalized) || []);
  const priority = TOOL_INPUT_PRIORITY.get(normalized) || [];
  const keys = [
    ...priority.filter((key) => key in args),
    ...Object.keys(args).filter((key) => !priority.includes(key)),
  ];
  const rows = [];
  for (const key of keys) {
    if (hidden.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (isInputScalar(value)) {
      rows.push(toolInputRow(key, value));
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.length === 1) {
        const only = value[0];
        rows.push(toolInputRow(key, isInputScalar(only) ? only : compactObjectValue(only)));
        continue;
      }
      value.forEach((item, index) => {
        rows.push(toolInputRow(`${key}[${index}]`, isInputScalar(item) ? item : compactObjectValue(item)));
      });
    } else {
      rows.push(toolInputRow(key, compactObjectValue(value)));
    }
  }
  if (rows.length > TOOL_INPUT_MAX_ROWS) {
    const extra = rows.length - TOOL_INPUT_MAX_ROWS;
    return [
      ...rows.slice(0, TOOL_INPUT_MAX_ROWS),
      { key: '…', value: `${extra} more ${extra === 1 ? 'field' : 'fields'}`, block: false },
    ];
  }
  return rows;
}
