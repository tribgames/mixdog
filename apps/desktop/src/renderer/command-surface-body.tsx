import type { DesktopCapability, DesktopModelSelection } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import type { SurfaceApi } from './command-surface-cache';
import { commandSurfaceDisplaySnapshot } from './command-surface-state';
import { ContextBody } from './ContextBody';
import { UsageSurfaceBody } from './UsageSurface';
import type { UsageSurfaceMode } from './usage-surface-mode';
import { UsageBody } from './command-surface-usage';
import { InheritBody } from './command-surface-inherit';
import { DoctorBody } from './command-surface-doctor';

type SurfaceRun = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;

export function SurfaceBody({
  surface,
  data,
  snapshot,
  sessionId,
  onInherit,
  onClose,
  onOpenSettings,
  loading,
  pending,
  run,
  request,
  api,
  usageMode = 'tokens',
}: {
  surface: CommandSurfaceName;
  data: Record<string, unknown>;
  snapshot?: unknown;
  sessionId?: string;
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection, options?: { compact: boolean }) => Promise<void>;
  onClose?: () => void;
  /** /doctor only: open the settings page that fixes a failing check. */
  onOpenSettings?: (section: SettingsSection) => void;
  loading?: boolean;
  pending: string;
  run: SurfaceRun;
  request: SurfaceRun;
  api: SurfaceApi;
  /** Which question the usage dialog shows (its header tabs choose). */
  usageMode?: UsageSurfaceMode;
}) {
  const busy = Boolean(pending);
  if (surface === 'context') {
    return (
      <ContextBody
        status={data.contextStatus}
        snapshot={commandSurfaceDisplaySnapshot(data, snapshot)}
        sessionUsage={data.getSessionUsage}
        request={request}
        loading={loading}
        readingInHeader
      />
    );
  }
  if (surface === 'usage') {
    return <UsageBody data={data} />;
  }
  if (surface === 'stats') {
    return <UsageSurfaceBody data={data} request={request} api={api} loading={loading} mode={usageMode} />;
  }
  if (surface === 'inherit') {
    return (
      <InheritBody
        snapshot={commandSurfaceDisplaySnapshot(data, snapshot)}
        sessionId={sessionId ?? ''}
        loading={loading}
        onInherit={onInherit}
        onClose={onClose}
      />
    );
  }
  if (surface === 'doctor') {
    return (
      <DoctorBody
        value={data.runDoctor}
        running={busy}
        onRerun={() => void run('runDoctor')}
        onOpenSettings={onOpenSettings}
      />
    );
  }
  return null;
}
