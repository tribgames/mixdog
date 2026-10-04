/**
 * doctor.mjs — /doctor health checks shared by the TUI and the desktop.
 *
 * Read-only diagnostics against current runtime status contracts. Missing
 * status is WARN, not a healthy default; a failed or stalled check cannot
 * abort the others — every check runs concurrently under one per-check
 * deadline. Report only names, counts and flags, never credentials or raw
 * errors. The update check uses the existing best-effort npm checker.
 * Configuration status does not prove service/database health.
 *
 * runDoctorChecks returns structured rows ({ id, label, level, detail, fix })
 * for the desktop dialog; formatDoctorReport renders the same rows as the
 * TUI text report.
 */
import { compareSemver } from '../../runtime/shared/update-checker.mjs';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';
import { hasEnabledAutomation } from '../../runtime/shared/automation-presence.mjs';
import { builtinFeatureActive } from '../../runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
import { providerRowUsable } from './provider-usable.mjs';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLYPH = { ok: '✓', warn: '⚠', fail: '✗' };
export const DOCTOR_CHECK_TIMEOUT_MS = 8000;
// Per-process log siblings are pruned by the channel worker; far above its
// cap means pruning is not running.
export const DOCTOR_LOG_FILE_WARN = 300;

// Only the stable ^major.minor.patch and >=major.minor.patch alternatives
// used by our Node engine contract are supported. Fail open to "unverified",
// never "supported", if the package adopts a different range syntax.
export function nodeEngineSupport(version, range) {
  if (typeof range !== 'string') return null;
  const alternatives = range.split('||').map((part) => /^(\^|>=)([1-9]\d*\.\d+\.\d+)$/.exec(part.trim()));
  if (alternatives.some((part) => !part)) return null;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return null;
  if (version.includes('-')) return false;
  return alternatives.some(([, operator, minimum]) => {
    if (compareSemver(version, minimum) < 0) return false;
    return operator === '>=' || version.split('.')[0] === minimum.split('.')[0];
  });
}

function readPackageJson() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(readFileSync(join(dir, '..', '..', '..', 'package.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

const TIMED_OUT = Symbol('timed out');

// One row per check: the status reader's result goes to the reporter, which
// emits its verdict (and an optional fix) through `row`. Any thrown error
// becomes a redacted failure row — errors can contain request URLs, headers
// or credentials. A check that outlives the deadline is reported as such and
// its late verdict is discarded.
async function doctorCheck({ id, label, readStatus, report, timeoutMs }) {
  const result = { id, label, level: 'warn', detail: 'status unavailable' };
  let settled = false;
  const row = (level, detail, fix) => {
    if (settled) return;
    result.level = level;
    result.detail = detail;
    if (fix) result.fix = fix;
  };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const work = (async () => {
    const status = await readStatus();
    if (!status || typeof status !== 'object' || Array.isArray(status)) return;
    await report(status, row);
  })();
  try {
    if ((await Promise.race([work, deadline])) === TIMED_OUT) {
      row('warn', `no response within ${Math.round(timeoutMs / 1000)}s`);
    }
  } catch {
    row('fail', 'check failed (error details omitted)');
  } finally {
    settled = true;
    clearTimeout(timer);
  }
  return result;
}

function reportUpdate(pkg) {
  return (upd, row) => {
    const current = upd.currentVersion || pkg?.version || 'unknown';
    const latest = upd.latestVersion;
    if (!latest) {
      row('warn', `v${current} · update check skipped (registry unreachable)`);
      return;
    }
    if (upd.updateAvailable) row('warn', `v${current} · update available → v${latest}`, { command: '/update' });
    else row('ok', `v${current} · up to date`);
  };
}

function reportNode({ version, engines }, row) {
  const supported = nodeEngineSupport(version, engines);
  if (supported == null) {
    row('warn', `v${version} · engine requirement ${engines ? `"${engines}" unverified` : 'unavailable'}`);
    return;
  }
  if (supported) row('ok', `v${version} · requires node ${engines}`);
  else row('fail', `v${version} · requires node ${engines}`, { hint: `install Node.js ${engines}` });
}

function providerUnusableReason(entry) {
  if (entry.reauthRequired) return 'requires sign-in again';
  if (entry.enabled === false) return 'is disabled';
  if (entry.type === 'local' && !entry.detected) return 'has no installed runtime/model';
  if (!entry.authenticated) return 'has no auth';
  return 'is not usable';
}

function reportProviders(getState) {
  return (setup, row) => {
    const active = getState()?.provider || '';
    if (setup.pendingSecrets === true) {
      row('warn', `credentials still loading · route ${active || 'unknown'} · run /doctor again when ready`);
      return;
    }
    if (![setup.api, setup.oauth, setup.local].every(Array.isArray)) {
      row('warn', 'status unavailable');
      return;
    }
    const lists = [...setup.api, ...setup.oauth, ...setup.local];
    const ready = lists.filter(providerRowUsable);
    const activeEntry = active ? lists.find((p) => p.id === active) : null;
    const fix = { command: '/providers' };
    if (activeEntry && !providerRowUsable(activeEntry)) {
      row('fail', `route ${active} ${providerUnusableReason(activeEntry)} · ${ready.length} ready`, fix);
      return;
    }
    if (active && !activeEntry) {
      row('warn', `${ready.length} ready · route ${active} (not listed)`, fix);
      return;
    }
    if (active) row('ok', `${ready.length} ready · route ${active}`);
    else row('warn', `${ready.length} ready · route unknown`, fix);
  };
}

// The MCP-server and skill/plugin registries share one entry shape: the
// entries active in this project, plus the disabled / out-of-project counts
// both details append before their own per-registry breakage markers.
function scopedRegistryEntries(entries) {
  const active = entries.filter((entry) => entry.enabled !== false && entry.activeHere !== false);
  const disabled = entries.filter((entry) => entry.enabled === false).length;
  const outside = entries.filter((entry) => entry.enabled !== false && entry.activeHere === false).length;
  let scopeDetail = '';
  if (disabled) scopeDetail += ` · ${disabled} disabled`;
  if (outside) scopeDetail += ` · ${outside} outside this project`;
  return { active, scopeDetail };
}

function reportMcp(status, row) {
  if (!Array.isArray(status.servers) || (!status.servers.length && status.configuredCount > 0)) {
    row('warn', 'status unavailable');
    return;
  }
  const servers = status.servers;
  if (!servers.length) {
    row('ok', 'no servers configured');
    return;
  }
  const { active, scopeDetail } = scopedRegistryEntries(servers);
  const connected = active.filter((s) => s.connected === true);
  const failed = active.filter((s) => s.error || s.status === 'failed');
  const pending = active.filter((s) => s.connected !== true && !failed.includes(s));
  let detail = `${connected.length}/${active.length} connected${scopeDetail}`;
  if (failed.length) detail += ` · failed: ${failed.map((s) => s.name).join(', ')}`;
  if (pending.length) detail += ` · disconnected: ${pending.map((s) => s.name).join(', ')}`;
  if (failed.length || pending.length) row('warn', detail, { command: '/mcp' });
  else row('ok', detail);
}

function reportMemory(runtime) {
  return async (memory, row) => {
    if (typeof memory.installed !== 'boolean' || typeof memory.enabled !== 'boolean') {
      row('warn', 'status unavailable');
      return;
    }
    if (!memory.installed || !memory.enabled) {
      row('ok', memory.installed ? 'installed · disabled' : 'not installed');
      return;
    }
    const recap = await runtime.getRecapSettings?.();
    if (typeof recap?.enabled !== 'boolean') {
      row('warn', 'installed · enabled · recap status unavailable');
      return;
    }
    row('ok', `installed · enabled · recap ${recap.enabled ? 'enabled' : 'disabled'}`);
  };
}

function reportChannels(runtime) {
  return async (settings, row) => {
    const worker = settings.status || (await runtime.getChannelWorkerStatus?.());
    if (typeof worker?.running !== 'boolean') {
      row('warn', 'worker status unavailable');
      return;
    }
    if (worker.running) {
      row('ok', 'worker running');
      return;
    }
    // The worker boots only for enabled schedules or webhooks, so without
    // them a stopped worker is idle, not a fault.
    const setup = await runtime.getChannelSetup?.();
    if (setup && !hasEnabledAutomation(setup)) {
      row('ok', 'idle (no active schedules or webhooks)');
      return;
    }
    row('warn', setup ? 'worker stopped with active automation' : 'worker stopped', {
      hint: 'enabled schedules and webhooks are not running',
    });
  };
}

// Skills and plugins share one registry shape: entries with enabled /
// activeHere flags and per-entry breakage markers.
function reportRegistry(label) {
  return (status, row) => {
    const entries = status[label];
    if (!Array.isArray(entries)) {
      row('warn', 'status unavailable');
      return;
    }
    const { active, scopeDetail } = scopedRegistryEntries(entries);
    const broken = active.filter(
      (entry) => entry.broken || entry.error || entry.invalid || entry.dependencyIssues?.length
    );
    const missing = Array.isArray(status.missing)
      ? status.missing.filter((entry) => entry.enabled !== false)
      : [];
    let detail = `${active.length}/${entries.length} active${scopeDetail}`;
    const issues = [...broken, ...(label === 'plugins' ? missing : [])];
    if (!issues.length) {
      row('ok', detail);
      return;
    }
    detail += ` · issues: ${issues.map((entry) => entry.name || entry.id).join(', ')}`;
    row('warn', detail, { command: `/${label}` });
  };
}

function reportLocalProvider(local, row) {
  if (typeof local.installed !== 'boolean') {
    row('warn', 'status unavailable');
    return;
  }
  if (!local.installed) {
    row('ok', 'not installed');
    return;
  }
  if (local.enabled !== true) {
    row('ok', 'installed · disabled');
    return;
  }
  const fix = { command: '/providers' };
  const models = Array.isArray(local.models) ? local.models.filter((model) => model.installed === true).length : 0;
  const jobs = Array.isArray(local.installations) ? local.installations : [];
  const latest = jobs.reduce((a, b) => (a && (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b), null);
  if (latest?.state === 'failed') {
    row('warn', `installed · enabled · ${models} models · latest installation failed`, fix);
  } else if (!models) {
    row('warn', 'installed · enabled · no model installed', fix);
  } else row('ok', `installed · enabled · ${models} models installed`);
}

function reportBuiltins(settings, row) {
  const groups = { enabled: [], disabled: [], 'not installed': [] };
  for (const id of ['git', 'office', 'tidy']) {
    const entry = settings[id];
    if (!entry || typeof entry.installed !== 'boolean') {
      row('warn', 'status unavailable');
      return;
    }
    if (!entry.installed) groups['not installed'].push(id);
    else groups[entry.enabled === false ? 'disabled' : 'enabled'].push(id);
  }
  const parts = Object.entries(groups)
    .filter(([, ids]) => ids.length)
    .map(([state, ids]) => `${state}: ${ids.join(', ')}`);
  const bridge = (id) => (builtinFeatureActive(undefined, id) ? 'bridge active' : 'no bridge');
  row('ok', `${parts.join(' · ')} · browser use ${bridge('browser')} · computer use ${bridge('computer')}`);
}

function reportVoice(voice, row) {
  if (typeof voice.enabled !== 'boolean') {
    row('warn', 'status unavailable');
    return;
  }
  if (!voice.enabled) {
    row('ok', 'disabled');
    return;
  }
  if (voice.installed !== true || voice.components?.model === false) {
    row('warn', 'enabled · runtime or model not installed', { hint: 'reinstall voice from Extensions' });
    return;
  }
  row('ok', 'enabled · runtime and model installed');
}

function reportHooks(hooks, row) {
  if (
    typeof hooks.enabled !== 'boolean' ||
    !Array.isArray(hooks.configuredEvents) ||
    !Number.isFinite(hooks.ruleCount)
  ) {
    row('warn', 'status unavailable');
    return;
  }
  const errors = Array.isArray(hooks.errors) ? hooks.errors.length : 0;
  let detail = `${hooks.enabled ? 'enabled' : 'disabled'} · ${hooks.ruleCount} rules · ${hooks.configuredEvents.length} configured events`;
  if (errors) detail += ` · ${errors} configuration errors`;
  row(errors ? 'warn' : 'ok', detail);
}

// Local installation state: the data folder every runtime store writes to,
// the unified config file inside it, and log accumulation there.
async function readDataFolder(dataDir) {
  try {
    await access(dataDir, fsConstants.W_OK);
    return { dataDir, writable: true };
  } catch (error) {
    return { dataDir, writable: false, missing: error?.code === 'ENOENT' };
  }
}

function reportDataFolder({ dataDir, writable, missing }, row) {
  if (writable) row('ok', `writable · ${dataDir}`);
  else if (missing) row('fail', `not found · ${dataDir}`, { hint: 'create the folder or point MIXDOG_DATA_DIR at an existing one' });
  else row('fail', `not writable · ${dataDir}`, { hint: 'check the folder permissions' });
}

async function readConfigFile(dataDir) {
  let raw;
  try {
    raw = await readFile(join(dataDir, 'mixdog-config.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return { exists: true, valid: !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) };
  } catch {
    return { exists: true, valid: false };
  }
}

function reportConfigFile({ exists, valid }, row) {
  if (!exists) row('ok', 'mixdog-config.json not created yet · defaults in use');
  else if (valid) row('ok', 'mixdog-config.json is valid');
  else row('fail', 'mixdog-config.json is not a valid JSON object', { hint: 'fix the JSON syntax in the config file' });
}

async function readLogFiles(dataDir) {
  const entries = await readdir(dataDir, { withFileTypes: true });
  return { count: entries.filter((entry) => entry.isFile() && entry.name.endsWith('.log')).length };
}

function reportLogFiles({ count }, row) {
  const detail = `${count} log files in the data folder`;
  if (count > DOCTOR_LOG_FILE_WARN) {
    row('warn', `${detail} (over ${DOCTOR_LOG_FILE_WARN})`, { hint: 'old per-process logs are not being pruned' });
  } else row('ok', detail);
}

export async function runDoctorChecks(runtime = {}, getState = () => ({}), options = {}) {
  const timeoutMs = options.timeoutMs ?? DOCTOR_CHECK_TIMEOUT_MS;
  const dataDir = options.dataDir ?? resolvePluginData();
  const pkg = readPackageJson();
  const checks = [
    ['mixdog', 'mixdog', () => runtime.checkForUpdate?.({}), reportUpdate(pkg)],
    ['node', 'node', () => ({ version: process.versions.node, engines: pkg?.engines?.node }), reportNode],
    ['providers', 'providers', () => runtime.getProviderSetup?.(), reportProviders(getState)],
    ['mcp', 'mcp', () => runtime.mcpStatus?.(), reportMcp],
    ['memory', 'memory', async () => (await runtime.getToolModuleSettings?.())?.memory, reportMemory(runtime)],
    [
      'localProvider',
      'local provider',
      async () => (await runtime.getToolModuleSettings?.())?.localProvider,
      reportLocalProvider,
    ],
    ['builtins', 'built-ins', async () => runtime.getToolModuleSettings?.(), reportBuiltins],
    [
      'voice',
      'voice',
      async () => (runtime.getVoiceStatus || (await import('../lib/voice-setup.mjs')).getVoiceStatus)(),
      reportVoice,
    ],
    [
      'automation',
      'automation',
      () => runtime.getChannelSettings?.({ includeStatus: true }),
      reportChannels(runtime),
    ],
    ['skills', 'skills', () => runtime.skillsStatus?.(), reportRegistry('skills')],
    ['plugins', 'plugins', () => runtime.pluginsStatus?.(), reportRegistry('plugins')],
    ['hooks', 'hooks', () => runtime.hooksStatus?.(), reportHooks],
    ['data', 'data folder', () => readDataFolder(dataDir), reportDataFolder],
    ['config', 'config', () => readConfigFile(dataDir), reportConfigFile],
    ['logs', 'logs', () => readLogFiles(dataDir), reportLogFiles],
  ];
  const rows = await Promise.all(
    checks.map(([id, label, readStatus, report]) => doctorCheck({ id, label, readStatus, report, timeoutMs }))
  );
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const row of rows) summary[row.level] += 1;
  return { checkedAt: Date.now(), summary, checks: rows };
}

export function formatDoctorReport(result) {
  const lines = ['mixdog doctor — installation health'];
  for (const check of result.checks) {
    lines.push(`${GLYPH[check.level] || GLYPH.warn} ${check.label}: ${check.detail}`);
    if (check.fix?.command) lines.push(`    → run ${check.fix.command}`);
    else if (check.fix?.hint) lines.push(`    → ${check.fix.hint}`);
  }
  const { ok, warn, fail } = result.summary;
  lines.push(`${ok} ok · ${warn} warnings · ${fail} failed`);
  return lines.join('\n');
}

export async function buildDoctorReport(runtime = {}, getState = () => ({}), options = {}) {
  return formatDoctorReport(await runDoctorChecks(runtime, getState, options));
}
