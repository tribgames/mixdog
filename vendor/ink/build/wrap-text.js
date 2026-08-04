import wrapAnsi from 'wrap-ansi';
import cliTruncate from 'cli-truncate';
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { AMBIGUOUS_WIDE, displayStringWidth } from './display-width.js';
const cache = {};
// [mixdog fork] wrap-ansi / cli-truncate measure with plain string-width, which
// counts our problem glyphs (circled digits U+2460–U+24FF, arrows U+2190–U+21FF)
// as 1 cell while the terminal draws 2. When the policy is ON, their column math
// under-counts and a wrapped/truncated line can still overflow by one cell,
// pushing content past the box edge (the ghosting/overlap). We can't cleanly
// fork wrap-ansi, so we compensate at THIS boundary: re-check each produced line
// with displayStringWidth. For wrap/hard modes the overflow is REFLOWED onto a
// new line (no visible content is dropped); only truncate-end may cut.
const PROBLEM_RE = /[\u2190-\u21ff\u2460-\u24ff]/;
const ANSI_RE = /^\u001B(?:\[[0-9;]*m|\].*?(?:\u0007|\u001B\\))/;
const segmenter = new Intl.Segmenter();
// SGR reset — appended after a mid-line cut so an open style doesn't leak past
// the split point onto the reflowed remainder / following cells.
const SGR_RESET = '\u001B[0m';
// OSC 8 hyperlink open (with a URL) and universal close. Cutting inside a link
// must close it on head and re-open it on tail, exactly like an open SGR style.
const OSC8_CLOSE = '\u001B]8;;\u0007';
const OSC8_RE = /^\u001B\]8;([^\u0007\u001B]*);([^\u0007\u001B]*)(?:\u0007|\u001B\\)/;
// Split one ANSI line at the first grapheme boundary where VISIBLE displayWidth
// would exceed `max`. Walks grapheme CLUSTERS (not code points) so a clustered
// glyph (e.g. `↔️` = U+2194 U+FE0F) is measured/kept whole. Returns
// { head, tail }: head fits within max (with an SGR reset appended when any
// style is still open at the cut so styling doesn't bleed); tail is the
// remaining visible content, prefixed with the carried-over open SGR codes so
// it renders with the same style it was cut from. ANSI escapes cost 0 width.
const splitAtDisplayWidth = (line, max, forceFirst = true) => {
    if (displayStringWidth(line) <= max)
        return { head: line, tail: '' };
    let head = '';
    let width = 0;
    let rest = line;
    // Track SGR open codes seen so far so the tail can re-open them. An empty
    // params reset ('' or '0') clears the carry; anything else accumulates.
    let openSgr = '';
    let sawOpenStyle = false;
    // Track an open OSC 8 hyperlink (empty URL '...8;;\u0007' closes it).
    let openLink = '';
    while (rest.length > 0) {
        const m = ANSI_RE.exec(rest);
        if (m) {
            head += m[0];
            const sgr = /^\u001B\[([0-9;]*)m$/.exec(m[0]);
            if (sgr) {
                const params = sgr[1];
                if (params === '' || params === '0') {
                    openSgr = '';
                    sawOpenStyle = false;
                }
                else {
                    openSgr += m[0];
                    sawOpenStyle = true;
                }
            }
            else {
                const osc = OSC8_RE.exec(m[0]);
                if (osc)
                    // Preserve the complete OSC 8 opener, including optional
                    // params such as `id=x`, when carrying a link to the tail.
                    openLink = osc[2] ? m[0] : '';
            }
            rest = rest.slice(m[0].length);
            continue;
        }
        const { segment } = segmenter.segment(rest)[Symbol.iterator]().next().value;
        const w = displayStringWidth(segment);
        // Progress guarantee: if nothing visible has landed on head yet, force
        // the first grapheme through even when it alone exceeds max (a 1-cluster
        // overflow is unavoidable and preferable to a zero-progress loop).
        if (width + w > max && (width > 0 || !forceFirst))
            break;
        head += segment;
        width += w;
        rest = rest.slice(segment.length);
    }
    // Close any style / link still open at the cut, and re-open on the tail.
    if (openLink)
        head += OSC8_CLOSE;
    if (sawOpenStyle)
        head += SGR_RESET;
    const carry = openSgr + openLink;
    const tail = rest.length > 0 ? carry + rest : '';
    return { head, tail };
};
// wrap/hard: no visible content may be dropped. Repeatedly split each produced
// line at the display-width budget and REFLOW the overflow onto following lines.
const reflowToDisplayWidth = (line, max) => {
    const out = [];
    let cur = line;
    while (displayStringWidth(cur) > max) {
        const { head, tail } = splitAtDisplayWidth(cur, max);
        // splitAtDisplayWidth now always advances (forces >=1 grapheme onto
        // head), so head carries visible content and tail shrinks each pass.
        // Belt-and-braces: if tail failed to shrink, flush the remainder. Push
        // `head` (not raw `cur`) — head carries the SGR/OSC8 close sequences, so
        // even a single overwide styled/linked glyph doesn't leak its style.
        if (tail === '' || tail === cur) {
            out.push(head || cur);
            return out;
        }
        out.push(head);
        cur = tail;
    }
    out.push(cur);
    return out;
};
// truncate-end: cutting is the intended behavior — drop the overflow but still
// cut on grapheme boundaries and close open styles.
const hardCutToDisplayWidth = (line, max) => splitAtDisplayWidth(line, max).head;
// Clipping cannot use wrapping's progress guarantee: a two-cell grapheme in a
// one-cell remainder must be dropped, never forced through the clip edge.
const strictCutToDisplayWidth = (line, max) => max <= 0
    ? ''
    : splitAtDisplayWidth(line, max, false).head;
// [mixdog fork] Policy-aware ANSI slice for Output's horizontal clipping.
// `slice-ansi` measures ambiguous glyphs with plain string-width, so its
// from/to columns drift whenever a clipped transcript row contains ①/②/③.
// Keep the same split primitive as wrapping so clipping and measurement use
// identical terminal-cell boundaries.
export const sliceTextByDisplayWidthWithPolicy = (line, from, to, wide) => {
    const start = Math.max(0, Math.floor(Number(from) || 0));
    const end = Math.max(start, Math.floor(Number(to) || 0));
    const source = String(line ?? '');
    const plain = stripAnsi(source);
    // Preserve exact upstream bytes (including its choice of SGR close code)
    // unless the active policy actually changes this line's measured width.
    // The broad trigger regex also contains ←/↑/→/↓ and ↻, which the true
    // policy deliberately excludes; a width-delta check keeps those lines on
    // slice-ansi's byte-identical path.
    if (!wide || displayStringWidth(plain) === stringWidth(plain))
        return sliceAnsi(source, start, end);
    if (end <= start)
        return '';
    let remainder = source;
    if (start > 0) {
        const prefix = splitAtDisplayWidth(remainder, start);
        remainder = prefix.tail;
        // If `start` lands inside a wide grapheme, consume that whole grapheme:
        // rendering half of it at x1 would still cross the left clip boundary.
        if (remainder && displayStringWidth(prefix.head) < start) {
            remainder = splitAtDisplayWidth(remainder, 1).tail;
        }
    }
    return strictCutToDisplayWidth(remainder, end - start);
};
export const sliceTextByDisplayWidth = (line, from, to) => sliceTextByDisplayWidthWithPolicy(line, from, to, AMBIGUOUS_WIDE);
// Re-enforce the display-width budget on every produced line when the policy is
// ON and the source contains a problem glyph. No-op otherwise (byte-identical
// to upstream wrap-ansi output), so terminals without the wide policy are
// unaffected.
const enforceDisplayWidth = (wrapped, maxWidth, mode) => {
    if (!AMBIGUOUS_WIDE || !PROBLEM_RE.test(stripAnsi(wrapped)))
        return wrapped;
    const lines = wrapped.split('\n');
    if (mode === 'truncate')
        return lines.map((line) => hardCutToDisplayWidth(line, maxWidth)).join('\n');
    // wrap/hard: reflow overflow, never drop.
    return lines.flatMap((line) => reflowToDisplayWidth(line, maxWidth)).join('\n');
};
const wrapText = (text, maxWidth, wrapType) => {
    const cacheKey = text + String(maxWidth) + String(wrapType);
    const cachedText = cache[cacheKey];
    if (cachedText) {
        return cachedText;
    }
    let wrappedText = text;
    if (wrapType === 'wrap') {
        wrappedText = wrapAnsi(text, maxWidth, {
            trim: false,
            hard: true,
        });
        wrappedText = enforceDisplayWidth(wrappedText, maxWidth, 'wrap');
    }
    if (wrapType === 'hard') {
        wrappedText = wrapAnsi(text, maxWidth, {
            trim: false,
            hard: true,
            wordWrap: false,
        });
        wrappedText = enforceDisplayWidth(wrappedText, maxWidth, 'wrap');
    }
    if (wrapType.startsWith('truncate')) {
        let position = 'end';
        if (wrapType === 'truncate-middle') {
            position = 'middle';
        }
        if (wrapType === 'truncate-start') {
            position = 'start';
        }
        wrappedText = cliTruncate(text, maxWidth, { position });
        if (position === 'end')
            wrappedText = enforceDisplayWidth(wrappedText, maxWidth, 'truncate');
    }
    cache[cacheKey] = wrappedText;
    return wrappedText;
};
export default wrapText;
//# sourceMappingURL=wrap-text.js.map