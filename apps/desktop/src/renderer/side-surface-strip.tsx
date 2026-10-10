import { ExternalLink, FileText as FileIcon, FolderOpen, PanelTop, Save, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { sideFileKey, type PaneSideDockFile } from './side-file-tabs';
import { DockHeaderRow, type DockAction } from './pane-dock-chrome';
import './tab-strip.css';

/** What the side-dock file editor reports upward so the dock can draw the
 *  actions in its own strip instead of the editor's breadcrumb row. */
export interface SideFileChrome {
  /** False for previews, binaries and read-only files: no Save / Problems. */
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  /** Markdown / SVG / table files: the Preview (or Table) ⇄ Source switch. */
  viewToggle?: { value: 'rendered' | 'source'; renderedLabel: string; onChange(next: 'rendered' | 'source'): void };
  /** Rendered CSV/TSV table: body rows × columns, shown on the footer's right. */
  tableSize?: { rows: number; columns: number };
  save(): void;
  /** Host-only (undefined on a remote surface, which offers `copyPath`). */
  reveal?(): void;
  copyPath?(): void;
  /** Previews and binaries: hand the file to the OS default app. */
  openDefault?(): void;
  /** Editor readout that used to live in the footer: problem counts (a ⋯ item
   *  that toggles the Problems split), cursor and language (⋯ menu),
   *  and the document formatter when the language server offers one. */
  problems?: { errors: number; warnings: number; onToggle(): void };
  /** `short` is the compact "12:1"; `label` the full tooltip. */
  cursor?: { label: string; short: string; onGoto(): void };
  language?: string;
  format?(): void;
}

/** The ONE strip every side-dock surface shows under the dock header: the
 *  shared browser/terminal tab toolbar with the surface's subject as its
 *  single active chip, optional leading control, and actions at the right. */
export function SideChipStrip({
  label,
  name,
  title,
  icon: Glyph = FileIcon,
  leading,
  children,
}: {
  label: string;
  name: string;
  title: string;
  icon?: typeof FileIcon;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="browser-tab-toolbar" data-side-dock-strip="">
      {leading}
      <div className="browser-tab-list" role="tablist" aria-label={label}>
        <div className="browser-tab is-active">
          <button type="button" role="tab" aria-selected="true" className="browser-tab-select" title={title}>
            <Glyph size={14} aria-hidden="true" />
            <span>{name}</span>
          </button>
        </div>
      </div>
      <span className="browser-tab-trailing side-file-strip-actions">{children}</span>
    </div>
  );
}

/** File dock actions. Only Save (while dirty) is a header button; the rest are
 *  real actions in ⋯ (reveal, open in main tab, format…). Status (problems,
 *  cursor, language, view toggle) lives in the second row, not here. */
export function sideFileActions(
  chrome: SideFileChrome | null,
  onOpenInMain: () => void,
  onKeepOpen?: () => void
): DockAction[] {
  const actions: DockAction[] = [];
  if (onKeepOpen) actions.push({ id: 'keep-open', label: t('Keep Open'), onSelect: onKeepOpen });
  if (chrome?.editable && chrome.dirty) {
    actions.push({
      id: 'save',
      label: t('Save'),
      icon: Save,
      inline: true,
      onSelect: chrome.save,
      disabled: chrome.saving,
    });
  }
  if (chrome?.openDefault) {
    actions.push({
      id: 'open-default',
      label: t('Open in default app'),
      icon: ExternalLink,
      onSelect: chrome.openDefault,
    });
  }
  if (chrome?.reveal) {
    actions.push({ id: 'reveal', label: t('Reveal in Explorer'), icon: FolderOpen, onSelect: chrome.reveal });
  } else if (chrome?.copyPath) {
    actions.push({ id: 'copy-path', label: t('Copy path'), icon: FolderOpen, onSelect: chrome.copyPath });
  }
  actions.push({ id: 'open-main', label: t('Open in main tab'), icon: PanelTop, onSelect: onOpenInMain });
  if (chrome?.format) {
    actions.push({ id: 'format', label: t('Format Document'), onSelect: chrome.format });
  }
  return actions;
}

/** Right-click menu of one file tab, portalled at the pointer. */
function SideFileTabMenu({
  x,
  y,
  preview,
  onKeepOpen,
  onCloseTab,
  onDismiss,
}: {
  x: number;
  y: number;
  preview: boolean;
  onKeepOpen(): void;
  onCloseTab(): void;
  onDismiss(): void;
}) {
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onDismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown);
    };
  }, [onDismiss]);
  const choose = (run: () => void) => () => {
    onDismiss();
    run();
  };
  return createPortal(
    <div ref={menu} className="dock-header-menu" role="menu" aria-label={t('File tab')} style={{ left: x, top: y }}>
      {preview && (
        <button type="button" role="menuitem" onClick={choose(onKeepOpen)}>
          <span className="dock-header-menu-glyph" />
          <span>{t('Keep Open')}</span>
        </button>
      )}
      <button type="button" role="menuitem" onClick={choose(onCloseTab)}>
        <span className="dock-header-menu-glyph" />
        <span>{t('Close tab')}</span>
      </button>
    </div>,
    document.body
  );
}

/** The side-dock file header: ONE row — the file tabs (monochrome icon + name,
 *  path tooltip; the preview tab in italics) on the left, the active file's
 *  actions and the pane close at the right. */
export function SideFileStrip({
  files,
  activeKey,
  chrome,
  onSelect,
  onCloseTab,
  onKeep,
  onOpenInMain,
  onClose,
}: {
  files: readonly PaneSideDockFile[];
  activeKey: string | null;
  chrome: SideFileChrome | null;
  onSelect(fileKey: string): void;
  onCloseTab(fileKey: string): void;
  onKeep(fileKey: string): void;
  onOpenInMain(): void;
  onClose(): void;
}) {
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const dismissMenu = useCallback(() => setMenu(null), []);
  const activePreview = files.find((file) => file.preview && sideFileKey(file) === activeKey);
  const menuFile = menu ? files.find((file) => sideFileKey(file) === menu.key) : undefined;
  return (
    <>
      <DockHeaderRow
        className="side-file-header"
        left={
          <div className="browser-tab-list" role="tablist" aria-label={t('Files')}>
            {files.map((file) => {
              const key = sideFileKey(file);
              const active = key === activeKey;
              const name = file.rel.split('/').at(-1) ?? file.rel;
              const tabClass = `browser-tab dock-header-chip${active ? ' is-active' : ''}${file.preview ? ' is-preview' : ''}`;
              return (
                <div
                  key={key}
                  className={tabClass}
                  data-preview={file.preview ? 'true' : undefined}
                  onDoubleClick={file.preview ? () => onKeep(key) : undefined}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ key, x: event.clientX, y: event.clientY });
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="browser-tab-select"
                    title={file.preview ? `${file.rel}\n${t('Preview tab — the next link replaces it')}` : file.rel}
                    onClick={() => onSelect(key)}
                  >
                    <FileIcon size={15} aria-hidden="true" />
                    <span>{name}</span>
                  </button>
                  <button
                    type="button"
                    className="browser-tab-close"
                    aria-label={`${t('Close tab')}: ${name}`}
                    onClick={() => onCloseTab(key)}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        }
        actions={sideFileActions(
          chrome,
          onOpenInMain,
          activePreview && activeKey ? () => onKeep(activeKey) : undefined
        )}
        onClose={onClose}
      />
      {menu && menuFile && (
        <SideFileTabMenu
          x={menu.x}
          y={menu.y}
          preview={menuFile.preview === true}
          onKeepOpen={() => onKeep(menu.key)}
          onCloseTab={() => onCloseTab(menu.key)}
          onDismiss={dismissMenu}
        />
      )}
    </>
  );
}
