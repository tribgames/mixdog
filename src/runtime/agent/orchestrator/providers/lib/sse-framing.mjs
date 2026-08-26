/**
 * sse-framing.mjs — shared SSE record framing for provider streams.
 *
 * One network chunk carries many SSE records. Splitting it into an array of
 * lines and then awaiting one JSON parse per record turned a single readable
 * chunk into O(records) allocations plus O(records) microtask hops on the
 * shared daemon event loop. These helpers frame a chunk in a single scan with
 * no per-line array, and they are pure so the exact same code runs inline on
 * the event loop and inside the provider stream worker (a worker failure can
 * therefore always be re-run inline with identical results).
 *
 * Framing rules are byte-identical to the previous inline Anthropic loop:
 *   - `:`-prefixed lines are comment/keepalive frames and are dropped.
 *   - blank lines are record separators and are dropped.
 *   - `event: ` sets the current event name, which persists (across chunks)
 *     until the next `event: ` line.
 *   - `data: ` payloads are trimmed; empty payloads are dropped.
 *   - any other line is ignored.
 * CRLF transports behave as before: the trailing `\r` is removed by trim() on
 * the value lines, and a bare `\r` line matches no prefix and is ignored.
 */

const COLON_CODE = 58; // ':'

/**
 * Split a decoded buffer into the complete-record region and the residual
 * partial line. Equivalent to `const lines = buffer.split('\n'); buffer = lines.pop()`
 * without materializing the line array.
 */
export function splitSseRegion(buffer) {
    const cut = buffer.lastIndexOf('\n');
    if (cut < 0) return { region: '', rest: buffer };
    return { region: buffer.slice(0, cut + 1), rest: buffer.slice(cut + 1) };
}

/**
 * Frame a complete-record region into ordered `{ name, data }` records.
 * `currentEvent` carries the last `event:` name into and out of the region so
 * a record split across network chunks keeps its event name.
 */
export function frameSseRegion(text, currentEvent = '') {
    const frames = [];
    let name = String(currentEvent || '');
    const length = text.length;
    let index = 0;
    while (index < length) {
        let end = text.indexOf('\n', index);
        if (end < 0) end = length;
        const start = index;
        index = end + 1;
        if (end === start) continue; // record separator
        if (text.charCodeAt(start) === COLON_CODE) continue; // comment / ping keepalive
        if (text.startsWith('event: ', start)) {
            name = text.slice(start + 7, end).trim();
            continue;
        }
        if (!text.startsWith('data: ', start)) continue;
        const data = text.slice(start + 6, end).trim();
        if (!data) continue;
        frames.push({ name, data });
    }
    return { frames, currentEvent: name };
}

/**
 * Parse framed records with per-record error isolation. A malformed record
 * must never discard the well-formed records batched beside it: the consumer
 * skips entries that carry `error` exactly like the previous per-event
 * try/catch did.
 */
export function parseSseFrames(frames) {
    const events = [];
    for (const frame of frames) {
        try {
            events.push({ name: frame.name, value: JSON.parse(frame.data) });
        } catch (error) {
            events.push({
                name: frame.name,
                error: {
                    name: String(error?.name || 'SyntaxError'),
                    message: String(error?.message || error || 'invalid JSON'),
                },
            });
        }
    }
    return events;
}

/** Frame + parse in one pass (the unit of work posted to the stream worker). */
export function frameAndParseSse(text, currentEvent = '') {
    const framed = frameSseRegion(text, currentEvent);
    return { events: parseSseFrames(framed.frames), currentEvent: framed.currentEvent };
}
