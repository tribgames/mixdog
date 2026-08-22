// Prompt submit dispatcher, extracted from App.jsx. One entry point for
// everything the prompt box can accept: provider/channel/hook/settings
// text-entry prompts, slash commands, and the normal chat submit with
// pasted image/text token expansion. Factory pattern (like the pickers):
// re-created per render so it closes over the CURRENT prompt/panel state.
import {
  memoryCoreResultErrorText,
  parseMcpServerInput,
  parseSkillInput,
} from './input-parsers.mjs';
import { projectNameFromPath } from './app-format.mjs';
import { isPanelEpochCurrent, supersedePanelEpoch } from './panel-epoch.mjs';
import {
  buildPromptContentWithImages,
  imageReferenceIds,
  pastedTextReferenceIds,
} from '../paste-attachments.mjs';

// In-flight prompt writes, tracked at MODULE scope: createPromptSubmit is
// re-created on every render, so a closure flag resets mid-write and a second
// Enter starts an overlapping daemon write whose OLDER ack then closes the
// panel that already holds newer (restored) input. Each value is the panel
// epoch its write owns, so a write stops blocking the moment the user takes
// the surface back (Esc/close bumps the epoch).
let providerWriteToken = 0;
let settingsWriteToken = 0;
const providerWriteInFlight = () => providerWriteToken > 0 && isPanelEpochCurrent(providerWriteToken);
const settingsWriteInFlight = () => settingsWriteToken > 0 && isPanelEpochCurrent(settingsWriteToken);

export function createPromptSubmit({
  store,
  state,
  providerPrompt,
  settingsPrompt,
  setProviderPrompt,
  setSettingsPrompt,
  oauthSubmitRef,
  clearModelCaches,
  openProviderSetupPicker,
  openSettingsPicker,
  openProjectPicker,
  openAutoClearPicker,
  openProfilePicker,
  openPluginsPicker,
  openMcpServersPicker,
  openProjectSkillsPicker,
  openMemoryCorePicker,
  registerProject,
  runSlashCommand,
  armTranscriptFollow,
  clearPastedImagesSnapshot,
  clearPastedTextsSnapshot,
  pastedImagesRef,
  pastedTextsRef,
}) {
  const serviceCall = (name, ...args) => {
    const target = store?.[name];
    if (typeof target !== 'function') {
      return Promise.reject(new TypeError(`project service method ${name} is unavailable`));
    }
    return Promise.resolve(target.apply(store, args));
  };
  // Panel openers are async on a daemon-backed store: a bare call leaves a
  // rejected open as an unhandled rejection, which terminates the TUI.
  const openPanel = (open, ...args) => {
    if (typeof open !== 'function') return;
    void Promise.resolve(open(...args)).catch((error) => {
      store.pushNotice(`panel failed to open: ${error?.message || error}`, 'error');
    });
  };
  const submitPrompt = (prompt, options) => {
    if (typeof store.submitAsync !== 'function') return store.submit(prompt, options);
    void Promise.resolve(store.submitAsync(prompt, options)).then((accepted) => {
      if (accepted === false) store.pushNotice('prompt was not accepted by the session service', 'error');
    }).catch((error) => {
      store.pushNotice(`prompt submit failed: ${error?.message || error}`, 'error');
    });
    // Input clearing remains synchronous; the daemon ACK is responsible for
    // durable intake, while provider execution continues independently.
    return true;
  };
  // A rejected daemon write keeps the settings prompt OPEN with the typed
  // value restored (the epoch remounts the editor, so an identical retry value
  // still re-seeds it) instead of closing and losing the entry.
  const restoreSettingsPrompt = (target, value) => {
    setSettingsPrompt({
      ...target,
      submitting: false,
      initialValue: value,
      restoreEpoch: (Number(target.restoreEpoch) || 0) + 1,
    });
  };
  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (providerPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      // Every provider write below is a DAEMON RPC (async). The prompt may only
      // close once the write is acknowledged; a rejection keeps the panel open
      // with the entered value restored so a transport hiccup never silently
      // eats a credential or claims success.
      const beginProviderSave = (target) => {
        // A new submit supersedes every older in-flight write for this surface.
        const token = supersedePanelEpoch();
        providerWriteToken = token;
        setProviderPrompt((prompt) => (prompt === target ? { ...prompt, submitting: true } : prompt));
        return token;
      };
      const endProviderSave = (token) => {
        if (providerWriteToken === token) providerWriteToken = 0;
      };
      const finishProviderSave = (target, token) => {
        endProviderSave(token);
        // Stale ack (newer submit, or the user closed the prompt): never close
        // or navigate a surface this write no longer owns.
        if (!isPanelEpochCurrent(token)) return;
        setProviderPrompt(null);
        if (target.afterSave) target.afterSave();
        else openPanel(openProviderSetupPicker);
      };
      const failProviderSave = (target, value, message, token) => {
        endProviderSave(token);
        store.pushNotice(message, 'error');
        if (!isPanelEpochCurrent(token)) return;
        // The restored panel now owns the surface.
        supersedePanelEpoch();
        setProviderPrompt({
          ...target,
          submitting: false,
          initialValue: value,
          restoreEpoch: (Number(target.restoreEpoch) || 0) + 1,
        });
      };
      if (providerPrompt.kind === 'api-key') {
        if (!commandText) {
          store.pushNotice(`API key is required for ${providerPrompt.providerId}`, 'warn');
          return false;
        }
        if (providerWriteInFlight()) {
          store.pushNotice('API key is already being saved', 'warn');
          return false;
        }
        const target = providerPrompt;
        const token = beginProviderSave(target);
        void serviceCall('saveProviderApiKey', target.providerId, commandText)
          .then(() => {
            clearModelCaches('all');
            finishProviderSave(target, token);
          })
          .catch((error) => failProviderSave(target, commandText, `api key save failed: ${error?.message || error}`, token));
        return true;
      }
      if (providerPrompt.kind === 'openai-usage-session') {
        if (!commandText) {
          store.pushNotice('OpenAI usage session key is required for credit lookup', 'warn');
          return false;
        }
        if (providerWriteInFlight()) {
          store.pushNotice('OpenAI usage session key is already being saved', 'warn');
          return false;
        }
        const target = providerPrompt;
        const token = beginProviderSave(target);
        void serviceCall('saveOpenAIUsageSessionKey', commandText)
          .then(() => finishProviderSave(target, token))
          .catch((error) => failProviderSave(target, commandText, `OpenAI usage auth save failed: ${error?.message || error}`, token));
        return true;
      }
      if (providerPrompt.kind === 'local-url') {
        if (providerWriteInFlight()) {
          store.pushNotice('local provider update is already running', 'warn');
          return false;
        }
        const target = providerPrompt;
        const token = beginProviderSave(target);
        void serviceCall('setLocalProvider', target.providerId, {
          enabled: true,
          baseURL: commandText || target.defaultURL,
        })
          .then(() => {
            clearModelCaches('all');
            finishProviderSave(target, token);
          })
          .catch((error) => failProviderSave(target, commandText, `local provider update failed: ${error?.message || error}`, token));
        return true;
      }
      if (providerPrompt.kind === 'oauth-code') {
        if (!commandText) {
          store.pushNotice('OAuth code is required', 'warn');
          return false;
        }
        if (oauthSubmitRef.current || providerPrompt.submitting) {
          store.pushNotice('OAuth code is already being submitted', 'warn');
          return false;
        }
        oauthSubmitRef.current = true;
        setProviderPrompt((prompt) => prompt === providerPrompt ? { ...prompt, submitting: true } : prompt);
        void providerPrompt.login?.completeCode(commandText)
          .then(() => {
            const successReturn = providerPrompt.successReturn;
            const afterSave = providerPrompt.afterSave;
            oauthSubmitRef.current = false;
            clearModelCaches('all');
            setProviderPrompt(null);
            store.pushNotice(`${providerPrompt.providerName || 'OAuth'} login complete`, 'info');
            if (successReturn) successReturn();
            else if (afterSave) afterSave();
            else openPanel(openProviderSetupPicker);
          })
          .catch((e) => {
            oauthSubmitRef.current = false;
            store.pushNotice(`oauth code failed: ${e?.message || e}`, 'error');
            setProviderPrompt(null);
            providerPrompt.failureReturn?.(e);
          });
        return true;
      }
    }
    // Channel token/target and hook-rule text prompts are retired: channels
    // moved to the PWA and hook rules are edited in the Hooks picker, so no
    // opener sets those prompts any more.
    if (settingsPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      // Settings writes are daemon RPCs and the panel stays open until they
      // ACK, so a second Enter used to start an OVERLAPPING write: the older
      // ack then closed the prompt that already held the newer, restored value
      // and the user's input was lost. One write at a time per surface, and a
      // superseded ack is ignored below.
      if (settingsWriteInFlight()) {
        store.pushNotice('wait for the current settings change to finish', 'warn');
        return false;
      }
      const beginSettingsSave = (target) => {
        const token = supersedePanelEpoch();
        settingsWriteToken = token;
        setSettingsPrompt((prompt) => (prompt === target ? { ...prompt, submitting: true } : prompt));
        return token;
      };
      const endSettingsSave = (token) => {
        if (settingsWriteToken === token) settingsWriteToken = 0;
      };
      const finishSettingsSave = (token, after) => {
        endSettingsSave(token);
        // Stale ack: a newer submit or an Esc owns this surface now.
        if (!isPanelEpochCurrent(token)) return;
        setSettingsPrompt(null);
        after?.();
      };
      const failSettingsSave = (target, value, message, token, tone = 'error') => {
        endSettingsSave(token);
        store.pushNotice(message, tone);
        if (!isPanelEpochCurrent(token)) return;
        // The restored panel now owns the surface.
        supersedePanelEpoch();
        restoreSettingsPrompt(target, value);
      };
      try {
        if (settingsPrompt.kind === 'cwd') {
          if (!commandText) {
            store.pushNotice('working directory path is required', 'warn');
            return false;
          }
          const target = settingsPrompt;
          const token = beginSettingsSave(target);
          void serviceCall('setCwd', commandText, {
            message: `Project set: ${projectNameFromPath(commandText)}`,
          }).then(() => {
            finishSettingsSave(token, () => openPanel(openSettingsPicker));
          }).catch((error) => {
            failSettingsSave(target, commandText, `project switch failed: ${error?.message || error}`, token);
          });
          return true;
        }
        if (settingsPrompt.kind === 'project-new') {
          if (!commandText) {
            store.pushNotice('project path is required', 'warn');
            return false;
          }
          const target = settingsPrompt;
          const token = beginSettingsSave(target);
          void serviceCall('inspectProjectPath', commandText).then((result) => {
            const path = String(result?.path || commandText);
            if (result?.directory === true) {
              finishSettingsSave(token, () => openPanel(registerProject, path));
              return;
            }
            if (result?.exists === true) {
              failSettingsSave(target, commandText, `${path} is not a directory`, token, 'warn');
              return;
            }
            endSettingsSave(token);
            if (!isPanelEpochCurrent(token)) return;
            supersedePanelEpoch();
            setSettingsPrompt({
              kind: 'project-create-confirm',
              label: 'New project · Create folder?',
              hint: `${path} does not exist. Type "y" to create it, or anything else to cancel.`,
              pendingPath: path,
            });
          }).catch((error) => {
            failSettingsSave(target, commandText, `project path check failed: ${error?.message || error}`, token);
          });
          return true;
        }
        if (settingsPrompt.kind === 'project-create-confirm') {
          const pendingPath = String(settingsPrompt.pendingPath || '');
          const answer = String(commandText || '').trim().toLowerCase();
          if (answer === 'y' || answer === 'yes') {
            const target = settingsPrompt;
            const token = beginSettingsSave(target);
            void serviceCall('ensureProjectDirectory', pendingPath).then((created) => {
              finishSettingsSave(token, () => openPanel(registerProject, created || pendingPath));
            }).catch((error) => {
              endSettingsSave(token);
              store.pushNotice(`could not create folder: ${error?.message || error}`, 'error');
              // The typed value here is only the y/n answer, so close rather
              // than restore — but never close a surface we no longer own.
              if (isPanelEpochCurrent(token)) setSettingsPrompt(null);
            });
            return true;
          }
          setSettingsPrompt(null);
          store.pushNotice('project creation canceled', 'info');
          return true;
        }
        if (settingsPrompt.kind === 'project-rename') {
          const targetPath = String(settingsPrompt.projectPath || '');
          const target = settingsPrompt;
          const token = beginSettingsSave(target);
          void serviceCall('renameProject', targetPath, commandText).then((updated) => {
            if (updated) {
              store.pushNotice(`project renamed to "${updated.name}"`, 'info');
            }
            finishSettingsSave(token, () => openPanel(openProjectPicker));
          }).catch((error) => {
            failSettingsSave(target, commandText, `rename failed: ${error?.message || error}`, token);
          });
          return true;
        }
        if (settingsPrompt.kind === 'system-shell') {
          const target = settingsPrompt;
          const token = beginSettingsSave(target);
          // Empty is the documented reset to automatic selection.
          void serviceCall('setSystemShell', commandText)
            .then(() => {
              finishSettingsSave(token, () => openPanel(openSettingsPicker));
            })
            .catch((error) => {
              failSettingsSave(target, commandText, `system shell update failed: ${error?.message || error}`, token);
            });
          return true;
        }
        if (settingsPrompt.kind === 'autoclear-provider') {
          const provider = String(settingsPrompt.provider || '').trim();
          if (!provider) {
            store.pushNotice('auto-clear provider is missing', 'warn');
            return false;
          }
          const duration = String(commandText || '').trim();
          const target = settingsPrompt;
          const token = beginSettingsSave(target);
          // Empty is the documented reset to the built-in provider default.
          void serviceCall('setAutoClear', duration ? { provider, duration } : { provider, resetProvider: true })
            .then(() => {
              store.pushNotice(duration ? `Auto-clear ${provider} default set to ${duration}` : `Auto-clear ${provider} default reset`, 'info');
              finishSettingsSave(token, () => openPanel(openAutoClearPicker, { advanced: true, returnTo: target.returnTo }));
            })
            .catch((error) => {
              failSettingsSave(target, duration, `autoclear failed: ${error?.message || error}`, token);
            });
          return true;
        }
        if (settingsPrompt.kind === 'profile-title') {
          const target = settingsPrompt;
          const token = beginSettingsSave(target);
          // Empty is the documented "clear the title" action.
          void serviceCall('setProfile', { title: commandText })
            .then(() => {
              store.pushNotice(commandText ? `Title set to "${commandText.trim()}"` : 'Title cleared', 'info');
              finishSettingsSave(token, () => openPanel(openProfilePicker));
            })
            .catch((error) => {
              failSettingsSave(target, commandText, `profile update failed: ${error?.message || error}`, token);
            });
          return true;
        }
        if (settingsPrompt.kind === 'plugin-add') {
          if (!commandText) {
            store.pushNotice('plugin URL/path is required', 'warn');
            return false;
          }
          void store.addPlugin?.(commandText)
            .then(() => openPluginsPicker())
            .catch((e) => store.pushNotice(`plugin add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'mcp-add') {
          const parsed = parseMcpServerInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          void store.addMcpServer?.(parsed.server)
            .then(() => openMcpServersPicker())
            .catch((e) => store.pushNotice(`mcp add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'skill-add') {
          const parsed = parseSkillInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          void store.addSkill?.(parsed.skill)
            .then(() => openProjectSkillsPicker())
            .catch((e) => store.pushNotice(`skill add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'skill-use') {
          const skillName = String(settingsPrompt.skillName || '').trim();
          if (!skillName) {
            store.pushNotice('skill name is missing', 'warn');
            return false;
          }
          const prompt = `$${skillName}${commandText ? ` ${commandText}` : ''}`;
          setSettingsPrompt(null);
          const accepted = submitPrompt(prompt);
          if (accepted) armTranscriptFollow();
          return accepted;
        }
        if (settingsPrompt.kind === 'core-add') {
          const sentence = commandText.trim();
          if (!sentence) {
            store.pushNotice('memory sentence is required', 'warn');
            return false;
          }
          setSettingsPrompt(null);
          void store.memoryControl?.({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence }, { silent: true })
            .then((result) => {
              const errText = memoryCoreResultErrorText(result);
              store.pushNotice(errText || 'core memory added', errText ? 'error' : 'info');
              openMemoryCorePicker();
            })
            .catch((e) => {
              store.pushNotice(`core add failed: ${e?.message || e}`, 'error');
              openMemoryCorePicker();
            });
          return true;
        }
        if (settingsPrompt.kind === 'core-edit') {
          const sentence = commandText.trim();
          const id = settingsPrompt._id;
          const projectId = settingsPrompt._projectId ?? 'common';
          if (!sentence) {
            store.pushNotice('memory sentence is required', 'warn');
            return false;
          }
          setSettingsPrompt(null);
          // Single-sentence semantics only rewrite `element` when the row was
          // already element===summary at load (see beginEditCoreMemory's
          // _singleSentence flag). A distinct legacy element carries meaning
          // this text prompt never captured -- clobbering it on every edit
          // would corrupt the entry (and re-embed/dedupe on the clobbered
          // value). Otherwise only `summary` is sent.
          const editArgs = settingsPrompt._singleSentence
            ? { action: 'core', op: 'edit', id, project_id: projectId, element: sentence, summary: sentence }
            : { action: 'core', op: 'edit', id, project_id: projectId, summary: sentence };
          void store.memoryControl?.(editArgs, { silent: true })
            .then((result) => {
              const errText = memoryCoreResultErrorText(result);
              store.pushNotice(errText || 'core memory updated', errText ? 'error' : 'info');
              openMemoryCorePicker();
            })
            .catch((e) => {
              store.pushNotice(`core edit failed: ${e?.message || e}`, 'error');
              openMemoryCorePicker();
            });
          return true;
        }
        if (settingsPrompt.kind === 'core-delete-confirm') {
          const id = settingsPrompt._id;
          const projectId = settingsPrompt._projectId ?? 'common';
          const answer = String(commandText || '').trim().toLowerCase();
          setSettingsPrompt(null);
          if (answer !== 'y' && answer !== 'yes') {
            store.pushNotice('delete canceled', 'info');
            openMemoryCorePicker();
            return true;
          }
          void store.memoryControl?.({ action: 'core', op: 'delete', id, project_id: projectId }, { silent: true })
            .then((result) => {
              const errText = memoryCoreResultErrorText(result);
              store.pushNotice(errText || 'core memory deleted', errText ? 'error' : 'info');
              openMemoryCorePicker();
            })
            .catch((e) => {
              store.pushNotice(`core delete failed: ${e?.message || e}`, 'error');
              openMemoryCorePicker();
            });
          return true;
        }
      } catch (e) {
        store.pushNotice(`settings update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (!commandText) return false;

    if (commandText.startsWith('/')) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      const [cmd, ...rest] = commandText.slice(1).split(/\s+/);
      const accepted = runSlashCommand(cmd, rest.join(' ').trim());
      if (accepted !== false) clearPastedImagesSnapshot();
      return accepted;
    }
    const imageRefs = imageReferenceIds(text);
    const imageSnapshot = Object.fromEntries(Object.entries(pastedImagesRef.current || {})
      .filter(([id]) => imageRefs.has(Number(id))));
    const hasImageSnapshot = Object.keys(imageSnapshot).length > 0;
    // Expand folded [Pasted text #N +M lines] tokens back to their original
    // text at the same point buildPromptContentWithImages runs. Broken /
    // partially-deleted tokens do not match and are left as-is.
    const textRefs = pastedTextReferenceIds(text);
    const textSnapshot = Object.fromEntries(Object.entries(pastedTextsRef.current || {})
      .filter(([id]) => textRefs.has(Number(id))));
    const hasTextSnapshot = Object.keys(textSnapshot).length > 0;
    const content = buildPromptContentWithImages(text, imageSnapshot);
    const imageRestoreMeta = Object.fromEntries(Object.entries(imageSnapshot).map(([id, image]) => {
      const { content: _content, ...metadata } = image;
      return [id, { ...metadata, sizeBytes: Math.floor((String(image.content || '').length * 3) / 4) }];
    }));
    const accepted = submitPrompt(content, {
      ...((hasImageSnapshot || hasTextSnapshot) ? { displayText: text } : {}),
      pastedImages: imageRestoreMeta,
      pastedTexts: textSnapshot,
      onCommitted: (hasImageSnapshot || hasTextSnapshot)
        ? () => { clearPastedImagesSnapshot(imageSnapshot); clearPastedTextsSnapshot(textSnapshot); }
        : null,
    });
    if (accepted) {
      armTranscriptFollow();
      if (imageRefs.size === 0 || (!hasImageSnapshot && !state.busy)) clearPastedImagesSnapshot();
      else if (state.busy && hasImageSnapshot) clearPastedImagesSnapshot(imageSnapshot);
      if (textRefs.size === 0 || (!hasTextSnapshot && !state.busy)) clearPastedTextsSnapshot();
      else if (state.busy && hasTextSnapshot) clearPastedTextsSnapshot(textSnapshot);
    }
    return accepted;
  };

  return { onSubmit };
}
