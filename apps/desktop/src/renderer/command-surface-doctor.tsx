import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { t } from './i18n';
import { record } from './record-utils';
import { resolveDesktopSlashCommand, type SettingsSection } from './slash-commands';

type DoctorLevel = 'ok' | 'warn' | 'fail';

interface DoctorCheck {
  id: string;
  label: string;
  level: DoctorLevel;
  detail: string;
  command: string;
  hint: string;
}

interface DoctorReport {
  busy: boolean;
  checks: DoctorCheck[];
  summary: Record<DoctorLevel, number>;
}

const LEVEL_ORDER: Record<DoctorLevel, number> = { fail: 0, warn: 1, ok: 2 };

/** The runtime's runDoctor result: { busy } or { summary, checks }. Anything
 * else (an older runtime's text report, a failed read) is not a report. */
export function doctorReport(value: unknown): DoctorReport | null {
  const source = record(value);
  const summary: Record<DoctorLevel, number> = { ok: 0, warn: 0, fail: 0 };
  if (source.busy === true) return { busy: true, checks: [], summary };
  if (!Array.isArray(source.checks)) return null;
  const checks = source.checks
    .map(record)
    .filter((entry) => typeof entry.id === 'string' && entry.id)
    .map((entry): DoctorCheck => {
      const fix = record(entry.fix);
      const level: DoctorLevel = entry.level === 'ok' || entry.level === 'fail' ? entry.level : 'warn';
      summary[level] += 1;
      return {
        id: String(entry.id),
        label: String(entry.label || entry.id),
        level,
        detail: String(entry.detail || ''),
        command: typeof fix.command === 'string' ? fix.command : '',
        hint: typeof fix.hint === 'string' ? fix.hint : '',
      };
    })
    // Problems first; the runtime's order is kept within each level.
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return { busy: false, checks, summary };
}

function checkLabel(check: DoctorCheck): string {
  switch (check.id) {
    case 'mixdog':
      return t('Mixdog');
    case 'node':
      return t('Node.js');
    case 'providers':
      return t('Providers');
    case 'mcp':
      return t('MCP');
    case 'memory':
      return t('Memory');
    case 'localProvider':
      return t('Local Provider');
    case 'builtins':
      return t('Built-ins');
    case 'voice':
      return t('Voice transcription');
    case 'automation':
      return t('Automations');
    case 'skills':
      return t('Skills');
    case 'plugins':
      return t('Plugins');
    case 'hooks':
      return t('Hooks');
    case 'data':
      return t('Data folder');
    case 'config':
      return t('Config file');
    case 'logs':
      return t('Logs');
    default:
      return check.label;
  }
}

function LevelIcon({ level, size = 16 }: { level: DoctorLevel; size?: number }) {
  if (level === 'fail') return <CircleX size={size} aria-hidden="true" />;
  if (level === 'warn') return <TriangleAlert size={size} aria-hidden="true" />;
  return <CircleCheck size={size} aria-hidden="true" />;
}

/** The settings page a check's fix command opens on the desktop, if any. */
function fixSection(check: DoctorCheck): SettingsSection | null {
  if (!check.command.startsWith('/')) return null;
  return resolveDesktopSlashCommand(check.command.slice(1))?.settingsRow ?? null;
}

/**
 * /doctor — one card: the overall verdict and per-level counts on top, then
 * one row per check (problems first) with the settings page that fixes it.
 */
export function DoctorBody({
  value,
  running,
  onRerun,
  onOpenSettings,
}: {
  value: unknown;
  running: boolean;
  onRerun: () => void;
  onOpenSettings?: (section: SettingsSection) => void;
}) {
  const report = doctorReport(value);
  let overall: DoctorLevel = 'ok';
  if (report?.summary.fail) overall = 'fail';
  else if (report?.summary.warn) overall = 'warn';
  let headline = t('Everything looks healthy');
  if (overall === 'fail') headline = t('Problems found');
  else if (overall === 'warn') headline = t('Some checks need attention');

  return (
    <div className="doctor-surface">
      {!report && <p className="doctor-surface-note">{t('No data available.')}</p>}
      {report?.busy && (
        <p className="doctor-surface-note" role="status">
          {t('Another command is running. Try again when it finishes.')}
        </p>
      )}
      {report && !report.busy && (
        <>
          <div className="doctor-surface-summary" data-level={overall}>
            <LevelIcon level={overall} size={20} />
            <strong>{headline}</strong>
            <span className="doctor-surface-counts">
              {(['ok', 'warn', 'fail'] as const).map((level) => (
                <span key={level} data-level={level}>
                  <LevelIcon level={level} size={14} />
                  {report.summary[level]}
                </span>
              ))}
            </span>
          </div>
          <ul className="doctor-surface-list">
            {report.checks.map((check) => {
              const section = fixSection(check);
              const hint = check.hint || (!section && check.command) || '';
              return (
                <li key={check.id} className="doctor-check" data-level={check.level}>
                  <LevelIcon level={check.level} />
                  <div className="doctor-check-text">
                    <span className="doctor-check-label">{checkLabel(check)}</span>
                    <span className="doctor-check-detail">{check.detail}</span>
                    {hint && <span className="doctor-check-hint">{hint}</span>}
                  </div>
                  {section && onOpenSettings && (
                    <button type="button" className="doctor-check-fix" onClick={() => onOpenSettings(section)}>
                      {t('Open')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <footer className="doctor-surface-actions">
        <button type="button" disabled={running} onClick={onRerun}>
          {running ? t('Checking…') : t('Run diagnostics again')}
        </button>
      </footer>
    </div>
  );
}
