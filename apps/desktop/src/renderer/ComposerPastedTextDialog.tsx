import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { containDialogTab, EditorDialogFooter, PaneDialogLayer } from './sidebar-dialog';
import { MxIcon } from './MxIcon';
import { t } from './i18n';

/** Full-text editor behind a folded paste chip. Saving folds the edited text
 *  back into the same chip; saving it empty drops the chip. */
export function ComposerPastedTextDialog({
  anchor,
  text,
  onSave,
  onClose,
  returnFocus,
}: {
  /** The composer control the card centers against (its pane). */
  anchor: RefObject<HTMLElement | null>;
  text: string;
  /** Returns the reason the edit was refused, or '' once the chip took it. */
  onSave(text: string): string;
  onClose(): void;
  returnFocus(): void;
}) {
  const titleId = useId();
  const [value, setValue] = useState(text);
  const [error, setError] = useState('');
  const focusReturn = useRef(returnFocus);
  focusReturn.current = returnFocus;
  useEffect(() => () => focusReturn.current(), []);
  const save = () => {
    const refusal = onSave(value);
    if (refusal) setError(refusal);
    else onClose();
  };
  return (
    <PaneDialogLayer anchor={anchor} onClose={onClose}>
      <section
        className="schedules-dialog composer-paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={containDialogTab}
      >
        <header>
          <h2 id={titleId}>{t('Edit pasted text')}</h2>
          <div className="schedules-dialog-header-actions">
            <button type="button" aria-label={t('Close')} onClick={onClose}>
              <MxIcon name="close-small" size={16} />
            </button>
          </div>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            // The card portals out of the DOM but stays inside the composer
            // form's React tree; a bubbling submit would send the draft.
            event.stopPropagation();
            save();
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the pasted-text dialog opens to edit the text, so focus goes to the field
            autoFocus
            aria-labelledby={titleId}
            rows={16}
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
              event.preventDefault();
              save();
            }}
          />
          <EditorDialogFooter error={error} busy={false} onCancel={onClose} />
        </form>
      </section>
    </PaneDialogLayer>
  );
}
