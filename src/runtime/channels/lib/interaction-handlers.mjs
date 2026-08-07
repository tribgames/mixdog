// Discord interaction/modal routing extracted from channels/index.mjs.
export function createInteractionHandlers({
  getProvider,
  getBridgeRuntimeConnected,
  instanceId,
  getBridgeOwnershipSnapshot,
  refreshBridgeOwnershipSafe,
  pendingSetup,
  buildModalRequestSpec,
  loadProfileConfig,
  sendNotifyToParent,
  scheduler,
  controlClaudeSession,
  writeTextFile,
  TURN_END_FILE,
}) {
getProvider().onModalRequest = async (rawInteraction) => {
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

getProvider().onInteraction = (interaction) => {
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
}
