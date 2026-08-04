import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
import { cursorPositionChanged, buildCursorSuffix, buildCursorOnlySequence, buildReturnToBottomPrefix, hideCursorEscape, } from './cursor-helpers.js';
// [mixdog debug] Opt-in per-write frame trace (MIXDOG_INK_FRAME_LOG=<file>).
// One JSON line per physical stream write with the branch taken and exact
// bytes. Zero cost when unset.
import { appendFileSync } from 'node:fs';
const FRAME_LOG_PATH = process.env.MIXDOG_INK_FRAME_LOG || '';
export const frameLog = (entry) => {
    if (!FRAME_LOG_PATH) return;
    try {
        appendFileSync(FRAME_LOG_PATH, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
    }
    catch { }
};
// Count visible lines in a string, ignoring the trailing empty element
// that `split('\n')` produces when the string ends with '\n'.
const visibleLineCount = (lines, str) => str.endsWith('\n') ? lines.length - 1 : lines.length;
// Mirror ink.js isWindowsConsole — WT buffer scroll/wrap desync breaks relative walks.
const isWindowsConsole = process.platform === 'win32' || Boolean(process.env.WT_SESSION);
// [mixdog fork] Cursor movement must use the terminal's real post-write origin
// line. Fullscreen frames omit the trailing newline to avoid Windows Terminal
// scrolling, so their origin is the last visible line instead of the line after it.
const createStandard = (stream, { showCursor = false } = {}) => {
    let previousLineCount = 0;
    let previousOutput = '';
    let hasHiddenCursor = false;
    let cursorPosition;
    let cursorDirty = false;
    let previousCursorPosition;
    let cursorWasShown = false;
    const getActiveCursor = () => (cursorDirty ? cursorPosition : undefined);
    const hasChanges = (str, activeCursor) => {
        const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
        return str !== previousOutput || cursorChanged;
    };
    const render = (str) => {
        if (!showCursor && !hasHiddenCursor) {
            cliCursor.hide(stream);
            hasHiddenCursor = true;
        }
        // Only use cursor if setCursorPosition was called since last render.
        // This ensures stale positions don't persist after component unmount.
        const activeCursor = getActiveCursor();
        cursorDirty = false;
        const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
        if (!hasChanges(str, activeCursor)) {
            return false;
        }
        const lines = str.split('\n');
        const visibleCount = visibleLineCount(lines, str);
        const cursorOriginLine = Math.max(0, lines.length - 1);
        const cursorSuffix = buildCursorSuffix(visibleCount, activeCursor, cursorOriginLine);
        if (str === previousOutput && cursorChanged) {
            stream.write(buildCursorOnlySequence({
                cursorWasShown,
                previousLineCount,
                previousCursorPosition,
                visibleLineCount: visibleCount,
                cursorOriginLine,
                cursorPosition: activeCursor,
            }));
        }
        else {
            previousOutput = str;
            const returnPrefix = buildReturnToBottomPrefix(cursorWasShown, previousLineCount, previousCursorPosition);
            stream.write(returnPrefix +
                ansiEscapes.eraseLines(previousLineCount) +
                str +
                cursorSuffix);
            previousLineCount = lines.length;
        }
        previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
        cursorWasShown = activeCursor !== undefined;
        return true;
    };
    render.clear = () => {
        const prefix = buildReturnToBottomPrefix(cursorWasShown, previousLineCount, previousCursorPosition);
        // [mixdog fork] Reset SGR before erasing so stale style/background from
        // the previous frame doesn't leak onto the cleared cells.
        stream.write(prefix + '\u001B[0m' + ansiEscapes.eraseLines(previousLineCount));
        previousOutput = '';
        previousLineCount = 0;
        previousCursorPosition = undefined;
        cursorWasShown = false;
    };
    render.done = () => {
        previousOutput = '';
        previousLineCount = 0;
        previousCursorPosition = undefined;
        cursorWasShown = false;
        if (!showCursor) {
            cliCursor.show(stream);
            hasHiddenCursor = false;
        }
    };
    render.reset = () => {
        previousOutput = '';
        previousLineCount = 0;
        previousCursorPosition = undefined;
        cursorWasShown = false;
    };
    render.sync = (str) => {
        const activeCursor = cursorDirty ? cursorPosition : undefined;
        cursorDirty = false;
        const lines = str.split('\n');
        previousOutput = str;
        previousLineCount = lines.length;
        if (!activeCursor && cursorWasShown) {
            stream.write(hideCursorEscape);
        }
        if (activeCursor) {
            stream.write(buildCursorSuffix(visibleLineCount(lines, str), activeCursor, Math.max(0, lines.length - 1)));
        }
        previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
        cursorWasShown = activeCursor !== undefined;
    };
    render.setCursorPosition = (position) => {
        cursorPosition = position;
        cursorDirty = true;
    };
    render.isCursorDirty = () => cursorDirty;
    render.willRender = (str) => hasChanges(str, getActiveCursor());
    return render;
};
const createIncremental = (stream, { showCursor = false } = {}) => {
    let previousLines = [];
    let previousOutput = '';
    let hasHiddenCursor = false;
    let cursorPosition;
    let cursorDirty = false;
    let previousCursorPosition;
    let cursorWasShown = false;
    const getActiveCursor = () => (cursorDirty ? cursorPosition : undefined);
    const hasChanges = (str, activeCursor) => {
        const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
        return str !== previousOutput || cursorChanged;
    };
    const render = (str) => {
        if (!showCursor && !hasHiddenCursor) {
            cliCursor.hide(stream);
            hasHiddenCursor = true;
        }
        // Only use cursor if setCursorPosition was called since last render.
        // This ensures stale positions don't persist after component unmount.
        const activeCursor = getActiveCursor();
        cursorDirty = false;
        const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
        if (!hasChanges(str, activeCursor)) {
            return false;
        }
        const nextLines = str.split('\n');
        const visibleCount = visibleLineCount(nextLines, str);
        const cursorOriginLine = Math.max(0, nextLines.length - 1);
        const previousVisible = visibleLineCount(previousLines, previousOutput);
        if (str === previousOutput && cursorChanged) {
            stream.write(buildCursorOnlySequence({
                cursorWasShown,
                previousLineCount: previousLines.length,
                previousCursorPosition,
                visibleLineCount: visibleCount,
                cursorOriginLine,
                cursorPosition: activeCursor,
            }));
            previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
            cursorWasShown = activeCursor !== undefined;
            return true;
        }
        const returnPrefix = buildReturnToBottomPrefix(cursorWasShown, previousLines.length, previousCursorPosition);
        if (str === '\n' || previousOutput.length === 0) {
            const cursorSuffix = buildCursorSuffix(visibleCount, activeCursor, cursorOriginLine);
            stream.write(returnPrefix +
                ansiEscapes.eraseLines(previousLines.length) +
                str +
                cursorSuffix);
            cursorWasShown = activeCursor !== undefined;
            previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
            previousOutput = str;
            previousLines = nextLines;
            return true;
        }
        const hasTrailingNewline = str.endsWith('\n');
        const useWindowsFullscreenSafe = isWindowsConsole && !hasTrailingNewline;
        frameLog({
            src: 'log-update',
            branch: useWindowsFullscreenSafe ? 'wt-safe' : 'relative-walk',
            visibleCount,
            previousVisible,
            prevLineCount: previousLines.length,
            hasTrailingNewline,
            prevTrailingNewline: previousOutput.endsWith('\n'),
        });
        // We aggregate all chunks for incremental rendering into a buffer, and then write them to stdout at the end.
        const buffer = [];
        buffer.push(returnPrefix);
        // Clear extra lines if the current content's line count is lower than the previous.
        if (visibleCount < previousVisible) {
            const previousHadTrailingNewline = previousOutput.endsWith('\n');
            const extraSlot = previousHadTrailingNewline ? 1 : 0;
            // [mixdog fork] Defensive erase on height shrink: clear ONE extra
            // physical line beyond the counted delta. A hardware line-wrap (wide
            // glyph at the viewport edge) can occupy a physical row the logical
            // line count doesn't account for, leaving a ghost row below the new
            // content. Not Windows-specific — the wrap desync happens on any
            // terminal. We erase the extra line with eraseLine at the current
            // (bottom) row FIRST — this does NOT move the cursor — then run the
            // normal eraseLines walk. This keeps the post-erase cursor origin
            // identical to upstream (cursorUp(visibleCount) still lands right),
            // so only a stray trailing row is removed, layout is untouched.
            buffer.push(ansiEscapes.eraseLine, ansiEscapes.eraseLines(previousVisible - visibleCount + extraSlot), ansiEscapes.cursorUp(visibleCount));
        }
        else if (!useWindowsFullscreenSafe) {
            buffer.push(ansiEscapes.cursorUp(previousLines.length - 1));
        }
        for (let i = 0; i < visibleCount; i++) {
            const isLastLine = i === visibleCount - 1;
            if (useWindowsFullscreenSafe) {
                // Absolute addressing means skipping an unchanged row cannot
                // desync the walk — keep the anti-flicker skip here too. The
                // cursor is parked on the origin row after the loop so the
                // relative-up cursorSuffix math stays valid.
                if (nextLines[i] === previousLines[i]) {
                    continue;
                }
                buffer.push(ansiEscapes.cursorTo(0, i) +
                    nextLines[i] +
                    ansiEscapes.eraseEndLine +
                    (isLastLine ? '' : '\n'));
                continue;
            }
            // We do not write lines if the contents are the same. This prevents flickering during renders.
            if (nextLines[i] === previousLines[i]) {
                // Don't move past the last line when there's no trailing newline,
                // otherwise the cursor overshoots the rendered block.
                if (!isLastLine || hasTrailingNewline) {
                    buffer.push(ansiEscapes.cursorNextLine);
                }
                continue;
            }
            buffer.push(ansiEscapes.cursorTo(0) +
                nextLines[i] +
                ansiEscapes.eraseEndLine +
                // Don't append newline after the last line when the input
                // has no trailing newline (fullscreen mode).
                (isLastLine && !hasTrailingNewline ? '' : '\n'));
        }
        if (useWindowsFullscreenSafe) {
            // Land the cursor on the origin (last) row regardless of which rows
            // were skipped, so buildCursorSuffix's relative moveUp is correct.
            buffer.push(ansiEscapes.cursorTo(0, Math.max(0, visibleCount - 1)));
        }
        const cursorSuffix = buildCursorSuffix(visibleCount, activeCursor, cursorOriginLine);
        buffer.push(cursorSuffix);
        const joined = buffer.join('');
        frameLog({ src: 'log-update', branch: 'write', bytes: joined });
        stream.write(joined);
        cursorWasShown = activeCursor !== undefined;
        previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
        previousOutput = str;
        previousLines = nextLines;
        return true;
    };
    render.clear = () => {
        const prefix = buildReturnToBottomPrefix(cursorWasShown, previousLines.length, previousCursorPosition);
        // [mixdog fork] Reset SGR before erasing so stale style/background from
        // the previous frame doesn't leak onto the cleared cells.
        stream.write(prefix + '\u001B[0m' + ansiEscapes.eraseLines(previousLines.length));
        previousOutput = '';
        previousLines = [];
        previousCursorPosition = undefined;
        cursorWasShown = false;
    };
    render.done = () => {
        previousOutput = '';
        previousLines = [];
        previousCursorPosition = undefined;
        cursorWasShown = false;
        if (!showCursor) {
            cliCursor.show(stream);
            hasHiddenCursor = false;
        }
    };
    render.reset = () => {
        previousOutput = '';
        previousLines = [];
        previousCursorPosition = undefined;
        cursorWasShown = false;
    };
    render.sync = (str) => {
        const activeCursor = cursorDirty ? cursorPosition : undefined;
        cursorDirty = false;
        const lines = str.split('\n');
        previousOutput = str;
        previousLines = lines;
        if (!activeCursor && cursorWasShown) {
            stream.write(hideCursorEscape);
        }
        if (activeCursor) {
            stream.write(buildCursorSuffix(visibleLineCount(lines, str), activeCursor, Math.max(0, lines.length - 1)));
        }
        previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
        cursorWasShown = activeCursor !== undefined;
    };
    render.setCursorPosition = (position) => {
        cursorPosition = position;
        cursorDirty = true;
    };
    render.isCursorDirty = () => cursorDirty;
    render.willRender = (str) => hasChanges(str, getActiveCursor());
    return render;
};
const create = (stream, { showCursor = false, incremental = false } = {}) => {
    if (incremental) {
        return createIncremental(stream, { showCursor });
    }
    return createStandard(stream, { showCursor });
};
const logUpdate = { create };
export default logUpdate;
//# sourceMappingURL=log-update.js.map