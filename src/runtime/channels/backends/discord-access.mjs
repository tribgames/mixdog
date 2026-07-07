// Access-config helpers extracted from discord.mjs. Pure functions with no
// dependency on the backend instance; behavior is identical to the originals.

function defaultAccess() {
  return {
    dmPolicy: "allowlist",
    allowFrom: [],
    channels: {}
  };
}
function normalizeAccess(parsed) {
  const defaults = defaultAccess();
  return {
    dmPolicy: parsed?.dmPolicy ?? defaults.dmPolicy,
    allowFrom: parsed?.allowFrom ?? defaults.allowFrom,
    channels: parsed?.channels ?? defaults.channels,
    mentionPatterns: parsed?.mentionPatterns,
    // Setup UI historically saved a boolean toggle; runtime needs an emoji
    // string for msg.react(). true → default emoji, non-string → off.
    ackReaction: parsed?.ackReaction === true
      ? "✅"
      : (typeof parsed?.ackReaction === "string" && parsed.ackReaction ? parsed.ackReaction : undefined),
    replyToMode: parsed?.replyToMode,
    textChunkLimit: parsed?.textChunkLimit,
  };
}
function safeAttName(att) {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, "_");
}
export { defaultAccess, normalizeAccess, safeAttName };
