import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor, type UseEditorOptions } from '@tiptap/react';
import { getMarkRange, type JSONContent } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Placeholder } from '@tiptap/extensions';
import { t } from '../i18n';
import {
  filterBlockCommands,
  filterEmoji,
  looksLikeMarkdown,
  type RichMarkdownPromptKind,
} from './rich-markdown-commands';
import { checkRichMarkdownRoundTrip, richMarkdownCodecFor } from './rich-markdown-codec';
import { richMarkdownBodySupport } from './rich-markdown-support';
import { RichMarkdownDocumentContext } from './rich-markdown-context';
import { createRichMarkdownExtensions } from './rich-markdown-extensions';
import { headingForAnchor, readHeadings } from '../editor-markdown-outline';
import { openWebLinkInSystemBrowser } from '../MarkdownLink';
import { richMarkdownLinkTarget } from './rich-markdown-links';
import { RichMarkdownModelSync } from './rich-markdown-model-sync';
import { RichMarkdownSearch, richMarkdownSearchKey, richMarkdownSearchState } from './rich-markdown-search';
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

/** Meta on transactions that load content: they are not user edits. */
const PROGRAMMATIC = 'richMarkdownProgrammatic';
const HOVER_HIDE_MS = 250;

interface MenuState {
  kind: 'slash' | 'emoji';
  from: number;
  to: number;
  items: SuggestItem[];
  selected: number;
  point: OverlayPoint;
}

interface PromptState {
  kind: RichMarkdownPromptKind;
  initial: PromptValues;
  withText: boolean;
  from: number;
  to: number;
  /** Position of the math node being edited. */
  nodePos?: number;
  point: OverlayPoint;
}

interface LinkBubbleState {
  href: string;
  from: number;
  to: number;
  point: OverlayPoint;
  /** Shown for the caret (stays while it is inside) or for the pointer. */
  source: 'caret' | 'hover';
}

interface SearchUiState {
  query: string;
  caseSensitive: boolean;
  active: number;
  count: number;
}

function linkRangeAt(state: EditorState, pos: number): { href: string; from: number; to: number } | null {
  const type = state.schema.marks.link;
  if (!type || pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  const mark = [...$pos.marks(), ...(state.doc.nodeAt(pos)?.marks ?? [])].find((candidate) => candidate.type === type);
  if (!mark) return null;
  const range = getMarkRange($pos, type, mark.attrs) ?? getMarkRange(state.doc.resolve(pos + 1), type, mark.attrs);
  return range ? { href: String(mark.attrs.href ?? ''), ...range } : null;
}

/** The `/query` or `:query` the caret is typing, if any. */
function typedTrigger(state: EditorState): { kind: 'slash' | 'emoji'; query: string; from: number; to: number } | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;
  const { $from } = selection;
  if ($from.parent.type.spec.code || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 48),
    $from.parentOffset,
    undefined,
    '\ufffc'
  );
  const slash = /(?:^|\s)\/([\p{L}\p{N}-]{0,24})$/u.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], from: $from.pos - slash[1].length - 1, to: $from.pos };
  const emoji = /(?:^|\s):([a-z0-9_+-]{2,32})$/.exec(before);
  if (emoji) return { kind: 'emoji', query: emoji[1], from: $from.pos - emoji[1].length - 1, to: $from.pos };
  return null;
}

/** Loads a document without it counting as an edit. Only the part that
 *  differs is replaced, so the caret stays put across a change made
 *  elsewhere; after an undo or redo (`toChange`) it moves to the end of the
 *  changed part, where the undone or redone edit was. */
function replaceDocument(editor: Editor, json: JSONContent, initial: boolean, toChange = false) {
  const doc = editor.schema.nodeFromJSON(json);
  const { state } = editor;
  const tr = state.tr.setMeta(PROGRAMMATIC, true);
  const start = state.doc.content.findDiffStart(doc.content);
  if (start !== null) {
    let { a: endA, b: endB } = state.doc.content.findDiffEnd(doc.content)!;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    tr.replace(start, endA, doc.slice(start, endB));
    if (!tr.doc.eq(doc)) tr.replaceWith(0, tr.doc.content.size, doc.content);
    if (toChange)
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(endB, tr.doc.content.size)), -1)).scrollIntoView();
  }
  if (initial) tr.setSelection(TextSelection.atStart(tr.doc));
  if (tr.docChanged || initial) editor.view.dispatch(tr);
}

/** WYSIWYG Markdown editing over a Monaco model (the single source of truth). */
export default function RichMarkdownEditor(props: RichMarkdownEditorProps) {
  const { modelRef, text, projectPath, relPath, readOnly, active } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<RichMarkdownModelSync | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  /** Set while an undo or redo reloads the editor from the model. */
  const historyRef = useRef(false);
  const [held, setHeld] = useState<string | null>(null);
  const [frontMatter, setFrontMatter] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null);
  const [search, setSearch] = useState<SearchUiState | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

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

  const refreshHistory = () => {
    const sync = syncRef.current;
    const canUndo = Boolean(sync?.canUndo());
    const canRedo = Boolean(sync?.canRedo());
    setHistory((current) =>
      current.canUndo === canUndo && current.canRedo === canRedo ? current : { canUndo, canRedo }
    );
  };

  /** Undo and redo run on the model's history, shared with Source mode. */
  const runHistory = (direction: 'undo' | 'redo') => {
    const sync = syncRef.current;
    if (!sync || !editor.isEditable) return;
    historyRef.current = true;
    try {
      sync[direction]();
    } finally {
      historyRef.current = false;
    }
    refreshHistory();
  };

  /** Drops the held edit (the user's explicit choice) and shows the file. */
  const discardHeld = () => {
    historyRef.current = true;
    try {
      syncRef.current?.discard();
    } finally {
      historyRef.current = false;
    }
    refreshHistory();
    editor.commands.focus();
  };

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
    const { state } = editor;
    const { from, to } = state.selection;
    setLinkBubble(null);
    closeMenu();
    if (kind === 'link') {
      const link = linkRangeAt(state, from);
      const range = link ?? { from, to };
      setPrompt({
        kind,
        initial: { value: link?.href ?? '', text: '' },
        withText: range.from === range.to,
        ...range,
        point: pointAt(range.from),
      });
      return;
    }
    if (edit) {
      setPrompt({
        kind,
        initial: { value: edit.latex, text: '' },
        withText: false,
        from,
        to,
        nodePos: edit.pos,
        point: pointAt(edit.pos),
      });
      return;
    }
    const selected = kind === 'image' ? '' : state.doc.textBetween(from, to, ' ');
    setPrompt({
      kind,
      initial: { value: selected, text: '' },
      withText: kind === 'image',
      from,
      to,
      point: pointAt(from),
    });
  };

  const submitPrompt = (current: PromptState, values: PromptValues) => {
    setPrompt(null);
    const value = values.value.trim();
    const label = values.text.trim();
    const chain = editor.chain().focus();
    const range = { from: current.from, to: current.to };
    switch (current.kind) {
      case 'link':
        if (!value) chain.setTextSelection(range).extendMarkRange('link').unsetLink().run();
        else if (range.from === range.to) {
          chain
            .insertContentAt(range.from, {
              type: 'text',
              text: label || value,
              marks: [{ type: 'link', attrs: { href: value } }],
            })
            .run();
        } else chain.setTextSelection(range).extendMarkRange('link').setLink({ href: value }).run();
        return;
      case 'image':
        if (value) chain.insertContentAt(range, { type: 'image', attrs: { src: value, alt: label || null } }).run();
        return;
      case 'inlineMath':
      case 'blockMath': {
        const pos = current.nodePos;
        if (pos === undefined) {
          if (value) chain.insertContentAt(range, { type: current.kind, attrs: { latex: value } }).run();
          return;
        }
        chain
          .command(({ tr }) => {
            const node = tr.doc.nodeAt(pos);
            if (!node || node.type.name !== current.kind) return false;
            if (value) tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: value });
            else tr.delete(pos, pos + node.nodeSize);
            return true;
          })
          .run();
      }
    }
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

  const applySearch = (next: Omit<SearchUiState, 'count'>, reveal: boolean) => {
    editor.view.dispatch(editor.state.tr.setMeta(richMarkdownSearchKey, next));
    const state = richMarkdownSearchState(editor.state);
    setSearch({ ...next, active: state?.active ?? -1, count: state?.matches.length ?? 0 });
    if (!reveal) return;
    requestAnimationFrame(() =>
      canvasRef.current?.querySelector('.rich-markdown-search-match.is-active')?.scrollIntoView?.({ block: 'center' })
    );
  };

  const openSearch = () => {
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, ' ');
    const query = selected && !selected.includes('\n') ? selected : (search?.query ?? '');
    applySearch({ query, caseSensitive: search?.caseSensitive ?? false, active: 0 }, true);
  };

  const closeSearch = () => {
    applySearch({ query: '', caseSensitive: false, active: -1 }, false);
    setSearch(null);
    editor.commands.focus();
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
        const data = event.clipboardData;
        const plain = data?.getData('text/plain') ?? '';
        if (!editor.isEditable || !plain || editor.state.selection.$from.parent.type.spec.code) return false;
        // Rich HTML (a web page, a document) already carries its structure.
        const html = data?.getData('text/html') ?? '';
        if (/<(?:h[1-6]|ul|ol|table|a\s|strong|em|b|i|pre|blockquote|img)\b/i.test(html)) return false;
        if (!looksLikeMarkdown(plain)) return false;
        event.preventDefault();
        // The clipboard gets the same safety checks as a loaded file: Markdown
        // the editor cannot represent faithfully goes in as literal text.
        const codec = richMarkdownCodecFor(editor.schema, editor.markdown!);
        if (richMarkdownBodySupport(plain).ok && checkRichMarkdownRoundTrip(codec, plain).ok) {
          return editor.chain().focus().insertContent(plain, { contentType: 'markdown' }).run();
        }
        // One paragraph per line; empty lines stay as empty paragraphs.
        const lines = plain.split(/\r\n?|\n/);
        return editor
          .chain()
          .focus()
          .insertContent(
            lines.map((line) =>
              line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
            )
          )
          .run();
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
        if (search && transaction.docChanged) {
          const found = richMarkdownSearchState(state);
          setSearch({ ...search, active: found?.active ?? -1, count: found?.matches.length ?? 0 });
        }
        if (!editor.isEditable || transaction.getMeta(PROGRAMMATIC)) {
          if (menu) closeMenu();
        } else if (transaction.docChanged || menu) {
          const trigger = typedTrigger(state);
          if (!trigger) {
            if (menu) closeMenu();
          } else {
            const items: SuggestItem[] =
              trigger.kind === 'slash'
                ? filterBlockCommands(trigger.query, t).map((command) => ({ kind: 'command', command }))
                : filterEmoji(trigger.query).map(([code, emoji]) => ({ kind: 'emoji', code, emoji }));
            if (trigger.kind === 'emoji' && !items.length) {
              if (menu) closeMenu();
            } else {
              const same = menu?.kind === trigger.kind && menu.from === trigger.from;
              setMenu({
                kind: trigger.kind,
                from: trigger.from,
                to: trigger.to,
                items,
                selected: same ? Math.min(menu.selected, Math.max(items.length - 1, 0)) : 0,
                point: same ? menu.point : pointAt(trigger.from),
              });
            }
          }
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

  // Load the model, follow its changes (including undo and redo), and end
  // the undo step on the way out.
  const model = modelRef.current;
  useLayoutEffect(() => {
    if (!model) return;
    const sync = new RichMarkdownModelSync(model, richMarkdownCodecFor(editor.schema, editor.markdown!), {
      onDocument(doc, nextFrontMatter) {
        replaceDocument(editor, doc, !loadedRef.current, historyRef.current);
        loadedRef.current = true;
        setFrontMatter(nextFrontMatter);
        setUnsupported(false);
      },
      onFrontMatter: setFrontMatter,
      onUnsupported(reason) {
        setUnsupported(true);
        live.current.reportUnsupported(reason);
      },
      onHeld(reason) {
        setHeld(reason);
        if (reason === null) live.current.reportHeld(false);
        else live.current.reportHeld(true, () => sync.heldMarkdown());
      },
    });
    syncRef.current = sync;
    sync.start();
    const changes = model.onDidChangeContent(() => live.current.refreshHistory());
    live.current.refreshHistory();
    return () => {
      changes.dispose();
      sync.flush();
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
      setHeld(null);
      // A held edit outlives the editor in the host's backup.
      if (sync.heldReason === null) live.current.reportHeld(false);
    };
  }, [editor, model]);

  // A changed text prop means the model changed; reload if it is not ours.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger; the effect must re-run when it changes
  useEffect(() => {
    syncRef.current?.refresh();
  }, [text]);

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
