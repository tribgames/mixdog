/**
 * src/tui/engine/session-api-ext.mjs - part of the public engine session object.
 */
import { listThemes, getThemeSetting, setThemeSetting } from '../theme.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from '../markdown/streaming-markdown.mjs';
import { toolResultText } from './tool-result-text.mjs';
import { parseSyntheticAgentMessage } from './agent-envelope.mjs';
import { flushTuiSteeringPersist } from './tui-steering-persist.mjs';
import { getVoiceStatus, toggleVoice } from '../lib/voice-setup.mjs';
import { aggregateToolCategoryEntry, aggregateDoneCategories, classifyToolCategory, formatAggregateDetail, summarizeToolResult } from '../../runtime/shared/tool-surface.mjs';
import { aggregateBucketForCategory, aggregateRawResult, failureDetailText, shellCommandExitCode } from './tool-result-status.mjs';

export function restoredTranscriptMetadata(message) {
  const value = message?.meta?.transcript;
  if (!value || typeof value !== 'object') return {};
  const completionValue = value.completion && typeof value.completion === 'object'
    ? value.completion
    : null;
  const completionStatus = typeof completionValue?.status === 'string'
    ? completionValue.status
    : '';
  const completionElapsedMs = Number(completionValue?.elapsedMs);
  const completion = completionValue && completionStatus && Number.isFinite(completionElapsedMs)
    ? {
        status: completionStatus,
        elapsedMs: Math.max(0, completionElapsedMs),
        ...(typeof completionValue.verb === 'string' && completionValue.verb
          ? { verb: completionValue.verb }
          : {}),
      }
    : null;
  return {
    ...(Number.isFinite(Number(value.at)) ? { at: Number(value.at) } : {}),
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
    ...(typeof value.agent === 'string' && value.agent ? { agent: value.agent } : {}),
    ...(completion ? { completion } : {}),
  };
}

export function restoredAssistantTranscriptItems(message, nextId) {
  const text = (typeof message?.content === 'string' ? message.content : toolResultText(message?.content)).trim();
  if (!text) return [];
  const { completion, ...metadata } = restoredTranscriptMetadata(message);
  const items = [{ kind: 'assistant', id: nextId(), text, ...metadata }];
  if (completion) {
    items.push({
      kind: 'turndone',
      id: nextId(),
      ...completion,
      ...(metadata.at ? { at: metadata.at } : {}),
    });
  }
  return items;
}

// Restored tool cards: stored assistant messages keep their (compacted)
// tool_calls and the follow-up role:'tool' results, but resume used to drop
// both — a reopened session lost every tool marker (user bug). Rebuild one
// transcript tool item per call and attach its result by tool_call_id.
export function restoredToolCallItems(message, nextId, pendingByCallId) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls
    : Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  const at = Number(message?.meta?.transcript?.at);
  const items = [];
  for (const call of calls) {
    const name = String(call?.function?.name || call?.name || 'tool').trim() || 'tool';
    let args = call?.function?.arguments ?? call?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* keep the raw string args */ }
    }
    const item = {
      kind: 'tool',
      id: nextId(),
      name,
      ...(args !== undefined && args !== '' ? { args } : {}),
      expanded: false,
      count: 1,
      completedCount: 1,
      ...(Number.isFinite(at) ? { at, startedAt: at, completedAt: at } : {}),
    };
    const callId = typeof call?.id === 'string' ? call.id : '';
    if (callId) pendingByCallId.set(callId, item);
    items.push(item);
  }
  return items;
}

export function attachRestoredToolResult(message, pendingByCallId) {
  const callId = typeof message?.tool_call_id === 'string' && message.tool_call_id
    ? message.tool_call_id
    : typeof message?.toolCallId === 'string' ? message.toolCallId : '';
  const target = callId ? pendingByCallId.get(callId) : null;
  if (!target) return;
  pendingByCallId.delete(callId);
  const text = (typeof message?.content === 'string' ? message.content : toolResultText(message?.content)) || '';
  target.result = text;
  if (/^\s*(?:error|\[error|failed\b)/i.test(text)) target.isError = true;
}

// Collapse a consecutive run (≥2) of restored per-call tool items into ONE
// done aggregate item shaped exactly like the live turn's '__aggregate__'
// card (turn.mjs completeAggregateVisual): merged category header counts,
// per-call result summaries as the collapsed detail, raw bodies preserved
// for expansion, failures/exits surfaced as 'N Ok · N Failed'/'Exit N'.
function buildRestoredAggregateItem(members) {
  const categories = new Map();
  const categoryOrder = [];
  const calls = [];
  for (const { item, category } of members) {
    const entry = aggregateToolCategoryEntry(item.name, item.args, category);
    if (!categories.has(entry.key)) categoryOrder.push(entry.key);
    const prev = categories.get(entry.key);
    categories.set(entry.key, { ...entry, count: Number(prev?.count || 0) + Number(entry.count || 1) });
    const resultText = String(item.result ?? '');
    // Mirror live outcome semantics: a plain non-zero shell exit is the
    // neutral 'Exit N' state, not a red failure; only real call errors count.
    const exitCode = shellCommandExitCode(resultText);
    const isExitError = exitCode != null;
    const isCallError = !isExitError && item.isError === true;
    calls.push({
      name: item.name,
      args: item.args,
      category,
      isError: isCallError,
      isCallError,
      isExitError,
      exitCode,
      resultText,
      resolved: true,
      summary: !isCallError && resultText.trim()
        ? summarizeToolResult(item.name, item.args, resultText, false)
        : null,
    });
  }
  const errors = calls.filter((r) => r.isError).length;
  const callErrors = calls.filter((r) => r.isCallError).length;
  const exitErrors = calls.filter((r) => r.isExitError).length;
  const succeeded = Math.max(0, calls.length - errors - exitErrors);
  const displayDetail = errors > 0 || exitErrors > 0
    ? failureDetailText({ succeeded, realErrors: callErrors, exitErrors, exitCode: calls.find((r) => r.isExitError)?.exitCode })
    : formatAggregateDetail(calls.filter((r) => r.summary).map((r) => r.summary));
  const rawResult = aggregateRawResult(calls);
  const first = members[0].item;
  const last = members[members.length - 1].item;
  return {
    kind: 'tool',
    id: first.id,
    name: '__aggregate__',
    args: { categoryOrder },
    aggregate: true,
    categories: Object.fromEntries(categories),
    doneCategories: aggregateDoneCategories(calls),
    count: calls.length,
    completedCount: calls.length,
    isError: errors > 0,
    errorCount: errors,
    callErrorCount: callErrors,
    exitErrorCount: exitErrors,
    result: displayDetail,
    text: displayDetail,
    rawResult: rawResult || null,
    expanded: false,
    headerFinalized: true,
    ...(first.at != null ? { at: first.at } : {}),
    ...(first.startedAt != null ? { startedAt: first.startedAt } : {}),
    ...(last.completedAt != null ? { completedAt: last.completedAt } : {}),
  };
}

// Restored transcripts must mirror the live turn's category merging: the live
// engine (turn.mjs) collapses consecutive same-bucket tool calls into one
// aggregate card, but resume rebuilt one card per call, so a reopened session
// un-merged every run (user bug). Walk the restored items and merge adjacent
// tool cards whose aggregateBucketForCategory matches; any non-tool item
// (user/assistant/turndone) is a block boundary, same as the live seal rule.
// Runs of 1 keep the plain per-call card (its argument summary stays visible).
// Agent cards never merge on restore: the live rule scopes Agent grouping to
// a single provider batch, a boundary the stored history no longer carries.
export function mergeRestoredToolItems(items) {
  const merged = [];
  let run = null; // { bucket, members: [{ item, category }] }
  const flushRun = () => {
    if (!run) return;
    if (run.members.length >= 2) merged.push(buildRestoredAggregateItem(run.members));
    else for (const member of run.members) merged.push(member.item);
    run = null;
  };
  for (const item of items || []) {
    const mergeable = item?.kind === 'tool' && item.aggregate !== true;
    if (!mergeable) { flushRun(); merged.push(item); continue; }
    const category = classifyToolCategory(item.name, item.args);
    const bucket = category === 'Agent' ? '' : aggregateBucketForCategory(category);
    if (!bucket) { flushRun(); merged.push(item); continue; }
    if (run && run.bucket === bucket) { run.members.push({ item, category }); continue; }
    flushRun();
    run = { bucket, members: [{ item, category }] };
  }
  flushRun();
  return merged;
}

export function createEngineApiB(bag) {
  const {
    runtime, nextId, flags, lifecycle, listeners, getState, set, flushEmitImmediate, disposeEmit, replaceItems, pushNotice, removeNotice, setProgressHint, clearToastTimers, disposeTranscriptSpill, routeState, syncContextStats, finishToolApproval, denyAllToolApprovals, restoreLeadSteeringFromDisk, resetStats, clearUiActivityBeforeContextSync, resetTuiForPendingSessionReset, snapshotTuiBeforeSessionReset, restoreTuiAfterFailedSessionReset, commitTuiSessionReset, resetStatsAndSyncContext,
  } = bag;
  return {
    resolveToolApproval: (id, decision = {}) => {
      const approved = decision === true || decision?.approved === true;
      return finishToolApproval(id, approved, decision?.reason || (approved ? 'approved by user' : 'denied by user'));
    },
    listPresets: () => {
      return runtime.listPresets();
    },
    listProviderModels: (options = {}) => {
      return runtime.listProviderModels(options);
    },
    getSearchRoute: () => {
      return runtime.getSearchRoute?.() || runtime.searchRoute || null;
    },
    listSearchModels: (options = {}) => {
      return runtime.listSearchModels?.(options) || [];
    },
    setSearchRoute: async (opts) => {
      if (getState().commandBusy) return null;
      const beforeRouteState = routeState();
      const optimisticSearchRoute = opts?.provider && opts?.model
        ? {
            provider: String(opts.provider).trim(),
            model: String(opts.model).trim(),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.fast === true ? { fast: true } : {}),
            ...(opts.toolType ? { toolType: opts.toolType } : {}),
          }
        : null;
      set({ commandBusy: true });
      try {
        if (optimisticSearchRoute?.provider && optimisticSearchRoute.model) {
          set({ searchRoute: optimisticSearchRoute });
        }
        const result = await runtime.setSearchRoute?.(opts);
        set({ ...routeState(), stats: { ...getState().stats } });
        return result;
      } catch (e) {
        set({ searchRoute: beforeRouteState.searchRoute || null });
        throw e;
      } finally {
        set({ commandBusy: false });
      }
    },
    listAgents: () => {
      return runtime.listAgents?.() || [];
    },
    listWorkflows: () => {
      return runtime.listWorkflows?.() || [];
    },
    getOutputStyle: () => {
      return runtime.getOutputStyle?.() || runtime.listOutputStyles?.() || null;
    },
    listOutputStyles: () => {
      return runtime.listOutputStyles?.() || runtime.getOutputStyle?.() || { styles: [], current: null, configured: 'default' };
    },
    setOutputStyle: async (styleId) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.setOutputStyle?.(styleId);
        resetStats();
        set({ ...routeState(), stats: { ...getState().stats } });
        // Defer the context recompute (transcript scan) off this tick so
        // the style change repaints immediately; stats settle right after.
        setTimeout(() => {
          syncContextStats({ allowEstimated: true });
          set({ stats: { ...getState().stats } });
        }, 0);
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    setWorkflow: async (workflowId) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.setWorkflow?.(workflowId);
        set({ ...routeState(), stats: { ...getState().stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    // Toggle Discord remote mode for this session. Flips the runtime's
    // remoteEnabled flag (booting/stopping the channel worker) and returns the
    // NEW enabled getState() so the caller can render an ON/OFF notice.
    toggleRemote: () => {
      const enabled = runtime.isRemoteEnabled?.() === true;
      if (enabled) runtime.stopRemote?.();
      else runtime.startRemote?.();
      const next = runtime.isRemoteEnabled?.() === true;
      set({ remoteEnabled: next });
      return next;
    },
    // Force-claim remote for this session (single-holder, last-wins). Always
    // turns remote ON here and steals the bridge seat; the previous holder is
    // superseded and flips itself OFF via onRemoteStateChange. Used by the
    // `/remote` slash command — repeated /remote just re-claims (idempotent).
    claimRemote: () => {
      runtime.startRemote?.();
      const next = runtime.isRemoteEnabled?.() === true;
      set({ remoteEnabled: next });
      return next;
    },
    isRemoteEnabled: () => runtime.isRemoteEnabled?.() === true,
    getVoiceStatus: () => getVoiceStatus(),
    // Desktop push-to-talk dictation: accept a recorded audio payload
    // (base64), stage it as a temp file, and run it through the SAME managed
    // whisper.cpp pipeline the channels use (ffmpeg convert -> whisper server,
    // model selected per voice.model/system language). Returns the transcript
    // text or throws a user-actionable error (e.g. runtime not installed).
    transcribeAudio: async ({ data, mimeType = 'audio/webm' } = {}) => {
      const base64 = String(data || '');
      if (!base64) throw new Error('transcribeAudio: audio payload is required');
      if (base64.length > 40_000_000) throw new Error('transcribeAudio: recording too large');
      const [{ createVoiceTranscription }, { resolvePluginData }, { readSection }, os, path, fsp, crypto] = await Promise.all([
        import('../../runtime/channels/lib/voice-transcription.mjs'),
        import('../../runtime/shared/plugin-paths.mjs'),
        import('../../runtime/shared/config.mjs'),
        import('node:os'),
        import('node:path'),
        import('node:fs/promises'),
        import('node:crypto'),
      ]);
      const extension = /ogg/i.test(mimeType) ? 'ogg' : /wav/i.test(mimeType) ? 'wav' : /mp4|m4a/i.test(mimeType) ? 'm4a' : 'webm';
      const audioPath = path.join(os.tmpdir(), `mixdog-dictation-${process.pid}-${Date.now()}.${extension}`);
      await fsp.writeFile(audioPath, Buffer.from(base64, 'base64'));
      try {
        const { transcribeVoice } = createVoiceTranscription({
          getConfig: () => ({ voice: readSection('voice') || {} }),
          dataDir: resolvePluginData(),
        });
        const text = await transcribeVoice(audioPath, {
          attachmentId: `dictation-${crypto.randomUUID()}`,
        });
        return typeof text === 'string' ? text : '';
      } finally {
        fsp.rm(audioPath, { force: true }).catch(() => undefined);
      }
    },
    // Desktop composer image attach: run the SAME optional-sharp resize
    // pipeline the TUI paste path uses (<=2000x2000, 5MB-base64 token budget,
    // identical no-sharp size errors) so both clients send identical image
    // payloads to the provider.
    resizeImage: async ({ data, mimeType = 'image/png', filename = '' } = {}) => {
      const base64 = String(data || '');
      if (!base64) throw new Error('resizeImage: image payload is required');
      if (base64.length > 40_000_000) throw new Error('resizeImage: image too large');
      const { imageAttachmentFromBuffer } = await import('../paste-attachments.mjs');
      const attachment = await imageAttachmentFromBuffer(
        Buffer.from(base64, 'base64'),
        String(mimeType || 'image/png'),
        { filename: String(filename || 'Pasted image') },
      );
      return {
        data: attachment.content,
        mimeType: attachment.mediaType,
        metadataText: attachment.metadataText || '',
      };
    },
    toggleVoice: async () => {
      const result = await toggleVoice({ pushNotice, setProgressHint });
      return {
        ...(await getVoiceStatus()),
        result: typeof result === 'boolean'
          ? { ok: true, enabled: result }
          : (result && typeof result === 'object' ? result : { ok: false }),
      };
    },
    // Theme is a TUI-local concern (no runtime round-trip). listThemes returns
    // picker metadata; getTheme reports the active id; setTheme applies the
    // palette in-place + persists ui.theme and bumps a themeEpoch so the React
    // tree re-renders (markdown/status/spinner colorizers re-resolve).
    listThemes: () => listThemes(),
    getTheme: () => getThemeSetting(),
    setTheme: (id, options = {}) => {
      const applied = setThemeSetting(id, options);
      set({ themeEpoch: (getState().themeEpoch || 0) + 1 });
      return applied;
    },
    setAgentRoute: async (agentId, opts) => {
      return await runtime.setAgentRoute?.(agentId, opts);
    },
    setDefaultProvider: async (provider) => {
      return await runtime.setDefaultProvider?.(provider);
    },
    listProviders: () => {
      return runtime.listProviders();
    },
    getProviderSetup: () => {
      return runtime.getProviderSetup();
    },
    getUsageDashboard: async (options = {}) => {
      return await runtime.getUsageDashboard?.(options);
    },
    getOnboardingStatus: () => {
      return runtime.getOnboardingStatus?.() || { completed: true, workflowRoutes: {} };
    },
    skipOnboarding: () => {
      // Completed-marking only; no route/agent/provider writes.
      return runtime.skipOnboarding?.() || null;
    },
    completeOnboarding: async (payload = {}) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.completeOnboarding?.(payload);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice('first-run setup saved', 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    loginOAuthProvider: async (provider) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.loginOAuthProvider(provider);
        pushNotice(`provider oauth ok: ${result.provider}`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    beginOAuthProviderLogin: async (provider) => {
      if (getState().commandBusy) throw new Error('command busy');
      set({ commandBusy: true });
      try {
        const result = await runtime.beginOAuthProviderLogin(provider);
        pushNotice(`provider oauth started: ${result.provider}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    saveProviderApiKey: (provider, secret) => {
      const result = runtime.saveProviderApiKey(provider, secret);
      pushNotice(`provider api key saved: ${result.provider}`, 'info');
      return true;
    },
    saveOpenCodeGoUsageAuth: (opts) => {
      const result = runtime.saveOpenCodeGoUsageAuth(opts);
      pushNotice(result.workspaceId
        ? `OpenCode Go usage auth saved: ${result.workspaceId}`
        : 'OpenCode Go usage auth saved',
        'info');
      return true;
    },
    loginOpenCodeGoUsage: async () => {
      if (getState().commandBusy) throw new Error('command busy');
      set({ commandBusy: true });
      try {
        return await runtime.loginOpenCodeGoUsage();
      } finally {
        set({ commandBusy: false });
      }
    },
    saveOpenAIUsageSessionKey: (secret) => {
      runtime.saveOpenAIUsageSessionKey(secret);
      pushNotice('OpenAI usage auth saved', 'info');
      return true;
    },
    setLocalProvider: (provider, opts) => {
      const result = runtime.setLocalProvider(provider, opts);
      pushNotice(`local provider ${result.enabled ? 'enabled' : 'disabled'}: ${result.provider}`, 'info');
      return true;
    },
    authenticateProvider: async (provider, secret) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.authenticateProvider(provider, secret);
        pushNotice(`provider auth ok: ${result.provider} (${result.type})`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    forgetProviderAuth: (provider) => {
      const result = runtime.forgetProviderAuth(provider);
      pushNotice(`provider auth forgotten: ${result.provider}`, 'info');
      return true;
    },
    getChannelSetup: () => {
      return runtime.getChannelSetup();
    },
    getChannelWorkerStatus: () => runtime.getChannelWorkerStatus?.(),
    setBackend: (name) => runtime.setBackend?.(name),
    saveDiscordToken: (token) => {
      const result = runtime.saveDiscordToken(token);
      pushNotice('discord token saved', 'info');
      return result;
    },
    forgetDiscordToken: () => {
      const result = runtime.forgetDiscordToken();
      pushNotice('discord token forgotten', 'info');
      return result;
    },
    saveTelegramToken: (token) => {
      const result = runtime.saveTelegramToken?.(token);
      pushNotice('telegram token saved', 'info');
      return result;
    },
    forgetTelegramToken: () => {
      const result = runtime.forgetTelegramToken?.();
      pushNotice('telegram token forgotten', 'info');
      return result;
    },
    saveWebhookAuthtoken: (token) => {
      const result = runtime.saveWebhookAuthtoken(token);
      pushNotice('webhook/ngrok authtoken saved', 'info');
      return result;
    },
    forgetWebhookAuthtoken: () => {
      const result = runtime.forgetWebhookAuthtoken();
      pushNotice('webhook/ngrok authtoken forgotten', 'info');
      return result;
    },
    setChannel: async (entry) => {
      const result = await runtime.setChannel(entry);
      pushNotice('channel saved', 'info');
      return result;
    },
    setWebhookConfig: async (patch) => {
      const result = await runtime.setWebhookConfig(patch);
      pushNotice('webhook config updated', 'info');
      return result;
    },
    saveSchedule: async (entry) => {
      const result = await runtime.saveSchedule(entry);
      pushNotice(`schedule saved: ${result.name}`, 'info');
      return result;
    },
    deleteSchedule: async (name) => {
      const result = await runtime.deleteSchedule(name);
      pushNotice(`schedule deleted: ${name}`, 'info');
      return result;
    },
    setScheduleEnabled: async (name, enabled) => {
      const result = await runtime.setScheduleEnabled(name, enabled);
      pushNotice(`schedule ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    runScheduleNow: async (name) => {
      const result = await runtime.runScheduleNow(name);
      pushNotice(`schedule ran: ${name}`, 'info');
      return result;
    },
    saveWebhook: async (entry) => {
      const result = await runtime.saveWebhook(entry);
      pushNotice(`webhook saved: ${result.name}`, 'info');
      return result;
    },
    deleteWebhook: async (name) => {
      const result = await runtime.deleteWebhook(name);
      pushNotice(`webhook deleted: ${name}`, 'info');
      return result;
    },
    setWebhookEnabled: async (name, enabled) => {
      const result = await runtime.setWebhookEnabled(name, enabled);
      pushNotice(`webhook ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    setRoute: async (opts) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        const routeOpts = opts && typeof opts === 'object' ? opts : {};
        // Default: apply to the NEXT session only. Only an explicit
        // `applyToCurrentSession: true` rewrites the live session in place.
        const applyToCurrentSession = routeOpts.applyToCurrentSession === true;
        const { applyToCurrentSession: _drop, ...nextRoute } = routeOpts;
        await runtime.setRoute(nextRoute, { applyToCurrentSession });
        if (applyToCurrentSession) syncContextStats({ allowEstimated: true });
        set({ ...routeState(), stats: { ...getState().stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    pushNotice,
    removeNotice,
    setProgressHint,
    clear: async () => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      set({
        items: getState().items,
        toasts: getState().toasts,
        queued: getState().queued,
        thinking: null,
        spinner: null,
        lastTurn: null,
        sessionId: null,
        stats: { ...getState().stats },
      });
      try {
        await runtime.clear({ recoverAgent: true });
        clearUiActivityBeforeContextSync();
        flags.pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...getState().stats } });
        commitTuiSessionReset(rollbackSnapshot);
        flags.lastUserActivityAt = Date.now();
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    listSessions: (options) => {
      return runtime.listSessions(options);
    },
    deleteSession: async (id) => {
      if (getState().commandBusy) return false;
      const deletingCurrent = String(runtime.session?.id || getState().sessionId || '') === String(id || '');
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = deletingCurrent ? snapshotTuiBeforeSessionReset() : null;
      if (deletingCurrent) resetTuiForPendingSessionReset();
      try {
        if (await runtime.deleteSession(id) !== true) {
          if (rollbackSnapshot) restoreTuiAfterFailedSessionReset(rollbackSnapshot);
          return false;
        }
        if (deletingCurrent) {
          clearUiActivityBeforeContextSync();
          flags.pendingSessionReset = false;
          resetStatsAndSyncContext();
          set({
            items: replaceItems([]),
            toasts: [],
            queued: [],
            thinking: null,
            spinner: null,
            lastTurn: null,
            sessionId: null,
            cwd: runtime.cwd,
            ...routeState(),
            stats: { ...getState().stats },
          });
          commitTuiSessionReset(rollbackSnapshot);
        }
        return true;
      } catch (error) {
        if (rollbackSnapshot) restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    switchContext: async (options) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      try {
        await runtime.switchContext(options);
        clearUiActivityBeforeContextSync();
        flags.pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({
          items: replaceItems([]),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          sessionId: null,
          cwd: runtime.cwd,
          ...routeState(),
          stats: { ...getState().stats },
        });
        commitTuiSessionReset(rollbackSnapshot);
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    newSession: async () => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      set({
        items: getState().items,
        toasts: getState().toasts,
        queued: getState().queued,
        thinking: null,
        spinner: null,
        lastTurn: null,
        sessionId: null,
        stats: { ...getState().stats },
      });
      try {
        await runtime.newSession();
        clearUiActivityBeforeContextSync();
        flags.pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...getState().stats } });
        commitTuiSessionReset(rollbackSnapshot);
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    resume: async (id) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Resuming conversation', startedAt: Date.now(), mode: 'resuming' } });
      clearToastTimers();
      try {
        const r = await runtime.resume(id);
        if (!r) return false;
        resetStatsAndSyncContext();
        const items = [];
        const pendingToolCalls = new Map();
        for (const m of r.messages || []) {
          if (m.role === 'user') {
            // Injected model-context payloads are model-visible but never
            // user-authored: skill bodies (meta:'skill'), hook/system
            // reminders (meta:'hook'), and tag-wrapped context blocks. They
            // must not restore as user bubbles in any client (TUI/desktop).
            if (m.meta === 'skill' || m.meta === 'hook') continue;
            // content may be a string OR an array of parts (text/tool-call
            // interleaving) — toolResultText coerces both to readable text so
            // array-content messages aren't silently dropped.
            const text = (typeof m.content === 'string' ? m.content : toolResultText(m.content)).trim();
            if (/^<(?:system-reminder|skill|memory-context|mcp-instructions|available-deferred-tools|event)\b/i.test(text)) continue;
            if (text) {
              const synthetic = parseSyntheticAgentMessage(text);
              if (synthetic) {
                const label = synthetic.label || 'notification';
                items.push({
                  kind: 'tool',
                  id: nextId(),
                  name: synthetic.name || 'agent',
                  args: synthetic.args || {
                    type: label,
                    task_id: synthetic.taskId || undefined,
                    description: synthetic.summary || 'agent notification',
                  },
                  result: synthetic.result,
                  rawResult: synthetic.rawResult ?? text,
                  isError: synthetic.isError ?? /^(failed|error|killed|cancelled)$/i.test(label),
                  expanded: false,
                  count: 1,
                  completedCount: 1,
                  startedAt: Date.now(),
                  completedAt: Date.now(),
                });
              } else {
                items.push({ kind: 'user', id: nextId(), text, ...restoredTranscriptMetadata(m) });
              }
            }
          } else if (m.role === 'assistant') {
            items.push(...restoredAssistantTranscriptItems(m, nextId));
            items.push(...restoredToolCallItems(m, nextId, pendingToolCalls));
          } else if (m.role === 'tool') {
            attachRestoredToolResult(m, pendingToolCalls);
          }
        }
        set({
          // Results above attach by mutating the per-call items in place, so
          // the category-merge pass must run only now, after the full walk.
          items: replaceItems(mergeRestoredToolItems(items)),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          ...routeState(),
          stats: { ...getState().stats },
        });
        void restoreLeadSteeringFromDisk();
        return true;
      } finally {
        set({ commandBusy: false, commandStatus: null });
        // Desktop resume returns a snapshot immediately after this promise.
        // Publish the completed route/transcript boundary now so callers never
        // observe the previous frame's session id and title.
        flushEmitImmediate();
      }
    },

    dispose: async (reason = 'cli-react-exit', options = {}) => {
      if (flags.disposed) return;
      disposeEmit?.();
      flags.disposed = true;
      clearToastTimers();
      disposeTranscriptSpill?.();
      try { clearInterval(lifecycle.runtimePulseTimer); } catch {}
      try { lifecycle.unsubscribeRuntimeNotifications?.(); } catch {}
      lifecycle.unsubscribeRuntimeNotifications = null;
      try { lifecycle.unsubscribeRemoteState?.(); } catch {}
      lifecycle.unsubscribeRemoteState = null;
      denyAllToolApprovals('runtime closing');
      await flushTuiSteeringPersist();
      await runtime.close(reason, options);
      listeners.clear();
    },
  };
}
