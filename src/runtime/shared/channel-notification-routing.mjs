export function channelNotificationModelContent(params = {}) {
  const meta = params?.meta && typeof params.meta === 'object' ? params.meta : {};
  if (meta.silent_to_agent === true || meta.silent_to_agent === 'true') return '';
  const instruction = typeof meta.instruction === 'string' ? meta.instruction.trim() : '';
  const content = String(params?.content || '').trim();
  return instruction || content;
}

export function channelNotificationSessionId(session, reservedSessionId = null) {
  return String(session?.id || reservedSessionId || '').trim() || null;
}
