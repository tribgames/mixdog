import { type KeyboardEvent, useId, useState } from 'react';

import type { DesktopSshConfigHost } from '../../shared/contract-ssh';
import { parseSshTarget, sshTargetLabel } from '../../main/ssh/ssh-command';
import { t } from '../i18n';
import { useMobileBack } from '../mobile-back';
import { ConnDialog } from './connection-dialogs';

function validTarget(text: string): boolean {
  try {
    parseSshTarget(text);
    return true;
  } catch {
    return false;
  }
}

/** The address being typed, the ssh config hosts that match it, and the suggestion menu's state. */
export function useSshAddressField(configHosts: DesktopSshConfigHost[], initialText: string) {
  const [text, setText] = useState(initialText);
  const [menuOpen, setMenuOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [identityFile, setIdentityFile] = useState('');
  const [remoteCwd, setRemoteCwd] = useState('');

  const target = text.trim();
  const valid = target.length > 0 && validTarget(target);
  const query = target.toLowerCase();
  const suggestions = configHosts.filter(
    (entry) =>
      entry.alias.toLowerCase() !== query &&
      (!query || entry.alias.toLowerCase().includes(query) || entry.detail.toLowerCase().includes(query))
  );
  const showMenu = menuOpen && suggestions.length > 0;
  const activeIndex = Math.min(active, suggestions.length - 1);

  return {
    text,
    target,
    valid,
    suggestions,
    showMenu,
    activeIndex,
    identityFile,
    remoteCwd,
    setIdentityFile,
    setRemoteCwd,
    change: (value: string): void => {
      setText(value);
      setMenuOpen(true);
      setActive(0);
    },
    pick: (entry: DesktopSshConfigHost): void => {
      setText(entry.alias);
      setMenuOpen(false);
      setActive(0);
    },
    move: (step: 1 | -1): void => {
      setMenuOpen(true);
      setActive((activeIndex + step + suggestions.length) % suggestions.length);
    },
    openMenu: (): void => setMenuOpen(true),
    closeMenu: (): void => setMenuOpen(false),
  };
}

type AddressField = ReturnType<typeof useSshAddressField>;

function AddressHint({ target, valid }: { target: string; valid: boolean }) {
  if (target.length > 0 && !valid) {
    return (
      <div className="conn-field-msg conn-field-msg--error" role="alert">
        {t('The address format is not valid.')}
      </div>
    );
  }
  return (
    <div className="conn-field-msg">
      {valid ? t('If the port is not 22, enter user@server address:port.') : '\u00a0'}
    </div>
  );
}

export const KEY_FILE_EXAMPLE = '~/.ssh/id_ed25519';

const MAX_PATH_LENGTH = 512;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const unusable = (value: string): boolean => value.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(value);

/** The same rules as main's parseHostSettings; '' when the value can be used. */
function keyFileError(value: string): string {
  const text = value.trim();
  if (unusable(text)) return t('The key file is not valid.');
  return text.startsWith('-') ? t('The key file must not start with "-".') : '';
}
function folderError(value: string): string {
  const text = value.trim();
  if (unusable(text)) return t('The server folder is not valid.');
  if (text && text !== '~' && !text.startsWith('~/') && !text.startsWith('/'))
    return t('The server folder must be an absolute server path or start with ~.');
  return '';
}

/** The collapsed "Advanced options": the login key file (typed or browsed) and the default server folder. */
function AdvancedOptions({
  field,
  chooseKeyFile,
}: {
  field: AddressField;
  chooseKeyFile?: () => Promise<string | null>;
}) {
  const browse = (): void => {
    void chooseKeyFile?.()
      .then((path) => path && field.setIdentityFile(path))
      .catch(() => undefined);
  };
  const keyError = keyFileError(field.identityFile);
  const folderMsg = folderError(field.remoteCwd);
  // While a field here is invalid (Connect is disabled) the section stays
  // open, so the reason stays in view; otherwise the user opens and closes it.
  const [expanded, setExpanded] = useState(false);
  const hasError = Boolean(keyError || folderMsg);
  return (
    <details
      className="ssh-advanced"
      open={expanded || hasError}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native disclosure control; the handler only holds it open while a field is invalid. */}
      <summary
        onClick={(event) => {
          if (hasError) event.preventDefault();
        }}
      >
        {t('Advanced options')}
      </summary>
      <div className="conn-stack">
        <label className="conn-field">
          <span>{t('Login key file')}</span>
          <span className="ssh-key-row">
            <input
              type="text"
              className="conn-input"
              placeholder={KEY_FILE_EXAMPLE}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={keyError !== ''}
              value={field.identityFile}
              onChange={(event) => field.setIdentityFile(event.currentTarget.value)}
            />
            {chooseKeyFile && (
              <button type="button" className="conn-btn" onClick={browse}>
                {t('Browse')}
              </button>
            )}
          </span>
          {keyError && (
            <span className="conn-field-msg conn-field-msg--error" role="alert">
              {keyError}
            </span>
          )}
        </label>
        <label className="conn-field">
          <span>{t('Default server folder')}</span>
          <input
            type="text"
            className="conn-input"
            placeholder="~"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={folderMsg !== ''}
            value={field.remoteCwd}
            onChange={(event) => field.setRemoteCwd(event.currentTarget.value)}
          />
          {folderMsg && (
            <span className="conn-field-msg conn-field-msg--error" role="alert">
              {folderMsg}
            </span>
          )}
        </label>
      </div>
    </details>
  );
}

/** "Connect SSH server" (B1): one address field with the ssh config hosts as suggestions. */
export function SshAddressDialog({
  field,
  chooseKeyFile,
  onConnect,
  onClose,
}: {
  field: AddressField;
  /** Native file picker on this PC; absent: no Browse button. */
  chooseKeyFile?: () => Promise<string | null>;
  onConnect(target: string, name: string, settings: { identityFile: string; remoteCwd: string }): void;
  onClose(): void;
}) {
  const listId = useId();
  const { target, valid, suggestions, showMenu, activeIndex } = field;
  // Registered after the dialog frame's own layer, so back folds the
  // suggestion list first (same order as Escape).
  useMobileBack(showMenu, field.closeMenu);

  const optionsValid = keyFileError(field.identityFile) === '' && folderError(field.remoteCwd) === '';
  const connect = (): void => {
    if (!valid || !optionsValid) return;
    onConnect(target, sshTargetLabel(parseSshTarget(target)), {
      identityFile: field.identityFile,
      remoteCwd: field.remoteCwd,
    });
  };
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      field.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (showMenu) field.pick(suggestions[activeIndex]);
      else connect();
    }
  };

  return (
    <ConnDialog
      viewKey="input"
      title={t('Connect SSH server')}
      description={t('Enter the address of the server to connect to.')}
      onEscape={() => (showMenu ? field.closeMenu() : onClose())}
      onScrim={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="conn-btn conn-btn--primary"
            disabled={!valid || !optionsValid}
            onClick={connect}
          >
            {t('Connect')}
          </button>
        </>
      }
    >
      <div className="conn-field ssh-field-wrap">
        <input
          type="text"
          className="conn-input"
          data-autofocus
          role="combobox"
          aria-expanded={showMenu}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={target.length > 0 && !valid}
          aria-label={t('user@server address')}
          placeholder={t('user@server address')}
          autoComplete="off"
          spellCheck={false}
          value={field.text}
          onChange={(event) => field.change(event.currentTarget.value)}
          onFocus={field.openMenu}
          onBlur={field.closeMenu}
          onKeyDown={onInputKeyDown}
        />
        {showMenu && (
          <div className="mx-menu ssh-suggest" id={listId} role="listbox" aria-label={t('SSH servers')}>
            {suggestions.map((entry, index) => (
              <button
                key={entry.alias}
                type="button"
                role="option"
                tabIndex={-1}
                className="mx-menu-item"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex ? 'true' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => field.pick(entry)}
              >
                <span>{entry.alias}</span>
                <small>{entry.detail}</small>
              </button>
            ))}
          </div>
        )}
        <AddressHint target={target} valid={valid} />
      </div>
      <AdvancedOptions field={field} chooseKeyFile={chooseKeyFile} />
    </ConnDialog>
  );
}
