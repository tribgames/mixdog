import { ChevronRight, Code2, Layers3, ListTree } from "lucide-react";
import React, {
  Suspense,
  lazy,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { preloadMarkdownBody } from "./markdown-body-loader";
import { MxIcon } from "./MxIcon";
import { CodeDiff } from "./transcript-diff";
import { CopyControl, TextShimmer } from "./transcript-primitives";
import { requestTranscriptRowMeasure } from "./transcript-measure";
import {
  desktopToolActivityCategoryGroups,
  desktopToolActivityItemPresentation,
  isHookApprovalDenialToolItem,
  TOOL_DETAIL_LABELS,
  toolActivityIsCompleted,
  toolItemDone,
  type ToolCardModel,
} from "./transcript-tool-model";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatToolSurface } from "../../../../src/runtime/shared/tool-surface.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolCardModel, deriveToolOutcomeTone, splitLineDeltaTokens } from "../../../../src/runtime/shared/tool-card-model.mjs";

interface DetailLinePart { text: string; delta?: "+" | "-" }

const TOOL_DISCLOSURE_LIMIT = 1_000;
const toolDisclosureStates = new Map<string, boolean>();

function toolDisclosureKey(item: TranscriptItem, scope: string): string {
  const id = String(item.id ?? "").trim();
  return id ? `${scope}:${id}` : "";
}

function rememberToolDisclosure(key: string, open: boolean): void {
  if (!key) return;
  toolDisclosureStates.delete(key);
  toolDisclosureStates.set(key, open);
  while (toolDisclosureStates.size > TOOL_DISCLOSURE_LIMIT) {
    const oldest = toolDisclosureStates.keys().next().value;
    if (typeof oldest !== "string") break;
    toolDisclosureStates.delete(oldest);
  }
}

// Disclosure state is visit-scoped and survives virtualized row remounts.
export function resetToolDisclosureScope(scope: string): void {
  if (!scope) return;
  const prefix = `${scope}:`;
  for (const key of [...toolDisclosureStates.keys()]) {
    if (key.startsWith(prefix)) toolDisclosureStates.delete(key);
  }
}

function toolActivityDisclosureKey(items: readonly TranscriptItem[], scope: string): string {
  const id = String(items[0]?.id ?? "").trim();
  return id ? `${scope}:tool-activity:${id}` : "";
}

export function ToolActivityGroup({
  items,
  disclosureScope = "",
}: {
  items: readonly TranscriptItem[];
  disclosureScope?: string;
}) {
  const disclosureKey = toolActivityDisclosureKey(items, disclosureScope);
  const [open, setOpen] = useState(() =>
    disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  useLayoutEffect(() => {
    setOpen(disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  }, [disclosureKey]);
  const groupRef = useRef<HTMLElement>(null);
  const measuredOpen = useRef(open);
  useLayoutEffect(() => {
    if (measuredOpen.current === open) return;
    measuredOpen.current = open;
    requestTranscriptRowMeasure(groupRef.current);
  }, [open]);
  const contentId = useId();
  const pending = items.some((item) => !toolItemDone(item));
  const categoryGroups = useMemo(
    () => desktopToolActivityCategoryGroups(items),
    [items],
  );
  const categorySummary = categoryGroups
    .map((group) => `${group.label} ${group.count}`)
    .join(" · ");
  const label = categorySummary || t("Tool use");

  return (
    <article ref={groupRef}
      className="tool-activity"
      data-surface="desktop"
      data-open={open ? "true" : "false"}>
      <button className="tool-header tool-activity-header"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => {
          const next = !value;
          rememberToolDisclosure(disclosureKey, next);
          return next;
        })}
        aria-expanded={open} aria-controls={contentId}>
        <span className="tool-icon"><ListTree size={16} /></span>
        <span className="tool-title tool-activity-title" title={label}>
          <b>{label}</b>
        </span>
        {pending && <span className="sr-only" role="status">{t("Running")}</span>}
        <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>
      </button>
      {open && (
        <div className="tool-activity-content" id={contentId}>
          <ToolActivityDetails groups={categoryGroups} disclosureKey={disclosureKey} />
        </div>
      )}
    </article>
  );
}

function activityItemKey(item: TranscriptItem, index: number): string {
  return String(item.id ?? `${String(item.name || "tool")}:${index}`);
}

function disclosureChildKey(parent: string, kind: "category" | "item", id: string): string {
  return parent ? `${parent}:${kind}:${id}` : "";
}

function ToolActivityDetails({
  groups,
  disclosureKey,
}: {
  groups: ReturnType<typeof desktopToolActivityCategoryGroups>;
  disclosureKey: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const allItems = groups.flatMap((group) => group.items);
  const rememberedCategory = () => groups.find((group) =>
    toolDisclosureStates.get(disclosureChildKey(disclosureKey, "category", group.unitKey)) === true)
    ?.unitKey ?? null;
  const rememberedItem = () => allItems.find((item, index) =>
    toolDisclosureStates.get(disclosureChildKey(
      disclosureKey,
      "item",
      activityItemKey(item, index),
    )) === true);
  const [openCategory, setOpenCategory] = useState<string | null>(rememberedCategory);
  const [openItem, setOpenItem] = useState<string | null>(() => {
    const item = rememberedItem();
    return item ? activityItemKey(item, allItems.indexOf(item)) : null;
  });
  useLayoutEffect(() => {
    setOpenCategory(rememberedCategory());
    const item = rememberedItem();
    setOpenItem(item ? activityItemKey(item, allItems.indexOf(item)) : null);
  }, [disclosureKey, groups]);
  useLayoutEffect(() => {
    requestTranscriptRowMeasure(rootRef.current);
  }, [openCategory, openItem]);

  const rememberToggledDisclosure = (
    kind: "category" | "item",
    id: string,
    open: string | null,
  ): string | null => {
    const next = open === id ? null : id;
    if (open) {
      rememberToolDisclosure(disclosureChildKey(disclosureKey, kind, open), false);
    }
    rememberToolDisclosure(disclosureChildKey(disclosureKey, kind, id), next !== null);
    return next;
  };

  const toggleCategory = (category: string) => {
    const next = rememberToggledDisclosure("category", category, openCategory);
    if (openItem) {
      rememberToolDisclosure(disclosureChildKey(disclosureKey, "item", openItem), false);
      setOpenItem(null);
    }
    setOpenCategory(next);
  };

  const toggleItem = (key: string) => {
    setOpenItem(rememberToggledDisclosure("item", key, openItem));
  };

  let itemIndex = 0;
  return (
    <div ref={rootRef} className="tool-activity-details">
      {groups.map((group, groupIndex) => {
        const groupItems = group.items.map((item) => ({
          item,
          index: itemIndex++,
        }));
        if (group.items.length <= 1) {
          const entry = groupItems[0];
          if (!entry) return null;
          const key = activityItemKey(entry.item, entry.index);
          return <ToolActivityItem key={key} item={entry.item}
            open={openItem === key} onToggle={() => toggleItem(key)}
            contentId={`${contentId}-item-${entry.index}`} />;
        }
        const categoryOpen = openCategory === group.unitKey;
        const categoryPending = group.items.some((item) => !toolItemDone(item));
        const categoryContentId = `${contentId}-category-${groupIndex}`;
        return (
          <section className="tool-activity-category"
            data-open={categoryOpen ? "true" : "false"} key={group.unitKey}>
            <button type="button" className="tool-header tool-activity-category-header"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => toggleCategory(group.unitKey)}
              aria-expanded={categoryOpen} aria-controls={categoryContentId}>
              <span className="tool-icon">{toolIcon(group.category)}</span>
              <span className="tool-title tool-activity-category-title">
                <b>{group.label}</b>
                <small>{group.count}</small>
              </span>
              {categoryPending && <span className="sr-only" role="status">{t("Running")}</span>}
              <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>
            </button>
            {categoryOpen && (
              <div className="tool-activity-category-items" id={categoryContentId}>
                {groupItems.map(({ item, index }) => {
                  const key = activityItemKey(item, index);
                  return <ToolActivityItem key={key} item={item}
                    open={openItem === key} onToggle={() => toggleItem(key)}
                    contentId={`${contentId}-item-${index}`} />;
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

const TOOL_ACTIVITY_MARKDOWN_HINT =
  /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\n\s*\|[^\n]*\|\s*(?:\n|$)/;
const TOOL_ACTIVITY_MARKDOWN_MAX = 20_000;
const ToolMarkdownBody = lazy(preloadMarkdownBody);

function toolActivityLooksMarkdown(text: string): boolean {
  return text.length <= TOOL_ACTIVITY_MARKDOWN_MAX
    && TOOL_ACTIVITY_MARKDOWN_HINT.test(text);
}

function toolActivityFencedCode(text: string, language: string): string {
  const longest = [...text.matchAll(/`{3,}/g)]
    .reduce((max, match) => Math.max(max, match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function ToolActivityRichBody({ text, language, fallbackClassName }: {
  text: string;
  language: string;
  fallbackClassName: string;
}) {
  const source = language ? toolActivityFencedCode(text, language) : text;
  return <div className="markdown tool-activity-markdown">
    <Suspense fallback={<pre className={fallbackClassName}>{text}</pre>}>
      <ToolMarkdownBody text={source} copyControl={CopyControl} />
    </Suspense>
  </div>;
}

function ToolActivityBody({ text, language, className }: {
  text: string;
  language: string;
  className: string;
}) {
  if (!language && !toolActivityLooksMarkdown(text)) {
    return <pre className={className}>{text}</pre>;
  }
  return <ToolActivityRichBody text={text} language={language}
    fallbackClassName={className} />;
}

function ToolActivityItem({
  item,
  open,
  onToggle,
  contentId,
}: {
  item: TranscriptItem;
  open: boolean;
  onToggle: () => void;
  contentId: string;
}) {
  const itemRef = useRef<HTMLElement>(null);
  const presentation = useMemo(
    () => desktopToolActivityItemPresentation(item),
    [item],
  );
  const panelOpen = open && presentation.hasDetails;
  const [rendered, setRendered] = useState(panelOpen);
  const [expanded, setExpanded] = useState(panelOpen);
  useLayoutEffect(() => {
    if (panelOpen) {
      setRendered(true);
      const frame = window.requestAnimationFrame(() => setExpanded(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = window.setTimeout(
      () => setRendered(false),
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    );
    return () => window.clearTimeout(timer);
  }, [panelOpen]);
  useLayoutEffect(() => {
    requestTranscriptRowMeasure(itemRef.current);
  }, [rendered, expanded]);

  return (
    <article ref={itemRef} className={`tool-activity-item ${presentation.tone}`}
      data-open={open ? "true" : "false"} data-expanded={expanded ? "true" : "false"}
      onTransitionEnd={(event) => {
        if (event.propertyName === "grid-template-rows") {
          requestTranscriptRowMeasure(itemRef.current);
        }
      }}>
      <button type="button" className="tool-header tool-activity-item-header"
        disabled={!presentation.hasDetails}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onToggle}
        aria-expanded={presentation.hasDetails ? open : undefined}
        aria-controls={presentation.hasDetails ? contentId : undefined}>
        <span className="tool-icon">{toolIcon(presentation.category)}</span>
        <span className="tool-title tool-activity-item-title"
          title={[presentation.title, presentation.subject, presentation.resultLabel].filter(Boolean).join(" · ")}>
          <b><TextShimmer text={presentation.title} active={presentation.pending} /></b>
          {presentation.subject && !(open && presentation.hideSubjectWhenOpen)
            && !(presentation.pending && !presentation.command)
            && <small>{presentation.subject}</small>}
        </span>
        {presentation.resultLabel && <span className="tool-activity-item-result">{presentation.resultLabel}</span>}
        {presentation.pending && <span className="sr-only" role="status">{t("Running")}</span>}
        {presentation.hasDetails && <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>}
      </button>
      {rendered && presentation.hasDetails && (
        <div className="tool-activity-item-body" id={contentId}>
          {presentation.metaText && (
            <p className="tool-activity-item-meta">{presentation.metaText}</p>
          )}
          {presentation.command && (
            <section className="tool-activity-terminal">
              <pre className="tool-activity-item-command"><code>$ {presentation.command}</code></pre>
              {presentation.outputText && (
                <pre className="tool-activity-item-output">{presentation.outputText}</pre>
              )}
              <CopyControl className="tool-detail-copy tool-activity-copy" label="Copy"
                value={[presentation.command, presentation.outputText].filter(Boolean).join("\n\n")} />
            </section>
          )}
          {presentation.structuredRows.length > 0 && (
            <section className="tool-activity-item-section">
              <span>{presentation.structuredKind === "questions"
                ? TOOL_DETAIL_LABELS.questions
                : presentation.structuredKind === "todos"
                  ? TOOL_DETAIL_LABELS.todos
                  : TOOL_DETAIL_LABELS.plan}</span>
              <div className="tool-activity-structured-list">
                {presentation.structuredRows.map((row, index) => (
                  <div className="tool-activity-structured-row"
                    data-status={row.status} key={`${row.text}:${index}`}>
                    <span className="tool-activity-structured-marker" aria-hidden="true">
                      {toolActivityIsCompleted(row.status) ? "✓" : "○"}
                    </span>
                    {presentation.structuredKind === "questions" ? (
                      <span className="tool-activity-structured-question">
                        <span className="tool-activity-structured-content">{row.text}</span>
                        {row.answer && <span className="tool-activity-structured-answer">
                          <span>{TOOL_DETAIL_LABELS.answer}</span>{row.answer}
                        </span>}
                      </span>
                    ) : <span className="tool-activity-structured-content">{row.text}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
          {presentation.previewText && (
            <section className="tool-activity-item-section">
              <span>{presentation.previewLabel}</span>
              <ToolActivityBody text={presentation.previewText}
                language={presentation.previewLanguage}
                className="tool-activity-item-preview" />
            </section>
          )}
          {(presentation.beforeText || presentation.afterText) && (
            <section className="tool-activity-item-section tool-activity-replacement">
              <div className="tool-activity-replacement-block" data-kind="before">
                <span>{TOOL_DETAIL_LABELS.before}</span>
                <ToolActivityBody text={presentation.beforeText}
                  language={presentation.replacementLanguage} className="" />
              </div>
              <div className="tool-activity-replacement-block" data-kind="after">
                <span>{TOOL_DETAIL_LABELS.after}</span>
                <ToolActivityBody text={presentation.afterText}
                  language={presentation.replacementLanguage} className="" />
              </div>
            </section>
          )}
          {presentation.fields.length > 0 && (
            <section className="tool-activity-item-section">
              <span>{TOOL_DETAIL_LABELS.arguments}</span>
              <dl className="tool-activity-item-fields">
                {presentation.fields.map((field) => (
                  <React.Fragment key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          )}
          {presentation.diffPatch && <CodeDiff patch={presentation.diffPatch} />}
          {presentation.outputText && !presentation.command && (
            <section className="tool-activity-item-section tool-activity-item-result-block">
              <ToolActivityBody text={presentation.outputText}
                language={presentation.outputLanguage}
                className="tool-activity-item-output" />
              <CopyControl className="tool-detail-copy tool-activity-copy" label="Copy"
                value={presentation.outputText} />
            </section>
          )}
        </div>
      )}
    </article>
  );
}

export function ToolCard({
  item,
  disclosureScope = "",
}: {
  item: TranscriptItem;
  disclosureScope?: string;
}) {
  const disclosureKey = toolDisclosureKey(item, disclosureScope);
  const [open, setOpen] = useState(() =>
    disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  useLayoutEffect(() => {
    setOpen(disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  }, [disclosureKey]);
  const cardRef = useRef<HTMLElement>(null);
  const measuredOpen = useRef(open);
  useLayoutEffect(() => {
    if (measuredOpen.current === open) return;
    measuredOpen.current = open;
    requestTranscriptRowMeasure(cardRef.current);
  }, [open]);
  const contentId = useId();
  const done = toolItemDone(item);
  const startedAt = Number(item.startedAt || 0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (done || !startedAt) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [done, startedAt]);
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const denied = isHookApprovalDenialToolItem(item);
  const surface = formatToolSurface(item.name, item.args);
  const category = classifyToolCategory(item.name, surface.args);
  const rawResult = item.result ?? item.rawResult;
  const model = useMemo(() => deriveToolCardModel({
    name: item.name,
    args: item.args,
    result: item.result,
    rawResult: item.rawResult,
    isError: item.isError,
    errorCount: item.errorCount,
    callErrorCount: item.callErrorCount,
    exitErrorCount: item.exitErrorCount,
    count: item.count,
    completedCount: done ? Math.max(1, Math.round(Number(item.count || 1))) : 0,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    aggregate: Boolean(item.aggregate),
    categories: item.categories,
    doneCategories: item.doneCategories,
    headerFinalized: item.headerFinalized,
    nowMs: nowTick,
  }) as ToolCardModel, [item, done, nowTick]);
  const hasResult = typeof rawResult === "string" ? Boolean(rawResult.trim()) : rawResult != null;
  const hasDetails = Boolean(model.detailLine);
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const partialMutation = callFailedCount > 0
    && typeof item.uiDiff === "string"
    && Boolean(item.uiDiff.trim());
  const outcomeTone = deriveToolOutcomeTone({
    pending: model.pending,
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus: denied ? "denied" : model.terminalStatus,
    partialMutation,
  });
  const failure = outcomeTone === "error";
  const warning = outcomeTone === "warning";
  const previousFailure = useRef(failure);
  const failureArrived = failure && !previousFailure.current;
  useEffect(() => {
    previousFailure.current = failure;
  }, [failure]);
  const errorCard = (failure || warning) && hasResult;
  const detailRowVisible = Boolean(model.detailLine) && open;
  return (
    <article ref={cardRef}
      className={`tool-card ${failure ? "failed" : ""} ${warning ? "warning" : ""} ${failureArrived ? "failure-arrived" : ""} ${done ? "settled" : ""}`}
      data-category={category} data-kind={errorCard ? "tool-error-card" : undefined}
      data-open={open ? "true" : "false"}>
      <button className="tool-header" disabled={!hasDetails}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => {
          const next = !value;
          rememberToolDisclosure(disclosureKey, next);
          return next;
        })} aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? contentId : undefined}>
        <span className="tool-icon">{toolIcon(category)}</span>
        <span className="tool-title"
          title={[model.labelText, model.summaryText ? `(${model.summaryText})` : ""]
            .filter(Boolean).join(" ")}>
          <b data-component={item.aggregate ? "tool-count-summary" : "tool-status-title"}
            data-active={!done ? "true" : "false"}>
            <TextShimmer text={model.labelText} active={!done} />
          </b>
        </span>
        {model.headerFailureText && <span className={`tool-state ${warning ? "warning" : "failed"}`} role="status">
          {model.headerFailureText}
        </span>}
        {!done && <span className="sr-only" role="status">{t("Running")}</span>}
        {hasDetails && <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>}
      </button>
      {detailRowVisible && (
        <div className="tool-detail-line" id={contentId} data-component="tool-collapsed-summary">
          <span className="tool-detail-text"
            data-placeholder={model.detailIsPlaceholder || undefined}>
            {(splitLineDeltaTokens(model.detailLine) as DetailLinePart[]).map((part, index) => (
              part.delta
                ? <em key={index} data-delta={part.delta}>{part.text}</em>
                : <React.Fragment key={index}>{part.text}</React.Fragment>
            ))}
          </span>
        </div>
      )}
    </article>
  );
}

export function toolIcon(category: unknown) {
  if (category === "Patch") return <Code2 size={16} />;
  if (category === "Read") return <MxIcon name="open-file" size={16} />;
  if (category === "Search" || category === "Web Research") return <MxIcon name="magnifying-glass" size={16} />;
  if (category === "Shell") return <MxIcon name="terminal" size={16} />;
  return <Layers3 size={16} />;
}
