import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, Copy, ExternalLink, Pencil, Unlink, X } from 'lucide-react';
import { t } from '../i18n';
import { copyTextToClipboard } from '../text-format';
import type { RichMarkdownBlockCommand, RichMarkdownPromptKind } from './rich-markdown-commands';
import { frontMatterLines } from './rich-markdown-frontmatter';

/** Content-relative anchor of a floating panel (scrolls with the text). */
export interface OverlayPoint {
  top: number;
  left: number;
}

export type SuggestItem =
  | { kind: 'command'; command: RichMarkdownBlockCommand }
  | { kind: 'emoji'; code: string; emoji: string };

export function RichMarkdownSuggestMenu({
  items,
  selected,
  point,
  onPick,
  onHover,
}: {
  items: SuggestItem[];
  selected: number;
  point: OverlayPoint;
  onPick(item: SuggestItem): void;
  onHover(index: number): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `selected` is the trigger; the active option is scrolled into view when it changes
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  // The menu is a sibling of the editor's contenteditable: point the editor at
  // the list and its active option while open, and clear them on close.
  const activeId = items.length ? optionId(Math.min(selected, items.length - 1)) : null;
  useEffect(() => {
    const editor = list.current?.parentElement?.querySelector<HTMLElement>('[contenteditable]');
    if (!editor) return undefined;
    editor.setAttribute('aria-controls', listId);
    editor.setAttribute('aria-expanded', 'true');
    if (activeId) editor.setAttribute('aria-activedescendant', activeId);
    else editor.removeAttribute('aria-activedescendant');
    return () => {
      editor.removeAttribute('aria-controls');
      editor.removeAttribute('aria-activedescendant');
      editor.removeAttribute('aria-expanded');
    };
  }, [listId, activeId]);
  return (
    <div
      ref={list}
      id={listId}
      className="rich-markdown-popover rich-markdown-suggest"
      role="listbox"
      aria-label={items[0]?.kind === 'emoji' ? t('Emoji') : t('Insert block')}
      style={{ top: point.top, left: point.left }}
    >
      {items.length ? (
        items.map((item, index) => (
          // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the editor; options are reached through aria-activedescendant
          <div
            key={item.kind === 'command' ? item.command.id : item.code}
            id={optionId(index)}
            role="option"
            aria-selected={index === selected}
            className="rich-markdown-suggest-item"
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
            onMouseEnter={() => onHover(index)}
          >
            {item.kind === 'command' ? (
              t(item.command.label, item.command.labelParams)
            ) : (
              <>
                <span className="rich-markdown-suggest-emoji">{item.emoji}</span>
                <span>:{item.code}:</span>
              </>
            )}
          </div>
        ))
      ) : (
        <div className="rich-markdown-suggest-empty">{t('No matches')}</div>
      )}
    </div>
  );
}

const PROMPT_LABELS: Record<RichMarkdownPromptKind, string> = {
  link: 'Link URL or path',
  image: 'Image path or URL',
  inlineMath: 'LaTeX',
  blockMath: 'LaTeX',
};

export interface PromptValues {
  value: string;
  /** Link text for a new link, alt text for an image. */
  text: string;
}

export function RichMarkdownPrompt({
  kind,
  initial,
  withText,
  point,
  onSubmit,
  onCancel,
}: {
  kind: RichMarkdownPromptKind;
  initial: PromptValues;
  /** Whether to ask for link/alt text as well. */
  withText: boolean;
  point: OverlayPoint;
  onSubmit(values: PromptValues): void;
  onCancel(): void;
}) {
  const [values, setValues] = useState(initial);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const math = kind === 'inlineMath' || kind === 'blockMath';
  return (
    <form
      className="rich-markdown-popover rich-markdown-prompt"
      style={{ top: point.top, left: point.left }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === 'Enter' && math && (event.ctrlKey || event.metaKey || kind === 'inlineMath')) {
          event.preventDefault();
          onSubmit(values);
        }
      }}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the label wraps the textarea or input chosen below */}
      <label>
        <span>{t(PROMPT_LABELS[kind])}</span>
        {kind === 'blockMath' ? (
          <textarea
            ref={input as RefObject<HTMLTextAreaElement>}
            rows={3}
            spellCheck={false}
            value={values.value}
            onChange={(event) => setValues({ ...values, value: event.target.value })}
          />
        ) : (
          <input
            ref={input as RefObject<HTMLInputElement>}
            spellCheck={false}
            value={values.value}
            onChange={(event) => setValues({ ...values, value: event.target.value })}
          />
        )}
      </label>
      {withText ? (
        <label>
          <span>{kind === 'image' ? t('Alt text') : t('Link text')}</span>
          <input value={values.text} onChange={(event) => setValues({ ...values, text: event.target.value })} />
        </label>
      ) : null}
      <div className="rich-markdown-prompt-actions">
        <button type="button" className="rich-markdown-button" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button type="submit" className="rich-markdown-button is-primary">
          {t('Apply')}
        </button>
      </div>
    </form>
  );
}

export function RichMarkdownLinkBubble({
  href,
  point,
  readOnly,
  onOpen,
  onEdit,
  onRemove,
  onPointerEnter,
  onPointerLeave,
}: {
  href: string;
  point: OverlayPoint;
  readOnly: boolean;
  onOpen(): void;
  onEdit(): void;
  onRemove(): void;
  onPointerEnter(): void;
  onPointerLeave(): void;
}) {
  const mod = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
  return (
    <div
      className="rich-markdown-popover rich-markdown-link-bubble"
      role="dialog"
      aria-label={t('Link')}
      style={{ top: point.top, left: point.left }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="rich-markdown-link-href" title={href}>
        {href}
      </span>
      <button
        type="button"
        className="rich-markdown-tool"
        aria-label={t('Open link')}
        title={t('Open link ({{shortcut}}+click)', { shortcut: mod })}
        onClick={onOpen}
      >
        <ExternalLink size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rich-markdown-tool"
        aria-label={t('Copy link')}
        title={t('Copy link')}
        onClick={() => void copyTextToClipboard(href)}
      >
        <Copy size={14} aria-hidden="true" />
      </button>
      {readOnly ? null : (
        <>
          <button
            type="button"
            className="rich-markdown-tool"
            aria-label={t('Edit link')}
            title={t('Edit link')}
            onClick={onEdit}
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rich-markdown-tool"
            aria-label={t('Remove link')}
            title={t('Remove link')}
            onClick={onRemove}
          >
            <Unlink size={14} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

export function RichMarkdownSearchBar({
  query,
  caseSensitive,
  active,
  count,
  onQuery,
  onCaseSensitive,
  onStep,
  onClose,
}: {
  query: string;
  caseSensitive: boolean;
  active: number;
  count: number;
  onQuery(query: string): void;
  onCaseSensitive(value: boolean): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  let countLabel = '';
  if (query)
    countLabel = count ? t('{{current}} of {{total}}', { current: active + 1, total: count }) : t('No results');
  return (
    // biome-ignore lint/a11y/useSemanticElements: keeps the div the stylesheet and layout expect
    <div className="rich-markdown-search" role="search">
      <input
        ref={input}
        className="rich-markdown-search-input"
        aria-label={t('Find')}
        placeholder={t('Find')}
        spellCheck={false}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="rich-markdown-search-count" aria-live="polite">
        {countLabel}
      </span>
      <button
        type="button"
        className="rich-markdown-tool"
        aria-label={t('Match case')}
        title={t('Match case')}
        aria-pressed={caseSensitive}
        onClick={() => onCaseSensitive(!caseSensitive)}
      >
        <CaseSensitive size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rich-markdown-tool"
        aria-label={t('Previous match')}
        title={t('Previous match (Shift+Enter)')}
        disabled={!count}
        onClick={() => onStep(-1)}
      >
        <ArrowUp size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rich-markdown-tool"
        aria-label={t('Next match')}
        title={t('Next match (Enter)')}
        disabled={!count}
        onClick={() => onStep(1)}
      >
        <ArrowDown size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rich-markdown-tool"
        aria-label={t('Close')}
        title={t('Close (Escape)')}
        onClick={onClose}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Read-only summary of the document's front matter, which the editor keeps
 *  byte for byte and never shows as editable content. */
export function RichMarkdownFrontMatter({ frontMatter }: { frontMatter: string }) {
  const [open, setOpen] = useState(false);
  const lines = frontMatterLines(frontMatter);
  const keys = lines.map((line) => /^([\w.-]+)\s*[:=]/.exec(line)?.[1]).filter(Boolean);
  return (
    <div className="rich-markdown-frontmatter" role="note" aria-label={t('Front matter')}>
      <button
        type="button"
        className="rich-markdown-frontmatter-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="rich-markdown-frontmatter-label">{t('Front matter')}</span>
        <span className="rich-markdown-frontmatter-keys">
          {keys.join(', ') || t('{{count}} lines', { count: lines.length })}
        </span>
      </button>
      {open ? <pre className="rich-markdown-frontmatter-source">{lines.join('\n')}</pre> : null}
    </div>
  );
}
