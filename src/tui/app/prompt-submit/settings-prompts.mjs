/**
 * src/tui/app/prompt-submit/settings-prompts.mjs - text-entry prompts opened
 * from the settings/project/profile pickers and the extension surfaces
 * (plugins, MCP servers, skills, core memory). Daemon-acknowledged writes go
 * through the settings panel-write; extension writes close the prompt at
 * once and report through notices.
 */
import { memoryCoreResultErrorText, parseMcpServerInput, parseSkillInput } from '../input-parsers.mjs';
import { projectNameFromPath } from '../app-format.mjs';
import { isPanelEpochCurrent, supersedePanelEpoch } from '../panel-epoch.mjs';

// One acknowledged settings write: begin → serviceCall → finish(after) or
// fail(restore typed value). `value` is what a failure restores.
function settingsSave(ctx, target, value, { method, args, onSaved, after, failurePrefix }) {
  const { serviceCall, settingsWrite } = ctx;
  const token = settingsWrite.begin(target);
  void serviceCall(method, ...args)
    .then((result) => {
      onSaved?.(result);
      settingsWrite.finish(token, after);
    })
    .catch((error) => {
      settingsWrite.fail(target, value, `${failurePrefix}: ${error?.message || error}`, token);
    });
  return true;
}

function requireText(ctx, commandText, notice) {
  if (commandText) return true;
  ctx.store.pushNotice(notice, 'warn');
  return false;
}

function setCwd(ctx, target, commandText) {
  if (!requireText(ctx, commandText, 'working directory path is required')) return false;
  return settingsSave(ctx, target, commandText, {
    method: 'setCwd',
    args: [commandText, { message: `Project set: ${projectNameFromPath(commandText)}` }],
    after: () => ctx.openPanel(ctx.openSettingsPicker),
    failurePrefix: 'project switch failed',
  });
}

function projectNew(ctx, target, commandText) {
  if (!requireText(ctx, commandText, 'project path is required')) return false;
  const { serviceCall, settingsWrite, setSettingsPrompt, openPanel, registerProject } = ctx;
  const token = settingsWrite.begin(target);
  void serviceCall('inspectProjectPath', commandText)
    .then((result) => {
      const path = String(result?.path || commandText);
      if (result?.directory === true) {
        settingsWrite.finish(token, () => openPanel(registerProject, path));
        return;
      }
      if (result?.exists === true) {
        settingsWrite.fail(target, commandText, `${path} is not a directory`, token, 'warn');
        return;
      }
      settingsWrite.end(token);
      if (!isPanelEpochCurrent(token)) return;
      supersedePanelEpoch();
      setSettingsPrompt({
        kind: 'project-create-confirm',
        label: 'New project · Create folder?',
        hint: `${path} does not exist. Type "y" to create it, or anything else to cancel.`,
        pendingPath: path,
      });
    })
    .catch((error) => {
      settingsWrite.fail(target, commandText, `project path check failed: ${error?.message || error}`, token);
    });
  return true;
}

function isYes(commandText) {
  const answer = String(commandText || '')
    .trim()
    .toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function projectCreateConfirm(ctx, target, commandText) {
  const { store, serviceCall, settingsWrite, setSettingsPrompt, openPanel, registerProject } = ctx;
  const pendingPath = String(target.pendingPath || '');
  if (!isYes(commandText)) {
    setSettingsPrompt(null);
    store.pushNotice('project creation canceled', 'info');
    return true;
  }
  const token = settingsWrite.begin(target);
  void serviceCall('ensureProjectDirectory', pendingPath)
    .then((created) => {
      settingsWrite.finish(token, () => openPanel(registerProject, created || pendingPath));
    })
    .catch((error) => {
      settingsWrite.end(token);
      store.pushNotice(`could not create folder: ${error?.message || error}`, 'error');
      // The typed value here is only the y/n answer, so close rather
      // than restore — but never close a surface we no longer own.
      if (isPanelEpochCurrent(token)) setSettingsPrompt(null);
    });
  return true;
}

function projectRename(ctx, target, commandText) {
  return settingsSave(ctx, target, commandText, {
    method: 'renameProject',
    args: [String(target.projectPath || ''), commandText],
    onSaved: (updated) => {
      if (updated) ctx.store.pushNotice(`project renamed to "${updated.name}"`, 'info');
    },
    after: () => ctx.openPanel(ctx.openProjectPicker),
    failurePrefix: 'rename failed',
  });
}

function systemShell(ctx, target, commandText) {
  // Empty is the documented reset to automatic selection.
  return settingsSave(ctx, target, commandText, {
    method: 'setSystemShell',
    args: [commandText],
    after: () => ctx.openPanel(ctx.openSettingsPicker),
    failurePrefix: 'system shell update failed',
  });
}

function autoClearProvider(ctx, target, commandText) {
  const provider = String(target.provider || '').trim();
  if (!provider) {
    ctx.store.pushNotice('auto-clear provider is missing', 'warn');
    return false;
  }
  const duration = String(commandText || '').trim();
  // Empty is the documented reset to the built-in provider default.
  return settingsSave(ctx, target, duration, {
    method: 'setAutoClear',
    args: [duration ? { provider, duration } : { provider, resetProvider: true }],
    onSaved: () => {
      ctx.store.pushNotice(
        duration ? `Auto-clear ${provider} default set to ${duration}` : `Auto-clear ${provider} default reset`,
        'info'
      );
    },
    after: () => ctx.openPanel(ctx.openAutoClearPicker, { advanced: true, returnTo: target.returnTo }),
    failurePrefix: 'autoclear failed',
  });
}

function profileTitle(ctx, target, commandText) {
  // Empty is the documented "clear the title" action.
  return settingsSave(ctx, target, commandText, {
    method: 'setProfile',
    args: [{ title: commandText }],
    onSaved: () => {
      ctx.store.pushNotice(commandText ? `Title set to "${commandText.trim()}"` : 'Title cleared', 'info');
    },
    after: () => ctx.openPanel(ctx.openProfilePicker),
    failurePrefix: 'profile update failed',
  });
}

// Extension adds close the prompt immediately; the store call reports back
// through a notice and reopens the owning picker on success.
function extensionAdd(ctx, { method, value, reopen, failurePrefix }) {
  const { store, setSettingsPrompt } = ctx;
  void store[method]?.(value)
    .then(() => reopen())
    .catch((e) => store.pushNotice(`${failurePrefix}: ${e?.message || e}`, 'error'));
  setSettingsPrompt(null);
  return true;
}

function pluginAdd(ctx, _target, commandText) {
  if (!requireText(ctx, commandText, 'plugin URL/path is required')) return false;
  return extensionAdd(ctx, {
    method: 'addPlugin',
    value: commandText,
    reopen: ctx.openPluginsPicker,
    failurePrefix: 'plugin add failed',
  });
}

function mcpAdd(ctx, _target, commandText) {
  const parsed = parseMcpServerInput(commandText);
  if (parsed.error) {
    ctx.store.pushNotice(parsed.error, 'warn');
    return false;
  }
  return extensionAdd(ctx, {
    method: 'addMcpServer',
    value: parsed.server,
    reopen: ctx.openMcpServersPicker,
    failurePrefix: 'mcp add failed',
  });
}

function skillAdd(ctx, _target, commandText) {
  const parsed = parseSkillInput(commandText);
  if (parsed.error) {
    ctx.store.pushNotice(parsed.error, 'warn');
    return false;
  }
  return extensionAdd(ctx, {
    method: 'addSkill',
    value: parsed.skill,
    reopen: ctx.openProjectSkillsPicker,
    failurePrefix: 'skill add failed',
  });
}

function skillUse(ctx, target, commandText) {
  const skillName = String(target.skillName || '').trim();
  if (!skillName) {
    ctx.store.pushNotice('skill name is missing', 'warn');
    return false;
  }
  const prompt = `$${skillName}${commandText ? ` ${commandText}` : ''}`;
  ctx.setSettingsPrompt(null);
  const accepted = ctx.submitPrompt(prompt);
  if (accepted) ctx.armTranscriptFollow();
  return accepted;
}

// Core memory writes: the prompt closes first; the result (or an error text
// carried inside a successful reply) lands as a notice and the picker reopens.
function coreMemoryWrite(ctx, args, { success, failurePrefix }) {
  const { store, openMemoryCorePicker } = ctx;
  void store
    .memoryControl?.(args, { silent: true })
    .then((result) => {
      const errText = memoryCoreResultErrorText(result);
      store.pushNotice(errText || success, errText ? 'error' : 'info');
      openMemoryCorePicker();
    })
    .catch((e) => {
      store.pushNotice(`${failurePrefix}: ${e?.message || e}`, 'error');
      openMemoryCorePicker();
    });
  return true;
}

function coreAdd(ctx, _target, commandText) {
  const sentence = commandText.trim();
  if (!requireText(ctx, sentence, 'memory sentence is required')) return false;
  ctx.setSettingsPrompt(null);
  return coreMemoryWrite(
    ctx,
    { action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence },
    { success: 'core memory added', failurePrefix: 'core add failed' }
  );
}

function coreEdit(ctx, target, commandText) {
  const sentence = commandText.trim();
  if (!requireText(ctx, sentence, 'memory sentence is required')) return false;
  ctx.setSettingsPrompt(null);
  // Single-sentence semantics only rewrite `element` when the row was
  // already element===summary at load (see beginEditCoreMemory's
  // _singleSentence flag). A distinct legacy element carries meaning
  // this text prompt never captured -- clobbering it on every edit
  // would corrupt the entry (and re-embed/dedupe on the clobbered
  // value). Otherwise only `summary` is sent.
  const editArgs = {
    action: 'core',
    op: 'edit',
    id: target._id,
    index_revision: target._indexRevision,
    project_id: target._projectId ?? 'common',
    ...(target._singleSentence ? { element: sentence } : {}),
    summary: sentence,
  };
  return coreMemoryWrite(ctx, editArgs, { success: 'core memory updated', failurePrefix: 'core edit failed' });
}

function coreDeleteConfirm(ctx, target, commandText) {
  const { store, setSettingsPrompt, openMemoryCorePicker } = ctx;
  setSettingsPrompt(null);
  if (!isYes(commandText)) {
    store.pushNotice('delete canceled', 'info');
    openMemoryCorePicker();
    return true;
  }
  return coreMemoryWrite(
    ctx,
    {
      action: 'core',
      op: 'delete',
      id: target._id,
      index_revision: target._indexRevision,
      project_id: target._projectId ?? 'common',
    },
    { success: 'core memory deleted', failurePrefix: 'core delete failed' }
  );
}

const SETTINGS_PROMPTS = {
  cwd: setCwd,
  'project-new': projectNew,
  'project-create-confirm': projectCreateConfirm,
  'project-rename': projectRename,
  'system-shell': systemShell,
  'autoclear-provider': autoClearProvider,
  'profile-title': profileTitle,
  'plugin-add': pluginAdd,
  'mcp-add': mcpAdd,
  'skill-add': skillAdd,
  'skill-use': skillUse,
  'core-add': coreAdd,
  'core-edit': coreEdit,
  'core-delete-confirm': coreDeleteConfirm,
};

/** true/false when the prompt consumed the submit; undefined for an unknown kind. */
export function submitSettingsPrompt(ctx, settingsPrompt, commandText) {
  const { store, state, settingsWrite } = ctx;
  if (state.commandBusy) {
    store.pushNotice('wait for the current command to finish', 'warn');
    return false;
  }
  // Settings writes are daemon RPCs and the panel stays open until they
  // ACK, so a second Enter used to start an OVERLAPPING write: the older
  // ack then closed the prompt that already held the newer, restored value
  // and the user's input was lost. One write at a time per surface, and a
  // superseded ack is ignored by the panel-write.
  if (settingsWrite.inFlight()) {
    store.pushNotice('wait for the current settings change to finish', 'warn');
    return false;
  }
  const handler = SETTINGS_PROMPTS[settingsPrompt.kind];
  if (!handler) return undefined;
  try {
    return handler(ctx, settingsPrompt, commandText);
  } catch (e) {
    store.pushNotice(`settings update failed: ${e?.message || e}`, 'error');
    return false;
  }
}
