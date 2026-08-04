import * as fs from "fs";
import * as path from "path";
// Discord permission-prompt + interaction/modal routing extracted from
// channels/index.mjs (behavior-preserving). Installs backend.onInteraction /
// onModalRequest handlers and the terminal tool-exec signal watcher; returns the
// pending-permission map + marker refresher for the worker IPC handler.
export function createInteractionHandlers({
  getBackend,
  getConfig,
  getBridgeRuntimeConnected,
  instanceId,
  getBridgeOwnershipSnapshot,
  refreshBridgeOwnershipSafe,
  pendingSetup,
  buildModalRequestSpec,
  loadProfileConfig,
  getDiscordToken,
  sendNotifyToParent,
  scheduler,
  controlClaudeSession,
  writeTextFile,
  TURN_END_FILE,
  getPermissionResultPath,
  TERMINAL_LEAD_PID,
  localTimestamp,
  isMixdogDebug,
  appendSessionStartCriticalLog,
  DATA_DIR,
  _bootLog,
  RUNTIME_ROOT,
}) {
function editDiscordMessage(channelId, messageId, label) {
  // Behavior-preserving: route through the getBackend() abstraction (which uses
  // discord.js under the hood) instead of issuing a raw REST PATCH. Errors
  // are swallowed to stderr to match the prior fire-and-forget shape — the
  // call site never awaited the HTTPS request either.
  if (!getDiscordToken()) return;
  const text = `\u{1F510} **Permission Request** \u2014 ${label}`;
  void getBackend().editMessage(channelId, messageId, text, { components: [] }).catch((err) => {
    process.stderr.write(`mixdog: editDiscordMessage failed: ${err}
`);
  });
}
getBackend().onModalRequest = async (rawInteraction) => {
  if (!getBridgeRuntimeConnected() || !getBridgeOwnershipSnapshot().owned) {
    refreshBridgeOwnershipSafe();
    return;
  }
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import("discord.js");
  const customId = rawInteraction.customId;
  const channelId = rawInteraction.channelId ?? "";
  pendingSetup.rememberMessage(rawInteraction.user.id, channelId, rawInteraction.message?.id);
  const modalSpec = buildModalRequestSpec(
    customId,
    pendingSetup.get(rawInteraction.user.id, channelId),
    loadProfileConfig()
  );
  if (!modalSpec) return;
  const modal = new ModalBuilder().setCustomId(modalSpec.customId).setTitle(modalSpec.title);
  const rows = modalSpec.fields.map(
    (field) => new ActionRowBuilder().addComponents((() => {
      const input = new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(TextInputStyle.Short).setRequired(field.required);
      if (field.value) input.setValue(field.value);
      return input;
    })())
  );
  modal.addComponents(...rows);
  await rawInteraction.showModal(modal);
};
const pendingPermRequests = new Map();
const TOOL_EXEC_CONSUMER_MARKER = path.join(RUNTIME_ROOT, '.tool-exec-consumer');
function refreshToolExecConsumerMarker() {
  try {
    if (pendingPermRequests.size > 0) {
      fs.writeFileSync(TOOL_EXEC_CONSUMER_MARKER, String(Date.now()));
    } else {
      try { fs.unlinkSync(TOOL_EXEC_CONSUMER_MARKER); } catch {}
    }
  } catch {}
}
// Watch for terminal-approved tool executions. The PostToolUse hook writes a
// signal file per tool call; when we see one, find the oldest pending perm
// request with a matching tool name and mark its Discord message as
// "Allowed (terminal)" so users don't see stale active buttons.
try {
  try { if (!fs.existsSync(RUNTIME_ROOT)) fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
  const SIGNAL_RE = /^tool-exec-\d+-[0-9a-f]+\.signal$/;
  fs.watch(RUNTIME_ROOT, { persistent: false }, (eventType, filename) => {
    if (!filename || !SIGNAL_RE.test(filename)) return;
    setTimeout(() => {
      try {
        const signalPath = path.join(RUNTIME_ROOT, filename);
        let raw;
        try { raw = fs.readFileSync(signalPath, 'utf8'); } catch { return; }
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        const toolName = payload?.toolName;
        if (!toolName) return;
        const sigFilePath = payload?.filePath || '';
        let oldestKey = null;
        let oldestEntry = null;
        for (const [k, v] of pendingPermRequests) {
          if (v.toolName !== toolName) continue;
          // Bind on filePath too. If both sides are empty (non-file tools
          // like Bash), toolName alone is the match. Otherwise both must
          // equal — prevents two concurrent Edit/Write requests from
          // cross-approving each other.
          const vFilePath = v.filePath || '';
          if (vFilePath || sigFilePath) {
            if (vFilePath !== sigFilePath) continue;
          }
          if (!oldestEntry || v.createdAt < oldestEntry.createdAt) {
            oldestKey = k;
            oldestEntry = v;
          }
        }
        // No matching pending request — leave the signal on disk so a
        // agent role hook (or other consumer) gets a chance to claim it.
        if (!oldestKey || !oldestEntry) return;
        if (oldestEntry.channelId && oldestEntry.messageId) {
          try {
            editDiscordMessage(oldestEntry.channelId, oldestEntry.messageId, 'Allowed (terminal)');
          } catch (err) {
            try { process.stderr.write(`mixdog channels: tool-exec signal edit failed: ${err && err.message || err}\n`); } catch {}
          }
        }
        pendingPermRequests.delete(oldestKey);
        refreshToolExecConsumerMarker();
        // Only unlink once we've confirmed the match and handled it.
        try { fs.unlinkSync(signalPath); } catch {}
      } catch (err) {
        try { process.stderr.write(`mixdog channels: tool-exec signal handler error: ${err && err.message || err}\n`); } catch {}
      }
    }, 50);
  });
  // Stale-signal sweeper: any signal file older than 60s is removed so
  // unclaimed files don't accumulate on disk. Runs every 30s.
  setInterval(() => {
    try {
      const now = Date.now();
      const entries = fs.readdirSync(RUNTIME_ROOT);
      for (const name of entries) {
        if (!SIGNAL_RE.test(name)) continue;
        const p = path.join(RUNTIME_ROOT, name);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs > 60_000) {
            try { fs.unlinkSync(p); } catch {}
          }
        } catch {}
      }
    } catch {}
  }, 30_000)?.unref?.();
} catch (err) {
  try { process.stderr.write(`mixdog channels: tool-exec signal watcher setup failed: ${err && err.message || err}\n`); } catch {}
}

getBackend().onInteraction = (interaction) => {
  // Channel-route permission reply. Custom_id format: perm-ch-{request_id}-{allow|session|deny}.
  // request_id is the 5-letter short ID CC generates via shortRequestId().
  // Emit notifications/claude/channel/permission back to the MCP host; the race
  // logic in interactiveHandler.ts resolves the pending request and dismisses
  // every other racer (local dialog, bridge, hook, classifier).
  if (interaction.customId?.startsWith("perm-ch-")) {
    const match = interaction.customId.match(/^perm-ch-([a-km-z]{5})-(allow|session|deny)$/);
    if (!match) return;
    const [, requestId, action] = match;
    const access = getConfig().access;
    if (access?.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`mixdog: perm-ch button rejected — user ${interaction.userId} not in allowFrom\n`);
      return;
    }
    const pending = pendingPermRequests.get(requestId);
    pendingPermRequests.delete(requestId);
    refreshToolExecConsumerMarker();
    const params = { request_id: requestId };
    if (action === 'deny') {
      params.behavior = 'deny';
    } else if (action === 'session') {
      params.behavior = 'allow';
      const toolName = pending?.toolName;
      if (toolName) {
        params.updatedPermissions = [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
      }
    } else {
      params.behavior = 'allow';
    }
    sendNotifyToParent('notifications/claude/channel/permission', params);
    const labels = { allow: 'Approved', session: 'Session Approved', deny: 'Denied' };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (interaction.customId?.startsWith("perm-")) {
    const match = interaction.customId.match(/^perm-([0-9a-f]{32})-(allow|session|deny)$/);
    if (!match) return;
    const [, uuid, action] = match;
    const access = getConfig().access;
    if (!access) {
      const _permDropLine = `[${localTimestamp()}] perm interaction dropped: no access getConfig()\n`;
      if (isMixdogDebug()) {
        fs.appendFileSync(_bootLog, _permDropLine);
      } else {
        appendSessionStartCriticalLog(DATA_DIR, `[channels] ${_permDropLine}`);
      }
      return;
    }
    if (access.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`mixdog: perm button rejected \u2014 user ${interaction.userId} not in allowFrom
`);
      return;
    }
    const resultPaths = [getPermissionResultPath(instanceId, uuid)];
    const leadInstanceId = String(TERMINAL_LEAD_PID);
    if (leadInstanceId && leadInstanceId !== instanceId) {
      resultPaths.push(getPermissionResultPath(leadInstanceId, uuid));
    }
    for (const resultPath of resultPaths) {
      try {
        fs.writeFileSync(resultPath, action, { flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") {
          process.stderr.write(`mixdog: writePermissionResult failed: ${e.message}\n`);
        }
      }
    }
    const labels = { allow: "Approved", session: "Session Approved", deny: "Denied" };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (!getBridgeRuntimeConnected() || !getBridgeOwnershipSnapshot().owned) {
    refreshBridgeOwnershipSafe();
    return;
  }
  scheduler.noteActivity();
  if (interaction.customId === "stop_task") {
    controlClaudeSession(instanceId, { type: "interrupt" })
      .catch(err => process.stderr.write(`[channels] controlClaudeSession rejected: ${err?.message || err}\n`));
    writeTextFile(TURN_END_FILE, String(Date.now()));
    return;
  }
  sendNotifyToParent("notifications/claude/channel", {
    content: `[interaction] ${interaction.type}: ${interaction.customId}${interaction.values ? " values=" + interaction.values.join(",") : ""}`,
    meta: {
      chat_id: interaction.channelId,
      user: `interaction:${interaction.type}`,
      user_id: interaction.userId,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      interaction_type: interaction.type,
      custom_id: interaction.customId,
      ...interaction.values ? { values: interaction.values.join(",") } : {},
      ...interaction.message ? { message_id: interaction.message.id } : {}
    }
  });
};
  return { pendingPermRequests, refreshToolExecConsumerMarker };
}
