import type { TranscriptItem } from './desktop-types';
import type { PatchSectionDigest } from './renderer-logic.mjs';
import { t, uiFormatLocale } from './i18n';
import { asRecord, oneLine } from './text-format';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { aggregateToolCategoryEntry, classifyToolCategory, formatToolSurface, toolLoadingTargets } from '../../../../src/runtime/shared/tool-surface.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { parseMcpToolName, titleCaseMcpServer, toolCallDisplayIdentity } from '../../../../src/runtime/shared/tool-primitives.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { bridgeDescribeResult, deriveToolOutcomeTone, resultTerminalStatus } from '../../../../src/runtime/shared/tool-card-model.mjs';

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
  return Boolean(item.isError) && toolOutputBasics(item).hookDenied;
}

/** Set on a phone's copy of a row whose output the host cut
 *  (main/remote-transcript.ts): the facts its whole output gives
 *  (`toolOutputFacts`, transcript-tool-model.ts) wherever the cut text gives
 *  others. Plain data: numbers, flags, enums, raw output text and deferred
 *  translations, never words in a language. */
export const REMOTE_OUTPUT_FACTS_FIELD = 'remoteOutputFacts';

export function carriedOutputFacts(item: TranscriptItem): Record<string, unknown> | null {
  return asRecord((item as Record<string, unknown>)[REMOTE_OUTPUT_FACTS_FIELD]);
}

/** What a row's tone and its group's summary read from the call's output. */
export interface ToolOutputBasics {
  /** The status the result itself states (`resultTerminalStatus`). */
  resultStatus: string;
  /** The output is a hook's approval denial. */
  hookDenied: boolean;
  /** A bridge load_tool's described / missing / blocked names. */
  described: { described: string[]; missing: string[]; blocked: string[] } | null;
}

/** The output facts of `toolOutputFacts` that tone and summary read: from the
 *  row's own output, with the whole output's where a phone's cut copy carries them. */
export function toolOutputBasics(item: TranscriptItem): ToolOutputBasics {
  return { ...toolOutputBasicsOf(item), ...(carriedOutputFacts(item) as Partial<ToolOutputBasics> | null) };
}

/** `toolOutputBasics` of the row's own output alone. */
export function toolOutputBasicsOf(item: TranscriptItem): ToolOutputBasics {
  // Only a failed call can be a denial; its text is read only then.
  const text = item.isError ? toolResultText(item) : '';
  return {
    resultStatus: String(resultTerminalStatus(item.result ?? item.rawResult) || ''),
    hookDenied:
      /^Error:\s*tool\s*"[^"]*"\s*(?:denied by hook|was not approved)\b/im.test(text) ||
      /denied by hook:\s*approval required but no approval UI is available/i.test(text),
    described: desktopToolDescribeResult(item.name, item.args, item.result ?? item.rawResult),
  };
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

/** The diff a phone's copy of a call carries instead of its text: one digest
 *  per file section, computed by the host with `patchSectionDigests`
 *  (`remote-transcript.ts`). Null on a row that holds its diff, or has none. */
export interface UiDiffSummary {
  sections: PatchSectionDigest[];
}
export function uiDiffDigest(item: TranscriptItem): UiDiffSummary | null {
  const digest = item.uiDiffSummary as Partial<UiDiffSummary> | null | undefined;
  return digest && typeof digest === 'object' && Array.isArray(digest.sections) ? (digest as UiDiffSummary) : null;
}

/** FNV-1a over the whole text: one linear pass, no allocation. */
function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** What a fetched full output or diff is bound to: the parts of a row that
 *  change when its output or diff does. A text fetched for one revision is
 *  never shown for another. */
export function toolRowRevision(item: TranscriptItem): string {
  const digest = uiDiffDigest(item);
  const signature = digest
    ? digest.sections
        .map(
          (section) =>
            `${section.names.join('>')}:${section.counts.additions}/${section.counts.deletions}:${section.statuses.join('')}`
        )
        .join(';')
    : '';
  const identity = (value: unknown) => (typeof value === 'string' ? `${value.length}.${textHash(value)}` : '0');
  return [
    item.remoteOutputTruncated ?? 0,
    item.completedAt ?? '',
    item.count ?? '',
    identity(item.result),
    identity(item.rawResult),
    identity(item.uiDiff),
    signature,
  ].join('|');
}

/** The call changed something: it holds a diff, or (on a phone) the digest of one. */
export function toolItemHasDiff(item: TranscriptItem): boolean {
  return (typeof item.uiDiff === 'string' && Boolean(item.uiDiff.trim())) || uiDiffDigest(item) !== null;
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
  const partialMutation = callFailedCount > 0 && toolItemHasDiff(item);
  let terminalStatus = '';
  const basics = toolOutputBasics(item);
  if (item.isError && basics.hookDenied) terminalStatus = 'denied';
  else if (basics.resultStatus === 'cancelled') terminalStatus = 'cancelled';
  const tone = deriveToolOutcomeTone({
    pending: !toolItemDone(item),
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus,
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
  if (category === 'Visualize') return t('Visualize');
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
      return t('Questions');
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
  // One unit per step whatever the action (open, close, capture…), so the
  // summary reads "Visualize 3" rather than one entry per action.
  if (category === 'Browser' || category === 'Computer' || category === 'Visualize') {
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
  ['ask_user', 'request_user_input'],
  ['todowrite', 'update_plan'],
]);

export function desktopToolActivityModeledName(name: unknown, args: unknown): string {
  const surface = formatToolSurface(String(name || 'tool'), args);
  return DESKTOP_TOOL_ACTIVITY_ALIASES.get(surface.normalizedName) ?? String(name || 'tool');
}

/** The tool a call shows as: a `call_tool` bridge request is the tool it runs
 *  (its own arguments, `via: 'call_tool'`); every other call is itself. Every
 *  desktop category, title and argument derivation starts from this. */
export function desktopToolDisplayIdentity(
  name: unknown,
  args: unknown
): { name: string; args: unknown; via?: 'call_tool' } {
  const identity = toolCallDisplayIdentity(name, args) as { name: unknown; args: unknown; via?: 'call_tool' };
  return {
    name: String(identity.name || 'tool'),
    args: identity.args,
    ...(identity.via ? { via: identity.via } : {}),
  };
}

/** A bridge load_tool result (described / missing / blocked), or null. */
export function desktopToolDescribeResult(
  name: unknown,
  args: unknown,
  result: unknown
): { described: string[]; missing: string[]; blocked: string[] } | null {
  if (result == null) return null;
  const identity = desktopToolDisplayIdentity(name, args);
  if (formatToolSurface(identity.name, identity.args).normalizedName !== 'load_tool') return null;
  return bridgeDescribeResult(typeof result === 'string' ? result : boundedTextOf(result));
}

/** Canonical surface name and arguments after the desktop aliases (`write` → `edit`). */
export function desktopToolActivitySurface(
  name: unknown,
  args: unknown
): { normalizedName: string; args: Record<string, unknown> } {
  const identity = desktopToolDisplayIdentity(name, args);
  const surface = formatToolSurface(desktopToolActivityModeledName(identity.name, identity.args), identity.args);
  return {
    normalizedName: String(surface.normalizedName),
    args: asRecord(surface.args) ?? asRecord(identity.args) ?? {},
  };
}

export function desktopToolActivityCategory(rawName: unknown, rawArgs: unknown): string {
  const { name, args } = desktopToolDisplayIdentity(rawName, rawArgs);
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  if (surface.normalizedName === 'browser' || surface.normalizedName === 'browser_devtools') return 'Browser';
  if (surface.normalizedName === 'computer') return 'Computer';
  return String(classifyToolCategory(modeledName, surface.args) || 'Other');
}

/** `generate_image` / `generate_video` name a generation like `generate` with a
 *  kind; the shared unit table would count them as a media status check. */
function mediaGenerateArgs(surface: { normalizedName: string; args: unknown }): unknown {
  if (surface.normalizedName !== 'media') return surface.args;
  const args = asRecord(surface.args) ?? {};
  const match = /^generate[_-]?(image|video)$/i.exec(String(args.action || ''));
  return match ? { ...args, action: 'generate', kind: match[1].toLowerCase() } : args;
}

function desktopToolActivityUnit(
  rawName: unknown,
  rawArgs: unknown,
  /** The call's output describes tools (`ToolOutputBasics.described`): a bridge load_tool describes, it never loads. */
  described = false
): {
  category: string;
  done: string;
  noun: string;
  unitKey: string;
  label: string;
  /** How many of the unit one call covers (3 files in one read). */
  count: number;
} {
  const { name, args } = desktopToolDisplayIdentity(rawName, rawArgs);
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  const category = desktopToolActivityCategory(modeledName, surface.args);
  const entry = aggregateToolCategoryEntry(modeledName, mediaGenerateArgs(surface), category) as {
    done?: string;
    noun?: string;
    count?: number;
  } | null;
  if (category === 'Load' && described) {
    return {
      category,
      done: 'Described',
      noun: 'tool',
      unitKey: 'Load|Described|tool',
      label: t('Tool description'),
      count: Math.max(1, Math.round(Number(entry?.count || 1))),
    };
  }
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

export function desktopToolActivityRowVerb(name: unknown, args: unknown, described = false): string {
  const unit = desktopToolActivityUnit(name, args, described);
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

const COMPUTER_REFUSAL_CODE = 'computer_capability_unavailable';
/** Computer actions that read or drive a window (the host's window-bound set). */
const COMPUTER_WINDOW_ACTIONS = new Set([
  'list_windows',
  'window_snapshot',
  'related_windows',
  'window_bounds',
  'window_capture',
  'window_predicates',
  'window_integrity',
  'list_apps',
  'verify',
  'focus_window',
  'move_window',
  'window_state',
  'close_window',
]);

export interface ComputerReadinessNotice {
  /** The refused call the notice belongs to. */
  refusalId: string;
  /** When that refused call finished. */
  refusalAt: number;
  /** A later call in the group that needed a window has since succeeded. */
  ready: boolean;
}

/** True when a Computer Use result is Linux's refusal for a missing window
 *  helper: the stable code, with `windows` among the capabilities it names. */
function refusedForWindowHelper(item: TranscriptItem): boolean {
  const meta = item.toolMeta;
  return meta?.code === COMPUTER_REFUSAL_CODE && meta.missing.includes('windows');
}
function computerCallNeedsWindow(item: TranscriptItem): boolean {
  const surface = desktopToolActivitySurface(item.name, item.args);
  let root = asRecord(item.args);
  if (!root && typeof item.args === 'string') {
    try {
      root = asRecord(JSON.parse(item.args));
    } catch {
      root = null;
    }
  }
  const named = (source: Record<string, unknown> | null | undefined) =>
    Boolean(source && (source.window_id || source.app || source.window));
  return (
    COMPUTER_WINDOW_ACTIONS.has(String(root?.action ?? surface.args.action ?? '')) ||
    named(root) ||
    named(asRecord(root?.input)) ||
    named(surface.args)
  );
}

function computerWindowCallSucceeded(item: TranscriptItem): boolean {
  return (
    desktopToolActivitySurface(item.name, item.args).normalizedName === 'computer' &&
    toolItemDone(item) &&
    !item.isError &&
    item.toolMeta?.code !== COMPUTER_REFUSAL_CODE &&
    computerCallNeedsWindow(item)
  );
}

/** The window-helper notice for a group of tool calls: set by the first
 *  Computer Use call refused for a missing window helper, and ready once a
 *  later call that needed a window succeeded in the group. */
export function desktopToolComputerReadinessNotice(items: readonly TranscriptItem[]): ComputerReadinessNotice | null {
  let notice: ComputerReadinessNotice | null = null;
  for (const [index, item] of flattenedToolActivityItems(items).entries()) {
    if (desktopToolActivitySurface(item.name, item.args).normalizedName !== 'computer') continue;
    if (!notice) {
      if (refusedForWindowHelper(item)) {
        notice = {
          refusalId: String(item.id ?? `computer:${index}`),
          refusalAt: Number(item.completedAt) || 0,
          ready: false,
        };
      }
      continue;
    }
    if (computerWindowCallSucceeded(item)) notice.ready = true;
  }
  return notice;
}

/** When the latest window-needing Computer Use call that worked in this group
 *  finished (0 = none). The chat card compares it across the groups of a turn. */
export function desktopToolComputerWindowSuccessAt(items: readonly TranscriptItem[]): number {
  let at = 0;
  for (const item of flattenedToolActivityItems(items)) {
    if (computerWindowCallSucceeded(item)) at = Math.max(at, Number(item.completedAt) || 0);
  }
  return at;
}
function toolActivitySummaryPhrase(unit: { unitKey: string; label: string }, count: number, past: boolean): string {
  switch (unit.unitKey) {
    case 'Read|Read|file':
    case 'Read|Read|image':
    case 'Read|Read|resource':
      return count === 1 ? t('Read file') : t('Read {{count}} files', { count });
    case 'Search|Searched|pattern':
      return count === 1
        ? past
          ? t('Searched code')
          : t('Search code')
        : past
          ? t('Searched {{count}} patterns', { count })
          : t('Search {{count}} patterns', { count });
    case 'Search|Found|glob':
      return count === 1
        ? past
          ? t('Found files')
          : t('Find files')
        : past
          ? t('Found {{count}} files', { count })
          : t('Find {{count}} files', { count });
    case 'Search|Found|query':
      return count === 1
        ? past
          ? t('Found path')
          : t('Find path')
        : past
          ? t('Found {{count}} paths', { count })
          : t('Find {{count}} paths', { count });
    case 'Search|Listed|directory':
      return count === 1
        ? past
          ? t('Listed directory')
          : t('List directory')
        : past
          ? t('Listed {{count}} directories', { count })
          : t('List {{count}} directories', { count });
    case 'Search|Mapped|symbol':
      return count === 1
        ? past
          ? t('Found symbol')
          : t('Find symbol')
        : past
          ? t('Found {{count}} symbols', { count })
          : t('Find {{count}} symbols', { count });
    // File changes always carry their count ("파일 1개 수정"), as commands do.
    case 'Patch|Created|file':
      return past ? t('Created {{count}} files', { count }) : t('Create {{count}} files', { count });
    case 'Patch|Edited|file':
      return past ? t('Edited {{count}} files', { count }) : t('Edit {{count}} files', { count });
    case 'Patch|Changed|file':
      return past ? t('Changed {{count}} files', { count }) : t('Change {{count}} files', { count });
    case 'Patch|Deleted|file':
      return past ? t('Deleted {{count}} files', { count }) : t('Delete {{count}} files', { count });
    case 'Web Research|Researched|query':
      return count === 1
        ? past
          ? t('Searched web')
          : t('Search web')
        : past
          ? t('Searched web {{count}} times', { count })
          : t('Search web {{count}} times', { count });
    case 'Web Research|Fetched|URL':
      return count === 1
        ? past
          ? t('Fetched page')
          : t('Fetch page')
        : past
          ? t('Fetched {{count}} pages', { count })
          : t('Fetch {{count}} pages', { count });
    case 'Web Research|Fetched|message':
      return count === 1
        ? past
          ? t('Fetched message')
          : t('Fetch message')
        : past
          ? t('Fetched {{count}} messages', { count })
          : t('Fetch {{count}} messages', { count });
    case 'Shell|Ran|command':
      return past ? t('Ran {{count}} commands', { count }) : t('Run {{count}} commands', { count });
    case 'Git|Ran|Git command':
      return count === 1
        ? past
          ? t('Ran Git command')
          : t('Run Git command')
        : past
          ? t('Ran {{count}} Git commands', { count })
          : t('Run {{count}} Git commands', { count });
    case 'Git|Staged|change':
      return count === 1
        ? past
          ? t('Staged changes')
          : t('Stage changes')
        : past
          ? t('Staged {{count}} changes', { count })
          : t('Stage {{count}} changes', { count });
    // Browser and Computer calls are one unit keyed by the category itself
    // (namedToolActivityUnit).
    case 'Browser':
      return count === 1 ? t('Browser action') : t('Browser {{count}} actions', { count });
    case 'Computer':
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

/** The group summary: each work unit summarized as a natural verb phrase, file
 *  changes first, then the rest in call order, as one list ("Edit 2 files,
 *  Read 6 files, Run 4 commands"). A command that failed says so: a lone one
 *  as "Command failed", otherwise as a closing "N failed". */
export function desktopToolActivitySummary(items: readonly TranscriptItem[], settled = false): string {
  const groups = new Map<string, { unit: ReturnType<typeof desktopToolActivityUnit>; count: number }>();
  const calls = flattenedToolActivityItems(items);
  let failedCommands = 0;
  for (const item of calls) {
    const basics = toolOutputBasics(item);
    const unit = desktopToolActivityUnit(item.name, item.args, Boolean(basics.described));
    // A stopped command was not a failure: the stop is its own outcome.
    if (
      unit.category === 'Shell' &&
      toolItemDone(item) &&
      basics.resultStatus !== 'cancelled' &&
      toolActivityItemTone(item) !== 'neutral'
    ) {
      failedCommands += 1;
    }
    const prev = groups.get(unit.unitKey);
    const added = Math.max(1, Math.round(Number(item.count || 1))) * unit.count;
    if (prev) {
      prev.count += added;
    } else {
      groups.set(unit.unitKey, { unit, count: added });
    }
  }
  const changesFiles = (unitKey: string) => (unitKey.startsWith('Patch|') ? 0 : 1);
  const phrases = [...groups.values()]
    .sort((left, right) => changesFiles(left.unit.unitKey) - changesFiles(right.unit.unitKey))
    .map(({ unit, count }) => toolActivitySummaryPhrase(unit, count, settled))
    .filter(Boolean);
  if (failedCommands > 0 && calls.length === 1) return t('Command failed');
  if (failedCommands > 0) phrases.push(t('{{count}} failed', { count: failedCommands }));
  // A plain enumeration comma; Japanese and Chinese write theirs as "、".
  return phrases.join(/^(?:ja|zh)/.test(uiFormatLocale()) ? '、' : ', ');
}

/** The work-unit name a call is counted under. */
export function desktopToolActivityUnitLabel(name: unknown, args: unknown, described = false): string {
  return desktopToolActivityUnit(name, args, described).label;
}
