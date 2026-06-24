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
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function pluginDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(claudeConfigDir(), 'plugins', 'data', 'mixdog-trib-plugin');
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
  const derived = raw > 0 ? Math.floor(raw * 9 / 10) : 0;
  if (explicit > 0 && derived > 0) return Math.min(explicit, derived);
  if (explicit > 0) return explicit;
  if (derived > 0 && context > 0) return Math.min(derived, context);
  if (derived > 0) return derived;
  return context > 0 ? context : null;
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch {}
}

export async function renderStatusLine(ccJsonInput) {
  // ── ANSI palette (identical to bash original) ────────────────────────────────
  const R   = '\x1b[0m';
  const B   = '\x1b[1m';
  const D   = '\x1b[2m';
  const RED = '\x1b[31m';
  const GRN = '\x1b[32m';
  const YLW = '\x1b[33m';
  const CYN = '\x1b[36m';
  const GREY = '\x1b[90m';

  // ── Terminal width ──────────────────────────────────────────────────────────
  let COLS = parseInt(process.env.COLUMNS || '120', 10);
  if (!Number.isFinite(COLS) || COLS <= 0) COLS = 120;

  // ── CC stdin JSON (from caller) ─────────────────────────────────────────────
  const CC_JSON = typeof ccJsonInput === 'string' ? ccJsonInput : '';
  writeStatuslineLastSnapshot(CC_JSON);
  let CURRENT_ROUTE = null;
  try {
    CURRENT_ROUTE = writeClaudeCodeCurrentSnapshot(CC_JSON);
    syncBaseUrlForCurrentModel(CURRENT_ROUTE);
    syncCompactWindowForCurrentModel(CURRENT_ROUTE);
  } catch {}

  if (process.env.MIXDOG_STATUSLINE_TRACE && CC_JSON && process.env.CLAUDE_PLUGIN_DATA) {
    try {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_PLUGIN_DATA, 'statusline-stdin.json'),
        CC_JSON
      );
    } catch {}
  }

  if (process.env.MIXDOG_STATUSLINE_TRACE) {
    try {
      const traceFile = path.join(
        pluginDataDir(), 'statusline-trace.log'
      );
      const st = fs.statSync(traceFile);
      if (st.size > 5 * 1024 * 1024) fs.writeFileSync(traceFile, '');
    } catch {}
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function extract(json, re) {
    const m = re.exec(json);
    return m ? m[1] : '';
  }

  function activeContextTokens(json) {
    try {
      const parsed = JSON.parse(json);
      const cw = parsed?.context_window || parsed?.contextWindow || {};
      const input = Number(cw.total_input_tokens ?? cw.totalInputTokens);
      const output = Number(cw.total_output_tokens ?? cw.totalOutputTokens);
      if (Number.isFinite(input) || Number.isFinite(output)) {
        return Math.max(0, Number.isFinite(input) ? input : 0) + Math.max(0, Number.isFinite(output) ? output : 0);
      }
      const currentInput = Number(cw.current_usage?.input_tokens ?? cw.currentUsage?.inputTokens);
      const currentOutput = Number(cw.current_usage?.output_tokens ?? cw.currentUsage?.outputTokens);
      if (Number.isFinite(currentInput) || Number.isFinite(currentOutput)) {
        return Math.max(0, Number.isFinite(currentInput) ? currentInput : 0) + Math.max(0, Number.isFinite(currentOutput) ? currentOutput : 0);
      }
    } catch {}
    return null;
  }

  function slice(json, key, stopKey) {
    const idx = json.indexOf(key);
    if (idx < 0) return null;
    const tail = json.slice(idx + key.length);
    if (stopKey) {
      const stop = tail.indexOf(stopKey);
      return stop >= 0 ? tail.slice(0, stop) : tail;
    }
    return tail;
  }

  // ── Extract CC fields ──────────────────────────────────────────────────────
  let CC_MODEL       = extract(CC_JSON, /"display_name"\s*:\s*"([^"]+)"/);
  let CC_CTX_USED    = '';
  let CC_RL_5H       = '';
  let CC_RL_7D       = '';
  let CC_RL_5H_RESET = '';

  const ctxTail = slice(CC_JSON, '"context_window"', '"rate_limits"');
  if (ctxTail !== null) {
    CC_CTX_USED = extract(ctxTail, /"used_percentage"\s*:\s*([0-9.]+)/);
  }
  const fiveTail = slice(CC_JSON, '"five_hour"', '"seven_day"');
  if (fiveTail !== null) {
    CC_RL_5H       = extract(fiveTail, /"used_percentage"\s*:\s*([0-9.]+)/);
    CC_RL_5H_RESET = extract(fiveTail, /"resets_at"\s*:\s*([0-9]+)/);
  }
  const sevenTail = slice(CC_JSON, '"seven_day"', null);
  if (sevenTail !== null) {
    CC_RL_7D = extract(sevenTail, /"used_percentage"\s*:\s*([0-9.]+)/);
  }

  const CC_SESSION_ID = extract(CC_JSON, /"session_id"\s*:\s*"([^"]+)"/);

  let CC_EFFORT = extract(CC_JSON, /"effort"\s*:\s*\{[^}]*"level"\s*:\s*"([^"]+)"/);
  if (!CC_EFFORT) CC_EFFORT = process.env.CLAUDE_CODE_EFFORT_LEVEL || '';
  if (!CC_EFFORT) {
    try {
      const settingsRaw = fs.readFileSync(
        path.join(claudeConfigDir(), 'settings.json'), 'utf8'
      );
      CC_EFFORT = extract(settingsRaw, /"effortLevel"\s*:\s*"([^"]+)"/);
    } catch {}
  }

  const STATUS_ARGS = (() => {
    try {
      const parsed = JSON.parse(CC_JSON);
      return Array.isArray(parsed?._args) ? parsed._args.map(String) : [];
    } catch { return []; }
  })();
  function statusArg(prefix) {
    return STATUS_ARGS.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || '';
  }
  function positiveInt(value) {
    const n = parseInt(String(value || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const CLIENT_HOST_PID_ARG = positiveInt(statusArg('--client-host-pid='));
  const CLIENT_HOST_PID = CLIENT_HOST_PID_ARG || positiveInt(process.ppid);
  // Bash-jobs scope pid: ONLY the explicitly passed --client-host-pid (the
  // shim-provided claude.exe pid). No process.ppid fallback here — under a
  // no-shim invocation ppid is the renderer's parent (the daemon/launcher),
  // NOT claude.exe, so falling back would count jobs that merely match that
  // unrelated pid. Absent ⇒ 0 ⇒ the segment attributes nothing.
  const CLIENT_HOST_PID_JOBS = positiveInt(statusArg('--client-host-pid='));

  const GATEWAY_STATUS = shouldLoadGatewayStatus(CURRENT_ROUTE, CC_SESSION_ID, CLIENT_HOST_PID_ARG)
    ? loadGatewayStatus({
      sessionId: CC_SESSION_ID,
      clientHostPid: CLIENT_HOST_PID_ARG,
      activeContextTokens: activeContextTokens(CC_JSON),
      currentRoute: CURRENT_ROUTE,
    })
    : null;
  if (GATEWAY_STATUS) {
    syncBaseUrlForGatewayStatus(GATEWAY_STATUS);
    syncCompactWindowForGatewayStatus(GATEWAY_STATUS);
    CC_MODEL = GATEWAY_STATUS.modelDisplay || CC_MODEL;
    if (GATEWAY_STATUS.contextUsedPct !== null && GATEWAY_STATUS.contextUsedPct !== undefined) {
      CC_CTX_USED = String(GATEWAY_STATUS.contextUsedPct);
    }
    CC_EFFORT = GATEWAY_STATUS.effort || '';
    if (GATEWAY_STATUS.fast) CC_EFFORT = CC_EFFORT ? `${CC_EFFORT} · FAST` : 'FAST';
  }

  function advertPidAlive(content) {
    const pid = positiveInt(extract(content, /"pid"\s*:\s*([0-9]+)/));
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  function advertCcMatches(content) {
    return !!(CC_SESSION_ID && content.includes('"cc_session_id"') && content.includes(`"${CC_SESSION_ID}"`));
  }
  function advertClaimed(content) {
    return content.includes('"cc_session_id"');
  }
  function advertClientHostPid(content) {
    return positiveInt(extract(content, /"clientHostPid"\s*:\s*([0-9]+)/))
      || positiveInt(extract(content, /"client_host_pid"\s*:\s*([0-9]+)/));
  }
  function advertHostMatches(content, { allowUnclaimed = false } = {}) {
    if (!CLIENT_HOST_PID) return true;
    const clientHostPid = advertClientHostPid(content);
    if (clientHostPid) return clientHostPid === CLIENT_HOST_PID;
    if (allowUnclaimed && !advertClaimed(content)) return true;
    const ownerHostPid = positiveInt(extract(content, /"ownerHostPid"\s*:\s*([0-9]+)/));
    return ownerHostPid === CLIENT_HOST_PID;
  }

  // ── Advert routing ─────────────────────────────────────────────────────────
  let statusAdvert = '';
  let needClaim    = false;
  const advertDir  = path.join(claudeConfigDir(), 'mixdog-status');
  const mappingPath = CC_SESSION_ID
    ? path.join(advertDir, `.cc-${CC_SESSION_ID}${CLIENT_HOST_PID ? `-host-${CLIENT_HOST_PID}` : ''}.path`)
    : '';

  if (mappingPath) {
    try {
      const cached = fs.readFileSync(mappingPath, 'utf8').trim();
      if (cached) {
        const cachedAdvert = path.isAbsolute(cached) ? cached : path.join(advertDir, cached);
        const advertContent = fs.readFileSync(cachedAdvert, 'utf8');
        if (advertPidAlive(advertContent) && advertCcMatches(advertContent) && advertHostMatches(advertContent)) {
          statusAdvert = cachedAdvert;
          needClaim = false;
        } else {
          try { fs.unlinkSync(mappingPath); } catch {}
        }
      } else {
        try { fs.unlinkSync(mappingPath); } catch {}
      }
    } catch {
      try { fs.unlinkSync(mappingPath); } catch {}
    }
  }

  if (!statusAdvert) {
    try {
      const files = fs.readdirSync(advertDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(advertDir, f));
      for (const f of files) {
        let content;
        try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (!advertPidAlive(content)) continue;
        if (advertCcMatches(content)) {
          if (!advertHostMatches(content)) continue;
          statusAdvert = f;
          needClaim    = false;
          break;
        }
        if (!statusAdvert && CC_SESSION_ID && !advertClaimed(content) && advertHostMatches(content, { allowUnclaimed: true })) {
          statusAdvert = f;
          needClaim    = true;
        }
      }
      if (!statusAdvert && !CC_SESSION_ID) {
        for (const f of files) {
          try { fs.readFileSync(f, 'utf8'); statusAdvert = f; break; } catch {}
        }
      }
    } catch {}
    if (statusAdvert && mappingPath && !needClaim) {
      try { fs.writeFileSync(mappingPath, statusAdvert); } catch {}
    }
  }
  if (!statusAdvert && !CC_SESSION_ID) {
    statusAdvert = path.join(claudeConfigDir(), 'mixdog-status.json');
  }

  // ── Read port from advert ──────────────────────────────────────────────────
  let statusPort = '';
  try {
    const advertContent = fs.readFileSync(statusAdvert, 'utf8');
    statusPort = extract(advertContent, /"port"\s*:\s*([0-9]+)/);
  } catch {}

  if (needClaim && CC_SESSION_ID && statusPort) {
    const claimPayload = { cc_session_id: CC_SESSION_ID };
    if (CLIENT_HOST_PID) claimPayload.client_host_pid = CLIENT_HOST_PID;
    const body = JSON.stringify(claimPayload);
    try {
      const req = http.request({
        hostname: '127.0.0.1',
        port: parseInt(statusPort, 10),
        path: '/register-cc-session',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); });
      req.on('error', () => {});
      req.setTimeout(800, () => { try { req.destroy(); } catch {} });
      req.write(body);
      req.end();
    } catch {}
  }

  // ── Fetch /bridge/status ───────────────────────────────────────────────────
  let bridgeJson = '';
  if (statusPort) {
    bridgeJson = await new Promise(resolve => {
      try {
        const statusUrl = `http://127.0.0.1:${statusPort}/bridge/status?format=statusline-json`
          + (CLIENT_HOST_PID ? `&clientHostPid=${CLIENT_HOST_PID}` : '');
        const req = http.get(
          statusUrl,
          { timeout: 500 },
          res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
      } catch { resolve(''); }
    });
  }
  if (!bridgeJson.startsWith('{')) bridgeJson = '';

  if (!bridgeJson && process.env.MIXDOG_STATUSLINE_TRACE) {
    try {
      const traceDir = pluginDataDir();
      if (fs.existsSync(traceDir)) {
        const advertPresent = (() => { try { fs.accessSync(statusAdvert); return 'present'; } catch { return 'missing'; } })();
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        fs.appendFileSync(
          path.join(traceDir, 'statusline-trace.log'),
          `${ts} NOBRIDGE port=${statusPort || '?'} advert=${advertPresent}\n`
        );
      }
    } catch {}
  }

  // ── Extract bridge fields ──────────────────────────────────────────────────
  let bSessRoles    = '';
  let bSchedNextAt  = '';
  let bSchedNextName = '';
  // Worker list carrying running/idle status alongside each tag, surfaced by
  // the aggregator's sessions.workers segment. Falls back to roles (running-
  // only) when an older aggregator payload lacks the workers array.
  let bWorkers      = [];

  if (bridgeJson) {
    const sessRaw = extract(bridgeJson, /"sessions"\s*:\s*\{[^}]*"roles"\s*:\s*\[([^\]]*)\]/);
    if (sessRaw) bSessRoles = sessRaw.replace(/"/g, '').replace(/\s/g, '');
    const workersRaw = extract(bridgeJson, /"workers"\s*:\s*\[([^\]]*)\]/);
    if (workersRaw) {
      // Parse [{"tag":"x","status":"running"},...] without a full JSON.parse
      // of the whole payload (matches the existing regex-extract approach).
      const re = /\{[^}]*?"tag"\s*:\s*"([^"]*)"[^}]*?"status"\s*:\s*"([^"]*)"[^}]*?\}/g;
      let m;
      while ((m = re.exec(workersRaw)) !== null) {
        bWorkers.push({ tag: m[1], status: m[2] === 'idle' ? 'idle' : 'running' });
      }
    }
    bSchedNextAt   = extract(bridgeJson, /"next"\s*:\s*\{[^}]*"fireAt"\s*:\s*([0-9]+)/);
    bSchedNextName = extract(bridgeJson, /"next"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]*)"/);
  }

  // ── Format helpers ─────────────────────────────────────────────────────────
  let modelStr = '';
  if (CC_MODEL) {
    let raw = CC_MODEL.replace('(1M context)', '(1M)');
    if (raw.includes('Opus'))   modelStr = 'Opus'   + raw.slice(raw.indexOf('Opus')   + 4);
    else if (raw.includes('Sonnet')) modelStr = 'Sonnet' + raw.slice(raw.indexOf('Sonnet') + 6);
    else if (raw.includes('Haiku'))  modelStr = 'Haiku'  + raw.slice(raw.indexOf('Haiku')  + 5);
    else modelStr = raw;
  }
  const modelShort = modelStr.split(' ')[0];
  const effortStr  = CC_EFFORT ? CC_EFFORT.toUpperCase() : '';

  function roundPct(s) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }

  function contextPct(s) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }

  function formatContextPct(pct) {
    if (pct === null) return '';
    if (pct > 0 && pct < 1) return String(Math.round(pct * 10) / 10);
    return String(Math.floor(pct));
  }

  const ctxPct    = contextPct(CC_CTX_USED);
  const rl5hInt   = roundPct(CC_RL_5H);
  const rl7dInt   = roundPct(CC_RL_7D);

  function epochMsToHHMM(ms) {
    const d = new Date(parseInt(ms, 10));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  const resetStr = CC_RL_5H_RESET ? epochMsToHHMM(CC_RL_5H_RESET * 1000) : '';
  const schedNextHHMM = bSchedNextAt ? epochMsToHHMM(parseInt(bSchedNextAt, 10)) : '';

  function colourPct(p) {
    if (p >= 90) return `${RED}${p}%${R}`;
    if (p >= 70) return `${YLW}${p}%${R}`;
    return `${GRN}${p}%${R}`;
  }

  const gatewayLimitSegments = formatGatewayLimitSegments(GATEWAY_STATUS, {
    COLS, D, R, RED, GRN, YLW, colourPct, epochMsToHHMM,
  });

  function makeBar(pct, cells) {
    if (pct === null || cells <= 0) return '';
    let filled = Math.floor(pct * cells / 100);
    if (filled < 0) filled = 0;
    if (filled > cells) filled = cells;
    if (pct > 0 && filled === 0) filled = 1;
    return '▓'.repeat(filled) + '░'.repeat(cells - filled);
  }

  // ── Build L1 ───────────────────────────────────────────────────────────────
  const SEP = `${D}│${R}`;
  const l1Parts = [];
  function addL1(seg) { if (seg) l1Parts.push(seg); }

  if (modelStr) {
    const m = COLS >= 120 ? modelStr : modelShort;
    if (effortStr) {
      addL1(`${CYN}◆${R} ${B}${m}${R} ${D}·${R} ${B}${effortStr}${R}`);
    } else {
      addL1(`${CYN}◆${R} ${B}${m}${R}`);
    }
  }

  if (ctxPct !== null) {
    const fill = ctxPct >= 90 ? RED : ctxPct >= 70 ? YLW : GRN;
    const ctxLabel = formatContextPct(ctxPct);
    let barOut = '';
    if      (COLS >= 120) barOut = makeBar(ctxPct, 14);
    else if (COLS >= 80)  barOut = makeBar(ctxPct, 8);
    if (barOut) {
      const filledPart = barOut.replace(/░/g, '');
      const emptyPart  = barOut.replace(/▓/g, '');
      const bar        = `${fill}${filledPart}${R}${D}${emptyPart}${R}`;
      addL1(`${bar} ${ctxLabel}%`);
    } else {
      addL1(`${fill}${ctxLabel}%${R}`);
    }
  }

  if (gatewayLimitSegments.length) {
    for (const seg of gatewayLimitSegments) addL1(seg);
  } else {
    if (rl5hInt !== null) {
      addL1(`${D}5H${R} ${colourPct(rl5hInt)}`);
    }
    if (COLS >= 80) {
      if (rl7dInt !== null) addL1(`${D}7D${R} ${colourPct(rl7dInt)}`);
      if (resetStr) addL1(`${D}↻ ${resetStr}${R}`);
    }
  }

  // ── Role classification ────────────────────────────────────────────────────
  let workCount    = 0;
  let workOrder    = '';
  let hasCycle1    = false;
  let hasCycle2    = false;
  let hasCycle3    = false;
  let hasSched     = false;
  let hasWebhook   = false;
  let hasExplorer  = false;

  function classifyMaint(role) {
    switch (role) {
      case 'cycle1-agent':    hasCycle1   = true; return true;
      case 'cycle2-agent':    hasCycle2   = true; return true;
      case 'cycle3-agent':    hasCycle3   = true; return true;
      case 'scheduler-task':  hasSched    = true; return true;
      case 'webhook-handler': hasWebhook  = true; return true;
      case 'explorer':        hasExplorer = true; return true;
      default: return false;
    }
  }

  // Idle worker tags (greyed in L2), threaded from the aggregator's
  // sessions.workers[].status. Running user-workers still feed workCount /
  // workOrder so the existing "N Running (tags)" badge is unchanged.
  const idleWorkers = [];
  if (bWorkers.length) {
    // Preferred path: per-worker running/idle status from the aggregator.
    for (const w of bWorkers) {
      if (classifyMaint(w.tag)) continue; // maintenance → L1, not the worker badge
      if (w.status === 'idle') {
        idleWorkers.push(w.tag);
      } else {
        workCount++;
        workOrder = workOrder ? `${workOrder}, ${w.tag}` : w.tag;
      }
    }
  } else if (bSessRoles) {
    // Fallback: legacy roles array (running-only, no idle/status info).
    for (const role of bSessRoles.split(',')) {
      if (!role) continue;
      if (classifyMaint(role)) continue;
      workCount++;
      workOrder = workOrder ? `${workOrder}, ${role}` : role;
    }
  }

  const maintParts = [];
  if (hasCycle1)    maintParts.push(`${GRN}↻${R} ${B}cycle1${R}`);
  if (hasCycle2)    maintParts.push(`${GRN}↻${R} ${B}cycle2${R}`);
  if (hasCycle3)    maintParts.push(`${GRN}↻${R} ${B}cycle3${R}`);
  if (hasSched)     maintParts.push(`${GRN}↻${R} ${B}scheduler${R}`);
  if (hasWebhook)   maintParts.push(`${GRN}↻${R} ${B}webhook${R}`);
  if (hasExplorer)  maintParts.push(`${GRN}↻${R} ${B}explorer${R}`);
  if (maintParts.length) addL1(maintParts.join(' '));

  // Background bash jobs: a running job is a `<jobId>.json` whose sibling
  // `<jobId>.done` (written on exit) is absent. Surviving candidates are then
  // liveness-filtered — the `.json` carries the wrapper `pid`; an orphaned job
  // (wrapper crashed, `.done` never written, pid dead for days) is skipped via
  // process.kill(pid, 0). Bounded per tick: candidates are ordered newest-first
  // (the jobId embeds its spawn Date.now()) and at most JOB_SCAN_CAP of them are
  // read — keeping each render O(cap), not O(total on-disk jobs). When the scan
  // is truncated a trailing `+` overflow marker is appended to the count. One
  // readFileSync/statSync per scanned job for the oldest startedAt (the .json is
  // written at job start); tolerate the dir being missing and never throw.
  const JOB_SCAN_CAP = 30;
  const bashJobsSeg = (() => {
    try {
      const dir = path.join(pluginDataDir(), 'shell-jobs');
      const names = fs.readdirSync(dir);
      const done = new Set();
      const jobs = [];
      const ownerByJob = new Map();
      for (const n of names) {
        if (n.endsWith('.done')) done.add(n.slice(0, -5));
        else if (n.endsWith('.json')) jobs.push(n.slice(0, -5));
        else {
          // Owner sidecar `<jobId>.owner-<pid>` — a zero-byte marker whose NAME
          // carries the owning CC host pid, written next to the .json at spawn.
          const i = n.lastIndexOf('.owner-');
          if (i > 0) { const pid = positiveInt(n.slice(i + 7)); if (pid) ownerByJob.set(n.slice(0, i), pid); }
        }
      }
      // Owner-filter BEFORE the scan cap, from the directory listing alone: each
      // job's owning claude.exe pid is read from its `.owner-<pid>` marker name
      // (no JSON read), so another session's newer jobs can never evict ours at
      // the cap. Only jobs whose marker pid equals THIS statusline's
      // --client-host-pid survive; legacy jobs without a marker — and every job
      // when no host pid was passed (CLIENT_HOST_PID_JOBS absent) — are excluded.
      // Then ordered newest-first by the spawn timestamp embedded in
      // `job_<ms>_<rand>`, so truncation drops only this session's oldest tail.
      const jobStampMs = (id) => { const m = /^job_(\d+)/.exec(id); return m ? Number(m[1]) : 0; };
      const candidates = jobs
        .filter((id) => !done.has(id) && CLIENT_HOST_PID_JOBS && ownerByJob.get(id) === CLIENT_HOST_PID_JOBS)
        .sort((a, b) => jobStampMs(b) - jobStampMs(a));
      if (candidates.length === 0) return '';
      const scan = candidates.slice(0, JOB_SCAN_CAP);
      const truncated = candidates.length > JOB_SCAN_CAP;
      let count = 0;
      let oldestMs = Infinity;
      for (const id of scan) {
        const p = path.join(dir, `${id}.json`);
        let pid, tmo, enforced;
        try {
          const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
          pid = d.pid; tmo = Number(d.timeoutMs);
          // Runtime enforcement proof: PS records timeoutEnforced:true; the
          // posix wrapper touches <id>.enforced iff its `timeout` branch ran.
          enforced = d.timeoutEnforced === true || fs.existsSync(path.join(dir, `${id}.enforced`));
        }
        catch { continue; } // unreadable/unparseable → skip
        let st;
        try { st = fs.statSync(p); }
        catch { continue; }
        // Deadline: the wrapper force-kills at timeoutMs, so a job older than
        // timeoutMs + grace is dead even when its pid was recycled by an
        // unrelated live process (pid-reuse-proof, mirrors the sweep). Trusted
        // only when the record proves in-wrapper enforcement (timeoutEnforced).
        if (enforced && Number.isFinite(tmo) && tmo > 0 && (Date.now() - st.mtimeMs) > tmo + 30 * 60_000) continue;
        // kill(0, 0) probes the whole process group and "succeeds" — a
        // malformed pid (0, "", []) must be rejected before the probe.
        pid = Number(pid);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        // Liveness: process.kill(pid, 0) succeeds or throws EPERM → alive;
        // ESRCH/invalid pid → dead → skip.
        let alive = false;
        try { process.kill(pid, 0); alive = true; }
        catch (e) { alive = e && e.code === 'EPERM'; }
        if (!alive) continue;
        count++;
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      }
      if (count === 0) return '';
      let elapsed = '';
      if (Number.isFinite(oldestMs)) {
        const secs = Math.max(0, Math.floor((Date.now() - oldestMs) / 1000));
        elapsed = secs < 60 ? ` ${secs}s` : ` ${Math.floor(secs / 60)}m`;
      }
      // `+` overflow marker: more live/recent candidates existed than the
      // per-tick scan cap, so the rendered count is a floor, not the ground.
      const overflow = truncated ? '+' : '';
      return `${GREY}⚙  bash:${count}${overflow}${elapsed}${R}`;
    } catch { return ''; }
  })();
  if (bashJobsSeg) addL1(bashJobsSeg);

  // ── Build L2 ───────────────────────────────────────────────────────────────
  const l2Parts = [];
  function addL2(seg) { if (seg) l2Parts.push(seg); }

  if (workCount > 0 && workOrder) {
    addL2(`${GRN}●${R} ${B}${workCount} Running${R} ${D}(${R}${CYN}${workOrder}${R}${D})${R}`);
  }

  if (idleWorkers.length) {
    // Idle workers: filled grey dot (●) + explicit 'idle' marker + tag list.
    // Filled (not hollow ○) so the glyph matches the running ● weight; only
    // the colour (grey vs green) distinguishes idle from running.
    const idleTags = idleWorkers.join(', ');
    addL2(`${GREY}● ${idleWorkers.length} idle (${idleTags})${R}`);
  }
  if (bSchedNextName && schedNextHHMM) {
    addL2(`${YLW}⏰${R} ${B}${bSchedNextName}${R} ${D}${schedNextHHMM}${R}`);
  }

  const l1 = l1Parts.join(` ${SEP} `) || 'mixdog';
  let l2   = l2Parts.join(` ${SEP} `);
  if (l2 === 'Idle') l2 = '';

  let out = l1 + '\n';
  if (l2) out += l2 + '\n';
  return out;
}
