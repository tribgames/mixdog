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

export function formatEngineBytes(bytes: unknown): string {
  const val = Number(bytes);
  if (!Number.isFinite(val) || val <= 0) return '';
  if (val < 1024 * 1024) {
    return `${(val / 1024).toFixed(1)} KB`;
  }
  return `${(val / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export async function readTidyEngineStatus(api: PanelContext['api']): Promise<DesktopTidyEngineStatus | null> {
  const request = { capability: 'getTidyEngineStatus' as const, args: [] };
  if (api.readCapabilities) {
    const [result] = await api.readCapabilities([request]);
    if (result?.ok) return result.value as DesktopTidyEngineStatus;
  } else if (api.invokeCapability) {
    const res = await api.invokeCapability(request);
    return (res?.value as DesktopTidyEngineStatus) ?? null;
  }
  return null;
}

export async function readTidyInstallStatus(api: PanelContext['api']): Promise<DesktopTidyInstallStatus | null> {
  const request = { capability: 'getTidyInstallStatus' as const, args: [] };
  if (api.readCapabilities) {
    const [result] = await api.readCapabilities([request]);
    if (result?.ok) return result.value as DesktopTidyInstallStatus;
  } else if (api.invokeCapability) {
    const res = await api.invokeCapability(request);
    return (res?.value as DesktopTidyInstallStatus) ?? null;
  }
  return null;
}

/** `optional` engines are the ones nothing is waiting on: a host toolchain
 *  that is simply absent, or a managed engine that downloads on first use.
 *  The panel folds those away so the list shows what is actually there. */
export type TidyEngineRowState = 'installed' | 'downloading' | 'failed' | 'pending' | 'optional';

export function engineRowState({
  engine,
  installEngine,
  isInstallingActive,
}: {
  engine: DesktopTidyEngine;
  installEngine?: DesktopTidyInstallEngine | null;
  isInstallingActive?: boolean;
}): {
  tag: SidebarResourceTag | null;
  description: string;
  tone: ExtensionItemTone;
  state: TidyEngineRowState;
} {
  // 1. Installed / present engines take precedence over failure states
  const isInstalled =
    engine.source === 'managed' ||
    engine.source === 'host' ||
    installEngine?.status === 'installed' ||
    installEngine?.status === 'present';

  if (isInstalled) {
    const parts: string[] = [];
    if (engine.languages?.length) {
      parts.push(engine.languages.join(', '));
    }
    const version = engine.version || installEngine?.version;
    if (version) {
      parts.push(version);
    }
    const bytes = typeof engine.bytes === 'number' && engine.bytes > 0 ? engine.bytes : installEngine?.bytes;
    if ((engine.source === 'managed' || engine.managed) && typeof bytes === 'number' && bytes > 0) {
      parts.push(formatEngineBytes(bytes));
    }
    return {
      tag: null,
      description: parts.join(' · '),
      tone: 'ok',
      state: 'installed',
    };
  }

  // 2. Actively downloading/installing
  if (
    isInstallingActive &&
    installEngine &&
    (installEngine.status === 'downloading' ||
      (installEngine.receivedBytes > 0 &&
        installEngine.status !== 'installed' &&
        installEngine.status !== 'present' &&
        installEngine.status !== 'failed' &&
        installEngine.status !== 'skipped'))
  ) {
    const receivedMB = formatMB(installEngine.receivedBytes);
    const totalMB =
      typeof installEngine.totalBytes === 'number' && installEngine.totalBytes > 0
        ? formatMB(installEngine.totalBytes)
        : null;
    const progressText = totalMB
      ? t('Downloading {{received}} MB / {{total}} MB', {
          received: receivedMB,
          total: totalMB,
        })
      : t('Downloading {{received}} MB', { received: receivedMB });
    return {
      tag: { label: t('Not installed'), tone: 'muted' },
      description: progressText,
      tone: 'muted',
      state: 'downloading',
    };
  }

  // 3. Failed during install
  if (installEngine?.status === 'failed' || (engine as { error?: string }).error) {
    const error = installEngine?.error || (engine as { error?: string }).error || t('Installation failed');
    return {
      tag: { label: t('Failed'), tone: 'danger' },
      description: error,
      tone: 'warn',
      state: 'failed',
    };
  }

  // 4. Skipped (e.g. host toolchain or shell dependency missing)
  if (installEngine?.status === 'skipped') {
    return {
      tag: { label: t('Not detected'), tone: 'muted' },
      description:
        installEngine.installHint ||
        engine.installHint ||
        (engine.languages?.length ? engine.languages.join(', ') : ''),
      tone: 'muted',
      state: 'optional',
    };
  }

  // 5. Toolchain host engine missing
  if (engine.toolchain || !engine.managed) {
    return {
      tag: { label: t('Not detected'), tone: 'muted' },
      description: engine.installHint || (engine.languages?.length ? engine.languages.join(', ') : ''),
      tone: 'muted',
      state: 'optional',
    };
  }

  // 6. Core engine missing
  if (engine.core) {
    return {
      tag: { label: t('Not installed'), tone: 'muted' },
      description: engine.languages?.length ? engine.languages.join(', ') : '',
      tone: 'muted',
      state: 'pending',
    };
  }

  // 7. Non-core managed and missing
  return {
    tag: { label: t('On demand'), tone: 'muted' },
    description: engine.languages?.length ? engine.languages.join(', ') : '',
    tone: 'muted',
    state: 'optional',
  };
}

export function useTidyEngineStatus(api: PanelContext['api'], active: boolean, installing: boolean) {
  const [status, setStatus] = useState<DesktopTidyEngineStatus | null>(null);
  const [installStatus, setInstallStatus] = useState<DesktopTidyInstallStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await readTidyEngineStatus(api);
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
        const next = await readTidyInstallStatus(api);
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
