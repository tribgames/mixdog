import type { TranscriptItem } from './desktop-types';
import { t, tExisting } from './i18n';
import { normalizeApplyPatch } from './renderer-logic.mjs';
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
  toolActivityItemTone,
  toolItemDone,
  type ToolCardModel,
} from './transcript-tool-core';
import {
  TOOL_ACTIVITY_BULK_ARGS,
  TOOL_ACTIVITY_INTERNAL_ARGS,
  TOOL_ACTIVITY_MEANINGLESS_RESULT,
  TOOL_ACTIVITY_OPERATIONAL_ARGS,
  TOOL_ACTIVITY_ROUTINE_RESULT,
  toolActivityCodeLanguage,
  toolActivityCommand,
  toolActivityFieldLabel,
  toolActivityFieldValue,
  toolActivityFirstText,
  toolActivityRedactInlineSecrets,
  toolActivityRepresentedKeys,
  toolActivitySubject,
  toolActivityTargets,
} from './transcript-tool-format';
import {
  toolActivityBackgroundTask,
  toolActivityCleanOutput,
  toolActivityErrorSummary,
  toolActivityIsCompleted,
  toolActivityOutputText,
  toolActivityResultValue,
  toolActivityStructuredRows,
  type ToolActivityStructuredKind,
  type ToolActivityStructuredRow,
} from './transcript-tool-result';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { formatToolSurface } from '../../../../src/runtime/shared/tool-surface.mjs';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { agentActionTitle, agentResponseTitle, deriveToolCardModel } from '../../../../src/runtime/shared/tool-card-model.mjs';
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
  'cwd',
  'setup',
]);

interface DesktopToolActivityItemPresentation {
  category: string;
  title: string;
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
  outputText: string;
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

export function desktopToolActivityItemPresentation(
  item: TranscriptItem,
  nowMs = Date.now()
): DesktopToolActivityItemPresentation {
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
  ) as ToolCardModel & {
    resultSummary?: string | null;
    resultSummaryDisplay?: string | null;
    displayedResultBodyText?: string;
    terminalStatus?: string;
    isAgentResponse?: boolean;
  };
  const baseTone = toolActivityItemTone(item);
  const failed =
    item.isError ||
    Number(item.errorCount || 0) > 0 ||
    /fail|error|timeout|denied/i.test(String(model.terminalStatus || ''));
  let tone = baseTone;
  if (baseTone === 'neutral' && failed) tone = 'error';
  const resultValue = toolActivityResultValue(item);
  const structured = toolActivityStructuredRows(normalizedName, args, resultValue);
  const title = desktopToolActivityUnitLabel(name, item.args);
  let agentTitle = '';
  if (normalizedName === 'agent') {
    // A response is only a completion notification; status/read are checks.
    const resultText = String(item.result ?? item.rawResult ?? '');
    agentTitle = model.isAgentResponse
      ? agentResponseTitle(args, 1, resultText)
      : agentActionTitle(args, resultText);
  }
  const subject = toolActivityRedactInlineSecrets(
    agentTitle || toolActivitySubject(normalizedName, args, oneLine(String(model.summaryText || ''))),
    args
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
  const represented = toolActivityRepresentedKeys(normalizedName);
  const category = desktopToolActivityCategory(name, item.args);
  if (category === 'MCP') {
    ['query', 'q', 'text', 'prompt', 'path', 'uri', 'name', 'id', 'action'].forEach((key) => {
      represented.add(key);
    });
  }
  const fields = Object.entries(args)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !represented.has(key) &&
        !TOOL_ACTIVITY_INTERNAL_ARGS.has(key) &&
        !TOOL_ACTIVITY_BULK_ARGS.has(key) &&
        !TOOL_ACTIVITY_OPERATIONAL_ARGS.has(key) &&
        value !== false &&
        value !== 0
    )
    .map(([key, value]) => ({
      key,
      label: toolActivityFieldLabel(key),
      value: toolActivityFieldValue(key, value),
    }));
  // The argument fallback is the raw apply_patch envelope (`*** Begin Patch`),
  // which parseUnifiedDiff reads as one nameless "after" file with bogus
  // hunks; normalize it into a unified diff so the card names each file.
  let diffPatch = '';
  if (typeof item.uiDiff === 'string' && item.uiDiff.trim()) diffPatch = item.uiDiff.trim();
  else if (normalizedName === 'apply_patch' && typeof args.patch === 'string') {
    diffPatch = normalizeApplyPatch(args.patch).trim();
  }
  // A written file that already has a diff shows the diff alone: the preview
  // would repeat every line of it.
  const previewText = !diffPatch && originalName === 'write' && typeof args.content === 'string' ? args.content : '';
  const beforeText =
    !diffPatch && normalizedName === 'edit' ? toolActivityFirstText(args, 'old_string', 'oldString', 'old_str') : '';
  const afterText =
    !diffPatch && normalizedName === 'edit' ? toolActivityFirstText(args, 'new_string', 'newString', 'new_str') : '';
  const targetPath = toolActivityFirstText(args, 'file_path', 'filePath', 'path', 'file', 'target');
  const replacementLanguage = beforeText || afterText ? toolActivityCodeLanguage(targetPath) : '';
  const rawOutput = item.result ?? model.displayedResultBodyText ?? item.rawResult;
  let outputText =
    normalizedName === 'git'
      ? String(rawOutput ?? '').trimEnd()
      : toolActivityCleanOutput(
          toolActivityOutputText(normalizedName === 'read' ? readRowsForDisplay(rawOutput) : rawOutput)
        );
  const backgroundTask = toolActivityBackgroundTask(outputText);
  const metaText = backgroundTask ? backgroundTask.meta : '';
  if (backgroundTask) outputText = backgroundTask.body;
  const mutation = normalizedName === 'edit' || normalizedName === 'apply_patch';
  const quietSuccessSurface = QUIET_SUCCESS_TOOLS.has(normalizedName);
  const routineSurface = mutation || quietSuccessSurface || ROUTINE_RESULT_TOOLS.has(normalizedName);
  if (
    structured.kind ||
    (tone === 'neutral' && routineSurface && TOOL_ACTIVITY_ROUTINE_RESULT.test(outputText.trim()))
  ) {
    outputText = '';
  }
  if (tone === 'neutral' && quietSuccessSurface) outputText = '';
  if (normalizedName === 'view_image' && /^\[image:/i.test(outputText.trim())) outputText = '';
  if (tone === 'neutral' && diffPatch && mutation) {
    outputText = '';
  }
  let resultLabel = '';
  let localizeResultLabel = (text: string): string => text;
  if (!model.pending) {
    const semantic = oneLine(String(model.resultSummary || ''));
    if (semantic && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(semantic)) {
      resultLabel = semantic;
      // The summary author knows which pieces are UI and which are tool/user
      // content. Never infer that boundary from the rendered words.
      localizeResultLabel = () => oneLine(String(model.resultSummaryDisplay ?? semantic));
    }
    if (tone === 'neutral' && quietSuccessSurface) resultLabel = '';
    if (!resultLabel && tone === 'error') {
      const failure = oneLine(String(model.headerFailureText || model.detailLine || ''));
      const failureText =
        toolActivityErrorSummary(outputText) ||
        (failure && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(failure) ? failure : '');
      resultLabel = failureText || 'Failed';
      localizeResultLabel = failureText ? (text) => text : () => t('Failed');
    }
  }
  if (structured.rows.length) {
    const completed = structured.rows.filter((row) => toolActivityIsCompleted(row.status)).length;
    resultLabel = `${completed}/${structured.rows.length}`;
    localizeResultLabel = (text) => text;
  }
  if (
    !resultLabel &&
    (normalizedName === 'git_stage' || (normalizedName === 'git' && args.action === 'stage')) &&
    /^staged\b/i.test(outputText.trim())
  ) {
    resultLabel = 'Staged';
    localizeResultLabel = () => t('Staged');
  }
  if (
    normalizedName !== 'git' &&
    resultLabel &&
    outputText &&
    oneLine(outputText).toLocaleLowerCase() === resultLabel.toLocaleLowerCase()
  ) {
    outputText = '';
  }
  // A clean exit is the default; the row only reports the ones that are not.
  if (/^Exit 0$/i.test(resultLabel)) resultLabel = '';
  // A patch's first line ("diff --git a/… b/…") is not an outcome.
  if (/^diff --git /.test(resultLabel)) resultLabel = '';
  // A patch summary ("Updated 2 Files · +129 lines") repeats the row's verb:
  // the row keeps what was touched, and the line delta moves to the outcome.
  const patchSummary =
    category === 'Patch' && tone === 'neutral'
      ? /^(?:Updated|Created|Deleted|Changed) (.+?)(?: · (.+))?$/.exec(subject || resultLabel)
      : null;
  if (patchSummary && (!subject || !resultLabel)) {
    resultLabel = patchSummary[2] ?? '';
    localizeResultLabel = (text) => text;
  }
  resultLabel = resultLabel ? localizeResultLabel(resultLabel) : '';
  // Only text that parses is JSON: a log line opening with "[warn]" is not.
  const outputLanguage = outputText && !command && isJsonText(outputText) ? 'json' : '';
  // A clean exit is the default; only a failing code is worth a line.
  if (command && normalizedName !== 'git') outputText = outputText.replace(/^\[exit code: 0\]\n*/, '');
  // `git diff` output is a patch: it renders as the diff card, not as text.
  if (normalizedName === 'git' && command && !diffPatch && isCompletePatch(outputText)) {
    diffPatch = outputText;
    outputText = '';
  }
  let sections: ToolOutputSection[] = [];
  if (previewText) sections = [toolFileSection(previewText, targetPath)];
  else if (outputText && SECTION_TOOLS.has(normalizedName)) {
    sections = toolOutputSections(
      outputText,
      normalizedName as 'read' | 'grep' | 'code_graph',
      normalizedName === 'read' && !targets.length ? targetPath : ''
    );
  }
  const listing =
    outputText && LISTING_TOOLS.has(normalizedName)
      ? toolFileEntries(
          outputText,
          /^(?:list|ls)$/.test(normalizedName) ? toolActivityFirstText(args, 'path', 'dir', 'cwd') : ''
        )
      : { entries: [], notes: [] };
  let sectionCopyText = outputText;
  if (previewText) sectionCopyText = previewText;
  else if (normalizedName === 'read') {
    sectionCopyText = sections.map((section) => section.rows.map((row) => row.text).join('\n')).join('\n\n');
  }
  let subjectKind: 'target' | 'code' | 'text' = 'text';
  // A file, or a bare count of targets ("4 files"), names what was touched.
  if ((targetPath && subject.startsWith(targetPath)) || (targets.length > 0 && !subject.includes(' · '))) {
    subjectKind = 'target';
  }
  if (subjectKind === 'text' && CODE_SUBJECT_TOOLS.test(normalizedName)) subjectKind = 'code';
  const promptText = normalizedName === 'agent' && !model.isAgentResponse ? toolActivityFirstText(args, 'prompt') : '';
  const hasDetails = Boolean(
    command ||
      targets.length ||
      fields.length ||
      diffPatch ||
      outputText ||
      metaText ||
      sections.length ||
      promptText ||
      beforeText ||
      afterText ||
      structured.rows.length
  );
  return {
    category,
    title,
    verb: desktopToolActivityRowVerb(name, item.args),
    subject,
    targets,
    resultLabel,
    pending: model.pending,
    tone,
    command,
    fields,
    diffPatch,
    outputText,
    metaText,
    outputLanguage,
    previewText,
    beforeText,
    afterText,
    replacementLanguage,
    structuredKind: structured.kind,
    structuredRows: structured.rows,
    hasDetails,
    hideSubjectWhenOpen: Boolean(command),
    targetPath,
    ...(normalizedName === 'read' && Number(args.offset) > 0 ? { targetLine: Math.floor(Number(args.offset)) } : {}),
    headerSubject: rowSubject(
      normalizedName,
      patchSummary?.[1].toLowerCase() ?? fileHeaderSubject(subject, targetPath)
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
