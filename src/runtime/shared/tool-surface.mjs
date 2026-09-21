// ── Facade: tool-surface primitives + result summaries are re-exported from
// their cohesive modules so every existing importer resolves unchanged. This
// file keeps the display-name / arg-summary and aggregate-card clusters.
import {
  DEFAULT_SUMMARY_MAX,
  AGENT_SURFACE_BRIEF_MAX,
  STATUS_SEPARATOR,
  stripToolPrefix,
  parseMcpToolName,
  isMcpToolName,
  isExternalMcpToolName,
  titleCaseMcpServer,
  normalizeToolName,
  truncateToolText,
  truncateCommand,
  parseToolArgs,
  displayToolPath,
  compactParts,
  quoted,
  firstText,
  splitToolSearchSelection,
  toolSearchDisplayLabel,
  displayToolSearchTarget,
  titleizeToolName,
  displayModelName,
  bridgeAgentModelSummary,
  summarizeLineWindow,
  summarizePatch,
  collectionCount,
  formatCountedUnit,
  codeGraphLabel,
  codeGraphSummary,
  pluralize,
} from './tool-primitives.mjs';
import {
  parseLineDelta,
  formatLineDelta,
  parseUpdateSummary,
  extractErrorCause,
  summarizeToolResult,
  summarizeAgentSurfaceBrief,
  isMemorySurface,
} from './tool-result-summary.mjs';
import {
  CATEGORY_ORDER,
  classifyToolCategory,
  categoryCopy,
  patchOperationProfile,
  patchMutationUnits,
  toolWorkUnit,
} from './tool-work-units.mjs';

export { classifyToolCategory, toolWorkUnit };

export {
  AGENT_SURFACE_BRIEF_MAX,
  DEFAULT_SUMMARY_MAX,
  STATUS_SEPARATOR,
  stripToolPrefix,
  parseMcpToolName,
  isMcpToolName,
  normalizeToolName,
  truncateToolText,
  parseToolArgs,
  displayToolPath,
  displayModelName,
  parseLineDelta,
  extractErrorCause,
  summarizeToolResult,
  summarizeAgentSurfaceBrief,
  isMemorySurface,
};

export function isTaskWaitToolCall(name, args = {}) {
  if (normalizeToolName(name) !== 'task') return false;
  const parsed = parseToolArgs(args);
  return (
    String(parsed?.action || '')
      .trim()
      .toLowerCase() === 'wait'
  );
}

export function displayToolName(name, args = {}) {
  if (isExternalMcpToolName(name)) {
    const mcp = parseMcpToolName(name);
    return `MCP ${titleCaseMcpServer(mcp.server)}`;
  }
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return 'Read';
    case 'apply_patch': {
      const parsed = parseToolArgs(args);
      if (parsed && parsed.dry_run === true) return 'Check';
      const operations = patchOperationProfile(parsed);
      if (operations.size > 1) return 'Change';
      if (operations.has('add')) return 'Create';
      if (operations.has('delete')) return 'Delete';
      return 'Update';
    }
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return 'Run';
    case 'task':
      return 'Task';
    case 'grep':
    case 'find':
    case 'glob':
    case 'list':
    case 'ls':
      return 'Search';
    case 'load_tool':
      return toolSearchDisplayLabel(parseToolArgs(args));
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      return 'Web Search';
    case 'web_fetch':
    case 'fetch':
      return 'Fetch';
    case 'browser':
    case 'browser_devtools':
      return 'Browser';
    case 'computer':
      return 'Computer';
    case 'office':
      return 'Office';
    case 'media':
      return 'Media';
    case 'tidy':
      return 'Tidy';
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
    case 'cwd':
    case 'setup':
      return 'Setup';
    case 'request_user_input':
      return 'Ask User';
    case 'update_plan':
      return 'Plan';
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
    case 'recall':
    case 'search_memories':
      return 'Memory';
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return 'Skill';
    case 'bridge':
    case 'agent':
      return 'Agent';
    case 'code_graph':
      return codeGraphLabel(parseToolArgs(args));
    default:
      return titleizeToolName(name);
  }
}

// The bridge tools (`browser`, `computer`) carry their fields in a nested
// `input` object, so the tool-level action stays at the argument root while
// `parseToolArgs` hands back the unwrapped input. Resolve both halves straight
// from the raw arguments, which may still arrive as a JSON string.
function bridgeToolCall(args) {
  let root = args;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      root = null;
    }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { action: '', input: {} };
  const input = root.input && typeof root.input === 'object' && !Array.isArray(root.input) ? root.input : root;
  return { action: String(root.action || input.action || ''), input };
}

export function summarizeToolArgs(name, args, { max = DEFAULT_SUMMARY_MAX } = {}) {
  const a = parseToolArgs(args);
  if (!a || typeof a !== 'object') return '';
  const normalized = normalizeToolName(name);
  if (isExternalMcpToolName(name)) {
    const mcp = parseMcpToolName(name);
    return compactParts([
      truncateToolText(mcp.tool, max),
      truncateToolText(
        firstText(a.query, a.q, a.text, a.prompt, a.path, a.uri, a.name, a.id, a.action),
        Math.min(max, 80)
      ),
    ]);
  }
  switch (normalized) {
    case 'read':
      if (!a.path && !a.file_path) return '';
      if (Array.isArray(a.path) || Array.isArray(a.file_path)) {
        return formatCountedUnit(collectionCount(a.path, a.file_path), 'file');
      }
      return compactParts([
        displayToolPath(a.path ?? a.file_path),
        a.pages ? `pages ${a.pages}` : summarizeLineWindow(a),
      ]);
    case 'view_image':
      return displayToolPath(a.path || a.file_path || '');
    case 'apply_patch':
      return summarizePatch(a.patch, a.base_path);
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return truncateCommand(a.description || a.command || a.cmd || '', max);
    case 'task':
      return compactParts([a.action || a.type || 'task', a.task_id || '']);
    case 'list':
    case 'ls':
      if (Array.isArray(a.path) || Array.isArray(a.dir) || Array.isArray(a.cwd)) {
        return formatCountedUnit(collectionCount(a.path, a.dir, a.cwd), 'directory', 'directories');
      }
      return compactParts([
        displayToolPath(a.path ?? a.dir ?? a.cwd ?? ''),
        a.head_limit || a.limit ? `${a.head_limit ?? a.limit} entries` : '',
      ]);
    case 'grep':
      if (!a.pattern && !a.query) return '';
      if (Array.isArray(a.pattern) || Array.isArray(a.query)) {
        return formatCountedUnit(collectionCount(a.pattern, a.query), 'pattern');
      }
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.query, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      if (Array.isArray(a.pattern) || Array.isArray(a.glob)) {
        return formatCountedUnit(collectionCount(a.pattern, a.glob), 'glob');
      }
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.glob, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'find':
      if (!a.query && !a.fuzzy) return '';
      if (Array.isArray(a.query) || Array.isArray(a.fuzzy)) {
        return formatCountedUnit(collectionCount(a.query, a.fuzzy), 'query', 'queries');
      }
      return compactParts([quoted(a.query ?? a.fuzzy, max), a.path ? `path: ${displayToolPath(a.path)}` : '']);
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      if (Array.isArray(a.query) || Array.isArray(a.keywords)) {
        return formatCountedUnit(collectionCount(a.query, a.keywords), 'query', 'queries');
      }
      return quoted(a.query || a.keywords || '', max);
    case 'load_tool': {
      const selected = [...splitToolSearchSelection(a.names), ...splitToolSearchSelection(a.select)];
      if (selected.length) return truncateToolText(selected.map(displayToolSearchTarget).join(', '), max);
      return quoted(firstText(a.query, a.q, a.text), max);
    }
    case 'web_fetch':
    case 'fetch':
      if (Array.isArray(a.url) || Array.isArray(a.uri)) {
        return formatCountedUnit(collectionCount(a.url, a.uri), 'URL', 'URLs');
      }
      return truncateToolText(a.url || a.uri || '', max);
    case 'browser':
    case 'browser_devtools': {
      const call = bridgeToolCall(args);
      return compactParts([call.action, pathOrId(call.input.url, call.input.ref, max)]);
    }
    case 'computer': {
      const call = bridgeToolCall(args);
      // One target per action: window/clipboard name their operation, list its
      // kind, and input actions their semantic ref, exact window, or app.
      return compactParts([
        call.action,
        truncateToolText(
          firstText(call.input.operation, call.input.kind, call.input.ref, call.input.window_id, call.input.app),
          max
        ),
      ]);
    }
    case 'office':
      return compactParts([String(a.action || ''), pathOrId(a.path, a.session, max)]);
    case 'media':
      return compactParts([String(a.action || ''), String(a.kind || ''), pathOrId(a.path, a.job, max)]);
    case 'tidy':
      return compactParts([
        String(a.action || ''),
        Array.isArray(a.engines) && a.engines.length ? a.engines.join(', ') : '',
        Array.isArray(a.paths) && a.paths.length ? truncateToolText(a.paths.join(' '), max) : '',
        a.apply === true ? 'apply' : '',
      ]);
    case 'read_mcp_resource':
      return truncateToolText(a.uri || '', max);
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return a.server ? `server "${truncateToolText(a.server, max)}"` : 'all servers';
    case 'cwd':
      return truncateToolText(firstText(a.path, a.cwd, a.dir), max);
    case 'setup':
      return compactParts([
        String(a.action || ''),
        truncateToolText(firstText(a.domain, a.target, a.name, a.agent, a.workflow, a.style), max),
      ]);
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
      return compactParts([
        a.action || a.type || a.operation || a.op || 'memory',
        truncateToolText(firstText(a.query, a.summary, a.element, a.key, a.name, a.text, a.value), Math.min(max, 80)),
      ]);
    case 'recall':
    case 'search_memories':
      return compactParts([
        quoted(firstText(a.query, a.text, a.input), max),
        a.limit || a.topK ? `top ${a.limit ?? a.topK}` : '',
      ]);
    case 'bridge':
    case 'agent': {
      const agentModel = bridgeAgentModelSummary(a);
      if (agentModel) return agentModel;
      const bridgeAction = a.type || a.action || a.mode || '';
      const showTarget = !/^(status|read)$/i.test(String(bridgeAction || ''));
      return compactParts([bridgeAction, showTarget ? a.tag || a.sessionId || a.task_id || '' : '']);
    }
    case 'code_graph':
      return codeGraphSummary(a, max);
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return truncateToolText(
        firstText(a.name, a.skill, a.skill_name, a.query, a.q, normalized === 'skills_list' ? 'all skills' : ''),
        max
      );
    default: {
      const primary = firstText(a.name, a.skill, a.query, a.title, a.path, a.file, a.target, a.id, a.action);
      if (primary) return truncateToolText(primary, Math.min(max, 80));
      // Last resort: compact key=value of at most the first 2 own keys.
      // Never JSON.stringify the whole object.
      const keys = Object.keys(a).slice(0, 2);
      const pairs = keys
        .map((key) => {
          const value = a[key];
          if (value == null || typeof value === 'object') return '';
          const text = truncateToolText(value, 40);
          return text ? `${key}=${text}` : '';
        })
        .filter(Boolean);
      return compactParts(pairs);
    }
  }
}

export function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed,
  };
}

export function toolLoadingTargets(name, args = {}) {
  const normalized = normalizeToolName(name);
  const parsed = parseToolArgs(args);
  if (!parsed || typeof parsed !== 'object') return [];
  let selected = [];
  if (normalized === 'load_tool') {
    selected = [...splitToolSearchSelection(parsed.names), ...splitToolSearchSelection(parsed.select)].map(
      displayToolSearchTarget
    );
  } else if (['skill', 'skill_execute', 'skill_view', 'use_skill'].includes(normalized)) {
    selected = [
      ...splitToolSearchSelection(parsed.names),
      ...splitToolSearchSelection(parsed.name),
      ...splitToolSearchSelection(parsed.skills),
      ...splitToolSearchSelection(parsed.skill),
      ...splitToolSearchSelection(parsed.skill_name),
    ];
  }
  return [...new Set(selected.map((value) => String(value || '').trim()).filter(Boolean))];
}

// ── Aggregate tool-card formatting (classification lives in tool-work-units) ──

function lifecycleVerb(unit, pending, { stableVerbWidth = false } = {}) {
  const active = String(unit.active || '');
  const done = String(unit.done || '');
  const verb = pending ? active : done;
  if (!stableVerbWidth) return verb;
  return verb.padEnd(Math.max(active.length, done.length), ' ');
}

export function formatToolActionHeader(
  name,
  args = {},
  { pending = false, count = 1, category = '', stableVerbWidth = false } = {}
) {
  const loadingTargets = toolLoadingTargets(name, args);
  if (loadingTargets.length) {
    return `${pending ? 'Loading' : 'Loaded'} ${loadingTargets.join(', ')}`;
  }
  const unit = toolWorkUnit(name, args, category);
  const n = Math.max(1, Number(unit.count || count || 1));
  const verb = lifecycleVerb(unit, pending, { stableVerbWidth });
  return `${verb} ${n} ${pluralize(n, unit.noun, unit.pluralNoun)}`;
}

// One aggregate entry per work unit. The key folds the whole verb/noun pair so
// two units only merge when they render identically.
function categoryEntryFromUnit(category, unit) {
  return {
    key: [category, unit.active, unit.done, unit.noun, unit.pluralNoun].join('|'),
    category,
    active: unit.active,
    done: unit.done,
    noun: unit.noun,
    pluralNoun: unit.pluralNoun,
    count: Math.max(1, Number(unit.count || 1)),
  };
}

export function aggregateToolCategoryEntry(name, args = {}, category = '') {
  const cat = category || classifyToolCategory(name, args);
  return categoryEntryFromUnit(cat, toolWorkUnit(name, args, cat));
}

export function aggregateToolCategoryEntries(name, args = {}, category = '') {
  const cat = category || classifyToolCategory(name, args);
  const normalized = normalizeToolName(name);
  const units = normalized === 'apply_patch' ? patchMutationUnits(args) : [toolWorkUnit(name, args, cat)];
  return units.map((unit) => categoryEntryFromUnit(cat, unit));
}

/**
 * Rebuild the per-category count map for the DONE state. Counts ATTEMPTS —
 * failed calls included — so the collapsed header total always agrees with
 * the 'N Ok · N Failed' breakdown rendered beside it ("Ran 5 commands ·
 * 3 Ok · 2 Failed", never "Ran 3 commands · 3 Ok · 2 Failed"). Mirrors the
 * call-time accumulation in turn.mjs (sum aggregateToolCategoryEntry(...).count
 * per key); outcome splitting stays in the failure detail, not the header.
 */
export function aggregateDoneCategories(calls = []) {
  const map = new Map();
  for (const rec of calls || []) {
    if (!rec) continue;
    for (const entry of aggregateToolCategoryEntries(rec.name, rec.args, rec.category)) {
      const prev = map.get(entry.key);
      map.set(entry.key, { ...entry, count: Number(prev?.count || 0) + Number(entry.count || 1) });
    }
  }
  return Object.fromEntries(map);
}

function aggregateCount(value) {
  if (value && typeof value === 'object') return Math.max(0, Number(value.count || 0));
  return Math.max(0, Number(value || 0));
}

function aggregateDescriptor(key, value) {
  if (value && typeof value === 'object') {
    const category = value.category || String(key || '').split('|')[0] || 'Other';
    const copy = categoryCopy(category);
    const noun = value.noun || copy.noun || 'item';
    return {
      category,
      active: value.active || copy.active,
      done: value.done || copy.done,
      noun,
      pluralNoun: value.pluralNoun || copy.pluralNoun || `${noun}s`,
      count: aggregateCount(value),
    };
  }
  const category = String(key || '');
  const copy = categoryCopy(category);
  const noun = copy.noun || 'item';
  return {
    category,
    active: copy.active,
    done: copy.done,
    noun,
    pluralNoun: copy.pluralNoun || `${noun}s`,
    count: aggregateCount(value),
  };
}

/**
 * Build a comma-separated header from per-category counts.
 * e.g. "Read 6 items, Searched 5 items, Called 1 agent"
 */
export function formatAggregateHeader(categories, { pending = false, order = null, stableVerbWidth = false } = {}) {
  const categoryKeys = Object.keys(categories || {});
  const preferred = Array.isArray(order) && order.length ? order : categoryKeys;
  const seen = new Set();
  const ordered = [];
  const add = (cat) => {
    if (!cat || seen.has(cat) || aggregateCount(categories[cat]) <= 0) return;
    seen.add(cat);
    ordered.push(cat);
  };
  for (const cat of preferred) add(cat);
  for (const cat of CATEGORY_ORDER) add(cat);
  for (const cat of Object.keys(categories || {})) add(cat);

  return ordered
    .map((cat) => {
      const item = aggregateDescriptor(cat, categories[cat]);
      const label = lifecycleVerb(item, pending, { stableVerbWidth });
      return `${label} ${item.count} ${pluralize(item.count, item.noun, item.pluralNoun)}`;
    })
    .join(', ');
}

/**
 * Join a list of per-call result summaries into a single detail line,
 * deduplicating exact repeats while preserving order.
 */
/** A truncated path when one is given, else the bare identifier, else ''. */
function pathOrId(path, id, max) {
  if (path) return truncateToolText(path, max);
  return id ? String(id) : '';
}

function singularNoun(noun) {
  if (noun.endsWith('ies')) return `${noun.slice(0, -3)}y`;
  if (/(?:ch|sh|x|z|s)es$/.test(noun)) return noun.slice(0, -2);
  return noun.endsWith('s') ? noun.slice(0, -1) : noun;
}

function pluralNoun(singular) {
  if (singular.endsWith('y')) return `${singular.slice(0, -1)}ies`;
  return /(?:ch|sh|x|z|s)$/.test(singular) ? `${singular}es` : `${singular}s`;
}

/** The merged file target of an update/check metric: one filename or a count. */
function mergedFileTarget(metric) {
  const count = metric.fileCount + metric.files.size;
  return count === 1 && metric.fileCount === 0 ? [...metric.files][0] : `${count} ${pluralize(count, 'file')}`;
}

/** Fold one parsed update summary into its metric (files, counts, deltas). */
function accumulateUpdateMetric(metric, update) {
  if (update.file) metric.files.add(update.file);
  metric.fileCount += update.fileCount;
  metric.added += update.added;
  metric.removed += update.removed;
  metric.seen = metric.seen || update.seen;
}

export function formatAggregateDetail(summaries) {
  if (!summaries || summaries.length === 0) return '';
  const metrics = new Map();
  const order = [];
  const extras = new Set();

  const addMetric = (key, initial) => {
    if (!metrics.has(key)) {
      metrics.set(key, { ...initial });
      order.push({ type: 'metric', key });
      return metrics.get(key);
    }
    return metrics.get(key);
  };

  const addExtra = (text) => {
    if (!text || extras.has(text)) return;
    extras.add(text);
    order.push({ type: 'extra', text });
  };

  for (const raw of summaries) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match = /^(?:Read\s+)?(\d+)\s+lines?$/i.exec(text);
    if (match) {
      const metric = addMetric('read_lines', { count: 0, render: (m) => `${m.count} ${pluralize(m.count, 'line')}` });
      metric.count += Number(match[1]);
      continue;
    }

    if (/^(?:Read\s+)?image$/i.test(text)) {
      const metric = addMetric('read_images', { count: 0, render: (m) => `${m.count} ${pluralize(m.count, 'image')}` });
      metric.count += 1;
      continue;
    }

    match = /^(?:Found\s+)?(\d+)\s+([a-z]+)$/i.exec(text);
    if (match) {
      const nounRaw = match[2].toLowerCase();
      // Normalize to a canonical singular so singular/plural variants of the
      // SAME noun merge into one metric. Previously "48 matches" keyed as
      // found_matches while "1 match" keyed as found_matchs (naive +s), so the
      // detail row showed "48 matches, 1 match" instead of "49 matches".
      const singular = singularNoun(nounRaw);
      const plural = pluralNoun(singular);
      const key = `found_${singular}`;
      const metric = addMetric(key, {
        count: 0,
        singular,
        plural,
        render: (m) => `${m.count} ${pluralize(m.count, m.singular, m.plural)}`,
      });
      metric.count += Number(match[1]);
      continue;
    }

    match = /^(?:Updated(?:\s+-)?\s+)?\+(\d+)\s+-(\d+)$/i.exec(text);
    if (match) {
      const metric = addMetric('updated', { added: 0, removed: 0, render: (m) => `+${m.added} -${m.removed}` });
      metric.added += Number(match[1]);
      metric.removed += Number(match[2]);
      continue;
    }

    const update = parseUpdateSummary(text);
    // Dry-run patch checks ("Checked foo.js · +7 -5") are validations, not
    // edits: their line delta must NEVER be summed into the real edit total.
    // They get their own metric so repeated checks still merge; the preview
    // delta is shown only when the card has no real edit delta it could be
    // confused with. Delta-less "Checked ..." texts (task/memory summaries)
    // fall through to extras unchanged.
    if (update && update.action === 'Checked') {
      if (update.seen) {
        const metric = addMetric('checked_files', {
          files: new Set(),
          fileCount: 0,
          added: 0,
          removed: 0,
          seen: false,
          render: (m) => {
            const target = mergedFileTarget(m);
            const editDelta = formatLineDelta(metrics.get('updated_files'));
            const delta = editDelta ? '' : formatLineDelta(m);
            return delta ? `Checked ${target} · ${delta}` : `Checked ${target}`;
          },
        });
        accumulateUpdateMetric(metric, update);
        continue;
      }
    } else if (update) {
      const metric = addMetric('updated_files', {
        files: new Set(),
        fileCount: 0,
        actions: new Set(),
        added: 0,
        removed: 0,
        seen: false,
        render: (m) => {
          // The aggregate header already carries the action + file count
          // (e.g. "Edited 2 files"), so the detail row shows only the merged
          // line delta. Fall back to the action + file/count summary only when
          // there is no +/- delta to show (e.g. pure create/delete).
          const delta = formatLineDelta(m);
          if (delta) return delta;
          const action = m.actions.size === 1 ? [...m.actions][0] : 'Updated';
          return `${action} ${mergedFileTarget(m)}`;
        },
      });
      metric.actions.add(update.action);
      accumulateUpdateMetric(metric, update);
      continue;
    }

    addExtra(text);
  }

  return order
    .map((item) => (item.type === 'metric' ? metrics.get(item.key)?.render(metrics.get(item.key)) : item.text))
    .filter(Boolean)
    .join(', ');
}
