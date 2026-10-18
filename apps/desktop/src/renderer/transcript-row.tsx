import { GitCommitHorizontal, GitPullRequest, SlidersHorizontal, Upload } from 'lucide-react';
import { parseIslandGitRequestText } from './island-git-request';
import { Suspense, createContext, memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { submissionIdentity } from './transcript-rows';
import {
  fitImageThumbnail,
  onSessionPreviewsDeleted,
  persistentImagePreviews,
  previewKey,
} from './image-preview-store';
import { AttachmentCard, composerCardMeta } from './attachment-card';
import {
  extractFileMarkers,
  fileChipKind,
  sentFileSource,
  sentPastedTextSource,
  type StoredAttachment,
} from './attachment-menu';
import { openAttachmentSource, useAttachmentContextMenu } from './attachment-context-menu';
import { MarkdownOpenFileContext, MarkdownSessionContext, MarkdownTranscriptItemContext } from './MarkdownLink';
import type { TranscriptItem } from './desktop-types';
import { isOtherDevice } from '../shared/session-devices';
import { t, uiFormatLocale } from './i18n';
import { VISUALIZE_TWEAKS_MARK } from './visualize-feedback-store';
import MarkdownBody from './MarkdownBody';
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  isPlainTextMarkdown,
  resolveStreamingMarkdownChunks,
} from './streaming-markdown';
import StreamingMarkdownBody from './StreamingMarkdownBody';
import { streamFadeTimeline } from './markdown-stream-fade';
import { preloadSyncMarkdownParser } from './markdown-worker-client';
import { imagePreviewCache, imagePreviewKey } from './transcript-metrics';
import { CopyControl } from './transcript-primitives';
import { noteStreamCommit } from './transcript-stream-metrics';
import { usePacedTranscriptText } from './use-paced-transcript-text';
import { type BackgroundWorkCounts, CompletionStatus } from './transcript-status';
import { shouldSuppressFullyFailedToolItem } from './transcript-tool-model';
import { ToolCard } from './transcript-tool-ui';
import { AppliedSkills, SkillMentionText, appliedSkillsOf } from './composer-skill-mentions';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText, isTranscriptCancelledStatusText, isTranscriptHiddenToolItem } from '../../../../src/runtime/shared/tool-execution-contract.mjs';
import { stripInjectedDisplayText, stripSessionEnvelope } from '../shared/session-title.mjs';

// StreamingMarkdownBody already loads the same renderer in this module.
// Wrapping history in React.lazy suspended even after preloading completed,
// holding the first transcript behind React's fallback reveal throttle.
export { MarkdownBody };

const StableMarkdownBody = memo(function StableMarkdownBody({ text }: { text: string }) {
  if (isPlainTextMarkdown(text)) return <p>{text}</p>;
  return <MarkdownBody text={text} copyControl={CopyControl} />;
});

const MarkdownResponse = memo(function MarkdownResponse({
  text,
  streaming,
  fadeKey,
  fadeMs,
}: {
  text: string;
  streaming: boolean;
  /** Row identity of the reply's word-fade timeline (markdown-stream-fade). */
  fadeKey: string;
  /** How long each newly shown word fades in. */
  fadeMs: number;
}) {
  const markdownCache = useRef(createStreamingMarkdownCache());
  const workerPipeline = useRef(streaming);
  const instanceKey = useId();
  // Every chunk, frozen ones included, fades on the reply's one timeline: a
  // paragraph that froze mid-fade keeps animating and the next block's first
  // words fade too. A settled reply has no timeline: it shows at full ink.
  const fadeTimeline = streamFadeTimeline(fadeKey || instanceKey, streaming, fadeMs);
  useLayoutEffect(() => {
    if (streaming) noteStreamCommit(text.length);
  }, [streaming, text]);
  if (streaming) workerPipeline.current = true;
  // Every reply loads the main-thread parser: a reply that arrives whole, or
  // the next settled row, then paints parsed in its first commit.
  useEffect(() => {
    void preloadSyncMarkdownParser();
  }, []);
  const markdownParts = resolveStreamingMarkdownChunks(text, streaming, markdownCache.current);
  const renderedChunks = markdownParts.stableChunks.map((chunk, index) => (
    <Suspense fallback={<span hidden data-transcript-pending />} key={markdownParts.stableChunkKeys[index]}>
      {workerPipeline.current ? (
        <StreamingMarkdownBody
          text={chunk}
          sync
          fadeTimeline={fadeTimeline}
          fadeChunk={markdownParts.stableChunkKeys[index]}
          copyControl={CopyControl}
        />
      ) : (
        <StableMarkdownBody text={chunk} />
      )}
    </Suspense>
  ));
  if (markdownParts.unstableText) {
    const unstableParseText = streaming
      ? healStreamingMarkdownTail(markdownParts.unstableText)
      : markdownParts.unstableText;
    renderedChunks.push(
      <Suspense fallback={<span hidden data-transcript-pending />} key={markdownParts.unstableKey}>
        {workerPipeline.current ? (
          <StreamingMarkdownBody
            text={markdownParts.unstableText}
            parseText={unstableParseText}
            parse={markdownParts.parseUnstable}
            sync
            fadeTimeline={fadeTimeline}
            fadeChunk={markdownParts.unstableKey}
            copyControl={CopyControl}
          />
        ) : (
          <StableMarkdownBody text={markdownParts.unstableText} />
        )}
      </Suspense>
    );
  }
  return <div className={`markdown ${streaming ? 'streaming' : ''}`}>{renderedChunks}</div>;
});

export function transcriptItemsEqual(previous: TranscriptItem | undefined, next: TranscriptItem | undefined): boolean {
  // Snapshot deltas preserve identity, avoiding retained value copies of large
  // tool outputs while still making every replacement a render boundary.
  return previous === next;
}

function messageMetadata(item: TranscriptItem) {
  const shortTime =
    typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0
      ? new Date(item.at).toLocaleTimeString(uiFormatLocale(), { timeStyle: 'short' })
      : '';
  return { shortTime };
}

function stripImageTokens(text: string): string {
  return text
    .replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

interface PastedTextChip {
  name: string;
  token: string;
  lines: number;
}

function extractPastedTextMarkers(text: string): { text: string; chips: PastedTextChip[] } {
  const chips: PastedTextChip[] = [];
  const stripped = String(text || '').replace(/ ?(\[Pasted text #\d+ \+(\d+) lines\]) ?/g, (_match, token, lines) => {
    chips.push({ name: `Pasted text · ${lines} lines`, token, lines: Number(lines) });
    return ' ';
  });
  if (chips.length === 0) return { text, chips };
  const cleaned = stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, chips };
}

/** Tweaks lines of a feedback message (`<mark> accent: #fff (was #000)`) come out of the text, to be drawn with an icon. */
function extractTweaksLines(text: string): { text: string; lines: string[] } {
  const lines: string[] = [];
  const kept: string[] = [];
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith(`${VISUALIZE_TWEAKS_MARK} `)) lines.push(line.slice(VISUALIZE_TWEAKS_MARK.length + 1).trim());
    else kept.push(line);
  }
  return lines.length ? { text: kept.join('\n').trim(), lines } : { text, lines };
}

interface ImageMarkerChip {
  name: string;
  dims: string;
  title: string;
  /** The `[Image: …]` line the chip comes from: restored rows name each
   *  image's stored original by it. */
  line?: string;
}

/** Each marker chip's stored original: the next unused `imageRefs` entry drawn
 *  by the chip's line. Chips with no such entry (omitted images, bare `#N`
 *  references) get none. */
function markerChipRefs(
  chips: readonly ImageMarkerChip[],
  refs: TranscriptItem['imageRefs']
): Array<string | undefined> {
  const pool = Array.isArray(refs) ? [...refs] : [];
  return chips.map((chip) => {
    const at = chip.line ? pool.findIndex((entry) => entry?.line === chip.line) : -1;
    return at < 0 ? undefined : pool.splice(at, 1)[0]?.ref;
  });
}

const inflightThumbnails = new Map<string, Promise<string | undefined>>();
const failedThumbnails = new Set<string>();

// A deleted session's attachments are gone with it: forget their misses.
onSessionPreviewsDeleted((session) => {
  const prefix = previewKey(session, '');
  for (const key of failedThumbnails) if (key.startsWith(prefix)) failedThumbnails.delete(key);
});

/** The cached thumbnail of a stored attachment; on a miss it is rebuilt from
 *  the stored original through the host (one host call per ref at a time). A
 *  ref the host has no picture for is not asked again in this run; a failed
 *  call (host unreachable) is retried on the next render that needs it. */
export function loadAttachmentThumbnail(
  session: string,
  ref: string,
  fit: (dataUrl: string) => Promise<string> = fitImageThumbnail
): Promise<string | undefined> {
  const key = previewKey(session, `attachment:${ref}`);
  const pending = inflightThumbnails.get(key);
  if (pending) return pending;
  const request = (async () => {
    const cached = await persistentImagePreviews.get(key).catch(() => undefined);
    if (cached) return cached;
    if (failedThumbnails.has(key)) return undefined;
    const read = window.mixdogDesktop?.readAttachmentThumbnail;
    if (!read) return undefined;
    let picture: string | null;
    try {
      picture = await read(ref);
    } catch {
      return undefined;
    }
    // A phone gets the original: fit it to thumbnail size before it is cached.
    const url = picture ? await fit(picture).catch(() => undefined) : undefined;
    if (!url) {
      failedThumbnails.add(key);
      return undefined;
    }
    await persistentImagePreviews.put(key, session, url).catch(() => undefined);
    return url;
  })().finally(() => inflightThumbnails.delete(key));
  inflightThumbnails.set(key, request);
  return request;
}

/** The thumbnail of a sent image, by its stored attachment ref. Loaded async;
 *  the card keeps its size meanwhile. */
function useStoredImagePreview(session: string, attachmentRef: string | undefined): string | undefined {
  const key = attachmentRef ? previewKey(session, `attachment:${attachmentRef}`) : '';
  const sync = key ? persistentImagePreviews.peek(key) : undefined;
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key || !attachmentRef) return;
    let active = true;
    void loadAttachmentThumbnail(session, attachmentRef).then((url) => {
      if (url && active) setLoaded({ key, url });
    });
    return () => {
      active = false;
    };
  }, [key, session, attachmentRef]);
  return sync ?? (loaded?.key === key ? loaded.url : undefined);
}

/** The host file behind a sent image: its store reference in this session. */
function storedAttachmentRef(session: string, ref: string | undefined): StoredAttachment | undefined {
  return session && ref && /^[a-f0-9]{64}$/.test(ref) ? { sessionId: session, id: ref } : undefined;
}

type SentAttachmentRecord = NonNullable<TranscriptItem['attachments']>[number];

/** The message-metadata attachment each file / pasted chip stands for: files
 *  by their name first, then pasted texts by name or, failing that, in order. */
function chipAttachments(
  records: TranscriptItem['attachments'],
  fileChips: readonly { name: string }[],
  pastedChips: readonly { name: string }[]
): { files: Array<SentAttachmentRecord | undefined>; pasted: Array<SentAttachmentRecord | undefined> } {
  const pool = Array.isArray(records) ? [...records] : [];
  const take = (match: (record: SentAttachmentRecord) => boolean) => {
    const at = pool.findIndex(match);
    return at < 0 ? undefined : pool.splice(at, 1)[0];
  };
  const files = fileChips.map((chip) => take((record) => record.name === chip.name && record.kind !== 'image'));
  const pasted = pastedChips.map(
    (chip) =>
      take((record) => record.name === chip.name && record.kind === 'text') ?? take((record) => record.kind === 'text')
  );
  return { files, pasted };
}

function SentImageCard({
  session,
  attachmentRef,
  live,
  name,
  dims,
  tooltip,
  menuProps,
}: {
  session: string;
  /** Reference of the stored original, from which the host rebuilds the thumbnail. */
  attachmentRef?: string;
  live?: string;
  name: string;
  dims?: string;
  tooltip?: string;
  menuProps: ReturnType<typeof useAttachmentContextMenu>['menuProps'];
}) {
  const stored = useStoredImagePreview(session, attachmentRef);
  const preview = live || stored;
  const openFile = useContext(MarkdownOpenFileContext);
  const hostFile = storedAttachmentRef(session, attachmentRef);
  return (
    <AttachmentCard
      kind="image"
      name={name}
      imageUrl={preview || undefined}
      tooltip={tooltip}
      meta={preview ? undefined : dims}
      menu={menuProps(
        preview
          ? { kind: 'image', name, dataUrl: preview, stored: hostFile }
          : { kind: 'image-marker', name, stored: hostFile }
      )}
      onOpen={
        preview
          ? () => openAttachmentSource({ kind: 'image', name, dataUrl: preview, stored: hostFile }, openFile)
          : undefined
      }
    />
  );
}

// Chip for an `[Image: …]` / `[Image source: …]` metadata line: the file name
// from its source path and its dimensions.
function imageMetaChip(meta: string, line: string): ImageMarkerChip {
  // A visualize pin's crop (`[Image: visualize pin N · label, WxH]`): named
  // like its composer card (number · label; history written before the emoji went still reads this way). Restored history has no crop thumbnail to show.
  const pin = /^visualize pin (\d+) · (.+), (\d+)x(\d+)$/.exec(meta);
  if (pin) return { name: `${pin[1]} · ${pin[2]}`, dims: `${pin[3]}\u00D7${pin[4]}`, title: line, line };
  const parts = meta.split(/,\s*/);
  const source =
    (parts.find((part) => part.startsWith('source: ')) || '').slice(8).trim() ||
    (line.startsWith('[Image source:') ? meta.trim() : '');
  const dims = parts.find((part) => /^\d+x\d+$/.test(part)) || '';
  const name = source
    ? source
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || 'Image'
    : 'Image';
  return { name, dims: dims.replace('x', '\u00D7'), title: source || line, line };
}

function extractImageMarkers(text: string): { text: string; chips: ImageMarkerChip[] } {
  const chips: ImageMarkerChip[] = [];
  const kept: string[] = [];
  let pendingRefs = 0;
  let lastWasMeta = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[Image #\d+(?::[^\]]*)?\]$/.test(line)) {
      pendingRefs += 1;
      lastWasMeta = false;
      continue;
    }
    const meta = /^\[Image(?::| source:) ([^\]]+)\]$/.exec(line);
    if (meta && !/^omitted\b/i.test(meta[1])) {
      chips.push(imageMetaChip(meta[1], line));
      if (pendingRefs > 0) pendingRefs -= 1;
      lastWasMeta = true;
      continue;
    }
    if (/^\[Image omitted from stored history[^\]]*\]$/.test(line)) {
      if (!lastWasMeta) {
        chips.push({ name: 'Image', dims: '', title: line });
        if (pendingRefs > 0) pendingRefs -= 1;
      }
      lastWasMeta = false;
      continue;
    }
    lastWasMeta = false;
    const inlineRefs = rawLine.match(/\[Image #\d+(?::[^\]]*)?\]/g);
    if (inlineRefs && inlineRefs.length > 0) {
      pendingRefs += inlineRefs.length;
      const strippedLine = stripImageTokens(rawLine);
      if (strippedLine) kept.push(strippedLine);
      continue;
    }
    kept.push(rawLine);
  }
  for (let index = 0; index < pendingRefs; index += 1) {
    chips.push({ name: t('Image'), dims: '', title: t('Attached image') });
  }
  return { text: kept.join('\n').trim(), chips };
}

const WEBHOOK_FENCE_RE =
  /(?:The block between the WEBHOOK_UNTRUSTED_DATA markers[^\n]*\n+)?<<<WEBHOOK_UNTRUSTED_DATA_BEGIN>>>\n?([\s\S]*?)\n?<<<WEBHOOK_UNTRUSTED_DATA_END>>>/;

function extractWebhookPayload(text: string): { text: string; payload: string } {
  const match = WEBHOOK_FENCE_RE.exec(text);
  if (!match) return { text, payload: '' };
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, payload: (match[1] || '').trim() };
}

function userTranscriptDisplayText(item: TranscriptItem): string {
  return stripInjectedDisplayText(stripSessionEnvelope(String(item.text || '')))
    .replace(/[ \t]+\r?\n/g, '\n')
    .replace(/\r?\n{3,}/g, '\n\n')
    .trim();
}

export function isVisibleTranscriptItem(item: TranscriptItem | undefined): boolean {
  if (!item) return false;
  if (item.kind === 'tool') {
    const members = Array.isArray(item.toolMembers) ? item.toolMembers : [];
    const hiddenAggregate =
      item.aggregate === true && members.length > 0 && members.every((member) => isTranscriptHiddenToolItem(member));
    return !isTranscriptHiddenToolItem(item) && !hiddenAggregate && !shouldSuppressFullyFailedToolItem(item);
  }
  if (item.kind === 'statusdone' || item.kind === 'turndone' || item.kind === 'notice') return true;
  if (item.kind === 'assistant') return true;
  if (item.kind !== 'user') return false;
  const metadataRecord =
    item.metadata && typeof item.metadata === 'object' ? (item.metadata as Record<string, unknown>) : null;
  const sourceText = String(item.text || '');
  const text = userTranscriptDisplayText(item);
  return !(
    (Boolean(sourceText.trim()) && !text && !(Array.isArray(item.images) && item.images.length > 0)) ||
    /^(?:system|developer|synthetic|internal|hidden)$/i.test(String(item.role || item.kind || '')) ||
    item.internal === true ||
    item.hidden === true ||
    item.synthetic === true ||
    metadataRecord?.internal === true ||
    metadataRecord?.hidden === true ||
    metadataRecord?.synthetic === true ||
    // TUI parity: the loose completion-wrapper shape hides RUNTIME-injected
    // rows only. A prompt the user typed or pasted stays visible.
    isInternalTranscriptDisplayText(text, { lenientWrapper: false })
  );
}

// Attribution badge above a user-role bubble. Only a Lead-authored brief in an
// Agent session earns a visible badge: in the user's own conversation a USER
// label is pure noise above a bubble that already reads as theirs. The `sender`
// metadata stays intact for every message — this is a display rule only.
export function transcriptSourceLabel(item: TranscriptItem): string {
  if (item.kind !== 'user') return '';
  return String(item.sender || '').toLowerCase() === 'lead' ? 'LEAD' : '';
}

/** Whether the conversation was used from more than one device. Only then does
 *  a prompt row say which device sent it. */
export const TranscriptDevicesContext = createContext(false);

/** The name of the device viewing the transcript (null while unknown). A prompt
 *  sent from this device is never labelled "from <this device>". */
export const TranscriptViewerDeviceContext = createContext<string | null>('');

/** The cards above a sent prompt: its images, pasted text and files. */
function SentAttachments({
  item,
  session,
  images,
  markerChips,
  pastedChips,
  fileChips,
  menuProps,
}: {
  item: TranscriptItem;
  session: string;
  images: NonNullable<TranscriptItem['images']>;
  markerChips: readonly ImageMarkerChip[];
  pastedChips: readonly PastedTextChip[];
  fileChips: ReturnType<typeof extractFileMarkers>['chips'];
  menuProps: ReturnType<typeof useAttachmentContextMenu>['menuProps'];
}) {
  const markerRefs = markerChipRefs(markerChips, item.imageRefs);
  const records = chipAttachments(item.attachments, fileChips, pastedChips);
  const hostFileOf = (record: SentAttachmentRecord | undefined) => storedAttachmentRef(session, record?.id);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and min-width into the card row.
    <div className="message-attachments" role="group" aria-label={t('Attachments')}>
      {images.map((image, index) => {
        const preview = imagePreviewCache.peek(
          imagePreviewKey(submissionIdentity(String(item.id ?? '')), image.id, image.bytes)
        );
        const name = image.name || t('Attached image');
        return (
          <SentImageCard
            // biome-ignore lint/suspicious/noArrayIndexKey: a sent message's attachments never reorder; the index separates images without an id.
            key={`${image.id ?? 'img'}-${index}`}
            session={session}
            attachmentRef={image.attachmentRef}
            live={preview || undefined}
            name={preview ? name : image.name || 'Image'}
            menuProps={menuProps}
          />
        );
      })}
      {markerChips.map((chip, index) => (
        <SentImageCard
          // biome-ignore lint/suspicious/noArrayIndexKey: chips are parsed from a sent message and never reorder.
          key={`marker-${index}`}
          session={session}
          attachmentRef={markerRefs[index]}
          name={chip.name}
          tooltip={chip.title}
          dims={chip.dims}
          menuProps={menuProps}
        />
      ))}
      {pastedChips.map((chip, index) => {
        const stored = sentPastedTextSource(chip.token, chip.name, item.id);
        const hostFile = hostFileOf(records.pasted[index]);
        return (
          <AttachmentCard
            // biome-ignore lint/suspicious/noArrayIndexKey: chips are parsed from a sent message and never reorder.
            key={`pasted-${index}`}
            kind="pasted"
            name={chip.name}
            content={stored.kind === 'pasted-text' ? stored.text : undefined}
            meta={t('{{count}} lines', { count: chip.lines })}
            menu={menuProps(() => ({ ...sentPastedTextSource(chip.token, chip.name, item.id), stored: hostFile }))}
          />
        );
      })}
      {fileChips.map((chip, index) => {
        const kind = fileChipKind(chip);
        const stored = sentFileSource(chip, item.id);
        const hostFile = hostFileOf(records.files[index]);
        let meta = '';
        let content: string | undefined;
        if (stored.kind === 'text-file' && stored.text !== undefined) {
          content = stored.text;
          meta = composerCardMeta({ kind: 'text', data: stored.text });
        } else if ((stored.kind === 'pdf' || stored.kind === 'office') && stored.dataUrl) {
          content = stored.dataUrl.split(',')[1] || '';
          meta = composerCardMeta({ kind: stored.kind, data: content });
        }
        return (
          <AttachmentCard
            // biome-ignore lint/suspicious/noArrayIndexKey: chips are parsed from a sent message and never reorder.
            key={`file-${index}`}
            kind={kind === 'text-file' ? 'text' : kind}
            name={chip.name}
            content={content}
            meta={meta}
            menu={menuProps(() => ({ ...sentFileSource(chip, item.id), stored: hostFile }))}
          />
        );
      })}
    </div>
  );
}

export const TranscriptRow = memo(
  function TranscriptRow({
    item,
    completion,
    animateComplete = false,
    completionActivityKey = '',
    backgroundWork,
    attachedUser = false,
    disclosureScope = '',
    paceKey = '',
    pace = false,
  }: {
    /** Background work still running; passed only to the latest completion. */
    backgroundWork?: BackgroundWorkCounts;
    /** Row key of a live assistant part; its painted text is paced. */
    paceKey?: string;
    /** The part is still the newest content row of its turn. */
    pace?: boolean;
    item: TranscriptItem;
    completion?: TranscriptItem;
    animateComplete?: boolean;
    completionActivityKey?: string;
    attachedUser?: boolean;
    disclosureScope?: string;
  }) {
    const multiDevice = useContext(TranscriptDevicesContext);
    const viewerDevice = useContext(TranscriptViewerDeviceContext);
    const sessionScope = useContext(MarkdownSessionContext);
    const assistant = item.kind === 'assistant';
    const articleRef = useRef<HTMLElement>(null);
    // Commentary (the provider's phase, or a part of unknown phase that has
    // not turned into a final answer) shows as it arrives; a final answer is
    // paced. Either fades for as long as its rate allows (fadeMs), and a
    // completed reply keeps streaming markdown while its backlog drains.
    const paced = usePacedTranscriptText({
      key: assistant ? paceKey : '',
      scope: sessionScope,
      element: articleRef,
      text: assistant ? String(item.text || '') : '',
      streaming: Boolean(item.streaming),
      pace: Boolean(pace),
      phase: assistant && typeof item.phase === 'string' ? item.phase : undefined,
    });
    const streaming = Boolean(item.streaming);
    const previousStreaming = useRef(streaming);
    const announceSettled = previousStreaming.current && !streaming;
    useEffect(() => {
      previousStreaming.current = streaming;
    }, [streaming]);
    const { menuProps, menuElement } = useAttachmentContextMenu(useContext(MarkdownOpenFileContext));
    if (item.kind === 'tool') {
      if (shouldSuppressFullyFailedToolItem(item)) return null;
      return <ToolCard item={item} disclosureScope={disclosureScope} />;
    }
    if (item.kind === 'statusdone' || item.kind === 'turndone') {
      return <CompletionStatus item={item} backgroundWork={backgroundWork} />;
    }
    if (item.kind === 'notice') {
      const tone = item.tone === 'error' || item.tone === 'warn' ? item.tone : '';
      return (
        <div className={`notice ${tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
          {item.text === 'The model refused to respond (safety refusal) — retry or rephrase your prompt.'
            ? t('The model refused to respond (safety refusal) — retry or rephrase your prompt.')
            : item.text}
        </div>
      );
    }
    if (item.kind !== 'user' && item.kind !== 'assistant') return null;
    const user = item.kind === 'user';
    const sourceLabel = transcriptSourceLabel(item);
    const text = user ? userTranscriptDisplayText(item) : String(item.text || '');
    if (user && isTranscriptCancelledStatusText(text)) {
      return <CompletionStatus item={{ kind: 'turndone', status: 'cancelled', elapsedMs: 0 } as TranscriptItem} />;
    }
    if (!isVisibleTranscriptItem(item)) return null;
    const gitRequest = user ? parseIslandGitRequestText(text) : null;
    if (gitRequest) {
      const RequestIcon =
        gitRequest.action === 'pr'
          ? GitPullRequest
          : gitRequest.action === 'commit-push'
            ? Upload
            : GitCommitHorizontal;
      return (
        <article ref={articleRef} className={`message user ${item.pending ? 'pending' : ''}`}>
          <div className="message-body island-git-request">
            <RequestIcon size={15} aria-hidden="true" />
            <b>{gitRequest.label}</b>
            {gitRequest.meta ? <span className="island-git-request-meta">{gitRequest.meta}</span> : null}
          </div>
        </article>
      );
    }
    const showFooter = !user && !streaming && Boolean(completion);
    // Only the footer shows the time. Formatting it per render cost the live
    // row a locale lookup on every paced frame.
    const metadata = showFooter ? messageMetadata(item) : null;
    const attachedImages = user && Array.isArray(item.images) ? item.images : [];
    const imageMarkers = user ? extractImageMarkers(text) : { text, chips: [] };
    const markerChips = attachedImages.length > 0 ? [] : imageMarkers.chips;
    const userDisplayText = attachedImages.length > 0 ? stripImageTokens(imageMarkers.text) : imageMarkers.text;
    const pastedFold = user
      ? extractPastedTextMarkers(userDisplayText)
      : { text: userDisplayText, chips: [] as PastedTextChip[] };
    const fileFold = user ? extractFileMarkers(pastedFold.text) : { text: pastedFold.text, chips: [] };
    const webhookFold = user ? extractWebhookPayload(fileFold.text) : { text: fileFold.text, payload: '' };
    const tweaksFold = user ? extractTweaksLines(webhookFold.text) : { text: webhookFold.text, lines: [] as string[] };
    // The runtime reports which `$name` mentions it applied; only those are
    // marked, so `$HOME` or a skill that was off stays prose.
    const appliedSkills = user ? appliedSkillsOf(item) : [];
    return (
      <>
        <article
          ref={articleRef}
          className={`message ${user ? 'user' : 'assistant'} ${sourceLabel ? 'sourced-message' : ''} ${streaming ? 'streaming' : 'settled'} ${item.pending ? 'pending' : ''} ${user && attachedUser ? 'attached-user' : ''}`}
          aria-live={streaming || announceSettled ? 'off' : undefined}
          aria-busy={item.pending === true ? 'true' : undefined}
        >
          {sourceLabel && <small className="message-source">{sourceLabel}</small>}
          {user &&
            (attachedImages.length > 0 ||
              markerChips.length > 0 ||
              pastedFold.chips.length > 0 ||
              fileFold.chips.length > 0) && (
              <SentAttachments
                item={item}
                session={sessionScope}
                images={attachedImages}
                markerChips={markerChips}
                pastedChips={pastedFold.chips}
                fileChips={fileFold.chips}
                menuProps={menuProps}
              />
            )}
          {menuElement}
          {(!user || tweaksFold.text || tweaksFold.lines.length > 0) && (
            // biome-ignore lint/a11y/noStaticElementInteractions: only suppresses native drag; the body is not an interactive control.
            <div className="message-body" onDragStart={(event) => event.preventDefault()}>
              {user && tweaksFold.text ? (
                <p>
                  <SkillMentionText text={tweaksFold.text} isSkill={(name) => appliedSkills.includes(name)} />
                </p>
              ) : null}
              {tweaksFold.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are parsed from a sent message and never reorder.
                <p key={`tweaks-${index}`} className="message-tweaks-line">
                  <SlidersHorizontal size={12} aria-hidden="true" /> {line}
                </p>
              ))}
              {!user && (
                // Only a settled reply's links can be downloaded by its row id.
                <MarkdownTranscriptItemContext.Provider value={streaming ? '' : String(item.id ?? '')}>
                  <MarkdownResponse
                    text={paced.text}
                    streaming={streaming || paced.draining}
                    fadeKey={paceKey}
                    fadeMs={paced.fadeMs}
                  />
                </MarkdownTranscriptItemContext.Provider>
              )}
            </div>
          )}
          {user && <AppliedSkills names={appliedSkills} />}
          {user && multiDevice && isOtherDevice(item.device, viewerDevice) && (
            <small className="message-device">{t('from {{device}}', { device: item.device })}</small>
          )}
          {showFooter && completion && (
            // biome-ignore lint/a11y/useSemanticElements: the footer names a group of response details; a <fieldset> would restyle it.
            <footer className="response-footer" role="group" aria-label={t('Response details')}>
              <CompletionStatus
                item={completion}
                animateComplete={animateComplete}
                completionActivityKey={completionActivityKey}
                backgroundWork={backgroundWork}
              />
              {metadata?.shortTime && <time className="message-time">{metadata.shortTime}</time>}
              {text && <CopyControl value={text} label="Copy response" className="message-actions response-copy" />}
            </footer>
          )}
        </article>
        {announceSettled && !completion && (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {t('Mixdog response complete.')}
          </p>
        )}
      </>
    );
  },
  (previous, next) =>
    transcriptItemsEqual(previous.item, next.item) &&
    transcriptItemsEqual(previous.completion, next.completion) &&
    previous.animateComplete === next.animateComplete &&
    previous.completionActivityKey === next.completionActivityKey &&
    previous.backgroundWork?.shell === next.backgroundWork?.shell &&
    previous.backgroundWork?.agent === next.backgroundWork?.agent &&
    previous.attachedUser === next.attachedUser &&
    previous.paceKey === next.paceKey &&
    previous.pace === next.pace &&
    previous.disclosureScope === next.disclosureScope
);
