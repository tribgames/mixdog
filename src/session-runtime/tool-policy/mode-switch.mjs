// Applying an orchestration (delegation) mode switch to a session: the
// overlay that carries the new mode's rules while the prompt keeps its own,
// and the transcript boundary.
import {
  orchestrationModeNoticeContent,
  stageOrchestrationModeSwitchNotice,
} from '../../runtime/agent/orchestrator/session/manager/orchestration-mode-switch-notice.mjs';
import { recordTranscriptBoundary } from '../model-route/set-route.mjs';
import { currentMode, promptMode, toolNames } from './surface-helpers.mjs';

// `agent` when `mode` delegates and the session can run it but holds it only
// as a deferred tool the model has not loaded.
function modeLoadableTools(session, mode) {
  if (mode === 'none') return [];
  const reached = new Set([
    ...toolNames(session.tools),
    ...toolNames(session.deferredCallableTools),
    ...toolNames(session.deferredDiscoveredTools),
  ]);
  const deferred = new Set(toolNames(session.deferredToolCatalog));
  const denied = new Set(
    [...(session.disallowedTools || []), ...(session.workflowOverlay?.deniedTools || [])].map(String)
  );
  return ['agent'].filter((name) => deferred.has(name) && !reached.has(name) && !denied.has(name));
}

export function applyOrchestrationModeSwitch(session, mode) {
  const from = currentMode(session);
  const prompt = promptMode(session);
  session.orchestrationMode = mode;
  delete session.orchestrationModeOverlay;
  if (mode !== prompt) {
    const loadableTools = modeLoadableTools(session, mode);
    session.orchestrationModeOverlay = {
      prompt,
      mode,
      loadableTools,
      content: orchestrationModeNoticeContent({ mode, loadableTools }),
    };
  }
  session.updatedAt = Date.now();
  stageOrchestrationModeSwitchNotice(session, from, mode);
  let orchestrationModeSwitch = null;
  if (from !== mode) {
    orchestrationModeSwitch = { from, to: mode, at: Date.now() };
    recordTranscriptBoundary(
      session,
      'orchestrationModeSwitches',
      orchestrationModeSwitch,
      (entry) => entry?.at === orchestrationModeSwitch.at && entry?.from === from && entry?.to === mode
    );
  }
  return { appliedToCurrentSession: true, mode, orchestrationModeSwitch };
}
