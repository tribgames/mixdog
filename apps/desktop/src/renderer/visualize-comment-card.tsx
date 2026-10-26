// The Comment layer's card: where it sits beside its target, and the form
// the note is typed into (title, element path, note, Add / Save, Delete).
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useLayoutEffect,
} from 'react';

import { VISUALIZE_ELEMENT_ROLES } from '../shared/visualize-comment-kinds';
import { rectFromFractions, type VisualizeFeedbackRect, type VisualizePagePick } from '../shared/visualize-feedback';
import { t } from './i18n';

const CARD_WIDTH_PX = 288;
/** Between the comment card and its target, and the card and the pane's edge (CSS px). */
const CARD_GAP_PX = 10;
const CARD_EDGE_PX = 8;

/** Where the comment card goes (px of the layer): below its target when it
 *  fits there, else above when it fits there, else on the roomier side; then
 *  clamped inside the layer, over the target when neither side has room. */
export function visualizeCardPlace(
  target: VisualizeFeedbackRect,
  layer: { width: number; height: number },
  card: { width: number; height: number }
): { left: number; top: number } {
  const below = layer.height - (target.y + target.height) - CARD_GAP_PX;
  const above = target.y - CARD_GAP_PX;
  const top =
    below >= card.height || (above < card.height && below >= above)
      ? target.y + target.height + CARD_GAP_PX
      : target.y - CARD_GAP_PX - card.height;
  const clamp = (value: number, size: number, room: number) =>
    Math.max(CARD_EDGE_PX, Math.min(value, room - size - CARD_EDGE_PX));
  return { left: clamp(target.x, card.width, layer.width), top: clamp(top, card.height, layer.height) };
}

/** The open card sits beside its target (`rect`, fractions of the layer; null
 *  while no card is open, else where `moved` says it is now) and always
 *  inside the pane. */
export function useVisualizeCommentCardPlace(
  card: RefObject<HTMLFormElement | null>,
  layer: RefObject<HTMLDivElement | null>,
  rect: VisualizeFeedbackRect | null,
  moved: () => VisualizeFeedbackRect | null
): void {
  useLayoutEffect(() => {
    const form = card.current;
    const box = layer.current?.getBoundingClientRect();
    if (!form || !rect || !box?.width || !box.height) return;
    const size = form.getBoundingClientRect();
    const target = moved() ?? rect;
    const place = visualizeCardPlace(
      rectFromFractions(target, { x: 0, y: 0, width: box.width, height: box.height }),
      box,
      { width: size.width || CARD_WIDTH_PX, height: size.height }
    );
    form.style.left = `${place.left}px`;
    form.style.top = `${place.top}px`;
  });
}

/** The card's form. `pick`: the element a new comment is on, whose path
 *  (with its first child) is offered as crumbs that retarget the comment. */
export function VisualizeCommentCard({
  cardRef,
  number,
  label,
  editing,
  pick,
  note,
  setNote,
  submit,
  remove,
  close,
  retarget,
}: {
  cardRef: RefObject<HTMLFormElement | null>;
  number: number;
  label: string;
  editing: boolean;
  pick: VisualizePagePick | undefined;
  note: string;
  setNote(note: string): void;
  submit(event?: FormEvent): Promise<void>;
  remove(): void;
  close(): void;
  retarget(selector: string): void;
}) {
  const placeholder = pick ? t('Comment on this element…') : t('Comment on this area…');
  const crumbs = pick ? [...pick.path, pick] : [];
  if (pick?.child) crumbs.push(pick.child);
  const onNoteKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  return (
    <form ref={cardRef} className="visualize-region-note" onSubmit={(event) => void submit(event)}>
      <div className="visualize-region-note-head">
        <span className="visualize-region-note-number">{number}</span>
        <b className="visualize-region-note-label">{label}</b>
        {editing ? (
          <button type="button" className="visualize-region-note-delete" onClick={remove}>
            {t('Delete')}
          </button>
        ) : null}
      </div>
      {crumbs.length > 1 && pick && (
        <nav className="visualize-region-crumbs" aria-label={t('Element path')}>
          {crumbs.map((node, at) => {
            const current = node.selector === pick.selector;
            return (
              <Fragment key={node.selector}>
                {at > 0 ? <i aria-hidden="true">{'›'}</i> : null}
                <button
                  type="button"
                  className={current ? 'is-current' : undefined}
                  aria-current={current ? 'true' : undefined}
                  title={node.name || undefined}
                  onClick={(event) => {
                    if (event.nativeEvent.isTrusted && !current) retarget(node.selector);
                  }}
                >
                  {t(VISUALIZE_ELEMENT_ROLES[node.role])}
                </button>
              </Fragment>
            );
          })}
        </nav>
      )}
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the card opens from the user's own click or drag and takes the text at once
        autoFocus
        rows={3}
        value={note}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setNote(event.currentTarget.value)}
        onKeyDown={onNoteKey}
      />
      <div className="visualize-region-note-row">
        <span className="visualize-region-note-keys">
          <kbd>Enter</kbd> {editing ? t('Save') : t('Add')} · <kbd>Esc</kbd> {t('Cancel')}
        </span>
        <button type="button" onClick={close}>
          {t('Cancel')}
        </button>
        <button type="submit" className="is-primary" disabled={!note.trim()}>
          {editing ? t('Save') : t('Add')}
        </button>
      </div>
    </form>
  );
}
