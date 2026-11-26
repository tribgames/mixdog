import { ChevronDown, GitCommitHorizontal, GitPullRequest, SlidersHorizontal, Upload } from 'lucide-react';
import { parseIslandGitRequestText } from './island-git-request';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAttachmentContextMenu } from './attachment-context-menu';
import { MarkdownOpenFileContext, MarkdownSessionContext, MarkdownTranscriptItemContext } from './MarkdownLink';
import type { TranscriptItem } from './desktop-types';
import { isOtherDevice } from '../shared/session-devices';
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';
import { useRoomContacts } from './agent-room-parts';
import { stripAgentMessageEnvelope } from '../shared/core-src/runtime/shared/agent-message-envelope.mjs';
import { localizeHeartbeatBreakerNotice, localizeRouteFallbackNotice } from './error-notice-copy';
import MarkdownBody from './MarkdownBody';
import { MarkdownResponse } from './MarkdownResponse';
import type { MarkdownAstRoot } from './markdown-ast';
import {
  canSyncParseMarkdown,
  parseStreamingMarkdownAst,
  preloadSyncMarkdownParser,
  readCachedStreamingMarkdownAst,
  subscribeSyncMarkdownParser,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParserLoad,
} from './markdown-worker-client';
import { CopyControl } from './transcript-primitives';
import { useTranscriptTextReveal } from './use-transcript-text-reveal';
import { type BackgroundWorkCounts, CompletionStatus, ModelSwitchDivider } from './transcript-status';
import { shouldSuppressFullyFailedToolItem } from './transcript-tool-model';
import { ToolCard } from './transcript-tool-ui';
import { SteerStatus } from './transcript-steer-status';
import { AppliedSkills, SkillMentionText, appliedSkillsOf } from './composer-skill-mentions';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText, isProcessRestartStatusText, isTranscriptCancelledStatusText } from '../../../../packages/protocol-client/src/shared/tool-execution-contract.mjs';
import { isTranscriptHiddenToolRow } from '../../../../packages/protocol-client/src/rows.ts';
import { stripInjectedDisplayText, stripSessionEnvelope } from '../shared/session-title.mjs';
import { routineNoticeText } from './routine-notice';
import { RoomAddressChip, RoomTranscriptRow } from './agent-room-transcript';
import { HeldRequestCard } from './ApprovalCard';
import { AgentTaskLine } from './agent-task-line';
import { MessageReactions, messageReactionsOf } from './message-reactions';
import { asRecord } from './text-format';

export { routineNoticeText };
export { loadAttachmentThumbnail, ReturnedAttachments } from './transcript-attachments';
import {
  extractEscapedFileMarkers,
  extractImageMarkers,
  extractPastedTextMarkers,
  extractTweaksLines,
  ReturnedAttachments,
  SentAttachments,
  splitInlinePastes,
  stripImagePlaceholders,
  stripImageTokens,
  useSentPastedTexts,
} from './transcript-attachments';

// StreamingMarkdownBody already loads the same renderer in this module.
// Wrapping history in React.lazy suspended even after preloading completed,
// holding the first transcript behind React's fallback reveal throttle.
export { MarkdownBody };

const SENT_PASTE_PREVIEW_LINES = 20;

/** A sent paste inline; past 20 lines only the first 20 are rendered until expanded. */
function SentPasteBlock({ text }: { text?: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const full = text ?? '';
  const lines = full.split('\n');
  const long = lines.length > SENT_PASTE_PREVIEW_LINES;
  const collapsed = long && !expanded;
  return (
    <>
      <p id={id} className={collapsed ? 'message-pasted-text message-pasted-text-collapsed' : 'message-pasted-text'}>
        {collapsed ? lines.slice(0, SENT_PASTE_PREVIEW_LINES).join('\n') : full}
      </p>
      {long && (
        <button
          type="button"
          className="message-pasted-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? 'Show less' : 'Show more')}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

export function transcriptItemsEqual(previous: TranscriptItem | undefined, next: TranscriptItem | undefined): boolean {
  // Snapshot deltas preserve identity, avoiding retained value copies of large
  // tool outputs while still making every replacement a render boundary.
  return previous === next;
}

// toLocaleTimeString builds a new Intl formatter on every call; footers mount
// on every range change of a fling, so one formatter per locale + options.
let shortTimeFormat: { key: string; format: Intl.DateTimeFormat } | null = null;

function shortTimeText(at: number): string {
  const locale = uiFormatLocale();
  const options: Intl.DateTimeFormatOptions = { timeStyle: 'short', ...timeFormatOptions() };
  const key = `${locale}|${JSON.stringify(options)}`;
  if (shortTimeFormat?.key !== key) shortTimeFormat = { key, format: new Intl.DateTimeFormat(locale, options) };
  return shortTimeFormat.format.format(at);
}

/** The note under a sent message that lost the full-size original of some images (`originalImagesMissing`, the count the core
 *  recorded on the message itself): the same sentence on every reload and device, in the reader's language. Null when the
 *  message lost none. */
export function originalImagesMissingText(count: unknown): string | null {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
  return count === 1
    ? t('The full-size original of an image could not be found, so it was sent at its smaller size.')
    : t('The full-size originals of {{count}} images could not be found, so they were sent at their smaller size.', {
        count,
      });
}

/** A runtime notice in the reader's language: the fixed notices by their
 *  English text, the heartbeat's breaker warning by its
 *  pattern, anything else as sent. */
function noticeText(text: string | undefined) {
  if (text === 'The model refused to respond (safety refusal) — retry or rephrase your prompt.') {
    return t('The model refused to respond (safety refusal) — retry or rephrase your prompt.');
  }
  if (text === 'Allowed this once. The setting could not be saved.') {
    return t('Allowed this once. The setting could not be saved.');
  }
  const value = String(text || '');
  return localizeHeartbeatBreakerNotice(value) ?? text;
}

function gitRequestIcon(action: string) {
  if (action === 'pr') return GitPullRequest;
  if (action === 'commit-push') return Upload;
  return GitCommitHorizontal;
}

function messageMetadata(item: TranscriptItem) {
  const shortTime =
    typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 ? shortTimeText(item.at) : '';
  return { shortTime };
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
  // A bot's message shows what it said, not the envelope it travelled in.
  const said = item.fromAgent ? stripAgentMessageEnvelope(item.text) : String(item.text || '');
  return stripInjectedDisplayText(stripSessionEnvelope(said))
    .replace(/[ \t]+\r?\n/g, '\n')
    .replace(/\r?\n{3,}/g, '\n\n')
    .trim();
}

export function isVisibleTranscriptItem(item: TranscriptItem | undefined): boolean {
  if (!item) return false;
  let visible = visibleItems.get(item);
  if (visible === undefined) {
    visible = readsVisible(item);
    visibleItems.set(item, visible);
  }
  return visible;
}

/** Whether an item has a row, by the item: read once (an item does not change; a changed row is another object). */
const visibleItems = new WeakMap<TranscriptItem, boolean>();

function readsVisible(item: TranscriptItem): boolean {
  if (item.kind === 'tool') {
    const members = Array.isArray(item.toolMembers) ? item.toolMembers : [];
    const hiddenAggregate =
      item.aggregate === true && members.length > 0 && members.every((member) => isTranscriptHiddenToolRow(member));
    return !isTranscriptHiddenToolRow(item) && !hiddenAggregate && !shouldSuppressFullyFailedToolItem(item);
  }
  if (item.kind === 'statusdone' || item.kind === 'turndone' || item.kind === 'notice') return true;
  // A reply of only whitespace has no row after a reload either.
  if (item.kind === 'assistant') return Boolean(String(item.text ?? '').trim());
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

export function transcriptSourceLabel(item: TranscriptItem): string {
  if (item.kind !== 'user' || item.fromAgent) return '';
  return String(item.sender || '').toLowerCase() === 'lead' ? 'LEAD' : '';
}

/** The name of the bot that sent a user-kind row (trusted romAgent metadata), where a
 *  lead's brief would read LEAD. */
function BotSourceLabel({ agentId }: { agentId: string }) {
  const { label } = useRoomContacts(true);
  return <small className="message-source">{label(agentId).name}</small>;
}

/** Whether the conversation was used from more than one device. Only then does
 *  a prompt row say which device sent it. */
export const TranscriptDevicesContext = createContext(false);

/** The name of the device viewing the transcript (null while unknown). A prompt
 *  sent from this device is never labelled "from <this device>". */
export const TranscriptViewerDeviceContext = createContext<string | null>('');

const streamingRowCounts = new Map<string, number>();
const streamingRowListeners = new Map<string, Set<() => void>>();

function notifyRowStreaming(key: string): void {
  for (const listener of [...(streamingRowListeners.get(key) ?? [])]) listener();
}

export function subscribeRowStreaming(key: string, listener: () => void): () => void {
  if (!key) return () => {};
  let bucket = streamingRowListeners.get(key);
  if (!bucket) {
    bucket = new Set();
    streamingRowListeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0 && streamingRowListeners.get(key) === bucket) streamingRowListeners.delete(key);
  };
}

export function isRowVisuallyStreaming(key: string): boolean {
  return Boolean(key && (streamingRowCounts.get(key) ?? 0) > 0);
}

/** Whether a settled reply carries a response footer (status line + copy). */
export function showsResponseFooter(item: TranscriptItem, completion?: TranscriptItem): boolean {
  return item.kind === 'assistant' && !item.streaming && Boolean(completion) && isVisibleTranscriptItem(item);
}

/** The response footer: the turn's status line, time and copy control. One
 *  element for waiting and complete alike, so the swap never remounts it. */
export function TranscriptResponseFooter({
  item,
  completion,
  animateComplete,
  completionActivityKey,
  backgroundWork,
  trailing = false,
  revealKey = '',
}: {
  item: TranscriptItem;
  completion: TranscriptItem;
  animateComplete?: boolean;
  completionActivityKey?: string;
  backgroundWork?: BackgroundWorkCounts;
  /** Rendered after the turn's cards rather than inside the message. */
  trailing?: boolean;
  /** Row reveal key of the closing assistant part so a trailing footer waits
   *  until paced text drain / final parse finishes before showing Completed. */
  revealKey?: string;
}) {
  const subscribe = useCallback(
    (listener: () => void) => (trailing && revealKey ? subscribeRowStreaming(revealKey, listener) : () => {}),
    [trailing, revealKey]
  );
  const getStreaming = useCallback(
    () => (trailing && revealKey ? isRowVisuallyStreaming(revealKey) : false),
    [trailing, revealKey]
  );
  const rowStreaming = useSyncExternalStore(subscribe, getStreaming, () => false);
  if (rowStreaming) return null;
  // Only the footer shows the time. Formatting it per render cost the live
  // row a locale lookup on every streamed commit.
  const metadata = messageMetadata(item);
  const text = String(item.text || '');
  return (
    // biome-ignore lint/a11y/useSemanticElements: the footer names a group of response details; a <fieldset> would restyle it.
    <footer
      className={trailing ? 'response-footer response-footer-trailing' : 'response-footer'}
      role="group"
      aria-label={t('Response details')}
    >
      <CompletionStatus
        item={completion}
        animateComplete={animateComplete}
        completionActivityKey={completionActivityKey}
        backgroundWork={backgroundWork}
      />
      {metadata?.shortTime && <time className="message-time">{metadata.shortTime}</time>}
      {text && <CopyControl value={text} label="Copy response" className="message-actions response-copy" />}
    </footer>
  );
}

function NoticeRow({ item, sessionId }: { item: TranscriptItem; sessionId: string }) {
  if (item.room) {
    return (
      <>
        <RoomTranscriptRow item={item} />
        {/* The files a member's turn produced, under its speech. */}
        {item.room.kind === 'speech' ? <ReturnedAttachments records={item.attachments} /> : null}
      </>
    );
  }
  // A held request of an unattended run waits as an approval card.
  const held = asRecord(item.heldRequest);
  if (held?.status === 'pending') return <HeldRequestCard held={held} sessionId={sessionId} />;
  const task = asRecord(item.routine);
  // A task report's files stay in its session: the card says how many.
  if (task?.kind === 'task') return <AgentTaskLine routine={task} />;
  const tone = item.tone === 'error' || item.tone === 'warn' ? item.tone : '';
  const routine = routineNoticeText(item.routine);
  const fallback = routine == null ? localizeRouteFallbackNotice(item.text ?? '') : null;
  if (fallback) return <ModelSwitchDivider label={fallback} />;
  return (
    <div className={`notice ${tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
      {routine ?? noticeText(item.text)}
    </div>
  );
}

function useRowStreaming(item: TranscriptItem, revealKey: string, paced: boolean) {
  const assistant = item.kind === 'assistant';
  const rawText = assistant ? String(item.text || '') : '';
  const streamedHere = useRef(false);
  const lastStreamingText = useRef('');
  const cachedFinal = useRef<{ text: string; root: MarkdownAstRoot } | null>(null);
  if (assistant && item.streaming) {
    streamedHere.current = true;
    lastStreamingText.current = rawText;
    cachedFinal.current = null;
  }
  const parserLoad = useSyncExternalStore(subscribeSyncMarkdownParser, syncMarkdownParserLoad, syncMarkdownParserLoad);
  const ending = streamedHere.current && !item.streaming;
  if (ending && typeof parserLoad === 'object') throw parserLoad.error;
  const [resolvedFinal, setResolvedFinal] = useState<{ text: string; root: MarkdownAstRoot } | null>(null);
  const waitingForParser = ending && parserLoad !== 'ready';
  let knownFinalRoot: MarkdownAstRoot | null = null;
  if (ending && parserLoad === 'ready' && rawText) {
    if (resolvedFinal?.text === rawText) knownFinalRoot = resolvedFinal.root;
    else if (cachedFinal.current?.text === rawText) knownFinalRoot = cachedFinal.current.root;
    else knownFinalRoot = readCachedStreamingMarkdownAst(rawText);
  }
  // Long or math-bearing endings parse off-thread before leaving streaming so
  // the tail and settlement commit together.
  const waitingForFinalParse =
    ending &&
    parserLoad === 'ready' &&
    Boolean(rawText) &&
    !knownFinalRoot &&
    (rawText.length > SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS || !canSyncParseMarkdown(rawText));
  const holdPreEndText = waitingForParser || waitingForFinalParse;
  const revealStreaming = Boolean(item.streaming) || holdPreEndText;
  useEffect(() => {
    if (waitingForParser) void preloadSyncMarkdownParser();
  }, [waitingForParser]);
  useEffect(() => {
    if (!waitingForFinalParse) return undefined;
    let active = true;
    void parseStreamingMarkdownAst(rawText).then((root) => {
      if (active) setResolvedFinal({ text: rawText, root });
    });
    return () => {
      active = false;
    };
  }, [waitingForFinalParse, rawText]);
  const revealed = useTranscriptTextReveal({
    key: assistant ? revealKey : '',
    text: holdPreEndText ? lastStreamingText.current : rawText,
    streaming: revealStreaming,
    paced,
  });
  const streaming = revealStreaming || revealed.draining;
  // Once settled, end the streaming-to-settled handoff so later AST cache
  // reclaim + rerender cannot revert the row to stale `lastStreamingText`.
  useLayoutEffect(() => {
    if (!assistant) return;
    if (!streaming) {
      streamedHere.current = false;
      lastStreamingText.current = '';
      cachedFinal.current = null;
    } else if (ending && knownFinalRoot) {
      cachedFinal.current = { text: rawText, root: knownFinalRoot };
    }
  }, [assistant, streaming, ending, knownFinalRoot, rawText]);
  const visualStreaming = assistant && Boolean(revealKey) && streaming;
  useLayoutEffect(() => {
    if (!visualStreaming) return undefined;
    const prior = streamingRowCounts.get(revealKey) ?? 0;
    streamingRowCounts.set(revealKey, prior + 1);
    if (prior === 0) notifyRowStreaming(revealKey);
    return () => {
      const next = (streamingRowCounts.get(revealKey) ?? 0) - 1;
      if (next > 0) {
        streamingRowCounts.set(revealKey, next);
      } else {
        streamingRowCounts.delete(revealKey);
        notifyRowStreaming(revealKey);
      }
    };
  }, [visualStreaming, revealKey]);
  const finalRoot = !streaming && knownFinalRoot && revealed.text === rawText ? knownFinalRoot : null;
  const previousStreaming = useRef(streaming);
  const announceSettled = previousStreaming.current && !streaming;
  useEffect(() => {
    previousStreaming.current = streaming;
  }, [streaming]);
  return { streaming, revealed, finalRoot, announceSettled };
}

function foldUserContent(item: TranscriptItem, text: string, pastedTexts: readonly (string | undefined)[]) {
  const attachedImages = Array.isArray(item.images) ? item.images : [];
  const imageMarkers = extractImageMarkers(text);
  const markerChips = attachedImages.length > 0 ? [] : imageMarkers.chips;
  const userDisplayText =
    attachedImages.length > 0 ? stripImagePlaceholders(stripImageTokens(imageMarkers.text)) : imageMarkers.text;
  const pastedFold = extractPastedTextMarkers(userDisplayText, pastedTexts);
  const fileFold = extractEscapedFileMarkers(pastedFold.text);
  const tweaksFold = extractTweaksLines(extractWebhookPayload(fileFold.text).text);
  return { attachedImages, markerChips, pastedFold, fileFold, tweaksFold };
}

const NO_USER_FOLD: ReturnType<typeof foldUserContent> = {
  attachedImages: [],
  markerChips: [],
  pastedFold: { text: '', chips: [] },
  fileFold: { text: '', chips: [] },
  tweaksFold: { text: '', lines: [] },
};

export const TranscriptRow = memo(
  function TranscriptRow({
    item,
    completion,
    animateComplete = false,
    completionActivityKey = '',
    backgroundWork,
    attachedUser = false,
    disclosureScope = '',
    revealKey = '',
    paced = false,
    footerAfterCards = false,
  }: {
    /** The turn's cards follow this row: its response footer is rendered by the
     *  caller after them (TranscriptResponseFooter), not inside the message. */
    footerAfterCards?: boolean;
    /** Background work still running; passed only to the latest completion. */
    backgroundWork?: BackgroundWorkCounts;
    /** Row key of an assistant part: its reveal identity. */
    revealKey?: string;
    /** The coding transcript: a live part reveals in paced steps; elsewhere
     *  received text shows whole. */
    paced?: boolean;
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
    const { texts: pastedTexts, records: pastedTokenRecords } = useSentPastedTexts(item, sessionScope);
    const { streaming, revealed, finalRoot, announceSettled } = useRowStreaming(item, revealKey, paced);
    const { menuProps, menuElement } = useAttachmentContextMenu(useContext(MarkdownOpenFileContext));
    if (item.kind === 'tool') {
      if (shouldSuppressFullyFailedToolItem(item)) return null;
      return <ToolCard item={item} disclosureScope={disclosureScope} />;
    }
    if (item.kind === 'statusdone' || item.kind === 'turndone') {
      return <CompletionStatus item={item} backgroundWork={backgroundWork} />;
    }
    if (item.kind === 'notice') return <NoticeRow item={item} sessionId={sessionScope} />;
    if (item.kind !== 'user' && item.kind !== 'assistant') return null;
    const user = item.kind === 'user';
    const sourceLabel = transcriptSourceLabel(item);
    const text = user ? userTranscriptDisplayText(item) : String(item.text || '');
    if (user && isTranscriptCancelledStatusText(text)) {
      const cause = isProcessRestartStatusText(text) ? 'restart' : undefined;
      return (
        <CompletionStatus item={{ kind: 'turndone', status: 'cancelled', cause, elapsedMs: 0 } as TranscriptItem} />
      );
    }
    if (!isVisibleTranscriptItem(item)) return null;
    const gitRequest = user ? parseIslandGitRequestText(text) : null;
    if (gitRequest) {
      const RequestIcon = gitRequestIcon(gitRequest.action);
      return (
        <article className={`message user ${item.pending ? 'pending' : ''}`}>
          <div className="message-body island-git-request">
            <RequestIcon size={15} aria-hidden="true" />
            <b>{gitRequest.label}</b>
            {gitRequest.meta ? <span className="island-git-request-meta">{gitRequest.meta}</span> : null}
          </div>
        </article>
      );
    }
    const showFooter = !user && !streaming && Boolean(completion);
    const { attachedImages, markerChips, pastedFold, fileFold, tweaksFold } = user
      ? foldUserContent(item, text, pastedTexts)
      : NO_USER_FOLD;
    const appliedSkills = user ? appliedSkillsOf(item) : [];
    const reactions = user ? messageReactionsOf(item) : [];
    const originalMissingNote = user ? originalImagesMissingText(item.originalImagesMissing) : null;
    return (
      <>
        <article
          className={`message ${user ? 'user' : 'assistant'} ${sourceLabel || (user && item.fromAgent) ? 'sourced-message' : ''} ${streaming ? 'streaming' : 'settled'} ${item.pending ? 'pending' : ''} ${user && attachedUser ? 'attached-user' : ''}`}
          aria-live={streaming || announceSettled ? 'off' : undefined}
          aria-busy={item.pending === true ? 'true' : undefined}
        >
          {sourceLabel && <small className="message-source">{sourceLabel}</small>}
          {user && item.fromAgent ? <BotSourceLabel agentId={item.fromAgent} /> : null}
          {user && item.room?.to?.length ? <RoomAddressChip room={item.room} fromUser /> : null}
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
                pastedRecords={pastedTokenRecords.filter((_, index) => pastedTexts[index] === undefined)}
                fileChips={fileFold.chips}
                menuProps={menuProps}
              />
            )}
          {menuElement}
          {(!user || tweaksFold.text || tweaksFold.lines.length > 0) && (
            // biome-ignore lint/a11y/noStaticElementInteractions: only suppresses native drag; the body is not an interactive control.
            <div className="message-body" onDragStart={(event) => event.preventDefault()}>
              {user &&
                Boolean(tweaksFold.text) &&
                splitInlinePastes(tweaksFold.text).map((part, index) =>
                  'paste' in part ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts are parsed from a sent message and never reorder.
                    <SentPasteBlock key={`paste-${index}`} text={pastedTexts[part.paste]} />
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts are parsed from a sent message and never reorder.
                    <p key={`text-${index}`}>
                      <SkillMentionText text={part.text.trim()} isSkill={(name) => appliedSkills.includes(name)} />
                    </p>
                  )
                )}
              {tweaksFold.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are parsed from a sent message and never reorder.
                <p key={`tweaks-${index}`} className="message-tweaks-line">
                  <SlidersHorizontal size={12} aria-hidden="true" /> {line}
                </p>
              ))}
              {!user && (
                // Only a settled reply's links can be downloaded by its row id.
                <MarkdownTranscriptItemContext.Provider value={streaming ? '' : String(item.id ?? '')}>
                  <MarkdownResponse text={revealed.text} streaming={streaming} preparsedRoot={finalRoot} />
                </MarkdownTranscriptItemContext.Provider>
              )}
            </div>
          )}
          {reactions.length > 0 && <MessageReactions reactions={reactions} />}
          {user && <AppliedSkills names={appliedSkills} />}
          {user && multiDevice && isOtherDevice(item.device, viewerDevice) && (
            <small className="message-device">{t('from {{device}}', { device: item.device })}</small>
          )}
          {user && <SteerStatus item={item} />}
          {user && originalMissingNote ? (
            <small className="message-original-missing" role="status">
              {originalMissingNote}
            </small>
          ) : null}
          {showFooter && completion && !footerAfterCards && (
            <TranscriptResponseFooter
              item={item}
              completion={completion}
              animateComplete={animateComplete}
              completionActivityKey={completionActivityKey}
              backgroundWork={backgroundWork}
            />
          )}
        </article>
        {announceSettled && !completion && (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {t('Response complete.')}
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
    previous.footerAfterCards === next.footerAfterCards &&
    previous.revealKey === next.revealKey &&
    previous.paced === next.paced &&
    previous.disclosureScope === next.disclosureScope
);
