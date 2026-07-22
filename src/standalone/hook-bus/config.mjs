import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listRegisteredPlugins } from '../plugin-admin.mjs';
import { NO_MATCHER_EVENTS } from './constants.mjs';

export function hookRulesPath(dataDir) {
  if (process.env.MIXDOG_HOOKS_FILE) return resolve(process.env.MIXDOG_HOOKS_FILE);
  return dataDir ? join(dataDir, 'hooks.json') : null;
}

// User-level trust list: only projects the user has explicitly approved may run
// shell/http hooks from their own `.mixdog/hooks.json`. Everything else loads
// (so context/prompt hooks still work) but executable handlers are neutered.
function readTrustedProjects(dataDir) {
  if (!dataDir) return new Set();
  const out = new Set();
  for (const name of ['config.json', 'settings.json']) {
    try {
      const p = join(dataDir, name);
      if (!existsSync(p)) continue;
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      const list = parsed?.trustedProjects ?? parsed?.hooks?.trustedProjects;
      if (Array.isArray(list)) {
        for (const item of list) {
          const raw = String(item || '').trim();
          if (!raw) continue;
          const abs = resolve(raw);
          out.add(process.platform === 'win32' ? abs.toLowerCase() : abs);
        }
      }
    } catch {
      // ignore malformed user config; fail closed (project stays untrusted)
    }
  }
  return out;
}

function isProjectTrusted(dataDir, projectDir) {
  if (!projectDir) return false;
  const abs = resolve(projectDir);
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return readTrustedProjects(dataDir).has(key);
}

export function normalizeRules(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.toolBefore)) return raw.toolBefore;
  if (Array.isArray(raw?.beforeTool)) return raw.beforeTool;
  if (Array.isArray(raw?.hooks?.toolBefore)) return raw.hooks.toolBefore;
  return [];
}

function uniqueHookEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry?.path) continue;
    const resolved = resolve(entry.path);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, path: resolved });
  }
  return out;
}

function cleanHookId(value) {
  return String(value ?? '').trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pluginHookConfigEntries(dataDir) {
  if (!dataDir) return [];
  let plugins = [];
  try {
    plugins = listRegisteredPlugins({ dataDir });
  } catch {
    return [];
  }
  const entries = [];
  for (const plugin of plugins || []) {
    const root = String(plugin?.root || '').trim();
    if (!root || !existsSync(root)) continue;
    const id = cleanHookId(plugin.id || plugin.name || plugin.title || root.split(/[\\/]/).pop());
    const pluginData = join(dataDir, 'plugins', 'data', id || 'plugin');
    entries.push({
      path: join(root, 'hooks', 'hooks.json'),
      pluginRoot: root,
      pluginData,
      sourceType: 'plugin',
    });
    entries.push({
      path: join(root, '.mixdog', 'hooks.json'),
      pluginRoot: root,
      pluginData,
      sourceType: 'plugin',
    });
  }
  return entries;
}

export function hookConfigEntries(dataDir, cwd) {
  if (process.env.MIXDOG_HOOKS_FILE) {
    return uniqueHookEntries([{ path: process.env.MIXDOG_HOOKS_FILE, sourceType: 'env' }]);
  }
  const projectDir = cwd ? resolve(cwd) : process.cwd();
  const projectTrusted = isProjectTrusted(dataDir, projectDir);
  return uniqueHookEntries([
    projectDir ? { path: join(projectDir, '.mixdog', 'hooks.json'), sourceType: 'project', untrusted: !projectTrusted } : null,
    projectDir ? { path: join(projectDir, '.mixdog', 'hooks', 'hooks.json'), sourceType: 'project', untrusted: !projectTrusted } : null,
    dataDir ? { path: join(dataDir, 'hooks.json'), sourceType: 'data' } : null,
    dataDir ? { path: join(dataDir, 'hooks', 'hooks.json'), sourceType: 'data' } : null,
    ...pluginHookConfigEntries(dataDir),
  ]);
}

export function isStandardConfig(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const values = Object.values(hooks);
  if (values.length === 0) return false;
  return values.every((groups) => (
    Array.isArray(groups)
    && groups.every((g) => g && typeof g === 'object' && Array.isArray(g.hooks))
  ));
}

const SIMPLE_MATCHER_RE = /^[A-Za-z0-9_ ,|]*$/;
export function matcherFires(matcher, field) {
  if (matcher == null) return true;
  const text = String(matcher).trim();
  if (text === '' || text === '*') return true;
  const value = String(field ?? '');
  if (SIMPLE_MATCHER_RE.test(text)) {
    const items = text.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) return true;
    return items.includes(value);
  }
  try {
    return new RegExp(text).test(value);
  } catch {
    return true;
  }
}

export function parseStandardConfig(parsed, source, meta = {}) {
  const events = {};
  const hooks = parsed.hooks || {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleanGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const handlers = Array.isArray(group.hooks)
        ? group.hooks
          .filter((h) => h && typeof h === 'object' && h.type)
          .map((h) => ({
            ...h,
            _source: source,
            ...(meta.pluginRoot ? { _pluginRoot: meta.pluginRoot } : {}),
            ...(meta.pluginData ? { _pluginData: meta.pluginData } : {}),
            ...(meta.untrusted ? { _untrusted: true } : {}),
          }))
        : [];
      if (handlers.length === 0) continue;
      cleanGroups.push({ matcher: group.matcher, hooks: handlers, _source: source });
    }
    if (cleanGroups.length > 0) events[eventName] = cleanGroups;
  }
  return events;
}

export function mergeEvents(target, source) {
  for (const [eventName, groups] of Object.entries(source || {})) {
    if (!Array.isArray(target[eventName])) target[eventName] = [];
    target[eventName].push(...groups);
  }
}

export function buildEventPayload(eventName, input = {}) {
  const payload = {
    session_id: input.sessionId ?? input.session_id ?? null,
    cwd: input.cwd ?? null,
    hook_event_name: eventName,
  };
  if (input.transcriptPath != null || input.transcript_path != null) {
    payload.transcript_path = input.transcriptPath ?? input.transcript_path;
  }
  if (input.permissionMode != null || input.permission_mode != null) {
    payload.permission_mode = input.permissionMode ?? input.permission_mode;
  }
  if (input.effort != null) payload.effort = input.effort;
  const toolName = input.name ?? input.tool_name;
  if (toolName != null) payload.tool_name = toolName;
  const toolInput = input.args ?? input.tool_input;
  if (toolInput != null) payload.tool_input = toolInput;
  if (input.toolCallId != null || input.tool_use_id != null) {
    payload.tool_use_id = input.toolCallId ?? input.tool_use_id;
  }
  if (input.toolResponse != null || input.tool_response != null || input.result != null) {
    payload.tool_response = input.toolResponse ?? input.tool_response ?? input.result;
  }
  for (const key of [
    'prompt',
    'source',
    'model',
    'session_title',
    'message',
    'notification_type',
    'trigger',
    'load_reason',
    'file_path',
    'memory_type',
    'command_name',
    'command_args',
    'command_source',
    'expansion_type',
    'stop_reason',
    'error_type',
    'agent_type',
  ]) {
    if (input[key] != null) payload[key] = input[key];
  }
  return payload;
}

export function matchFieldFor(eventName, payload) {
  if (NO_MATCHER_EVENTS.has(eventName)) return null;
  if (eventName === 'SessionStart') return payload.source ?? '';
  if (eventName === 'Setup') return payload.trigger ?? '';
  if (eventName === 'SessionEnd') return payload.reason ?? '';
  if (eventName === 'Notification') return payload.notification_type ?? payload.type ?? '';
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') return payload.agent_type ?? '';
  if (eventName === 'PreCompact' || eventName === 'PostCompact') return payload.trigger ?? '';
  if (eventName === 'ConfigChange') return payload.source ?? '';
  if (eventName === 'InstructionsLoaded') return payload.load_reason ?? '';
  if (eventName === 'UserPromptExpansion') return payload.command_name ?? '';
  if (eventName === 'StopFailure') return payload.error_type ?? '';
  return payload.tool_name ?? '';
}
