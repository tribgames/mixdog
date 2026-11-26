import type { TranscriptItem } from './desktop-types';
import type { PatchSectionDigest } from './renderer-logic.mjs';
import { t, uiFormatLocale } from './i18n';
import { asRecord, oneLine } from './text-format';
import { textIdentity } from '../shared/tool-output-revision';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { aggregateToolCategoryEntry, classifyToolCategory, formatToolSurface, toolLoadingTargets } from '../../../../packages/protocol-client/src/rows/tool-surface.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { parseMcpToolName, titleCaseMcpServer, toolCallDisplayIdentity } from '../../../../packages/protocol-client/src/rows/tool-primitives.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { bridgeDescribeResult, deriveToolOutcomeTone, resultTerminalStatus } from '../../../../packages/protocol-client/src/rows/tool-card-model.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { cancelledCallWasStopped, toolResultControlStatus } from '../../../../packages/protocol-client/src/rows/tool-status.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isEmptyLookupResult } from '../../../../packages/protocol-client/src/rows/tool-result-summary.mjs';

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
 *  (`toolOutputFacts`). Plain data, never words in a language. */
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
  /** The output is the runtime's note for a lookup that returned no entry. */
  foundNothing: boolean;
}

/** The output facts of `toolOutputFacts` that tone and summary read: from the
 *  row's own output, with the whole output's where a phone's cut copy carries them. */
function toolOutputBasics(item: TranscriptItem): ToolOutputBasics {
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
    foundNothing: isEmptyLookupResult(item.result ?? item.rawResult),
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
  // A cut row names its whole output's revision (the host computed it over the uncut text): what the phone's copy leaves out cannot
  // tell two revisions apart, and a read kept for one must not be shown for another.
  const whole = typeof item.remoteOutputRevision === 'string' ? item.remoteOutputRevision : null;
  return [
    item.remoteOutputTruncated ?? 0,
    item.completedAt ?? '',
    item.count ?? '',
    ...(whole === null
      ? [textIdentity(item.result), textIdentity(item.rawResult), textIdentity(item.uiDiff)]
      : [whole]),
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

export type ToolCallTone = 'error' | 'warning' | 'neutral';

/** How one call ended, the one answer its row and its group both read. */
export interface ToolCallOutcome {
  state: 'running' | 'done' | 'failed' | 'stopped';
  tone: ToolCallTone;
}

const COMMAND_TOOLS = /^(?:shell|bash|bash_session|shell_command|job_wait)$/;

/** A call's outcome. A stop is its own outcome, never a failure: a call whose
 *  result says "cancelled" was stopped unless the word is a cancel action's
 *  own answer or the status of a job it only reports (`cancelledCallWasStopped`).
 *  A stored call with no result at all ended with its turn (`stopped`).
 *  A call that neither ran to its end nor was stopped failed: its error flag,
 *  a failing exit, a hook's denial. */
export function toolCallOutcome(item: TranscriptItem): ToolCallOutcome {
  if (!toolItemDone(item)) return { state: 'running', tone: 'neutral' };
  if (item.stopped) return { state: 'stopped', tone: 'warning' };
  const basics = toolOutputBasics(item);
  const errored = Boolean(item.isError) || Number(item.errorCount || 0) > 0;
  const text = String(item.result ?? item.rawResult ?? '');
  let reportedJobStatus = '';
  if (basics.resultStatus === 'cancelled') {
    const surface = desktopToolActivitySurface(item.name, item.args);
    const stopped = cancelledCallWasStopped(text, {
      args: surface.args,
      errored,
      command: COMMAND_TOOLS.test(surface.normalizedName),
    });
    if (stopped) return { state: 'stopped', tone: 'warning' };
    // The call went through: it cancelled what it was asked to, or read a cancelled job's status.
    reportedJobStatus = toolResultControlStatus(text) ? '' : 'cancelled';
  }
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const settled = deriveToolOutcomeTone({
    pending: false,
    groupCount: Math.max(1, Math.round(Number(item.count || 1))),
    callFailedCount,
    exitFailedCount: Math.max(0, Number(item.exitErrorCount || 0)),
    terminalStatus: item.isError && basics.hookDenied ? 'denied' : reportedJobStatus,
    partialMutation: callFailedCount > 0 && toolItemHasDiff(item),
  });
  const tone: ToolCallTone = settled === 'error' || settled === 'warning' ? settled : 'neutral';
  if (reportedJobStatus) return { state: 'done', tone };
  if (errored || tone !== 'neutral') return { state: 'failed', tone: tone === 'neutral' ? 'error' : tone };
  return { state: 'done', tone };
}

export function toolActivityItemTone(item: TranscriptItem): ToolCallTone {
  return toolCallOutcome(item).tone;
}

/** A label's settled form: a catalog may give a label a `_done` variant
 *  ("Generate media" → "Generated media"); one without it reads the same either way. */
const SETTLED = { context: 'done' } as const;

function localizedToolActivityCategory(category: string, past = false): string {
  const options = past ? SETTLED : undefined;
  if (category === 'Read') return t('File reading', options);
  if (category === 'Search') return t('Search', options);
  if (category === 'Load') return t('Tool loading', options);
  if (category === 'MCP') return t('MCP tools', options);
  if (category === 'Skill') return t('Skills', options);
  if (category === 'Web Research') return t('Web research', options);
  if (category === 'Memory') return t('Memory', options);
  if (category === 'Explore') return t('Code exploration', options);
  if (category === 'Patch') return t('File editing', options);
  if (category === 'Git') return t('Git', options);
  if (category === 'Shell') return t('Command execution', options);
  if (category === 'Agent') return t('Agents', options);
  if (category === 'Task') return t('Tasks', options);
  if (category === 'Setup') return t('Setup', options);
  if (category === 'Goal') return t('Goal', options);
  if (category === 'Browser') return t('Browser Use', options);
  if (category === 'Computer') return t('Computer Use', options);
  if (category === 'Terminal') return t('Terminal', options);
  if (category === 'Office') return t('Document work', options);
  if (category === 'Media') return t('Media generation', options);
  if (category === 'Tidy') return t('Code Tidy', options);
  if (category === 'Visualize') return t('Visualize', options);
  return t('External tools', options);
}

function toolActivityUnitKey(category: string, done: string, noun: string): string {
  return category === 'MCP' ? 'MCP' : `${category}|${done}|${noun}`;
}

function localizedToolActivityUnit(category: string, done: string, noun: string, past = false): string {
  const options = past ? SETTLED : undefined;
  switch (toolActivityUnitKey(category, done, noun)) {
    case 'Read|Read|file':
      return t('File reading', options);
    case 'Read|Read|image':
      return t('Image viewing', options);
    case 'Read|Read|resource':
      return t('MCP resource reading', options);
    case 'Read|Read|code map':
      return t('Code structure', options);
    case 'Search|Searched|pattern':
      return t('Content search', options);
    case 'Search|Found|glob':
      return t('File lookup', options);
    case 'Search|Found|query':
      return t('Path lookup', options);
    case 'Search|Listed|directory':
      return t('Folder listing', options);
    case 'Search|Mapped|symbol':
      return t('Symbol lookup', options);
    case 'Patch|Created|file':
      return t('File creation', options);
    case 'Patch|Edited|file':
      return t('File editing', options);
    case 'Patch|Deleted|file':
      return t('File deletion', options);
    case 'Patch|Changed|file':
      return t('File changes', options);
    case 'Patch|Checked|file':
      return t('Patch check', options);
    case 'Load|Loaded|tool':
    case 'Load|Loaded|query':
      return t('Tool loading', options);
    case 'Skill|Loaded|skill':
      return t('Skills', options);
    case 'MCP':
      return t('MCP tool use', options);
    case 'Web Research|Researched|query':
      return t('Web search', options);
    case 'Web Research|Fetched|URL':
      return t('Page fetching', options);
    case 'Web Research|Fetched|message':
      return t('Message fetching', options);
    case 'Memory|Checked|memory item':
      return t('Memory lookup', options);
    case 'Memory|Wrote|memory item':
      return t('Memory saving', options);
    case 'Memory|Deleted|memory item':
      return t('Memory deletion', options);
    case 'Memory|Listed|memory item':
      return t('Memory listing', options);
    case 'Shell|Ran|command':
      return t('Command execution', options);
    case 'Git|Ran|Git command':
      return t('Git commands', options);
    case 'Git|Staged|change':
      return t('Git staging', options);
    case 'Agent|Called|agent':
      return t('Agent calls', options);
    case 'Agent|Checked|agent':
      return t('Agent status', options);
    case 'Agent|Completed|agent':
      return t('Agent responses', options);
    case 'Agent|Failed|agent':
      return t('Agent failures', options);
    case 'Agent|Cancelled|agent':
      return t('Agent cancellations', options);
    case 'Agent|Ended|agent':
      return t('Ended agents', options);
    case 'Task|Checked|task':
      return t('Task status', options);
    case 'Task|Waited for|task':
      return t('Task waiting', options);
    case 'Task|Listed|task':
      return t('Task listing', options);
    case 'Task|Cancelled|task':
      return t('Task cancellation', options);
    case 'Setup|Selected|project':
      return t('Project selection', options);
    case 'Setup|Listed|project':
      return t('Project listing', options);
    case 'Terminal|Listed|terminal tab':
      return t('Terminal tabs', options);
    case 'Terminal|Read|terminal output':
      return t('Terminal output', options);
    case 'Terminal|Ran|terminal command':
      return t('Terminal commands', options);
    case 'Media|Generated|image':
      return t('Image generation', options);
    case 'Media|Generated|video':
      return t('Video generation', options);
    case 'Media|Checked|media job':
      return t('Media status', options);
    case 'Media|Cancelled|media job':
      return t('Media cancellation', options);
    case 'Media|Listed|media catalog':
      return t('Media catalog', options);
    case 'Office|Read|document action':
      return t('Document reading', options);
    case 'Tidy|Previewed|cleanup pass':
      return t('Tidy preview', options);
    case 'Tidy|Installed|cleanup engine':
      return t('Tidy install', options);
    case 'Tidy|Scanned|project':
      return t('Tidy scan', options);
    case 'Tidy|Checked|cleanup action':
      return t('Tidy check', options);
    case 'Tidy|Read|cleanup rules':
      return t('Tidy rules', options);
    case 'Tidy|Read|cleanup results':
      return t('Tidy results', options);
    case 'Setup|Checked|working directory':
      return t('Project check', options);
    case 'Setup|Asked|user':
      return t('Questions', options);
    case 'Setup|Updated|plan':
      return t('Plan updates', options);
    case 'Setup|Viewed|plan':
      return t('Plan view', options);
    case 'Setup|Reacted|message':
      return t('Reaction', options);
    case 'Setup|Handed over|step to user':
      return t('Hand off to user', options);
    case 'Setup|Listed|worktree':
      return t('Worktree management', options);
    case 'Setup|Listed|MCP resource':
      return t('MCP resource listing', options);
    case 'Setup|Listed|MCP resource template':
      return t('MCP template listing', options);
    case 'Git|Managed|worktree':
      return t('Worktree management', options);
    case 'Setup|Created|session':
      return t('Session creation', options);
    case 'Setup|Sent to|session':
      return t('Session message', options);
    case 'Setup|Checked|session':
      return t('Session status', options);
    case 'Setup|Renamed|session':
    case 'Setup|Closed|session':
    case 'Setup|Forked|session':
    case 'Setup|Cancelled|session':
    case 'Setup|Deleted|session':
    case 'Setup|Favorited|session':
    case 'Setup|Unfavorited|session':
    case 'Setup|Archived|session':
    case 'Setup|Unarchived|session':
    case 'Setup|Scheduled|compaction':
      return t('Session management', options);
    default:
      return localizedToolActivityCategory(category, past);
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
  // summary reads "Visualize ×3" rather than one entry per action.
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
function desktopToolDescribeResult(
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
export function desktopToolActivitySurface(name: unknown, args: unknown): ToolActivitySurface {
  const held = args !== null && typeof args === 'object' ? toolSurfaces.get(args) : undefined;
  if (held && held.name === name) return held.surface;
  const identity = desktopToolDisplayIdentity(name, args);
  const formatted = formatToolSurface(desktopToolActivityModeledName(identity.name, identity.args), identity.args);
  const surface = {
    normalizedName: String(formatted.normalizedName),
    args: asRecord(formatted.args) ?? asRecord(identity.args) ?? {},
  };
  if (args !== null && typeof args === 'object') toolSurfaces.set(args, { name, surface });
  return surface;
}

type ToolActivitySurface = { normalizedName: string; args: Record<string, unknown> };
/** A call's surface, by its arguments object: read once, and for as long as the call's row holds those arguments. */
const toolSurfaces = new WeakMap<object, { name: unknown; surface: ToolActivitySurface }>();

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

/** A row's verb names the work its arguments ask for and what it acts on, in
 *  its group line's words, one phrase from start to end; how the call ended is
 *  its outcome beside it. A tool-named row ("Agent", "Task", "Browser") keeps
 *  its action in the subject. */
function toolActivityRowVerb(category: string, done: string, noun: string): string {
  switch (toolActivityUnitKey(category, done, noun)) {
    // A viewed image and a read resource are files read, as their group says.
    case 'Read|Read|file':
    case 'Read|Read|image':
    case 'Read|Read|resource':
      return t('Read file');
    case 'Read|Read|code map':
      return t('Code structure');
    case 'Search|Searched|pattern':
      return t('Search code');
    case 'Search|Found|glob':
      return t('Find files');
    case 'Search|Found|query':
      return t('Find path');
    case 'Search|Mapped|symbol':
      return t('Find symbol');
    case 'Search|Listed|directory':
      return t('List directory');
    case 'Terminal|Listed|terminal tab':
      return t('List tabs');
    case 'Terminal|Read|terminal output':
      return t('Read output');
    case 'Terminal|Ran|terminal command':
      return t('Run terminal command');
    case 'Setup|Updated|plan':
      return t('Update plan');
    case 'Setup|Reacted|message':
      return t('React to message');
    case 'Patch|Created|file':
      return t('Create file');
    case 'Patch|Edited|file':
    case 'Patch|Changed|file':
      return t('Edit file');
    case 'Patch|Deleted|file':
      return t('Delete file');
    case 'Patch|Checked|file':
      return t('Check patch');
    case 'Web Research|Researched|query':
      return t('Search web');
    case 'Web Research|Fetched|URL':
      return t('Fetch page');
    case 'Web Research|Fetched|message':
      return t('Fetch message');
    case 'Explore|Explored|query':
      return t('Explore code');
    case 'Shell|Ran|command':
      return t('Run command');
    case 'Git|Ran|Git command':
      return t('Run Git command');
    case 'Git|Staged|change':
      return t('Stage changes');
    case 'Tidy|Tidied|cleanup pass':
      return t('Tidy code');
    case 'Browser|Browsed|action':
      return t('Browser');
    case 'Agent|Called|agent':
    case 'Agent|Checked|agent':
    case 'Agent|Completed|agent':
    case 'Agent|Failed|agent':
    case 'Agent|Cancelled|agent':
    case 'Agent|Ended|agent':
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

export interface ToolActivityTerminalRun {
  /** The call's id: one card per run. */
  id: string;
  command: string;
  /** The terminal the command went to, from the bridge's reply. */
  terminalId: string;
}

const TERMINAL_RUN_REPLY = /Terminal run: (session-terminal:[^\s·"\\]+)/;

/** The commands a group's `terminal` calls ran, for the "터미널 · … · 보기" cards.
 *  Only a run whose reply names its terminal leaves a card: a call still
 *  running, a failed run, a read or a list has no tab to reveal. */
export function desktopToolActivityTerminalRuns(items: readonly TranscriptItem[]): ToolActivityTerminalRun[] {
  const runs: ToolActivityTerminalRun[] = [];
  for (const item of flattenedToolActivityItems(items)) {
    if (item.isError) continue;
    const surface = desktopToolActivitySurface(item.name, item.args);
    if (surface.normalizedName !== 'terminal' || surface.args.action !== 'run') continue;
    const command = typeof surface.args.command === 'string' ? surface.args.command.trim() : '';
    if (!command) continue;
    const value = item.result ?? item.rawResult;
    const reply = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    const terminalId = TERMINAL_RUN_REPLY.exec(reply)?.[1];
    if (terminalId) runs.push({ id: String(item.id), command, terminalId });
  }
  return runs;
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
function toolActivitySummaryPhrase(unit: SummaryUnit, count: number, past: boolean): string {
  const settled = past ? SETTLED : undefined;
  switch (unit.unitKey) {
    case 'Read|Read|file':
      return count === 1 ? t('Read file', settled) : t('Read {{count}} files', { count, ...settled });
    case 'Search|Searched|pattern':
      if (count === 1) return past ? t('Searched code') : t('Search code');
      return past ? t('Searched {{count}} patterns', { count }) : t('Search {{count}} patterns', { count });
    // A glob call counts its patterns: how many files they matched is the row's outcome.
    case 'Search|Found|glob':
      if (count === 1) return past ? t('Found files') : t('Find files');
      return past
        ? t('Found files for {{count}} patterns', { count })
        : t('Find files for {{count}} patterns', { count });
    case 'Search|Found|query':
      if (count === 1) return past ? t('Found path') : t('Find path');
      return past ? t('Found {{count}} paths', { count }) : t('Find {{count}} paths', { count });
    case 'Search|Listed|directory':
      if (count === 1) return past ? t('Listed directory') : t('List directory');
      return past ? t('Listed {{count}} directories', { count }) : t('List {{count}} directories', { count });
    case 'Search|Mapped|symbol':
      if (count === 1) return past ? t('Found symbol') : t('Find symbol');
      return past ? t('Found {{count}} symbols', { count }) : t('Find {{count}} symbols', { count });
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
      if (count === 1) return past ? t('Searched web') : t('Search web');
      return past ? t('Searched web {{count}} times', { count }) : t('Search web {{count}} times', { count });
    case 'Web Research|Fetched|URL':
      if (count === 1) return past ? t('Fetched page') : t('Fetch page');
      return past ? t('Fetched {{count}} pages', { count }) : t('Fetch {{count}} pages', { count });
    case 'Web Research|Fetched|message':
      if (count === 1) return past ? t('Fetched message') : t('Fetch message');
      return past ? t('Fetched {{count}} messages', { count }) : t('Fetch {{count}} messages', { count });
    case 'Explore|Explored|query':
      if (count === 1) return past ? t('Explored code') : t('Explore code');
      return past ? t('Explored {{count}} questions', { count }) : t('Explore {{count}} questions', { count });
    case 'Shell|Ran|command':
      return past ? t('Ran {{count}} commands', { count }) : t('Run {{count}} commands', { count });
    case 'Git|Ran|Git command':
      if (count === 1) return past ? t('Ran Git command') : t('Run Git command');
      return past ? t('Ran {{count}} Git commands', { count }) : t('Run {{count}} Git commands', { count });
    case 'Git|Staged|change':
      if (count === 1) return past ? t('Staged changes') : t('Stage changes');
      return past ? t('Staged {{count}} changes', { count }) : t('Stage {{count}} changes', { count });
    // Browser and Computer calls are one unit keyed by the category itself
    // (namedToolActivityUnit).
    case 'Browser':
      return count === 1 ? t('Browser action', settled) : t('Browser {{count}} actions', { count, ...settled });
    case 'Computer':
      return count === 1 ? t('Computer action', settled) : t('Computer {{count}} actions', { count, ...settled });
    case 'Office|Edited|document action':
      return count === 1 ? t('Office action', settled) : t('Office {{count}} actions', { count, ...settled });
    case 'Media|Generated|image':
    case 'Media|Generated|video':
      return count === 1 ? t('Generate media', settled) : t('Generate {{count}} media', { count, ...settled });
    case 'Tidy|Tidied|cleanup pass':
      return count === 1 ? t('Tidy code', settled) : t('Tidy code {{count}} times', { count, ...settled });
    case 'Agent|Called|agent':
      if (count === 1) return past ? t('Called agent') : t('Call agent');
      return past ? t('Called {{count}} agents', { count }) : t('Call {{count}} agents', { count });
    case 'Agent|Completed|agent':
      return count === 1 ? t('Agent response') : countedUnitLabel(unit.label, count, past);
    case 'Task|Checked|task':
      if (count === 1) return past ? t('Checked task') : t('Check task');
      return past ? t('Checked {{count}} tasks', { count }) : t('Check {{count}} tasks', { count });
    case 'Task|Waited for|task':
      if (count === 1) return past ? t('Waited for task') : t('Wait for task');
      return past ? t('Waited for {{count}} tasks', { count }) : t('Wait for {{count}} tasks', { count });
    case 'Task|Listed|task':
      return past ? t('Listed tasks') : t('List tasks');
    case 'Task|Cancelled|task':
      if (count === 1) return past ? t('Cancelled task') : t('Cancel task');
      return past ? t('Cancelled {{count}} tasks', { count }) : t('Cancel {{count}} tasks', { count });
    default:
      if (count > 1) return countedUnitLabel(unit.label, count, past);
      return past ? unit.pastLabel : unit.label;
  }
}

/** A unit without a count phrase of its own: its name, then how many it covers
 *  ("Visualize ×3", Korean "워크트리 관리 4회" like the other counted labels).
 *  A bare trailing number read as part of the name. */
function countedUnitLabel(label: string, count: number, past = false): string {
  if (count <= 1) return label;
  return t('{{label}} ×{{count}}', { label, count, ...(past ? SETTLED : undefined) });
}

/** Units that read as one phrase share one summary entry: a viewed image and a
 *  read MCP resource are files read, so they join "Read N files" instead of
 *  repeating it. */
function summaryUnitKey(unitKey: string): string {
  return unitKey === 'Read|Read|image' || unitKey === 'Read|Read|resource' ? 'Read|Read|file' : unitKey;
}

type SummaryUnit = ReturnType<typeof desktopToolActivityUnit> & { pastLabel: string };

/** A unit's name in its settled form; a named target (an MCP server, a skill,
 *  GitHub) reads the same either way. */
function settledUnitLabel(unit: ReturnType<typeof desktopToolActivityUnit>): string {
  if (unit.unitKey === 'Load|Described|tool') return t('Tool description', SETTLED);
  if (unit.unitKey === 'Browser' || unit.unitKey === 'Computer' || unit.unitKey === 'Visualize') {
    return localizedToolActivityCategory(unit.category, true);
  }
  if (unit.unitKey !== toolActivityUnitKey(unit.category, unit.done, unit.noun) || unit.category === 'MCP') {
    return unit.label;
  }
  return localizedToolActivityUnit(unit.category, unit.done, unit.noun, true);
}

/** What a lookup whose settled phrase claims a find ("Found files") says when
 *  none of its calls found anything; null for every other unit. */
function emptyLookupPhrase(unitKey: string): string | null {
  switch (unitKey) {
    case 'Search|Found|glob':
      return t('Found no files');
    case 'Search|Found|query':
      return t('Found no paths');
    case 'Search|Mapped|symbol':
      return t('Found no symbols');
    default:
      return null;
  }
}

/** What one call adds to its group's count, the one rule for every unit. A
 *  call still running counts what it set out to do, and a finished one what
 *  it did, though a lookup that returned nothing found none (`empty`). A
 *  failed or stopped call did not do its work (`none`), except a command that
 *  ran to a failing exit. A completion notice is counted under the unit that
 *  names how its agent ended ("Agent failures"), whatever that end was. */
function countedCall(
  item: TranscriptItem,
  unit: ReturnType<typeof desktopToolActivityUnit>
): { state: ToolCallOutcome['state']; work: 'counted' | 'empty' | 'none' } {
  if (unit.category === 'Agent' && desktopToolActivitySurface(item.name, item.args).args.type === 'result') {
    return { state: toolItemDone(item) ? 'done' : 'running', work: 'counted' };
  }
  const { state } = toolCallOutcome(item);
  if (state === 'running') return { state, work: 'counted' };
  if (state === 'done') {
    const empty =
      emptyLookupPhrase(unit.unitKey) !== null &&
      (toolOutputBasics(item).foundNothing || !String(item.result ?? item.rawResult ?? '').trim());
    return { state, work: empty ? 'empty' : 'counted' };
  }
  const ranToFailingExit =
    state === 'failed' && Number(item.exitErrorCount || 0) > 0 && !Number(item.callErrorCount || 0);
  return { state, work: ranToFailingExit ? 'counted' : 'none' };
}

const EDIT_TOOLS = /^(?:edit|write|strreplace|str_replace|str_replace_editor|search_replace)$/;

/** The files a change call names: one path, or each file section of a patch;
 *  empty when it names none. */
function changedFiles(name: unknown, args: unknown): string[] {
  const surface = desktopToolActivitySurface(name, args);
  if (EDIT_TOOLS.test(surface.normalizedName)) {
    const path = surface.args.file_path ?? surface.args.filePath ?? surface.args.path ?? surface.args.file;
    return typeof path === 'string' && path.trim() ? [path.trim()] : [];
  }
  const patch = typeof surface.args.patch === 'string' ? surface.args.patch : '';
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm)].map((match) => match[1]);
  if (files.length) return files;
  // A path may hold spaces: an unrenamed file names the same path twice, a
  // renamed one its new path on the `+++` line.
  return patch
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
    .map(
      (section) =>
        section.match(/^diff --git a\/(.+) b\/\1[ \t]*$/m)?.[1] ?? section.match(/^\+\+\+ b\/(.+?)[ \t]*$/m)?.[1] ?? ''
    );
}

/** A unit whose every call failed or stopped: the phrase it read while its
 *  calls ran, marked as not having happened. Failures and stops together say
 *  how many of each, apart from the phrase's own count. */
function unfinishedPhrase(entry: SummaryEntry): string {
  const label = toolActivitySummaryPhrase(entry.unit, workCount(entry.unit, entry.asked), false);
  if (entry.failed === 0) return t('{{label}} stopped', { label });
  if (entry.stopped === 0) return t('{{label}} failed', { label });
  const outcome = [
    t('{{count}} failed', { count: entry.failed }),
    t('{{count}} stopped', { count: entry.stopped }),
  ].join(summaryListSeparator());
  return t('{{label}}: {{outcome}}', { label, outcome });
}

/** A plain enumeration comma; Japanese and Chinese write theirs as "、". */
function summaryListSeparator(): string {
  return /^(?:ja|zh)/.test(uiFormatLocale()) ? '、' : ', ';
}

interface WorkTally {
  /** What the calls cover. */
  count: number;
  /** A change unit's distinct files. */
  files: Set<string>;
  /** Units of change calls that name no file. */
  unnamed: number;
}

/** How many of a unit a tally covers: a change counts the files it names. */
function workCount(unit: SummaryUnit, tally: WorkTally): number {
  return unit.category === 'Patch' && tally.files.size ? tally.files.size + tally.unnamed : tally.count;
}

interface SummaryEntry {
  unit: SummaryUnit;
  calls: number;
  failed: number;
  stopped: number;
  /** What every call set out to do. */
  asked: WorkTally;
  /** What the calls that count cover (`countedCall`). */
  counted: WorkTally;
  /** The part of `counted.count` from finished lookups that found nothing. */
  empty: number;
}

/** The phrase one unit adds: its work counted over the calls that did it, or,
 *  when none did, what failed or stopped. A settled group claims nothing for a
 *  lookup that found nothing. */
function summaryEntryPhrase(entry: SummaryEntry, past: boolean): string {
  const { unit, calls, failed, stopped } = entry;
  if (calls > 0 && failed + stopped === calls) return unfinishedPhrase(entry);
  let count = past ? entry.counted.count - entry.empty : entry.counted.count;
  if (unit.category === 'Patch' && entry.counted.files.size) count = workCount(unit, entry.counted);
  if (count === 0) return emptyLookupPhrase(unit.unitKey) ?? '';
  return toolActivitySummaryPhrase(unit, count, past);
}

/** The group summary: each work unit summarized as a natural verb phrase, file
 *  changes first, then the rest in call order, as one list ("Edit 2 files,
 *  Read 6 files, Run 4 commands"). A unit whose every call failed reads as the
 *  phrase it ran under, marked failed ("Run 1 command failed"); failures among
 *  calls that did their work close the list as "N failed". */
export function desktopToolActivitySummary(items: readonly TranscriptItem[], settled = false): string {
  const groups = new Map<string, SummaryEntry>();
  const calls = flattenedToolActivityItems(items);
  for (const item of calls) {
    const basics = toolOutputBasics(item);
    const unit = desktopToolActivityUnit(item.name, item.args, Boolean(basics.described));
    const unitKey = summaryUnitKey(unit.unitKey);
    const added = Math.max(1, Math.round(Number(item.count || 1))) * unit.count;
    let entry = groups.get(unitKey);
    if (!entry) {
      const shown = { ...unit, unitKey };
      entry = {
        unit: { ...shown, pastLabel: settledUnitLabel(shown) },
        calls: 0,
        failed: 0,
        stopped: 0,
        asked: { count: 0, files: new Set(), unnamed: 0 },
        counted: { count: 0, files: new Set(), unnamed: 0 },
        empty: 0,
      };
      groups.set(unitKey, entry);
    }
    const { state, work } = countedCall(item, unit);
    const files = unit.category === 'Patch' ? changedFiles(item.name, item.args).filter(Boolean) : [];
    // Sections whose path could not be read still change a file each.
    const unnamed = unit.category === 'Patch' ? Math.max(0, unit.count - files.length) : 0;
    const tally = (into: WorkTally) => {
      into.count += added;
      for (const file of files) into.files.add(file);
      into.unnamed += unnamed;
    };
    entry.calls += 1;
    if (state === 'failed') entry.failed += 1;
    if (state === 'stopped') entry.stopped += 1;
    tally(entry.asked);
    if (work === 'none') continue;
    if (work === 'empty') {
      entry.counted.count += added;
      entry.empty += added;
    } else tally(entry.counted);
  }
  const changesFiles = (unitKey: string) => (unitKey.startsWith('Patch|') ? 0 : 1);
  const entries = [...groups.values()].sort(
    (left, right) => changesFiles(left.unit.unitKey) - changesFiles(right.unit.unitKey)
  );
  const phrases = entries.map((entry) => summaryEntryPhrase(entry, settled)).filter(Boolean);
  const partly = entries.filter((entry) => entry.failed + entry.stopped < entry.calls);
  const partlyFailed = partly.reduce((total, entry) => total + entry.failed, 0);
  const partlyStopped = partly.reduce((total, entry) => total + entry.stopped, 0);
  if (partlyFailed > 0) phrases.push(t('{{count}} failed', { count: partlyFailed }));
  if (partlyStopped > 0) phrases.push(t('{{count}} stopped', { count: partlyStopped }));
  return phrases.join(summaryListSeparator());
}

/** The work-unit name a call is counted under. */
export function desktopToolActivityUnitLabel(name: unknown, args: unknown, described = false): string {
  return desktopToolActivityUnit(name, args, described).label;
}
