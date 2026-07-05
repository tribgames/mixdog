import ansiEscapes from 'ansi-escapes';
const showCursorEscape = '\u001B[?25h';
const hideCursorEscape = '\u001B[?25l';
export { showCursorEscape, hideCursorEscape };
/**
Compare two cursor positions. Returns true if they differ.
*/
export const cursorPositionChanged = (a, b) => a?.x !== b?.x || a?.y !== b?.y;
/**
Build escape sequence to move cursor from the output cursor-origin line to the target position and show it.

[mixdog fork] Most Ink frames end with a trailing newline, so the terminal cursor
rests just after the last visible output line (origin line = visibleLineCount).
Fullscreen frames intentionally omit that trailing newline to avoid scrolling
Windows Terminal/conhost, so the cursor rests on the last visible output line
(origin line = visibleLineCount - 1). Keep the origin explicit to avoid parking
the hardware cursor one row too high in fullscreen input bars.
*/
export const buildCursorSuffix = (visibleLineCount, cursorPosition, cursorOriginLine = visibleLineCount) => {
    if (!cursorPosition) {
        return '';
    }
    const moveUp = Math.max(0, cursorOriginLine - cursorPosition.y);
    return ((moveUp > 0 ? ansiEscapes.cursorUp(moveUp) : '') +
        ansiEscapes.cursorTo(cursorPosition.x) +
        showCursorEscape);
};
/**
Build escape sequence to move cursor from previousCursorPosition back to the bottom of output.
This must be done before eraseLines or any operation that assumes cursor is at the bottom.
*/
export const buildReturnToBottom = (previousLineCount, previousCursorPosition) => {
    if (!previousCursorPosition) {
        return '';
    }
    // PreviousLineCount includes trailing newline, so visible lines = previousLineCount - 1
    // cursor is at previousCursorPosition.y, need to go to line (previousLineCount - 1)
    const down = previousLineCount - 1 - previousCursorPosition.y;
    return ((down > 0 ? ansiEscapes.cursorDown(down) : '') + ansiEscapes.cursorTo(0));
};
/**
Build the escape sequence for cursor-only updates (output unchanged, cursor moved).
Hides cursor if it was previously shown, returns to bottom, then repositions.
*/
export const buildCursorOnlySequence = (input) => {
    const hidePrefix = input.cursorWasShown ? hideCursorEscape : '';
    const returnToBottom = buildReturnToBottom(input.previousLineCount, input.previousCursorPosition);
    const cursorSuffix = buildCursorSuffix(input.visibleLineCount, input.cursorPosition, input.cursorOriginLine);
    return hidePrefix + returnToBottom + cursorSuffix;
};
/**
Build the prefix that hides cursor and returns to bottom before erasing or rewriting.
Returns empty string if cursor was not shown.
*/
export const buildReturnToBottomPrefix = (cursorWasShown, previousLineCount, previousCursorPosition) => {
    if (!cursorWasShown) {
        return '';
    }
    return (hideCursorEscape +
        buildReturnToBottom(previousLineCount, previousCursorPosition));
};
//# sourceMappingURL=cursor-helpers.js.map