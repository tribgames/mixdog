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
function getPendingSelectUpdate(customId, values) {
  const value = values?.[0];
  if (!value) return null;
  const scheduleMatch = customId.match(/^sched_(add|edit)_(period|exec|mode)$/);
  if (scheduleMatch) {
    return { [scheduleMatch[2]]: value };
  }
  if (customId === "quiet_holidays_select") {
    return { holidays: value };
  }
  if (customId === "activity_mode_select") {
    return { activityMode: value };
  }
  return null;
}
function buildModalRequestSpec(customId, pending, profile) {
  switch (customId) {
    case "sched_add_next": {
      const fields = [
        { id: "name", label: "Name", required: true },
        { id: "time", label: "Cron expression (e.g. 0 9 * * 1-5)", required: true },
        { id: "channel", label: "Channel", required: false, value: "general" }
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
    case "quiet_set_next":
      return {
        customId: "modal_quiet",
        title: "Quiet Hours",
        fields: [
          { id: "schedule", label: "Schedule quiet hours (e.g. 23:00-07:00)", required: false }
        ]
      };
    case "sched_edit_next": {
      const fields = [
        { id: "time", label: "Cron expression (e.g. 0 9 * * 1-5)", required: false },
        { id: "channel", label: "Channel", required: false },
        { id: "dnd", label: "Quiet hours (e.g. 23:00-07:00, leave empty to disable)", required: false }
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
    case "activity_add_next":
      return {
        customId: "modal_activity_add",
        title: "Add Activity Channel",
        fields: [
          { id: "name", label: "Channel Name", required: true },
          { id: "id", label: "Channel ID", required: true }
        ]
      };
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
function buildModalExecutionPlan(customId, pending, fields) {
  switch (customId) {
    case "modal_sched_add": {
      const params = {
        time: fields.time,
        channel: fields.channel || "general",
        mode: pending.mode || "non-interactive",
        period: pending.period || "daily",
        exec: pending.exec || "prompt"
      };
      if (fields.script) params.script = fields.script;
      return {
        commands: [{ target: "bot", args: ["schedule", "add", fields.name], params }],
        followup: { target: "bot", args: ["schedule", "list"], params: {} }
      };
    }
    case "modal_quiet": {
      const commands = [];
      if (fields.schedule) commands.push({ target: "bot", args: ["quiet", "schedule", fields.schedule], params: {} });
      if (pending.holidays && pending.holidays !== "none") {
        commands.push({ target: "bot", args: ["quiet", "holidays", pending.holidays], params: {} });
      }
      return {
        commands,
        followup: { target: "bot", args: ["quiet", "list"], params: {} }
      };
    }
    case "modal_sched_edit": {
      const name = pending.editName;
      if (!name) return null;
      const params = {};
      if (fields.time) params.time = fields.time;
      if (fields.channel) params.channel = fields.channel;
      if (pending.period) params.period = pending.period;
      if (pending.exec) params.exec = pending.exec;
      if (pending.mode) params.mode = pending.mode;
      if (fields.script) params.script = fields.script;
      const commands = [
        { target: "bot", args: ["schedule", "edit", name], params }
      ];
      if (fields.dnd) {
        commands.push({ target: "bot", args: ["quiet", "schedule", fields.dnd], params: {} });
      }
      return {
        commands,
        followup: { target: "bot", args: ["schedule", "detail", name], params: {} }
      };
    }
    case "modal_activity_add":
      return {
        commands: [{
          target: "bot",
          args: ["activity", "add", fields.name],
          params: {
            id: fields.id,
            mode: pending.activityMode || "interactive"
          }
        }],
        followup: { target: "bot", args: ["activity", "list"], params: {} }
      };
    case "modal_profile_edit": {
      const params = {};
      if (fields.name) params.name = fields.name;
      if (fields.role) params.role = fields.role;
      if (fields.lang) params.lang = fields.lang;
      if (fields.tone) params.tone = fields.tone;
      return {
        commands: Object.keys(params).length > 0 ? [{ target: "profile", args: ["set"], params }] : [],
        followup: { target: "bot", args: ["profile", "list"], params: {} }
      };
    }
    default:
      return null;
  }
}
export {
  PendingInteractionStore,
  buildModalExecutionPlan,
  buildModalRequestSpec,
  getPendingSelectUpdate
};
