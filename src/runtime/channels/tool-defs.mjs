export const TOOL_DEFS = [
  // reply/fetch model-facing tools removed 2026-08: the output forwarder
  // delivers session output to the channel and the inbound bridge injects
  // incoming messages, so the model never needed to call them directly.
  // memory and recall_memory tools are now provided by memory-service.mjs via MCP
  // react/edit_message/download_attachment tools removed (no remaining
  // callers); provider editMessage/downloadAttachment/react methods stay for
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
