export const TOOL_DEFS = [
  {
    name: "reply",
    title: "Discord Reply",
    annotations: { title: "Discord Reply", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Send message to configured channel. files are local paths.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target channel/chat id." },
        text: { type: "string", description: "Message text." },
        reply_to: { type: "string", description: "Reply message id." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths."
        },
        embeds: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Discord embeds."
        },
        components: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Discord components."
        }
      },
      required: ["chat_id", "text"]
    }
  },
  {
    name: "react",
    title: "Reaction",
    annotations: { title: "Reaction", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "React to channel message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target channel/chat id." },
        message_id: { type: "string", description: "Message id." },
        emoji: { type: "string", description: "Emoji." }
      },
      required: ["chat_id", "message_id", "emoji"]
    }
  },
  {
    name: "edit_message",
    title: "Edit Message",
    annotations: { title: "Edit Message", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Edit bot-authored channel message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target channel/chat id." },
        message_id: { type: "string", description: "Bot message id." },
        text: { type: "string", description: "Replacement text." },
        embeds: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Replacement embeds."
        },
        components: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Replacement components."
        }
      },
      required: ["chat_id", "message_id", "text"]
    }
  },
  {
    name: "download_attachment",
    title: "Download Attachment",
    annotations: { title: "Download Attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Download message attachments.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Source channel/chat id." },
        message_id: { type: "string", description: "Message id." }
      },
      required: ["chat_id", "message_id"]
    }
  },
  {
    name: "fetch",
    title: "Fetch",
    annotations: { title: "Fetch", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Discord-only recent messages. NOT for URLs; use web_fetch.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Discord channel id." },
        limit: { type: "number", description: "Max messages." }
      },
      required: ["channel"]
    }
  },
  {
    name: "schedule_status",
    title: "Schedule Status",
    annotations: { title: "Schedule Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Show schedule status.",
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
    description: "Run schedule now.",
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
    description: 'Defer or skip a schedule.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Schedule name." },
        action: { type: "string", enum: ["defer", "skip_today"], description: "Control action." },
        minutes: { type: "number", description: "Defer minutes." }
      },
      required: ["name", "action"]
    }
  },
  {
    name: "activate_channel_bridge",
    title: "Activate Channel Bridge",
    annotations: { title: "Activate Channel Bridge", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Toggle channel bridge.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "Activate forwarding." }
      },
      required: ["active"]
    }
  },
  // memory and recall_memory tools are now provided by memory-service.mjs via MCP
  {
    name: "reload_config",
    title: "Reload Config",
    annotations: { title: "Reload Config", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Reload channel/runtime config.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "inject_command",
    title: "Inject Mixdog Slash Command",
    annotations: { title: "Inject Mixdog Slash Command", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Inject supported Mixdog slash command.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["reload-plugins", "clear"],
          description: "Slash command."
        }
      },
      required: ["command"]
    }
  }
];
