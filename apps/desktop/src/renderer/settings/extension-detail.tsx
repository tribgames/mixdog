import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useMemo, type FormEvent, type ReactNode } from 'react';

import type { DesktopProjectSummary } from '../../shared/contract';
import { t } from '../i18n';
import { OpenSelect } from '../OpenSelect';
import { record } from '../record-utils';
import { SidebarDialogLayer } from '../sidebar-dialog';
import { useSidebarReferences } from '../sidebar-reference-cache';
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
  return <button type="button"
    className="schedules-row utilities-row extensions-row extensions-row-open"
    data-extension-row={title} data-enabled={enabled ? 'true' : 'false'}
    aria-label={title} disabled={busy} onClick={onOpen} {...dataAttributes}>
    <span className="extensions-row-icon sidebar-resource-icon" aria-hidden="true">{icon}</span>
    <span className="schedules-row-copy utilities-row-copy">
      <span className="sidebar-resource-title">
        <b>{title}</b>
        {badge ? <span className="extensions-row-badge">{badge}</span> : null}
      </span>
      <small>{description}</small>
    </span>
    <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
  </button>;
}

/** Width ladder for every Extensions card: `compact` for one-field prompts
 *  (install source, add-kind choice), `detail` for read-mostly entries, and
 *  `editor` for the Skill/MCP forms that carry a Markdown body. */
export type ExtensionDialogWidth = 'compact' | 'detail' | 'editor';

/** THE card every Extensions entry opens in — built-in feature, plugin,
 *  skill, MCP server, and the install/add prompts. One header (identity plate,
 *  title, status switch or install control, close), one scrolling body on
 *  the 16px section rhythm, and a footer only when the entry has real
 *  actions. Editors pass `onSubmit`; the body and footer then live inside a
 *  form so the footer's submit button posts it. Rows drill IN here instead
 *  of exposing their actions in the list (user: 다른것들처럼 클릭해서 들어가서
 *  설정하는 걸로). Portaled because the list lives inside the sidebar's
 *  clipped box. */
export function ExtensionDetailDialog({
  title, icon, tagline, children, footer, enabled, busy, onToggle, headerControl, onClose,
  onSubmit, width = 'detail', titleId = 'extensions-dialog-title', className = '', dataAttributes,
}: {
  title: string;
  /** Identity glyph on the title line — the same plate as the list row's, so
   *  the dialog opens as a continuation of the row that was clicked. */
  icon?: ReactNode;
  /** One lead sentence under the header, before the sections. */
  tagline?: string;
  /** Body sections composed by the caller. */
  children: ReactNode;
  /** Footer buttons, complete: the caller decides Cancel/Close/Save/Remove.
   *  A `.danger` button parks itself on the left edge. */
  footer?: ReactNode;
  enabled?: boolean;
  busy?: boolean;
  onToggle?(enabled: boolean): void;
  /** Replaces the header switch (install pill, progress) when the entry is
   *  not simply on/off yet. */
  headerControl?: ReactNode;
  onClose(): void;
  /** Present on editors: body + footer render inside a form. */
  onSubmit?(event: FormEvent<HTMLFormElement>): void;
  width?: ExtensionDialogWidth;
  titleId?: string;
  className?: string;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const body = <>
    <div className="extensions-dialog-body">
      {tagline ? <p className="extensions-dialog-tagline">{tagline}</p> : null}
      {children}
    </div>
    {footer ? <footer className="extensions-dialog-actions">{footer}</footer> : null}
  </>;
  return <SidebarDialogLayer onClose={onClose}>
    <section className={`schedules-dialog extensions-dialog ${className}`.trim()}
      data-dialog-width={width} role="dialog" aria-modal="true"
      aria-labelledby={titleId} {...dataAttributes}>
      <header>
        {icon ? <span className="extensions-dialog-icon" aria-hidden="true">{icon}</span> : null}
        <h2 id={titleId}>{title}</h2>
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
      {onSubmit
        ? <form className="extensions-dialog-form" onSubmit={onSubmit}>{body}</form>
        : body}
    </section>
  </SidebarDialogLayer>;
}

/** Body building blocks shared by every Extensions card: titled sections,
 *  item rows, the facts list, notes, previews, form fields, the one action
 *  button, and the project-scope control. They live here so each dialog
 *  composes the same grammar instead of growing its own. */

export type ExtensionScopeKind = 'skills' | 'mcp' | 'plugins';

const PROJECT_KEYS = ['projects'] as const;

/** Section head (title, optional count, optional one-line note), then its
 *  body on the shared rhythm. `collapsible` folds the section behind its head
 *  for advanced, rarely used content. */
export function ExtensionSection({ title, count, description, action, collapsible = false, defaultOpen = false, children, dataAttributes }: {
  title: string;
  count?: number;
  description?: string;
  /** Head-line control on the trailing edge (an add button, a refresh). */
  action?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const head = <>
    <span>{title}</span>
    {typeof count === 'number' ? <em>{count}</em> : null}
  </>;
  if (collapsible) {
    return <details className="extensions-section" open={defaultOpen || undefined} {...dataAttributes}>
      <summary>
        <h3>{head}</h3>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {description ? <p className="extensions-section-note">{description}</p> : null}
      {children}
    </details>;
  }
  return <section className="extensions-section" {...dataAttributes}>
    <div className="extensions-section-head">
      <div>
        <h3>{head}</h3>
        {description ? <p className="extensions-section-note">{description}</p> : null}
      </div>
      {action ?? null}
    </div>
    {children}
  </section>;
}

export type ExtensionItemTone = 'ok' | 'off' | 'warn' | 'muted';

/** Stack of item rows on the section's 6px rhythm. */
export function ExtensionItemList({ children }: { children: ReactNode }) {
  return <div className="extensions-item-list">{children}</div>;
}

/** One contained item: a plugin's skill or MCP server, a model, a GitHub
 *  account line, or a setting whose control sits on its trailing edge. */
export function ExtensionItemRow({ icon, title, description, status, tone = 'muted', control, dataAttributes }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  status?: string;
  tone?: ExtensionItemTone;
  /** Trailing control (switch, select, or action) so the setting or bundled
   *  item is handled without leaving the card. */
  control?: ReactNode;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  // Same anatomy as the Settings dialog's resource row (user: 옵션쪽이랑
  // 맞춰): title with its status pill on one line, the meta line under it,
  // and the control on the trailing edge.
  return <div className="extensions-item" data-tone={tone} data-extension-item={title} {...dataAttributes}>
    {icon ? <span className="extensions-item-icon" aria-hidden="true">{icon}</span> : null}
    <span className="extensions-item-copy">
      <span className="extensions-item-title">
        <b>{title}</b>
        {status ? <span className="extensions-item-status"><i aria-hidden="true" />{status}</span> : null}
      </span>
      {description ? <small>{description}</small> : null}
    </span>
    {control ? <span className="extensions-item-trailing">{control}</span> : null}
  </div>;
}

/** The one in-card action button (28px quiet plate; `danger` for removal). */
export function ExtensionAction({ children, danger = false, disabled, ariaLabel, onClick }: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onClick(): void;
}) {
  return <button type="button" className={`extensions-action${danger ? ' danger' : ''}`}
    aria-label={ariaLabel} disabled={disabled} onClick={onClick}>{children}</button>;
}

/** Muted guidance line inside a section; `danger` for a blocking condition. */
export function ExtensionNote({ children, tone, role }: {
  children: ReactNode;
  tone?: 'danger';
  role?: 'status';
}) {
  return <p className="extensions-note" data-tone={tone} role={role}>{children}</p>;
}

/** Quiet example block: a titled explanation over a monospace sample. */
export function ExtensionPreview({ title, description, code }: {
  title: string;
  description?: string;
  code: string;
}) {
  return <div className="extensions-preview">
    <b>{title}</b>
    {description ? <p>{description}</p> : null}
    <code>{code}</code>
  </div>;
}

/** Form field on the dialog grammar: title, optional note, then the control. */
export function ExtensionField({ label, note, children, as = 'label', className = '', dataAttributes }: {
  label: string;
  note?: string;
  children: ReactNode;
  as?: 'label' | 'div';
  className?: string;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const Tag = as;
  return <Tag className={`schedules-field ${className}`.trim()} {...dataAttributes}>
    <span>{label}</span>
    {note ? <small>{note}</small> : null}
    {children}
  </Tag>;
}

/** Right-aligned action row under a field group (Save for a draft). */
export function ExtensionFieldActions({ children }: { children: ReactNode }) {
  return <div className="extensions-field-actions">{children}</div>;
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
  return <ExtensionField as="div" className="extensions-scope-field" label={t('Applies to')}
    note={value ? t('Only available in the selected project.') : t('Applies to every project.')}
    dataAttributes={{ 'data-extension-scope': kind }}>
    <OpenSelect className="extensions-scope-select" ariaLabel={t('Applies to')}
      value={value} disabled={busy || references.loading && !projects.length}
      options={options} localizeLabels={false}
      onChange={(next) => { void run('setExtensionScope', [kind, name, next ? [next] : []]); }} />
    {inheritedCount > 0 ? <ExtensionNote>
      {t('Also limited by plugin {{name}} to {{count}} projects.', { name: inheritedFrom || '', count: inheritedCount })}
    </ExtensionNote> : null}
  </ExtensionField>;
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
