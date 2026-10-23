// Prompt-facing workflow context: the summary row and the system-prompt block
// (active pack + orchestration instructions + delegatable agent catalog).
import { clean } from '../session-text.mjs';
import { configuredOrchestrationMode } from '../../../../shared/orchestration.mjs';
import { AGENT_MODE_DELEGATION, MIXY_CONTACTS_INTRO, orchestrationInstructions } from '../orchestration.mjs';
import { DEFAULT_WORKFLOW_ID, isContactAgentId, normalizeWorkflowId } from '../workflow-ids.mjs';

export function createWorkflowContext({ packs, agents }) {
  function workflowSummary(pack, { hasAgents = true } = {}) {
    const id = normalizeWorkflowId(pack?.id, DEFAULT_WORKFLOW_ID);
    return {
      id,
      name: clean(pack?.name) || (id === 'default' ? 'Default' : id),
      description: clean(pack?.description),
      source: clean(pack?.source),
      // Effective session capability, not an editable workflow property.
      // Solo keeps the agent tool deferred for explicit user requests.
      delegatesAgents: hasAgents !== false,
    };
  }

  // Status-pulse read (boot/facade currentWorkflow, every session every 2 s):
  // the pack and the agent list both come from the process-wide shared caches.
  function activeWorkflowSummary(config, dir) {
    return workflowSummary(packs.sharedWorkflowPack(dir, packs.activeWorkflowId(config)), {
      hasAgents: agents.delegatableAgentIds(config, dir).length > 0,
    });
  }

  function workflowContextBlockFromPack(pack) {
    if (!pack) return '';
    // The pack body opens with its own `# <name>` title, so header + description
    // + body used to repeat the workflow name three times in the prompt. Emit one
    // header line and drop the body's duplicate title (only when it matches).
    const rawBody = String(pack.body || '');
    const firstBreak = rawBody.indexOf('\n');
    const firstLine = (firstBreak === -1 ? rawBody : rawBody.slice(0, firstBreak)).trim();
    const body =
      firstBreak !== -1 && firstLine.toLowerCase() === `# ${String(pack.name || '').toLowerCase()}`
        ? rawBody.slice(firstBreak + 1).replace(/^\s+/, '')
        : rawBody;
    const lines = [`# Active Workflow: ${pack.name}${pack.description ? ` — ${pack.description}` : ''}`, body];
    return lines.join('\n\n');
  }

  // Name + description only: the AGENT.md body is the worker's own system
  // prompt and rides in the worker session at spawn time — repeating it in
  // the Lead prompt only bloats context. Lead picks agents by description
  // (a when-to-use signal); orchestration carries the delegation rules.
  function agentCatalog(dir, ids) {
    return ids
      .map((id) => agents.loadAgentDefinition(dir, id))
      .filter(Boolean)
      .map((agent) => `- ${agent.name} (${agent.id})${agent.description ? `: ${agent.description}` : ''}`)
      .join('\n');
  }

  // A Lead's workflow slices for BP3 (composeSystemPrompt orders them):
  // - coding: the orchestration mode block and the full agent catalog;
  // - agent mode: the fixed delegation block (no per-agent setting) and the
  //   sub-agent catalog — identical for every agent, so their prompts share
  //   it — plus the contact-agent catalog: every bot but `agentId` itself.
  function leadPromptParts(config, dir, { agentMode = false, agentId = '' } = {}) {
    const mode = configuredOrchestrationMode(config);
    const ids = agents.delegatableAgentIds(config, dir);
    const isContact = (id) => isContactAgentId(id, agents.loadAgentDefinition(dir, id)?.kind);
    if (!agentMode) {
      // Bots are never a coding Lead's agents: only agent-mode Leads hand them work.
      const workflowIds = ids.filter((id) => !isContact(id));
      const catalog = agentCatalog(dir, workflowIds);
      return {
        // Solo without agents has nothing to delegate to on request either.
        orchestrationContext: mode === 'none' && !workflowIds.length ? '' : orchestrationInstructions(mode),
        agentCatalogContext: catalog ? `# Available Agents\n\n${catalog}` : '',
        contactCatalogContext: '',
      };
    }
    const subAgents = agentCatalog(
      dir,
      ids.filter((id) => !isContact(id))
    );
    const contacts = agentCatalog(
      dir,
      ids.filter((id) => isContact(id) && id !== agentId)
    );
    return {
      // An agent-mode Lead without agents has no one to delegate to at all.
      orchestrationContext: subAgents || contacts ? AGENT_MODE_DELEGATION : '',
      agentCatalogContext: subAgents ? `# Available Agents\n\n${subAgents}` : '',
      contactCatalogContext: contacts ? `# Bots\n\n${MIXY_CONTACTS_INTRO}\n\n${contacts}` : '',
    };
  }

  // The coding Lead's combined block (orchestration + catalog), as before.
  function orchestrationContextBlock(config, dir) {
    const { orchestrationContext, agentCatalogContext } = leadPromptParts(config, dir);
    return [orchestrationContext, agentCatalogContext].filter(Boolean).join('\n\n');
  }

  // Single-pass variant: loads the active WORKFLOW.md pack once and derives both
  // the summary and the context block from it, so session-create does not re-read
  // and re-parse WORKFLOW.md twice on the hot boot path.
  function activeWorkflowContext(config, dir) {
    const pack = packs.loadWorkflowPack(dir, packs.activeWorkflowId(config));
    const orchestrationMode = configuredOrchestrationMode(config);
    const packContext = workflowContextBlockFromPack(pack);
    return {
      summary: workflowSummary(pack, {
        hasAgents: agents.delegatableAgentIds(config, dir).length > 0,
      }),
      orchestrationMode,
      // Pack block alone: agent-owned sessions never get the Lead-only
      // orchestration instructions / agent catalog.
      packContext,
      context: [packContext, orchestrationContextBlock(config, dir)].filter(Boolean).join('\n\n'),
      // A Lead's BP3 slices beside the pack: `{ agentMode, agentId }` picks the
      // coding variant, or the agent variant of the agent `agentId` (session/agent-mode.mjs).
      leadPromptParts: (options) => leadPromptParts(config, dir, options),
    };
  }

  return {
    workflowSummary,
    activeWorkflowSummary,
    workflowContextBlock: (config, dir) => activeWorkflowContext(config, dir).context,
    activeWorkflowContext,
  };
}
