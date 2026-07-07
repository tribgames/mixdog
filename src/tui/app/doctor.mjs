/**
 * doctor.mjs — /doctor installation health report builder.
 *
 * buildDoctorReport(runtime, getState) runs a fixed set of best-effort
 * diagnostics against the live runtime accessors and returns a single
 * multi-line string (one glyph-prefixed row per check). Every check is
 * individually try/caught so one failure degrades to a single FAIL row
 * instead of killing the whole report. No secrets are ever printed — only
 * whether a token/auth is configured. The only network touch is the
 * best-effort npm update check already used by /update; an unreachable
 * registry downgrades to a WARN "check skipped" row, never a throw.
 */
import { compareSemver } from '../../runtime/shared/update-checker.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';

const GLYPH = { ok: '✓', warn: '⚠', fail: '✗' };

// Windows Defender real-time scanning of the Postgres data dir shows up as
// pathologically long checkpoint write phases in pg.log (e.g. write=12 s for a
// <10MB checkpoint). Get-MpPreference needs admin, so we never read the actual
// exclusion list — we infer interference from checkpoint timings instead.
const CKPT_WRITE_WARN_S = 10; // any single checkpoint write phase over this = suspicious
const CKPT_WRITE_MEDIAN_S = 5; // sustained median over this = suspicious

function parseCheckpointWriteSeconds(logText) {
  const lines = String(logText).split(/\r?\n/).slice(-200);
  const out = [];
  for (const line of lines) {
    const m = /checkpoint complete:.*?\bwrite=([\d.]+)\s*s/i.exec(line);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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
  const check = async (label, fn) => {
    const row = (level, detail) => {
      rows.push(`${GLYPH[level] || GLYPH.warn} ${label}: ${detail}`);
    };
    try {
      await fn(row);
    } catch (e) {
      row('fail', `check failed: ${e?.message || e}`);
    }
  };
  const pkg = readPackageJson();

  // 1. mixdog version + update availability (best-effort registry check).
  await check('mixdog', async (row) => {
    const upd = (await runtime.checkForUpdate?.({})) || {};
    const current = upd.currentVersion || pkg?.version || 'unknown';
    const latest = upd.latestVersion;
    if (latest == null) {
      row('warn', `v${current} · update check skipped (registry unreachable)`);
      return;
    }
    if (upd.updateAvailable) row('warn', `v${current} · update available → v${latest}`);
    else row('ok', `v${current} · up to date`);
  });

  // 2. node version vs package.json engines (only when engines present).
  await check('node', async (row) => {
    const nodeVer = process.versions?.node || '0.0.0';
    const engines = pkg?.engines?.node;
    if (!engines) {
      row('ok', `v${nodeVer}`);
      return;
    }
    const m = String(engines).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) {
      row('warn', `v${nodeVer} · engines "${engines}" unparsed`);
      return;
    }
    const required = `${m[1]}.${m[2] || 0}.${m[3] || 0}`;
    const ok = compareSemver(nodeVer, required) >= 0;
    row(ok ? 'ok' : 'fail', `v${nodeVer} · requires node ${engines}`);
  });

  // 3. providers: configured auth count; FAIL if the active route provider
  //    has no auth.
  await check('providers', async (row) => {
    const setup = (await runtime.getProviderSetup?.()) || {};
    const lists = [...(setup.api || []), ...(setup.oauth || []), ...(setup.local || [])];
    const isAuthed = (p) => Boolean(p && (p.authenticated || p.enabled || p.detected));
    const authed = lists.filter(isAuthed);
    const active = getState()?.provider || '';
    const activeEntry = active ? lists.find((p) => p.id === active) : null;
    if (activeEntry && !isAuthed(activeEntry)) {
      row('fail', `route ${active} has no auth · ${authed.length} configured`);
      return;
    }
    if (active && !activeEntry) {
      row('warn', `${authed.length} authed · route ${active} (not listed)`);
      return;
    }
    row('ok', `${authed.length} authed · route ${active || 'unknown'}`);
  });

  // 4. MCP: connected/configured, failed servers named.
  await check('mcp', async (row) => {
    const m = runtime.mcpStatus?.() || {};
    const servers = Array.isArray(m.servers) ? m.servers : [];
    const conn = Number(m.connectedCount || 0);
    const conf = Number(m.configuredCount || 0);
    if (conf === 0) {
      row('ok', 'no servers configured');
      return;
    }
    const failed = servers
      .filter((s) => s && (s.error || s.status === 'failed'))
      .map((s) => s.name || s.id)
      .filter(Boolean);
    const detail = `${conn}/${conf} connected${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`;
    row(failed.length || conn < conf ? 'warn' : 'ok', detail);
  });

  // 5. memory: enabled/disabled (+ backend health only if the accessor
  //    already exposes it; no new probing).
  await check('memory', async (row) => {
    const mem = runtime.getMemorySettings?.() || {};
    const enabled = mem.enabled !== false;
    let detail = enabled ? 'enabled' : 'disabled';
    if (mem.backend) detail += ` · backend ${mem.backend}`;
    const health = mem.backendHealth || mem.health;
    if (health != null) {
      detail += ` · ${typeof health === 'string' ? health : (health.ok ? 'healthy' : 'unhealthy')}`;
    }
    row(enabled ? 'ok' : 'warn', detail);
  });

  // 6. channels: enabled + worker status + configured tokens (names only).
  await check('channels', async (row) => {
    const settings = runtime.getChannelSettings?.({ includeStatus: true }) || {};
    const enabled = settings.enabled !== false;
    if (!enabled) {
      row('ok', 'disabled');
      return;
    }
    const worker = settings.status || runtime.getChannelWorkerStatus?.() || {};
    const setup = (await runtime.getChannelSetup?.()) || {};
    const tokens = [];
    if (setup.discord?.authenticated) tokens.push('discord');
    if (setup.telegram?.authenticated) tokens.push('telegram');
    if (setup.webhook?.authenticated) tokens.push('webhook');
    const running = worker.running === true;
    const detail = `enabled · worker ${running ? 'running' : 'stopped'} · tokens: ${tokens.length ? tokens.join(', ') : 'none'}`;
    row(running ? 'ok' : 'warn', detail);
  });

  // 7. skills / plugins / hooks: counts + broken/disabled entries.
  await check('skills', async (row) => {
    const s = runtime.skillsStatus?.() || {};
    const skills = Array.isArray(s.skills) ? s.skills : [];
    const broken = skills.filter((x) => x && (x.broken || x.error || x.invalid));
    const disabled = skills.filter((x) => x && x.disabled);
    let detail = `${s.count ?? skills.length} available`;
    if (disabled.length) detail += ` · ${disabled.length} disabled`;
    if (broken.length) detail += ` · broken: ${broken.map((x) => x.name || x.id).filter(Boolean).join(', ')}`;
    row(broken.length ? 'warn' : 'ok', detail);
  });
  await check('plugins', async (row) => {
    const p = runtime.pluginsStatus?.() || {};
    const plugins = Array.isArray(p.plugins) ? p.plugins : [];
    const broken = plugins.filter((x) => x && (x.broken || x.error));
    const disabled = plugins.filter((x) => x && x.disabled);
    let detail = `${p.count ?? plugins.length} detected`;
    if (disabled.length) detail += ` · ${disabled.length} disabled`;
    if (broken.length) detail += ` · broken: ${broken.map((x) => x.title || x.name || x.id).filter(Boolean).join(', ')}`;
    row(broken.length ? 'warn' : 'ok', detail);
  });
  await check('hooks', async (row) => {
    const h = runtime.hooksStatus?.() || {};
    const events = Array.isArray(h.events) ? h.events : [];
    const enabled = h.enabled === true;
    row('ok', `${enabled ? 'enabled' : 'disabled'} · ${events.length} event${events.length === 1 ? '' : 's'}`);
  });

  // 8. defender (win32 only): infer AV real-time-scan interference on the PG
  //    data dir from checkpoint write timings; report-only, so surface the
  //    exact elevated exclusion one-liner as copyable fix text.
  if (process.platform === 'win32') {
    await check('defender', async (row) => {
      const dataDir = resolvePluginData();
      const pgdata = join(dataDir, 'pgdata');
      let writes;
      try {
        writes = parseCheckpointWriteSeconds(readFileSync(join(dataDir, 'pg.log'), 'utf8'));
      } catch {
        row('ok', 'pg.log unavailable · check skipped');
        return;
      }
      if (!writes.length) {
        row('ok', 'no checkpoint timings yet');
        return;
      }
      const max = Math.max(...writes);
      const med = median(writes);
      if (max <= CKPT_WRITE_WARN_S && med <= CKPT_WRITE_MEDIAN_S) {
        row('ok', `checkpoint write median ${med.toFixed(1)}s · max ${max.toFixed(1)}s`);
        return;
      }
      const fix = `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',"Add-MpPreference -ExclusionPath '${pgdata}'"`;
      row('warn', `slow checkpoints (median ${med.toFixed(1)}s · max ${max.toFixed(1)}s) suggest Defender real-time scan of ${pgdata}. Fix (run in PowerShell): ${fix}`);
    });
  }

  return ['mixdog doctor — installation health', ...rows].join('\n');
}
