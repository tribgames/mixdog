import { ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopProjectSummary } from '../../shared/contract';
import { t } from '../i18n';
import { useMobileBack } from '../mobile-back';
import { OpenSelect } from '../OpenSelect';
import { record } from '../record-utils';
import { useSidebarReferences } from '../sidebar-reference-cache';
import { acquireTitleBarDim } from '../titlebar-dim';
import { CompactSwitch } from './capability-controls';
import type { CapabilityApi, PanelContext, RecordValue } from './capability-data';

/** One list row for every extension kind — built-in feature, plugin, skill,
 *  MCP server: icon, title line, one-line description. The row has no switch;
 *  enabling lives in the detail dialog (user: 아이템 레이아웃은 아이콘 제목줄
 *  설명줄 한줄로 가고 토글버튼 빼고). A disabled entry only dims its icon so
 *  the list still reads as one column. */
export function ExtensionRow({ icon, title, description, badge, enabled, busy, onOpen, dataAttributes }: {
  icon: ReactNode;
  title: string;
  description: string;
  /** Short status note ("2 projects", "Not installed"); '' hides it. */
  badge?: string;
  enabled: boolean;
  busy: boolean;
  onOpen(): void;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  return <div className="schedules-row utilities-row extensions-row" data-extension-row={title}
    data-enabled={enabled ? 'true' : 'false'} {...dataAttributes}>
    <button type="button"
      className="schedules-row-copy utilities-row-copy projects-row-open extensions-row-open"
      aria-label={title} disabled={busy} onClick={onOpen}>
      <span className="extensions-row-icon" aria-hidden="true">{icon}</span>
      <span className="sidebar-resource-title">
        <b>{title}</b>
        {badge ? <span className="extensions-row-badge">{badge}</span> : null}
      </span>
      <small>{description}</small>
    </button>
    <button type="button" className="session-panel-action workflows-row-enter extensions-row-enter"
      aria-label={t('Edit {{name}}', { name: title })} disabled={busy} onClick={onOpen}>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  </div>;
}

/** The detail card every section shares: facts, optional content, then the
 *  entry's actions. Rows drill IN here instead of exposing their actions in the
 *  list (user: 다른것들처럼 클릭해서 들어가서 설정하는 걸로) — the same move
 *  Workflows, Schedules and Webhooks make. Portaled for their reason too: the
 *  list lives inside the sidebar's clipped box. */
export function ExtensionDetailDialog({ title, children, actions, enabled, busy, onToggle, headerControl, onClose, dataAttributes }: {
  title: string;
  /** Body sections: hero, scope, contents, facts — composed by the caller. */
  children: ReactNode;
  actions?: ReactNode;
  enabled?: boolean;
  busy?: boolean;
  onToggle?(enabled: boolean): void;
  /** Replaces the header switch (install pill, progress) when the entry is
   *  not simply on/off yet. */
  headerControl?: ReactNode;
  onClose(): void;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog extensions-dialog" role="dialog" aria-modal="true"
      aria-labelledby="extensions-dialog-title" {...dataAttributes}>
      <header>
        <h2 id="extensions-dialog-title">{title}</h2>
        <div className="schedules-dialog-header-actions">
          {headerControl !== undefined ? headerControl
            : typeof enabled === 'boolean' && onToggle && <CompactSwitch
              label={`${title} · ${t('Enabled')}`} checked={enabled}
              disabled={busy} onChange={onToggle} />}
          <button type="button" aria-label={t("Close")} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="extensions-dialog-body">
        {children}
        <footer>
          {actions}
          <button type="button" className="secondary" onClick={onClose}>{t('Close')}</button>
        </footer>
      </div>
    </section>
  </div>, document.body);
}

/** Extension detail building blocks shared by the Plugin, Skill, and MCP
 *  dialogs: identity header, titled sections, item rows, the facts list, and
 *  the project-scope control. They live outside capability-panels.tsx so the
 *  three dialogs compose the same grammar instead of each growing its own. */

export type ExtensionScopeKind = 'skills' | 'mcp' | 'plugins';

const PROJECT_KEYS = ['projects'] as const;

/** Icon tile + name + one-line summary under the dialog header. */
export function ExtensionHero({ icon, title, tagline }: {
  icon: ReactNode;
  title: string;
  tagline?: string;
}) {
  return <div className="extensions-hero">
    <span className="extensions-hero-icon" aria-hidden="true">{icon}</span>
    <div className="extensions-hero-copy">
      <b>{title}</b>
      {tagline ? <small>{tagline}</small> : null}
    </div>
  </div>;
}

/** Section head with an optional count, then its body on the shared rhythm. */
export function ExtensionSection({ title, count, children }: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return <section className="extensions-section">
    <h3>
      <span>{title}</span>
      {typeof count === 'number' ? <em>{count}</em> : null}
    </h3>
    {children}
  </section>;
}

export type ExtensionItemTone = 'ok' | 'off' | 'warn' | 'muted';

/** One contained item (a plugin's skill or MCP server, an MCP tool). */
export function ExtensionItemRow({ icon, title, description, status, tone = 'muted', control }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  status?: string;
  tone?: ExtensionItemTone;
  /** Trailing control (its own switch or action) so a bundled item can be
   *  turned on/off without leaving the owning plugin. */
  control?: ReactNode;
}) {
  return <div className="extensions-item" data-tone={tone} data-extension-item={title}>
    {icon ? <span className="extensions-item-icon" aria-hidden="true">{icon}</span> : null}
    <span className="extensions-item-copy">
      <b>{title}</b>
      {description ? <small>{description}</small> : null}
    </span>
    <span className="extensions-item-trailing">
      {status ? <span className="extensions-item-status"><i aria-hidden="true" />{status}</span> : null}
      {control}
    </span>
  </div>;
}

export function ExtensionFacts({ facts }: {
  facts: ReadonlyArray<readonly [string, string]>;
}) {
  const visible = facts.filter(([, value]) => value);
  if (!visible.length) return null;
  return <dl className="extensions-dialog-facts">
    {visible.map(([label, value]) => <div key={label}>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
    </div>)}
  </dl>;
}

function samePath(left: string, right: string): boolean {
  const norm = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(left) === norm(right);
}

export function projectDisplayName(project: DesktopProjectSummary): string {
  return String(project.alias || project.name || project.path.split(/[\\/]/).pop() || project.path);
}

/** Short list-row badge for a scoped entry: '' when global. */
export function extensionScopeBadge(row: RecordValue): string {
  const scope = Array.isArray(row.scope) ? row.scope : null;
  const inherited = Array.isArray(row.inheritedScope) ? row.inheritedScope : null;
  if (row.activeHere === false) return t('Not in this project');
  const count = scope ? scope.length : inherited ? inherited.length : 0;
  if (!count) return '';
  return count === 1 ? t('1 project') : t('{{count}} projects', { count });
}

const SHARED_SCOPE = '';

/** "Applies to": one dropdown choosing Shared (every project) or a single
 *  project from the catalog (user: 프로젝트 선택은 드롭다운으로 공용이나 개별
 *  프로젝트 중 하나 선택). Saves on change through `setExtensionScope`; the
 *  list re-reads from the refreshed status, so `scope` is the source of truth
 *  between edits. A legacy multi-project scope shows its first project and
 *  collapses to that one on the next change. */
export function ExtensionScopeField({ api, run, kind, name, scope, inheritedScope, inheritedFrom, currentPath, busy }: {
  api: CapabilityApi;
  run: PanelContext['run'];
  kind: ExtensionScopeKind;
  name: string;
  scope: string[] | null;
  inheritedScope?: string[] | null;
  inheritedFrom?: string;
  currentPath?: string;
  busy: boolean;
}) {
  const references = useSidebarReferences(api, PROJECT_KEYS);
  const projects = references.values.projects ?? [];
  const current = scope?.[0] ?? SHARED_SCOPE;
  const options = useMemo(() => {
    const catalog = projects.map((project) => ({
      value: project.path,
      label: samePath(project.path, String(currentPath || ''))
        ? `${projectDisplayName(project)} · ${t('Current project')}`
        : projectDisplayName(project),
    }));
    // A scoped path missing from the catalog still shows, so the field never
    // silently reports "Shared" for an entry that is in fact limited.
    if (current && !catalog.some((option) => samePath(option.value, current))) {
      catalog.unshift({ value: current, label: current.split(/[\\/]/).pop() || current });
    }
    return [{ value: SHARED_SCOPE, label: t('Shared (all projects)') }, ...catalog];
  }, [projects, current, currentPath]);
  const matched = options.find((option) => option.value !== SHARED_SCOPE && samePath(option.value, current));
  const value = current ? matched?.value ?? current : SHARED_SCOPE;
  const inheritedCount = inheritedScope?.length ?? 0;
  return <div className="schedules-field extensions-scope-field" data-extension-scope={kind}>
    <span>{t('Applies to')}</span>
    <small>{value ? t('Only available in the selected project.') : t('Applies to every project.')}</small>
    <OpenSelect className="extensions-scope-select" ariaLabel={t('Applies to')}
      value={value} disabled={busy || references.loading && !projects.length}
      options={options} localizeLabels={false}
      onChange={(next) => { void run('setExtensionScope', [kind, name, next ? [next] : []]); }} />
    {inheritedCount > 0 ? <p className="extensions-mcp-note">
      {t('Also limited by plugin {{name}} to {{count}} projects.', { name: inheritedFrom || '', count: inheritedCount })}
    </p> : null}
  </div>;
}

/** Scope props straight off a decorated status row. */
export function scopeOf(row: RecordValue): { scope: string[] | null; inheritedScope: string[] | null } {
  const scope = Array.isArray(row.scope) ? row.scope.map(String) : null;
  const inheritedScope = Array.isArray(row.inheritedScope) ? row.inheritedScope.map(String) : null;
  return { scope: scope && scope.length ? scope : null, inheritedScope: inheritedScope && inheritedScope.length ? inheritedScope : null };
}

export function currentProjectPath(data: Record<string, unknown>): string {
  return String(record(data.skills).cwd || '');
}
