import type { editor as MonacoEditor, IDisposable } from 'monaco-editor';
import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { t } from '../i18n';
import {
  checkRichMarkdownRoundTrip,
  dominantEol,
  markdownBlockSpans,
  minimalTextEdit,
  reconcileMarkdown,
  richMarkdownBlocksMeaning,
  toLf,
  type RichMarkdownCodec,
  type RichMarkdownRoundTrip,
} from './rich-markdown-codec';
import { splitFrontMatter } from './rich-markdown-frontmatter';
import { richMarkdownBodySupport, richMarkdownSizeSupport, richMarkdownSupport } from './rich-markdown-support';

/** The slice of a Monaco text model the rich editor reads and writes. */
export type RichMarkdownModel = Pick<
  MonacoEditor.ITextModel,
  | 'getValue'
  | 'getPositionAt'
  | 'pushEditOperations'
  | 'pushStackElement'
  | 'onDidChangeContent'
  | 'isDisposed'
  | 'undo'
  | 'redo'
  | 'canUndo'
  | 'canRedo'
>;

/** Edits written within this long of each other form one undo step. */
const UNDO_STEP_MS = 500;

export interface RichMarkdownSyncHandlers {
  /** A (re)loaded body for the editor, with the front matter to show. */
  onDocument(doc: JSONContent, frontMatter: string): void;
  /** Only the front matter changed; the editor content stays. */
  onFrontMatter(frontMatter: string): void;
  onUnsupported(reason: string): void;
  /** The editor holds an edit the model could not take (why), or no longer
   *  does (null). Held edits are kept until written or explicitly discarded. */
  onHeld?(reason: string | null): void;
}

/** A top-level block of the editor document and its span in the body
 *  (LF line endings); empty paragraphs have no text and an empty span. */
interface BlockEntry {
  node: ProseMirrorNode;
  start: number;
  end: number;
}

type LoadVerdict = (RichMarkdownRoundTrip | { ok: false; reason: string }) & {
  /** The body's block spans (LF), when loadable. */
  spans?: ReturnType<typeof markdownBlockSpans>;
};

/** Verdicts of the latest loads by model text, most recent last, so going
 *  back to Rich on unchanged content skips the checks. The documents in it
 *  are shared and never mutated. */
const verdicts = new Map<string, LoadVerdict>();
const VERDICTS_KEPT = 4;

/** The support and round-trip verdict for loading `text` (whose body is
 *  `body`). */
function loadVerdict(codec: RichMarkdownCodec, text: string, body: string): LoadVerdict {
  let verdict = verdicts.get(text);
  if (verdict) verdicts.delete(text);
  else {
    const support = richMarkdownSupport(text);
    verdict = support.ok ? checkRichMarkdownRoundTrip(codec, body) : support;
    if (verdict.ok) verdict = { ...verdict, spans: markdownBlockSpans(toLf(body)) };
  }
  // Only acceptances are kept: a rejection (possibly from a transient
  // failure) is checked again the next time this text is loaded.
  if (!verdict.ok) return verdict;
  verdicts.set(text, verdict);
  if (verdicts.size > VERDICTS_KEPT) verdicts.delete(verdicts.keys().next().value!);
  return verdict;
}

/** Editor block types each reference-lexer block may stand for. */
const BLOCK_TYPES: Record<string, string[]> = {
  heading: ['heading'],
  paragraph: ['paragraph', 'blockMath'],
  code: ['codeBlock'],
  blockquote: ['blockquote'],
  list: ['bulletList', 'orderedList', 'taskList'],
  table: ['table'],
  hr: ['horizontalRule'],
  html: ['details'],
};

const isEmptyParagraph = (node: ProseMirrorNode) => node.type.name === 'paragraph' && node.childCount === 0;

/** Front matter followed by a body. A block whose closing delimiter ends the
 *  file has no line ending, which a non-empty body needs after it (else the
 *  delimiter and the body share a line and the block stops being front matter). */
function joinFrontMatter(frontMatter: string, body: string): string {
  if (!frontMatter || !body || frontMatter.endsWith('\n')) return frontMatter + body;
  return frontMatter + dominantEol(frontMatter) + body;
}

function childrenOf(doc: ProseMirrorNode, from = 0, to = doc.childCount): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = [];
  for (let index = from; index < to; index++) children.push(doc.child(index));
  return children;
}

/** The blocks `nodes` paired with their spans in `text` (offset by `base`),
 *  or null when the text's blocks do not line up with them one to one. */
function mapBlocks(
  text: string,
  nodes: ProseMirrorNode[],
  base = 0,
  spans = markdownBlockSpans(text)
): BlockEntry[] | null {
  if (!spans) return null;
  const entries: BlockEntry[] = [];
  let next = 0;
  let lastEnd = 0;
  for (const node of nodes) {
    if (isEmptyParagraph(node)) {
      entries.push({ node, start: base + lastEnd, end: base + lastEnd });
      continue;
    }
    const span = spans[next++];
    if (!span || !BLOCK_TYPES[span.type]?.includes(node.type.name)) return null;
    entries.push({ node, start: base + span.start, end: base + span.end });
    lastEnd = span.end;
  }
  return next === spans.length ? entries : null;
}

/**
 * Keeps one rich editor and its Monaco model in step. The model is the source
 * of truth: the editor is loaded from it, edits are written back as one
 * minimal replacement (so Monaco's undo, dirty state and save keep working),
 * and changes made elsewhere reload the editor. Nothing is written unless an
 * edit actually changes the Markdown, and only Markdown proven to read back
 * as the edited document. Undo and redo run on the model's own history, so
 * Rich and Source share one.
 */
export class RichMarkdownModelSync {
  /** Front matter and body the editor currently reflects. */
  private frontMatter = '';
  private body = '';
  /** `body` with LF line endings, and the line ending the model uses. */
  private lf = '';
  private eol: '\n' | '\r\n' = '\n';
  /** The editor's top-level blocks and their spans in `lf`, or null when
   *  unknown (the next edit is then written over the whole document). */
  private blocks: BlockEntry[] | null = null;
  private writing = false;
  /** Model text last found unsupported. */
  private rejected: string | null = null;
  /** Why the editor holds an edit the model could not take (it exists only
   *  in the editor), or null. */
  private held: string | null = null;
  /** The held edit's document, while one is held. */
  private heldDoc: ProseMirrorNode | null = null;
  /** When the open undo step last took an edit; null when none is open. */
  private stepAt: number | null = null;
  private subscription: IDisposable | null = null;

  constructor(
    readonly model: RichMarkdownModel,
    private readonly codec: RichMarkdownCodec,
    private readonly handlers: RichMarkdownSyncHandlers
  ) {}

  /** Loads the model into the editor and starts following its changes.
   *  False (after reporting why) when the content cannot be edited safely. */
  start(): boolean {
    this.subscription = this.model.onDidChangeContent(() => {
      if (!this.writing) this.refresh();
    });
    return this.load(this.model.getValue());
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  /** Re-reads the model; reloads the editor only when the body differs from
   *  what the editor last showed or wrote. */
  refresh(): void {
    if (this.model.isDisposed()) return;
    const text = this.model.getValue();
    if (text === this.rejected) return;
    const { frontMatter, body } = splitFrontMatter(text);
    // Back to the body the editor shows after other text was rejected: the
    // editor shows the unsupported state, so it is loaded again below.
    if (body === this.body && this.rejected === null) {
      if (frontMatter !== this.frontMatter) {
        this.frontMatter = frontMatter;
        this.handlers.onFrontMatter(frontMatter);
      }
      return;
    }
    this.stepAt = null;
    // The editor holds an edit the model never took: it is kept (never
    // replaced behind the user's back) until explicitly discarded.
    if (this.held !== null) {
      this.hold(
        t('The file changed elsewhere while this edit could not be saved. Discard the edit to load the current file.')
      );
      return;
    }
    if (!this.reloadChangedBlocks(text)) this.load(text);
  }

  /**
   * Follows a change of the model (an undo or redo, an edit made elsewhere)
   * by reparsing only the top-level blocks the changed text touches, with
   * one unchanged neighbouring block per side; those must read back exactly
   * as before, which proves the change did not reach past them. The
   * reparsed run passes the same support and round-trip checks a whole
   * document does on loading. False when the change cannot be applied this
   * way; the caller then reloads the whole document.
   */
  private reloadChangedBlocks(text: string): boolean {
    const old = this.blocks;
    if (!old || this.rejected !== null || richMarkdownSizeSupport(text)) return false;
    const { frontMatter, body } = splitFrontMatter(text);
    const lf = toLf(body);
    const previous = this.lf;
    let changeStart = 0;
    const limit = Math.min(previous.length, lf.length);
    while (changeStart < limit && previous.charCodeAt(changeStart) === lf.charCodeAt(changeStart)) changeStart++;
    let tail = 0;
    while (
      tail < previous.length - changeStart &&
      tail < lf.length - changeStart &&
      previous.charCodeAt(previous.length - 1 - tail) === lf.charCodeAt(lf.length - 1 - tail)
    ) {
      tail++;
    }
    const changeEnd = previous.length - tail;
    const delta = lf.length - previous.length;
    // Neighbours: the last block ending before the change and the first
    // starting after it.
    let prev = -1;
    let next = -1;
    for (let index = 0; index < old.length && next === -1; index++) {
      const entry = old[index];
      if (isEmptyParagraph(entry.node)) continue;
      if (entry.end < changeStart) prev = index;
      else if (entry.start > changeEnd) next = index;
    }
    const windowStart = prev >= 0 ? old[prev].start : 0;
    const windowText = lf.slice(windowStart, (next >= 0 ? old[next].end : previous.length) + delta);
    const support = richMarkdownBodySupport(windowText);
    const roundTrip = support.ok ? checkRichMarkdownRoundTrip(this.codec, windowText) : support;
    if (!roundTrip.ok) return false;
    const nodes = childrenOf(this.codec.schema.nodeFromJSON(roundTrip.doc));
    const blocks = nodes.filter((node) => !isEmptyParagraph(node));
    if (prev >= 0 && !blocks[0]?.eq(old[prev].node)) return false;
    if (next >= 0 && !blocks.at(-1)?.eq(old[next].node)) return false;
    const mapped = mapBlocks(windowText, nodes, windowStart);
    if (!mapped) return false;
    const from = prev >= 0 ? prev : 0;
    const to = next >= 0 ? next + 1 : old.length;
    const entries = [
      ...old.slice(0, from),
      ...mapped,
      ...old.slice(to).map((entry) => ({ node: entry.node, start: entry.start + delta, end: entry.end + delta })),
    ];
    const doc = this.codec.schema.topNodeType.create(
      null,
      entries.map((entry) => entry.node)
    );
    this.rejected = null;
    this.frontMatter = frontMatter;
    this.setBody(body);
    this.blocks = entries;
    this.handlers.onDocument(doc.toJSON(), frontMatter);
    return true;
  }

  /** The reason an edit is held, or null when the model has every edit. */
  get heldReason(): string | null {
    return this.held;
  }

  private hold(reason: string): void {
    this.held = reason;
    this.handlers.onHeld?.(reason);
  }

  private release(): void {
    this.heldDoc = null;
    if (this.held === null) return;
    this.held = null;
    this.handlers.onHeld?.(null);
  }

  /**
   * The whole file as it would read with the held edit, best effort (it is
   * held because this Markdown does not read back exactly as the edit), for
   * crash-recovery backups; null when nothing is held. The front matter and
   * the parts of the body the edit left unchanged keep their bytes.
   */
  heldMarkdown(): string | null {
    const doc = this.heldDoc;
    if (this.held === null || !doc) return null;
    let fresh: string;
    try {
      fresh = this.serializeBlocks(childrenOf(doc));
    } catch {
      return null;
    }
    let lf: string;
    try {
      lf = toLf(reconcileMarkdown(this.lf, fresh));
    } catch {
      lf = fresh;
    }
    return joinFrontMatter(this.frontMatter, this.eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf);
  }

  /** Drops a held edit and reloads the editor from the model. */
  discard(): void {
    if (this.model.isDisposed()) return;
    this.release();
    this.endUndoStep();
    const text = this.model.getValue();
    if (!this.reloadChangedBlocks(text)) this.load(text);
  }

  private setBody(body: string): void {
    this.body = body;
    this.lf = toLf(body);
    this.eol = dominantEol(body);
  }

  private load(text: string): boolean {
    const { frontMatter, body } = splitFrontMatter(text);
    const roundTrip = loadVerdict(this.codec, text, body);
    if (!roundTrip.ok) {
      // Reported once per content; the host decides what to show instead.
      this.rejected = text;
      this.handlers.onUnsupported(roundTrip.reason);
      return false;
    }
    this.rejected = null;
    this.frontMatter = frontMatter;
    this.setBody(body);
    this.blocks = mapBlocks(this.lf, childrenOf(this.codec.schema.nodeFromJSON(roundTrip.doc)), 0, roundTrip.spans);
    this.handlers.onDocument(roundTrip.doc, frontMatter);
    return true;
  }

  /** Whether `markdown` reads back as `nodes` (Markdown meaning). */
  private readsBackAs(markdown: string, nodes: ProseMirrorNode[]): boolean {
    try {
      const parsed = this.codec.schema.nodeFromJSON(this.codec.parse(markdown));
      return richMarkdownBlocksMeaning(childrenOf(parsed)) === richMarkdownBlocksMeaning(nodes);
    } catch {
      return false;
    }
  }

  private serializeBlocks(nodes: ProseMirrorNode[]): string {
    return this.codec.serialize({ type: 'doc', content: nodes.map((node) => node.toJSON()) });
  }

  /**
   * The new body (LF) with only the top-level blocks that changed rewritten,
   * and the block spans after it; null when that cannot be done (or proven)
   * locally. Changed blocks are found by identity (an editor transaction
   * keeps untouched blocks as the same nodes) or equality, and the written
   * text is validated by reparsing it with one neighbouring block per side,
   * the only blocks it can merge with.
   */
  private spliceChangedBlocks(doc: ProseMirrorNode): { lf: string; blocks: BlockEntry[] | null } | null {
    const old = this.blocks;
    if (!old) return null;
    const n = old.length;
    const m = doc.childCount;
    const same = (entry: BlockEntry, node: ProseMirrorNode) => {
      if (entry.node === node) return true;
      if (!entry.node.eq(node)) return false;
      entry.node = node;
      return true;
    };
    let p = 0;
    while (p < n && p < m && same(old[p], doc.child(p))) p++;
    let s = 0;
    while (s < n - p && s < m - p && same(old[n - 1 - s], doc.child(m - 1 - s))) s++;
    if (p === n && p === m) return { lf: this.lf, blocks: old };
    let prev = p - 1;
    while (prev >= 0 && isEmptyParagraph(old[prev].node)) prev--;
    let next = n - s;
    while (next < n && isEmptyParagraph(old[next].node)) next++;
    if (next === n) next = -1;
    const lf = this.lf;
    const lo = prev >= 0 ? old[prev].end : 0;
    const hi = next >= 0 ? old[next].start : lf.length - (/\n*$/.exec(lf)?.[0].length ?? 0);
    const run = childrenOf(doc, p, m - s);
    // The run's blocks separated as the serializer separates them: a blank
    // line between blocks and one more per empty paragraph.
    let fresh = '';
    let pending = 0;
    let afterBlock = prev >= 0;
    for (const node of run) {
      if (isEmptyParagraph(node)) {
        pending++;
        continue;
      }
      fresh += '\n\n'.repeat(pending + (afterBlock ? 1 : 0)) + this.serializeBlocks([node]);
      afterBlock = true;
      pending = 0;
    }
    if (next >= 0) fresh += '\n\n'.repeat(pending + (afterBlock ? 1 : 0));
    const oldRun = old.slice(p, n - s);
    // Unchanged parts inside the changed blocks keep their bytes.
    const region = oldRun.some((entry) => !isEmptyParagraph(entry.node))
      ? toLf(reconcileMarkdown(lf.slice(lo, hi), fresh))
      : fresh;
    const nextLf = lf.slice(0, lo) + region + lf.slice(hi);
    const delta = region.length - (hi - lo);
    const windowStart = prev >= 0 ? old[prev].start : 0;
    const windowEnd = next >= 0 ? old[next].end + delta : nextLf.length;
    const windowNodes = childrenOf(doc, prev >= 0 ? prev : 0, next >= 0 ? next + m - n + 1 : m);
    if (!this.readsBackAs(nextLf.slice(windowStart, windowEnd), windowNodes)) return null;
    const mapped = mapBlocks(region, run, lo);
    const blocks = mapped
      ? [
          ...old.slice(0, p),
          ...mapped,
          ...old
            .slice(n - s)
            .map((entry) => ({ node: entry.node, start: entry.start + delta, end: entry.end + delta })),
        ]
      : null;
    // Suffix blocks are the document's own nodes from here on.
    if (blocks) for (let index = m - s; index < m; index++) blocks[index].node = doc.child(index);
    return { lf: nextLf, blocks };
  }

  /** The new body (LF) with the whole document serialized and reconciled
   *  against the old one; null when it would not read back as `doc`. */
  private spliceWholeDocument(doc: ProseMirrorNode): { lf: string; blocks: BlockEntry[] | null } | null {
    const nodes = childrenOf(doc);
    let next: string;
    try {
      next = toLf(reconcileMarkdown(this.lf, this.serializeBlocks(nodes)));
    } catch {
      return null;
    }
    if (!this.readsBackAs(next, nodes)) return null;
    return { lf: next, blocks: mapBlocks(next, nodes) };
  }

  /**
   * Writes the edited document into the model as Markdown. Only the changed
   * top-level blocks are serialized and written; unchanged blocks, and
   * unchanged parts of changed lists, quotes and tables, keep their original
   * bytes. Markdown that would not read back as `doc` is never written: the
   * model stays as it is and the edit is held (reported through `onHeld`)
   * until a later edit makes it writable or it is discarded. Edits in quick
   * succession share one undo step. Returns whether the model changed.
   */
  commit(input: ProseMirrorNode | JSONContent): boolean {
    if (this.model.isDisposed()) return false;
    const doc = 'nodeSize' in input ? (input as ProseMirrorNode) : this.codec.schema.nodeFromJSON(input);
    const text = this.model.getValue();
    const { frontMatter, body } = splitFrontMatter(text);
    if (body !== this.body) {
      // Changed elsewhere without a reload: only possible while an edit is
      // held, which must not overwrite that change. The held edit still
      // follows the editor, and is reported again so its backup does too.
      if (this.held !== null) {
        this.heldDoc = doc;
        this.hold(this.held);
        return false;
      }
      this.setBody(body);
      this.blocks = null;
    }
    const result = this.spliceChangedBlocks(doc) ?? this.spliceWholeDocument(doc);
    if (!result) {
      this.heldDoc = doc;
      this.hold(
        t(
          'This edit cannot be written as Markdown, so it is not in the file and cannot be saved yet. Keep editing, or discard it.'
        )
      );
      return false;
    }
    this.release();
    this.frontMatter = frontMatter;
    this.blocks = result.blocks;
    const nextBody = this.eol === '\r\n' ? result.lf.replace(/\n/g, '\r\n') : result.lf;
    const edit = minimalTextEdit(text, joinFrontMatter(frontMatter, nextBody));
    if (!edit) return false;
    const start = this.model.getPositionAt(edit.start);
    const end = this.model.getPositionAt(edit.end);
    this.writing = true;
    try {
      const now = Date.now();
      if (this.stepAt === null || now - this.stepAt > UNDO_STEP_MS) this.model.pushStackElement();
      this.stepAt = now;
      this.model.pushEditOperations(
        [],
        [
          {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text: edit.text,
          },
        ],
        () => null
      );
    } finally {
      this.writing = false;
    }
    // The model may normalize line endings of the inserted text; what it now
    // holds is what the editor reflects.
    this.setBody(splitFrontMatter(this.model.getValue()).body);
    if (this.lf !== result.lf) this.blocks = null;
    return true;
  }

  /** Ends the open undo step, so the next edit (here or in Source) starts
   *  its own. */
  endUndoStep(): void {
    if (this.stepAt !== null && !this.model.isDisposed()) this.model.pushStackElement();
    this.stepAt = null;
  }

  /** Ends the undo step; true when the model has every edit (nothing is
   *  held), so saving or leaving may proceed. */
  flush(): boolean {
    this.endUndoStep();
    return this.held === null;
  }

  canUndo(): boolean {
    return this.held !== null || (!this.model.isDisposed() && this.model.canUndo());
  }

  canRedo(): boolean {
    return !this.model.isDisposed() && this.model.canRedo();
  }

  /** Undoes the latest edit through the model's history; the editor follows
   *  the model. A held edit is the latest: undoing discards it. */
  undo(): void {
    if (this.model.isDisposed()) return;
    if (this.held !== null) {
      this.discard();
      return;
    }
    this.endUndoStep();
    void this.model.undo();
  }

  redo(): void {
    if (this.model.isDisposed()) return;
    if (this.held !== null) this.discard();
    this.endUndoStep();
    void this.model.redo();
  }
}
