import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { EditorContent, ReactNodeViewRenderer, useEditor, type UseEditorOptions } from '@tiptap/react';
import type { Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Placeholder } from '@tiptap/extensions';
import { t } from '../i18n';
import type { RichMarkdownPromptKind } from './rich-markdown-commands';
import { RichMarkdownDocumentContext } from './rich-markdown-context';
import { linkRangeAt, PROGRAMMATIC } from './rich-markdown-document';
import { createRichMarkdownExtensions } from './rich-markdown-extensions';
import { headingForAnchor, readHeadings } from '../editor-markdown-outline';
import { openWebLinkInSystemBrowser } from '../MarkdownLink';
import { richMarkdownLinkTarget } from './rich-markdown-links';
import type { RichMarkdownModelSync } from './rich-markdown-model-sync';
import { pasteRichMarkdown } from './rich-markdown-paste';
import { applyRichMarkdownPrompt, type PromptState, richMarkdownPromptFor } from './rich-markdown-prompt-state';
import { RichMarkdownSearch } from './rich-markdown-search';
import { type MenuState, suggestMenuFor } from './rich-markdown-suggest';
import { RichMarkdownCodeBlock, RichMarkdownImage } from './RichMarkdownNodeViews';
import {
  RichMarkdownFrontMatter,
  RichMarkdownLinkBubble,
  RichMarkdownPrompt,
  RichMarkdownSearchBar,
  RichMarkdownSuggestMenu,
  type OverlayPoint,
  type PromptValues,
  type SuggestItem,
} from './RichMarkdownOverlays';
import { RichMarkdownToolbar } from './RichMarkdownToolbar';
import { useRichMarkdownHistory } from './use-rich-markdown-history';
import { useRichMarkdownModelSync } from './use-rich-markdown-model-sync';
import { useRichMarkdownSearch } from './use-rich-markdown-search';
import './rich-markdown.css';

export interface RichMarkdownEditorProps {
  modelRef: RefObject<MonacoEditor.ITextModel | null>;
  text: string;
  projectPath: string;
  relPath: string;
  readOnly: boolean;
  active: boolean;
  onSave(): void;
  onOpenFile?(project: string, rel: string, line?: number): void;
  onUnsupported(reason: string): void;
  /** Whether the editor holds an edit the file does not have yet: the host
   *  keeps Rich in view until it is written or explicitly discarded. While
   *  held, `heldText` reads the whole file as it would be with the edit
   *  (best effort, for crash-recovery backups; it stays readable after
   *  unmount). Unmounting with a held edit reports nothing: the edit is
   *  not discarded, and the backup keeps it. */
  onHeldChange?(held: boolean, heldText?: () => string | null): void;
}

const HOVER_HIDE_MS = 250;

interface LinkBubbleState {
  href: string;
  from: number;
  to: number;
  point: OverlayPoint;
  /** Shown for the caret (stays while it is inside) or for the pointer. */
  source: 'caret' | 'hover';
}

/** WYSIWYG Markdown editing over a Monaco model (the single source of truth). */
export default function RichMarkdownEditor(props: RichMarkdownEditorProps) {
  const { modelRef, text, projectPath, relPath, readOnly, active } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<RichMarkdownModelSync | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null);

  // ProseMirror keeps the handlers it was created with; they read the
  // current render's values through this ref.
  const live = useRef<ReturnType<typeof liveHandlers>>(null!);

  const [options] = useState<UseEditorOptions>(() => ({
    extensions: createRichMarkdownExtensions({
      nodeViews: {
        codeBlock: ReactNodeViewRenderer(RichMarkdownCodeBlock),
        image: ReactNodeViewRenderer(RichMarkdownImage),
      },
      onMathClick: (kind, latex, pos) => live.current.editMath(kind, latex, pos),
      extra: [
        RichMarkdownSearch,
        Placeholder.configure({ placeholder: t('Write, or type / for blocks and : for emoji') }),
      ],
    }),
    editable: !readOnly,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'rich-markdown-content', 'aria-label': t('Rich Markdown editor'), spellcheck: 'true' },
      handleKeyDown: (_view, event) => live.current.keyDown(event),
      handleClick: (view, pos, event) => live.current.click(view, pos, event),
      handlePaste: (_view, event) => live.current.paste(event),
      handleDOMEvents: {
        mouseover: (view, event) => live.current.hover(view, event),
        mouseout: (_view, event) => live.current.unhover(event),
        beforeinput: (_view, event) => live.current.beforeInput(event),
      },
    },
    onUpdate: ({ transaction }) => live.current.update(transaction),
    onTransaction: ({ transaction }) => live.current.transaction(transaction),
    onBlur: () => syncRef.current?.endUndoStep(),
  }));
  const editor = useEditor(options, []);
  const { historyRef, history, refreshHistory, runHistory, discardHeld } = useRichMarkdownHistory(editor, syncRef);
  const { search, applySearch, openSearch, closeSearch, followEdit } = useRichMarkdownSearch(editor, canvasRef);

  const pointAt = (pos: number): OverlayPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { top: 0, left: 0 };
    const coords = editor.view.coordsAtPos(pos);
    const box = canvas.getBoundingClientRect();
    return { top: coords.bottom - box.top + 4, left: Math.max(0, coords.left - box.left) };
  };

  const scrollToAnchor = (slug: string) => {
    // The outline's own ids: repeated headings get collision-free suffixes.
    const heading = headingForAnchor(readHeadings(editor.view.dom, false), slug)?.element;
    if (!heading) return;
    heading.scrollIntoView({ block: 'start' });
    const pos = editor.view.posAtDOM(heading, 0);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos))));
  };

  const openLink = (href: string) => {
    const target = richMarkdownLinkTarget(href, projectPath, relPath);
    if (target.kind === 'anchor') scrollToAnchor(target.slug);
    else if (target.kind === 'web') openWebLinkInSystemBrowser(undefined, target.url);
    else if (target.kind === 'file') props.onOpenFile?.(projectPath, target.rel, target.line);
  };

  const closeMenu = () => setMenu(null);

  const openPrompt = (kind: RichMarkdownPromptKind, edit?: { latex: string; pos: number }) => {
    setLinkBubble(null);
    closeMenu();
    setPrompt(richMarkdownPromptFor(editor.state, kind, edit, pointAt));
  };

  const submitPrompt = (current: PromptState, values: PromptValues) => {
    setPrompt(null);
    applyRichMarkdownPrompt(editor, current, values);
  };

  const pickSuggestion = (current: MenuState, item: SuggestItem) => {
    closeMenu();
    const range = { from: current.from, to: current.to };
    if (item.kind === 'emoji') {
      editor.chain().focus().insertContentAt(range, item.emoji).run();
      return;
    }
    editor.chain().focus().deleteRange(range).run();
    item.command.run(editor, (kind) => openPrompt(kind));
  };

  function liveHandlers() {
    return {
      refreshHistory,
      reportUnsupported: (reason: string) => props.onUnsupported(reason),
      reportHeld: (isHeld: boolean, heldText?: () => string | null) => props.onHeldChange?.(isHeld, heldText),
      editMath: (kind: 'inlineMath' | 'blockMath', latex: string, pos: number) => {
        if (editor.isEditable) openPrompt(kind, { latex, pos });
      },
      keyDown(event: KeyboardEvent): boolean {
        if (menu) {
          const count = menu.items.length;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (count)
              setMenu({ ...menu, selected: (menu.selected + (event.key === 'ArrowDown' ? 1 : count - 1)) % count });
            return true;
          }
          if ((event.key === 'Enter' || event.key === 'Tab') && count) {
            pickSuggestion(menu, menu.items[menu.selected]);
            return true;
          }
          if (event.key === 'Escape') {
            closeMenu();
            return true;
          }
        }
        const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
        const key = event.key.toLowerCase();
        if (mod && key === 'k' && editor.isEditable) {
          openPrompt('link');
          return true;
        }
        if (mod && (key === 'z' || key === 'y')) {
          runHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
          return true;
        }
        return false;
      },
      beforeInput(event: InputEvent): boolean {
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
        event.preventDefault();
        runHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo');
        return true;
      },
      click(view: EditorView, pos: number, event: MouseEvent): boolean {
        if (view.editable && !(event.ctrlKey || event.metaKey)) return false;
        const link = linkRangeAt(view.state, pos);
        if (!link) return false;
        event.preventDefault();
        openLink(link.href);
        return true;
      },
      paste(event: ClipboardEvent): boolean {
        return pasteRichMarkdown(editor, event);
      },
      hover(view: EditorView, event: MouseEvent): boolean {
        const anchor = (event.target as Element | null)?.closest?.('a[href]');
        if (!anchor || !view.dom.contains(anchor)) return false;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        const link = linkRangeAt(view.state, view.posAtDOM(anchor, 0));
        if (link && !prompt) setLinkBubble({ ...link, point: pointAt(link.from), source: 'hover' });
        return false;
      },
      unhover(event: MouseEvent): boolean {
        if (!(event.target as Element | null)?.closest?.('a[href]')) return false;
        this.scheduleBubbleHide();
        return false;
      },
      scheduleBubbleHide() {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => {
          setLinkBubble((current) => (current?.source === 'hover' ? null : current));
        }, HOVER_HIDE_MS);
      },
      // Every edit reaches the model at once: nothing waits in the editor for
      // a change made elsewhere to overwrite, and the dirty state is current.
      update(transaction: Transaction) {
        if (!transaction.docChanged || transaction.getMeta(PROGRAMMATIC) || unsupported) return;
        syncRef.current?.commit(editor.state.doc);
        refreshHistory();
      },
      transaction(transaction: Transaction) {
        const { state } = editor;
        if (transaction.docChanged) followEdit();
        if (!editor.isEditable || transaction.getMeta(PROGRAMMATIC)) {
          if (menu) closeMenu();
        } else if (transaction.docChanged || menu) {
          const next = suggestMenuFor(state, menu, pointAt);
          if (next) setMenu(next);
          else if (menu) closeMenu();
        }
        if (transaction.selectionSet || transaction.docChanged) {
          const link = state.selection.empty ? linkRangeAt(state, state.selection.from) : null;
          if (link && !prompt && editor.isFocused)
            setLinkBubble({ ...link, point: pointAt(link.from), source: 'caret' });
          else setLinkBubble((current) => (current?.source === 'caret' ? null : current));
        }
      },
    };
  }
  live.current = liveHandlers();

  const { held, frontMatter, unsupported } = useRichMarkdownModelSync({
    editor,
    model: modelRef.current,
    text,
    syncRef,
    historyRef,
    live,
  });

  useEffect(() => {
    if (active) syncRef.current?.refresh();
    else {
      syncRef.current?.flush();
      setMenu(null);
      setPrompt(null);
      setLinkBubble(null);
    }
  }, [active]);

  useEffect(() => {
    editor.setEditable(!readOnly, false);
    if (readOnly) {
      setMenu(null);
      setPrompt(null);
    }
  }, [editor, readOnly]);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    []
  );

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && !event.altKey && !event.shiftKey && key === 's') {
      event.preventDefault();
      event.stopPropagation();
      // A held edit is not in the file: saving now would save without it.
      // The notice stays up with the choice to discard it.
      // flush() is undefined without a sync; only an explicit false holds the save.
      if (syncRef.current?.flush() === false) return;
      props.onSave();
    } else if (mod && !event.altKey && !event.shiftKey && key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    } else if (event.key === 'Escape' && search) {
      event.preventDefault();
      closeSearch();
    }
  };

  if (unsupported) return <div className="rich-markdown rich-markdown-unsupported" />;

  return (
    <RichMarkdownDocumentContext.Provider value={{ projectPath, relPath, readOnly }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: handles shortcuts bubbling from the editor and toolbar inside; the root itself is not interactive */}
      <div className="rich-markdown" data-readonly={readOnly || undefined} onKeyDown={onRootKeyDown}>
        <RichMarkdownToolbar
          editor={editor}
          readOnly={readOnly}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={() => {
            runHistory('undo');
            editor.commands.focus();
          }}
          onRedo={() => {
            runHistory('redo');
            editor.commands.focus();
          }}
          onPrompt={(kind) => openPrompt(kind)}
          onSearch={openSearch}
        />
        {held !== null ? (
          <div className="rich-markdown-held" role="alert">
            <span>{held}</span>
            <button type="button" onClick={discardHeld}>
              {t('Discard edit')}
            </button>
          </div>
        ) : null}
        {search ? (
          <RichMarkdownSearchBar
            query={search.query}
            caseSensitive={search.caseSensitive}
            active={search.active}
            count={search.count}
            onQuery={(query) => applySearch({ query, caseSensitive: search.caseSensitive, active: 0 }, true)}
            onCaseSensitive={(caseSensitive) => applySearch({ query: search.query, caseSensitive, active: 0 }, true)}
            onStep={(delta) =>
              search.count &&
              applySearch(
                {
                  query: search.query,
                  caseSensitive: search.caseSensitive,
                  active: (search.active + delta + search.count) % search.count,
                },
                true
              )
            }
            onClose={closeSearch}
          />
        ) : null}
        <div className="rich-markdown-scroll editor-text-view editor-markdown-preview markdown">
          {frontMatter ? <RichMarkdownFrontMatter frontMatter={frontMatter} /> : null}
          <div ref={canvasRef} className="rich-markdown-canvas">
            <EditorContent editor={editor} />
            {menu ? (
              <RichMarkdownSuggestMenu
                items={menu.items}
                selected={menu.selected}
                point={menu.point}
                onPick={(item) => pickSuggestion(menu, item)}
                onHover={(selected) => setMenu({ ...menu, selected })}
              />
            ) : null}
            {prompt ? (
              <RichMarkdownPrompt
                key={`${prompt.kind}:${prompt.from}:${prompt.nodePos ?? ''}`}
                kind={prompt.kind}
                initial={prompt.initial}
                withText={prompt.withText}
                point={prompt.point}
                onSubmit={(values) => submitPrompt(prompt, values)}
                onCancel={() => {
                  setPrompt(null);
                  editor.commands.focus();
                }}
              />
            ) : null}
            {linkBubble && !prompt ? (
              <RichMarkdownLinkBubble
                href={linkBubble.href}
                point={linkBubble.point}
                readOnly={readOnly}
                onOpen={() => openLink(linkBubble.href)}
                onEdit={() => {
                  editor.chain().focus().setTextSelection({ from: linkBubble.from, to: linkBubble.to }).run();
                  openPrompt('link');
                }}
                onRemove={() => {
                  setLinkBubble(null);
                  editor
                    .chain()
                    .focus()
                    .setTextSelection({ from: linkBubble.from, to: linkBubble.to })
                    .unsetLink()
                    .run();
                }}
                onPointerEnter={() => hoverTimer.current && clearTimeout(hoverTimer.current)}
                onPointerLeave={() => live.current.scheduleBubbleHide()}
              />
            ) : null}
          </div>
        </div>
      </div>
    </RichMarkdownDocumentContext.Provider>
  );
}
