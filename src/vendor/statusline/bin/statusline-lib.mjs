// mixdog statusline renderer — function form for in-daemon reuse.
//
// Mirrors `bin/statusline.mjs` exactly, but takes the CC stdin JSON as an
// argument and returns the rendered status text instead of reading fd 0 and
// writing to process.stdout. This allows the hook-pipe daemon to compute the
// statusline without paying the ~100ms bun cold-start on every refresh tick.

import fs from 'fs';
import os from 'os';
import http from 'node:http';
import path from 'path';
import { formatGatewayLimitSegments, loadGatewayStatus } from './statusline-route.mjs';
import {
  isClaudeNativeModelSelection,
  isMixdogModelSelection,
  writeClaudeCodeCurrentSnapshot,
} from '../src/gateway/claude-current.mjs';
import {
  ANTHROPIC_OFFICIAL_BASE_URL,
  syncAnthropicBaseUrl,
  syncAutoCompactWindow,
} from '../scripts/lib/gateway-settings.mjs';
import {
  readGatewaySessionRoute,
  readLatestGatewayHostRoute,
} from '../src/gateway/session-routes.mjs';

function claudeConfigDir() {
  return process.env.MIXDOG_CONFIG_DIR || path.join(os.homedir(), '.mixdog');
}

function pluginDataDir() {
  return process.env.MIXDOG_DATA_DIR || path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
}

function writeFileIfChangedSync(file, content) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return true;
  } catch {
    return false;
  }
}

function gatewayPort() {
  const envPort = Number(process.env.MIXDOG_GATEWAY_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return Math.floor(envPort);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(pluginDataDir(), 'mixdog-config.json'), 'utf8'));
    const port = Number(cfg?.gateway?.port);
    if (Number.isFinite(port) && port > 0) return Math.floor(port);
  } catch {}
  return 3468;
}

function readGatewayConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDataDir(), 'mixdog-config.json'), 'utf8'));
  } catch {
    return null;
  }
}

function gatewayOwnsMainBaseUrl() {
  const cfg = readGatewayConfig();
  if (cfg?.modules?.gateway?.enabled !== true) return false;
  return cfg?.gateway?.mode === 'claude-current';
}

function settingsModelIsMixdog() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'settings.json'), 'utf8'));
    return isMixdogModelSelection(settings?.model);
  } catch {
    return false;
  }
}

function routeUsesNonClaudeGateway(route) {
  if (!route || typeof route !== 'object') return false;
  const provider = String(route.defaultProvider || route.provider || '').trim();
  const model = String(route.defaultModel || route.model || '').trim();
  if (!provider || !model) return false;
  return provider !== 'anthropic-oauth' && provider !== 'anthropic';
}

function storedRouteNeedsGatewayStatus(sessionId, clientHostPid) {
  try {
    if (!(Number(clientHostPid) > 0)) return false;
    const route = readGatewaySessionRoute(sessionId, { clientHostPid })
      || readLatestGatewayHostRoute(clientHostPid, { excludeSessionId: sessionId });
    return routeUsesNonClaudeGateway(route);
  } catch {
    return false;
  }
}

function shouldLoadGatewayStatus(currentRoute, sessionId, clientHostPid) {
  if (process.env.MIXDOG_STATUSLINE_STANDALONE === '1') return false;
  if (process.env.MIXDOG_STANDALONE === '1') return true;
  if (!isClaudeNativeModelSelection(currentRoute)) return true;
  // Native model selection, but the gateway still owns the main base URL in
  // claude-current mode: every request flows through 3468, so the gateway's
  // oauth usage cache (5H/7D) is the only quota source — CC's stdin rate_limits
  // arrive empty on a gateway-proxied native route. Read the gateway status so
  // the usage segment renders instead of going blank.
  return gatewayOwnsMainBaseUrl()
    || storedRouteNeedsGatewayStatus(sessionId, clientHostPid)
    || settingsModelIsMixdog();
}

function traceStatusline(message) {
  if (!process.env.MIXDOG_STATUSLINE_TRACE) return;
  try {
    fs.appendFileSync(path.join(pluginDataDir(), 'statusline-trace.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function syncBaseUrlForCurrentModel(route) {
  if (!route) return;
  const target = isMixdogModelSelection(route) || gatewayOwnsMainBaseUrl() || settingsModelIsMixdog()
    ? `http://127.0.0.1:${gatewayPort()}`
    : isClaudeNativeModelSelection(route)
      ? ANTHROPIC_OFFICIAL_BASE_URL
      : '';
  if (!target) return;
  const result = syncAnthropicBaseUrl(target, { requireExisting: true });
  if (!result.ok) traceStatusline(`[base-url-sync] ${result.error || 'failed'}`);
}

function syncBaseUrlForGatewayStatus(status) {
  if (!status?.provider || !status?.model) return;
  const result = syncAnthropicBaseUrl(`http://127.0.0.1:${gatewayPort()}`, { requireExisting: true });
  if (!result.ok) traceStatusline(`[base-url-sync:gateway-status] ${result.error || 'failed'}`);
}

function syncCompactWindowValue(win, label) {
  if (!(Number.isFinite(Number(win)) && Number(win) > 0)) return;
  const result = syncAutoCompactWindow(Math.floor(Number(win)));
  if (!result.ok) traceStatusline(`[compact-window-sync:${label}] ${result.error || 'failed'}`);
}

function compactWindowForRouteLike(route) {
  if (!route || typeof route !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const explicit = num(route.autoCompactTokenLimit ?? route.auto_compact_token_limit);
  const raw = num(route.rawContextWindow ?? route.raw_context_window ?? route.contextWindow ?? route.context_window);
  const context = num(route.contextWindow ?? route.context_window);
  const pct = num(route.effectiveContextWindowPercent ?? route.effective_context_window_percent) || 90;
  const effective = context || (raw > 0 ? Math.max(1, Math.floor(raw * Math.min(100, pct) / 100)) : 0);
  if (explicit > 0 && effective > 0) return Math.min(explicit, effective);
  if (explicit > 0) return explicit;
  return effective > 0 ? effective : null;
}

function syncCompactWindowForCurrentModel(route) {
  if (!isClaudeNativeModelSelection(route)) return;
  try {
    syncCompactWindowValue(compactWindowForRouteLike(route), 'current');
  } catch (e) {
    traceStatusline(`[compact-window-sync:current] ${e?.message || e}`);
  }
}

function syncCompactWindowForGatewayStatus(status) {
  if (!status?.provider || !status?.model) return;
  syncCompactWindowValue(compactWindowForRouteLike(status), 'gateway-status');
}

function writeStatuslineLastSnapshot(json) {
  if (!json) return;
  try { JSON.parse(json); } catch { return; }
  try {
    const file = path.join(claudeConfigDir(), 'cc-statusline-last.json');
    const tmp = `${file}.${process.pid}.tmp`;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === json) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch {}
}
