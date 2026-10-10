// Presentational pieces of the editor breadcrumb row: the path/symbol trail and
// the file/symbol picker popup. EditorBreadcrumbs owns their state.
import { Braces, ChevronLeft, ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import React, { type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { EditorOutlineItem } from './editor-language-store';
import type { BreadcrumbFileItem, BreadcrumbPickerState } from './editor-pane-model';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';

export function BreadcrumbTrail({
  segments,
  symbols,
  picker,
  focusIndex,
  accessToken,
  buttonRefs,
  onFocusItem,
  onOpenPath,
  onOpenSymbol,
}: {
  segments: string[];
  symbols: EditorOutlineItem[];
  picker: BreadcrumbPickerState | null;
  focusIndex: number;
  accessToken?: string;
  buttonRefs: RefObject<Array<HTMLButtonElement | null>>;
  onFocusItem(index: number): void;
  onOpenPath(event: MouseEvent<HTMLButtonElement>, index: number): void;
  onOpenSymbol(event: MouseEvent<HTMLButtonElement>, sourceIndex: number, selected: EditorOutlineItem): void;
}) {
  return (
    <span className="editor-breadcrumb-path">
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a path can repeat a segment name ("a/a"), so the index keeps the key unique.
        <React.Fragment key={`${index}:${segment}`}>
          {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
          <button
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            className={`editor-breadcrumb-item${index === segments.length - 1 ? ' editor-breadcrumb-current' : ''}`}
            title={segments.slice(0, index + 1).join('/')}
            aria-haspopup={accessToken ? undefined : 'tree'}
            aria-expanded={picker?.kind === 'files' && picker.anchor.sourceIndex === index}
            disabled={Boolean(accessToken)}
            tabIndex={focusIndex === index ? 0 : -1}
            onFocus={() => onFocusItem(index)}
            onClick={(event) => onOpenPath(event, index)}
          >
            {index === segments.length - 1 ? (
              <FileIcon size={14} aria-hidden="true" />
            ) : (
              <Folder size={14} aria-hidden="true" />
            )}
            <span>{segment}</span>
          </button>
        </React.Fragment>
      ))}
      {symbols.map((item, symbolIndex) => {
        const index = segments.length + symbolIndex;
        return (
          <React.Fragment key={item.key}>
            <ChevronRight size={14} aria-hidden="true" />
            <button
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              className="editor-breadcrumb-item editor-breadcrumb-symbol"
              title={item.detail || item.name}
              aria-haspopup="tree"
              aria-expanded={picker?.kind === 'symbols' && picker.anchor.sourceIndex === index}
              tabIndex={focusIndex === index ? 0 : -1}
              onFocus={() => onFocusItem(index)}
              onClick={(event) => onOpenSymbol(event, index, item)}
            >
              <Braces size={14} aria-hidden="true" />
              <span>{item.name}</span>
            </button>
          </React.Fragment>
        );
      })}
    </span>
  );
}

export function BreadcrumbPicker({
  picker,
  projectPath,
  pickerRef,
  rowRefs,
  onKeyDown,
  onParentFolder,
  onActivateRow,
  onPickFile,
  onPickSymbol,
}: {
  picker: BreadcrumbPickerState;
  projectPath: string;
  pickerRef: RefObject<HTMLDivElement | null>;
  rowRefs: RefObject<Array<HTMLButtonElement | null>>;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onParentFolder(): void;
  onActivateRow(index: number): void;
  onPickFile(item: BreadcrumbFileItem): void;
  onPickSymbol(item: EditorOutlineItem): void;
}) {
  return createPortal(
    <div
      ref={pickerRef}
      className="editor-breadcrumb-picker"
      role="dialog"
      aria-label={picker.kind === 'files' ? t('File Breadcrumbs') : t('Symbol Breadcrumbs')}
      style={{
        left: picker.anchor.x,
        top: picker.anchor.y,
        width: picker.anchor.width,
        maxHeight: picker.anchor.maxHeight,
      }}
      onKeyDown={onKeyDown}
    >
      {picker.kind === 'files' && (
        <div className="editor-breadcrumb-picker-header">
          <button type="button" aria-label={t('Parent Folder')} disabled={!picker.directory} onClick={onParentFolder}>
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span title={picker.directory || projectPath}>{picker.directory || projectPath}</span>
        </div>
      )}
      <div className="editor-breadcrumb-picker-tree" role="tree">
        {picker.kind === 'files' && picker.loading && (
          <p>
            <ProgressSpinner size={14} className="editor-pane-spinner" /> {t('Loading…')}
          </p>
        )}
        {picker.kind === 'files' && !picker.loading && picker.error && <p>{picker.error}</p>}
        {picker.kind === 'files' && !picker.loading && !picker.error && !picker.rows.length && (
          <p>{t('No files found.')}</p>
        )}
        {picker.kind === 'symbols' && !picker.rows.length && <p>{t('No symbols found.')}</p>}
        {picker.rows.map((item, index) => {
          const fileItem = picker.kind === 'files' ? (item as BreadcrumbFileItem) : null;
          const symbolItem = picker.kind === 'symbols' ? (item as EditorOutlineItem) : null;
          const selected = index === picker.activeIndex;
          let RowGlyph = Braces;
          if (fileItem) RowGlyph = fileItem.dir ? Folder : FileIcon;
          return (
            <button
              key={fileItem?.relPath || symbolItem?.key || index}
              ref={(node) => {
                rowRefs.current[index] = node;
              }}
              type="button"
              role="treeitem"
              aria-selected={selected}
              className={selected ? 'selected' : ''}
              style={symbolItem ? { paddingLeft: `${8 + symbolItem.level * 14}px` } : undefined}
              onFocus={() => onActivateRow(index)}
              onMouseEnter={() => onActivateRow(index)}
              onClick={() => {
                if (fileItem) {
                  onPickFile(fileItem);
                  return;
                }
                if (!symbolItem) return;
                onPickSymbol(symbolItem);
              }}
            >
              <RowGlyph size={14} aria-hidden="true" />
              <span>{fileItem?.name || symbolItem?.name}</span>
              {symbolItem?.detail && <small>{symbolItem.detail}</small>}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
