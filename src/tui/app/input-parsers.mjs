/**
 * input-parsers.mjs — pure text-to-structure parsers for slash-command inputs
 * (hook rules, MCP servers, skills, memory commands + memory row tables).
 * Extracted verbatim from App.jsx; no hooks, no App state, no closures.
 */
export function parseHookRuleInput(text) {
  const parts = String(text || '').split('|').map((part) => part.trim());
  const [tool, actionRaw, match, reason, patchText] = parts;
  const action = String(actionRaw || '').toLowerCase();
  if (!tool || !action) return { error: 'usage: tool | allow|deny|modify | match(optional) | reason(optional) | json patch(optional)' };
  if (!['allow', 'deny', 'block', 'modify', 'rewrite'].includes(action)) {
    return { error: 'hook action must be allow, deny, block, modify, or rewrite' };
  }
  const rule = { tool, action };
  if (match) rule.match = match;
  if (reason) rule.reason = reason;
  if (patchText) {
    try {
      const patch = JSON.parse(patchText);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'json patch must be an object' };
      rule.patch = patch;
    } catch (e) {
      return { error: `invalid json patch: ${e?.message || e}` };
    }
  }
  if ((action === 'modify' || action === 'rewrite') && !rule.patch) {
    return { error: 'modify/rewrite needs a json patch object in the last field' };
  }
  return { rule };
}

export function parseMcpServerInput(text) {
  const parts = String(text || '').split('|').map((part) => part.trim());
  const [name, commandOrUrl, argsText = '', cwd = ''] = parts;
  if (!name || !commandOrUrl) return { error: 'usage: name | command-or-url | args(optional) | cwd(optional)' };
  if (/^(?:https?|wss?):\/\//i.test(commandOrUrl)) return { server: { name, url: commandOrUrl } };
  return {
    server: {
      name,
      command: commandOrUrl,
      args: argsText.split(/\s+/).filter(Boolean),
      cwd,
    },
  };
}

export function parseSkillInput(text) {
  const parts = String(text || '').split('|').map((part) => part.trim());
  const [name, description = 'Project skill.'] = parts;
  if (!name) return { error: 'usage: name | description(optional)' };
  return { skill: { name, description } };
}

export function parseMemoryCommand(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  const action = parts[0] || 'status';
  const out = { action };
  for (const part of parts.slice(1)) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) continue;
    const raw = rest.join('=');
    const num = Number(raw);
    out[key] = Number.isFinite(num) && raw.trim() !== '' ? num : raw;
  }
  return out;
}

export function parseMemoryStatusRows(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const sep = line.indexOf(':');
      const label = sep === -1 ? line : line.slice(0, sep);
      const description = sep === -1 ? '' : line.slice(sep + 1).trim();
      return {
        value: `status-${index}`,
        label,
        description,
        _line: line,
      };
    });
}

export function parseMemoryCoreRows(text) {
  let currentProjectId = null;
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const raw = line.trim();
      if (raw.endsWith(':') && !raw.includes('id=')) {
        const label = raw.slice(0, -1);
        currentProjectId = label === 'COMMON' ? null : label;
        // Group headers (COMMON / project slug) are scope markers, not
        // selectable rows — drop them and carry the scope on each entry's
        // meta column instead (blank for common).
        return null;
      }
      const match = raw.match(/^id=(\d+)\s+\[([^\]]*)\]\s+(.+?)(?:\s+—\s+(.+))?$/);
      if (match) {
        const [, id, category, element, summary = ''] = match;
        return {
          value: `core-${id}`,
          // Display is summary-first: session injection only ever uses the
          // summary sentence (buildSessionCoreMemoryPayload), so id/category/
          // element are UI noise. They stay in the hidden _fields for
          // edit/delete plumbing.
          label: `#${id}`,
          meta: currentProjectId || '',
          description: summary || element,
          _line: raw,
          _action: 'core-entry',
          _id: Number(id),
          _category: category,
          _element: element,
          _summary: summary || element,
          _projectId: currentProjectId,
          // Raw pre-edit values, distinct from the (possibly later-mutated)
          // _element/_summary above -- beginEditCoreMemory reads these to
          // decide whether the row's element duplicated its summary (single-
          // sentence entry) before deciding whether to touch element on edit.
          _origElement: element,
          _origSummary: summary,
        };
      }
      return {
        value: `core-${index}`,
        label: raw,
        description: '',
        _line: raw,
      };
    })
    .filter(Boolean);
}

export function parseMemoryCandidateRows(text) {
  const trimmed = String(text || '').trim();
  // op:'candidates' returns this exact sentinel (index.mjs ~3158) when the
  // resolved scope has none — treat as an empty list, not an inert text row.
  if (!trimmed || /^core candidates:\s*none$/i.test(trimmed)) return [];
  // Backend row shape (index.mjs ~3164), one candidate per line, no group
  // headers:
  //   id=<n> project=<COMMON|slug> [<category>] score=<x.xx|-> <element> — <summary> (<reason>)
  const rowPattern = /^id=(\d+)\s+project=(\S+)\s+\[([^\]]*)\]\s+score=(\S+)\s+(.+?)\s+—\s+(.+?)\s+\(([^)]*)\)$/;
  return trimmed
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const raw = line.trim();
      const match = raw.match(rowPattern);
      if (match) {
        const [, id, project, category, score, element, summary, reason] = match;
        return {
          value: `candidate-${id}`,
          label: `#${id} [${category}] ${element}`,
          meta: project === 'COMMON' ? 'common' : project,
          description: `${summary}${score !== '-' ? ` (score ${score})` : ''} — ${reason}`,
          _line: raw,
          _action: 'candidate-entry',
          _id: Number(id),
          _projectId: project === 'COMMON' ? null : project,
        };
      }
      return {
        value: `candidate-${index}`,
        label: raw,
        description: '',
        _line: raw,
      };
    });
}

// Backend "core" op errors are flattened to plain text by store.memoryControl
// (isError is dropped -- see engine.mjs memoryControl / toolResponseText in
// mixdog-session-runtime.mjs). Success text always uses a past-tense verb
// ("core added/edited/deleted/promoted...", "core candidate dismissed...");
// every declared failure in index.mjs's core-op handling uses the op word
// followed by either ":" (validation message) or " failed" (caught
// exception) -- e.g. "core add: project_id required...", "core edit failed:
// no entry with id=5". That shape is used here to recover the error signal
// since store.memoryControl resolves instead of rejecting on isError.
export function memoryCoreResultErrorText(text) {
  const value = String(text || '').trim();
  if (/^core (add|edit|delete|promote|dismiss)(:| failed)/i.test(value)) return value;
  // Broader catch-all for other flattened "core" failures that don't name an
  // op word right after "core" (e.g. "core: memory data dir is not
  // initialized", "core requires op: ..."), plus any bare error/failed lead-in.
  if (/^core:.*(not initialized|failed|error)/i.test(value)) return value;
  if (/^(error|failed)\b/i.test(value)) return value;
  return null;
}
