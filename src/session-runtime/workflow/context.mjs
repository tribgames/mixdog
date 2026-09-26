// Prompt-facing workflow context: the summary row and the system-prompt block
// (active pack + orchestration instructions + delegatable agent catalog).
import { clean } from '../session-text.mjs';
import { configuredOrchestrationMode } from '../../runtime/shared/orchestration.mjs';
import { orchestrationInstructions } from '../orchestration.mjs';
import { DEFAULT_WORKFLOW_ID, normalizeWorkflowId } from '../workflow-ids.mjs';

export function createWorkflowContext({ packs, agents }) {
  function workflowSummary(pack, { hasAgents = true, orchestrationMode = 'none' } = {}) {
    const id = normalizeWorkflowId(pack?.id, DEFAULT_WORKFLOW_ID);
    return {
      id,
      name: clean(pack?.name) || (id === 'default' ? 'Default' : id),
      description: clean(pack?.description),
      source: clean(pack?.source),
      // Effective session capability, not an editable workflow property.
      delegatesAgents: orchestrationMode !== 'none' && hasAgents !== false,
    };
  }

  // Status-pulse read (boot/facade currentWorkflow, every session every 2 s):
  // the pack and the agent list both come from the process-wide shared caches.
  function activeWorkflowSummary(config, dir) {
    return workflowSummary(packs.sharedWorkflowPack(dir, packs.activeWorkflowId(config)), {
      hasAgents: agents.delegatableAgentIds(config, dir).length > 0,
      orchestrationMode: configuredOrchestrationMode(config),
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

  function orchestrationContextBlock(config, dir) {
    const instructions = orchestrationInstructions(configuredOrchestrationMode(config));
    if (!instructions) return '';
    const lines = [instructions];
    const agentIds = agents.delegatableAgentIds(config, dir);
    const agentBlocks = agentIds.map((id) => agents.loadAgentDefinition(dir, id)).filter(Boolean);
    if (agentBlocks.length) {
      lines.push('# Available Agents');
      // Name + description only: the AGENT.md body is the worker's own system
      // prompt and rides in the worker session at spawn time — repeating it in
      // the Lead prompt only bloats context. Lead picks agents by description
      // (a when-to-use signal); orchestration carries the delegation rules.
      lines.push(
        agentBlocks
          .map((agent) => `- ${agent.name} (${agent.id})${agent.description ? `: ${agent.description}` : ''}`)
          .join('\n')
      );
    }
    return lines.join('\n\n');
  }

  // Single-pass variant: loads the active WORKFLOW.md pack once and derives both
  // the summary and the context block from it, so session-create does not re-read
  // and re-parse WORKFLOW.md twice on the hot boot path.
  function activeWorkflowContext(config, dir) {
    const pack = packs.loadWorkflowPack(dir, packs.activeWorkflowId(config));
    const orchestrationMode = configuredOrchestrationMode(config);
    return {
      summary: workflowSummary(pack, {
        hasAgents: agents.delegatableAgentIds(config, dir).length > 0,
        orchestrationMode,
      }),
      orchestrationMode,
      context: [workflowContextBlockFromPack(pack), orchestrationContextBlock(config, dir)]
        .filter(Boolean)
        .join('\n\n'),
    };
  }

  return {
    workflowSummary,
    activeWorkflowSummary,
    workflowContextBlock: (config, dir) => activeWorkflowContext(config, dir).context,
    activeWorkflowContext,
  };
}
