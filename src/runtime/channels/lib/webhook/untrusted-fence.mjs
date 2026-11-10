// Webhook fields are external, attacker-controllable input. Prompts fence them
// with this marker token and scrub the token from the content, so a field
// cannot close its own fence early and smuggle instructions into the agent
// prompt (indirect prompt injection).
export const UNTRUSTED_MARKER = 'WEBHOOK_UNTRUSTED_DATA';

export function scrubFenceMarker(value) {
  return String(value).split(UNTRUSTED_MARKER).join('WEBHOOK_DATA');
}
