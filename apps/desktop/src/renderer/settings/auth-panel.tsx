// 설정 › 인증 관리: every login Browser Use may use, merging the saved-login
// vault with the cookie sign-ins, plus the imports and the auto sign-in /
// chat-save / clear-all controls. Passwords and authenticator keys flow in
// only: this page shows a site, a username and which secrets are stored, never
// their values.
import { Globe, KeyRound, MoreHorizontal, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi, DesktopBrowserSignedInSite, DesktopVaultLogin } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { ScmContextMenu, type ScmContextMenuState } from '../ScmContextMenu';
import { BrowserImportDialog } from '../BrowserImportDialog';
import { ActionButton, Group, SettingsConfirmDialog, ToggleRow } from './capability-controls';
import { type AuthFilter, type AuthRow, authCounts, filterAuthRows, mergeAuthRows } from './auth-rows';
import { loginSavePayload } from './auth-login-draft';

type AuthApi = Partial<DesktopApi>;

/** How a row's login got here (mockup source line); a cookie-only site "stays signed in". */
function sourceText(row: AuthRow): string {
  if (!row.hasPassword) return t('Stays signed in');
  switch (row.source) {
    case 'csv':
      return t('From CSV');
    case 'chat':
      return t('Saved from chat');
    case 'manual':
      return t('Added manually');
    default:
      return t('Imported from Chrome');
  }
}

const INITIAL_ROWS = 8;

interface LoginDialogState {
  login: DesktopVaultLogin | null;
}

export function AuthPanel({ api = window.mixdogDesktop, active = true }: { api?: AuthApi; active?: boolean } = {}) {
  const [logins, setLogins] = useState<DesktopVaultLogin[] | null>(null);
  const [sites, setSites] = useState<DesktopBrowserSignedInSite[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AuthFilter | null>(null);
  const [visible, setVisible] = useState(INITIAL_ROWS);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const [dialog, setDialog] = useState<LoginDialogState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [autoSignIn, setAutoSignIn] = useState<boolean | null>(null);
  const [saveChatLogins, setSaveChatLogins] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Only the newest read lands: an older one answering late never restores
  // a stale list or clears a newer error.
  const listRead = useRef(0);
  const settingsRead = useRef(0);
  const reload = useCallback(async () => {
    const read = ++listRead.current;
    try {
      const [vaultLogins, signedIn] = await Promise.all([
        Promise.resolve(api.browserVaultLogins?.()).then((value) => value ?? []),
        Promise.resolve(api.browserSignedInSites?.()).then((value) => value ?? []),
      ]);
      if (read !== listRead.current) return;
      setLogins(vaultLogins);
      setSites(signedIn);
      setError('');
    } catch (reason) {
      if (read !== listRead.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [api]);

  // Every time the page is shown it re-reads the vault: the panel stays
  // mounted while hidden, so a mount-only load would keep a stale list.
  useEffect(() => {
    if (!active) return;
    void reload();
    const read = ++settingsRead.current;
    void Promise.resolve(api.readSettings?.())
      .then((settings) => {
        if (read !== settingsRead.current) return;
        setAutoSignIn(settings ? settings.browserAutoSignIn !== false : null);
        setSaveChatLogins(settings ? settings.saveChatLogins !== false : null);
      })
      .catch(() => undefined);
  }, [active, api, reload]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleSetting = (
    key: 'browserAutoSignIn' | 'saveChatLogins',
    next: boolean,
    set: (value: boolean) => void
  ) => {
    set(next);
    void Promise.resolve(api.updateSetting?.(key, next))
      .then((settings) => {
        if (settings) set(key === 'browserAutoSignIn' ? settings.browserAutoSignIn !== false : settings.saveChatLogins !== false);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const rows = mergeAuthRows(logins ?? [], sites);
  const counts = authCounts(rows);
  // Until the user picks one, the switch opens on the side that has logins.
  // The cookie-only option disappears at zero; its filter then falls back.
  const preferred: AuthFilter = filter ?? (counts.password === 0 && counts.cookies > 0 ? 'cookies' : 'password');
  const activeFilter: AuthFilter = preferred === 'cookies' && counts.cookies === 0 ? 'password' : preferred;
  const shown = filterAuthRows(rows, activeFilter, query);
  const filters: Array<[AuthFilter, string, number]> = [['password', t('Saved password'), counts.password]];
  if (counts.cookies > 0) filters.push(['cookies', t('Stay signed in only'), counts.cookies]);
  const noLogins = logins !== null && rows.length === 0;

  const openMenu = (row: AuthRow, point: { x: number; y: number }) => {
    const items = [];
    if (row.loginId) {
      items.push({
        id: 'edit',
        label: t('Edit login'),
        onSelect: () => {
          const login = (logins ?? []).find((entry) => entry.id === row.loginId) ?? null;
          window.setTimeout(() => setDialog({ login }), 0);
        },
      });
    }
    if (row.cookies > 0) {
      items.push({ id: 'signout', label: t('Sign out'), onSelect: () => void run(() => api.browserSignOutSite?.(row.host) ?? Promise.resolve()) });
    }
    if (row.loginId) {
      items.push({
        id: 'delete',
        label: t('Delete login'),
        danger: true,
        separatorBefore: items.length > 0,
        onSelect: () => void run(() => api.browserVaultDelete?.(row.loginId as string) ?? Promise.resolve()),
      });
    }
    if (items.length) setMenu({ label: row.host, ...point, items });
  };

  return (
    <>
      <Group
        title={t('Logins')}
        actions={
          <div className="auth-tools">
            <ActionButton
              primary={noLogins}
              disabled={!api.browserProfileImportSources}
              onClick={() => setImportOpen(true)}
            >
              {t('Import')}
            </ActionButton>
            <ActionButton onClick={() => setDialog({ login: null })}>{t('Add')}</ActionButton>
          </div>
        }
      >
        {logins !== null && !noLogins && (
          <>
            <div className="auth-seg" role="group" aria-label={t('Logins')}>
              {filters.map(([value, label, count]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={activeFilter === value}
                  onClick={() => {
                    setFilter(value);
                    setVisible(INITIAL_ROWS);
                  }}
                >
                  {label} {count}
                </button>
              ))}
            </div>
            <label className="auth-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t('Search sites and usernames')}
                aria-label={t('Search sites and usernames')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisible(INITIAL_ROWS);
                }}
              />
            </label>
          </>
        )}
        {logins === null ? (
          <p className="settings-empty">{t('Loading…')}</p>
        ) : noLogins ? (
          <p className="settings-empty">
            {t('No logins yet. Chrome logins can be imported so the agent can sign in with them (one administrator approval).')}
          </p>
        ) : shown.length === 0 ? (
          <p className="settings-empty">{t('No saved logins yet.')}</p>
        ) : (
          <ul className="auth-list">
            {shown.slice(0, visible).map((row) => (
              <li key={row.key} className="auth-row">
                <span className="auth-row-icon" aria-hidden="true">
                  <Globe size={15} />
                </span>
                <span className="auth-row-copy">
                  <b>{row.host}</b>
                  <small>
                    {row.username ? <span className="auth-user">{row.username}</span> : null}
                    {row.hasPassword && (
                      <span className="auth-pill auth-pill-key">
                        <KeyRound size={10} aria-hidden="true" /> {t('Password')}
                      </span>
                    )}
                    {row.hasTotp && <span className="auth-pill auth-pill-otp">{t('Authenticator key')}</span>}
                    {row.cookies > 0 && <span className="auth-pill">{t('Cookies {{count}}', { count: row.cookies })}</span>}
                    {row.loggedOut && <span className="auth-pill auth-pill-off">{t('Signed out')}</span>}
                    <span className="auth-source">· {sourceText(row)}</span>
                  </small>
                </span>
                <button
                  type="button"
                  className="auth-row-menu"
                  aria-label={t('Edit login')}
                  disabled={busy}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu(row, { x: rect.right, y: rect.bottom });
                  }}
                >
                  <MoreHorizontal size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
            {shown.length > visible && (
              <li>
                <button type="button" className="auth-more" onClick={() => setVisible((count) => count + INITIAL_ROWS)}>
                  {t('Show {{count}} more', { count: shown.length - visible })}
                </button>
              </li>
            )}
          </ul>
        )}
        {error && <ErrorNotice error={error} />}
      </Group>

      <Group>
        {autoSignIn !== null && (
          <ToggleRow
            title={t('Auto login')}
            description={t('The agent signs in by itself with saved logins.')}
            showDescription
            checked={autoSignIn}
            onChange={(next) => toggleSetting('browserAutoSignIn', next, setAutoSignIn)}
          />
        )}
        {saveChatLogins !== null && (
          <ToggleRow
            title={t('Save logins entered in chat')}
            description={t('Save logins you enter in chat.')}
            showDescription
            checked={saveChatLogins}
            onChange={(next) => toggleSetting('saveChatLogins', next, setSaveChatLogins)}
          />
        )}
      </Group>

      {!noLogins && logins !== null && (
        <button
          type="button"
          className="auth-clear-all"
          disabled={busy || !api.browserClearSignIns}
          onClick={() => setConfirmClear(true)}
        >
          {t('Clear all saved logins')}
        </button>
      )}

      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {dialog && (
        <LoginDialog
          login={dialog.login}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={(input) =>
            run(async () => {
              await api.browserVaultSave?.(input);
              setDialog(null);
            })
          }
        />
      )}
      <BrowserImportDialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          void reload();
        }}
      />
      {confirmClear && (
        <SettingsConfirmDialog
          portal
          options={{
            title: t('Clear all saved logins?'),
            description: t(
              'Every site is signed out and the passwords, cookies and history imported from Chrome are deleted.'
            ),
            danger: true,
            confirmLabel: t('Clear all'),
            onConfirm: () => void run(() => api.browserClearSignIns?.() ?? Promise.resolve()),
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </>
  );
}

/** 로그인 추가 / 로그인 수정: the only place a password or authenticator key is
 *  entered. A blank password on edit keeps the saved one. */
function LoginDialog({
  login,
  busy,
  onClose,
  onSave,
}: {
  login: DesktopVaultLogin | null;
  busy: boolean;
  onClose(): void;
  onSave(input: { id?: string; origin: string; username: string; password?: string; totpSecret?: string; note?: string }): void;
}) {
  const titleId = useId();
  const [site, setSite] = useState(() => (login ? login.origin.replace(/^https?:\/\//, '') : ''));
  const [username, setUsername] = useState(login?.username ?? '');
  const [password, setPassword] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCleared, setTotpCleared] = useState(false);
  const [note, setNote] = useState(login?.note ?? '');

  const submit = () => {
    onSave(
      loginSavePayload({
        ...(login ? { id: login.id } : {}),
        site,
        username,
        password,
        totpSecret,
        totpCleared,
        note,
      })
    );
  };

  return createPortal(
    <div className="settings-oauth-layer" {...scrimDismiss(() => !busy && onClose())}>
      <section
        className="conn-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={titleId}>{login ? t('Edit saved login') : t('Add login')}</h3>
          <p>{t('Use this login only on this site.')}</p>
        </header>
        <div className="conn-stack">
          <label className="conn-field">
            <span>{t('Site')}</span>
            <input
              className="conn-input"
              data-autofocus
              autoComplete="off"
              spellCheck={false}
              value={site}
              onChange={(event) => setSite(event.currentTarget.value)}
            />
          </label>
          <label className="conn-field">
            <span>{t('Username or email')}</span>
            <input
              className="conn-input"
              autoComplete="off"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
            />
          </label>
          <label className="conn-field">
            <span>{t('Password')}</span>
            <input
              className="conn-input"
              type="password"
              autoComplete="new-password"
              placeholder={login ? t('Leave blank to keep the saved password.') : ''}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <label className="conn-field">
            <span>{t('Authenticator app key (optional)')}</span>
            <input
              className="conn-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('Key under the QR code, or an otpauth:// address')}
              disabled={totpCleared}
              value={totpSecret}
              onChange={(event) => {
                setTotpSecret(event.currentTarget.value);
                setTotpCleared(false);
              }}
            />
            {/* Editing a login with a saved key: the field is blank (the key
                is never shown), so an unchanged edit must not wipe it. An
                explicit removal is the only way to clear it here. */}
            {login?.hasTotp &&
              (totpCleared ? (
                <span className="auth-field-note">
                  {t('The authenticator key will be removed when you save.')}
                  <button type="button" className="conn-link" onClick={() => setTotpCleared(false)}>
                    {t('Undo')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="conn-link auth-field-note"
                  onClick={() => {
                    setTotpCleared(true);
                    setTotpSecret('');
                  }}
                >
                  {t('Remove authenticator key')}
                </button>
              ))}
          </label>
          <label className="conn-field">
            <span>{t('Note (optional)')}</span>
            <input
              className="conn-input"
              autoComplete="off"
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <div className="auth-dialog-help">
            <KeyRound size={12} aria-hidden="true" />
            {t('Encrypted and never shown to the agent.')}
          </div>
        </div>
        <footer>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="conn-btn conn-btn--primary"
            disabled={busy || !site.trim() || !username.trim() || (!login && !password)}
            onClick={submit}
          >
            {t('Save')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
