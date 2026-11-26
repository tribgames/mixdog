export type MonacoWorkerKind = 'editor' | 'json' | 'css' | 'html';

export type MonacoLanguageServiceLabel = 'json' | 'css' | 'scss' | 'less' | 'html' | 'handlebars' | 'razor';

export interface MonacoLanguageServiceDefaultsLike {
  readonly modeConfiguration: Readonly<Record<string, unknown>>;
  setModeConfiguration(modeConfiguration: Record<string, unknown>): void;
}

export interface MonacoWorkerFactories {
  editor(): Worker;
  json(): Worker;
  css(): Worker;
  html(): Worker;
}

export function monacoWorkerKindForLabel(label: string): MonacoWorkerKind {
  switch (label) {
    case 'json':
      return 'json';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'html':
    case 'handlebars':
    case 'razor':
      return 'html';
    default:
      return 'editor';
  }
}

function isLanguageServiceLabel(label: string): label is MonacoLanguageServiceLabel {
  return (
    label === 'json' ||
    label === 'css' ||
    label === 'scss' ||
    label === 'less' ||
    label === 'html' ||
    label === 'handlebars' ||
    label === 'razor'
  );
}

function isCssLanguageServiceLabel(label: MonacoLanguageServiceLabel): boolean {
  return label === 'css' || label === 'scss' || label === 'less';
}

export interface MonacoWorkerLifecycle {
  createWorker(label: string): Worker;
  stopWorkers(): void;
  wakeWorkers(): void;
  readonly activeLabels: ReadonlySet<string>;
}

export function createMonacoWorkerLifecycle({
  factories,
  getLanguageDefaults,
  stopEditorWorker,
  hasLiveModels,
}: {
  factories: MonacoWorkerFactories;
  getLanguageDefaults(label: MonacoLanguageServiceLabel): MonacoLanguageServiceDefaultsLike | undefined;
  stopEditorWorker(): void;
  hasLiveModels?(label: MonacoLanguageServiceLabel): boolean;
}): MonacoWorkerLifecycle {
  const activeLabels = new Set<string>();
  const pausedModeConfigs = new Map<MonacoLanguageServiceLabel, Record<string, unknown>>();
  let editorWorkerActive = false;

  return {
    createWorker(label: string): Worker {
      const kind = monacoWorkerKindForLabel(label);
      activeLabels.add(label);
      if (kind === 'editor') editorWorkerActive = true;
      return factories[kind]();
    },

    stopWorkers(): void {
      // Snapshot and clear before stopping so any synchronous worker respawn
      // inside Monaco's mode listeners is tracked in `activeLabels` rather than erased.
      const labelsToStop = [...activeLabels];
      activeLabels.clear();

      for (const label of labelsToStop) {
        if (!isLanguageServiceLabel(label)) continue;
        const defaults = getLanguageDefaults(label);
        if (!defaults) continue;
        // cssMode's DiagnosticsAdapter stays attached across setModeConfiguration and
        // immediately re-validates (respawning cssWorker) if any live model matches.
        // Leave the CSS worker tracked until its last live model is disposed.
        if (isCssLanguageServiceLabel(label) && hasLiveModels?.(label)) {
          activeLabels.add(label);
          continue;
        }
        const saved = pausedModeConfigs.get(label) ?? { ...defaults.modeConfiguration };
        pausedModeConfigs.set(label, saved);
        defaults.setModeConfiguration({ ...saved, diagnostics: false });
        // jsonMode's DiagnosticsAdapter runs onDidChange before jsonMode's own
        // listener disposes it, so a live hidden JSON model respawns jsonWorker on
        // the first call. A second call after DiagnosticsAdapter is disposed stops it cleanly.
        if (label === 'json' && activeLabels.has(label)) {
          activeLabels.delete(label);
          defaults.setModeConfiguration({ ...saved, diagnostics: false });
        }
      }
      if (editorWorkerActive) {
        editorWorkerActive = false;
        stopEditorWorker();
      }
    },

    wakeWorkers(): void {
      if (pausedModeConfigs.size === 0) return;
      for (const [label, saved] of pausedModeConfigs) {
        const defaults = getLanguageDefaults(label);
        defaults?.setModeConfiguration({ ...saved });
      }
      pausedModeConfigs.clear();
    },

    get activeLabels(): ReadonlySet<string> {
      return activeLabels;
    },
  };
}

let activeWorkerLifecycle: Pick<MonacoWorkerLifecycle, 'stopWorkers' | 'wakeWorkers'> | null = null;

export function installMonacoWorkerLifecycle(
  lifecycle: Pick<MonacoWorkerLifecycle, 'stopWorkers' | 'wakeWorkers'>
): void {
  activeWorkerLifecycle = lifecycle;
}

export function stopMonacoLanguageWorkers(): void {
  activeWorkerLifecycle?.stopWorkers();
}

export function wakeMonacoLanguageWorkers(): void {
  activeWorkerLifecycle?.wakeWorkers();
}
