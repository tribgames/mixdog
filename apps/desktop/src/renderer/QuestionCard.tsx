import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import {
  buildAnswers,
  emptyDraft,
  initQuestionState,
  primaryAction,
  type Question,
  type QuestionAction,
  type QuestionDraft,
  type QuestionAnswer,
  questionReducer,
  type QuestionState,
} from './question-card-logic';

export type QuestionDecision = { approved: boolean; reason?: string; answers?: QuestionAnswer[] };

// Shortcuts belong to one card: the one in the pane of the last pointer/focus
// interaction (several panes can each show their own pending question).
const cards = new Set<HTMLElement>();
let lastPane: Element | null = null;
const paneOf = (node: EventTarget | null): Element | null =>
  node instanceof Element ? node.closest('.pane-leaf') : null;
const rememberPane = (event: Event) => {
  lastPane = paneOf(event.target) ?? lastPane;
};
function ownsKeyboard(card: HTMLElement): boolean {
  // Focus in a dialog or anywhere outside the card's conversation (and outside
  // every pane) belongs to that surface. A single-pane layout has no pane
  // element, so the conversation is the scope there.
  const active = document.activeElement;
  const scope = card.closest('.conversation');
  if (active && active !== document.body && !paneOf(active) && !scope?.contains(active)) return false;
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return false;
  const pane = lastPane ?? paneOf(active);
  return pane ? pane === paneOf(card) : cards.size === 1;
}

// An IME commit arrives as keyCode 229 even after isComposing has cleared.
const isImeKey = (event: globalThis.KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/** The pending ask_user question, shown in the transcript where its call sits. */
export function QuestionCard({
  questions,
  resolve,
  draftsRef,
}: {
  questions: Question[];
  /** Kept current with the card's drafts so the composer can send them along with a reply. */
  draftsRef?: MutableRefObject<QuestionDraft[]>;
  /** true/false: recorded or refused (another device answered first; the card
   *  stays disabled until the approval leaves the snapshot). */
  resolve: (decision: QuestionDecision) => Promise<unknown>;
}) {
  const [state, setState] = useState<QuestionState>(() => initQuestionState(questions));
  // The ref is advanced with the same transition as the state, so a second
  // click or key before React re-renders still builds on the first one.
  const stateRef = useRef(state);
  if (draftsRef) draftsRef.current = stateRef.current.drafts;
  const apply = useCallback(
    (action: QuestionAction) => {
      stateRef.current = questionReducer(stateRef.current, action);
      if (draftsRef) draftsRef.current = stateRef.current.drafts;
      setState(stateRef.current);
    },
    [draftsRef]
  );
  const { drafts, index } = state;
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const resolvingRef = useRef(false);
  const composingRef = useRef(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const question = questions[index];
  const draft = drafts[index] ?? emptyDraft();
  const multi = question.multi_select === true;
  const total = questions.length;

  const decide = useCallback(
    async (decision: QuestionDecision) => {
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      setError('');
      setResolving(true);
      try {
        const accepted = await resolve(decision);
        if (typeof accepted === 'boolean') return;
        setError(t('Mixdog could not record this decision. Please try again.'));
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason || '');
        setError(
          detail
            ? t('Mixdog could not record this decision: {{detail}}', { detail })
            : t('Mixdog could not record this decision. Please try again.')
        );
      }
      resolvingRef.current = false;
      setResolving(false);
    },
    [resolve]
  );
  const close = useCallback(() => decide({ approved: false, reason: 'dismissed by user' }), [decide]);
  const advance = () => {
    const { drafts: current, index: at } = stateRef.current;
    const action = primaryAction(current, at);
    if (action === 'close') return void close();
    if (action === 'send') return void decide({ approved: true, answers: buildAnswers(questions, current) });
    apply({ type: 'step', delta: 1 });
  };
  // A single-select pick with no typed text is the whole answer: move on.
  const choose = (option: number) => {
    apply({ type: 'pick', option });
    const { drafts: current, index: at, multi: multiFlags } = stateRef.current;
    const draftNow = current[at];
    if (!multiFlags[at] && !draftNow.text.trim() && draftNow.selected.includes(option)) advance();
  };

  const live = useRef({ advance, choose, close, questions });
  live.current = { advance, choose, close, questions };
  const focusRow = (row: number) => rowRefs.current[row]?.focus();
  // The card takes focus when nothing else holds it, so the shortcuts work at
  // once; a user already typing in the composer keeps typing there (sending
  // from it closes the question).
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    card.focus({ preventScroll: true });
    // Long tool output above can leave the new card below the fold.
    card.scrollIntoView({ block: 'nearest' });
  }, []);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    cards.add(card);
    if (!lastPane) lastPane = paneOf(document.activeElement);
    document.addEventListener('pointerdown', rememberPane, true);
    document.addEventListener('focusin', rememberPane, true);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeKey(event) || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!ownsKeyboard(card)) return;
      const { advance: advanceCard, choose: chooseOption, close: closeCard, questions: all } = live.current;
      const { index: at, multi: multiFlags } = stateRef.current;
      const target = event.target;
      if (isTypingTarget(target)) return;
      // Option rows are buttons too, but Enter on them confirms the question
      // (Space or a click toggles); only other buttons keep native Enter.
      const onOption = target instanceof HTMLElement && target.classList.contains('question-option');
      const onButton = target instanceof HTMLButtonElement && !onOption;
      const optionCount = all[at].options.length;
      const multiSelect = multiFlags[at];
      const total = all.length;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === 'Escape') {
        handled();
        void closeCard();
      } else if (event.key === 'Enter') {
        if (onButton) return;
        handled();
        advanceCard();
      } else if (/^[1-9]$/.test(event.key)) {
        const number = Number(event.key);
        if (number <= optionCount) {
          handled();
          chooseOption(number - 1);
        } else if (number === optionCount + 1) {
          handled();
          inputRef.current?.focus();
        }
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        handled();
        const active = rowRefs.current.findIndex((row) => row === document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const entry = step > 0 ? 0 : optionCount;
        const next = active < 0 ? entry : Math.min(optionCount, Math.max(0, active + step));
        rowRefs.current[next]?.focus();
      } else if (event.key === ' ' && multiSelect && !onButton) {
        const active = rowRefs.current.findIndex((row) => row === document.activeElement);
        if (active >= 0 && active < optionCount) {
          handled();
          apply({ type: 'pick', option: active });
        }
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && total > 1) {
        handled();
        apply({ type: 'step', delta: event.key === 'ArrowRight' ? 1 : -1 });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cards.delete(card);
      document.removeEventListener('keydown', onKeyDown, true);
      if (cards.size === 0) {
        document.removeEventListener('pointerdown', rememberPane, true);
        document.removeEventListener('focusin', rememberPane, true);
        lastPane = null;
      }
    };
  }, [apply]);

  const moveFromInput = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || isImeKey(event.nativeEvent)) return;
    const optionCount = question.options.length;
    if (event.key === 'Enter') {
      event.preventDefault();
      advance();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void close();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(optionCount - 1);
    }
  };

  const typed = draft.text.trim().length > 0;
  const primary = primaryAction(drafts, index);
  const primaryLabel = {
    skip: t('Skip'),
    next: t('Next'),
    send: t('Send'),
    close: t('Close'),
  }[primary];
  const meta = [total > 1 ? `${index + 1}/${total}` : '', multi ? t('Multiple') : ''].filter(Boolean).join(' · ');
  const hint = [
    draft.selected.length > 0 ? t('{{count}} selected', { count: draft.selected.length }) : '',
    `Enter ${primaryLabel}`,
    index > 0 ? `← ${t('Previous question')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <article> must keep its tag; role="group" names the question region
    <article
      ref={cardRef}
      tabIndex={-1}
      className="question-card"
      role="group"
      aria-label={t('Agent question')}
      data-multi={multi || undefined}
    >
      <div className="question-head">
        <span className="question-icon" aria-hidden="true">
          ?
        </span>
        <span className="question-title">
          <strong>{question.header || t('Question')}</strong>
          {meta && <span className="question-meta">{meta}</span>}
        </span>
        <button
          type="button"
          className="question-close"
          aria-label={t('Close question')}
          onClick={() => void close()}
        >
          ✕
        </button>
      </div>
      <div className="question-text">{question.question}</div>
      <div className="question-options" role={multi ? 'group' : 'radiogroup'} aria-label={t('Options')}>
        {question.options.map((option, i) => {
          const on = draft.selected.includes(i);
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: options are positional and never reorder
              key={i}
              ref={(node) => {
                rowRefs.current[i] = node;
              }}
              type="button"
              className="question-option"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              data-selected={on || undefined}
              disabled={resolving}
              onClick={() => choose(i)}
            >
              <span className="question-box" data-kind={multi ? 'check' : 'radio'} aria-hidden="true">
                {multi && on ? '✓' : ''}
              </span>
              <span className="question-option-text">
                <span className="question-option-label">
                  {option.label}
                  {question.recommended === i && <span className="question-rec">{t('Recommended')}</span>}
                </span>
                {option.description && <span className="question-option-desc">{option.description}</span>}
              </span>
              {i < 9 && <span className="question-key">{i + 1}</span>}
            </button>
          );
        })}
      </div>
      <label className="question-other" data-typed={typed || undefined}>
        <input
          ref={(node) => {
            inputRef.current = node;
            rowRefs.current[question.options.length] = node;
          }}
          type="text"
          value={draft.text}
          maxLength={4000}
          disabled={resolving}
          placeholder={t('Type your own answer')}
          aria-label={t('Type your own answer')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => apply({ type: 'text', value: event.target.value })}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onBlur={() => {
            composingRef.current = false;
          }}
          onKeyDown={moveFromInput}
        />
      </label>
      {error && <ErrorNotice error={error} />}
      <div className="question-foot">
        <span className="question-hint">{hint}</span>
        {index > 0 && (
          <button
            type="button"
            className="turn-changes-action question-btn"
            data-action="previous"
            disabled={resolving}
            onClick={() => apply({ type: 'step', delta: -1 })}
          >
            {t('Previous')}
          </button>
        )}
        <button
          type="button"
          className={`${primary === 'send' || primary === 'next' ? 'turn-changes-view' : 'turn-changes-action'} question-btn`}
          data-primary
          data-action={primary}
          disabled={resolving}
          onClick={advance}
        >
          {primaryLabel}
        </button>
      </div>
    </article>
  );
}
