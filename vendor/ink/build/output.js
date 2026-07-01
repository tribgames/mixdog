import sliceAnsi from 'slice-ansi';
import { styledCharsFromTokens, styledCharsToString, tokenize, } from '@alcalzone/ansi-tokenize';
// [mixdog fork] use the shared display-width policy so ink's per-character
// advance + width cache treat circled digits / arrows as 2 cells under Windows
// Terminal, matching OUR wrap/row math. See display-width.js (kept in sync with
// src/tui/display-width.mjs).
import { displayStringWidth as stringWidth } from './display-width.js';
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
        const { transformers } = options;
        if (!text) {
            return;
        }
        this.operations.push({
            type: 'write',
            x,
            y,
            text,
            transformers,
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
        const clips = [];
        for (const operation of this.operations) {
            if (operation.type === 'clip') {
                clips.push(operation.clip);
            }
            if (operation.type === 'unclip') {
                clips.pop();
            }
            if (operation.type === 'write') {
                const { text, transformers } = operation;
                let { x, y } = operation;
                let lines = text.split('\n');
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
                            return sliceAnsi(line, from, to);
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
                        // For multi-column characters, clear following cells to avoid stray spaces/artifacts
                        if (characterWidth > 1) {
                            for (let index = 1; index < characterWidth; index++) {
                                currentLine[offsetX + index] = {
                                    type: 'char',
                                    value: '',
                                    fullWidth: false,
                                    styles: character.styles,
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
            // A style entry sets the background when its opening SGR code begins
            // with a background parameter: 40-47 (basic), 48 (256/truecolor),
            // 49 (default), or 100-107 (bright). ansi-tokenize emits one entry
            // per SGR attribute, so a prefix test on `.code` cleanly isolates the
            // bg-only entries we want to drop before appending the selection bg.
            const isBackgroundStyle = (s) => typeof s?.code === 'string' && /^\x1b\[(?:4[0-9]|10[0-7])[;m]/.test(s.code);
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
            const selRows = captureSelectedText ? [] : null;
            for (let y = y1; y <= y2; y++) {
                const row = output[y];
                if (!row) {
                    if (captureSelectedText) {
                        selRows.push('');
                    }
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
                let contentStart = -1;
                let contentEnd = -1;
                for (let x = x1; x <= x2; x++) {
                    const value = row[x]?.value ?? '';
                    if (value && !/^\s$/u.test(value)) {
                        if (contentStart === -1) {
                            contentStart = x;
                        }
                        contentEnd = x;
                    }
                }
                let rowText = '';
                for (let x = x1; x <= x2; x++) {
                    const cell = row[x];
                    if (!cell) {
                        continue;
                    }
                    // Collect the visible glyph. Wide-char trailing placeholders
                    // carry value '' and contribute nothing, which is correct.
                    if (captureSelectedText) {
                        rowText += cell.value ?? '';
                    }
                    if (contentStart === -1 || x < contentStart || x > contentEnd) {
                        continue;
                    }
                    // [mixdog fork] fg-preserving highlight: keep the cell's own
                    // style entries (foreground color, bold/dim/underline, link
                    // attrs) and swap ONLY the background. Drop any existing
                    // background entry so the two bgs don't fight, then append the
                    // selection bg last so it wins for this cell.
                    const baseStyles = Array.isArray(cell.styles) ? cell.styles : [];
                    const preserved = baseStyles.filter(style => !isBackgroundStyle(style));
                    row[x] = {
                        ...cell,
                        styles: [...preserved, selectionBg],
                    };
                }
                // Trailing spaces in a selected row are padding, not content.
                if (captureSelectedText) {
                    selRows.push(rowText.replace(/\s+$/u, ''));
                }
            }
            if (captureSelectedText) {
                // Blank edge rows come from selecting through padded alt-screen
                // space around rendered content. Native terminal selection does
                // not paste those as leading/trailing empty lines, so trim only
                // the outer empty rows and preserve intentional blank rows inside.
                while (selRows.length > 0 && selRows[0].trim() === '') {
                    selRows.shift();
                }
                while (selRows.length > 0 && selRows[selRows.length - 1].trim() === '') {
                    selRows.pop();
                }
                // [mixdog fork] SOFT-WRAP JOIN (claude-code getSelectedText):
                // claude-code rejoins word-wrapped continuation rows into one
                // logical line using screen.softWrap, a per-row bitmap set at
                // wrap time marking a row as a continuation of the one above.
                // mixdog's rect(linear) render model carries NO softWrap metadata
                // — the Output grid is a flat array of visual rows with no record
                // of which line breaks were inserted by wrapping vs. present in
                // the source. Detecting "this row filled to content width AND the
                // next continues the same logical block" from cell values alone is
                // a guess (a source line that legitimately fills the width would be
                // wrongly glued to the next). Per the correctness-over-cleverness
                // rule we keep the honest per-visual-row '\n' join rather than
                // fabricate wrap boundaries. Revisit if the render pipeline starts
                // emitting a softWrap bit per row.
                selectedText = selRows.join('\n');
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
            return styledCharsToString(lineWithinWidth).trimEnd();
        })
            .join('\n');
        return {
            output: generatedOutput,
            height: output.length,
            cursor: this.cursor, // [mixdog fork] absolute cursor cell or null
            selectedText, // [mixdog fork] text inside the selection rect, or null
            plainRows, // [mixdog fork] column-indexed cell values per row for word lookup
        };
    }
}
//# sourceMappingURL=output.js.map
