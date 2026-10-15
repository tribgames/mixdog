import type { TranscriptItem } from './desktop-types';
import { t, tExisting } from './i18n';
import { normalizeApplyPatch, parseUnifiedDiff, patchLineCounts } from './renderer-logic.mjs';
import { asRecord, oneLine } from './text-format';
import {
  toolFileEntries,
  toolFileSection,
  toolOutputSections,
  type ToolFileEntry,
  type ToolOutputSection,
} from './transcript-tool-sections';
import {
  desktopToolActivityCategory,
  desktopToolActivityModeledName,
  desktopToolActivityRowVerb,
  desktopToolActivityUnitLabel,
  desktopToolDescribeResult,
  desktopToolDisplayIdentity,
  toolActivityItemTone,
  toolItemDone,
  type ToolCardModel,
} from './transcript-tool-core';
import {
  TOOL_ACTIVITY_BULK_ARGS,
  TOOL_ACTIVITY_INTERNAL_ARGS,
  TOOL_ACTIVITY_MEANINGLESS_RESULT,
  toolActivityIsOperationalArg,
  TOOL_ACTIVITY_ROUTINE_RESULT,
  toolActivityCodeLanguage,
  toolActivityCommand,
  toolActivityFieldLabel,
  toolActivityFieldValue,
  toolActivityFirstText,
  toolActivityRedactInlineSecrets,
  shortMachineId,
  toolActivityRepresentedKeys,
  toolActivitySubject,
  toolActivityTargets,
  visualizeRowSubject,
} from './transcript-tool-format';
import { callArgs } from './visualize-card-model';
import {
  toolActivityBackgroundTask,
  toolActivityCleanOutput,
  toolActivityErrorSummary,
  toolActivityIsCompleted,
  toolActivityOutputText,
  toolActivityResultValue,
  toolActivityLocalizeTaskList,
  toolActivityShellFailureLabel,
  toolActivityStripInstructions,
  toolActivityStructuredRows,
  type ToolActivityStructuredKind,
  type ToolActivityStructuredRow,
} from './transcript-tool-result';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { formatToolSurface } from '../../../../src/runtime/shared/tool-surface.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { agentActionTitle, agentResponseTitle, deriveToolCardModel, resultTerminalStatus } from '../../../../src/runtime/shared/tool-card-model.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { readRowsForDisplay } from '../../../../src/runtime/shared/read-row-numbers.mjs';

export * from './transcript-tool-core';
export * from './transcript-tool-format';
export * from './transcript-tool-result';

/** Tools whose successful output is never worth showing. */
const QUIET_SUCCESS_TOOLS = new Set(['load_tool', 'skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill']);
/** Tools whose routine success text ("ok", "done", …) is suppressed. */
const ROUTINE_RESULT_TOOLS = new Set([
  'agent',
  'bridge',
  'task',
  'browser',
  'browser_devtools',
  'computer',
  'office',
  'media',
  'tidy',
  'visualize',
  'cwd',
  'session',
  'setup',
]);

interface DesktopToolActivityItemPresentation {
  category: string;
  title: string;
  /** Set when a bridge call ran the presented tool (`call_tool`). */
  via?: 'call_tool';
  /** The short verb the call's own row opens with. */
  verb: string;
  subject: string;
  /** Each target of a call that carried several (files, patterns, commands…). */
  targets: string[];
  resultLabel: string;
  pending: boolean;
  tone: string;
  command: string;
  fields: Array<{ key: string; label: string; value: string }>;
  diffPatch: string;
  diffCounts: { additions: number; deletions: number } | null;
  outputText: string;
  /** One quiet line under the output ("종료 코드 2", the still-running note). */
  outputNote: string;
  /** The part of the closed-row outcome that may ellipsize (an error's first line). */
  outcomeReason: string;
  metaText: string;
  outputLanguage: string;
  previewText: string;
  beforeText: string;
  afterText: string;
  replacementLanguage: string;
  structuredKind: ToolActivityStructuredKind;
  structuredRows: ToolActivityStructuredRow[];
  hasDetails: boolean;
  hideSubjectWhenOpen: boolean;
  /** File/folder the call targeted (`file_path`, `path`…), so the header
   *  subject can open it like a chat file link. */
  targetPath: string;
  targetLine?: number;
  /** The subject as the row shows it: a file target by name, not full path. */
  headerSubject: string;
  /** The subject names the target itself, so it may open it. A search
   *  pattern beside a search folder is not a link to that folder. */
  subjectIsTarget: boolean;
  /** How the row sets its subject: a file or a count of them reads as a
   *  name, a command or pattern as code, anything else as plain words. */
  subjectKind: 'target' | 'code' | 'text';
  /** A read, grep or code-graph result as per-file sections of numbered rows. */
  sections: ToolOutputSection[];
  /** A glob, find or list result as file rows, with the lines that are not. */
  entries: ToolFileEntry[];
  entryNotes: string[];
  /** What the copy control of a sectioned result writes. */
  sectionCopyText: string;
  /** Short scalar arguments, shown as one quiet line instead of a table. */
  fieldsInline: boolean;
  /** Output that is literal text (file rows, matches, a listing, a command's
   *  output), never markdown: a `# grep src/a.ts` section is not a heading. */
  outputLiteral: boolean;
  /** The instructions an agent call handed over. */
  promptText: string;
}

/** Tools whose output is a task/background envelope carrying the runtime's
 *  instructions to the model; every other tool's output is the user's content. */
const TASK_ENVELOPE_TOOLS = /^(?:task|agent)$/;

const AGENT_TITLE_VERBS: Record<string, () => string> = {
  'Agent status': () => t('Agent status'),
  Spawn: () => t('Spawn'),
  Send: () => t('Send'),
  Cancel: () => t('Cancel'),
  Close: () => t('Close'),
  Cleanup: () => t('Cleanup'),
  Read: () => t('Read'),
  Status: () => t('Status'),
  Response: () => t('Response'),
};

/** A patch's target count ("2 Files") reads in the active language. */
function localizePatchTarget(target: string): string {
  const count = /^(\d+) files?$/i.exec(target.trim());
  return count ? t('{{count}} files', { count: Number(count[1]) }) : target.toLowerCase();
}

type PresentationCardModel = ToolCardModel & {
  resultSummary?: string | null;
  resultSummaryDisplay?: string | null;
  displayedResultBodyText?: string;
  terminalStatus?: string;
  isAgentResponse?: boolean;
};

type PresentationBackgroundTask = ReturnType<typeof toolActivityBackgroundTask>;

/** What the closed row reports for a finished, stopped or failed call, from
 *  one place: a stopped call reads "Stopped", a failed background task keeps
 *  its status and exit, a running one reports nothing (its output is the
 *  body), a failed command reads "실패 · <why>". */
function toolActivityFailureOutcome(input: {
  stopped: boolean;
  backgroundTask: PresentationBackgroundTask;
  foregroundShellFailure: boolean;
  rawResult: string;
  outputText: string;
  resultLabel: string;
}): { resultLabel: string; outputText: string; reason: string } {
  const { stopped, backgroundTask, foregroundShellFailure, rawResult } = input;
  let { outputText, resultLabel } = input;
  let reason = '';
  if (stopped) {
    resultLabel = t('Stopped');
    // The runtime's own stop note ("cancelled") is not something the call said.
    if (resultTerminalStatus(outputText) === 'cancelled') outputText = '';
  }
  if (backgroundTask?.failed) {
    resultLabel = backgroundTask.outcome;
    reason = backgroundTask.reason;
  } else if (backgroundTask?.running) resultLabel = '';
  if (foregroundShellFailure) {
    // The live result drops the `[exit code: N]` marker the raw result keeps.
    if (/^\[exit(?: code)?:\s*-?\d+\]/m.test(rawResult) && !/^\[exit(?: code)?:/m.test(outputText)) {
      outputText = toolActivityCleanOutput(toolActivityOutputText(rawResult))
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '');
    }
    ({ label: resultLabel, reason } = toolActivityShellFailureLabel(outputText, resultLabel));
  }
  return { resultLabel, outputText, reason };
}

/** The shared agent title opens with an English action word ("Spawn (r)"). */
function localizeAgentTitle(title: string): string {
  const match = /^(Agent status|Spawn|Send|Cancel|Close|Cleanup|Read|Status|Response)\b([\s\S]*)$/.exec(title);
  return match ? `${AGENT_TITLE_VERBS[match[1]]()}${match[2]}` : title;
}

const LITERAL_OUTPUT_CATEGORIES = new Set(['Read', 'Search', 'Git', 'Shell', 'Patch', 'Task']);
const CODE_SUBJECT_TOOLS = /^(?:shell|bash|bash_session|shell_command|job_wait|git|grep|glob|find|code_graph)$/;
const SECTION_TOOLS = new Set(['read', 'grep', 'code_graph']);
const LISTING_TOOLS = new Set(['glob', 'find', 'list', 'ls']);

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** A unified diff whose every hunk carries the line counts its header states.
 *  Output cut at a limit fails this and stays terminal text: the diff view
 *  cannot draw half a hunk. */
function isCompletePatch(text: string): boolean {
  if (!/^diff --git /.test(text)) return false;
  let hunks = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (oldLeft || newLeft) return false;
      hunks += 1;
      oldLeft = Number(header[1] ?? 1);
      newLeft = Number(header[2] ?? 1);
      continue;
    }
    if (!oldLeft && !newLeft) {
      if (
        hunks &&
        line &&
        !/^(?:diff --git |index |--- |\+\+\+ |new file|deleted file|similarity|rename|old mode|new mode|\\)/.test(line)
      ) {
        return false;
      }
      continue;
    }
    if (line.startsWith('+')) newLeft -= 1;
    else if (line.startsWith('-')) oldLeft -= 1;
    else if (line.startsWith(' ') || line === '') {
      oldLeft -= 1;
      newLeft -= 1;
    } else if (!line.startsWith('\\')) return false;
    if (oldLeft < 0 || newLeft < 0) return false;
  }
  return hunks > 0 && !oldLeft && !newLeft;
}

/** The file sections of a patch that belong to one edited file. Calls landing
 *  in the same batch can each carry the whole batch's patch; the row names one
 *  file, so its body shows that file only. A patch with no section for the
 *  target is kept whole. */
function patchForTarget(patch: string, targetPath: string, root = ''): string {
  // Exact path identity: separators, `.`/`..` segments and absolute-vs-relative
  // (against the call's root) are normalized; a suffix never matches.
  // Windows-style paths (drive letter, UNC or backslash form) compare
  // case-insensitively; POSIX paths compare exactly.
  const isWindows = (path: string) => /^[A-Za-z]:|^[\\/]{2}/.test(path) || path.includes('\\');
  const clean = (path: string) => {
    const slashed = path.replace(/\\/g, '/');
    const head = /^(?:[A-Za-z]:\/?|\/\/|\/)/.exec(slashed)?.[0] ?? '';
    const out: string[] = [];
    for (const part of slashed.slice(head.length).split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') out.push(part);
      else if (out.length && out.at(-1) !== '..') out.pop();
      else if (!head) out.push(part);
    }
    return { head, path: head + out.join('/') };
  };
  const rootWindows = isWindows(root);
  const rootDir = root ? clean(root).path.replace(/(?<=.)\/$/, '') : '';
  const identity = (path: string) => {
    const win = rootWindows || isWindows(path);
    const own = clean(path);
    const cleaned = rootDir && !own.head ? clean(`${rootDir}/${path}`).path : own.path;
    const fold = (text: string) => (win ? text.toLowerCase() : text);
    if (rootDir && fold(cleaned).startsWith(`${fold(rootDir)}/`))
      return { key: cleaned.slice(rootDir.length + 1), win };
    return { key: cleaned, win };
  };
  const target = identity(targetPath);
  if (!targetPath || !target.key) return patch;
  const sections = patch.split(/^(?=diff --git )/m);
  if (sections.length < 2) return patch;
  const names = (section: string) =>
    (/^diff --git a\/(.+?) b\/(.+)$/m.exec(section)?.slice(1) ?? []).map((name) => name.trim());
  const matches = (name: string) => {
    const candidate = identity(name);
    return target.win || candidate.win
      ? candidate.key.toLowerCase() === target.key.toLowerCase()
      : candidate.key === target.key;
  };
  const own = sections.filter((section) => names(section).some(matches));
  return own.length ? own.join('').trim() : patch;
}

function isJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** The row already says "Git": `git diff -- a.ts` reads as `diff -- a.ts`. */
function rowSubject(normalizedName: string, subject: string): string {
  return normalizedName === 'git' ? subject.replace(/^git\s+/, '') : subject;
}

/** `src/app/a.ts:3-9` reads as `a.ts:3-9` on the row; the panel names the path. */
function fileHeaderSubject(subject: string, targetPath: string): string {
  if (!targetPath || !subject.startsWith(targetPath)) return subject;
  const base =
    targetPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || targetPath;
  return `${base}${subject.slice(targetPath.length)}`;
}

/** A file change's row verb says what happened to the file: in progress while
 *  it runs, then created, edited or deleted by its own diff. Empty when the
 *  call is no file change or failed (the plain verb then stays). */
function fileChangeVerb(
  category: string,
  pending: boolean,
  tone: string,
  diffPatch: string,
  originalName: string
): string {
  if (category !== 'Patch') return '';
  if (pending) return originalName === 'write' ? t('Writing file') : t('Editing');
  if (tone !== 'neutral' || !diffPatch) return '';
  const statuses = parseUnifiedDiff(diffPatch).map((file) => file.status);
  if (statuses.every((status) => status === 'A')) return t('Created file');
  if (statuses.every((status) => status === 'D')) return t('Deleted file');
  return t('Edited file');
}

/** The file a change's diff names, as the session diff lists it. */
export function diffTargetPath(diffPatch: string): string {
  const file = parseUnifiedDiff(diffPatch)[0];
  if (!file) return '';
  return file.status === 'D' ? file.oldFile.fileName : file.newFile.fileName;
}

/** The call as the shared card model reads it: the tool name it surfaces
 *  under, its normalized arguments and its card model. */
function presentationCall(item: TranscriptItem, nowMs: number) {
  const name = String(item.name || 'tool');
  const originalSurface = formatToolSurface(name, item.args);
  const originalName = originalSurface.normalizedName;
  const modeledName = desktopToolActivityModeledName(name, item.args);
  const surface = formatToolSurface(modeledName, item.args);
  const normalizedName = surface.normalizedName;
  const args = asRecord(surface.args) ?? asRecord(item.args) ?? {};
  const done = toolItemDone(item);
  const model = deriveToolCardModel(
    {
      name: modeledName,
      args: item.args,
      result: item.result,
      rawResult: item.rawResult,
      isError: item.isError,
      errorCount: item.errorCount,
      callErrorCount: item.callErrorCount,
      exitErrorCount: item.exitErrorCount,
      count: 1,
      completedCount: done ? 1 : 0,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      headerFinalized: item.headerFinalized,
      nowMs,
    },
    { translate: tExisting }
  ) as PresentationCardModel;
  return { name, originalName, normalizedName, args, model };
}

/** An agent call's title; empty for every other tool. */
function presentationAgentTitle(
  normalizedName: string,
  args: Record<string, unknown>,
  item: TranscriptItem,
  model: PresentationCardModel
): string {
  if (normalizedName !== 'agent') return '';
  // A response is only a completion notification; status/read are checks.
  const resultText = String(item.result ?? item.rawResult ?? '');
  return model.isAgentResponse ? agentResponseTitle(args, 1, resultText) : agentActionTitle(args, resultText);
}

/** The row subject: an agent call's title, a visualize call's tab, else the
 *  tool's own subject; inline secrets are redacted. */
function presentationSubject(
  normalizedName: string,
  args: Record<string, unknown>,
  item: TranscriptItem,
  agentTitle: string,
  summary: string,
  visualizeTabTitle: string
): string {
  let text: string;
  if (agentTitle) text = localizeAgentTitle(agentTitle);
  else if (normalizedName === 'visualize') {
    text = visualizeRowSubject(callArgs(item).action, args, visualizeTabTitle) || summary;
  } else text = toolActivitySubject(normalizedName, args, summary);
  const subject = toolActivityRedactInlineSecrets(text, args);
  // A command is the user's own text; every other subject may carry machine
  // ids. Only task and agent subjects can carry the runtime's instructions.
  if (CODE_SUBJECT_TOOLS.test(normalizedName)) return subject;
  return shortMachineId(
    TASK_ENVELOPE_TOOLS.test(normalizedName) ? toolActivityStripInstructions(subject, true) : subject
  );
}

/** The texts an edit or write shows when the call carries no diff. A written
 *  file that already has a diff shows the diff alone: the preview would
 *  repeat every line of it. */
function presentationEditTexts(
  originalName: string,
  normalizedName: string,
  args: Record<string, unknown>,
  diffPatch: string,
  targetPath: string
) {
  const previewText = !diffPatch && originalName === 'write' && typeof args.content === 'string' ? args.content : '';
  const beforeText =
    !diffPatch && normalizedName === 'edit' ? toolActivityFirstText(args, 'old_string', 'oldString', 'old_str') : '';
  const afterText =
    !diffPatch && normalizedName === 'edit' ? toolActivityFirstText(args, 'new_string', 'newString', 'new_str') : '';
  const replacementLanguage = beforeText || afterText ? toolActivityCodeLanguage(targetPath) : '';
  return { previewText, beforeText, afterText, replacementLanguage };
}

/** The call's output text, and the background task it (or a restored
 *  completion notice's raw envelope) reports. */
function presentationRawOutput(
  item: TranscriptItem,
  model: PresentationCardModel,
  normalizedName: string,
  args: Record<string, unknown>
) {
  const rawOutputText = presentationOutputText(
    normalizedName,
    item.result ?? model.displayedResultBodyText ?? item.rawResult
  );
  // A restored completion notice keeps only its `<result>` guidance as the
  // result; the envelope itself rides in rawResult.
  const restoredNotice = args.type === 'result';
  // Only a task wait result carries the producer's cue paragraph.
  const taskWait = normalizedName === 'task' && args.action === 'wait';
  const backgroundTask: PresentationBackgroundTask =
    toolActivityBackgroundTask(rawOutputText, taskWait) ??
    (restoredNotice ? toolActivityBackgroundTask(String(item.rawResult ?? '')) : null);
  return { rawOutputText, backgroundTask, restoredNotice, taskWait };
}

/** The row's tone, and the two outcomes that decide it beyond the item's own
 *  tone: a stopped command and a failed foreground command. */
function presentationTone(
  item: TranscriptItem,
  model: PresentationCardModel,
  normalizedName: string,
  backgroundTask: PresentationBackgroundTask
): { tone: string; stopped: boolean; foregroundShellFailure: boolean } {
  const failed =
    item.isError ||
    Number(item.errorCount || 0) > 0 ||
    /fail|error|timeout|denied/i.test(String(model.terminalStatus || ''));
  // A call stopped by the user or the runtime did not fail: it reads
  // "Stopped" in the quieter warning ink, never as a failure.
  // (A task tool's "cancel" action reports what it cancelled; that is its
  // result, not a stop of the call, so only command runs read this way.)
  const stopped =
    !model.pending &&
    /^(?:shell|bash|bash_session|shell_command)$/.test(normalizedName) &&
    resultTerminalStatus(item.result ?? item.rawResult) === 'cancelled';
  let tone = stopped ? 'warning' : toolActivityItemTone(item);
  if (tone === 'neutral' && failed) tone = 'error';
  if (backgroundTask?.failed && tone === 'neutral') tone = 'error';
  // A foreground command that failed reads "실패 · <why>" and keeps its output.
  // (A non-zero exit is a "warning" tone: the call itself did not fail.)
  const foregroundShellFailure =
    tone !== 'neutral' &&
    !stopped &&
    !model.pending &&
    !backgroundTask &&
    /^(?:shell|bash|bash_session|shell_command|job_wait)$/.test(normalizedName);
  // A failed command looks like every other failure to the reader; "warning"
  // stays the internal tone (a non-zero exit is not a failed call).
  if (foregroundShellFailure) tone = 'error';
  return { tone, stopped, foregroundShellFailure };
}

/** The output body without its task/background envelope, and the quiet note
 *  for a job whose output has not arrived yet. */
function presentationOutputBody(input: {
  normalizedName: string;
  outputText: string;
  backgroundTask: PresentationBackgroundTask;
  restoredNotice: boolean;
  taskWait: boolean;
}): { outputText: string; outputNote: string } {
  const { normalizedName, backgroundTask, restoredNotice, taskWait } = input;
  let { outputText } = input;
  let waitingForOutput = false;
  if (backgroundTask) outputText = backgroundTask.body;
  else if (TASK_ENVELOPE_TOOLS.test(normalizedName) || restoredNotice) {
    // A read of a live job has no lines yet: its whole result is that one
    // label, so say so instead of showing it as output.
    waitingForOutput = /^Job still running; \d+ new lines?\.?$/i.test(outputText.trim());
    outputText = waitingForOutput ? '' : toolActivityStripInstructions(outputText, false, taskWait);
  }
  if (backgroundTask?.running && !outputText.trim()) waitingForOutput = true;
  // The card is a snapshot of the call: the note must stay true after the job ends.
  const outputNote = waitingForOutput ? t('Running in the background · a notice appears when it completes') : '';
  if (normalizedName === 'task') outputText = toolActivityLocalizeTaskList(outputText);
  return { outputText, outputNote };
}

/** The output, or nothing when a successful call's output is routine: a
 *  structured result, a routine "ok", a quiet tool, an image marker, or a
 *  mutation whose diff already shows it. */
function suppressRoutineOutput(input: {
  normalizedName: string;
  outputText: string;
  tone: string;
  structuredKind: ToolActivityStructuredKind;
  diffPatch: string;
}): string {
  const { normalizedName, outputText, tone, structuredKind, diffPatch } = input;
  const mutation = normalizedName === 'edit' || normalizedName === 'apply_patch';
  const quietSuccessSurface = QUIET_SUCCESS_TOOLS.has(normalizedName);
  const routineSurface = mutation || quietSuccessSurface || ROUTINE_RESULT_TOOLS.has(normalizedName);
  if (
    structuredKind ||
    (tone === 'neutral' && routineSurface && TOOL_ACTIVITY_ROUTINE_RESULT.test(outputText.trim()))
  ) {
    return '';
  }
  if (tone === 'neutral' && quietSuccessSurface) return '';
  if (normalizedName === 'view_image' && /^\[image:/i.test(outputText.trim())) return '';
  if (tone === 'neutral' && diffPatch && mutation) return '';
  return outputText;
}

/** The result label before cleanup: the settled call's summary or failure, a
 *  structured result's progress, or a stage call's "Staged". */
function presentationBaseResultLabel(input: {
  model: PresentationCardModel;
  tone: string;
  normalizedName: string;
  args: Record<string, unknown>;
  outputText: string;
  structuredRows: readonly ToolActivityStructuredRow[];
}): { label: string; localize: (text: string) => string } {
  const { model, tone, normalizedName, args, outputText, structuredRows } = input;
  let label = '';
  let localize = (text: string): string => text;
  if (!model.pending) {
    ({ label, localize } = settledResultLabel(model, tone, QUIET_SUCCESS_TOOLS.has(normalizedName), outputText));
  }
  if (structuredRows.length) {
    const completed = structuredRows.filter((row) => toolActivityIsCompleted(row.status)).length;
    label = `${completed}/${structuredRows.length}`;
    localize = (text) => text;
  }
  if (
    !label &&
    (normalizedName === 'git_stage' || (normalizedName === 'git' && args.action === 'stage')) &&
    /^staged\b/i.test(outputText.trim())
  ) {
    label = 'Staged';
    localize = () => t('Staged');
  }
  return { label, localize };
}

/** A one-line output that only repeats the result label is said once. */
function dedupeOneLineOutcome(input: {
  normalizedName: string;
  backgroundTask: PresentationBackgroundTask;
  foregroundShellFailure: boolean;
  command: string;
  label: string;
  outputText: string;
}): { label: string; outputText: string } {
  const { normalizedName, backgroundTask, foregroundShellFailure, command, label, outputText } = input;
  if (
    normalizedName !== 'git' &&
    !backgroundTask?.failed &&
    !backgroundTask?.running &&
    !foregroundShellFailure &&
    label &&
    outputText &&
    oneLine(outputText).toLocaleLowerCase() === label.toLocaleLowerCase()
  ) {
    // A command's output stays under its command; its header never repeats
    // it. Any other tool's one-line result is the outcome itself.
    return command ? { label: '', outputText } : { label, outputText: '' };
  }
  return { label, outputText };
}

/** The displayed result label: defaults and restatements dropped, a patch
 *  summary reduced to its line delta, instructions stripped, localized. */
function presentationResultLabel(input: {
  label: string;
  localize: (text: string) => string;
  normalizedName: string;
  category: string;
  tone: string;
  subject: string;
  backgroundTask: PresentationBackgroundTask;
  restoredNotice: boolean;
}): { resultLabel: string; patchSummary: RegExpExecArray | null } {
  const { normalizedName, category, tone, subject, backgroundTask, restoredNotice } = input;
  let { label, localize } = input;
  // A clean exit is the default; the row only reports the ones that are not.
  if (/^Exit 0$/i.test(label)) label = '';
  // A finished shell task restates its command and exit; the row's subject and
  // status already carry both.
  if (/^Shell task completed \(exit 0\)(?::|$)/.test(label)) label = '';
  // A patch's first line ("diff --git a/… b/…") is not an outcome.
  if (/^diff --git /.test(label)) label = '';
  // A patch summary ("Updated 2 Files · +129 lines") repeats the row's verb:
  // the row keeps what was touched, and the line delta moves to the outcome.
  const patchSummary =
    category === 'Patch' && tone === 'neutral'
      ? /^(?:Updated|Created|Deleted|Changed) (.+?)(?: · (.+))?$/.exec(subject || label)
      : null;
  if (patchSummary && (!subject || !label)) {
    label = patchSummary[2] ?? '';
    localize = (text) => text;
  }
  if (label && (backgroundTask || restoredNotice || TASK_ENVELOPE_TOOLS.test(normalizedName))) {
    label = toolActivityStripInstructions(label, true);
  }
  return { resultLabel: label ? shortMachineId(localize(label)) : '', patchSummary };
}

/** The closed row's outcome, in order: the base result label, a one-line
 *  output said once, the displayed label, then the stopped/failed outcome. */
function presentationOutcome(input: {
  model: PresentationCardModel;
  normalizedName: string;
  args: Record<string, unknown>;
  category: string;
  subject: string;
  command: string;
  tone: string;
  stopped: boolean;
  foregroundShellFailure: boolean;
  backgroundTask: PresentationBackgroundTask;
  restoredNotice: boolean;
  structuredRows: readonly ToolActivityStructuredRow[];
  rawResult: unknown;
  outputText: string;
}): { resultLabel: string; outputText: string; reason: string; patchSummary: RegExpExecArray | null } {
  const { model, normalizedName, args, category, subject, command, tone, stopped } = input;
  const { foregroundShellFailure, backgroundTask, restoredNotice, structuredRows, rawResult, outputText } = input;
  const base = presentationBaseResultLabel({ model, tone, normalizedName, args, outputText, structuredRows });
  const deduped = dedupeOneLineOutcome({
    normalizedName,
    backgroundTask,
    foregroundShellFailure,
    command,
    label: base.label,
    outputText,
  });
  const { resultLabel, patchSummary } = presentationResultLabel({
    label: deduped.label,
    localize: base.localize,
    normalizedName,
    category,
    tone,
    subject,
    backgroundTask,
    restoredNotice,
  });
  const failure = toolActivityFailureOutcome({
    stopped,
    backgroundTask,
    foregroundShellFailure,
    rawResult: typeof rawResult === 'string' ? rawResult : '',
    outputText: deduped.outputText,
    resultLabel,
  });
  return { ...failure, patchSummary };
}

/** A command's output without its exit marker (a failing code becomes the
 *  note) or the shell's empty placeholder; `git diff` output moves into the
 *  diff card. */
function presentationCommandOutput(input: {
  normalizedName: string;
  command: string;
  tone: string;
  outputText: string;
  outputNote: string;
  diffPatch: string;
}): { outputText: string; outputNote: string; diffPatch: string } {
  const { normalizedName, command, tone, diffPatch } = input;
  let { outputText, outputNote } = input;
  // A clean exit is the default; only a failing code is worth a line.
  // Only a failing code is worth a line, and it reads as a quiet note.
  if (command && normalizedName !== 'git') {
    const exit = /^\[exit(?: code)?:\s*(-?\d+)\]\n*/.exec(outputText);
    if (exit) {
      outputText = outputText.slice(exit[0].length);
      if (Number(exit[1]) !== 0) outputNote = t('Exit code {{code}}', { code: exit[1] });
    }
    // A clean run that printed nothing shows its command alone; the shell's
    // "(no output)" placeholder is not something the command said.
    if (tone === 'neutral' && /^\((?:no|no new) output\)$/.test(outputText.trim())) outputText = '';
  }
  // `git diff` output is a patch: it renders as the diff card, not as text.
  if (normalizedName === 'git' && command && !diffPatch && isCompletePatch(outputText)) {
    return { outputText: '', outputNote, diffPatch: outputText };
  }
  return { outputText, outputNote, diffPatch };
}

/** What the copy control of a sectioned result writes. */
function presentationSectionCopyText(
  normalizedName: string,
  outputText: string,
  previewText: string,
  sections: readonly ToolOutputSection[]
): string {
  if (previewText) return previewText;
  if (normalizedName === 'read') {
    return sections.map((section) => section.rows.map((row) => row.text).join('\n')).join('\n\n');
  }
  return outputText;
}

/** The arguments the row does not already represent, as labelled fields. */
function presentationFields(args: Record<string, unknown>, normalizedName: string, category: string) {
  const represented = toolActivityRepresentedKeys(normalizedName);
  if (category === 'MCP') {
    ['query', 'q', 'text', 'prompt', 'path', 'uri', 'name', 'id', 'action'].forEach((key) => {
      represented.add(key);
    });
  }
  return Object.entries(args)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !represented.has(key) &&
        !TOOL_ACTIVITY_INTERNAL_ARGS.has(key) &&
        !TOOL_ACTIVITY_BULK_ARGS.has(key) &&
        !toolActivityIsOperationalArg(normalizedName, key) &&
        value !== false &&
        value !== 0
    )
    .map(([key, value]) => ({
      key,
      label: toolActivityFieldLabel(key, normalizedName),
      value: toolActivityFieldValue(key, value),
    }));
}

/** The call's diff: the runtime's `uiDiff`, else the raw apply_patch envelope
 *  (`*** Begin Patch`, which parseUnifiedDiff would read as one nameless
 *  "after" file with bogus hunks) normalized into a unified diff. */
function presentationDiffPatch(
  item: TranscriptItem,
  args: Record<string, unknown>,
  normalizedName: string,
  targetPath: string
): string {
  if (typeof item.uiDiff === 'string' && item.uiDiff.trim()) {
    return patchForTarget(
      item.uiDiff.trim(),
      normalizedName === 'edit' ? targetPath : '',
      toolActivityFirstText(args, 'cwd', 'root') || (typeof item.cwd === 'string' ? item.cwd : '')
    );
  }
  if (normalizedName === 'apply_patch' && typeof args.patch === 'string') return normalizeApplyPatch(args.patch).trim();
  return '';
}

/** The result label of a finished call and how to localize it for display. */
function settledResultLabel(
  model: { resultSummary?: unknown; resultSummaryDisplay?: unknown; headerFailureText?: unknown; detailLine?: unknown },
  tone: string,
  quietSuccessSurface: boolean,
  outputText: string
): { label: string; localize: (text: string) => string } {
  let label = '';
  let localize = (text: string): string => text;
  const semantic = oneLine(String(model.resultSummary || ''));
  if (semantic && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(semantic)) {
    label = semantic;
    // The summary author knows which pieces are UI and which are tool/user
    // content. Never infer that boundary from the rendered words.
    localize = () => oneLine(String(model.resultSummaryDisplay ?? semantic));
  }
  if (tone === 'neutral' && quietSuccessSurface) label = '';
  if (!label && tone === 'error') {
    const failure = oneLine(String(model.headerFailureText || model.detailLine || ''));
    const failureText =
      toolActivityErrorSummary(outputText) ||
      (failure && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(failure) ? failure : '');
    label = failureText || 'Failed';
    localize = failureText ? (text) => text : () => t('Failed');
  }
  return { label, localize };
}

function presentationOutputText(normalizedName: string, rawOutput: unknown): string {
  if (normalizedName === 'git') return String(rawOutput ?? '').trimEnd();
  return toolActivityCleanOutput(
    toolActivityOutputText(normalizedName === 'read' ? readRowsForDisplay(rawOutput) : rawOutput)
  );
}

function presentationSections(
  normalizedName: string,
  outputText: string,
  previewText: string,
  targets: readonly string[],
  targetPath: string
): ToolOutputSection[] {
  if (previewText) return [toolFileSection(previewText, targetPath)];
  if (!outputText || !SECTION_TOOLS.has(normalizedName)) return [];
  return toolOutputSections(
    outputText,
    normalizedName as 'read' | 'grep' | 'code_graph',
    normalizedName === 'read' && !targets.length ? targetPath : ''
  );
}

function presentationListing(normalizedName: string, args: Record<string, unknown>, outputText: string) {
  if (!outputText || !LISTING_TOOLS.has(normalizedName)) return { entries: [], notes: [] };
  const base = /^(?:list|ls)$/.test(normalizedName) ? toolActivityFirstText(args, 'path', 'dir', 'cwd') : '';
  return toolFileEntries(outputText, base);
}

/** A describe result's outcome: the names it could not describe. */
function describeResultLabel(describe: { missing: string[]; blocked: string[] }): string {
  return [
    ...(describe.missing.length ? [t('Missing: {{value0}}', { value0: describe.missing.join(', ') })] : []),
    ...(describe.blocked.length ? [t('Blocked: {{value0}}', { value0: describe.blocked.join(', ') })] : []),
  ].join(' · ');
}

function presentationSubjectKind(
  normalizedName: string,
  subject: string,
  targetPath: string,
  targets: readonly string[]
): 'target' | 'code' | 'text' {
  // A file, or a bare count of targets ("4 files"), names what was touched.
  if ((targetPath && subject.startsWith(targetPath)) || (targets.length > 0 && !subject.includes(' · '))) {
    return 'target';
  }
  return CODE_SUBJECT_TOOLS.test(normalizedName) ? 'code' : 'text';
}

export function desktopToolActivityItemPresentation(
  wireItem: TranscriptItem,
  nowMs = Date.now(),
  /** `visualizeTabTitle`: the title of the tab a visualize call acts on. */
  options: { visualizeTabTitle?: string } = {}
): DesktopToolActivityItemPresentation {
  // A bridged call presents as the tool it runs; the transcript keeps the wire call.
  const identity = desktopToolDisplayIdentity(wireItem.name, wireItem.args);
  const item: TranscriptItem = identity.via ? { ...wireItem, name: identity.name, args: identity.args } : wireItem;
  const { name, originalName, normalizedName, args, model } = presentationCall(item, nowMs);
  const resultValue = item.result ?? item.rawResult;
  const describe = model.pending ? null : desktopToolDescribeResult(name, item.args, resultValue);
  const structured = toolActivityStructuredRows(normalizedName, args, toolActivityResultValue(item));
  const title = desktopToolActivityUnitLabel(name, item.args, resultValue);
  const subject = describe?.described.length
    ? describe.described.join(', ')
    : presentationSubject(
        normalizedName,
        args,
        item,
        presentationAgentTitle(normalizedName, args, item, model),
        oneLine(String(model.summaryText || '')),
        options.visualizeTabTitle ?? ''
      );
  const targets = toolActivityTargets(normalizedName, args).map((target) =>
    toolActivityRedactInlineSecrets(target, args)
  );
  // A batch of commands lists them as targets; its output keeps the per-command
  // sections the tool already wrote.
  const command =
    /^(?:shell|bash|bash_session|shell_command|job_wait|git)$/.test(normalizedName) && !targets.length
      ? toolActivityCommand(args)
      : '';
  const category = desktopToolActivityCategory(name, item.args);
  const fields = presentationFields(args, normalizedName, category);
  const targetPath = toolActivityFirstText(args, 'file_path', 'filePath', 'path', 'file', 'target');
  const callDiffPatch = presentationDiffPatch(item, args, normalizedName, targetPath);
  const editTexts = presentationEditTexts(originalName, normalizedName, args, callDiffPatch, targetPath);
  const { previewText, beforeText, afterText } = editTexts;
  const { rawOutputText, backgroundTask, restoredNotice, taskWait } = presentationRawOutput(
    item,
    model,
    normalizedName,
    args
  );
  const { tone, stopped, foregroundShellFailure } = presentationTone(item, model, normalizedName, backgroundTask);
  const body = presentationOutputBody({
    normalizedName,
    outputText: rawOutputText,
    backgroundTask,
    restoredNotice,
    taskWait,
  });
  const bodyText = suppressRoutineOutput({
    normalizedName,
    outputText: body.outputText,
    tone,
    structuredKind: structured.kind,
    diffPatch: callDiffPatch,
  });
  const outcome = presentationOutcome({
    model,
    normalizedName,
    args,
    category,
    subject,
    command,
    tone,
    stopped,
    foregroundShellFailure,
    backgroundTask,
    restoredNotice,
    structuredRows: structured.rows,
    rawResult: item.rawResult,
    outputText: bodyText,
  });
  const { patchSummary } = outcome;
  // Only text that parses is JSON: a log line opening with "[warn]" is not.
  const outputLanguage = outcome.outputText && !command && isJsonText(outcome.outputText) ? 'json' : '';
  const { outputText, outputNote, diffPatch } = presentationCommandOutput({
    normalizedName,
    command,
    tone,
    outputText: outcome.outputText,
    outputNote: body.outputNote,
    diffPatch: callDiffPatch,
  });
  const sections = presentationSections(normalizedName, outputText, previewText, targets, targetPath);
  const listing = presentationListing(normalizedName, args, outputText);
  const sectionCopyText = presentationSectionCopyText(normalizedName, outputText, previewText, sections);
  const subjectKind = presentationSubjectKind(normalizedName, subject, targetPath, targets);
  const promptText = normalizedName === 'agent' && !model.isAgentResponse ? toolActivityFirstText(args, 'prompt') : '';
  // A finished background task with nothing to read keeps no disclosure: its
  // command is already the subject, its status and id ride on the closed row.
  const commandIsDetail = Boolean(command) && !(backgroundTask && !outputText.trim() && !outputNote);
  const hasDetails = Boolean(
    commandIsDetail ||
      targets.length ||
      fields.length ||
      diffPatch ||
      outputText ||
      outputNote ||
      sections.length ||
      promptText ||
      beforeText ||
      afterText ||
      structured.rows.length
  );
  return {
    category,
    title,
    ...(identity.via ? { via: identity.via } : {}),
    verb:
      fileChangeVerb(category, model.pending, tone, diffPatch, originalName) ||
      desktopToolActivityRowVerb(name, item.args, resultValue),
    subject,
    targets,
    resultLabel: describe ? describeResultLabel(describe) : outcome.resultLabel,
    pending: model.pending,
    tone,
    command,
    fields,
    diffPatch,
    // The lines the call's diff adds and removes; a failed call claims none.
    diffCounts: diffPatch && tone === 'neutral' && !model.pending ? patchLineCounts(diffPatch) : null,
    outputText,
    outputNote,
    outcomeReason: outcome.reason,
    metaText: backgroundTask ? backgroundTask.meta : '',
    outputLanguage,
    previewText,
    beforeText,
    afterText,
    replacementLanguage: editTexts.replacementLanguage,
    structuredKind: structured.kind,
    structuredRows: structured.rows,
    hasDetails,
    hideSubjectWhenOpen: Boolean(command),
    targetPath,
    ...(normalizedName === 'read' && Number(args.offset) > 0 ? { targetLine: Math.floor(Number(args.offset)) } : {}),
    headerSubject: rowSubject(
      normalizedName,
      patchSummary ? localizePatchTarget(patchSummary[1]) : fileHeaderSubject(subject, targetPath)
    ),
    subjectIsTarget: Boolean(targetPath) && subject.startsWith(targetPath),
    subjectKind: patchSummary ? 'target' : subjectKind,
    sections,
    entries: listing.entries,
    entryNotes: listing.notes,
    sectionCopyText,
    fieldsInline: fields.every((field) => field.value.length <= 40 && !field.value.includes('\n')),
    outputLiteral: LITERAL_OUTPUT_CATEGORIES.has(category),
    promptText,
  };
}
