import { type TranscriptItem } from "./desktop-types";
import { asRecord } from "./text-format";
import { boundedTextOf } from "./transcript-tool-core";
import {
  TOOL_ACTIVITY_ROUTINE_RESULT,
  TOOL_DETAIL_LABELS,
  toolActivityCompact,
  toolActivityFieldValue,
  toolActivityFirstText,
  toolActivityInline,
} from "./transcript-tool-format";

export type ToolActivityStructuredKind = "plan" | "todos" | "questions" | "";

export interface ToolActivityStructuredRow {
  text: string;
  status: string;
  answer?: string;
}

export function toolActivityErrorSummary(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return toolActivityInline(
    first.replace(/^(?:\[(?:error|failed)\]\s*|error\s*:?\s*|failed\s*:?\s*)/i, ""),
    180,
  );
}

export function toolActivityResultValue(item: TranscriptItem): unknown {
  const value = item.rawResult ?? item.result;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toolActivityAnswer(
  result: unknown,
  question: Record<string, unknown>,
  index: number,
  total: number,
): string {
  const secret = question.is_secret === true || question.isSecret === true;
  const record = asRecord(result);
  const answers = record?.answers ?? record?.answer;
  let value: unknown;
  if (Array.isArray(answers)) value = answers[index];
  else {
    const answerRecord = asRecord(answers);
    const id = toolActivityFirstText(question, "id");
    value = answerRecord?.[id] ?? answerRecord?.[String(index)];
  }
  if (value == null && total === 1 && typeof result === "string"
    && result.trim() && !TOOL_ACTIVITY_ROUTINE_RESULT.test(result.trim())) {
    value = result.trim();
  }
  const text = Array.isArray(value)
    ? value.map((entry) => toolActivityInline(entry)).filter(Boolean).join(", ")
    : toolActivityInline(value);
  return text ? (secret ? "••••••" : text) : "";
}

export function toolActivityStructuredRows(
  normalizedName: string,
  args: Record<string, unknown>,
  result: unknown,
): { kind: ToolActivityStructuredKind; rows: ToolActivityStructuredRow[] } {
  if (normalizedName === "request_user_input" && Array.isArray(args.questions)) {
    const questions = args.questions
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return {
      kind: "questions",
      rows: questions.map((question, index) => ({
        text: toolActivityFirstText(question, "question", "header", "text") || `Question ${index + 1}`,
        status: toolActivityAnswer(result, question, index, questions.length) ? "completed" : "pending",
        answer: toolActivityAnswer(result, question, index, questions.length),
      })),
    };
  }
  const source = Array.isArray(args.todos) ? args.todos
    : normalizedName === "update_plan" && Array.isArray(args.plan) ? args.plan
      : [];
  if (source.length) {
    const kind: ToolActivityStructuredKind = Array.isArray(args.todos) ? "todos" : "plan";
    return {
      kind,
      rows: source.map((entry, index) => {
        const record = asRecord(entry) ?? {};
        return {
          text: toolActivityFirstText(record, "content", "step", "text", "title") || `${kind === "todos" ? "Todo" : "Step"} ${index + 1}`,
          status: toolActivityFirstText(record, "status") || "pending",
        };
      }),
    };
  }
  return { kind: "", rows: [] };
}

export function toolActivityOutputText(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") return toolActivityFieldValue("output", value).trimEnd();
  const text = value.trimEnd();
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, 100_000);
    } catch {}
  }
  return boundedTextOf(text, 100_000).trimEnd();
}

const TOOL_ACTIVITY_PROTOCOL_HINT =
  /(?:pass offset:|one window:|to continue|for more|raw source spans|evidence-ref|showing \d+ of|top \d+ of)/i;
const TOOL_ACTIVITY_TASK_INSTRUCTION =
  /(?:completion is automatic|do not call task|continue independent work|explicitly ask|use read for full output)/i;

function toolActivityIsProtocolLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\[arg-guard\]/i.test(text)) return true;
  if (!/^(?:\.{3}\s*)?\[[^\]]*\]$/.test(text)) return false;
  return TOOL_ACTIVITY_PROTOCOL_HINT.test(text);
}

export function toolActivityCleanOutput(text: string): string {
  if (!text.includes("[")) return text;
  return text
    .split("\n")
    .filter((line) => !toolActivityIsProtocolLine(line))
    .join("\n")
    .trim();
}

export function toolActivityBackgroundTask(text: string): { meta: string; body: string } | null {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "background task") return null;
  const meta = new Map<string, string>();
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) {
      index += 1;
      break;
    }
    const match = /^([a-z0-9_]+):\s*(.*)$/i.exec(line);
    if (!match) break;
    meta.set(match[1].toLowerCase(), match[2].trim());
  }
  const status = (meta.get("status") || "").toLowerCase();
  const statusLabel = status === "running"
    ? TOOL_DETAIL_LABELS.running
    : status === "completed"
      ? TOOL_DETAIL_LABELS.completed
      : status === "failed" ? TOOL_DETAIL_LABELS.failed : status;
  const body = lines.slice(index).join("\n")
    .split(/\n{2,}/)
    .filter((block) => block.trim() && !TOOL_ACTIVITY_TASK_INSTRUCTION.test(block))
    .join("\n\n")
    .trim();
  return {
    meta: toolActivityCompact([statusLabel, meta.get("task_id"), meta.get("error")]),
    body,
  };
}

export function toolActivityIsCompleted(status: string): boolean {
  return /^(?:completed|complete|done|success|succeeded|checked)$/i.test(status);
}
