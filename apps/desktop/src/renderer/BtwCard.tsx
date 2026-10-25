// /btw card: docked directly above the composer, transient, never part of the
// transcript. State comes from btw-side-question.ts.
import { Check, Copy, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type BtwCardState, createBtwController } from './btw-side-question';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { usePhoneSurfaceMarked } from './mobile-surface';
import { ProgressSpinner } from './ProgressSpinner';
import { copyTextToClipboard } from './text-format';
import MarkdownBody from './MarkdownBody';
import { parseStreamingMarkdownAst } from './markdown-worker-client';
import { CopyControl } from './transcript-primitives';

/** The answer is revealed only once its AST is cached, so it opens styled in
 *  one paint instead of flashing source Markdown or an empty body first. */
function useAnswerReady(text: string | null): boolean {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    let live = true;
    const done = () => {
      if (live) setReady(text);
    };
    parseStreamingMarkdownAst(text).then(done, done);
    return () => {
      live = false;
    };
  }, [text]);
  return text !== null && ready === text;
}

/** Marks the scroller `data-more` while answer text remains below its fold. */
function useMoreBelow() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      node.dataset.more = String(node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    const mutations = new MutationObserver(() => {
      for (const child of node.children) observer.observe(child);
      update();
    });
    mutations.observe(node, { childList: true });
    node.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      node.removeEventListener('scroll', update);
    };
  }, []);
  return ref;
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"]';

/** One card per session surface. `blocked` = a composer palette owns Esc. */
export function useBtwCard(sessionId: string | undefined, active: boolean, blocked: boolean) {
  const [card, setCard] = useState<BtwCardState | null>(null);
  const controller = useRef<ReturnType<typeof createBtwController> | null>(null);
  controller.current ||= createBtwController((request) => window.mixdogDesktop.invokeCapability(request), setCard);
  const api = controller.current;
  // Leaving the session (or unmounting) cancels a pending ask and drops the card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger; the body does not read it
  useEffect(() => api.close, [api, sessionId]);
  const open = card !== null;
  useEffect(() => {
    if (!open || !active || blocked) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      // Kept-mounted surfaces (model picker, settings) stay in the DOM hidden.
      const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
      if ([...overlays].some((node) => node.getClientRects().length > 0)) return;
      // Capture phase: the composer's own Esc would interrupt the running turn.
      event.preventDefault();
      event.stopPropagation();
      api.close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [api, open, active, blocked]);
  const ask = useCallback((id: string, question: string) => void api.ask(id, question), [api]);
  const retry = useCallback(() => {
    if (sessionId) void api.retry(sessionId);
  }, [api, sessionId]);
  return { card, ask, retry, close: api.close };
}

const NO_REQUEST_NOTICE = 'Send a message first, then try /btw.';

/** A failure reads as one short line; the cause stays on hover. Only the
 *  no-conversation notice, which tells the user what to do, is shown as is. */
function FailureNotice({ error }: { error: string }) {
  const detail = errorMessageText(error);
  if (detail === NO_REQUEST_NOTICE) return t('Send a message first, then try /btw.');
  return <span title={detail}>{t('Response failed')}</span>;
}

// The runtime's fixed side-question notice that arrives as an answer.
const SIDE_MESSAGES: Readonly<Record<string, () => string>> = {
  'The model tried to use a tool instead of answering. A side question cannot run tools; try asking it differently.':
    () =>
      t(
        'The model tried to use a tool instead of answering. A side question cannot run tools; try asking it differently.'
      ),
};

function sideMessage(text: string): string {
  return Object.hasOwn(SIDE_MESSAGES, text) ? SIDE_MESSAGES[text]() : text;
}

function CopyAnswerButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void copyTextToClipboard(text).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1_600);
      },
      () => undefined
    );
  };
  const label = copied ? t('Copied') : t('Copy');
  return (
    <button type="button" className="btw-icon" aria-label={label} data-tooltip={label} onClick={copy}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

export function BtwCard({ card, onClose, onRetry }: { card: BtwCardState; onClose(): void; onRetry(): void }) {
  const phone = usePhoneSurfaceMarked();
  const pending = card.status === 'pending';
  const failed = card.status === 'failed';
  const answer = card.status === 'answered' ? sideMessage(card.text) : null;
  const answerReady = useAnswerReady(answer);
  const bodyRef = useMoreBelow();
  let closeTooltip: string;
  if (pending) closeTooltip = t('Cancel');
  else if (failed) closeTooltip = t('Esc to close');
  else closeTooltip = t('Esc to close · not saved to the conversation');
  return (
    <section className="btw-card" data-status={card.status} aria-label={t('Side question')}>
      <div className="btw-head">
        <span className="btw-question" title={card.question}>
          {card.question}
        </span>
        <span className="btw-tag">btw</span>
        {card.status === 'answered' && <CopyAnswerButton text={card.text} />}
        {failed && (
          <button
            type="button"
            className="btw-icon"
            aria-label={t('Ask again')}
            data-tooltip={t('Ask again')}
            onClick={onRetry}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="btw-icon"
          aria-label={pending ? t('Cancel') : t('Close')}
          data-tooltip={closeTooltip}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div ref={bodyRef} className="btw-body" data-error={failed || undefined} role={pending ? 'status' : undefined}>
        {(pending || (answer !== null && !answerReady)) && (
          <span className="btw-pending">
            <ProgressSpinner size={12} />
            {phone ? t('Answering…') : t('Answering… · Esc to cancel')}
          </span>
        )}
        {failed && <FailureNotice error={card.error} />}
        {answer !== null && answerReady && (
          <div className="markdown">
            <MarkdownBody text={answer} copyControl={CopyControl} />
          </div>
        )}
      </div>
    </section>
  );
}
