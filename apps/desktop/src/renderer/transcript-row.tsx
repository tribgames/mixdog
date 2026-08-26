import React, { Suspense, lazy, memo, useEffect, useMemo, useRef } from "react";
import { type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { preloadMarkdownBody } from "./markdown-body-loader";
import { MxIcon } from "./MxIcon";
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  isPlainTextMarkdown,
  resolveStreamingMarkdownChunks,
} from "./streaming-markdown";
import StreamingMarkdownBody from "./StreamingMarkdownBody";
import {
  createTranscriptRowMeasureScheduler,
  requestTranscriptRowMeasure,
} from "./transcript-measure";
import { imagePreviewCache, imagePreviewKey } from "./transcript-metrics";
import { CopyControl } from "./transcript-primitives";
import { CompletionStatus } from "./transcript-status";
import { shouldSuppressFullyFailedToolItem } from "./transcript-tool-model";
import { ToolCard } from "./transcript-tool-ui";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText, isTranscriptCancelledStatusText } from "../../../../src/runtime/shared/tool-execution-contract.mjs";
import { stripInjectedDisplayText, stripSessionEnvelope } from "../shared/session-title.mjs";

let streamingMarkdownBodyPromise: Promise<typeof import("./StreamingMarkdownBody")> | null = null;
export const MarkdownBody = lazy(preloadMarkdownBody);

export function preloadStreamingMarkdownBody() {
  streamingMarkdownBodyPromise ||= import("./StreamingMarkdownBody").catch((error) => {
    streamingMarkdownBodyPromise = null;
    throw error;
  });
  return streamingMarkdownBodyPromise;
}

const StableMarkdownBody = React.memo(function StableMarkdownBody({ text }: { text: string }) {
  if (isPlainTextMarkdown(text)) return <p>{text}</p>;
  return <MarkdownBody text={text} copyControl={CopyControl} />;
});

export const MarkdownResponse = React.memo(function MarkdownResponse({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const markdownCache = useRef(createStreamingMarkdownCache());
  const markdownRoot = useRef<HTMLDivElement>(null);
  const scheduleMarkdownMeasure = useMemo(
    () => createTranscriptRowMeasureScheduler(
      () => requestTranscriptRowMeasure(markdownRoot.current),
    ),
    [],
  );
  const workerPipeline = useRef(streaming);
  if (streaming) workerPipeline.current = true;
  const markdownParts = resolveStreamingMarkdownChunks(text, streaming, markdownCache.current);
  const renderedChunks = markdownParts.stableChunks.map((chunk, index) => (
    <Suspense fallback={null}
      key={markdownParts.stableChunkKeys[index]}>
      {workerPipeline.current
        ? <StreamingMarkdownBody text={chunk}
            copyControl={CopyControl} onRendered={scheduleMarkdownMeasure} />
        : <StableMarkdownBody text={chunk} />}
    </Suspense>
  ));
  if (markdownParts.unstableText) {
    const unstableParseText = streaming
      ? healStreamingMarkdownTail(markdownParts.unstableText)
      : markdownParts.unstableText;
    renderedChunks.push(
      <Suspense
        fallback={null}
        key={markdownParts.unstableKey}>
        {workerPipeline.current
          ? <StreamingMarkdownBody
              text={markdownParts.unstableText}
              parseText={unstableParseText}
              parse={markdownParts.parseUnstable}
              copyControl={CopyControl}
              onRendered={scheduleMarkdownMeasure} />
          : <StableMarkdownBody text={markdownParts.unstableText} />}
      </Suspense>,
    );
  }
  return <div className={`markdown ${streaming ? "streaming" : ""}`} ref={markdownRoot}>
    {renderedChunks}
  </div>;
});

export function transcriptItemsEqual(
  previous: TranscriptItem | undefined,
  next: TranscriptItem | undefined,
): boolean {
  // Snapshot deltas preserve identity, avoiding retained value copies of large
  // tool outputs while still making every replacement a render boundary.
  return previous === next;
}

export function messageMetadata(item: TranscriptItem) {
  const shortTime = typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0
    ? new Date(item.at).toLocaleTimeString(undefined, { timeStyle: "short" })
    : "";
  return { shortTime };
}

function stripImageTokens(text: string): string {
  return text
    .replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

interface PastedTextChip { name: string }

function extractPastedTextMarkers(text: string): { text: string; chips: PastedTextChip[] } {
  const chips: PastedTextChip[] = [];
  const stripped = String(text || "").replace(/ ?\[Pasted text #\d+ \+(\d+) lines\] ?/g, (_match, lines) => {
    chips.push({ name: `Pasted text · ${lines} lines` });
    return " ";
  });
  if (chips.length === 0) return { text, chips };
  const cleaned = stripped
    .split(/\r?\n/).map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, chips };
}

interface ImageMarkerChip { name: string; dims: string; title: string }

function extractImageMarkers(text: string): { text: string; chips: ImageMarkerChip[] } {
  const chips: ImageMarkerChip[] = [];
  const kept: string[] = [];
  let pendingRefs = 0;
  let lastWasMeta = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[Image #\d+(?::[^\]]*)?\]$/.test(line)) {
      pendingRefs += 1;
      lastWasMeta = false;
      continue;
    }
    const meta = /^\[Image(?::| source:) ([^\]]+)\]$/.exec(line);
    if (meta && !/^omitted\b/i.test(meta[1])) {
      const parts = meta[1].split(/,\s*/);
      const source = (parts.find((part) => part.startsWith("source: ")) || "").slice(8).trim()
        || (line.startsWith("[Image source:") ? meta[1].trim() : "");
      const dims = parts.find((part) => /^\d+x\d+$/.test(part)) || "";
      const name = source ? (source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Image") : "Image";
      chips.push({ name, dims: dims.replace("x", "\u00D7"), title: source || line });
      if (pendingRefs > 0) pendingRefs -= 1;
      lastWasMeta = true;
      continue;
    }
    if (/^\[Image omitted from stored history[^\]]*\]$/.test(line)) {
      if (!lastWasMeta) {
        chips.push({ name: "Image", dims: "", title: line });
        if (pendingRefs > 0) pendingRefs -= 1;
      }
      lastWasMeta = false;
      continue;
    }
    lastWasMeta = false;
    const inlineRefs = rawLine.match(/\[Image #\d+(?::[^\]]*)?\]/g);
    if (inlineRefs && inlineRefs.length > 0) {
      pendingRefs += inlineRefs.length;
      const strippedLine = rawLine.replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, " ").replace(/ {2,}/g, " ").trim();
      if (strippedLine) kept.push(strippedLine);
      continue;
    }
    kept.push(rawLine);
  }
  for (let index = 0; index < pendingRefs; index += 1) {
    chips.push({ name: t("Image"), dims: "", title: t("Attached image") });
  }
  return { text: kept.join("\n").trim(), chips };
}

const WEBHOOK_FENCE_RE =
  /(?:The block between the WEBHOOK_UNTRUSTED_DATA markers[^\n]*\n+)?<<<WEBHOOK_UNTRUSTED_DATA_BEGIN>>>\n?([\s\S]*?)\n?<<<WEBHOOK_UNTRUSTED_DATA_END>>>/;

function extractWebhookPayload(text: string): { text: string; payload: string } {
  const match = WEBHOOK_FENCE_RE.exec(text);
  if (!match) return { text, payload: "" };
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text: stripped, payload: (match[1] || "").trim() };
}

export function userTranscriptDisplayText(item: TranscriptItem): string {
  return stripInjectedDisplayText(stripSessionEnvelope(String(item.text || "")))
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
}

export function isVisibleTranscriptItem(item: TranscriptItem | undefined): boolean {
  if (!item) return false;
  if (item.kind === "tool") return !shouldSuppressFullyFailedToolItem(item);
  if (item.kind === "statusdone" || item.kind === "turndone" || item.kind === "notice") return true;
  if (item.kind === "assistant") return true;
  if (item.kind !== "user") return false;
  const metadataRecord = item.metadata && typeof item.metadata === "object"
    ? item.metadata as Record<string, unknown>
    : null;
  const sourceText = String(item.text || "");
  const text = userTranscriptDisplayText(item);
  return !(
    (Boolean(sourceText.trim()) && !text && !(Array.isArray(item.images) && item.images.length > 0))
    || /^(?:system|developer|synthetic|internal|hidden)$/i.test(String(item.role || item.kind || ""))
    || item.internal === true
    || item.hidden === true
    || item.synthetic === true
    || metadataRecord?.internal === true
    || metadataRecord?.hidden === true
    || metadataRecord?.synthetic === true
    || isInternalTranscriptDisplayText(text)
  );
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  completion,
  completionAnimate = false,
  attachedUser = false,
  disclosureScope = "",
}: {
  item: TranscriptItem;
  completion?: TranscriptItem;
  completionAnimate?: boolean;
  attachedUser?: boolean;
  disclosureScope?: string;
}) {
  const previousStreaming = useRef(Boolean(item.streaming));
  const announceSettled = previousStreaming.current && !item.streaming;
  useEffect(() => {
    previousStreaming.current = Boolean(item.streaming);
  }, [item.streaming]);
  if (item.kind === "tool") {
    if (shouldSuppressFullyFailedToolItem(item)) return null;
    return <ToolCard item={item} disclosureScope={disclosureScope} />;
  }
  if (item.kind === "statusdone" || item.kind === "turndone") {
    return <CompletionStatus item={item} animate={completionAnimate} />;
  }
  if (item.kind === "notice") {
    const tone = item.tone === "error" ? "error" : item.tone === "warn" ? "warn" : "";
    return <div className={`notice ${tone}`}
      role={item.tone === "error" ? "alert" : "status"}>{item.text}</div>;
  }
  if (item.kind !== "user" && item.kind !== "assistant") return null;
  const user = item.kind === "user";
  const text = user ? userTranscriptDisplayText(item) : String(item.text || "");
  if (user && isTranscriptCancelledStatusText(text)) {
    return <CompletionStatus item={{ kind: "turndone", status: "cancelled", elapsedMs: 0 } as TranscriptItem} />;
  }
  if (!isVisibleTranscriptItem(item)) return null;
  const metadata = messageMetadata(item);
  const attachedImages = user && Array.isArray(item.images) ? item.images : [];
  const imageMarkers = user ? extractImageMarkers(text) : { text, chips: [] };
  const markerChips = attachedImages.length > 0 ? [] : imageMarkers.chips;
  const userDisplayText = attachedImages.length > 0
    ? stripImageTokens(imageMarkers.text)
    : imageMarkers.text;
  const pastedFold = user ? extractPastedTextMarkers(userDisplayText)
    : { text: userDisplayText, chips: [] as PastedTextChip[] };
  const webhookFold = user ? extractWebhookPayload(pastedFold.text) : { text: pastedFold.text, payload: "" };
  return (
    <>
      <article className={`message ${user ? "user" : "assistant"} ${item.streaming ? "streaming" : "settled"} ${item.pending ? "pending" : ""} ${user && attachedUser ? "attached-user" : ""}`}
        aria-live={item.streaming || announceSettled ? "off" : undefined}
        aria-busy={item.pending === true ? "true" : undefined}>
        <div className="message-body" onDragStart={(event) => event.preventDefault()}>
          {user ? <>
            {(attachedImages.length > 0 || markerChips.length > 0 || pastedFold.chips.length > 0)
              && <div className="message-image-chips"
              aria-label={t("Attachments")}>
              {attachedImages.map((image, index) => {
                const preview = imagePreviewCache.get(imagePreviewKey(image.id, image.bytes));
                const name = image.name || t("Attached image");
                return preview
                  ? <button type="button" className="message-image-chip message-image-chip-button"
                    key={`${image.id ?? "img"}-${index}`} title={name}
                    aria-label={t("Open image")}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => void window.mixdogDesktop?.openAttachmentImage?.(preview, name)
                      ?.catch(() => undefined)}>
                    <img src={preview} alt={name} />
                  </button>
                  : <span className="message-image-chip" key={`${image.id ?? "img"}-${index}`}
                    title={name}>
                    <span className="message-image-fallback">
                      <MxIcon name="photo" size={14} />
                      <span>{image.name || "Image"}</span>
                    </span>
                  </span>;
              })}
              {markerChips.map((chip, index) => (
                <span className="message-image-chip" key={`marker-${index}`} title={chip.title}>
                  <span className="message-image-fallback">
                    <MxIcon name="photo" size={14} />
                    <span>{chip.name}</span>
                    {chip.dims ? <small>{chip.dims}</small> : null}
                  </span>
                </span>
              ))}
              {pastedFold.chips.map((chip, index) => (
                <span className="message-image-chip message-pasted-chip" key={`pasted-${index}`} title={chip.name}>
                  <span className="message-image-fallback">
                    <MxIcon name="open-file" size={14} />
                    <span>{chip.name}</span>
                  </span>
                </span>
              ))}
            </div>}
            {webhookFold.text ? <p>{webhookFold.text}</p> : null}
          </> : (
            <MarkdownResponse text={text} streaming={Boolean(item.streaming)} />
          )}
        </div>
        {!user && !item.streaming && completion && <footer className="response-footer"
          aria-label={t("Response details")}>
          <CompletionStatus item={completion} animate={completionAnimate} />
          {metadata.shortTime &&
            <time className="message-time">{metadata.shortTime}</time>}
          {text && <CopyControl value={text} label={t("Copy response")}
            className="message-actions response-copy" />}
        </footer>}
      </article>
      {announceSettled && !completion && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Mixdog response complete.
      </p>}
    </>
  );
}, (previous, next) => (
  transcriptItemsEqual(previous.item, next.item)
  && transcriptItemsEqual(previous.completion, next.completion)
  && previous.completionAnimate === next.completionAnimate
  && previous.attachedUser === next.attachedUser
  && previous.disclosureScope === next.disclosureScope
));
