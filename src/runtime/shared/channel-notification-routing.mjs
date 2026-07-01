export function channelNotificationModelContent(params = {}) {
  const meta = params?.meta && typeof params.meta === 'object' ? params.meta : {};
  if (meta.silent_to_agent === true || meta.silent_to_agent === 'true') return '';
  const instruction = typeof meta.instruction === 'string' ? meta.instruction.trim() : '';
  const content = String(params?.content || '').trim();
  return instruction || content;
}

export function shouldMirrorChannelNotificationToPending(meta = {}) {
  const type = String(meta?.type || '').trim().toLowerCase();
  return type === 'schedule';
}
