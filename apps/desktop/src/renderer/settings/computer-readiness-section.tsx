import { Accessibility, AppWindow, ClipboardList, MousePointer2, Monitor, ScanText, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { DesktopApi, DesktopComputerReadiness } from '../../shared/contract';
import type { DesktopComputerInputAccess, DesktopPcAccessApproval } from '../../shared/contract-computer';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import {
  computerReadinessPending,
  computerReadinessRows,
  type ComputerReadinessIcon,
  type ComputerReadinessRow,
} from './computer-readiness';
import {
  ExtensionAction,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
} from './extension-detail';

type ReadinessApi = Partial<
  Pick<
    DesktopApi,
    'computerReadiness' | 'requestLinuxInputAccess' | 'openComputerPermissionSettings' | 'approvePcAccess'
  >
>;

/** While something is pending the dialog re-reads this often, so the section
 *  disappears by itself once the user (or the app) has finished the setup. */
export const COMPUTER_READINESS_POLL_MS = 3000;

/** Reads Computer Use readiness: once on mount, on every window focus (the
 *  user comes back from System Settings or a terminal), and every few seconds
 *  while `polling` and something is still pending. */
export function useComputerReadiness(api: ReadinessApi, polling: boolean) {
  const [readiness, setReadiness] = useState<DesktopComputerReadiness | null>(null);
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const next = await api.computerReadiness?.();
      if (next && ticket === latest.current) setReadiness(next);
    } catch {
      // Keep the last known state; the next read replaces it.
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      latest.current += 1;
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  const rows = useMemo(() => computerReadinessRows(readiness), [readiness]);
  const pending = computerReadinessPending(rows);
  useEffect(() => {
    if (!polling || !pending) return;
    const timer = window.setInterval(() => void refresh(), COMPUTER_READINESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, pending, refresh]);
  return { readiness, rows, refresh };
}

const ICONS: Record<ComputerReadinessIcon, ReactNode> = {
  pointer: <MousePointer2 size={16} />,
  window: <AppWindow size={16} />,
  clipboard: <ClipboardList size={16} />,
  text: <ScanText size={16} />,
  monitor: <Monitor size={16} />,
  accessibility: <Accessibility size={16} />,
  shield: <ShieldCheck size={16} />,
};

/** The translated line for a failed Allow, chosen from the structured result (never the English diagnostic). */
export function inputAccessError(result: DesktopComputerInputAccess | undefined): string {
  const base = t('Mouse and keyboard access could not be allowed.');
  if (!result || result.ok) return base;
  let detail = '';
  if (result.reason === 'access_unavailable') {
    detail =
      result.detail === 'no-module'
        ? t('The uinput kernel module is not available on this system.')
        : t('Sign out and back in, or add your user to the input group, then try again.');
  } else if (result.reason === 'failed' && result.exitCode !== undefined) {
    detail = t('The repair script failed (exit {{code}}).', { code: result.exitCode });
  } else if (result.reason === 'cancelled') {
    detail = t('Authorization was cancelled.');
  } else if (result.reason === 'pkexec_missing') {
    detail = t('pkexec is not installed, so access cannot be set up from here.');
  }
  return detail ? `${base} ${detail}` : base;
}

/** The translated line for a PC access Approve that did not set it up, chosen
 *  from the outcome (never the English `detail`); a failure that came from the
 *  installer exiting adds its exit code, the way a failed Allow adds the repair
 *  script's. Empty when it succeeded or there was nothing to approve. */
export function pcAccessApprovalError(result: DesktopPcAccessApproval | undefined): string {
  switch (result?.outcome) {
    case 'done':
    case 'nothing-to-do':
      return '';
    case 'declined':
      return t('PC access was not approved because the administrator prompt was declined or closed.');
    case 'in-progress':
      return t('PC access is already waiting for an open administrator prompt. Answer it on this PC.');
    case 'other-user':
      return t('PC access is already set up by another Windows account on this PC.');
    case 'unavailable':
      return t('PC access is not available on this PC.');
    default: {
      const base = t('PC access could not be set up.');
      return result?.exitCode === undefined
        ? base
        : `${base} ${t('The PC access installer failed (exit {{code}}).', { code: result.exitCode })}`;
    }
  }
}

/** Hidden entirely when nothing is pending. */
export function ComputerReadinessSection({
  rows,
  api,
  refresh,
}: {
  rows: readonly ComputerReadinessRow[];
  api: ReadinessApi;
  refresh(): Promise<void>;
}) {
  const [error, setError] = useState('');
  const [howTo, setHowTo] = useState<{ id: string; package: string } | null>(null);
  /** The row whose action is still running (its button is disabled meanwhile). */
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows.length) return null;
  const run = async (row: ComputerReadinessRow) => {
    const action = row.action;
    if (!action || busy) return;
    setError('');
    setBusy(row.id);
    try {
      if (action.kind === 'install_how') {
        setHowTo((open) => (open?.id === row.id ? null : { id: row.id, package: action.package }));
      } else if (action.kind === 'open_settings') {
        await api.openComputerPermissionSettings?.(action.pane);
      } else if (action.kind === 'approve_pc_access') {
        // One UAC prompt on this PC; every outcome but success says why.
        setError(pcAccessApprovalError(await api.approvePcAccess?.()));
        await refresh();
      } else if (action.kind === 'allow_input') {
        const result = await api.requestLinuxInputAccess?.();
        if (!result?.ok) setError(inputAccessError(result));
        await refresh();
      } else {
        await refresh();
      }
    } catch (failure) {
      setError(String((failure as Error)?.message || failure));
    } finally {
      setBusy(null);
    }
  };
  const waitingForPrompt = rows.some((row) => row.id === busy && row.action?.kind === 'approve_pc_access');
  return (
    <ExtensionSection
      title={t('Readiness')}
      description={t('Items that are not ready yet. This section disappears once everything is ready.')}
      dataAttributes={{ 'data-computer-readiness': 'true' }}
    >
      <ExtensionItemList>
        {rows.map((row) => (
          <ExtensionItemRow
            key={row.id}
            icon={ICONS[row.icon]}
            title={row.title}
            description={row.description}
            status={row.status}
            tone={row.tone}
            dataAttributes={{ 'data-readiness-row': row.id }}
            control={
              row.action ? (
                <ExtensionAction disabled={busy !== null} onClick={() => void run(row)}>
                  {row.action.label}
                </ExtensionAction>
              ) : undefined
            }
          />
        ))}
      </ExtensionItemList>
      {howTo ? (
        <ExtensionNote role="status">
          {t('Install the {{package}} package with your package manager, for example: {{command}}', {
            package: howTo.package,
            command: `sudo apt install ${howTo.package}`,
          })}
        </ExtensionNote>
      ) : null}
      {waitingForPrompt ? (
        <ExtensionNote role="status">
          {t('PC access is waiting for the administrator prompt. Approve it on this PC to continue.')}
        </ExtensionNote>
      ) : null}
      <ErrorNotice errors={[error]} />
    </ExtensionSection>
  );
}
