import { useState } from 'react';
import { BROWSER_PERMISSION_MAX_SITES } from '../shared/browser-permission-policy';
import type { DesktopBrowserPageAction, DesktopBrowserPageFrame } from '../shared/contract';
import { t } from './i18n';

function focusOnArrival(node: HTMLElement | null) {
  node?.focus({ preventScroll: true });
}

/** A sibling of the pixel/input surface, never an event ancestor of it. */
export function BrowserPagePrompts({
  frame,
  control,
}: {
  frame: Pick<DesktopBrowserPageFrame, 'url' | 'dialog' | 'fileChooser'>;
  control(action: DesktopBrowserPageAction): Promise<unknown>;
}) {
  const [text, setText] = useState(frame.dialog?.defaultPrompt ?? '');
  // An untouched default is accepted as the page's own (possibly longer) value.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  // The device picked in a device chooser, for the prompt it was picked in.
  const [pick, setPick] = useState<{ prompt: string; device: string } | null>(null);
  // The "remember" choice of a permission prompt, for the prompt it was made in.
  const [keep, setKeep] = useState<{ prompt: string; value: '' | 'site' | 'all' } | null>(null);
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
  // Cards the browser words itself: a leave confirmation carries no page
  // text, a dialog on another session's page is not this view's to show or
  // answer, and a dialog dismissed unseen is a notice to acknowledge.
  const leaving = dialog?.type === 'beforeunload';
  const waiting = dialog?.type === 'blocked';
  const notice = dialog?.type === 'dismissed';
  // A site asking for a permission: nothing is granted until a person picks
  // Allow, so no button is focused for Enter to press by accident.
  const asking = dialog?.type === 'permission';
  // A device chooser: Connect waits until a person picks one of the devices
  // still offered (one unplugged meanwhile drops out of the list and the pick).
  const devices = asking ? dialog?.permission?.devices : undefined;
  const picked =
    devices && pick && pick.prompt === dialog?.id && devices.some((device) => device.id === pick.device)
      ? pick.device
      : undefined;
  const cancellable = !waiting && !notice && dialog?.type !== 'alert';
  // How long a permission answer lasts; Escape never keeps anything.
  const siteListFull = asking && dialog?.permission?.siteListFull === true;
  const chosen: '' | 'site' | 'all' = keep && keep.prompt === dialog?.id ? keep.value : '';
  // A full exception list cannot take another site: the choice falls back to "until quit" visibly.
  const remember = siteListFull && chosen === 'site' ? '' : chosen;
  const rememberField = asking && !devices && dialog ? (remember ? { remember } : {}) : {};
  // Like an ordinary browser's page dialog: an opaque card naming the site,
  // focused on arrival so Enter accepts and Escape dismisses it.
  const accept = () => {
    if (dialog) {
      void answer({
        type: 'answer-dialog',
        requestId: dialog.id,
        accept: true,
        promptText: text,
        ...(dialog.type === 'prompt' && !edited ? { keepDefault: true } : {}),
        ...(picked ? { deviceId: picked } : {}),
        ...rememberField,
      });
    }
  };
  const deny = () => {
    if (dialog) void answer({ type: 'answer-dialog', requestId: dialog.id, accept: false, ...rememberField });
  };
  const dismiss = () => {
    if (dialog) {
      if (!waiting) void answer({ type: 'answer-dialog', requestId: dialog.id, accept: !cancellable });
    } else if (chooser) void answer({ type: 'choose-files', requestId: chooser.id, cancel: true });
  };
  const body = leaving
    ? t('Changes you made may not be saved.')
    : waiting
      ? t('This page is waiting for a dialog open on another page.')
      : notice
        ? t('This page tried to open a dialog, which was dismissed.')
        : devices
          ? t('{{origin}} wants to connect to a HID device. Pick the device to connect.', {
              origin: withoutScheme(dialog?.permission?.origin ?? ''),
            })
          : asking
            ? permissionBody(dialog?.permission)
            : dialog?.message;
  return (
    <section
      className="browser-page-prompt mx-dialog"
      role={dialog ? 'alertdialog' : 'dialog'}
      aria-label={dialog ? pageHost(frame.url) : t('Choose files')}
      // A permission card takes focus itself, not a button: Escape reaches
      // it and Enter grants nothing.
      tabIndex={asking ? -1 : undefined}
      ref={asking ? focusOnArrival : undefined}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') dismiss();
      }}
    >
      {dialog ? (
        <>
          <header>
            <h3>{leaving ? t('Leave site?') : pageHost(frame.url)}</h3>
          </header>
          <div className="mx-dialog-body">
            {asking && !devices ? <div>{body}</div> : <p>{body}</p>}
            {devices && dialog && (
              <>
                {devices.length ? (
                  <fieldset className="browser-device-list">
                    <legend>{t('Device to connect')}</legend>
                    {devices.map((device) => (
                      <label key={device.id}>
                        <input
                          type="radio"
                          name={`browser-device-${dialog.id}`}
                          checked={picked === device.id}
                          disabled={busy}
                          onChange={() => setPick({ prompt: dialog.id, device: device.id })}
                        />
                        <span>{device.name || t('Unknown device')}</span>
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <p className="browser-device-empty">
                    {t('No devices to connect. Connect a device to this PC and it appears here.')}
                  </p>
                )}
                {picked && (
                  <p className="browser-device-note">
                    {t('Only this device is connected to this site, until the app quits.')}
                  </p>
                )}
              </>
            )}
            {asking && !devices && (
              <label className="browser-permission-remember">
                <span>{t('Remember')}</span>
                <select
                  value={remember}
                  disabled={busy}
                  onChange={(event) => setKeep({ prompt: dialog.id, value: event.target.value as '' | 'site' | 'all' })}
                >
                  <option value="">{t('Until the app quits')}</option>
                  <option value="site" disabled={siteListFull}>
                    {t('For this site')}
                  </option>
                  <option value="all">{t('For all sites')}</option>
                </select>
                {siteListFull && (
                  <small className="browser-permission-remember-note" role="status">
                    {t('Site list full ({{max}}) — remove sites in Settings', { max: BROWSER_PERMISSION_MAX_SITES })}
                  </small>
                )}
              </label>
            )}
            {dialog.type === 'prompt' && (
              <input
                aria-label={t('Response')}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setEdited(true);
                }}
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
          {!waiting && (
            <footer>
              {cancellable && (
                <button type="button" disabled={busy} onClick={asking && !devices ? deny : dismiss}>
                  {devices ? t('Cancel') : asking ? t('Deny') : t('Cancel')}
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={busy || (devices !== undefined && !picked)}
                onClick={accept}
                // biome-ignore lint/a11y/noAutofocus: a page dialog must put focus on its default action
                autoFocus={dialog.type !== 'prompt' && !asking}
              >
                {leaving ? t('Leave') : devices ? t('Connect') : asking ? t('Allow') : t('OK')}
              </button>
            </footer>
          )}
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

/** What a site can ask for, in the pane's words. */
function permissionLabel(key: string): string {
  switch (key) {
    case 'notifications':
      return t('Show notifications');
    case 'geolocation':
      return t('Know your location');
    case 'clipboard-read':
      return t('Read the clipboard and put content on it');
    case 'clipboard-write':
      return t('Put content on the clipboard');
    case 'midi':
      return t('Use your MIDI devices');
    case 'midiSysex':
      return t('Control and reprogram your MIDI devices');
    case 'idle-detection':
      return t('Know when you are actively using this device');
    case 'top-level-storage-access':
      return t('Use info it has saved about you');
    case 'window-management':
      return t('Manage windows on all your displays');
    case 'speaker-selection':
      return t('Play audio through other speakers');
    case 'fileSystem':
      return t('Edit files on your device');
    case 'media:video':
      return t('Use your camera');
    case 'media:audio':
      return t('Use your microphone');
    default:
      return key;
  }
}

const withoutScheme = (origin: string) => origin.replace(/^https?:\/\//, '');

/** Who asks, and for what: the asking frame is named, with the site that
 *  embeds it when that is another one. */
function permissionBody(permission: NonNullable<DesktopBrowserPageFrame['dialog']>['permission']) {
  if (!permission) return null;
  const origin = withoutScheme(permission.origin);
  const heading = permission.embedder
    ? t('{{origin}}, embedded in {{embedder}}, wants to:', { origin, embedder: withoutScheme(permission.embedder) })
    : t('{{origin}} wants to:', { origin });
  const labels = [...new Set(permission.keys.map(permissionLabel))];
  return (
    <>
      {heading}
      <ul>
        {labels.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
    </>
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
