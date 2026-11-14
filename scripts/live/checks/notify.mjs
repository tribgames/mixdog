// notify/state answers with the shape the settings page reads, and a host request the desktop does not serve fails
// with unsupportedMethod (through a test-only core method; skipped when the core has none).
export const name = 'notify state and unsupported host request';

/** The core's test-only method that sends the desktop a host request it does not serve (absent in a build without test hooks). */
export const UNSUPPORTED_PROBE = 'test/host/unsupported';

export async function run({ env }) {
  const state = await env.core.request('notify/state', {});
  if (typeof state?.supported !== 'boolean') throw new Error(`notify/state answered no boolean "supported": ${JSON.stringify(state).slice(0, 200)}`);
  if (!('notifications' in state)) throw new Error('notify/state answered no "notifications"');
  try {
    await env.core.request(UNSUPPORTED_PROBE, {});
  } catch (error) {
    const detail = error?.detail;
    if (detail?.kind === 'unknownMethod' || (detail?.kind === 'rpc' && detail.code === -32601)) return `notify/state supported=${state.supported}; skipped the unsupportedMethod probe: the core has no ${UNSUPPORTED_PROBE}`;
    if (detail?.kind === 'rpc' && (detail.reason === 'unsupportedMethod' || /unsupportedMethod/.test(detail.message))) return `notify/state supported=${state.supported}; the unserved host request failed with unsupportedMethod`;
    throw new Error(`${UNSUPPORTED_PROBE} failed with something other than unsupportedMethod: ${JSON.stringify(detail ?? String(error)).slice(0, 300)}`);
  }
  throw new Error(`${UNSUPPORTED_PROBE} succeeded: a host request the desktop does not serve must fail with unsupportedMethod`);
}
