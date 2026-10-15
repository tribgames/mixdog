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

/** "Connect SSH server" (B1): one address field with the ssh config hosts as suggestions. */
export function SshAddressDialog({
  field,
  onConnect,
  onClose,
}: {
  field: AddressField;
  onConnect(target: string, name: string): void;
  onClose(): void;
}) {
  const listId = useId();
  const { target, valid, suggestions, showMenu, activeIndex } = field;
  // Registered after the dialog frame's own layer, so back folds the
  // suggestion list first (same order as Escape).
  useMobileBack(showMenu, field.closeMenu);

  const connect = (): void => {
    if (!valid) return;
    onConnect(target, sshTargetLabel(parseSshTarget(target)));
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
          <button type="button" className="conn-btn conn-btn--primary" disabled={!valid} onClick={connect}>
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
    </ConnDialog>
  );
}
