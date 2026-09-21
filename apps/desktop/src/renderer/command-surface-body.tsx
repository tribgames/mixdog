import type React from 'react';
import type { DesktopCapability, DesktopModelSelection } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';
import { commandSurfaceDisplaySnapshot } from './command-surface-state';
import { t } from './i18n';
import { ContextBody } from './ContextBody';
import { UsageStatsBody } from './UsageStatsSurface';
import { UsageBody } from './command-surface-usage';
import { InheritBody } from './command-surface-inherit';

type SurfaceRun = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;

export function pretty(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function Group({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <section className="settings-group">
      <header>
        <h3>{title}</h3>
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

export function SurfaceBody({
  surface,
  data,
  snapshot,
  sessionId,
  onInherit,
  onClose,
  loading,
  pending,
  run,
  request,
}: {
  surface: CommandSurfaceName;
  data: Record<string, unknown>;
  snapshot?: unknown;
  sessionId?: string;
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  onClose?: () => void;
  loading?: boolean;
  pending: string;
  run: SurfaceRun;
  request: SurfaceRun;
}) {
  const busy = Boolean(pending);
  if (surface === 'context') {
    return (
      <ContextBody
        status={data.contextStatus}
        snapshot={commandSurfaceDisplaySnapshot(data, snapshot)}
        request={request}
        loading={loading}
      />
    );
  }
  if (surface === 'usage') {
    return <UsageBody data={data} />;
  }
  if (surface === 'stats') {
    return <UsageStatsBody data={data} request={request} loading={loading} />;
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
      <Group title={t('Diagnostic result')}>
        <pre className="tool-detail">{pretty(data.runDoctor) || t('No data available.')}</pre>
        <button type="button" disabled={busy} onClick={() => void run('runDoctor')}>
          {t('Run diagnostics again')}
        </button>
      </Group>
    );
  }
  return null;
}
