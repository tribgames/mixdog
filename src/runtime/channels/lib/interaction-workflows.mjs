function stateKey(userId, channelId) {
  return `${userId}:${channelId}`;
}
class PendingInteractionStore {
  states = /* @__PURE__ */ new Map();
  get(userId, channelId) {
    return { ...this.states.get(stateKey(userId, channelId)) ?? {} };
  }
  set(userId, channelId, state) {
    this.states.set(stateKey(userId, channelId), state);
  }
  patch(userId, channelId, update) {
    const next = { ...this.get(userId, channelId), ...update };
    this.set(userId, channelId, next);
    return next;
  }
  delete(userId, channelId) {
    this.states.delete(stateKey(userId, channelId));
  }
  rememberMessage(userId, channelId, messageId) {
    if (!messageId) return;
    this.patch(userId, channelId, { _msgId: messageId });
  }
}
function buildModalRequestSpec(customId, pending, profile) {
  switch (customId) {
    case "sched_add_next": {
      const fields = [
        { id: "name", label: "Name", required: true },
        { id: "time", label: "Cron expression (e.g. 0 9 * * 1-5)", required: true },
        // Single main channel: `channel` is a boolean-ish flag (true → post
        // to the main channel, empty/false → inject into the Lead session).
        { id: "channel", label: "Post to channel? (true / false)", required: false, value: "true" }
      ];
      if (pending.exec?.includes("script")) {
        fields.push({ id: "script", label: "Script filename", required: true });
      }
      return {
        customId: "modal_sched_add",
        title: "Add Schedule",
        fields
      };
    }
    case "sched_edit_next": {
      const fields = [
        { id: "time", label: "Cron expression (e.g. 0 9 * * 1-5)", required: false },
        { id: "channel", label: "Post to channel? (true / false)", required: false }
      ];
      if (pending.exec?.includes("script")) {
        fields.push({ id: "script", label: "Script filename", required: false });
      }
      return {
        customId: "modal_sched_edit",
        title: `${pending.editName ?? "Schedule"} Edit`,
        fields
      };
    }
    case "profile_edit":
      return {
        customId: "modal_profile_edit",
        title: "Edit Profile",
        fields: [
          { id: "name", label: "Name", required: false, value: profile.name ?? "" },
          { id: "role", label: "Role", required: false, value: profile.role ?? "" },
          { id: "lang", label: "Language (ko / en / ja / zh)", required: false, value: profile.lang ?? "" },
          { id: "tone", label: "Tone", required: false, value: profile.tone ?? "" }
        ]
      };
    default:
      return null;
  }
}
export {
  PendingInteractionStore,
  buildModalRequestSpec
};
