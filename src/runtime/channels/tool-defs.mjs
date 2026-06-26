export const TOOL_DEFS = [
  {
    name: "reply",
    title: "Discord Reply",
    annotations: { title: "Discord Reply", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Send a reply/message to a configured channel. Requires chat_id and text; files are local paths to attach.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target channel/chat id from the channel context." },
        text: { type: "string", description: "Message text to send." },
        reply_to: { type: "string", description: "Optional message id to reply to." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths to attach."
        },
        embeds: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Discord embed payloads."
        },
        components: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Discord component payloads."
        }
      },
      required: ["chat_id", "text"]
    }
  },
  {
    name: "react",
    title: "Reaction",
    annotations: { title: "Reaction", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Add an emoji reaction to an existing channel message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target channel/chat id." },
        message_id: { type: "string", description: "Message id to react to." },
        emoji: { type: "string", description: "Emoji name or Unicode emoji." }
      },
      required: ["chat_id", "message_id", "emoji"]
    }
  },
  {
    name: "edit_message",
    title: "Edit Message",
    annotations: { title: "Edit Message", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Edit a bot-authored channel message. Requires chat_id, message_id, and replacement text.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target channel/chat id." },
        message_id: { type: "string", description: "Bot message id to edit." },
        text: { type: "string", description: "Replacement message text." },
        embeds: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Replacement Discord embed payloads."
        },
        components: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Replacement Discord component payloads."
        }
      },
      required: ["chat_id", "message_id", "text"]
    }
  },
  {
    name: "download_attachment",
    title: "Download Attachment",
    annotations: { title: "Download Attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Download attachments from a channel message. Requires chat_id and message_id.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Source channel/chat id." },
        message_id: { type: "string", description: "Message id containing attachments." }
      },
      required: ["chat_id", "message_id"]
    }
  },
  {
    name: "fetch",
    title: "Fetch",
    annotations: { title: "Fetch", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Discord-only: fetch recent messages from a Discord channel. Requires channel (id); optional limit (count). NOT for URLs or web pages — use web_fetch for those.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Discord channel id." },
        limit: { type: "number", description: "Maximum recent messages to return." }
      },
      required: ["channel"]
    }
  },
  {
    name: "schedule_status",
    title: "Schedule Status",
    annotations: { title: "Schedule Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Show configured schedules and their current status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "trigger_schedule",
    title: "Trigger Schedule",
    annotations: { title: "Trigger Schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Run a configured scheduled task immediately by name. Requires name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Schedule name." }
      },
      required: ["name"]
    }
  },
  {
    name: "schedule_control",
    title: "Schedule Control",
    annotations: { title: "Schedule Control", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Defer or skip a schedule without running it now: action=defer pushes by minutes; action=skip_today skips the next run today. Requires name and action.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Schedule name." },
        action: { type: "string", enum: ["defer", "skip_today"], description: "Schedule control action." },
        minutes: { type: "number", description: "Minutes to defer when action=defer." }
      },
      required: ["name", "action"]
    }
  },
  {
    name: "activate_channel_bridge",
    title: "Activate Channel Bridge",
    annotations: { title: "Activate Channel Bridge", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Enable or disable channel bridge forwarding.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "true to activate forwarding, false to deactivate." }
      },
      required: ["active"]
    }
  },
  // memory and recall_memory tools are now provided by memory-service.mjs via MCP
  {
    name: "reload_config",
    title: "Reload Config",
    annotations: { title: "Reload Config", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Reload channel/runtime configuration from disk.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "inject_command",
    title: "Inject Mixdog Slash Command",
    annotations: { title: "Inject Mixdog Slash Command", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Inject a supported Mixdog slash command into the active channel/session.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["reload-plugins", "clear"],
          description: "Slash command to inject."
        }
      },
      required: ["command"]
    }
  }
];
