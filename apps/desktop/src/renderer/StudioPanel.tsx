import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { showDesktopToast } from './desktop-toasts';
import { t, uiFormatLocale } from './i18n';
import { announceStudioAssetRemoved, useStudioPanelState } from './studio-panel-bridge';
import { filterStudioAssets, groupStudioAssets } from './studio-panel-model';
import { StudioThumbnail } from './studio-media-components';
import { useStudioAssetGallery, useStudioMediaUrls, type StudioMediaJob } from './studio-media-state';
import { deleteStudioAsset } from './studio-pane-asset-actions';
import { contextMenuRowProps, ScmContextMenu, type ScmContextMenuState } from './ScmContextMenu';
import { SidebarPanelHeaderSlot, toggleHeading } from './session-sidebar-sections';
import { SessionRowStatusIcon } from './session-status-mark';
import { errorText, type MediaAsset, type MediaKind, type StudioApi } from './studio-support';

const KINDS: readonly MediaKind[] = ['image', 'video'];
/** How close to the list's end (px) the next page starts loading. */
const LOAD_AHEAD = 240;

function assetTooltip(asset: MediaAsset): string {
  const when = new Date(asset.createdAt).toLocaleString(uiFormatLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  return `${asset.prompt} · ${t(asset.kind)} · ${when}`;
}

/** The 20px rounded slot leading a row; a run in flight has no picture yet. */
function WorkThumb({ asset, src, onError }: { asset?: MediaAsset; src?: string; onError?(assetId: string): void }) {
  return (
    <span className="session-agent-avatar studio-panel-thumb" aria-hidden="true">
      {asset && (
        <StudioThumbnail
          src={src ?? ''}
          kind={asset.kind}
          eager={false}
          onLoad={() => {}}
          onError={() => onError?.(asset.id)}
        />
      )}
    </span>
  );
}

function PanelSection({
  id,
  label,
  closed,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  closed: boolean;
  onToggle(id: string): void;
  children: ReactNode;
}) {
  return (
    <section className="sidebar-recent" aria-label={label}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={!closed}
          onClick={toggleHeading(() => onToggle(id))}
        >
          <span>{label}</span>
          {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      {!closed && <nav className="session-list recent-session-list">{children}</nav>}
    </section>
  );
}

/** The Studio rail page: the runs in flight, then the works by day, one
 *  Sessions-sized row each. Nothing is fetched while it is not shown. */
export function StudioPanel({
  active,
  api = window.mixdogDesktop,
  onNewStudio,
  onOpenAsset,
}: {
  active: boolean;
  api?: StudioApi;
  onNewStudio(): void;
  /** Brings Studio forward with `asset` open. */
  onOpenAsset(asset: MediaAsset): void;
}) {
  const { assets, loadMoreAssets, refreshAssetKind, removeAsset } = useStudioAssetGallery(api, 'image');
  const { jobs, openId } = useStudioPanelState();
  const { assetUrl, markUrlBroken } = useStudioMediaUrls(api, active);
  const slot = useContext(SidebarPanelHeaderSlot);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const running = useMemo(() => jobs.filter((entry) => entry.status === 'running'), [jobs]);
  const runningKey = running.map((entry) => entry.id).join(',');
  const shownAssets = useMemo(() => filterStudioAssets(assets, searching ? query : ''), [assets, searching, query]);
  const groups = useMemo(() => groupStudioAssets(shownAssets), [shownAssets]);

  // A finished run adds a work, so the list reloads when the runs in flight change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runningKey is the trigger
  useEffect(() => {
    if (!active) return;
    Promise.all(KINDS.map((kind) => refreshAssetKind(kind))).catch((reason) =>
      showDesktopToast(errorText(reason), 'error')
    );
  }, [active, refreshAssetKind, runningKey]);

  // The next page loads as the list's end nears, like the gallery's scroll
  // paging (no IntersectionObserver: see VisualizePane's note).
  // biome-ignore lint/correctness/useExhaustiveDependencies: each loaded page re-checks
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!active || !sentinel) return undefined;
    const check = () => {
      if (sentinel.getBoundingClientRect().top > window.innerHeight + LOAD_AHEAD) return;
      Promise.all(KINDS.map((kind) => loadMoreAssets(kind))).catch((reason) =>
        showDesktopToast(errorText(reason), 'error')
      );
    };
    check();
    document.addEventListener('scroll', check, { capture: true, passive: true });
    window.addEventListener('resize', check);
    return () => {
      document.removeEventListener('scroll', check, { capture: true });
      window.removeEventListener('resize', check);
    };
  }, [active, loadMoreAssets, assets.length]);

  const toggleSection = (id: string) =>
    setClosedSections((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const deleteAsset = async (asset: MediaAsset) => {
    try {
      await deleteStudioAsset(api, asset);
      removeAsset(asset);
      announceStudioAssetRemoved(asset);
    } catch (reason) {
      showDesktopToast(errorText(reason), 'error');
    }
  };
  const openMenu = (asset: MediaAsset, point: { x: number; y: number }) =>
    setMenu({
      label: assetTooltip(asset),
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => onOpenAsset(asset) },
        {
          id: 'delete',
          label: t('Delete asset'),
          danger: true,
          separatorBefore: true,
          onSelect: () => void deleteAsset(asset),
        },
      ],
    });

  const actions = (
    <>
      <button
        type="button"
        className="session-panel-action"
        aria-label={t('Search')}
        data-tooltip={t('Search')}
        aria-pressed={searching}
        onClick={() => {
          setSearching((value) => !value);
          setQuery('');
        }}
      >
        <Search size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="session-panel-action"
        aria-label={t('New Studio')}
        data-tooltip={t('New Studio')}
        onClick={onNewStudio}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </>
  );
  const runRow = (entry: StudioMediaJob) => {
    const label = entry.request?.prompt || t('Generating');
    return (
      <div className="session-row working" key={entry.id}>
        <button type="button" className="session-row-main" aria-label={label} data-tooltip={label}>
          <WorkThumb />
          <span className="session-row-copy">
            <b>{label}</b>
          </span>
          <span className="session-row-status" data-working>
            <SessionRowStatusIcon status="running" name={label} />
          </span>
        </button>
      </div>
    );
  };
  const workRow = (asset: MediaAsset) => {
    const tooltip = assetTooltip(asset);
    const selected = openId === asset.id;
    return (
      <div
        className={`session-row${selected ? ' selected' : ''}`}
        key={asset.id}
        data-asset-id={asset.id}
        {...contextMenuRowProps((point) => openMenu(asset, point))}
      >
        <button
          type="button"
          className="session-row-main"
          aria-label={tooltip}
          aria-current={selected ? 'true' : undefined}
          aria-haspopup="menu"
          data-tooltip={tooltip}
          onClick={() => onOpenAsset(asset)}
        >
          <WorkThumb asset={asset} src={assetUrl(asset.id, 'thumb')} onError={(id) => markUrlBroken(id, 'thumb')} />
          <span className="session-row-copy">
            <b>{asset.prompt}</b>
          </span>
        </button>
      </div>
    );
  };

  return (
    <div className="studio-panel">
      {slot ? (active ? createPortal(actions, slot) : null) : actions}
      {searching && (
        <input
          className="agent-pane-search"
          type="search"
          // biome-ignore lint/a11y/noAutofocus: the search button opens this field to type into
          autoFocus
          value={query}
          placeholder={t('Search')}
          aria-label={t('Search')}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearching(false);
          }}
        />
      )}
      {running.length > 0 && (
        <PanelSection
          id="running"
          label={t('In progress')}
          closed={closedSections.has('running')}
          onToggle={toggleSection}
        >
          {running.map(runRow)}
        </PanelSection>
      )}
      {groups.map((group) => (
        <PanelSection
          key={group.id}
          id={group.id}
          label={group.label}
          closed={closedSections.has(group.id)}
          onToggle={toggleSection}
        >
          {group.assets.map(workRow)}
        </PanelSection>
      ))}
      {running.length === 0 && groups.length === 0 && (
        <p className="utility-dock-empty">
          <span>{searching && query.trim() ? t('No results') : t('No works yet.')}</span>
        </p>
      )}
      <div ref={sentinelRef} className="studio-panel-end" aria-hidden="true" />
      <ScmContextMenu state={menu} onClose={closeMenu} />
    </div>
  );
}
