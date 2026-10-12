import { useState } from 'react';
import type { DesktopBrowserPageAction, DesktopBrowserPageFrame } from '../shared/contract';
import { t } from './i18n';

/** A sibling of the pixel/input surface, never an event ancestor of it. */
export function BrowserPagePrompts({
  frame,
  control,
}: {
  frame: DesktopBrowserPageFrame;
  control(action: DesktopBrowserPageAction): Promise<void>;
}) {
  const [text, setText] = useState(frame.dialog?.defaultPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const answer = async (action: DesktopBrowserPageAction) => {
    if (busy) return;
    setBusy(true);
    try {
      await control(action);
    } catch {
      /* The client owns the visible error; never replay an answer. */
    } finally {
      setBusy(false);
    }
  };
  const dialog = frame.dialog;
  const chooser = frame.fileChooser;
  if (!dialog && !chooser) return null;
  // Like an ordinary browser's page dialog: an opaque card naming the site,
  // focused on arrival so Enter accepts and Escape dismisses it.
  const accept = () => {
    if (dialog) void answer({ type: 'answer-dialog', requestId: dialog.id, accept: true, promptText: text });
  };
  const dismiss = () => {
    if (dialog) void answer({ type: 'answer-dialog', requestId: dialog.id, accept: dialog.type === 'alert' });
    else if (chooser) void answer({ type: 'choose-files', requestId: chooser.id, cancel: true });
  };
  return (
    <section
      className="browser-page-prompt mx-dialog"
      role={dialog ? 'alertdialog' : 'dialog'}
      aria-label={dialog ? pageHost(frame.url) : t('Choose files')}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') dismiss();
      }}
    >
      {dialog ? (
        <>
          <header>
            <h3>{pageHost(frame.url)}</h3>
          </header>
          <div className="mx-dialog-body">
            <p>{dialog.message}</p>
            {dialog.type === 'prompt' && (
              <input
                aria-label={t('Response')}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) accept();
                }}
                maxLength={2000}
                disabled={busy}
                // biome-ignore lint/a11y/noAutofocus: a page prompt dialog must put focus in its response field
                autoFocus
              />
            )}
          </div>
          <footer>
            {dialog.type !== 'alert' && (
              <button type="button" disabled={busy} onClick={dismiss}>
                {t('Cancel')}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={accept}
              // biome-ignore lint/a11y/noAutofocus: a page dialog must put focus on its default action
              autoFocus={dialog.type !== 'prompt'}
            >
              {t('OK')}
            </button>
          </footer>
        </>
      ) : (
        chooser && (
          <>
            <header>
              <h3>{t('Choose files')}</h3>
            </header>
            <footer>
              <button type="button" disabled={busy} onClick={dismiss}>
                {t('Cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void answer({
                    type: 'choose-files',
                    requestId: chooser.id,
                  })
                }
                // biome-ignore lint/a11y/noAutofocus: a file-chooser dialog must put focus on its default action
                autoFocus
              >
                {t('Choose files')}
              </button>
            </footer>
          </>
        )
      )}
    </section>
  );
}

/** The site asking, as an ordinary browser titles its page dialogs. */
function pageHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
