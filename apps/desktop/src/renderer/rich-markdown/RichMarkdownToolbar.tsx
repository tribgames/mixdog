import type { ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Code,
  FileCode2,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Search,
  Sigma,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react';
import { t } from '../i18n';
import type { RichMarkdownPromptKind } from './rich-markdown-commands';

const LIST_ITEMS = ['listItem', 'taskItem'] as const;

function listItemType(editor: Editor): (typeof LIST_ITEMS)[number] | null {
  return LIST_ITEMS.find((name) => editor.isActive(name)) ?? null;
}

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  onRun,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onRun(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="rich-markdown-tool"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active}
      disabled={disabled}
      // Keeps the editor's selection: the button never takes focus on press.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

const ICON = { size: 15, 'aria-hidden': true } as const;

const TABLE_ACTIONS = [
  ['Row above', 'addRowBefore'],
  ['Row below', 'addRowAfter'],
  ['Delete row', 'deleteRow'],
  ['Column left', 'addColumnBefore'],
  ['Column right', 'addColumnAfter'],
  ['Delete column', 'deleteColumn'],
  ['Delete table', 'deleteTable'],
] as const;

export function RichMarkdownToolbar({
  editor,
  readOnly,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPrompt,
  onSearch,
}: {
  editor: Editor;
  readOnly: boolean;
  /** Undo and redo run on the document's model history, not the editor's. */
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onPrompt(kind: RichMarkdownPromptKind): void;
  onSearch(): void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      heading: ([1, 2, 3, 4, 5, 6] as const).find((level) => current.isActive('heading', { level })) ?? 0,
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      table: current.isActive('table'),
      listItem: listItemType(current),
    }),
  });
  const chain = () => editor.chain().focus();
  const off = readOnly;
  const mod = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return (
    <div className="rich-markdown-toolbar" role="toolbar" aria-label={t('Formatting')}>
      <div className="rich-markdown-toolbar-group">
        <ToolButton label={t('Undo')} shortcut={`${mod}Z`} disabled={off || !canUndo} onRun={onUndo}>
          <Undo2 {...ICON} />
        </ToolButton>
        <ToolButton label={t('Redo')} shortcut={`${mod}Shift+Z`} disabled={off || !canRedo} onRun={onRedo}>
          <Redo2 {...ICON} />
        </ToolButton>
      </div>
      <div className="rich-markdown-toolbar-group">
        <select
          className="rich-markdown-block-type"
          aria-label={t('Text style')}
          disabled={off}
          value={String(state.heading)}
          onChange={(event) => {
            const level = Number(event.target.value);
            if (level)
              chain()
                .setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
                .run();
            else chain().setParagraph().run();
          }}
        >
          <option value="0">{t('Text')}</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option key={level} value={level}>
              {t('Heading {{level}}', { level })}
            </option>
          ))}
        </select>
      </div>
      <div className="rich-markdown-toolbar-group">
        <ToolButton
          label={t('Bold')}
          shortcut={`${mod}B`}
          active={state.bold}
          disabled={off}
          onRun={() => chain().toggleBold().run()}
        >
          <Bold {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Italic')}
          shortcut={`${mod}I`}
          active={state.italic}
          disabled={off}
          onRun={() => chain().toggleItalic().run()}
        >
          <Italic {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Strikethrough')}
          shortcut={`${mod}Shift+S`}
          active={state.strike}
          disabled={off}
          onRun={() => chain().toggleStrike().run()}
        >
          <Strikethrough {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Inline code')}
          shortcut={`${mod}E`}
          active={state.code}
          disabled={off}
          onRun={() => chain().toggleCode().run()}
        >
          <Code {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Link')}
          shortcut={`${mod}K`}
          active={state.link}
          disabled={off}
          onRun={() => onPrompt('link')}
        >
          <Link {...ICON} />
        </ToolButton>
      </div>
      <div className="rich-markdown-toolbar-group">
        <ToolButton
          label={t('Bulleted list')}
          active={state.bulletList}
          disabled={off}
          onRun={() => chain().toggleBulletList().run()}
        >
          <List {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Numbered list')}
          active={state.orderedList}
          disabled={off}
          onRun={() => chain().toggleOrderedList().run()}
        >
          <ListOrdered {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Task list')}
          active={state.taskList}
          disabled={off}
          onRun={() => chain().toggleTaskList().run()}
        >
          <ListChecks {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Outdent')}
          shortcut="Shift+Tab"
          disabled={off || !state.listItem}
          onRun={() => state.listItem && chain().liftListItem(state.listItem).run()}
        >
          <IndentDecrease {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Indent')}
          shortcut="Tab"
          disabled={off || !state.listItem}
          onRun={() => state.listItem && chain().sinkListItem(state.listItem).run()}
        >
          <IndentIncrease {...ICON} />
        </ToolButton>
      </div>
      <div className="rich-markdown-toolbar-group">
        <ToolButton
          label={t('Quote')}
          active={state.blockquote}
          disabled={off}
          onRun={() => chain().toggleBlockquote().run()}
        >
          <Quote {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Code block')}
          active={state.codeBlock}
          disabled={off}
          onRun={() => chain().toggleCodeBlock().run()}
        >
          <FileCode2 {...ICON} />
        </ToolButton>
        <ToolButton
          label={t('Table')}
          disabled={off || state.table}
          onRun={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          <Table {...ICON} />
        </ToolButton>
        <ToolButton label={t('Image')} disabled={off} onRun={() => onPrompt('image')}>
          <ImageIcon {...ICON} />
        </ToolButton>
        <ToolButton label={t('Math block')} disabled={off} onRun={() => onPrompt('blockMath')}>
          <Sigma {...ICON} />
        </ToolButton>
        <ToolButton label={t('Collapsible section')} disabled={off} onRun={() => chain().setDetails().run()}>
          <ListCollapse {...ICON} />
        </ToolButton>
        <ToolButton label={t('Divider')} disabled={off} onRun={() => chain().setHorizontalRule().run()}>
          <Minus {...ICON} />
        </ToolButton>
      </div>
      {state.table && !off ? (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would change the toolbar's layout and styling
        <div className="rich-markdown-toolbar-group rich-markdown-table-tools" role="group" aria-label={t('Table')}>
          {TABLE_ACTIONS.map(([label, run]) => (
            <button
              key={label}
              type="button"
              className={`rich-markdown-tool-text${run === 'deleteTable' ? ' is-danger' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chain()[run]().run()}
            >
              {t(label)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rich-markdown-toolbar-spacer" />
      <div className="rich-markdown-toolbar-group">
        <ToolButton label={t('Find')} shortcut={`${mod}F`} onRun={onSearch}>
          <Search {...ICON} />
        </ToolButton>
      </div>
    </div>
  );
}
