import { GitCommitHorizontal, GitPullRequest, SlidersHorizontal, Upload } from 'lucide-react';
import { parseIslandGitRequestText } from './island-git-request';
import { Suspense, createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAttachmentContextMenu } from './attachment-context-menu';
import { MarkdownOpenFileContext, MarkdownSessionContext, MarkdownTranscriptItemContext } from './MarkdownLink';
import type { TranscriptItem } from './desktop-types';
import { isOtherDevice } from '../shared/session-devices';
import { t, uiFormatLocale } from './i18n';
import { useRoomContacts } from './agent-room-parts';
import { stripAgentMessageEnvelope } from '../../../../src/runtime/shared/agent-message-envelope.mjs';
import { localizeRouteFallbackNotice } from './error-notice-copy';
import MarkdownBody from './MarkdownBody';
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  isPlainTextMarkdown,
  resolveStreamingMarkdownChunks,
} from './streaming-markdown';
import StreamingMarkdownBody from './StreamingMarkdownBody';
import { dropStreamFadeTimeline, STREAM_FADE_SETTLE_MS, streamFadeTimeline } from './markdown-stream-fade';
import { preloadSyncMarkdownParser } from './markdown-worker-client';
import { CopyControl } from './transcript-primitives';
import { noteStreamCommit } from './transcript-stream-metrics';
import { useTranscriptTextReveal } from './use-transcript-text-reveal';
import { type BackgroundWorkCounts, CompletionStatus } from './transcript-status';
import { shouldSuppressFullyFailedToolItem } from './transcript-tool-model';
import { ToolCard } from './transcript-tool-ui';
import { SteerStatus } from './transcript-steer-status';
import { AppliedSkills, SkillMentionText, appliedSkillsOf } from './composer-skill-mentions';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText, isTranscriptCancelledStatusText, isTranscriptHiddenToolItem } from '../../../../src/runtime/shared/tool-execution-contract.mjs';
import { stripInjectedDisplayText, stripSessionEnvelope } from '../shared/session-title.mjs';
import { routineNoticeText } from './routine-notice';
import { RoomAddressChip, RoomTranscriptRow } from './agent-room-transcript';
import { HeldRequestCard } from './ApprovalCard';
import { AgentTaskLine } from './agent-task-line';
import { asRecord } from './text-format';

export { routineNoticeText };
export { loadAttachmentThumbnail, ReturnedAttachments } from './transcript-attachments';
import {
  extractEscapedFileMarkers,
  extractImageMarkers,
  extractPastedTextMarkers,
  extractTweaksLines,
  type PastedTextChip,
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

const StableMarkdownBody = memo(function StableMarkdownBody({ text }: { text: string }) {
  if (isPlainTextMarkdown(text)) return <p>{text}</p>;
  return <MarkdownBody text={text} copyControl={CopyControl} />;
});

const MarkdownResponse = memo(function MarkdownResponse({
  text,
  streaming,
  fadeKey,
  fadeRevision = 0,
}: {
  text: string;
  streaming: boolean;
  /** Row identity of the reply's word-fade timeline (markdown-stream-fade);
   *  empty: nothing fades. */
  fadeKey: string;
  /** The reveal's last rewrite of `text` (use-transcript-text-reveal). */
  fadeRevision?: number;
}) {
  const markdownCache = useRef(createStreamingMarkdownCache());
  const workerPipeline = useRef(streaming);
  // Every chunk, frozen ones included, fades on the reply's one timeline. A
  // settled reply keeps it STREAM_FADE_SETTLE_MS, so the rest it then shows
  // at once still fades; after that its words show unwrapped.
  const [fadeSettled, setFadeSettled] = useState(false);
  const fadeTimeline = fadeKey && !fadeSettled ? streamFadeTimeline(fadeKey, streaming) : null;
  fadeTimeline?.sync(text, performance.now(), fadeRevision);
  useEffect(() => {
    if (streaming || !fadeTimeline) return;
    const timer = setTimeout(() => {
      dropStreamFadeTimeline(fadeKey);
      setFadeSettled(true);
    }, STREAM_FADE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [streaming, fadeTimeline, fadeKey]);
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
  // `streamed`: this mount watched the reply arrive (22-markdown.css keeps its
  // line breaks greedy, also once it settles).
  return (
    <div className={`markdown ${streaming ? 'streaming' : ''}${workerPipeline.current ? ' streamed' : ''}`}>
      {renderedChunks}
    </div>
  );
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
}: {
  item: TranscriptItem;
  completion: TranscriptItem;
  animateComplete?: boolean;
  completionActivityKey?: string;
  backgroundWork?: BackgroundWorkCounts;
  /** Rendered after the turn's cards rather than inside the message. */
  trailing?: boolean;
}) {
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
    /** Row key of an assistant part: its reveal and fade identity. */
    revealKey?: string;
    /** The coding transcript: a live part reveals in paced steps and its new
     *  words fade in; elsewhere received text shows whole, unfaded. */
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
    const assistant = item.kind === 'assistant';
    const revealed = useTranscriptTextReveal({
      key: assistant ? revealKey : '',
      text: assistant ? String(item.text || '') : '',
      streaming: Boolean(item.streaming),
      paced,
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
      if (held?.status === 'pending') return <HeldRequestCard held={held} sessionId={sessionScope} />;
      const task = asRecord(item.routine);
      // A task report's files stay in its session: the card says how many.
      if (task?.kind === 'task') return <AgentTaskLine routine={task} />;
      const tone = item.tone === 'error' || item.tone === 'warn' ? item.tone : '';
      const routine = routineNoticeText(item.routine);
      return (
        <div className={`notice ${tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
          {routine ??
            (item.text === 'The model refused to respond (safety refusal) — retry or rephrase your prompt.'
              ? t('The model refused to respond (safety refusal) — retry or rephrase your prompt.')
              : item.text === 'Allowed this once. The setting could not be saved.'
                ? t('Allowed this once. The setting could not be saved.')
                : (localizeRouteFallbackNotice(String(item.text || '')) ?? item.text))}
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
    const attachedImages = user && Array.isArray(item.images) ? item.images : [];
    const imageMarkers = user ? extractImageMarkers(text) : { text, chips: [] };
    const markerChips = attachedImages.length > 0 ? [] : imageMarkers.chips;
    const userDisplayText =
      attachedImages.length > 0 ? stripImagePlaceholders(stripImageTokens(imageMarkers.text)) : imageMarkers.text;
    const pastedFold = user
      ? extractPastedTextMarkers(userDisplayText, pastedTexts)
      : { text: userDisplayText, chips: [] as PastedTextChip[] };
    const fileFold = user ? extractEscapedFileMarkers(pastedFold.text) : { text: pastedFold.text, chips: [] };
    const webhookFold = user ? extractWebhookPayload(fileFold.text) : { text: fileFold.text, payload: '' };
    const tweaksFold = user ? extractTweaksLines(webhookFold.text) : { text: webhookFold.text, lines: [] as string[] };
    // The runtime reports which `$name` mentions it applied; only those are
    // marked, so `$HOME` or a skill that was off stays prose.
    const appliedSkills = user ? appliedSkillsOf(item) : [];
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
              {user && tweaksFold.text
                ? splitInlinePastes(tweaksFold.text).map((part, index) =>
                    'paste' in part ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts are parsed from a sent message and never reorder.
                      <p key={`paste-${index}`} className="message-pasted-text">
                        {pastedTexts[part.paste]}
                      </p>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts are parsed from a sent message and never reorder.
                      <p key={`text-${index}`}>
                        <SkillMentionText text={part.text.trim()} isSkill={(name) => appliedSkills.includes(name)} />
                      </p>
                    )
                  )
                : null}
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
                    text={revealed.text}
                    streaming={streaming}
                    fadeKey={paced ? revealKey : ''}
                    fadeRevision={revealed.revision}
                  />
                </MarkdownTranscriptItemContext.Provider>
              )}
            </div>
          )}
          {user && <AppliedSkills names={appliedSkills} />}
          {user && multiDevice && isOtherDevice(item.device, viewerDevice) && (
            <small className="message-device">{t('from {{device}}', { device: item.device })}</small>
          )}
          {user && <SteerStatus item={item} />}
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
    previous.footerAfterCards === next.footerAfterCards &&
    previous.revealKey === next.revealKey &&
    previous.paced === next.paced &&
    previous.disclosureScope === next.disclosureScope
);
