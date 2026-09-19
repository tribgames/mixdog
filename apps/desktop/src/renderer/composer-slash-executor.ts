// Slash-command execution for the composer: one executor per render, bound
// to the pane's session/model props and the composer's notice/error sinks.
// Returns false when the command failed or was refused so the caller keeps
// the draft; true otherwise.
import type {
  DesktopCapability,
  DesktopCapabilityResult,
  DesktopModelSelection,
  DesktopPromptContent,
  DesktopSubmitOptions,
  SessionSnapshot,
} from '../shared/contract';
import { resolveDesktopSlashCommand, type CommandSurface as CommandSurfaceName, type SettingsSection } from './slash-commands';
import { TURN_LOCKED_SLASH_COMMANDS, asRecord } from './text-format';

export type SlashExecutorDeps = {
  draftMode?: boolean;
  sessionId?: string;
  turnBusy: boolean;
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  modelParameters?: Record<string, string>;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection) => void;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  invokeCapabilityResult: <T>(
    capability: DesktopCapability,
    args?: unknown[]
  ) => Promise<DesktopCapabilityResult<T> | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  setAttachmentError: (message: string) => void;
  clearNotice: () => void;
  showNotice: (message: string) => void;
  openGoalDialog: () => void;
  onNewTask: () => void;
  onClearToNewTask?: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenProjects: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
};

type SlashRun = { deps: SlashExecutorDeps; failed: boolean };
type SlashCommand = NonNullable<ReturnType<typeof resolveDesktopSlashCommand>>;

const STATUS_ARGUMENTS = ['status', 'current', 'show'];

export function createSlashExecutor(deps: SlashExecutorDeps) {
  return async (raw: string): Promise<boolean> => {
    const [token, ...tail] = raw.trim().slice(1).split(/\s+/);
    const rawName = token.toLowerCase();
    const argument = tail.join(' ').trim();
    const command = resolveDesktopSlashCommand(rawName);
    if (!command) {
      deps.setAttachmentError(`Unknown command: /${rawName}`);
      return false;
    }
    deps.setAttachmentError('');
    deps.clearNotice();
    if (deps.turnBusy && TURN_LOCKED_SLASH_COMMANDS.has(command.name)) {
      deps.setAttachmentError(`Wait for the current turn to finish before /${rawName}.`);
      return false;
    }
    const run: SlashRun = { deps, failed: false };
    const outcome = await runSlashCommand(run, command, rawName, argument);
    return outcome ?? !run.failed;
  };
}

// A resolved boolean ends the command; undefined falls through to the
// invocation-failure check.
async function runSlashCommand(
  run: SlashRun,
  command: SlashCommand,
  rawName: string,
  argument: string
): Promise<boolean | undefined> {
  const { deps } = run;
  const name = command.name;
  if (rawName === 'new' || name === 'clear') return runNewOrClear(run, rawName);
  if (name === 'goal') return runGoal(run, argument);
  if (name === 'fast') return runFast(run, argument);
  if (name === 'model' && argument) return runModel(run, argument);
  if (name === 'project') deps.onOpenProjects();
  else if (name === 'resume' && argument) deps.onResumeSession(argument);
  else if (name === 'resume') deps.onOpenSessions();
  else if (name === 'compact') await commandCapability(run, 'compact');
  else if (name === 'doctor') deps.onOpenCommandSurface('doctor');
  else if (name === 'settings') deps.onOpenSettings();
  // Desktop /quit leaves THIS task, not the app (user): it rides the same
  // close path as Ctrl+W, so unsaved-close guards and group collapse apply.
  // Explicit app quit stays in the File menu.
  else if (command.action === 'close-task') window.dispatchEvent(new CustomEvent('mixdog:close-active-tab'));
  else if (name === 'autoclear' && argument) await runAutoClear(run, argument);
  else if (name === 'outputstyle' && argument) await runOutputStyle(run, argument);
  else if (name === 'theme' && argument) await runTheme(run, argument);
  else if (name === 'effort' && argument) await runEffort(run, argument);
  else if (name === 'model') deps.onOpenSettings('model');
  else if (name === 'usage') await runUsage(run, argument);
  else if (command.surface) deps.onOpenCommandSurface(command.surface);
  else if (command.settingsRow) deps.onOpenSettings(command.settingsRow);
  return undefined;
}

// A draft pane only answers the read-only commands and the effort change
// (which becomes the draft's model selection); everything else needs a
// started task.
async function commandCapability<T>(run: SlashRun, capability: DesktopCapability, args: unknown[] = []) {
  const { deps } = run;
  if (deps.draftMode && capability === 'setEffort' && deps.onDraftModelSelection && deps.provider && deps.model) {
    const nextEffort = String(args[0] || deps.effort);
    deps.onDraftModelSelection(modelSelection(deps, { effort: nextEffort, ...(deps.fastCapable ? { fast: deps.fast } : {}) }));
    return nextEffort as T;
  }
  if (deps.draftMode && capability !== 'listPresets' && capability !== 'getUsageDashboard') {
    deps.setAttachmentError('Start the task with a message before running this command.');
    run.failed = true;
    return undefined;
  }
  const result = await deps.invokeCapabilityResult<T>(capability, args);
  if (result === undefined) {
    run.failed = true;
    return undefined;
  }
  return result.value;
}

function modelSelection(deps: SlashExecutorDeps, patch: { effort?: string; fast?: boolean }): DesktopModelSelection {
  const { provider, model, effort, modelParameters } = deps;
  return {
    provider,
    model,
    effort,
    ...patch,
    ...(modelParameters && Object.keys(modelParameters).length ? { modelParameters } : {}),
  };
}

// A session pane's /new and /clear close THIS session tab and open a New Task
// in its place (settings inherited). Outside a session pane the old routes
// remain: /new opens a draft, /clear clears the engine.
async function runNewOrClear(run: SlashRun, rawName: string): Promise<undefined> {
  const { deps } = run;
  if (!deps.draftMode && deps.sessionId && deps.onClearToNewTask) deps.onClearToNewTask();
  else if (rawName === 'new') deps.onNewTask();
  else await commandCapability(run, 'clear');
  return undefined;
}

async function runGoal(run: SlashRun, argument: string): Promise<boolean | undefined> {
  const { deps } = run;
  if (!argument) {
    deps.openGoalDialog();
    return true;
  }
  if (deps.draftMode) {
    const accepted = await deps.submit(argument, { displayText: argument, goalCommand: argument });
    return accepted === true ? undefined : false;
  }
  const result = asRecord(await commandCapability<unknown>(run, 'goalControl', [{ command: argument }]));
  if (!run.failed) deps.showNotice(String(result?.message || 'Goal updated.'));
  return undefined;
}

async function runAutoClear(run: SlashRun, argument: string) {
  const value = argument.toLowerCase();
  const statusQuery = STATUS_ARGUMENTS.includes(value);
  let patch: Record<string, unknown> = { duration: value };
  if (value === 'on' || value === 'enable' || value === 'enabled') patch = { enabled: true };
  else if (value === 'off' || value === 'disable' || value === 'disabled') patch = { enabled: false };
  const status = asRecord(
    await commandCapability<unknown>(run, statusQuery ? 'getAutoClear' : 'setAutoClear', statusQuery ? [] : [patch])
  );
  if (run.failed) return;
  run.deps.showNotice(`Auto-clear ${status?.enabled ? 'on' : 'off'}${status?.idleMs ? ` · idle ${status.idleMs}ms` : ''}`);
}

async function runOutputStyle(run: SlashRun, argument: string) {
  const statusOnly = STATUS_ARGUMENTS.includes(argument.toLowerCase());
  const value = await commandCapability<unknown>(
    run,
    statusOnly ? 'getOutputStyle' : 'setOutputStyle',
    statusOnly ? [] : [argument]
  );
  if (run.failed) return;
  const result = asRecord(value);
  const current = asRecord(result?.current);
  run.deps.showNotice(
    `Output style: ${String(current?.label || current?.id || result?.configured || result?.label || result?.id || argument)}`
  );
}

async function runTheme(run: SlashRun, argument: string) {
  const statusOnly = STATUS_ARGUMENTS.includes(argument.toLowerCase());
  const value = await commandCapability<unknown>(
    run,
    statusOnly ? 'getTheme' : 'setTheme',
    statusOnly ? [] : [argument, { persist: true }]
  );
  if (run.failed) return;
  const result = asRecord(value);
  run.deps.showNotice(`Theme: ${String(result?.label || result?.id || value || argument)}`);
}

async function runEffort(run: SlashRun, argument: string) {
  const next = await commandCapability<unknown>(run, 'setEffort', [argument]);
  if (!run.failed) run.deps.showNotice(`Effort set to ${String(next || argument)}`);
}

async function runUsage(run: SlashRun, argument: string) {
  if (['refresh', '--refresh', '-r', 'true'].includes(argument.toLowerCase())) {
    await commandCapability(run, 'getUsageDashboard', [{ refresh: true }]);
  }
  run.deps.onOpenCommandSurface('usage');
}

function parseFastArgument(argument: string, current: boolean): boolean | null {
  const value = argument.toLowerCase();
  if (!value) return !current;
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value)) return false;
  return null;
}

async function runFast(run: SlashRun, argument: string): Promise<boolean | undefined> {
  const { deps } = run;
  const nextFast = parseFastArgument(argument, deps.fast);
  if (nextFast === null) {
    deps.setAttachmentError('Usage: /fast [on|off]');
    return false;
  }
  if (deps.draftMode && deps.onDraftModelSelection && deps.provider && deps.model) {
    deps.onDraftModelSelection(modelSelection(deps, { fast: nextFast }));
  } else {
    const next = await deps.invokeResult(() => window.mixdogDesktop.setFast(nextFast, deps.sessionId || undefined));
    if (next === undefined) return false;
    deps.applySnapshot(next);
    if (deps.provider && deps.model) deps.onRoutePreferenceApplied?.(modelSelection(deps, { fast: nextFast }));
  }
  deps.showNotice(`Fast mode ${nextFast ? 'on' : 'off'}`);
  return undefined;
}

async function findPreset(run: SlashRun, argument: string) {
  const presetValue = await commandCapability<unknown>(run, 'listPresets');
  let presetSource: unknown[] = [];
  if (Array.isArray(presetValue)) presetSource = presetValue;
  else if (Array.isArray(asRecord(presetValue)?.presets)) presetSource = asRecord(presetValue)?.presets as unknown[];
  const wanted = argument.toLowerCase();
  return presetSource
    .map(asRecord)
    .find(
      (entry) =>
        entry && (String(entry.id || '').toLowerCase() === wanted || String(entry.name || '').toLowerCase() === wanted)
    );
}

async function runModel(run: SlashRun, argument: string): Promise<boolean | undefined> {
  const { deps } = run;
  if (argument.toLowerCase() === 'refresh') {
    const models = await deps.invokeResult(() => window.mixdogDesktop.listProviderModels({ quick: false }));
    if (models === undefined) return false;
    deps.onOpenSettings('model');
    return true;
  }
  const preset = await findPreset(run, argument);
  if (preset) {
    await commandCapability(run, 'setModel', [preset.id || preset.name]);
    return !run.failed;
  }
  const models = (await deps.invokeResult(() => window.mixdogDesktop.listProviderModels({ quick: false }))) || [];
  const normalized = argument.toLowerCase();
  const match = models.find(
    (entry) =>
      `${entry.provider}:${entry.model}`.toLowerCase() === normalized ||
      entry.model.toLowerCase() === normalized ||
      entry.display.toLowerCase() === normalized
  );
  if (!match) {
    deps.setAttachmentError(`Model not found: ${argument}`);
    return false;
  }
  const selection = { provider: match.provider, model: match.model };
  if (deps.draftMode && deps.onDraftModelSelection) {
    deps.onDraftModelSelection(selection);
    return true;
  }
  const sessionId = deps.sessionId;
  if (!sessionId) return false;
  const next = await deps.invokeResult(() => window.mixdogDesktop.setModelRoute(selection, sessionId));
  if (next === undefined) return false;
  deps.applySnapshot(next);
  deps.onRoutePreferenceApplied?.(selection);
  return undefined;
}
