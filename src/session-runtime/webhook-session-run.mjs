/**
 * Run an inbound webhook: the endpoint's instructions and the fenced event
 * payload become one turn in its owner bot's home thread
 * (routine-home-turn.mjs). Invoked from the channels worker's webhook
 * dispatch and the app's "Run now".
 */
import { markEndpointRun } from '../runtime/channels/lib/webhooks-db.mjs';
import { runOwnedAutomation } from './owned-automation-run.mjs';
import { runRoutineTurn } from './routine-home-turn.mjs';

/**
 * One run of the endpoint in its owner's thread (Mixy when absent): a run
 * while the previous one of the same endpoint is still going is skipped (and
 * stamped), and every outcome is stamped on the endpoint. `prompt` carries the
 * fenced payload; `skillSelection` only the endpoint's instructions.
 */
export async function runWebhookSession({ ownerAgentId = null, ...options }, deps = {}) {
  const name = String(options.name || '').trim();
  const { markRun = markEndpointRun, run = runWebhookTurn, ...ownedDeps } = deps;
  const stamp = (outcome) =>
    markRun(name, outcome, new Date()).catch((error) =>
      process.stderr.write(`mixdog webhook: ${name} ${outcome} stamp failed: ${error?.message || error}\n`)
    );
  let outcome;
  try {
    // The dispatch's cancellation reaches the run as `signal`.
    outcome = await runOwnedAutomation(
      'webhook',
      { name, ownerAgentId },
      ({ signal }) => run({ ...options, ownerAgentId, signal }),
      { recordSkip: () => stamp('skipped'), signal: options.signal || null, ...ownedDeps }
    );
  } catch (error) {
    await stamp('failed');
    throw error;
  }
  if (!outcome.skipped) await stamp('success');
  return outcome;
}

/** One turn in the owner's thread; `skillSelection` absent selects nothing. */
function runWebhookTurn({
  name,
  prompt,
  ownerAgentId = null,
  cwd = null,
  attachments = null,
  event = '',
  skillSelection = '',
  signal = null,
}) {
  const endpoint = String(name || '').trim();
  if (!endpoint) throw new Error('runWebhookSession: endpoint name required');
  return runRoutineTurn({
    kind: 'webhook',
    name: endpoint,
    ownerAgentId,
    prompt,
    skillSelection: String(skillSelection ?? ''),
    attachments,
    cwd,
    event,
    signal,
  });
}
