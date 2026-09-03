import { Check, FolderOpen } from 'lucide-react';
import React, { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { DesktopProjectSummary } from '../../shared/contract';
import { t } from '../i18n';
import { record } from '../record-utils';
import { useSidebarReferences } from '../sidebar-reference-cache';
import type { CapabilityApi, PanelContext, RecordValue } from './capability-data';

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
export function ExtensionItemRow({ icon, title, description, status, tone = 'muted' }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  status?: string;
  tone?: ExtensionItemTone;
}) {
  return <div className="extensions-item" data-tone={tone}>
    {icon ? <span className="extensions-item-icon" aria-hidden="true">{icon}</span> : null}
    <span className="extensions-item-copy">
      <b>{title}</b>
      {description ? <small>{description}</small> : null}
    </span>
    {status ? <span className="extensions-item-status"><i aria-hidden="true" />{status}</span> : null}
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

/** "Applies to": every project, or a checked subset of the project catalog.
 *  Saves on every change through `setExtensionScope`; the list re-reads from
 *  the refreshed status, so `scope` is the source of truth between edits. */
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
  const [selecting, setSelecting] = useState(Boolean(scope));
  useEffect(() => { setSelecting(Boolean(scope)); }, [scope]);
  const selected = useMemo(() => scope ?? [], [scope]);
  const isSelected = (path: string) => selected.some((root) => samePath(root, path));
  const save = (paths: string[]) => { void run('setExtensionScope', [kind, name, paths]); };
  const choose = (path: string, on: boolean) => {
    const next = on
      ? [...selected.filter((root) => !samePath(root, path)), path]
      : selected.filter((root) => !samePath(root, path));
    save(next);
  };
  const beginSelecting = () => {
    setSelecting(true);
    // Start from the project the user is in; nothing else is a safe guess.
    if (!scope && currentPath && projects.some((project) => samePath(project.path, currentPath))) {
      save([currentPath]);
    }
  };
  const inheritedCount = inheritedScope?.length ?? 0;
  return <div className="schedules-field extensions-scope-field" data-extension-scope={kind}>
    <span>{t('Applies to')}</span>
    <small>{selecting
      ? (selected.length ? t('Limited to {{count}} projects.', { count: selected.length })
        : t('Pick at least one project; until then it stays available everywhere.'))
      : t('Applies to every project.')}</small>
    <div className="extensions-mcp-transport extensions-scope-mode" role="group" aria-label={t('Applies to')}>
      <button type="button" className={selecting ? '' : 'active'} aria-pressed={!selecting}
        disabled={busy} onClick={() => { setSelecting(false); if (scope) save([]); }}>
        <Check size={12} aria-hidden="true" />
        <span>{t('All projects')}</span>
      </button>
      <button type="button" className={selecting ? 'active' : ''} aria-pressed={selecting}
        disabled={busy} onClick={beginSelecting}>
        <Check size={12} aria-hidden="true" />
        <span>{t('Selected projects')}</span>
      </button>
    </div>
    {selecting ? <div className="extensions-scope-projects" role="group" aria-label={t('Selected projects')}>
      {projects.length ? projects.map((project) => {
        const on = isSelected(project.path);
        const here = Boolean(currentPath) && samePath(project.path, String(currentPath));
        return <label key={project.path} className="extensions-scope-project" data-selected={on ? 'true' : 'false'}>
          <input type="checkbox" checked={on} disabled={busy}
            onChange={(event) => choose(project.path, event.currentTarget.checked)} />
          <FolderOpen size={14} aria-hidden="true" />
          <span className="extensions-scope-project-copy">
            <b>{projectDisplayName(project)}{here ? <em>{t('Current project')}</em> : null}</b>
            <small>{project.path}</small>
          </span>
        </label>;
      }) : <p className="extensions-mcp-note">{references.loading
        ? t('Loading projects…')
        : t('No projects yet. Add one under Projects.')}</p>}
    </div> : null}
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
