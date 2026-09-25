import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopTidyEngine,
  DesktopTidyEngineStatus,
  DesktopTidyInstallEngine,
  DesktopTidyInstallStatus,
} from '../../shared/contract';
import { t } from '../i18n';
import type { SidebarResourceTag } from '../sidebar-resource-row';
import type { PanelContext } from './capability-data';
import type { ExtensionItemTone } from './extension-detail';

function formatEngineBytes(bytes: unknown): string {
  const val = Number(bytes);
  if (!Number.isFinite(val) || val <= 0) return '';
  if (val < 1024 * 1024) {
    return `${(val / 1024).toFixed(1)} KB`;
  }
  return `${(val / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function readTidyCapability<T>(
  api: PanelContext['api'],
  capability: 'getTidyEngineStatus' | 'getTidyInstallStatus'
): Promise<T | null> {
  const request = { capability, args: [] };
  if (api.readCapabilities) {
    const [result] = await api.readCapabilities([request]);
    if (result?.ok) return result.value as T;
  } else if (api.invokeCapability) {
    const res = await api.invokeCapability(request);
    return (res?.value as T) ?? null;
  }
  return null;
}

/** `optional` engines are the ones nothing is waiting on: a host toolchain
 *  that is simply absent, or a managed engine that downloads on first use.
 *  The panel folds those away so the list shows what is actually there. */
export type TidyEngineRowState = 'installed' | 'downloading' | 'failed' | 'pending' | 'optional';

type TidyEngineRow = {
  tag: SidebarResourceTag | null;
  description: string;
  tone: ExtensionItemTone;
  state: TidyEngineRowState;
};

function engineLanguages(engine: DesktopTidyEngine): string {
  return engine.languages?.length ? engine.languages.join(', ') : '';
}

// Languages, version and (for managed engines) the payload size.
function installedEngineDescription(
  engine: DesktopTidyEngine,
  installEngine?: DesktopTidyInstallEngine | null
): string {
  const parts: string[] = [];
  if (engine.languages?.length) parts.push(engine.languages.join(', '));
  const version = engine.version || installEngine?.version;
  if (version) parts.push(version);
  const bytes = typeof engine.bytes === 'number' && engine.bytes > 0 ? engine.bytes : installEngine?.bytes;
  if ((engine.source === 'managed' || engine.managed) && typeof bytes === 'number' && bytes > 0) {
    parts.push(formatEngineBytes(bytes));
  }
  return parts.join(' · ');
}

function engineDownloading(installEngine: DesktopTidyInstallEngine): boolean {
  return (
    installEngine.status === 'downloading' ||
    (installEngine.receivedBytes > 0 &&
      installEngine.status !== 'installed' &&
      installEngine.status !== 'present' &&
      installEngine.status !== 'failed' &&
      installEngine.status !== 'skipped')
  );
}

function downloadProgressText(installEngine: DesktopTidyInstallEngine): string {
  const receivedMB = formatMB(installEngine.receivedBytes);
  const totalMB =
    typeof installEngine.totalBytes === 'number' && installEngine.totalBytes > 0
      ? formatMB(installEngine.totalBytes)
      : null;
  return totalMB
    ? t('Downloading {{received}} MB / {{total}} MB', { received: receivedMB, total: totalMB })
    : t('Downloading {{received}} MB', { received: receivedMB });
}

// An engine that is neither installed, downloading nor failed: skipped by the
// installer, a host toolchain to install by hand, a core engine still pending,
// or a managed engine fetched on demand.
function missingEngineRow(engine: DesktopTidyEngine, installEngine?: DesktopTidyInstallEngine | null): TidyEngineRow {
  if (installEngine?.status === 'skipped') {
    return {
      tag: { label: t('Not detected'), tone: 'muted' },
      description: installEngine.installHint || engine.installHint || engineLanguages(engine),
      tone: 'muted',
      state: 'optional',
    };
  }
  if (engine.toolchain || !engine.managed) {
    return {
      tag: { label: t('Not detected'), tone: 'muted' },
      description: engine.installHint || engineLanguages(engine),
      tone: 'muted',
      state: 'optional',
    };
  }
  if (engine.core) {
    return {
      tag: { label: t('Not installed'), tone: 'muted' },
      description: engineLanguages(engine),
      tone: 'muted',
      state: 'pending',
    };
  }
  return {
    tag: { label: t('On demand'), tone: 'muted' },
    description: engineLanguages(engine),
    tone: 'muted',
    state: 'optional',
  };
}

export function engineRowState({
  engine,
  installEngine,
  isInstallingActive,
}: {
  engine: DesktopTidyEngine;
  installEngine?: DesktopTidyInstallEngine | null;
  isInstallingActive?: boolean;
}): TidyEngineRow {
  // Installed / present engines take precedence over failure states.
  const isInstalled =
    engine.source === 'managed' ||
    engine.source === 'host' ||
    installEngine?.status === 'installed' ||
    installEngine?.status === 'present';
  if (isInstalled) {
    return {
      tag: null,
      description: installedEngineDescription(engine, installEngine),
      tone: 'ok',
      state: 'installed',
    };
  }
  if (isInstallingActive && installEngine && engineDownloading(installEngine)) {
    return {
      tag: { label: t('Not installed'), tone: 'muted' },
      description: downloadProgressText(installEngine),
      tone: 'muted',
      state: 'downloading',
    };
  }
  if (installEngine?.status === 'failed' || (engine as { error?: string }).error) {
    const error = installEngine?.error || (engine as { error?: string }).error || t('Installation failed');
    return { tag: { label: t('Failed'), tone: 'danger' }, description: error, tone: 'warn', state: 'failed' };
  }
  return missingEngineRow(engine, installEngine);
}

export function useTidyEngineStatus(api: PanelContext['api'], active: boolean, installing: boolean) {
  const [status, setStatus] = useState<DesktopTidyEngineStatus | null>(null);
  const [installStatus, setInstallStatus] = useState<DesktopTidyInstallStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await readTidyCapability<DesktopTidyEngineStatus>(api, 'getTidyEngineStatus');
      if (next) {
        setStatus(next);
      }
      return next;
    } catch {
      return null;
    }
  }, [api]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!installing) {
      setInstallStatus(null);
      return;
    }
    setInstallStatus(null);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await readTidyCapability<DesktopTidyInstallStatus>(api, 'getTidyInstallStatus');
        if (!disposed && next) {
          setInstallStatus(next);
        }
      } catch {
        /* a status read failure is not an installation failure */
      }
      if (!disposed) {
        timer = setTimeout(poll, 500);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, installing]);

  return {
    status,
    installStatus,
    refresh,
  };
}
