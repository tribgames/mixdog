// Applying a mid-conversation workflow switch: the overlay it lays over the
// session's prompt, and the tool changes it makes reachable without touching
// the prefix.
import { toSessionWorkflowMeta } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import {
  promptWorkflowOf,
  stageWorkflowSwitchNotice,
  workflowOverlayContent,
} from '../../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { mergePendingDeferredToolDelta } from '../../runtime/agent/orchestrator/runtime-core/deferred-tool-delta.mjs';
import { recordTranscriptBoundary } from '../model-route/set-route.mjs';
import { promptMode, schemaTools, toolName } from './surface-helpers.mjs';

export function createWorkflowOverlay({ liveDeniedTools, modelStandaloneTools }) {
  // The overlay of a switch to `target` while the prompt carries `prompt`
  // (manager/workflow-switch-notice.mjs): what the reminder tells the Lead and
  // which calls are refused. Nothing in the request prefix moves.
  function workflowOverlay(session, { target, parts }, { prompt, promptOrchestrationMode }) {
    const denied = new Set(liveDeniedTools(session, target.summary).map((name) => name.toLowerCase()));
    const disallowed = new Set((session.disallowedTools || []).map((name) => String(name).toLowerCase()));
    const deniedTools = [
      ...new Set(
        schemaTools(session)
          .map(toolName)
          .filter((name) => name && denied.has(name.toLowerCase()) && !disallowed.has(name.toLowerCase()))
      ),
    ];
    // Tools the new workflow allows that the session's policy denied (`agent`
    // after a switch to a workflow with agents): reachable by deferred loading.
    // `modelStandaloneTools` follows the session's workflow here (the caller
    // drops the old overlay first), so their definitions are current.
    // An earlier switch may have opened one already (workflowOpenedTools).
    const reopened = [
      ...new Set([...(session.disallowedTools || []), ...(session.workflowOpenedTools || [])].map(String)),
    ].filter((name) => !denied.has(name.toLowerCase()));
    const known = new Set(schemaTools(session).map(toolName));
    const fresh = modelStandaloneTools().filter(
      (tool) => reopened.includes(toolName(tool)) && !known.has(toolName(tool))
    );
    for (const tool of fresh) known.add(toolName(tool));
    const loadableTools = reopened.filter((name) => known.has(name));
    const unavailableTools = reopened.filter((name) => !known.has(name));
    const workflow = { id: target.summary.id, name: target.summary.name || target.summary.id };
    const instructions = [
      target.packContext,
      parts.orchestrationContext ||
        `# Delegation\n\n${workflow.name} has no agents to delegate to: do the work yourself.`,
      parts.agentCatalogContext,
    ]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n\n');
    const overlay = {
      prompt,
      promptOrchestrationMode,
      workflow,
      orchestrationMode: target.orchestrationMode,
      deniedTools,
      loadableTools,
      unavailableTools,
      content: workflowOverlayContent({
        promptName: prompt?.name || prompt?.id || 'the previous workflow',
        workflow,
        instructions,
        deniedTools,
        loadableTools,
        unavailableTools,
      }),
    };
    return { overlay, fresh };
  }

  // Make a switch's loadable tools reachable without touching the prefix: their
  // definitions join the deferred catalog, the policy stops denying them, and
  // the next turn's deferred_tools_delta names them. Switching back refuses
  // them again (the overlay's deniedTools, or the policy's deny list below).
  function openLoadableTools(session, { loadableTools, fresh }) {
    if (!loadableTools.length) return;
    const opened = session.workflowOpenedTools || [];
    session.workflowOpenedTools = [...new Set([...opened, ...loadableTools])];
    if (fresh.length) session.deferredToolCatalog = [...(session.deferredToolCatalog || []), ...fresh];
    session.disallowedTools = (session.disallowedTools || []).filter((name) => !loadableTools.includes(String(name)));
    const byName = new Map(schemaTools(session).map((tool) => [toolName(tool), tool]));
    // Announced on every switch that opens them: a pending removal (a switch
    // back in between) cancels against it rather than lingering.
    mergePendingDeferredToolDelta(session, {
      added: loadableTools.map((name) => ({ name, description: byName.get(name)?.description || '' })),
    });
  }

  // Back on the workflow the prompt carries: tools an earlier switch opened
  // that it denies are denied again (call-time refusal; the schema stays).
  function closeReopenedTools(session, target) {
    const denied = new Set(liveDeniedTools(session, target.summary));
    const disallowed = new Set((session.disallowedTools || []).map(String));
    const known = new Set(schemaTools(session).map(toolName));
    const closed = [...denied].filter((name) => known.has(name) && !disallowed.has(name));
    if (!closed.length) return;
    session.disallowedTools = [...disallowed, ...closed];
    mergePendingDeferredToolDelta(session, { removed: closed });
  }

  function applyWorkflowSwitch(session, resolved) {
    const { target } = resolved;
    const before = session.workflow;
    const from = before?.id ? before : null;
    const prompt = promptWorkflowOf(session);
    const promptOrchestrationMode = promptMode(session);
    session.workflow = toSessionWorkflowMeta(target.summary);
    session.orchestrationMode = target.orchestrationMode;
    delete session.workflowOverlay;
    if (session.workflow.id === prompt?.id) closeReopenedTools(session, target);
    else {
      const { overlay, fresh } = workflowOverlay(session, resolved, { prompt, promptOrchestrationMode });
      openLoadableTools(session, { loadableTools: overlay.loadableTools, fresh });
      session.workflowOverlay = overlay;
    }
    session.updatedAt = Date.now();
    stageWorkflowSwitchNotice(session, from, session.workflow);
    let workflowSwitch = null;
    if (from?.id !== session.workflow.id) {
      workflowSwitch = {
        fromId: from?.id || '',
        from: from?.name || from?.id || '',
        toId: session.workflow.id,
        to: session.workflow.name,
        at: Date.now(),
      };
      // Two switches can land in the same millisecond (A→B→A): the same
      // switch is a repeat only when its direction matches too.
      recordTranscriptBoundary(
        session,
        'workflowSwitches',
        workflowSwitch,
        (entry) =>
          entry?.at === workflowSwitch.at &&
          entry?.fromId === workflowSwitch.fromId &&
          entry?.toId === workflowSwitch.toId
      );
    }
    return { appliedToCurrentSession: true, workflow: session.workflow, workflowSwitch };
  }

  return { applyWorkflowSwitch };
}
