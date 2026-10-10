import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord, oneLine } from './text-format';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { aggregateToolCategoryEntry, classifyToolCategory, formatToolSurface, toolLoadingTargets } from '../../../../src/runtime/shared/tool-surface.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { parseMcpToolName, titleCaseMcpServer } from '../../../../src/runtime/shared/tool-primitives.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolOutcomeTone, resultTerminalStatus } from '../../../../src/runtime/shared/tool-card-model.mjs';

export interface ToolCardModel {
  pending: boolean;
  labelText: string;
  summaryText: string;
  headerFailureText: string;
  detailLine: string;
  detailIsPlaceholder: boolean;
  terminalStatus: string;
}

export function boundedTextOf(value: unknown, maxLength = 100_000) {
  if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength)}\n…truncated` : value;
  let visited = 0;
  try {
    const text =
      JSON.stringify(
        value,
        (_key, nested) => {
          visited += 1;
          if (visited > 2_000) return '…truncated';
          if (typeof nested === 'string' && nested.length > 20_000) return `${nested.slice(0, 20_000)}…`;
          return nested;
        },
        2
      ) || '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…truncated` : text;
  } catch {
    return oneLine(String(value), maxLength);
  }
}

function toolResultText(item: TranscriptItem) {
  return [item.result, item.rawResult]
    .filter((value, index, values) => value != null && (index === 0 || value !== values[0]))
    .map(String)
    .join('\n')
    .trim();
}

export function isHookApprovalDenialToolItem(item: TranscriptItem) {
  if (!item.isError) return false;
  const text = toolResultText(item);
  return (
    /^Error:\s*tool\s*"[^"]*"\s*denied by hook\b/im.test(text) ||
    /denied by hook:\s*approval required but no approval UI is available/i.test(text)
  );
}

export function shouldSuppressFullyFailedToolItem(item: TranscriptItem) {
  const args = asRecord(item.args);
  const status = String(args?.status || '').toLowerCase();
  if ((args?.task_id || args?.taskId) && /^(failed|error|timeout|cancelled|canceled|killed)$/.test(status))
    return false;
  const count = Math.max(1, Number(item.count || 1));
  const completed = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
  const explicit = Number(item.errorCount);
  let errors = 0;
  if (Number.isFinite(explicit)) errors = Math.max(0, Math.min(count, Math.floor(explicit)));
  else if (item.isError) errors = count;
  return completed >= count && errors >= count && !isHookApprovalDenialToolItem(item) && !toolResultText(item);
}

export function toolItemDone(item: TranscriptItem): boolean {
  return (
    item.completedAt != null ||
    (item.completedCount === undefined
      ? item.result != null || item.rawResult != null
      : item.completedCount >= (item.count || 1))
  );
}

export function toolActivityItemTone(item: TranscriptItem): 'error' | 'warning' | 'neutral' {
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const partialMutation = callFailedCount > 0 && typeof item.uiDiff === 'string' && Boolean(item.uiDiff.trim());
  const tone = deriveToolOutcomeTone({
    pending: !toolItemDone(item),
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus: isHookApprovalDenialToolItem(item)
      ? 'denied'
      : resultTerminalStatus(item.result ?? item.rawResult) === 'cancelled'
        ? 'cancelled'
        : '',
    partialMutation,
  });
  return tone === 'error' || tone === 'warning' ? tone : 'neutral';
}

function localizedToolActivityCategory(category: string): string {
  if (category === 'Read') return t('File reading');
  if (category === 'Search') return t('Search');
  if (category === 'Load') return t('Tool loading');
  if (category === 'MCP') return t('MCP tools');
  if (category === 'Skill') return t('Skills');
  if (category === 'Web Research') return t('Web research');
  if (category === 'Memory') return t('Memory');
  if (category === 'Patch') return t('File editing');
  if (category === 'Git') return t('Git');
  if (category === 'Shell') return t('Command execution');
  if (category === 'Agent') return t('Agents');
  if (category === 'Task') return t('Tasks');
  if (category === 'Setup') return t('Setup');
  if (category === 'Browser') return t('Browser Use');
  if (category === 'Computer') return t('Computer Use');
  if (category === 'Terminal') return t('Terminal');
  if (category === 'Office') return t('Document work');
  if (category === 'Media') return t('Media generation');
  if (category === 'Tidy') return t('Code Tidy');
  return t('External tools');
}

function toolActivityUnitKey(category: string, done: string, noun: string): string {
  return category === 'MCP' ? 'MCP' : `${category}|${done}|${noun}`;
}

function localizedToolActivityUnit(category: string, done: string, noun: string): string {
  switch (toolActivityUnitKey(category, done, noun)) {
    case 'Read|Read|file':
      return t('File reading');
    case 'Read|Read|image':
      return t('Image viewing');
    case 'Read|Read|resource':
      return t('MCP resource reading');
    case 'Read|Read|code map':
      return t('Code structure');
    case 'Search|Searched|pattern':
      return t('Content search');
    case 'Search|Found|glob':
      return t('File lookup');
    case 'Search|Found|query':
      return t('Path lookup');
    case 'Search|Listed|directory':
      return t('Folder listing');
    case 'Search|Mapped|symbol':
      return t('Symbol lookup');
    case 'Patch|Created|file':
      return t('File creation');
    case 'Patch|Edited|file':
      return t('File editing');
    case 'Patch|Deleted|file':
      return t('File deletion');
    case 'Patch|Changed|file':
      return t('File changes');
    case 'Patch|Checked|file':
      return t('Patch check');
    case 'Load|Loaded|tool':
    case 'Load|Loaded|query':
      return t('Tool loading');
    case 'Skill|Loaded|skill':
      return t('Skills');
    case 'MCP':
      return t('MCP tool use');
    case 'Web Research|Researched|query':
      return t('Web search');
    case 'Web Research|Fetched|URL':
      return t('Page fetching');
    case 'Web Research|Fetched|message':
      return t('Message fetching');
    case 'Memory|Checked|memory item':
      return t('Memory lookup');
    case 'Memory|Wrote|memory item':
      return t('Memory saving');
    case 'Memory|Deleted|memory item':
      return t('Memory deletion');
    case 'Memory|Listed|memory item':
      return t('Memory listing');
    case 'Shell|Ran|command':
      return t('Command execution');
    case 'Git|Ran|Git command':
      return t('Git commands');
    case 'Git|Staged|change':
      return t('Git staging');
    case 'Agent|Called|agent':
      return t('Agent calls');
    case 'Agent|Checked|agent':
      return t('Agent status');
    case 'Agent|Completed|agent':
      return t('Agent responses');
    case 'Agent|Failed|agent':
      return t('Agent failures');
    case 'Agent|Cancelled|agent':
      return t('Agent cancellations');
    case 'Task|Checked|task':
      return t('Task status');
    case 'Task|Waited for|task':
      return t('Task waiting');
    case 'Task|Listed|task':
      return t('Task listing');
    case 'Task|Cancelled|task':
      return t('Task cancellation');
    case 'Setup|Selected|project':
      return t('Project selection');
    case 'Setup|Listed|project':
      return t('Project listing');
    case 'Terminal|Listed|terminal tab':
      return t('Terminal tabs');
    case 'Terminal|Read|terminal output':
      return t('Terminal output');
    case 'Media|Generated|image':
      return t('Image generation');
    case 'Media|Generated|video':
      return t('Video generation');
    case 'Media|Checked|media job':
      return t('Media status');
    case 'Media|Cancelled|media job':
      return t('Media cancellation');
    case 'Media|Listed|media catalog':
      return t('Media catalog');
    case 'Office|Read|document action':
      return t('Document reading');
    case 'Tidy|Previewed|cleanup pass':
      return t('Tidy preview');
    case 'Tidy|Installed|cleanup engine':
      return t('Tidy install');
    case 'Setup|Checked|working directory':
      return t('Project check');
    case 'Setup|Asked|user':
      return t('User questions');
    case 'Setup|Updated|plan':
      return t('Plan updates');
    case 'Setup|Listed|MCP resource':
      return t('MCP resource listing');
    case 'Setup|Listed|MCP resource template':
      return t('MCP template listing');
    default:
      return localizedToolActivityCategory(category);
  }
}

function namedToolActivityUnit(
  name: unknown,
  args: unknown,
  category: string,
  done: string,
  noun: string
): { unitKey: string; label: string } {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  if (category === 'MCP') {
    const mcp = parseMcpToolName(String(name || modeledName));
    const server = titleCaseMcpServer(mcp?.server || '');
    // Named units read as "<what> <which>" like every other unit: a bare
    // server or skill name in the summary line looked like a versioned token.
    if (server) return { unitKey: `MCP|${mcp.server}`, label: t('MCP {{value0}}', { value0: server }) };
  }
  if (category === 'Skill') {
    const skills = toolLoadingTargets(modeledName, surface.args);
    const skill = skills.join(', ');
    if (skill) return { unitKey: `Skill|${skill}`, label: `${t('Skill')} ${skill}` };
  }
  if (category === 'Browser' || category === 'Computer') {
    return { unitKey: category, label: localizedToolActivityCategory(category) };
  }
  // Repository, PR and issue calls are one unit, named apart from local Git.
  if (surface.normalizedName === 'github') return { unitKey: 'GitHub', label: 'GitHub' };
  if (category === 'Other') {
    const label = String(surface.label || modeledName || t('Tool'));
    return { unitKey: `Other|${surface.normalizedName}`, label };
  }
  return {
    unitKey: toolActivityUnitKey(category, done, noun),
    label: localizedToolActivityUnit(category, done, noun),
  };
}

export function flattenedToolActivityItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const flattened: TranscriptItem[] = [];
  for (const item of items) {
    const members = item.aggregate === true && Array.isArray(item.toolMembers) ? item.toolMembers : [];
    if (members.length === 0) {
      flattened.push(item);
      continue;
    }
    members.forEach((member, index) => {
      if (!member || typeof member !== 'object' || Array.isArray(member)) return;
      const record = member as TranscriptItem;
      flattened.push({
        ...record,
        kind: 'tool',
        id: record.id ?? `${String(item.id ?? 'aggregate')}:member:${index}`,
      });
    });
  }
  return flattened;
}

const DESKTOP_TOOL_ACTIVITY_ALIASES = new Map([
  ['webfetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['patch', 'apply_patch'],
  ['write', 'edit'],
  ['question', 'request_user_input'],
  ['todowrite', 'update_plan'],
]);

export function desktopToolActivityModeledName(name: unknown, args: unknown): string {
  const surface = formatToolSurface(String(name || 'tool'), args);
  return DESKTOP_TOOL_ACTIVITY_ALIASES.get(surface.normalizedName) ?? String(name || 'tool');
}

/** Canonical surface name and arguments after the desktop aliases (`write` → `edit`). */
export function desktopToolActivitySurface(
  name: unknown,
  args: unknown
): { normalizedName: string; args: Record<string, unknown> } {
  const surface = formatToolSurface(desktopToolActivityModeledName(name, args), args);
  return { normalizedName: String(surface.normalizedName), args: asRecord(surface.args) ?? asRecord(args) ?? {} };
}

export function desktopToolActivityCategory(name: unknown, args: unknown): string {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  if (surface.normalizedName === 'browser' || surface.normalizedName === 'browser_devtools') return 'Browser';
  if (surface.normalizedName === 'computer') return 'Computer';
  return String(classifyToolCategory(modeledName, surface.args) || 'Other');
}

function desktopToolActivityUnit(
  name: unknown,
  args: unknown
): {
  category: string;
  done: string;
  noun: string;
  unitKey: string;
  label: string;
  /** How many of the unit one call covers (3 files in one read). */
  count: number;
} {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  const category = desktopToolActivityCategory(modeledName, surface.args);
  const entry = aggregateToolCategoryEntry(modeledName, surface.args, category) as {
    done?: string;
    noun?: string;
    count?: number;
  } | null;
  const done = String(entry?.done || '');
  const noun = String(entry?.noun || '');
  const named = namedToolActivityUnit(name, args, category, done, noun);
  return {
    category,
    done,
    noun,
    unitKey: named.unitKey,
    label: named.label,
    count: Math.max(1, Math.round(Number(entry?.count || 1))),
  };
}

/** The one-word verb a call's own row opens with ("Read a.ts", "Run npm
 *  test"). The group summary counts work units by their full name; a row sits
 *  beside its target, so the short verb is all it needs. Empty when the unit
 *  has no plain verb (a named skill, an MCP server). */
function toolActivityRowVerb(category: string, done: string, noun: string): string {
  switch (toolActivityUnitKey(category, done, noun)) {
    case 'Read|Read|file':
    case 'Read|Read|image':
    case 'Read|Read|resource':
    case 'Read|Read|code map':
      return t('Read');
    case 'Search|Searched|pattern':
      return t('Search');
    case 'Search|Found|glob':
    case 'Search|Found|query':
    case 'Search|Mapped|symbol':
      return t('Find');
    case 'Search|Listed|directory':
      return t('List');
    case 'Terminal|Listed|terminal tab':
      return t('List tabs');
    case 'Terminal|Read|terminal output':
      return t('Read output');
    case 'Patch|Created|file':
      return t('Write');
    case 'Patch|Edited|file':
    case 'Patch|Changed|file':
      return t('Edit');
    case 'Patch|Deleted|file':
      return t('Delete');
    case 'Web Research|Researched|query':
      return t('Web search');
    case 'Web Research|Fetched|URL':
    case 'Web Research|Fetched|message':
      return t('Fetch');
    case 'Shell|Ran|command':
      return t('Run');
    case 'Git|Ran|Git command':
    case 'Git|Staged|change':
      return t('Git');
    case 'Browser|Browsed|action':
      return t('Browser');
    case 'Agent|Called|agent':
    case 'Agent|Completed|agent':
    case 'Agent|Failed|agent':
    case 'Agent|Cancelled|agent':
      return t('Agent');
    case 'Task|Checked|task':
    case 'Task|Waited for|task':
    case 'Task|Listed|task':
    case 'Task|Cancelled|task':
      return t('Task');
    default:
      return '';
  }
}

export function desktopToolActivityRowVerb(name: unknown, args: unknown): string {
  const unit = desktopToolActivityUnit(name, args);
  return toolActivityRowVerb(unit.category, unit.done, unit.noun) || unit.label;
}

export interface ToolActivityBrowserPage {
  url: string;
  /** Host, the card's title. */
  host: string;
  /** Path and query after the host; empty for a site root. */
  path: string;
}

/** The last page a group's browser calls navigated to, for the page card
 *  under the group. Failed calls and calls that name no http(s) address
 *  (a click, a snapshot, a wait on a URL fragment) leave no page. */
export function desktopToolActivityBrowserPage(items: readonly TranscriptItem[]): ToolActivityBrowserPage | null {
  let page: ToolActivityBrowserPage | null = null;
  for (const item of flattenedToolActivityItems(items)) {
    if (item.isError) continue;
    const surface = desktopToolActivitySurface(item.name, item.args);
    if (surface.normalizedName !== 'browser') continue;
    // The action rides at the argument root, beside the nested `input` the
    // surface unwraps; a stored call may still carry its arguments as JSON.
    let root = asRecord(item.args);
    if (!root && typeof item.args === 'string') {
      try {
        root = asRecord(JSON.parse(item.args));
      } catch {
        root = null;
      }
    }
    const action = String(root?.action ?? surface.args.action ?? '');
    if (!/^(?:navigate|open)$/.test(action)) continue;
    const address = surface.args.url ?? asRecord(root?.input)?.url ?? root?.url;
    const raw = typeof address === 'string' ? address.trim() : '';
    if (!/^https?:\/\//i.test(raw)) continue;
    try {
      const parsed = new URL(raw);
      const path = `${parsed.pathname}${parsed.search}`;
      page = { url: parsed.href, host: parsed.host, path: path === '/' ? '' : path };
    } catch {
      // Not an address the pane could load; keep the previous page.
    }
  }
  return page;
}

function toolActivitySummaryPhrase(unit: { unitKey: string; label: string }, count: number): string {
  switch (unit.unitKey) {
    case 'Read|Read|file':
    case 'Read|Read|image':
    case 'Read|Read|resource':
      return count === 1 ? t('Read file') : t('Read {{count}} files', { count });
    case 'Search|Searched|pattern':
      return count === 1 ? t('Search code') : t('Search {{count}} patterns', { count });
    case 'Search|Found|glob':
      return count === 1 ? t('Find files') : t('Find {{count}} files', { count });
    case 'Search|Found|query':
      return count === 1 ? t('Find path') : t('Find {{count}} paths', { count });
    case 'Search|Listed|directory':
      return count === 1 ? t('List directory') : t('List {{count}} directories', { count });
    case 'Search|Mapped|symbol':
      return count === 1 ? t('Find symbol') : t('Find {{count}} symbols', { count });
    case 'Patch|Created|file':
      return count === 1 ? t('Create file') : t('Create {{count}} files', { count });
    case 'Patch|Edited|file':
      return count === 1 ? t('Edit file') : t('Edit {{count}} files', { count });
    case 'Patch|Changed|file':
      return count === 1 ? t('Change file') : t('Change {{count}} files', { count });
    case 'Patch|Deleted|file':
      return count === 1 ? t('Delete file') : t('Delete {{count}} files', { count });
    case 'Web Research|Researched|query':
      return count === 1 ? t('Search web') : t('Search web {{count}} times', { count });
    case 'Web Research|Fetched|URL':
      return count === 1 ? t('Fetch page') : t('Fetch {{count}} pages', { count });
    case 'Web Research|Fetched|message':
      return count === 1 ? t('Fetch message') : t('Fetch {{count}} messages', { count });
    case 'Shell|Ran|command':
      return count === 1 ? t('Run command') : t('Run {{count}} commands', { count });
    case 'Git|Ran|Git command':
      return count === 1 ? t('Run Git command') : t('Run {{count}} Git commands', { count });
    case 'Git|Staged|change':
      return count === 1 ? t('Stage changes') : t('Stage {{count}} changes', { count });
    case 'Browser|Browsed|action':
      return count === 1 ? t('Browser action') : t('Browser {{count}} actions', { count });
    case 'Computer|Operated|action':
      return count === 1 ? t('Computer action') : t('Computer {{count}} actions', { count });
    case 'Office|Edited|document action':
      return count === 1 ? t('Office action') : t('Office {{count}} actions', { count });
    case 'Media|Generated|image':
    case 'Media|Generated|video':
      return count === 1 ? t('Generate media') : t('Generate {{count}} media', { count });
    case 'Tidy|Tidied|cleanup pass':
      return count === 1 ? t('Tidy code') : t('Tidy code {{count}} times', { count });
    case 'Agent|Called|agent':
      return count === 1 ? t('Call agent') : t('Call {{count}} agents', { count });
    case 'Agent|Completed|agent':
      return count === 1 ? t('Agent response') : `${unit.label} ${count}`;
    case 'Task|Checked|task':
      return count === 1 ? t('Check task') : t('Check {{count}} tasks', { count });
    case 'Task|Waited for|task':
      return count === 1 ? t('Wait for task') : t('Wait for {{count}} tasks', { count });
    case 'Task|Listed|task':
      return t('List tasks');
    case 'Task|Cancelled|task':
      return count === 1 ? t('Cancel task') : t('Cancel {{count}} tasks', { count });
    default:
      return count > 1 ? `${unit.label} ${count}` : unit.label;
  }
}

/** The group summary: each work unit summarized as a natural verb phrase
 *  ("Read 6 files · Search code · Run 4 commands"). */
export function desktopToolActivitySummary(items: readonly TranscriptItem[]): string {
  const groups = new Map<string, { unit: ReturnType<typeof desktopToolActivityUnit>; count: number }>();
  for (const item of flattenedToolActivityItems(items)) {
    const unit = desktopToolActivityUnit(item.name, item.args);
    const prev = groups.get(unit.unitKey);
    const added = Math.max(1, Math.round(Number(item.count || 1))) * unit.count;
    if (prev) {
      prev.count += added;
    } else {
      groups.set(unit.unitKey, { unit, count: added });
    }
  }
  return [...groups.values()]
    .map(({ unit, count }) => toolActivitySummaryPhrase(unit, count))
    .filter(Boolean)
    .join(' · ');
}

/** The work-unit name a call is counted under. */
export function desktopToolActivityUnitLabel(name: unknown, args: unknown): string {
  return desktopToolActivityUnit(name, args).label;
}

interface ToolActivityCategoryGroup {
  unitKey: string;
  category: string;
  label: string;
  count: number;
  items: TranscriptItem[];
}

export function desktopToolActivityCategoryGroups(items: readonly TranscriptItem[]) {
  const groups = new Map<string, ToolActivityCategoryGroup>();
  let previous: ToolActivityCategoryGroup | null = null;
  let previousUnitKey = '';
  for (const item of flattenedToolActivityItems(items)) {
    const unit = desktopToolActivityUnit(item.name, item.args);
    const count = Math.max(1, Math.round(Number(item.count || 1))) * unit.count;
    if (previous && previousUnitKey === unit.unitKey) {
      previous.count += count;
      previous.items.push(item);
      continue;
    }
    const unitKey = groups.has(unit.unitKey) ? `${unit.unitKey}:${groups.size}` : unit.unitKey;
    const group: ToolActivityCategoryGroup = {
      unitKey,
      category: unit.category,
      label: unit.label,
      count,
      items: [item],
    };
    groups.set(unitKey, group);
    previous = group;
    previousUnitKey = unit.unitKey;
  }
  return [...groups.values()];
}
