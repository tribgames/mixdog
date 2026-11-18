import { sshMessages } from '@mixdog/protocol';

import type { SshMessage } from '../../shared/contract-ssh';
import { t } from '../i18n';

type Params = Record<string, string>;

/** The named parameters of a sentence (a missing one reads as empty rather than leaving a `{{slot}}` in the text). */
function pick(params: Params, names: string[]): Params {
  return Object.fromEntries(names.map((name) => [name, params[name] ?? '']));
}

/** A sentence followed by the detail lines the server printed, when it printed any. */
function withDetail(text: string, detail: string | undefined): string {
  return detail ? `${text}\n${detail}` : text;
}

/** A sentence followed by the file to edit, when it is named. */
function withPath(text: string, path: string | undefined): string {
  return path ? `${text} (${path})` : text;
}

/** Every sentence of the connection code by its stable code, worded in the interface language. The codes are the ones the core
 *  exports as `sshMessages` (the test pins that the two sets are the same). */
export const SSH_MESSAGE_TEXT: Record<string, (params: Params) => string> = {
  'server-not-ready': (p) => t('The server on {{name}} is not ready to accept connections. Try connecting again.', pick(p, ['name'])),
  'server-not-ready-unnamed': () => t('The server is not ready to accept connections. Try connecting again.'),
  'server-no-ssh-response': (p) => t('The server on {{name}} did not respond over SSH. Try connecting again.', pick(p, ['name'])),
  'server-refused-app': (p) => t('The server on {{name}} did not accept this app: {{error}}', pick(p, ['name', 'error'])),
  'foreign-program-answered': (p) => t('Another program answered over SSH on {{name}} instead of the server the app started. The connection was stopped and nothing was sent to it. Connect again to start over.', pick(p, ['name'])),
  'ssh-connection-not-ready': (p) => t('The SSH connection to {{name}} is not ready after {{ms}} ms.', pick(p, ['name', 'ms'])),
  'ssh-connection-closed': (p) => t('The SSH connection to {{name}} is closed.', pick(p, ['name'])),
  'server-connection-closed': () => t('The connection to the server is closed.'),
  'link-closed': (p) => t('The connection to {{name}} was closed.', pick(p, ['name'])),
  'reconnect-off': () => t('Automatic reconnection is off for this server.'),
  'folder-control-characters': () => t('The server folder must not contain control characters.'),
  'folder-not-absolute': (p) => t('The server folder must be an absolute server path: {{folder}}', pick(p, ['folder'])),
  'app-lacks-install-files': () => t('This app does not include the files needed to install on a server.'),
  'app-older-than-server': (p) => t('This app ({{client}}) is older than the version on {{display}} ({{server}}). Update the app on this PC, then reconnect.', pick(p, ['client', 'display', 'server'])),
  'server-version-mismatch': (p) => t('The version running on {{display}} ({{server}}) does not match this app ({{client}}). Reconnect to install the matching version on the server.', pick(p, ['display', 'server', 'client'])),
  'password-refused': () => t('The password was not accepted. Check it and try again.'),
  'passphrase-refused': () => t('The passphrase for the key was not accepted. Check it and try again.'),
  'code-refused': () => t('The code was not accepted. Check it and try again.'),
  'bootstrap-no-result': () => t('The server did not answer the install check. Try connecting again.'),
  'bootstrap-no-platform': () => t('The server did not say which system it runs. Try connecting again.'),
  'bootstrap-exited': (p) => withDetail(t('The install check on the server stopped unexpectedly (status {{status}}). Try connecting again.', pick(p, ['status'])), p.detail),
  'server-runs-windows': () => t('The server runs Windows. Servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).'),
  'server-system-unsupported': (p) => t('The server is {{found}}. Servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).', pick(p, ['found'])),
  'install-id-unsafe': (p) => t('The install name is not a safe folder name: {{id}}', pick(p, ['id'])),
  'upload-needs-checksums': () => t('An upload needs the checksum of the files and of their bundle.'),
  'install-no-gzip': () => t('gzip was not found on the server.'),
  'install-no-tar': () => t('tar was not found on the server.'),
  'install-no-checksum-tool': () => t('Neither sha256sum nor shasum was found on the server.'),
  'upload-not-stored': () => t('The uploaded files could not be stored on the server.'),
  'upload-checksum-mismatch': () => t('The uploaded files do not match their checksum.'),
  'upload-folder-failed': () => t('The upload folder could not be created on the server.'),
  'upload-not-unpacked': () => t('The uploaded files could not be unpacked on the server.'),
  'upload-no-program': () => t('The uploaded files do not contain the server program.'),
  'install-missing': () => t('The app is not installed on the server and must be uploaded.'),
  'host-keys-unreadable': (p) => t('The SSH host keys saved on this PC could not be read: {{error}}', pick(p, ['error'])),
  'host-keys-newer-version': (p) => t('The SSH host keys saved on this PC were written by a newer version of the app. Update the app and try again. ({{error}})', pick(p, ['error'])),
  'host-keys-malformed': (p) => t('The SSH host keys saved on this PC contain an entry the app cannot read. Fix or remove that entry in the known_hosts file, then try again. ({{error}})', pick(p, ['error'])),
  'ssh-settings-not-updated': (p) => t('The SSH settings on this PC could not be updated: {{error}}', pick(p, ['error'])),
  'host-key-changed-while-confirming': () => t('The server presented another key while this one was being confirmed. Check the server again.'),
  'host-key-revoked-while-confirming': () => t('This server\'s key was revoked while you were confirming it, so it was not saved. Check the server again.'),
  'host-keys-changed-while-confirming': () => t('The saved server keys changed while you were confirming this key, so it was not saved. Check the server again.'),
  'saved-entry-removal-failed': (p) => t('The saved entry for {{name}} could not be removed.', pick(p, ['name'])),
  'server-upgrade-required': (p) => t('The app on the server ({{server}}) does not offer the connection this app needs. Remove it from the server and connect again to install a matching version.', pick(p, ['server'])),
  'host-key-manual-edit': (p) => withPath(t('This host key is also listed in an entry the app did not add, or in several entries, so it cannot be replaced automatically. Edit the known_hosts file by hand, then try again.'), p.path),
  'ssh-config-unreadable': () => t('ssh could not read its configuration for this address.'),
  'proxy-host-unreadable': () => t('The host name cannot be read through a proxy.'),
  'no-key-to-save': () => t('There is no key to save.'),
  'no-key-to-replace': () => t('There is no key to replace.'),
  'server-not-saved': () => t('This SSH server is no longer saved.'),
  'cleanup-nothing-running': () => t('Nothing was running on the server.'),
  'cleanup-stopped': (p) => t('Stopped what was running on the server (process {{pid}}).', pick(p, ['pid'])),
  'cleanup-left-running': (p) => t('Left process {{pid}} running: it could not be confirmed as the app’s.', pick(p, ['pid'])),
  'cleanup-removed': (p) => t('Removed {{removed}}.', pick(p, ['removed'])),
  'cleanup-removed-kept': (p) => t('Removed {{removed}}; kept {{kept}}.', pick(p, ['removed', 'kept'])),
  'cleanup-removed-nothing': () => t('Removed nothing.'),
  'cleanup-removed-nothing-kept': (p) => t('Removed nothing; kept {{kept}}.', pick(p, ['kept'])),
  'connect-first': (p) => t('Connect to {{name}} to manage its logins.', pick(p, ['name'])),
  'pc-accounts': (p) => t('{{name}} uses this PC’s accounts. Switch it to server accounts to manage its logins.', pick(p, ['name'])),
  'forward-connection-closed': () => t('The SSH connection is closed.'),
  'forward-connection-not-ready': (p) => t('The SSH connection is not ready after {{ms}} ms.', pick(p, ['ms'])),
  'ensure-install-locked': (p) => t('Another installation on the server holds {{lock}} ({{owner}}). Try again when it has finished.', pick(p, ['lock', 'owner'])),
  'ensure-install-missing': (p) => t('The app is not installed on the server (install {{install}}) and must be uploaded.', pick(p, ['install'])),
  'ensure-checksum-mismatch': (p) => t('The uploaded files do not match their checksum (expected {{expected}}, got {{actual}}).', pick(p, ['expected', 'actual'])),
  'ensure-unsafe-install-id': (p) => t('The install name is not a safe folder name: {{id}}', pick(p, ['id'])),
  'ensure-bad-version': (p) => t('The version is not valid: {{version}}', pick(p, ['version'])),
  'ensure-core-exited': (p) => t('The app stopped on the server (status {{status}}). {{log}}: {{tail}}', pick(p, ['status', 'log', 'tail'])),
  'ensure-core-not-ready': (p) => t('The app did not become ready on the server within {{seconds}} s (it is still {{state}}). {{log}}: {{tail}}', pick(p, ['seconds', 'state', 'log', 'tail'])),
  'ensure-controller-gone': () => t('The connection to the server closed while the app was starting; it was left starting.'),
  'ensure-core-control': (p) => t('Managing the app on the server failed: {{detail}}', pick(p, ['detail'])),
  'ensure-install-failed': (p) => t('The install on the server failed: {{detail}}', pick(p, ['detail'])),
  'ensure-unproven': (p) => t('A process on the server could not be confirmed as the app’s, so it was left alone. {{detail}}', pick(p, ['detail'])),
  'ensure-stop-failed': (p) => t('The app on the server (process {{pid}}) did not stop.', pick(p, ['pid'])),
  'ensure-client-outdated': (p) => t('This app (version {{desktop_version}}) is older than the version on the server (version {{server_version}}). Update the app on this PC.', pick(p, ['desktop_version', 'server_version'])),
  'ensure-busy': (p) => t('The version on the server ({{server_version}}) is still running work. Wait for it to finish, or stop it.', pick(p, ['server_version'])),
  'ensure-arguments': (p) => t('The server program was not given usable arguments: {{detail}}', pick(p, ['detail'])),
};

/** The set of codes the core says, `client` and `server` together. */
export const SSH_MESSAGE_CODES: string[] = [...sshMessages.client, ...sshMessages.server].map((text) => text.code);

/** What a message says in the interface language; a code this window does not know shows the English the sender attached. */
export function sshMessageText(message: SshMessage | undefined, fallback: string): string {
  const text = message ? SSH_MESSAGE_TEXT[message.code] : undefined;
  return text && message ? text(message.params ?? {}) : fallback;
}
