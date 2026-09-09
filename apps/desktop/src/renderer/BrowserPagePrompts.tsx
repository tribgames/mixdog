import { useState } from 'react';
import type { DesktopBrowserPageAction, DesktopBrowserPageFrame } from '../shared/contract';
import { t } from './i18n';

/** A sibling of the pixel/input surface, never an event ancestor of it. */
export function BrowserPagePrompts({ frame, control }: {
  frame: DesktopBrowserPageFrame;
  control(action: DesktopBrowserPageAction): Promise<void>;
}) {
  const [text, setText] = useState(frame.dialog?.defaultPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const answer = async (action: DesktopBrowserPageAction) => {
    if (busy) return;
    setBusy(true);
    try { await control(action); }
    catch { /* The client owns the visible error; never replay an answer. */ }
    finally { setBusy(false); }
  };
  const dialog = frame.dialog;
  const chooser = frame.fileChooser;
  if (!dialog && !chooser) return null;
  return <div className="browser-page-prompt" role="dialog" aria-label={dialog?.type ?? t('Choose files')}
    onKeyDown={event => event.stopPropagation()}>
    {dialog ? <>
      <p>{dialog.message}</p>
      {dialog.type === 'prompt' && <input aria-label={t('Response')} value={text}
        onChange={event => setText(event.target.value)} maxLength={2000} disabled={busy} />}
      <div>
        {dialog.type !== 'alert' && <button disabled={busy} onClick={() => void answer({
          type: 'answer-dialog', requestId: dialog.id, accept: false,
        })}>{t('Cancel')}</button>}
        <button disabled={busy} onClick={() => void answer({
          type: 'answer-dialog', requestId: dialog.id, accept: true, promptText: text,
        })}>{t('OK')}</button>
      </div>
    </> : chooser && <>
      <p>{t('Choose files')}</p>
      <div>
        <button disabled={busy} onClick={() => void answer({
          type: 'choose-files', requestId: chooser.id, cancel: true,
        })}>{t('Cancel')}</button>
        <button disabled={busy} onClick={() => void answer({
          type: 'choose-files', requestId: chooser.id,
        })}>{t('Choose files')}</button>
      </div>
    </>}
  </div>;
}
