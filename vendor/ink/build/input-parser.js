/**
 * input-parser.js — thin adapter over the termio state-machine pipeline.
 *
 * The naive per-chunk escape scanner that used to live here was replaced by the
 * claude-code termio tokenizer + keypress parser (termio-tokenize.js /
 * termio-keypress.js). This adapter keeps the createInputParser() shape App.js
 * expects, but push() now returns typed ParsedInput events (kind: 'key' |
 * 'mouse' | 'response') instead of raw strings / { paste } objects. App.js's
 * handleReadable dispatches those onto the input/paste/mouse/terminal-response
 * channels.
 */
import { parseMultipleKeypresses, INITIAL_STATE } from './termio-keypress.js';
const escape = '\u001B';
const pasteStart = '\u001B[200~';
export const createInputParser = () => {
    let state = { ...INITIAL_STATE };
    return {
        push(chunk) {
            const [events, next] = parseMultipleKeypresses(state, chunk);
            state = next;
            return events;
        },
        flush() {
            const [events, next] = parseMultipleKeypresses(state, null);
            state = next;
            return events;
        },
        hasPendingEscape() {
            // Arm the lone-ESC flush timer when a bare ESC / partial escape
            // sequence is buffered — but NOT while assembling a paste-start
            // marker or buffering paste body, which complete on their own and
            // must never flush as literal input.
            const pending = state.incomplete;
            return (state.mode !== 'IN_PASTE' &&
                pending.startsWith(escape) &&
                // Suppress ONLY while assembling the exact paste-start marker
                // (`\u001B[200~`) or its penultimate prefix (`\u001B[200`) —
                // both complete on their own and must never flush as literal
                // input. Any other partial escape (`\x1b[`, `\x1b[2`, `\x1b[20`,
                // …) is a generic partial CSI and must still arm the lone-ESC
                // flush so it doesn't buffer indefinitely.
                !pending.startsWith(pasteStart) &&
                pending !== '\u001B[200');
        },
        flushPendingEscape() {
            // Force the tokenizer to emit its buffered incomplete sequence as a
            // key event (typically a lone Escape), matching the old 20ms-delay
            // lone-ESC flush. Returns the ParsedInput events, or undefined when
            // nothing floppable is pending.
            const pending = state.incomplete;
            if (state.mode === 'IN_PASTE' || !pending.startsWith(escape)) {
                return undefined;
            }
            const [events, next] = parseMultipleKeypresses(state, null);
            state = next;
            return events.length > 0 ? events : undefined;
        },
        reset() {
            state = { ...INITIAL_STATE };
        },
    };
};
//# sourceMappingURL=input-parser.js.map
