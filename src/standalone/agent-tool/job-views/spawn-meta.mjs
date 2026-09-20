// job-views/spawn-meta.mjs
// The task meta a spawn carries: from a prepared spawn, from raw args while
// the spawn is still pending, and merging later updates into a job.
import { sanitizeTaskMeta } from '../../../runtime/shared/background-tasks.mjs';
import { clean, normalizeAgentName, presetKey } from '../helpers.mjs';
import { resolveAgentSpawnPreset } from '../spawn-preset.mjs';

export function preparedSpawnMeta(prepared, extras = {}) {
  return sanitizeTaskMeta({
    ...(extras || {}),
    tag: prepared.tag,
    sessionId: prepared.session.id,
    agent: prepared.agent,
    preset: presetKey(prepared.preset) || prepared.presetName,
    provider: prepared.preset.provider,
    model: prepared.preset.model,
    effort: prepared.preset.effort || null,
    fast: prepared.preset.fast === true,
  });
}

/** Best-effort resolve the default preset so the pending "Spawn …" card can
 *  already show the model (e.g. "Spawn Heavy Worker (Opus 4.8)") even when the
 *  caller did not pass an explicit provider/model. Never throws: falls back to
 *  whatever raw args carry. */
export function pendingSpawnMeta(cfgMod, args = {}, extras = {}) {
  const agent = normalizeAgentName(args.agent);
  let resolved = null;
  if (!clean(args.model) || !clean(args.provider)) {
    try {
      resolved = resolveAgentSpawnPreset(cfgMod.loadConfig(), args)?.preset || null;
    } catch {
      resolved = null;
    }
  }
  return sanitizeTaskMeta({
    ...(extras || {}),
    tag: clean(args.tag) || null,
    sessionId: null,
    agent: agent || null,
    preset: clean(args.preset) || presetKey(resolved) || null,
    provider: clean(args.provider) || clean(resolved?.provider) || null,
    model: clean(args.model) || clean(resolved?.model) || null,
    effort: clean(args.effort) || clean(resolved?.effort) || null,
    fast: args.fast === true || resolved?.fast === true ? true : null,
  });
}

export function mergeJobMeta(job, meta = {}) {
  if (!job || !meta || typeof meta !== 'object') return;
  const next = sanitizeTaskMeta({ ...(job.meta || {}), ...meta });
  job.meta = next;
  if (job.input && typeof job.input === 'object') {
    job.input = {
      ...job.input,
      tag: next.tag || job.input.tag || null,
      sessionId: next.sessionId || job.input.sessionId || null,
      agent: next.agent || job.input.agent || null,
    };
  }
  job.label = next.tag || next.sessionId || job.label;
}
