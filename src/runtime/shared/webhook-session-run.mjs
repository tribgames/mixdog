/**
 * Run an inbound webhook as a VISIBLE Mixdog session (schedules parity, user
 * decision): no Lead-context injection, no channel forward — the fire leaves
 * a resumable session with owner 'user' + sourceType 'webhook' that surfaces
 * in desktop Recent / TUI resume with the normal unread marker. Invoked from
 * the channels worker's webhook dispatch.
 */
import { loadConfig } from '../agent/orchestrator/config.mjs';
import { createSession } from '../agent/orchestrator/session/manager/session-lifecycle.mjs';
import { askSession } from '../agent/orchestrator/session/manager/ask-session.mjs';
import { parseScheduleModelRef } from './schedule-model-ref.mjs';

/** Endpoint model ref wins; the maintenance.webhook route is the fallback. */
function webhookRoute(modelRef) {
  if (modelRef) {
    const ref = parseScheduleModelRef(modelRef);
    if (ref && typeof ref === 'object') return ref;
  }
  const cfg = loadConfig({ secrets: false });
  const maintenance = cfg?.maintenance?.webhook;
  if (maintenance?.provider && maintenance?.model) {
    return { provider: maintenance.provider, model: maintenance.model };
  }
  throw new Error('webhook run has no model: set one on the endpoint or configure maintenance.webhook');
}

export async function runWebhookSession({ name, model = null, prompt }) {
  const endpoint = String(name || '').trim();
  const body = String(prompt || '').trim();
  if (!endpoint) throw new Error('runWebhookSession: endpoint name required');
  if (!body) throw new Error(`webhook "${endpoint}" has no prompt body`);
  const route = webhookRoute(model);
  const session = createSession({
    provider: route.provider,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.fast === true ? { fast: true } : {}),
    owner: 'user',
    sourceType: 'webhook',
    sourceName: endpoint,
    desktopSession: { classification: 'task', projectPath: null },
  });
  // The user message leads with the endpoint's instructions, so Recent titles
  // read as the user-authored intent rather than payload noise.
  const result = await askSession(session.id, body, null, null, undefined);
  return { sessionId: session.id, result: String(result?.content || '') };
}
