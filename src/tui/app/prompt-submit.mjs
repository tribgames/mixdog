// Prompt submit dispatcher, extracted from App.jsx. One entry point for
// everything the prompt box can accept: provider/channel/hook/settings
// text-entry prompts, slash commands, and the normal chat submit with
// pasted image/text token expansion. Factory pattern (like the pickers):
// re-created per render so it closes over the CURRENT prompt/panel state.
import {
  memoryCoreResultErrorText,
  parseHookRuleInput,
  parseMcpServerInput,
  parseSkillInput,
} from './input-parsers.mjs';
import { projectNameFromPath } from './app-format.mjs';
import {
  buildPromptContentWithImages,
  expandPastedTextTokens,
  imageReferenceIds,
  pastedTextReferenceIds,
} from '../paste-attachments.mjs';

export function createPromptSubmit({
  store,
  state,
  providerPrompt,
  channelPrompt,
  hookPrompt,
  settingsPrompt,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  oauthSubmitRef,
  clearModelCaches,
  openProviderSetupPicker,
  openChannelSetupPicker,
  openHooksPicker,
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
  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (providerPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      if (providerPrompt.kind === 'api-key') {
        if (!commandText) {
          store.pushNotice(`API key is required for ${providerPrompt.providerId}`, 'warn');
          return false;
        }
        try {
          store.saveProviderApiKey(providerPrompt.providerId, commandText);
          clearModelCaches('all');
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`api key save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'openai-usage-session') {
        if (!commandText) {
          store.pushNotice('OpenAI usage session key is required for credit lookup', 'warn');
          return false;
        }
        try {
          store.saveOpenAIUsageSessionKey(commandText);
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`OpenAI usage auth save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'local-url') {
        try {
          store.setLocalProvider(providerPrompt.providerId, {
            enabled: true,
            baseURL: commandText || providerPrompt.defaultURL,
          });
          clearModelCaches('all');
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
          return false;
        }
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
            else void openProviderSetupPicker();
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
    if (channelPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        const resumeAfterChannelPrompt = (prompt) => {
          const afterSave = prompt?.afterSave;
          setChannelPrompt(null);
          if (typeof afterSave === 'function') afterSave();
          else void openChannelSetupPicker('all');
        };
        if (channelPrompt.kind === 'discord-token') {
          if (!commandText) return false;
          store.saveDiscordToken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'telegram-token') {
          if (!commandText) return false;
          store.saveTelegramToken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        const parts = commandText.split('|').map((part) => part.trim());
        if (channelPrompt.kind === 'channel-add') {
          // Single-channel: the UI asks only for the channel id. Legacy
          // `name | id | ...` pipe input still parses (the id is the second
          // field) so old muscle memory does not break.
          const isPipe = parts.length > 1;
          const channelId = isPipe ? parts[1] : parts[0];
          Promise.resolve(store.setChannel({
            channelId,
            provider: channelPrompt.provider,
          }))
            .then(() => resumeAfterChannelPrompt(channelPrompt))
            .catch((e) => {
              store.pushNotice(`channel save failed: ${e?.message || e}`, 'error');
            });
          return true;
        }
        // schedule-add / webhook-add prompt kinds retired: schedules and
        // webhooks are managed in the desktop app (user decision).
      } catch (e) {
        store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (hookPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (hookPrompt.kind === 'rule-add') {
          const parsed = parseHookRuleInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          store.addHookRule?.(parsed.rule);
          setHookPrompt(null);
          void openHooksPicker();
          return true;
        }
      } catch (e) {
        store.pushNotice(`hook update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (settingsPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (settingsPrompt.kind === 'cwd') {
          if (!commandText) {
            store.pushNotice('working directory path is required', 'warn');
            return false;
          }
          void serviceCall('setCwd', commandText, {
            message: `Project set: ${projectNameFromPath(commandText)}`,
          }).then(() => {
            setSettingsPrompt(null);
            void openSettingsPicker();
          }).catch((error) => {
            store.pushNotice(`project switch failed: ${error?.message || error}`, 'error');
          });
          return true;
        }
        if (settingsPrompt.kind === 'project-new') {
          if (!commandText) {
            store.pushNotice('project path is required', 'warn');
            return false;
          }
          void serviceCall('inspectProjectPath', commandText).then((result) => {
            const path = String(result?.path || commandText);
            if (result?.directory === true) {
              setSettingsPrompt(null);
              void registerProject(path);
              return;
            }
            if (result?.exists === true) {
              store.pushNotice(`${path} is not a directory`, 'warn');
              return;
            }
            setSettingsPrompt({
              kind: 'project-create-confirm',
              label: 'New project · Create folder?',
              hint: `${path} does not exist. Type "y" to create it, or anything else to cancel.`,
              pendingPath: path,
            });
          }).catch((error) => {
            store.pushNotice(`project path check failed: ${error?.message || error}`, 'error');
          });
          return true;
        }
        if (settingsPrompt.kind === 'project-create-confirm') {
          const pendingPath = String(settingsPrompt.pendingPath || '');
          const answer = String(commandText || '').trim().toLowerCase();
          if (answer === 'y' || answer === 'yes') {
            void serviceCall('ensureProjectDirectory', pendingPath).then((created) => {
              setSettingsPrompt(null);
              void registerProject(created || pendingPath);
            }).catch((error) => {
              store.pushNotice(`could not create folder: ${error?.message || error}`, 'error');
              setSettingsPrompt(null);
            });
            return true;
          }
          setSettingsPrompt(null);
          store.pushNotice('project creation canceled', 'info');
          return true;
        }
        if (settingsPrompt.kind === 'project-rename') {
          const targetPath = String(settingsPrompt.projectPath || '');
          void serviceCall('renameProject', targetPath, commandText).then((updated) => {
            if (updated) {
              store.pushNotice(`project renamed to "${updated.name}"`, 'info');
            }
            setSettingsPrompt(null);
            void openProjectPicker();
          }).catch((error) => {
            store.pushNotice(`rename failed: ${error?.message || error}`, 'error');
          });
          return true;
        }
        if (settingsPrompt.kind === 'system-shell') {
          store.setSystemShell?.(commandText);
          setSettingsPrompt(null);
          void openSettingsPicker();
          return true;
        }
        if (settingsPrompt.kind === 'autoclear-provider') {
          const provider = String(settingsPrompt.provider || '').trim();
          if (!provider) {
            store.pushNotice('auto-clear provider is missing', 'warn');
            return false;
          }
          const text = String(commandText || '').trim();
          try {
            if (text) store.setAutoClear?.({ provider, duration: text });
            else store.setAutoClear?.({ provider, resetProvider: true });
            store.pushNotice(text ? `Auto-clear ${provider} default set to ${text}` : `Auto-clear ${provider} default reset`, 'info');
          } catch (e) {
            store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
            return false;
          }
          setSettingsPrompt(null);
          openAutoClearPicker({ advanced: true, returnTo: settingsPrompt.returnTo });
          return true;
        }
        if (settingsPrompt.kind === 'profile-title') {
          try {
            store.setProfile?.({ title: commandText });
            store.pushNotice(commandText ? `Title set to "${commandText.trim()}"` : 'Title cleared', 'info');
          } catch (e) {
            store.pushNotice(`profile update failed: ${e?.message || e}`, 'error');
          }
          setSettingsPrompt(null);
          openProfilePicker();
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
    const expandedText = hasTextSnapshot ? expandPastedTextTokens(text, textSnapshot) : text;
    const content = buildPromptContentWithImages(expandedText, imageSnapshot);
    const accepted = submitPrompt(content, {
      // Store the EXPANDED text in the transcript/history so a later prompt-
      // history recall resubmits the real content, not the literal token
      // (pastedTexts entries are cleared on accept). History recall therefore
      // shows the full original text instead of the token — acceptable.
      displayText: expandedText,
      pastedImages: imageSnapshot,
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
