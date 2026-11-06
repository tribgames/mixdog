// The core's half of a secret fill, for the tests of the desktop half: it holds the user's value (the
// slot lives in the core, not in the desktop), asks the desktop to check the bound page without the
// value (`secret_precheck`), and only on `ready` takes the value and sends it (`secret_fill`).
import { precheckSecretFill, runSecretFill } from './host-agent.ts';

export async function fillSecretInput(host, sessionId, requestId, signal, registry) {
  if (!registry.has(requestId)) {
    registry.discard(requestId);
    return { text: 'expired' };
  }
  const desk = { hostId: 'test-host', ...host };
  const checked = precheckSecretFill(desk, sessionId, requestId, registry);
  if (checked.text !== 'ready') {
    registry.discard(requestId);
    return checked;
  }
  const value = registry.take(requestId);
  const username = registry.take(`${requestId}-username`);
  const save = registry.take(`${requestId}-save`) === '1';
  return runSecretFill(desk, sessionId, requestId, { value, username, save }, signal, registry);
}
