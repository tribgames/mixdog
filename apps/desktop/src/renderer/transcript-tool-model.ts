import { type TranscriptItem } from "./desktop-types";
import { asRecord, oneLine } from "./text-format";
import {
  desktopToolActivityCategory,
  desktopToolActivityModeledName,
  toolActivityItemTone,
  toolItemDone,
  type ToolCardModel,
} from "./transcript-tool-core";
import {
  TOOL_ACTIVITY_BULK_ARGS,
  TOOL_ACTIVITY_INTERNAL_ARGS,
  TOOL_ACTIVITY_MEANINGLESS_RESULT,
  TOOL_ACTIVITY_ROUTINE_RESULT,
  TOOL_DETAIL_LABELS,
  toolActivityCodeLanguage,
  toolActivityCommand,
  toolActivityFieldLabel,
  toolActivityFieldValue,
  toolActivityFirstText,
  toolActivityLocalizedResult,
  toolActivityRedactInlineSecrets,
  toolActivityRepresentedKeys,
  toolActivitySubject,
  toolActivityTitle,
} from "./transcript-tool-format";
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
} from "./transcript-tool-result";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { formatToolSurface } from "../../../../src/runtime/shared/tool-surface.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolCardModel } from "../../../../src/runtime/shared/tool-card-model.mjs";

export * from "./transcript-tool-core";
export * from "./transcript-tool-format";
export * from "./transcript-tool-result";

export interface DesktopToolActivityItemPresentation {
  category: string;
  title: string;
  subject: string;
  resultLabel: string;
  pending: boolean;
  tone: string;
  command: string;
  fields: Array<{ key: string; label: string; value: string }>;
  diffPatch: string;
  outputText: string;
  metaText: string;
  outputLanguage: string;
  previewLabel: string;
  previewText: string;
  previewLanguage: string;
  beforeText: string;
  afterText: string;
  replacementLanguage: string;
  structuredKind: ToolActivityStructuredKind;
  structuredRows: ToolActivityStructuredRow[];
  hasDetails: boolean;
  hideSubjectWhenOpen: boolean;
}

export function desktopToolActivityItemPresentation(
  item: TranscriptItem,
  nowMs = Date.now(),
): DesktopToolActivityItemPresentation {
  const name = String(item.name || "tool");
  const originalSurface = formatToolSurface(name, item.args);
  const originalName = originalSurface.normalizedName;
  const modeledName = desktopToolActivityModeledName(name, item.args);
  const surface = formatToolSurface(modeledName, item.args);
  const normalizedName = surface.normalizedName;
  const args = asRecord(surface.args) ?? asRecord(item.args) ?? {};
  const done = toolItemDone(item);
  const model = deriveToolCardModel({
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
  }) as ToolCardModel & {
    resultSummary?: string | null;
    displayedResultBodyText?: string;
    terminalStatus?: string;
  };
  const baseTone = toolActivityItemTone(item);
  const tone = baseTone !== "neutral"
    ? baseTone
    : item.isError || Number(item.errorCount || 0) > 0 || /fail|error|timeout|denied/i.test(String(model.terminalStatus || ""))
      ? "error"
      : "neutral";
  const resultValue = toolActivityResultValue(item);
  const structured = toolActivityStructuredRows(normalizedName, args, resultValue);
  const title = toolActivityTitle(normalizedName, originalName, surface.label, args);
  const subject = toolActivityRedactInlineSecrets(toolActivitySubject(
    normalizedName,
    args,
    oneLine(String(model.summaryText || "")),
  ), args);
  const command = /^(?:shell|bash|bash_session|shell_command|job_wait|git)$/.test(normalizedName)
    ? toolActivityCommand(args)
    : "";
  const represented = toolActivityRepresentedKeys(normalizedName);
  if (desktopToolActivityCategory(name, item.args) === "MCP") {
    ["query", "q", "text", "prompt", "path", "uri", "name", "id", "action"]
      .forEach((key) => represented.add(key));
  }
  const fields = Object.entries(args)
    .filter(([key, value]) => (
      value !== undefined
      && value !== null
      && value !== ""
      && !represented.has(key)
      && !TOOL_ACTIVITY_INTERNAL_ARGS.has(key)
      && !TOOL_ACTIVITY_BULK_ARGS.has(key)
      && value !== false
      && !(typeof value === "number" && value === 0)
    ))
    .map(([key, value]) => ({
      key,
      label: toolActivityFieldLabel(key),
      value: toolActivityFieldValue(key, value),
    }));
  const argumentPatch = typeof args.patch === "string" ? args.patch.trim() : "";
  const diffPatch = typeof item.uiDiff === "string" && item.uiDiff.trim()
    ? item.uiDiff.trim()
    : normalizedName === "apply_patch" ? argumentPatch : "";
  const previewText = originalName === "write" && typeof args.content === "string"
    ? args.content
    : "";
  const beforeText = !diffPatch && normalizedName === "edit"
    ? toolActivityFirstText(args, "old_string", "oldString", "old_str")
    : "";
  const afterText = !diffPatch && normalizedName === "edit"
    ? toolActivityFirstText(args, "new_string", "newString", "new_str")
    : "";
  const targetPath = toolActivityFirstText(
    args, "file_path", "filePath", "path", "file", "target",
  );
  const previewLanguage = previewText ? toolActivityCodeLanguage(targetPath) : "";
  const replacementLanguage = beforeText || afterText
    ? toolActivityCodeLanguage(targetPath)
    : "";
  let outputText = toolActivityCleanOutput(toolActivityOutputText(
    item.rawResult ?? model.displayedResultBodyText ?? item.result,
  ));
  const backgroundTask = toolActivityBackgroundTask(outputText);
  const metaText = backgroundTask ? backgroundTask.meta : "";
  if (backgroundTask) outputText = backgroundTask.body;
  const mutation = normalizedName === "edit" || normalizedName === "apply_patch";
  const routineSurface = mutation
    || normalizedName === "load_tool"
    || /^(?:skill|skill_execute|skill_view|skills_list|use_skill)$/.test(normalizedName)
    || normalizedName === "agent"
    || normalizedName === "bridge"
    || normalizedName === "task";
  const quietSuccessSurface = normalizedName === "load_tool"
    || /^(?:skill|skill_execute|skill_view|skills_list|use_skill)$/.test(normalizedName);
  if (structured.kind || (tone === "neutral" && routineSurface
    && TOOL_ACTIVITY_ROUTINE_RESULT.test(outputText.trim()))) {
    outputText = "";
  }
  if (tone === "neutral" && quietSuccessSurface) outputText = "";
  if (normalizedName === "view_image" && /^\[image:/i.test(outputText.trim())) outputText = "";
  if (tone === "neutral" && diffPatch && outputText.split("\n").length === 1
    && /(?:applied|updated|changed|created|deleted|success|done)/i.test(outputText)) {
    outputText = "";
  }
  let resultLabel = "";
  if (!model.pending) {
    const semantic = oneLine(String(model.resultSummary || ""));
    if (semantic && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(semantic)) resultLabel = semantic;
    if (tone === "neutral" && quietSuccessSurface) resultLabel = "";
    if (!resultLabel && tone === "error") {
      const failure = oneLine(String(model.headerFailureText || model.detailLine || ""));
      resultLabel = toolActivityErrorSummary(outputText)
        || (failure && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(failure) ? failure : "Failed");
    }
  }
  if (structured.rows.length) {
    const completed = structured.rows.filter((row) => toolActivityIsCompleted(row.status)).length;
    resultLabel = `${completed}/${structured.rows.length}`;
  }
  if (!resultLabel && normalizedName === "git_stage" && /^staged\b/i.test(outputText.trim())) {
    resultLabel = "Staged";
  }
  if (resultLabel && outputText
    && oneLine(outputText).toLocaleLowerCase() === resultLabel.toLocaleLowerCase()) {
    outputText = "";
  }
  resultLabel = resultLabel ? toolActivityLocalizedResult(resultLabel) : "";
  const outputLanguage = outputText && !command && /^[{[]/.test(outputText.trimStart())
    ? "json"
    : "";
  const hasDetails = Boolean(
    command
    || fields.length
    || diffPatch
    || outputText
    || metaText
    || previewText
    || beforeText
    || afterText
    || structured.rows.length,
  );
  return {
    category: desktopToolActivityCategory(name, item.args),
    title,
    subject,
    resultLabel,
    pending: model.pending,
    tone,
    command,
    fields,
    diffPatch,
    outputText,
    metaText,
    outputLanguage,
    previewLabel: previewText ? TOOL_DETAIL_LABELS.content : "",
    previewText,
    previewLanguage,
    beforeText,
    afterText,
    replacementLanguage,
    structuredKind: structured.kind,
    structuredRows: structured.rows,
    hasDetails,
    hideSubjectWhenOpen: Boolean(command),
  };
}
