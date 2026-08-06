export function channelNotificationModelContent(params = {}) {
  const meta = params?.meta && typeof params.meta === 'object' ? params.meta : {};
  if (meta.silent_to_agent === true || meta.silent_to_agent === 'true') return '';
  const instruction = typeof meta.instruction === 'string' ? meta.instruction.trim() : '';
  const content = String(params?.content || '').trim();
  return instruction || content;
}

export function shouldMirrorChannelNotificationToPending(meta = {}) {
  // Every inbound channel/schedule notification flows through the single
  // queue — when no live
  // listener handled it (engine not subscribed yet, pane disposed, headless),
  // it is mirrored into the session pending queue for the next turn instead
  // of being dropped. Silent-to-agent stays excluded; the upstream content
  // gate (channelNotificationModelContent → '') already enforces it, this is
  // a defensive second gate.
  return !(meta?.silent_to_agent === true || meta?.silent_to_agent === 'true');
}
