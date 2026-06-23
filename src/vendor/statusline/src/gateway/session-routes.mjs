import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolvePluginData } from '../../../../runtime/shared/plugin-paths.mjs';
import { updateJsonAtomicSync } from '../../../../runtime/shared/atomic-file.mjs';
import { CLAUDE_CURRENT_MODE } from './claude-current.mjs';

const STORE_FILE = 'gateway-session-routes.json';
const UUIDISH_SESSION_RE = /^[0-9a-z][0-9a-z._-]{7,}$/i;

function cleanString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

function cleanBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'fast', 'priority'].includes(s)) return true;
    if (['0', 'false', 'no', 'off', 'none'].includes(s)) return false;
  }
  return null;
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

export function normalizeGatewaySessionId(value) {
  const s = cleanString(value);
  if (!s || !UUIDISH_SESSION_RE.test(s)) return null;
  return s;
}

export function normalizeClientHostPid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function hostRouteKey(sessionId, clientHostPid) {
  const sid = normalizeGatewaySessionId(sessionId);
  const pid = normalizeClientHostPid(clientHostPid);
  return sid && pid ? `${sid}#${pid}` : null;
}

export function gatewaySessionRoutesPath() {
  return join(resolvePluginData(), STORE_FILE);
}

function readStore() {
  try {
    const file = gatewaySessionRoutesPath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeGatewayRouteSection(route = {}) {
  const mode = cleanString(route.mode) || CLAUDE_CURRENT_MODE;
  const provider = cleanString(route.defaultProvider ?? route.provider);
  const model = cleanString(route.defaultModel ?? route.model);
  if (!provider || !model) return null;
  const out = {
    mode,
    defaultProvider: provider,
    defaultModel: model,
  };
  for (const key of ['presetId', 'presetName', 'effort', 'displayEffort', 'modelDisplay']) {
    const value = cleanString(route[key]);
    if (value) out[key] = value;
  }
  if (hasOwn(route, 'fast')) {
    const fast = cleanBool(route.fast);
    if (fast !== null) out.fast = fast;
  }
  if (hasOwn(route, 'thinkingBudgetTokens')) {
    const n = Number(route.thinkingBudgetTokens);
    if (Number.isFinite(n) && n > 0) out.thinkingBudgetTokens = Math.floor(n);
  }
  return out;
}

function routeWithMeta(route, sessionId, clientHostPid = null) {
  const normalized = normalizeGatewayRouteSection(route || {});
  if (!normalized) return null;
  const pid = normalizeClientHostPid(clientHostPid ?? route?.clientHostPid);
  return {
    ...normalized,
    sessionId,
    ...(pid ? { clientHostPid: pid } : {}),
    updatedAt: route?.updatedAt || null,
  };
}

export function readGatewaySessionRoute(sessionId, options = {}) {
  const sid = normalizeGatewaySessionId(sessionId);
  if (!sid) return null;
  const store = readStore();
  const pid = normalizeClientHostPid(options?.clientHostPid);
  const hosts = store?.sessionHosts && typeof store.sessionHosts === 'object' ? store.sessionHosts : {};
  if (pid) {
    const hostRoute = hosts[hostRouteKey(sid, pid)];
    const scoped = routeWithMeta(hostRoute, sid, pid);
    if (scoped) return scoped;
    if (options?.fallbackLegacy === true) {
      const legacy = store?.sessions && typeof store.sessions === 'object' ? store.sessions[sid] : null;
      return routeWithMeta(legacy, sid);
    }
    return null;
  }
  const route = store?.sessions && typeof store.sessions === 'object' ? store.sessions[sid] : null;
  return routeWithMeta(route, sid);
}

export function readLatestGatewayHostRoute(clientHostPid, options = {}) {
  const pid = normalizeClientHostPid(clientHostPid);
  if (!pid) return null;
  const excludeSid = normalizeGatewaySessionId(options?.excludeSessionId);
  const store = readStore();
  const hosts = store?.sessionHosts && typeof store.sessionHosts === 'object' ? store.sessionHosts : {};
  let best = null;
  let bestAt = -1;
  for (const route of Object.values(hosts)) {
    if (!route || typeof route !== 'object') continue;
    if (normalizeClientHostPid(route.clientHostPid) !== pid) continue;
    const sid = normalizeGatewaySessionId(route.sessionId);
    if (!sid || (excludeSid && sid === excludeSid)) continue;
    const normalized = routeWithMeta(route, sid, pid);
    if (!normalized) continue;
    const at = Number(route.updatedAt) || 0;
    if (at >= bestAt) {
      best = normalized;
      bestAt = at;
    }
  }
  return best;
}

export function writeGatewaySessionRoute(sessionId, route, options = {}) {
  const sid = normalizeGatewaySessionId(sessionId);
  const normalized = normalizeGatewayRouteSection(route || {});
  if (!sid || !normalized) return false;
  const pid = normalizeClientHostPid(options?.clientHostPid ?? route?.clientHostPid);
  try {
    updateJsonAtomicSync(gatewaySessionRoutesPath(), (curRaw) => {
      const cur = curRaw && typeof curRaw === 'object' ? curRaw : {};
      const sessions = cur.sessions && typeof cur.sessions === 'object' ? { ...cur.sessions } : {};
      const sessionHosts = cur.sessionHosts && typeof cur.sessionHosts === 'object' ? { ...cur.sessionHosts } : {};
      if (pid) {
        sessionHosts[hostRouteKey(sid, pid)] = { ...normalized, sessionId: sid, clientHostPid: pid, updatedAt: Date.now() };
      } else {
        sessions[sid] = { ...normalized, sessionId: sid, updatedAt: Date.now() };
      }
      return { version: 2, updatedAt: Date.now(), sessions, sessionHosts };
    }, { compact: true, fsyncDir: true });
    return true;
  } catch {
    return false;
  }
}

export function clearGatewaySessionRoute(sessionId, options = {}) {
  const sid = normalizeGatewaySessionId(sessionId);
  if (!sid) return false;
  const pid = normalizeClientHostPid(options?.clientHostPid);
  try {
    updateJsonAtomicSync(gatewaySessionRoutesPath(), (curRaw) => {
      const cur = curRaw && typeof curRaw === 'object' ? curRaw : {};
      const sessions = cur.sessions && typeof cur.sessions === 'object' ? { ...cur.sessions } : {};
      const sessionHosts = cur.sessionHosts && typeof cur.sessionHosts === 'object' ? { ...cur.sessionHosts } : {};
      if (pid) {
        const key = hostRouteKey(sid, pid);
        if (!key || !hasOwn(sessionHosts, key)) return cur;
        delete sessionHosts[key];
      } else {
        if (!hasOwn(sessions, sid)) return cur;
        delete sessions[sid];
      }
      return { version: 2, updatedAt: Date.now(), sessions, sessionHosts };
    }, { compact: true, fsyncDir: true });
    return true;
  } catch {
    return false;
  }
}

export function priorGatewaySessionIdForClear(active, newSessionId) {
  const sid = normalizeGatewaySessionId(newSessionId);
  if (!sid || !active || typeof active !== 'object') return null;
  const transcriptPath = cleanString(active.transcriptPath);
  const currentBase = transcriptPath ? cleanString(transcriptPath.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, '')) : null;
  if (currentBase !== sid) return null;
  const priorTranscriptPath = cleanString(active.priorTranscriptPath);
  const priorBase = priorTranscriptPath ? cleanString(priorTranscriptPath.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, '')) : null;
  const priorSid = normalizeGatewaySessionId(priorBase);
  return priorSid && priorSid !== sid ? priorSid : null;
}

export function gatewayConfigForSession(globalGateway = {}, sessionId = null, options = {}) {
  const sessionRoute = readGatewaySessionRoute(sessionId, options);
  return sessionRoute ? { ...(globalGateway || {}), ...sessionRoute } : (globalGateway || {});
}

export function gatewayConfigForSessionBoot(globalGateway = {}, sessionId = null, inheritFromSessionId = null, options = {}) {
  const sid = normalizeGatewaySessionId(sessionId);
  if (!sid) return globalGateway || {};
  const pid = normalizeClientHostPid(options?.clientHostPid);
  const routeOptions = pid ? { clientHostPid: pid } : {};
  // 1. Session already has a stored route — use it (idempotent).
  const sessionRoute = readGatewaySessionRoute(sid, routeOptions);
  if (sessionRoute) return { ...(globalGateway || {}), ...sessionRoute };
  // 2. No route yet — try to inherit from a prior session (e.g. after /clear)
  //    before falling back to the global default. This preserves a manually
  //    pinned route across session boundaries.
  if (inheritFromSessionId) {
    const priorSid = normalizeGatewaySessionId(inheritFromSessionId);
    if (priorSid && priorSid !== sid) {
      const priorRoute = readGatewaySessionRoute(priorSid, routeOptions);
      if (priorRoute) {
        writeGatewaySessionRoute(sid, priorRoute, routeOptions);
        return { ...(globalGateway || {}), ...priorRoute };
      }
    }
  }
  // 3. If Claude Code did not provide a reliable prior transcript on /new,
  // carry the last explicit route for this terminal only. This keeps multiple
  // terminals isolated without falling back to the process-global default.
  if (pid) {
    const hostRoute = readLatestGatewayHostRoute(pid, { excludeSessionId: sid });
    if (hostRoute) {
      writeGatewaySessionRoute(sid, hostRoute, routeOptions);
      return { ...(globalGateway || {}), ...hostRoute };
    }
  }
  // 4. No prior route to inherit — pin the current global config.
  const normalized = normalizeGatewayRouteSection(globalGateway || {});
  if (!normalized) return globalGateway || {};
  writeGatewaySessionRoute(sid, normalized, routeOptions);
  return { ...(globalGateway || {}), ...normalized };
}
