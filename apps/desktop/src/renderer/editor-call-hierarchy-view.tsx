// The peek panel itself: a preview on the left, the rows of one direction on
// the right, and the keyboard grammar that moves between them. It renders what
// the hook holds and reports every intent back; no request and no state of its
// own lives here.
import Editor from '@monaco-editor/react';
import { ChevronRight, X } from 'lucide-react';
import type { Dispatch, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from 'react';
import type { EditorCallHierarchyItem } from './editor-lsp-conversion';
import type { CallHierarchyDirection, CallHierarchyState } from './editor-call-hierarchy-model';
import { MIXDOG_EDITOR_SCROLLBAR } from './editor-monaco-bootstrap';
import type { CallHierarchyPreview, readCallHierarchyLayout } from './editor-pane-model';
import { monaco, resolveThemeColor } from './monaco-setup';
import { t } from './i18n';

function hierarchyTitle(loading: boolean, direction: string, rootName: string): string {
  if (loading) return 'Loading…';
  return direction === 'incoming' ? `Callers of '${rootName}'` : `Calls from '${rootName}'`;
}

export function CallHierarchyPeek({
  state,
  selected,
  preview,
  layout,
  lightTheme,
  treeRef,
  setState,
  close,
  switchDirection,
  load,
  openItem,
  beginSplitResize,
  beginHeightResize,
}: {
  state: CallHierarchyState;
  selected: EditorCallHierarchyItem | null;
  preview: CallHierarchyPreview | null;
  layout: ReturnType<typeof readCallHierarchyLayout>;
  lightTheme: boolean;
  treeRef: RefObject<HTMLDivElement | null>;
  setState: Dispatch<SetStateAction<CallHierarchyState | null>>;
  close: () => void;
  switchDirection: (next?: CallHierarchyDirection) => void;
  load: (
    root: EditorCallHierarchyItem,
    direction: CallHierarchyDirection,
    stack: EditorCallHierarchyItem[]
  ) => Promise<void>;
  openItem: (item: EditorCallHierarchyItem) => void;
  beginSplitResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  beginHeightResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <section
      className="editor-call-hierarchy"
      role="dialog"
      aria-label={t('Call Hierarchy')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.shiftKey && event.altKey && event.key.toLocaleLowerCase() === 'h') {
          event.preventDefault();
          switchDirection();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setState((current) => {
            if (!current?.rows.length) return current;
            const offset = event.key === 'ArrowDown' ? 1 : -1;
            return {
              ...current,
              selectedIndex: (current.selectedIndex + offset + current.rows.length) % current.rows.length,
            };
          });
          return;
        }
        if (event.key === 'ArrowLeft' && state.stack.length) {
          event.preventDefault();
          const root = state.stack.at(-1);
          if (root) void load(root, state.direction, state.stack.slice(0, -1));
          return;
        }
        if (event.key === 'ArrowRight' && selected) {
          event.preventDefault();
          if (state.root) void load(selected, state.direction, [...state.stack, state.root]);
          return;
        }
        if (event.key === 'Enter' && selected) {
          event.preventDefault();
          openItem(selected);
          close();
        }
      }}
    >
      <header>
        <div className="editor-call-hierarchy-title">
          <b>{hierarchyTitle(state.loading, state.direction, state.root?.name || '')}</b>
          {state.root?.detail && <small>{state.root.detail}</small>}
        </div>
        <div className="editor-call-hierarchy-actions">
          <button
            type="button"
            disabled={!state.stack.length}
            aria-label={t('Back')}
            data-tooltip={t('Back')}
            onClick={() => {
              const root = state.stack.at(-1);
              if (root) void load(root, state.direction, state.stack.slice(0, -1));
            }}
          >
            ←
          </button>
          <button
            type="button"
            aria-label={state.direction === 'incoming' ? t('Show Outgoing Calls') : t('Show Incoming Calls')}
            data-tooltip={
              state.direction === 'incoming'
                ? t('Show Outgoing Calls (Shift+Alt+H)')
                : t('Show Incoming Calls (Shift+Alt+H)')
            }
            onClick={() => switchDirection()}
          >
            {state.direction === 'incoming' ? '⇥' : '⇤'}
          </button>
          <button type="button" aria-label={t('Close')} data-tooltip={t('Close (Escape)')} onClick={close}>
            <X size={14} />
          </button>
        </div>
      </header>
      <div
        className="editor-call-hierarchy-results"
        style={{
          gridTemplateColumns: `${layout.ratio * 100}% 4px minmax(100px, 1fr)`,
        }}
      >
        <div className="editor-call-hierarchy-preview">
          {preview?.loading && <p>{t('Loading…')}</p>}
          {preview && !preview.loading && preview.error && <p>{preview.error}</p>}
          {!preview && <p>{state.error || (state.loading ? t('Loading…') : t('No results'))}</p>}
          {preview && !preview.loading && !preview.error && (
            <Editor
              key={preview.itemKey}
              defaultValue={preview.content}
              defaultLanguage={preview.languageId}
              theme={lightTheme ? 'mixdog-light' : 'mixdog-dark'}
              options={{
                readOnly: true,
                domReadOnly: true,
                fontSize: 13,
                lineHeight: 20,
                fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
                minimap: { enabled: false },
                scrollbar: MIXDOG_EDITOR_SCROLLBAR,
                scrollBeyondLastLine: false,
                overviewRulerLanes: 2,
                fixedOverflowWidgets: true,
                automaticLayout: true,
                lineNumbersMinChars: 3,
                folding: false,
                glyphMargin: false,
              }}
              onMount={(peekEditor) => {
                peekEditor.setPosition({
                  lineNumber: preview.line,
                  column: preview.ranges[0]?.startColumn ?? 1,
                });
                if (preview.ranges.length) {
                  peekEditor.revealRangeInCenter(preview.ranges[0]);
                  peekEditor.createDecorationsCollection(
                    preview.ranges.map((range) => ({
                      range,
                      options: {
                        className: 'editor-call-hierarchy-match',
                        overviewRuler: {
                          color: resolveThemeColor('--mx-focus', '#0078d4'),
                          position: monaco.editor.OverviewRulerLane.Center,
                        },
                      },
                    }))
                  );
                } else {
                  peekEditor.revealLineInCenter(preview.line);
                }
                peekEditor.addCommand(monaco.KeyCode.Escape, close);
                peekEditor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyH, () =>
                  switchDirection()
                );
                peekEditor.onMouseDown((event) => {
                  if (event.event.detail !== 2 || !selected) return;
                  openItem(selected);
                  close();
                });
              }}
            />
          )}
        </div>
        <div
          className="editor-call-hierarchy-sash"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={beginSplitResize}
        />
        <div
          ref={treeRef}
          className="editor-call-hierarchy-tree"
          role="tree"
          aria-label={state.direction === 'incoming' ? t('Incoming Calls') : t('Outgoing Calls')}
          tabIndex={0}
        >
          {state.loading && <p>{t('Loading…')}</p>}
          {!state.loading && state.error && <p>{state.error}</p>}
          {!state.loading && !state.error && !state.rows.length && (
            <p>
              {state.direction === 'incoming'
                ? t("No callers of '{{name}}'", { name: state.root?.name || '' })
                : t("No calls from '{{name}}'", { name: state.root?.name || '' })}
            </p>
          )}
          {state.rows.map((item, index) => (
            <div
              key={item.key}
              role="treeitem"
              aria-selected={index === state.selectedIndex}
              className={index === state.selectedIndex ? 'selected' : ''}
            >
              <button
                type="button"
                className="editor-call-hierarchy-row"
                onMouseEnter={() => setState((current) => (current ? { ...current, selectedIndex: index } : current))}
                onClick={() => setState((current) => (current ? { ...current, selectedIndex: index } : current))}
                onDoubleClick={() => {
                  openItem(item);
                  close();
                }}
              >
                <span>
                  <b>{item.name}</b>
                  {item.detail && <small>{item.detail}</small>}
                </span>
              </button>
              <button
                type="button"
                className="editor-call-hierarchy-expand"
                aria-label={`Show ${state.direction} calls for ${item.name}`}
                onClick={() => state.root && void load(item, state.direction, [...state.stack, state.root])}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div
        className="editor-call-hierarchy-height-sash"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={beginHeightResize}
      />
    </section>
  );
}
