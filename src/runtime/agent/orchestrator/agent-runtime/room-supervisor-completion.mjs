// One group-room supervisor step on the Maintainer model route (the route
// compaction and the other maintenance roles resolve): a session-less, tool-free
// one-shot send. Prompt and parsing live in session/agent-room-supervisor.mjs.
import { loadConfig } from '../config.mjs';
import { getProvider, initProviders } from '../providers/registry.mjs';
import { parseRoomDecision, roomSupervisorPrompt } from '../session/agent-room-supervisor.mjs';
import { resultText } from './completion-text.mjs';
import { resolveMaintenanceRoute } from './maintenance-route.mjs';

const TIMEOUT_MS = 30_000;
// Every step's prompt is new and asked once: a cache write would cost more
// than any read it could earn, so no layer is marked.
const NO_PROMPT_CACHE = Object.freeze({ tools: 'none', system: 'none', tier3: 'none', messages: 'none' });

export function createRoomSupervisorCompletion(deps = {}) {
  const load = deps.loadConfig || loadConfig;
  const resolveRoute = deps.resolveMaintenanceRoute || resolveMaintenanceRoute;
  const initialize = deps.initProviders || initProviders;
  const providerFor = deps.getProvider || getProvider;
  const log = deps.log || ((line) => process.stderr.write(line));

  /** The decision for one step (parseRoomDecision), null for an unusable
   *  reply, `{ action: 'unmanaged' }` when no Maintainer model is configured;
   *  throws when the configured provider is unavailable. */
  return async function decideRoomTurn(input = {}) {
    const members = (Array.isArray(input?.members) ? input.members : [])
      .filter((member) => member && typeof member.id === 'string' && member.id)
      .map((member) => ({
        id: member.id,
        name: typeof member.name === 'string' ? member.name : member.id,
        description: typeof member.description === 'string' ? member.description : '',
      }));
    if (!members.length) return null;
    const config = load();
    // The Maintainer's own route only: a step runs after every turn, so it
    // never falls back to the default (Lead) model the user pays most for.
    // Without one the room is unmoderated: the members called answer once.
    const route = resolveRoute({ agent: 'cycle1-agent', config, includeDefault: false });
    const providerName = String(route?.provider || '').trim();
    const model = String(route?.model || '').trim();
    if (!providerName || !model) return { action: 'unmanaged' };
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    await initialize(config.providers || {}, { signal });
    const provider = providerFor(providerName);
    if (!provider || typeof provider.send !== 'function') {
      throw new Error(`Room supervisor provider is unavailable: ${providerName}`);
    }
    const { system, user } = roomSupervisorPrompt({
      roomName: input.roomName,
      members,
      rows: input.rows,
      turns: Array.isArray(input.turns) ? input.turns : [],
      mustPick: input.mustPick === true,
      last: typeof input.last === 'string' ? input.last : '',
      remaining: input.remaining && typeof input.remaining === 'object' ? input.remaining : {},
    });
    const startedAt = Date.now();
    const response = await provider.send(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      model,
      undefined,
      {
        signal,
        effort: String(route.effort || '').trim() || 'low',
        fast: route.fast === true,
        maxOutputTokens: 400,
        // The room falls back at once instead of waiting out a retry.
        retry529: false,
        cacheStrategy: NO_PROMPT_CACHE,
      }
    );
    const reply = resultText(response);
    const decision = parseRoomDecision(reply, members);
    // One line per step in daemon.log: its latency and outcome, and for an
    // unusable reply its bounded head, so failures can be told apart.
    const outcome = !decision
      ? `none reply=${JSON.stringify(String(reply ?? '').slice(0, 160))}`
      : `${decision.action}${decision.action === 'speak' ? `:${decision.agentId}` : ''} scene=${decision.scene}`;
    log(`[room-supervisor] model=${model} ms=${Date.now() - startedAt} decision=${outcome}\n`);
    return decision;
  };
}

export const decideRoomTurn = createRoomSupervisorCompletion();
