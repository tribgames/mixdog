/**
 * doctor.mjs — /doctor installation health report builder.
 *
 * Read-only diagnostics against current runtime status contracts. Missing
 * status is WARN, not a healthy default; a failed check cannot abort the
 * remaining checks. Report only names, counts and flags, never credentials
 * or raw errors. The update check uses the existing best-effort npm checker.
 * Configuration status does not prove service/database health.
 */
import { compareSemver } from '../../runtime/shared/update-checker.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLYPH = { ok: '✓', warn: '⚠', fail: '✗' };

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

export async function buildDoctorReport(runtime = {}, getState = () => ({})) {
  const rows = [];
  const check = async (label, readStatus, report) => {
    const row = (level, detail) => {
      rows.push(`${GLYPH[level] || GLYPH.warn} ${label}: ${detail}`);
    };
    try {
      const status = await readStatus();
      if (!status || typeof status !== 'object' || Array.isArray(status)) {
        row('warn', 'status unavailable');
        return;
      }
      await report(status, row);
    } catch {
      // Errors can contain request URLs, headers or credentials.
      row('fail', 'check failed (error details omitted)');
    }
  };
  const pkg = readPackageJson();

  await check('mixdog', () => runtime.checkForUpdate?.({}), (upd, row) => {
    const current = upd.currentVersion || pkg?.version || 'unknown';
    const latest = upd.latestVersion;
    if (!latest) {
      row('warn', `v${current} · update check skipped (registry unreachable)`);
      return;
    }
    if (upd.updateAvailable) row('warn', `v${current} · update available → v${latest}`);
    else row('ok', `v${current} · up to date`);
  });

  await check(
    'node',
    () => ({ version: process.versions.node, engines: pkg?.engines?.node }),
    ({ version, engines }, row) => {
      const supported = nodeEngineSupport(version, engines);
      if (supported == null) {
        row('warn', `v${version} · engine requirement ${engines ? `"${engines}" unverified` : 'unavailable'}`);
        return;
      }
      row(supported ? 'ok' : 'fail', `v${version} · requires node ${engines}`);
    }
  );

  await check('providers', () => runtime.getProviderSetup?.(), (setup, row) => {
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
    const isReady = (p) =>
      p.enabled !== false &&
      p.reauthRequired !== true &&
      p.usable !== false &&
      (p.type === 'local' ? p.detected === true : p.authenticated === true);
    const ready = lists.filter(isReady);
    const activeEntry = active ? lists.find((p) => p.id === active) : null;
    if (activeEntry && !isReady(activeEntry)) {
      const reason = activeEntry.reauthRequired
        ? 'requires sign-in again'
        : activeEntry.enabled === false
          ? 'is disabled'
          : activeEntry.type === 'local' && !activeEntry.detected
            ? 'has no installed runtime/model'
            : !activeEntry.authenticated
              ? 'has no auth'
              : 'is not usable';
      row('fail', `route ${active} ${reason} · ${ready.length} ready · check /providers`);
      return;
    }
    if (active && !activeEntry) {
      row('warn', `${ready.length} ready · route ${active} (not listed)`);
      return;
    }
    row(active ? 'ok' : 'warn', `${ready.length} ready · route ${active || 'unknown'}`);
  });

  await check('mcp', () => runtime.mcpStatus?.(), (status, row) => {
    if (!Array.isArray(status.servers) || (!status.servers.length && status.configuredCount > 0)) {
      row('warn', 'status unavailable');
      return;
    }
    const servers = status.servers;
    if (!servers.length) {
      row('ok', 'no servers configured');
      return;
    }
    const active = servers.filter((s) => s.enabled !== false && s.activeHere !== false);
    const connected = active.filter((s) => s.connected === true);
    const failed = active.filter((s) => s.error || s.status === 'failed');
    const pending = active.filter((s) => s.connected !== true && !failed.includes(s));
    const disabled = servers.filter((s) => s.enabled === false).length;
    const outside = servers.filter((s) => s.enabled !== false && s.activeHere === false).length;
    let detail = `${connected.length}/${active.length} connected`;
    if (disabled) detail += ` · ${disabled} disabled`;
    if (outside) detail += ` · ${outside} outside this project`;
    if (failed.length) detail += ` · failed: ${failed.map((s) => s.name).join(', ')}`;
    if (pending.length) detail += ` · disconnected: ${pending.map((s) => s.name).join(', ')}`;
    row(failed.length || pending.length ? 'warn' : 'ok', detail);
  });

  await check(
    'memory',
    async () => (await runtime.getToolModuleSettings?.())?.memory,
    async (memory, row) => {
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
    }
  );

  await check(
    'channels',
    () => runtime.getChannelSettings?.({ includeStatus: true }),
    async (settings, row) => {
      if (typeof settings.enabled !== 'boolean') {
        row('warn', 'status unavailable');
        return;
      }
      if (!settings.enabled) {
        row('ok', 'disabled');
        return;
      }
      const worker = settings.status || (await runtime.getChannelWorkerStatus?.());
      if (typeof worker?.running !== 'boolean') {
        row('warn', 'enabled · worker status unavailable');
        return;
      }
      row(worker.running ? 'ok' : 'warn', `enabled · worker ${worker.running ? 'running' : 'stopped'}`);
    }
  );

  for (const [label, method] of [['skills', 'skillsStatus'], ['plugins', 'pluginsStatus']]) {
    await check(label, () => runtime[method]?.(), (status, row) => {
      const entries = status[label];
      if (!Array.isArray(entries)) {
        row('warn', 'status unavailable');
        return;
      }
      const active = entries.filter((entry) => entry.enabled !== false && entry.activeHere !== false);
      const disabled = entries.filter((entry) => entry.enabled === false).length;
      const outside = entries.filter((entry) => entry.enabled !== false && entry.activeHere === false).length;
      const broken = active.filter(
        (entry) => entry.broken || entry.error || entry.invalid || entry.dependencyIssues?.length
      );
      let detail = `${active.length}/${entries.length} active`;
      if (disabled) detail += ` · ${disabled} disabled`;
      if (outside) detail += ` · ${outside} outside this project`;
      if (broken.length) detail += ` · issues: ${broken.map((entry) => entry.name || entry.id).join(', ')}`;
      row(broken.length ? 'warn' : 'ok', detail);
    });
  }

  await check('hooks', () => runtime.hooksStatus?.(), (hooks, row) => {
    if (typeof hooks.enabled !== 'boolean' || !Array.isArray(hooks.configuredEvents) || !Number.isFinite(hooks.ruleCount)) {
      row('warn', 'status unavailable');
      return;
    }
    const errors = Array.isArray(hooks.errors) ? hooks.errors.length : 0;
    let detail = `${hooks.enabled ? 'enabled' : 'disabled'} · ${hooks.ruleCount} rules · ${hooks.configuredEvents.length} configured events`;
    if (errors) detail += ` · ${errors} configuration errors`;
    row(errors ? 'warn' : 'ok', detail);
  });

  return ['mixdog doctor — installation health', ...rows].join('\n');
}
