import { useState } from 'react';

import type { DesktopSshHost } from '../../shared/contract-ssh';
import type { CapabilityApi } from './capability-data';
import type { SshHostRequest } from './connection-intent';
import { SshAskpassPrompt } from './ssh-askpass-prompt';
import { SshAddressDialog, useSshAddressField } from './ssh-address-dialog';
import { SshChangedDialog, SshTrustDialog } from './ssh-host-key-views';
import { SshDaemonDialog, SshFailureDialog, SshForwardsDialog, SshStepsDialog } from './ssh-connect-views';
import { SshLogDialog } from './ssh-log-dialogs';
import { useSshConnectAttempt } from './use-ssh-connect-attempt';

export { sshProgressSteps } from './ssh-connect-views';

/** "Connect SSH server" (B1–B3, C1–C6): one address field, then the connection
 *  in the same dialog. A host key to confirm, a missing login key, a server
 *  that is not ready, or a daemon in the way each replace the content in place;
 *  nothing retries by itself. A saved `host` skips the address and connects. */
export function SshConnectDialog({
  api,
  host = null,
  onConnected,
  onClose,
}: {
  api: CapabilityApi;
  host?: SshHostRequest | null;
  onConnected?(host: DesktopSshHost): void;
  onClose(): void;
}) {
  const attempt = useSshConnectAttempt({ api, host, onConnected, onClose });
  const field = useSshAddressField(attempt.configHosts, host?.target ?? '');
  const [logOpen, setLogOpen] = useState(false);
  const { view, shown, summary, question } = attempt;
  const { chooseFile } = api;

  const editAddress = (): void => {
    attempt.editAddress();
    field.closeMenu();
  };
  const cancelAndClose = (): void => {
    attempt.cancelAttempt();
    onClose();
  };

  if (logOpen)
    return <SshLogDialog api={api} reference={shown.target} name={shown.name} onClose={() => setLogOpen(false)} />;
  if (question && question.kind !== 'close' && view.kind === 'steps') {
    return (
      <SshAskpassPrompt question={{ ...question, kind: question.kind }} name={shown.name} onAnswer={attempt.answer} />
    );
  }
  switch (view.kind) {
    case 'daemon':
      return (
        <SshDaemonDialog
          view={view}
          name={shown.name}
          onConfirm={attempt.restartAndConnect}
          onDismiss={() => attempt.dismissDaemon(field.closeMenu)}
        />
      );
    case 'steps':
      return (
        <SshStepsDialog view={view} shown={shown} summary={summary} onEdit={editAddress} onCancel={cancelAndClose} />
      );
    case 'forwards':
      return (
        <SshForwardsDialog
          forwards={view.forwards}
          name={shown.name}
          onContinue={attempt.acceptForwardsNotice}
          onCancel={cancelAndClose}
        />
      );
    case 'trust':
      return (
        <SshTrustDialog
          view={view}
          shown={shown}
          summary={summary}
          onConfirm={attempt.confirmHostKey}
          onCancel={cancelAndClose}
          onClose={onClose}
        />
      );
    case 'changed':
      return <SshChangedDialog view={view} summary={summary} onReplace={attempt.replaceHostKey} onClose={onClose} />;
    case 'failure':
      return (
        <SshFailureDialog
          view={view}
          name={shown.name}
          hasLog={Boolean(api.sshDiagnosticsLog)}
          onEdit={editAddress}
          onViewLog={() => setLogOpen(true)}
          onClose={onClose}
          onRetry={() => void attempt.run(shown.target, shown.name)}
        />
      );
    case 'input':
      return (
        <SshAddressDialog
          field={field}
          chooseKeyFile={chooseFile ? () => chooseFile().then((file) => file?.absolutePath ?? null) : undefined}
          onConnect={(target, name, settings) => void attempt.run(target, name, settings)}
          onClose={onClose}
        />
      );
  }
}
