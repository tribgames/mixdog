import { styledCharsFromTokens, styledCharsToString, tokenize, } from '@alcalzone/ansi-tokenize';
import { sliceTextByDisplayWidth } from './wrap-text.js';
// [mixdog fork] use the shared display-width policy so ink's per-character
// advance + width cache treat circled digits / arrows as 2 cells under Windows
// Terminal, matching OUR wrap/row math. See display-width.js (kept in sync with
// src/tui/display-width.mjs).
import { displayStringWidth as stringWidth, syntheticWideCellPadding } from './display-width.js';
const RGB_COLOR_RE = /^rgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)$/;
const rgbStyle = (value, type, fallback) => {
    const match = RGB_COLOR_RE.exec(String(value || ''));
    const parts = match
        ? match.slice(1, 4).map(part => Math.max(0, Math.min(255, Number(part) || 0)))
        : fallback;
    const sgr = type === 'foreground' ? 38 : 48;
    const reset = type === 'foreground' ? '\x1b[39m' : '\x1b[49m';
    return { code: `\x1b[${sgr};2;${parts[0]};${parts[1]};${parts[2]}m`, endCode: reset };
};
const intersectClips = (clips) => {
    if (clips.length === 0) {
        return undefined;
    }
    const out = {};
    for (const clip of clips) {
        if (typeof clip?.x1 === 'number') {
            out.x1 = typeof out.x1 === 'number' ? Math.max(out.x1, clip.x1) : clip.x1;
        }
        if (typeof clip?.x2 === 'number') {
            out.x2 = typeof out.x2 === 'number' ? Math.min(out.x2, clip.x2) : clip.x2;
        }
        if (typeof clip?.y1 === 'number') {
            out.y1 = typeof out.y1 === 'number' ? Math.max(out.y1, clip.y1) : clip.y1;
        }
        if (typeof clip?.y2 === 'number') {
            out.y2 = typeof out.y2 === 'number' ? Math.min(out.y2, clip.y2) : clip.y2;
        }
    }
    return out;
};
class OutputCaches {
    widths = new Map();
    blockWidths = new Map();
    styledChars = new Map();
    getStyledChars(line) {
        let cached = this.styledChars.get(line);
        if (cached === undefined) {
            cached = styledCharsFromTokens(tokenize(line));
            this.styledChars.set(line, cached);
        }
        return cached;
    }
    getStringWidth(text) {
        let cached = this.widths.get(text);
        if (cached === undefined) {
            cached = stringWidth(text);
            this.widths.set(text, cached);
        }
        return cached;
    }
    getWidestLine(text) {
        let cached = this.blockWidths.get(text);
        if (cached === undefined) {
            let lineWidth = 0;
            for (const line of text.split('\n')) {
                lineWidth = Math.max(lineWidth, this.getStringWidth(line));
            }
            cached = lineWidth;
            this.blockWidths.set(text, cached);
        }
        return cached;
    }
}
export default class Output {
    width;
    height;
    operations = [];
    caches = new OutputCaches();
    // [mixdog fork] absolute terminal cell where the hardware cursor should be
    // parked, captured during renderNodeToOutput from the anchored input node's
    // real laid-out position. null = no cursor this frame.
    cursor = null;
    // [mixdog fork] absolute terminal cell rectangle the user has drag-selected
    // with the mouse, applied as an inverse highlight at serialization time.
    // null = no selection. { x1, y1, x2, y2 } are inclusive, normalized so
    // (x1,y1) is the top-left and (x2,y2) the bottom-right.
    selection = null;
    constructor(options) {
        const { width, height } = options;
        this.width = width;
        this.height = height;
    }
    // [mixdog fork] record the cursor's absolute output cell (last write wins).
    setCursor(x, y) {
        this.cursor = { x, y };
    }
    // [mixdog fork] set the drag-selection rectangle (absolute output cells).
    setSelection(rect) {
        this.selection = rect;
    }
    write(x, y, text, options) {
        const { transformers, softWrap } = options;
        if (!text) {
            return;
        }
        this.operations.push({
            type: 'write',
            x,
            y,
            text,
            transformers,
            // [mixdog fork] per-visual-line soft-wrap flags, parallel to
            // text.split('\n'); softWrap[i]=true means line i is a word-wrap
            // continuation of line i-1. undefined = producer didn't track it.
            softWrap,
        });
    }
    clip(clip) {
        this.operations.push({
            type: 'clip',
            clip,
        });
    }
    unclip() {
        this.operations.push({
            type: 'unclip',
        });
    }
    get() {
        // Initialize output array with a specific set of rows, so that margin/padding at the bottom is preserved
        const output = [];
        for (let y = 0; y < this.height; y++) {
            const row = [];
            for (let x = 0; x < this.width; x++) {
                row.push({
                    type: 'char',
                    value: ' ',
                    fullWidth: false,
                    styles: [],
                });
            }
            output.push(row);
        }
        // [mixdog fork] per-output-row soft-wrap continuation bitmap, filled from
        // each write op's softWrap flags at the row it lands on. rowSoftWrap[y]
        // true = row y is a word-wrap continuation of y-1. Left false where the
        // producer didn't track wrapping (fills, raw ansi, unwrapped text).
        const rowSoftWrap = new Array(this.height).fill(false);
        const clips = [];
        for (const operation of this.operations) {
            if (operation.type === 'clip') {
                clips.push(operation.clip);
            }
            if (operation.type === 'unclip') {
                clips.pop();
            }
            if (operation.type === 'write') {
                const { text, transformers, softWrap } = operation;
                let { x, y } = operation;
                let lines = text.split('\n');
                // Index of the first surviving line after a vertical clip slice,
                // so softWrap[] (parallel to the UN-clipped lines) stays aligned.
                let swFrom = 0;
                // [mixdog fork] Nested overflow:hidden boxes must be clipped to
                // the INTERSECTION of every active ancestor clip. Using only the
                // innermost clip lets child components such as ToolExecution /
                // TurnDone (which have their own overflow hidden rows) escape the
                // transcript viewport and paint over command/prompt/status rows.
                const clip = intersectClips(clips);
                if (clip) {
                    const clipHorizontally = typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number';
                    const clipVertically = typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number';
                    if ((clipHorizontally && clip.x2 <= clip.x1) ||
                        (clipVertically && clip.y2 <= clip.y1)) {
                        continue;
                    }
                    // If text is positioned outside of clipping area altogether,
                    // skip to the next operation to avoid unnecessary calculations
                    if (clipHorizontally) {
                        const width = this.caches.getWidestLine(text);
                        if (x + width < clip.x1 || x > clip.x2) {
                            continue;
                        }
                    }
                    if (clipVertically) {
                        const height = lines.length;
                        if (y + height < clip.y1 || y > clip.y2) {
                            continue;
                        }
                    }
                    if (clipHorizontally) {
                        lines = lines.map(line => {
                            const from = x < clip.x1 ? clip.x1 - x : 0;
                            const width = this.caches.getStringWidth(line);
                            const to = x + width > clip.x2 ? clip.x2 - x : width;
                            // [mixdog fork] `from`/`to` are display-cell offsets.
                            // Plain slice-ansi treats enclosed alphanumerics as
                            // one cell and lets clipped transcript body text
                            // overwrite cells to its right. Slice with the same
                            // wide-glyph policy used by wrap/measure/output.
                            return sliceTextByDisplayWidth(line, from, to);
                        });
                        if (x < clip.x1) {
                            x = clip.x1;
                        }
                    }
                    if (clipVertically) {
                        const from = y < clip.y1 ? clip.y1 - y : 0;
                        const height = lines.length;
                        const to = y + height > clip.y2 ? clip.y2 - y : height;
                        lines = lines.slice(from, to);
                        swFrom = from;
                        if (y < clip.y1) {
                            y = clip.y1;
                        }
                    }
                }
                let offsetY = 0;
                for (let [index, line] of lines.entries()) {
                    const currentLine = output[y + offsetY];
                    // Line can be missing if `text` is taller than height of pre-initialized `this.output`
                    if (!currentLine) {
                        continue;
                    }
                    for (const transformer of transformers) {
                        line = transformer(line, index);
                    }
                    const characters = this.caches.getStyledChars(line);
                    let offsetX = x;
                    // Nothing to write (e.g. line was clipped away).
                    if (characters.length === 0) {
                        offsetY++;
                        continue;
                    }
                    // [mixdog fork] record this VISIBLE row's soft-wrap origin.
                    // Fail closed: a write WITHOUT softWrap metadata clears any
                    // prior sw bit on the row, so untracked overlapping content
                    // (fills, raw ansi, a later plain write) can never inherit a
                    // stale continuation flag and misjoin. Placed after the
                    // empty-line guard so clipped-away no-op lines don't clear it.
                    rowSoftWrap[y + offsetY] = softWrap ? softWrap[swFrom + index] === true : false;
                    const spaceCell = {
                        type: 'char',
                        value: ' ',
                        fullWidth: false,
                        styles: [],
                    };
                    // Wide characters (e.g. CJK) occupy two cells: a leading
                    // cell with the character and a trailing placeholder with
                    // value ''. When an overlapping write lands in the middle
                    // of a wide character, the boundary cells need cleanup so
                    // the terminal never renders a half-visible wide character.
                    if (currentLine[offsetX]?.value === '' &&
                        offsetX > 0 &&
                        this.caches.getStringWidth(currentLine[offsetX - 1]?.value ?? '') >
                            1) {
                        currentLine[offsetX - 1] = spaceCell;
                    }
                    for (const character of characters) {
                        currentLine[offsetX] = character;
                        // Determine printed width using string-width to align with measurement
                        const characterWidth = Math.max(1, this.caches.getStringWidth(character.value));
                        // Policy-widened ambiguous glyphs need a REAL spacer in the
                        // terminal byte stream: unlike native CJK/emoji, WT paints
                        // their ink wide but advances only one cell. Keep the grid
                        // placeholder empty for layout/selection; serialization
                        // materializes only the synthetic tail cells as spaces.
                        const syntheticPadding = characterWidth > 1
                            ? syntheticWideCellPadding(character.value)
                            : 0;
                        // For multi-column characters, clear following cells to avoid stray spaces/artifacts
                        if (characterWidth > 1) {
                            for (let index = 1; index < characterWidth; index++) {
                                currentLine[offsetX + index] = {
                                    type: 'char',
                                    value: '',
                                    fullWidth: false,
                                    styles: character.styles,
                                    syntheticPad: syntheticPadding > 0 && index >= characterWidth - syntheticPadding,
                                };
                            }
                        }
                        offsetX += characterWidth;
                    }
                    if (currentLine[offsetX]?.value === '') {
                        currentLine[offsetX] = spaceCell;
                    }
                    offsetY++;
                }
            }
        }
        // [mixdog fork] Apply the drag-selection highlight. Do not invert the
        // whole rectangle: in an alt-screen TUI most cells are padded blanks, and
        // inverse-video turns those blanks into huge white blocks. Instead,
        // highlight only the content span on each selected row, skipping leading
        // and trailing padding. Selection uses a fixed foreground/background
        // pair close to Windows Terminal's default light selection so links,
        // dim text, and status colors do not bleed through.
        const sel = this.selection;
        let selectedText = null;
        // [mixdog fork] Per-row selection harvest ({y, text}) exposed via the
        // instance getSelectionRows() so the app can stitch selections taller
        // than the viewport. y is the absolute screen row of the last frame;
        // text is trailing-space-trimmed and partial first/last rows respect
        // x1/x2. Null when there is no selection (mirrors selectedText).
        let selectionRows = null;
        // [mixdog fork] noSelect exclusion (claude-code skips gutter / line-number
        // / diff-sigil cells from both highlight and copy via screen.noSelect):
        // mixdog's cell model has NO noSelect marker — the Output grid stores only
        // {value, styles} per cell, with no flag distinguishing gutter cells from
        // content. Inferring gutters from position/content would be a fragile
        // heuristic (line numbers, diff +/- sigils, and real content are
        // indistinguishable at the cell level), so this is deliberately NOT
        // implemented. It needs a noSelect bit threaded through the render
        // pipeline before it can be done cleanly.
        if (sel) {
            const captureSelectedText = sel.captureText !== false;
            if (!captureSelectedText) {
                selectedText = undefined;
            }
            // [mixdog fork] Port applySelectionOverlay's fg-preserving principle
            // from claude-code's selection.ts: REPLACE only the background and
            // PRESERVE each cell's own foreground/attribute styles, so syntax
            // highlighting, OSC-8 links, and dim text stay readable under the
            // selection. The old code forced a black fg + light bg, flattening
            // every colored glyph to one color. selectionForeground is now
            // intentionally unused (kept in the setter API for compatibility).
            const selectionBg = rgbStyle(sel.selectionBackground, 'background', [245, 245, 245]);
            // Parse each SGR entry's parameter list and remove ONLY the bg and
            // inverse params, keeping everything else (fg, bold/dim/underline,
            // etc.) in order, then re-emit the sequence. A prefix test is not
            // enough: a compound entry like \x1b[31;48;5;42m or
            // \x1b[1;48;2;r;g;b;37m would keep its old bg and override the
            // selection color. Background params: 40-49 (basic + default),
            // 100-107 (bright), 48;5;n (256), 48;2;r;g;b (truecolor). Inverse: 7.
            // Returns a sanitized style, or null when no params remain (drop).
            const sanitizeStyle = (s) => {
                if (typeof s?.code !== 'string')
                    return s ?? null;
                const m = /^\x1b\[([\d;]*)m$/.exec(s.code);
                if (!m)
                    return s;
                const params = m[1].length ? m[1].split(';') : [];
                const kept = [];
                for (let i = 0; i < params.length; i++) {
                    const n = Number(params[i]);
                    if (n === 7) // inverse
                        continue;
                    // basic/default/bright bg — 48 is EXCLUDED here: it is the
                    // extended-bg introducer (48;5;n / 48;2;r;g;b) and must be
                    // consumed WITH its payload below. Matching it in this range
                    // check dropped only the lone '48' and left '2;r;g;b' behind,
                    // which re-parsed as dim(2)+basic colors and grayed out any
                    // text drawn over a truecolor background (user-message band).
                    if ((n >= 40 && n <= 47) || n === 49 || (n >= 100 && n <= 107))
                        continue;
                    if (n === 48) { // extended bg: 48;5;n or 48;2;r;g;b
                        const mode = Number(params[i + 1]);
                        i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
                        continue;
                    }
                    if (n === 38) { // extended fg — keep the whole group
                        const mode = Number(params[i + 1]);
                        const span = mode === 2 ? 4 : mode === 5 ? 2 : 1;
                        for (let j = 0; j <= span && i + j < params.length; j++)
                            kept.push(params[i + j]);
                        i += span;
                        continue;
                    }
                    kept.push(params[i]);
                }
                if (kept.length === 0)
                    return null;
                return { ...s, code: `\x1b[${kept.join(';')}m` };
            };
            const linear = sel.mode === 'linear';
            const start = linear && (sel.y1 > sel.y2 || (sel.y1 === sel.y2 && sel.x1 > sel.x2))
                ? { x: sel.x2, y: sel.y2 }
                : { x: sel.x1, y: sel.y1 };
            const end = linear && (sel.y1 > sel.y2 || (sel.y1 === sel.y2 && sel.x1 > sel.x2))
                ? { x: sel.x1, y: sel.y1 }
                : { x: sel.x2, y: sel.y2 };
            const clipY1 = typeof sel.clipY1 === 'number' ? sel.clipY1 : 0;
            const clipY2 = typeof sel.clipY2 === 'number' ? sel.clipY2 : this.height - 1;
            const y1 = Math.max(0, clipY1, linear ? start.y : Math.min(sel.y1, sel.y2));
            const y2 = Math.min(this.height - 1, clipY2, linear ? end.y : Math.max(sel.y1, sel.y2));
            const lineMode = linear && y1 !== y2;
            // [mixdog fork] selRowObjs is built UNCONDITIONALLY whenever a
            // selection rect exists, independent of captureSelectedText: a
            // capture-disabled drag (rect.captureText === false) still needs a
            // per-row harvest so getSelectionRows() can stitch tall selections.
            // Each entry also carries sw = rowSoftWrap[y] so the copy join (here
            // and the app-side stitch) can rejoin word-wrap continuations. Only
            // selectedText honors the captureSelectedText gate.
            const selRowObjs = [];
            for (let y = y1; y <= y2; y++) {
                const row = output[y];
                // [mixdog fork] is THIS row a soft-wrap continuation of the row
                // above? Drives the logical-line rejoin at copy time.
                const sw = rowSoftWrap[y] === true;
                if (!row) {
                    selRowObjs.push({ y, text: '', sw });
                    continue;
                }
                const rawX1 = linear
                    ? (lineMode ? (y === start.y ? start.x : 0) : Math.min(start.x, end.x))
                    : Math.min(sel.x1, sel.x2);
                const rawX2 = linear
                    ? (lineMode ? (y === end.y ? end.x : row.length - 1) : Math.max(start.x, end.x))
                    : Math.max(sel.x1, sel.x2);
                const x1 = Math.max(0, Math.min(rawX1, rawX2));
                const x2 = Math.min(row.length - 1, Math.max(rawX1, rawX2));
                let rowText = '';
                // [mixdog fork] running active fg/attr SGR for carry-forward below;
                // reset per selected row so state never bleeds across rows.
                let carry = [];
                for (let x = x1; x <= x2; x++) {
                    const cell = row[x];
                    // Collect the visible glyph. Wide-char trailing placeholders
                    // carry value '' and contribute nothing, which is correct.
                    // Always accumulated so the unconditional selRowObjs harvest
                    // has row text even when captureSelectedText is false.
                    rowText += cell?.value ?? '';
                    // [mixdog fork] Match claude-code: EVERY cell in the selected
                    // span gets ONE uniform selection background — no content-span
                    // skipping. Empty/whitespace cells (and gaps in the grid) are
                    // painted as a blank ' ' carrying only the selection bg, so a
                    // single highlight style covers text and padding alike.
                    // fg-preserving: keep the cell's own style entries (foreground
                    // color, bold/dim/underline, link attrs) and swap ONLY the
                    // background — drop any existing background/inverse entry so
                    // they don't fight the selection bg, then append it last.
                    const value = cell?.value ?? ' ';
                    const baseStyles = Array.isArray(cell?.styles) ? cell.styles : [];
                    const preserved = baseStyles.map(sanitizeStyle).filter(Boolean);
                    // [mixdog fork] Carry the row's active fg/attr SGR forward into
                    // selected cells that carry NO style of their own — grid-padding
                    // gaps and wide-char trailing placeholders sit at styles=[], so
                    // styledCharsToString's per-cell diff would emit a bare
                    // fg/attr RESET (\x1b[39m / 22m / 24m) at each such cell,
                    // BREAKING the colored run mid-selection and repainting the
                    // following glyphs from a reset state. Inherit the last active
                    // fg/attrs so the highlighted span stays ONE uniform SGR run.
                    // Guard: only blank/whitespace cells inherit — a VISIBLE glyph
                    // that genuinely has empty styles is intentional default-fg and
                    // must never be recolored.
                    if (preserved.length > 0) {
                        carry = preserved;
                    }
                    const effective = preserved.length > 0
                        ? preserved
                        : (value.trim() === '' ? carry : preserved);
                    row[x] = {
                        ...(cell ?? { value: ' ' }),
                        value,
                        styles: [...effective, selectionBg],
                    };
                }
                // Trailing spaces are padding on a logical-line END, but at a
                // soft-wrap boundary the break-point whitespace is the word
                // separator (wrap-ansi keeps it on the head's tail or the
                // continuation's lead). When the NEXT selected row continues this
                // one, COLLAPSE the trailing run to a single space rather than
                // trimming it: this preserves the one word-separator space while
                // discarding the full-width padding blanks, so "alpha beta " +
                // "gamma" rejoins as "alpha beta gamma" (not "alpha beta   gamma").
                // Hard/char-wrap rows have no trailing space, so nothing is added.
                // Otherwise (logical-line end) trim trailing padding entirely.
                const nextIsCont = y + 1 <= y2 && rowSoftWrap[y + 1] === true;
                const rowOut = nextIsCont ? rowText.replace(/\s+$/u, ' ') : rowText.replace(/\s+$/u, '');
                selRowObjs.push({ y, text: rowOut, sw });
            }
            // [mixdog fork] Outer-trim the per-row harvest (same rule as
            // selectedText below) but UNCONDITIONALLY, keeping the absolute row
            // index per entry so the app can stitch rows across the viewport.
            while (selRowObjs.length > 0 && selRowObjs[0].text.trim() === '') {
                selRowObjs.shift();
            }
            while (selRowObjs.length > 0 && selRowObjs[selRowObjs.length - 1].text.trim() === '') {
                selRowObjs.pop();
            }
            selectionRows = selRowObjs;
            if (captureSelectedText) {
                // [mixdog fork] SOFT-WRAP JOIN (claude-code getSelectedText):
                // rejoin word-wrap continuation rows (sw = rowSoftWrap[y], set at
                // render/output build time from the wrapText call) onto their
                // logical source line WITHOUT a newline; only source/hard line
                // breaks emit '\n'. selRowObjs is already outer-trimmed above so
                // intentional interior blank rows (paragraph gaps) survive as
                // empty logical lines. Trailing whitespace is trimmed once per
                // logical-line end (mid-line separators kept by the harvest).
                const logical = [];
                for (const r of selRowObjs) {
                    if (r.sw && logical.length > 0) {
                        logical[logical.length - 1] += r.text;
                    }
                    else {
                        logical.push(r.text);
                    }
                }
                selectedText = logical.map(l => l.replace(/\s+$/u, '')).join('\n');
            }
        }
        // [mixdog fork] Snapshot per-row, column-indexed cell values so the App
        // can compute word boundaries (double-click select) without retaining
        // this Output instance, which is created fresh per render and discarded.
        // ALWAYS build this, even while a selection rect is active: gating it on
        // `!sel` froze the snapshot at the frame the first selection appeared, so
        // every later double-click read STALE cell rows (wrong/empty words) until
        // the selection cleared. Applying the selection above only rewrites cell
        // `styles`, never `value`, so reading `value` here stays correct.
        const plainRows = output.map((row) => (row || []).map((cell) => (cell?.value ?? '')));
        const generatedOutput = output
            .map(line => {
            // See https://github.com/vadimdemedes/ink/pull/564#issuecomment-1637022742
            // [mixdog fork] Keep the serialized row inside Output.width as a
            // final invariant. Component-level width budgeting can miss
            // background fills, resize races, or wide-char edge cases; if the
            // terminal receives a row wider than its modeled width it may
            // soft-wrap/scroll outside Ink's cursor-origin model.
            const lineWithinWidth = [];
            let usedWidth = 0;
            for (const item of line) {
                if (item === undefined) {
                    continue;
                }
                // A synthetic wide-cell placeholder is already included in
                // the leading glyph's modeled width. Emit a literal blank so WT's
                // cursor advances, but do not count that blank a second time.
                if (item.syntheticPad) {
                    lineWithinWidth.push({ ...item, value: ' ' });
                    continue;
                }
                const value = item.value ?? '';
                if (value === '') {
                    lineWithinWidth.push(item);
                    continue;
                }
                const itemWidth = Math.max(1, this.caches.getStringWidth(value));
                if (usedWidth + itemWidth > this.width) {
                    break;
                }
                lineWithinWidth.push(item);
                usedWidth += itemWidth;
            }
            // [mixdog fork] Per-row SGR reset. styledCharsToString emits sticky
            // SGR (color/dim/bold) but never a trailing reset, so a row that ends
            // mid-attribute leaks its state into the NEXT row when log-update's
            // incremental diff rewrites only changed rows (cursorTo(0)+row). That
            // makes unrelated text visibly dim/darken during drag-selection
            // repaints until a full repaint clears it. Terminate every row that
            // carries any escape with a single explicit reset so each emitted row
            // is self-contained. Reset ONCE at the row tail (not per cell) to
            // avoid double-reset flicker; plain rows stay untouched.
            const serialized = styledCharsToString(lineWithinWidth).trimEnd();
            if (!serialized.includes('\x1b['))
                return serialized;
            return /\x1b\[0?m$/.test(serialized) ? serialized : serialized + '\x1b[0m';
        })
            .join('\n');
        return {
            output: generatedOutput,
            height: output.length,
            cursor: this.cursor, // [mixdog fork] absolute cursor cell or null
            selectedText, // [mixdog fork] text inside the selection rect, or null
            plainRows, // [mixdog fork] column-indexed cell values per row for word lookup
            selectionRows, // [mixdog fork] per-row {y, text} selection harvest, or null
        };
    }
}
//# sourceMappingURL=output.js.map
