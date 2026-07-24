/**
 * Run a schedule as a VISIBLE Mixdog session instead of a hidden agent
 * dispatch. Shared by the engine run-now capability and the channels-worker
 * scheduler so both paths leave the same trail: a resumable session with
 * owner 'user' + sourceType 'schedule' (admitted by the lead-session list
 * filter as its own type, so it shows in desktop Recent / TUI resume), the
 * schedule's provider/model route, and the schedule's project cwd.
 */
import { loadConfig } from '../agent/orchestrator/config.mjs';
import { createSession } from '../agent/orchestrator/session/manager/session-lifecycle.mjs';
import { askSession } from '../agent/orchestrator/session/manager/ask-session.mjs';
import { parseScheduleModelRef } from './schedule-model-ref.mjs';
import { automationWorkflowOpts } from './automation-workflow.mjs';
import { automationPromptContent } from './automation-attachments.mjs';

/** Resolve schedule.model into a {provider,model,effort?,fast?} route. */
function scheduleRouteFromModelRef(modelRef, config = null) {
  const ref = parseScheduleModelRef(modelRef);
  if (ref && typeof ref === 'object') return ref;
  const cfg = config || loadConfig({ secrets: false });
  const preset = cfg.presets?.find((p) => p.id === ref || p.name === ref);
  if (!preset) {
    throw new Error(`schedule model "${ref}" is neither a provider/model route nor a known preset name`);
  }
  return {
    provider: preset.provider,
    model: preset.model,
    ...(preset.effort ? { effort: preset.effort } : {}),
    ...(preset.fast === true ? { fast: true } : {}),
  };
}

/**
 * Create the visible schedule session and run the prompt in it.
 * `prompt` overrides schedule.prompt when the caller (channels worker) has
 * already resolved/wrapped the prompt body; the override is used verbatim
 * while the fallback gets a small origin header.
 */
export async function runScheduleSession(schedule, { config = null, prompt: promptOverride = null } = {}) {
  if (!schedule?.name) throw new Error('runScheduleSession: schedule row required');
  const prompt = String(promptOverride ?? schedule.prompt ?? '').trim();
  if (!prompt) throw new Error(`schedule "${schedule.name}" has no instructions`);
  if (!schedule.model) {
    throw new Error(`schedule "${schedule.name}" has no model configured — edit it and choose a model first`);
  }
  const route = scheduleRouteFromModelRef(schedule.model, config);
  const cwd = schedule.cwd ? String(schedule.cwd) : null;
  // Every fire is a fresh New task (user decision): one prompt, the
  // schedule's model/workflow/project, a brand-new session in the sidebar
  // Automations section (newest per name wins there).
  const session = createSession({
    provider: route.provider,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.fast === true ? { fast: true } : {}),
    owner: 'user',
    sourceType: 'schedule',
    sourceName: schedule.name,
    sourceDelivery: schedule.delivery || null,
    ...(cwd ? { cwd } : {}),
    desktopSession: cwd
      ? { classification: 'project', projectPath: cwd }
      : { classification: 'task', projectPath: null },
    ...automationWorkflowOpts(schedule.workflow),
  });
  // The user message is the schedule's instructions verbatim: the desktop
  // title/preview derive from it, so no "[Scheduled task: …]" header noise.
  // Stored attachments ride along as composer-style content parts.
  const content = automationPromptContent(prompt, schedule.attachments);
  const result = await askSession(session.id, content, null, null, cwd || undefined);
  return { sessionId: session.id, result: String(result?.content || '') };
}
