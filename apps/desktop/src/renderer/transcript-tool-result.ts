import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';
import { boundedTextOf } from './transcript-tool-core';
// @ts-expect-error Shared runtime module is JavaScript.
import { parseTaskNotification } from '../../../../src/runtime/shared/task-notification-envelope.mjs';
import {
  TOOL_ACTIVITY_ROUTINE_RESULT,
  TOOL_DETAIL_LABELS,
  toolActivityActionLabel,
  toolActivityCompact,
  toolActivityFieldValue,
  toolActivityFirstText,
  toolActivityInline,
  shortMachineId,
} from './transcript-tool-format';

export type ToolActivityStructuredKind = 'plan' | 'todos' | 'questions' | '';

function statusKey(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** A task or tool status in the active language; an unknown status stays as the runtime wrote it. */
export function toolStatusLabel(status: string): string {
  switch (statusKey(status)) {
    case 'queued':
      return TOOL_DETAIL_LABELS.queued;
    case 'running':
      return TOOL_DETAIL_LABELS.running;
    case 'completed':
      return TOOL_DETAIL_LABELS.completed;
    case 'failed':
      return TOOL_DETAIL_LABELS.failed;
    case 'cancelled':
    case 'canceled':
      return TOOL_DETAIL_LABELS.cancelled;
    case 'timeout':
    case 'timed_out':
      return TOOL_DETAIL_LABELS.timeout;
    case 'pending':
      return TOOL_DETAIL_LABELS.pending;
    default:
      return status;
  }
}

function normalizeStructuredStatus(status: unknown): string {
  const value = String(status || 'pending')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (/^(?:complete|completed|done|success|succeeded|checked)$/.test(value)) return 'completed';
  if (/^(?:active|current|in_progress|inprogress|running)$/.test(value)) return 'in_progress';
  if (/^(?:error|failed|failure)$/.test(value)) return 'failed';
  return value || 'pending';
}

export interface ToolActivityStructuredRow {
  text: string;
  status: string;
  answer?: string;
}

export function toolActivityErrorSummary(text: string): string {
  const first =
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  return toolActivityInline(first.replace(/^(?:\[(?:error|failed)\]\s*|error\s*:?\s*|failed\s*:?\s*)/i, ''), 180);
}

export function toolActivityResultValue(item: TranscriptItem): unknown {
  const value = typeof item.result === 'string' && item.result.trim() ? item.result : (item.result ?? item.rawResult);
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

const ASK_USER_RESULT_PREFIX = 'User has answered your questions: ';

/** A JSON string literal starting at `at`: its value and the index after it. */
function readQuoted(text: string, at: number): [string, number] | null {
  if (text[at] !== '"') return null;
  let end = at + 1;
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
  if (end >= text.length) return null;
  try {
    return [JSON.parse(text.slice(at, end + 1)) as string, end + 1];
  } catch {
    return null;
  }
}

/** The answers in an ask_user result, by question text: the picked labels (as
 *  the runtime joined them) and the typed text. Grammar per question:
 *  `"q"=(no answer)`, `"q"="picked"`, `"q"="typed" (typed)` or
 *  `"q"="picked" + "typed" (typed)`, joined by `; `. */
export function askUserAnswers(result: string): Map<string, { picked: string; typed: string }> {
  const answers = new Map<string, { picked: string; typed: string }>();
  if (!result.startsWith(ASK_USER_RESULT_PREFIX)) return answers;
  const TYPED = ' (typed)';
  let at = ASK_USER_RESULT_PREFIX.length;
  for (;;) {
    const key = readQuoted(result, at);
    if (!key || result[key[1]] !== '=') break;
    at = key[1] + 1;
    let picked = '';
    let typed = '';
    if (result.startsWith('(no answer)', at)) at += '(no answer)'.length;
    else {
      const first = readQuoted(result, at);
      if (!first) break;
      at = first[1];
      if (result.startsWith(' + ', at)) {
        const second = readQuoted(result, at + 3);
        if (!second) break;
        picked = first[0];
        typed = second[0];
        at = second[1] + (result.startsWith(TYPED, second[1]) ? TYPED.length : 0);
      } else if (result.startsWith(TYPED, at)) {
        typed = first[0];
        at += TYPED.length;
      } else picked = first[0];
    }
    answers.set(key[0], { picked, typed });
    if (!result.startsWith('; ', at)) break;
    at += 2;
  }
  return answers;
}

function toolActivityAnswer(result: unknown, question: Record<string, unknown>, index: number, total: number): string {
  const secret = question.is_secret === true || question.isSecret === true;
  if (typeof result === 'string' && result.startsWith(ASK_USER_RESULT_PREFIX)) {
    const answer = askUserAnswers(result).get(toolActivityFirstText(question, 'question'));
    return answer ? [answer.picked, answer.typed].filter(Boolean).join(', ') : '';
  }
  const record = asRecord(result);
  const answers = record?.answers ?? record?.answer;
  let value: unknown;
  if (Array.isArray(answers)) value = answers[index];
  else {
    const answerRecord = asRecord(answers);
    const id = toolActivityFirstText(question, 'id');
    value = answerRecord?.[id] ?? answerRecord?.[String(index)];
  }
  if (
    value == null &&
    total === 1 &&
    typeof result === 'string' &&
    result.trim() &&
    !TOOL_ACTIVITY_ROUTINE_RESULT.test(result.trim())
  ) {
    value = result.trim();
  }
  const text = Array.isArray(value)
    ? value
        .map((entry) => toolActivityInline(entry))
        .filter(Boolean)
        .join(', ')
    : toolActivityInline(value);
  if (!text) return '';
  return secret ? '••••••' : text;
}

export function toolActivityStructuredRows(
  normalizedName: string,
  args: Record<string, unknown>,
  result: unknown
): { kind: ToolActivityStructuredKind; rows: ToolActivityStructuredRow[] } {
  if (normalizedName === 'request_user_input' && Array.isArray(args.questions)) {
    const questions = args.questions
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return {
      kind: 'questions',
      rows: questions.map((question, index) => {
        const answer = toolActivityAnswer(result, question, index, questions.length);
        return {
          text:
            toolActivityFirstText(question, 'question', 'header', 'text') ||
            t('Question {{value0}}', { value0: index + 1 }),
          status: answer ? 'completed' : 'pending',
          answer,
        };
      }),
    };
  }
  let source: unknown[] = [];
  if (Array.isArray(args.todos)) source = args.todos;
  else if (normalizedName === 'update_plan' && Array.isArray(args.plan)) source = args.plan;
  if (source.length) {
    const kind: ToolActivityStructuredKind = Array.isArray(args.todos) ? 'todos' : 'plan';
    return {
      kind,
      rows: source.map((entry, index) => {
        const record = asRecord(entry) ?? {};
        return {
          text:
            toolActivityFirstText(record, 'content', 'step', 'text', 'title') ||
            (kind === 'todos'
              ? t('Todo {{value0}}', { value0: index + 1 })
              : t('Step {{value0}}', { value0: index + 1 })),
          status: normalizeStructuredStatus(toolActivityFirstText(record, 'status') || 'pending'),
        };
      }),
    };
  }
  return { kind: '', rows: [] };
}

export function toolActivityOutputText(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') return toolActivityFieldValue('output', value).trimEnd();
  const text = value.trimEnd();
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, 100_000);
    } catch {
      // JSON-looking tool output may still be plain text; preserve it below.
    }
  }
  return boundedTextOf(text, 100_000).trimEnd();
}

const TOOL_ACTIVITY_PROTOCOL_HINT =
  /(?:pass offset:|one window:|to continue|for more|raw source spans|evidence-ref|showing \d+ of|top \d+ of)/i;
// Lines the runtime writes for the model (how to fetch output, when to wait).
// The person reading the row gets the status and the id, never the manual.
// Each entry is one full line the runtime writes, verbatim from its source
// (tools/shell-command.mjs, shell-run-background/promotion-results.mjs,
// bash-tool/backgrounded-result.mjs, task-notification-envelope.mjs,
// builtin/task-tool.mjs, background-tasks.mjs); only ids, numbers and
// durations vary. Ordinary wording that merely resembles one is never touched.
const GUIDANCE_ID = /[^)\]\s]*/y;
const GUIDANCE_NUMBER = /\d+/y;
const GUIDANCE_PROMOTED = /(?:auto-backgrounded after|moved to background at timeout after) \d+s/y;
const TOOL_ACTIVITY_MODEL_INSTRUCTION: Array<Array<string | RegExp>> = [
  // task-notification-envelope.mjs renderShellCompletionNotice
  ['Retrieve output with task read (task_id: ', GUIDANCE_ID, ') only if it has not already been received.'],
  // promotion-results.mjs resolveBackgrounded: backgroundMessage with BACKGROUND_GUIDANCE
  [
    GUIDANCE_PROMOTED,
    '; still running. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
  ],
  // promotion-results.mjs resolveBackgrounded without a job id
  [
    GUIDANCE_PROMOTED,
    '; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
  ],
  // backgrounded-result.mjs DEFAULT_BACKGROUND_MESSAGE
  [
    'auto-backgrounded; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
  ],
  // shell-command.mjs admission saturation
  [
    'shell admission wait exceeded ',
    GUIDANCE_NUMBER,
    'ms; queued as background task [task_id: ',
    GUIDANCE_ID,
    '] that starts when an execution slot frees. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
  ],
  // task-tool.mjs read of a live job
  ['Job still running; ', GUIDANCE_NUMBER, ' new lines.'],
  ['Job still running; ', GUIDANCE_NUMBER, ' new line.'],
  // task-tool.mjs wait cues
  [
    'Wait interrupted by new user input; task still running. Handle the new message now and reply to it before waiting on this task again.',
  ],
  [
    'Wait ceiling reached; task still running. If periodic reports were requested, write the user-facing report now, then call task wait for the next interval; otherwise continue independent work or end the turn.',
  ],
  // background-tasks.mjs renderBackgroundTask
  ['(no result body — use read for full output)'],
];
// summarizeToolResult cuts a one-line label with truncateSingleLine(…, 80):
// the first 80 characters, then "...". A shortened machine id leaves fewer, so
// the cut text is judged by what it says: at least this much of a sentence.
const GUIDANCE_TRUNCATED_MIN = 50;
const GUIDANCE_TRUNCATED_MAX = 80;

function guidanceMatches(parts: Array<string | RegExp>, line: string, truncated: boolean): boolean {
  let position = 0;
  const text = truncated ? line.slice(0, -3) : line;
  for (const part of parts) {
    const rest = text.slice(position);
    if (typeof part === 'string') {
      if (truncated && part.length >= rest.length) return part.startsWith(rest);
      if (!rest.startsWith(part)) return false;
      position += part.length;
      continue;
    }
    part.lastIndex = position;
    const match = part.exec(text);
    if (!match) return false;
    position += match[0].length;
  }
  return !truncated && position === text.length;
}

/** `summary` marks a generated one-line label (a subject or result label):
 *  only those are ever cut with "..."; a raw body line must match in full. */
function toolActivityIsModelInstruction(line: string, summary: boolean): boolean {
  const cut = line.length - 3;
  const truncated = summary && line.endsWith('...') && cut >= GUIDANCE_TRUNCATED_MIN && cut <= GUIDANCE_TRUNCATED_MAX;
  return TOOL_ACTIVITY_MODEL_INSTRUCTION.some(
    (parts) => guidanceMatches(parts, line, false) || (truncated && guidanceMatches(parts, line, true))
  );
}
// Legacy agent envelope heads as the runtime writes them: `agent task: <id>`
// (tool-card-labels fixtures, agent-envelope.mjs) and `agent result` with
// optional key=value attributes (transcript-restore/agent-envelope.mjs).
const TOOL_ACTIVITY_LEGACY_AGENT_HEADER =
  /^(?:agent task: \S+|agent result(?: [A-Za-z][\w-]*=(?:"[^"]*"|'[^']*'|\S+))*)$/;
const TOOL_ACTIVITY_HEADER_FIELD =
  /^(?:status|type|target|role|agent|preset|model|effort|fast|limits|session|task-id|task_id|surface|operation|label|notification|queueDepth|worker|worker_stage|last_progress|silent_for|watchdog|queued_followups|diagnostic|started|finished|elapsed|reused|protocol|version):\s/;

const TOOL_ACTIVITY_JOB_RUNNING = /^Job still running; /;

/** A body line the runtime wrote for the model. "Job still running" is a task
 *  read's whole result (a label), never a line of a body. */
function toolActivityIsBodyInstruction(line: string): boolean {
  return !TOOL_ACTIVITY_JOB_RUNNING.test(line) && toolActivityIsModelInstruction(line, false);
}

// task-tool.mjs appends these to a task wait result as `rendered + '\n\n' + cue`:
// the one producer that adds guidance after output, always as the last paragraph.
const TOOL_ACTIVITY_WAIT_CUE = /^Wait (?:interrupted by new user input|ceiling reached);/;

function toolActivityIsGuidanceBody(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every(toolActivityIsBodyInstruction);
}

/** Guidance is dropped only where a producer puts it: as the sole body (a
 *  completion notice's `<result>`, the empty-body placeholder) or as the wait
 *  cue paragraph after a wait result. Output sections (`[stdout]`, `[stderr]`),
 *  an agent's answer and fenced code are payload and are never filtered. */
function toolActivityDropGuidance(text: string, waitResult: boolean): string {
  if (toolActivityIsGuidanceBody(text)) return '';
  if (!waitResult) return text;
  const cut = text.lastIndexOf('\n\n');
  if (cut < 0) return text;
  const last = text.slice(cut + 2).trim();
  return TOOL_ACTIVITY_WAIT_CUE.test(last) && toolActivityIsBodyInstruction(last) ? text.slice(0, cut) : text;
}

/** The text without the lines written for the model and without a legacy
 *  `agent task:` / `agent result` header block; empty when nothing else remains.
 *  `summary` marks a generated one-line label, where any line may be guidance;
 *  a body is only filtered in the runtime-owned positions. `waitResult` is true
 *  only for the result of a \`task\` call with action \`wait\`, the one producer
 *  that appends a cue paragraph. */
export function toolActivityStripInstructions(text: string, summary = false, waitResult = false): string {
  const kept: string[] = [];
  let dropped = false;
  let inHeader = false;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    // Only a genuine envelope header on the very first line opens the block.
    if (index === 0 && TOOL_ACTIVITY_LEGACY_AGENT_HEADER.test(trimmed)) {
      inHeader = true;
      dropped = true;
      continue;
    }
    if (inHeader) {
      // The known field lines directly after the header, up to the blank line.
      if (TOOL_ACTIVITY_HEADER_FIELD.test(trimmed)) {
        dropped = true;
        continue;
      }
      inHeader = false;
      if (!trimmed) continue;
    }
    if (summary && toolActivityIsModelInstruction(trimmed, true)) {
      dropped = true;
      continue;
    }
    kept.push(line);
  }
  const body = kept.join('\n');
  const cleaned = summary ? body : toolActivityDropGuidance(body, waitResult);
  if (!dropped && cleaned === body) return text;
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function toolActivityIsProtocolLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\[arg-guard\]/i.test(text)) return true;
  if (!/^(?:\.{3}\s*)?\[[^\]]*\]$/.test(text)) return false;
  return TOOL_ACTIVITY_PROTOCOL_HINT.test(text);
}

export function toolActivityCleanOutput(text: string): string {
  if (!text.includes('[')) return text;
  return text
    .split('\n')
    .filter((line) => !toolActivityIsProtocolLine(line))
    .join('\n')
    .trim();
}

/** PowerShell writes error streams as CLIXML: a `#< CLIXML` marker and an
 *  `<Objs>` payload whose `<S S="Error">` strings are the real text. */
function toolActivityPowerShellText(text: string): string {
  if (!text.includes('#< CLIXML') && !text.includes('<Objs')) return text;
  const decode = (value: string) =>
    value
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\r\n?/g, '\n');
  return text
    .replace(/^#< CLIXML[ \t]*$/gm, '')
    .replace(/<Objs\b[\s\S]*?<\/Objs>/g, (payload) =>
      [...payload.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) => decode(match[1])).join('')
    )
    .replace(/\n{3,}/g, '\n\n');
}

/** One failure outcome from its normalized parts: fixed chips (status, exit,
 *  signal) and a reason that may be ellipsized ("실패 · SIGKILL · boom"). The
 *  exit only shows when there is no reason; the short id joins at the row. */
export interface ToolOutcome {
  label: string;
  reason: string;
}
export function toolActivityOutcome(status: string, exit: string, signal: string, reason: string): ToolOutcome {
  return { label: toolActivityCompact([status, reason ? '' : exit, signal, reason]), reason };
}

/** A failed foreground command: "실패 · fatal: permission denied", or the exit
 *  when the command said nothing. */
export function toolActivityShellFailureLabel(output: string, current: string): ToolOutcome {
  const exit = /^\[exit(?: code)?:\s*(-?\d+)\]/im.exec(output);
  const first = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^\[[a-z_ ]+(?::[^\]]*)?\]$/i.test(line));
  const reason = toolActivityShortError(first ?? '');
  const code = exit && Number(exit[1]) !== 0 ? t('Exit {{code}}', { code: exit[1] }) : '';
  return toolActivityOutcome(t('Failed'), code || current, '', reason);
}

/** The closed row's reason: the first line of the error, cut to a short phrase. */
function toolActivityShortError(error: string): string {
  const first = error.split('\n').find((line) => line.trim()) ?? '';
  const text = first.trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** A non-zero exit, a timeout or a signal makes a finished task a failure even
 *  when its envelope says "completed"; exit 0 stays silent. */
function toolActivityBackgroundOutcome(
  status: string,
  exitCode: string | number | null | undefined,
  timedOut: boolean,
  signal: string,
  error = ''
): {
  statusLabel: string;
  exit: string;
  failed: boolean;
  outcome: string;
  reason: string;
  code: string;
  signal: string;
  timeout: boolean;
} {
  const code = String(exitCode ?? '').trim();
  const badExit = /^-?\d+$/.test(code) && Number(code) !== 0;
  const normalized = statusKey(status);
  const timeout = timedOut || /^(?:timeout|timed_out)$/.test(normalized);
  const failed = badExit || timeout || Boolean(signal) || normalized === 'failed';
  let statusLabel = toolStatusLabel(status);
  if (timeout) statusLabel = toolStatusLabel('timeout');
  else if (failed && (!normalized || toolActivityIsCompleted(normalized))) statusLabel = toolStatusLabel('failed');
  const exit = badExit ? t('Exit {{code}}', { code }) : '';
  const reason = failed ? toolActivityShortError(error) : '';
  return {
    statusLabel,
    exit,
    failed,
    outcome: toolActivityOutcome(statusLabel, exit, signal, reason).label,
    reason,
    code: badExit ? code : '',
    signal,
    timeout,
  };
}

/** "종료 코드 2로 실패 · make": the failure in words, built from the parsed parts. */
function toolActivityFailureLine(result: ReturnType<typeof toolActivityBackgroundOutcome>, command: string): string {
  let head = result.statusLabel;
  if (!result.timeout) {
    if (result.code) head = t('Failed with exit code {{code}}', { code: result.code });
    else if (result.signal) head = t('Failed with signal {{signal}}', { signal: result.signal });
  }
  return toolActivityCompact([head, command]);
}

/** Empty `[stdout]` / `[stderr]` labels with nothing under them are noise, and
 *  a lone leading `[stdout]` over one stream labels nothing. Line endings are \n. */
function toolActivityDropEmptySections(source: string): string {
  const text = toolActivityPowerShellText(source.replace(/\r\n?/g, '\n'));
  const lines = text.split('\n');
  const label = /^\[(?:stdout|stderr)(?: preview)?\]$/;
  const kept = lines.filter((line, index) => {
    if (!label.test(line.trim())) return true;
    const next = lines.slice(index + 1).find((entry) => entry.trim());
    return next !== undefined && !label.test(next.trim());
  });
  const first = kept.findIndex((line) => line.trim());
  const labels = kept.filter((line) => label.test(line.trim()));
  if (first >= 0 && labels.length === 1 && kept[first].trim() === '[stdout]') kept.splice(first, 1);
  return kept.join('\n').replace(/^\n+/, '').trimEnd();
}

/** A failed task never loses its reason: the output, then the explicit error,
 *  and when neither exists the failure in words. */
function toolActivityFailureBody(body: string, error: string, failure: string): string {
  let text = body;
  const detail = error.trim();
  if (detail && !text.includes(detail)) text = text ? `${text}\n\n${detail}` : detail;
  return text || failure;
}

/** `- job_… shell/shell running label=…` rows of a task list, one readable line each. */
export function toolActivityLocalizeTaskList(text: string): string {
  if (!/^background tasks:\s*\d+/i.test(text.trim())) return text;
  const surfaceLabel = (surface: string) =>
    surface === 'shell' ? t('Commands') : surface === 'agent' ? t('Agent') : surface;
  return text
    .split('\n')
    .map((line) => {
      const count = /^background tasks:\s*(\d+)\s*$/i.exec(line.trim());
      if (count) return t('Background tasks: {{count}}', { count: Number(count[1]) });
      const row = /^- (\S+) ([^\s/]+)\/(\S+) (\S+)(?: label=(.*?))?(?: error=(.*))?$/.exec(line.trim());
      if (!row) return line;
      const [, id, surface, operation, status, label, error] = row;
      return toolActivityCompact([
        shortMachineId(id),
        surfaceLabel(surface),
        operation === surface ? '' : toolActivityActionLabel(operation),
        toolStatusLabel(status),
        label,
        error,
      ]);
    })
    .join('\n');
}

export function toolActivityBackgroundTask(
  text: string,
  waitResult = false
): {
  meta: string;
  body: string;
  failed: boolean;
  running: boolean;
  outcome: string;
  reason: string;
} | null {
  const notification = parseTaskNotification(text);
  if (notification) {
    const error = String(notification.error || '');
    const result = toolActivityBackgroundOutcome(
      String(notification.status || ''),
      notification.exitCode,
      false,
      '',
      error
    );
    const summary = String(notification.summary || '');
    const shell = /^Shell task [^(]*\(exit [^)]*\)(?::\s*([\s\S]*))?$/.exec(summary);
    // With no output at all the command is the only thing left to show; the
    // header already says it failed and how.
    const command = (shell?.[1] || '').trim();
    let failure = '';
    if (result.failed) failure = shell ? command || toolActivityFailureLine(result, '') : summary.trim();
    const id = shortMachineId(String(notification.taskId || ''));
    return {
      meta: toolActivityCompact([result.failed ? result.outcome : result.statusLabel, id]),
      body: toolActivityFailureBody(
        toolActivityDropEmptySections(toolActivityStripInstructions(String(notification.result || ''))),
        error,
        failure
      ),
      failed: result.failed,
      running: false,
      outcome: result.outcome,
      reason: result.reason,
    };
  }
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== 'background task') return null;
  const meta = new Map<string, string>();
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (!line) {
      index += 1;
      break;
    }
    const match = /^([a-z0-9_]+):\s*(.*)$/i.exec(line);
    // The runtime's guidance line is part of this header block.
    if (!match && toolActivityIsBodyInstruction(line)) continue;
    if (!match) break;
    meta.set(match[1].toLowerCase(), match[2].trim());
  }
  const status = (meta.get('status') || '').toLowerCase();
  // A shell job still running is "in the background" to the reader; the row's
  // own verb already says it runs.
  const background = status === 'running' && (!meta.get('surface') || meta.get('surface') === 'shell');
  const error = meta.get('error') || '';
  const result = toolActivityBackgroundOutcome(
    status,
    meta.get('exit_code'),
    meta.get('timed_out') === 'true',
    meta.get('signal') || '',
    error
  );
  const statusLabel = background ? TOOL_DETAIL_LABELS.background : result.statusLabel;
  const body = toolActivityFailureBody(
    toolActivityDropEmptySections(toolActivityStripInstructions(lines.slice(index).join('\n'), false, waitResult)),
    error,
    result.failed
      ? (!meta.get('surface') || meta.get('surface') === 'shell' ? meta.get('label') : '') ||
          toolActivityFailureLine(result, '')
      : ''
  );
  return {
    meta: toolActivityCompact([
      result.failed ? result.outcome : statusLabel,
      shortMachineId(meta.get('task_id') || ''),
    ]),
    body,
    failed: result.failed,
    running: status === 'running',
    outcome: result.outcome,
    reason: result.reason,
  };
}

export function toolActivityIsCompleted(status: string): boolean {
  return /^(?:completed|complete|done|success|succeeded|checked)$/i.test(status);
}
