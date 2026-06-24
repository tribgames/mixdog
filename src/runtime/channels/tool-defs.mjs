export const TOOL_DEFS = [
  {
    name: "reply",
    title: "Discord Reply",
    annotations: { title: "Discord Reply", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Reply on channel.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        text: { type: "string" },
        reply_to: { type: "string" },
        files: {
          type: "array",
          items: { type: "string" }
        },
        embeds: {
          type: "array",
          items: { type: "object", additionalProperties: true }
        },
        components: {
          type: "array",
          items: { type: "object", additionalProperties: true }
        }
      },
      required: ["chat_id", "text"]
    }
  },
  {
    name: "react",
    title: "Reaction",
    annotations: { title: "Reaction", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "React to message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        emoji: { type: "string" }
      },
      required: ["chat_id", "message_id", "emoji"]
    }
  },
  {
    name: "edit_message",
    title: "Edit Message",
    annotations: { title: "Edit Message", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Edit bot message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        text: { type: "string" },
        embeds: {
          type: "array",
          items: { type: "object", additionalProperties: true }
        },
        components: {
          type: "array",
          items: { type: "object", additionalProperties: true }
        }
      },
      required: ["chat_id", "message_id", "text"]
    }
  },
  {
    name: "download_attachment",
    title: "Download Attachment",
    annotations: { title: "Download Attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Download attachments.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" }
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
        channel: { type: "string" },
        limit: { type: "number" }
      },
      required: ["channel"]
    }
  },
  {
    name: "schedule_status",
    title: "Schedule Status",
    annotations: { title: "Schedule Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Show schedules.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "trigger_schedule",
    title: "Trigger Schedule",
    annotations: { title: "Trigger Schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Run a scheduled task immediately by name (fire it now). Requires name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "schedule_control",
    title: "Schedule Control",
    annotations: { title: "Schedule Control", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Defer or skip a schedule (not run it now): action=defer (push by `minutes`) | skip_today. Requires name + action.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        action: { type: "string", enum: ["defer", "skip_today"] },
        minutes: { type: "number" }
      },
      required: ["name", "action"]
    }
  },
  {
    name: "activate_channel_bridge",
    title: "Activate Channel Bridge",
    annotations: { title: "Activate Channel Bridge", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Set channel bridge active.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean" }
      },
      required: ["active"]
    }
  },
  // memory and recall_memory tools are now provided by memory-service.mjs via MCP
  {
    name: "reload_config",
    title: "Reload Config",
    annotations: { title: "Reload Config", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Reload config.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "inject_command",
    title: "Inject Claude Code Slash Command",
    annotations: { title: "Inject Claude Code Slash Command", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Inject slash command.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["reload-plugins", "clear"]
        }
      },
      required: ["command"]
    }
  }
];
