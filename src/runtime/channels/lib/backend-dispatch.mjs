import { recordFetchedMessages } from "./status-snapshot.mjs";

// Backend-tool dispatch helpers. Extracted verbatim from channels/index.mjs
// (behavior-preserving). Bound to live getters so runtime config/backend
// reloads keep the original file-level reference semantics.
function createBackendDispatch({ getConfig, getBackend, scheduler }) {
  async function dispatchReply(args) {
    const sendOpts = {
      replyTo: args.reply_to,
      files: args.files ?? [],
      embeds: args.embeds ?? [],
      components: args.components ?? []
    };
    let ids;
    // Pre-send activity bump keeps idle gating consistent during the await.
    scheduler.noteActivity();
    const sendResult = await getBackend().sendMessage(args.chat_id, args.text, sendOpts);
    scheduler.noteActivity();
    ids = sendResult.sentIds;
    const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(", ")})`;
    return { content: [{ type: "text", text }] };
  }

  async function dispatchFetch(args) {
    // `args.channel` is a raw channel id (no label resolution anymore); when
    // omitted, fall back to the single configured main channel id.
    const config = getConfig();
    const channelId = args.channel || config.channelId || "";
    const limit = args.limit ?? 20;
    let msgs;
    msgs = await getBackend().fetchMessages(channelId, limit);
    recordFetchedMessages(channelId, channelId, msgs);
    const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
      const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
      return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
    }).join("\n");
    return { content: [{ type: "text", text }] };
  }

  return {
    dispatchReply,
    dispatchFetch,
  };
}

export { createBackendDispatch };
