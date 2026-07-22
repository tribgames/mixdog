export const TOOL_DEFS = [
  {
    name: "reply",
    title: "Discord Reply",
    annotations: { title: "Discord Reply", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Send message to configured channel. files are local paths.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message text for the configured channel." },
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
      required: ["message"]
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
  // memory and recall_memory tools are now provided by memory-service.mjs via MCP
  // react/edit_message/download_attachment tools removed (no remaining
  // callers); backend editMessage/downloadAttachment/react methods stay for
  // internal use.
  // schedule_status/trigger_schedule/schedule_control tools removed (no
  // remaining callers). activate_channel_bridge/reload_config are NOT model-
  // facing tools anymore (no TOOL_DEFS entry) but the underlying
  // channels.execute('activate_channel_bridge'|'reload_config', ...) dispatch
  // stays alive in index.mjs/channel-worker.mjs because
  // mixdog-session-runtime.mjs calls them directly as internal Lead-only
  // runtime plumbing (bridge-claim on start, config hot-reload) — see
  // reloadChannelsSoon() and the remote-start bridge claim.
];
