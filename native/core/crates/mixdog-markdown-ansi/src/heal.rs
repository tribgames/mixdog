//! Healing of an unfinished markdown tail (`src/ui/streaming-markdown-heal.mjs`): the text of a stream is closed where
//! it is cut, so the renderer draws the style an unfinished token is going to have instead of the literal marker that
//! turns into it a delta later. Offsets are byte offsets of the text; the rules are the Node ones, regexes included
//! (they run on the engine of the lexer, which reads them as ECMAScript does).

use std::sync::LazyLock;

use mixdog_js::{is_js_space, js_trim, js_trim_end, utf16_len};
use mixdog_termtext::grapheme::utf16_to_byte;

use crate::lexer::rules::Re;

/// `isPendingLocalPath`: whether the final token of the text could still grow into a file link.
pub type PendingPath<'a> = Option<&'a dyn Fn(&str) -> bool>;

static FENCE_LINE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}(`{3,}|~{3,})(.*)$", ""));
static FENCED_BLOCK: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$", "m"));
static INLINE_CODE_SPAN: LazyLock<Re> = LazyLock::new(|| Re::new(r"`+[^`\n]*`+", ""));
static PENDING_BLOCK_MARKER_LINE: LazyLock<Re> = LazyLock::new(|| Re::new(r"(?:^|\n)[ \t]*(?:[-+*=_#>~`]+|\d{1,9}[.)]?)[ \t]*$", ""));
static PARTIAL_CLOSING_FENCE: LazyLock<Re> = LazyLock::new(|| Re::new(r"(?:^|\r?\n) {0,3}([`~]+)$", ""));
static LINK_LIST_PREFIX: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}(?:[-+*]|\d+[.)])\s+$", ""));
static PIPE_ROW: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}\|", ""));
static DELIMITER_ROW: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$", ""));
static PARTIAL_DELIMITER_ROW: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}\|?[\s:|-]*$", ""));
static BLANK_LINE: LazyLock<Re> = LazyLock::new(|| Re::new(r"\n[ \t]*\r?\n", ""));
static LAST_WORD: LazyLock<Re> = LazyLock::new(|| Re::new(r"\S+$", ""));

/// The next character of `text` at byte `at`, if `at` is a boundary inside it.
fn char_at(text: &str, at: usize) -> Option<char> {
    text.get(at..)?.chars().next()
}

fn char_before(text: &str, at: usize) -> Option<char> {
    text.get(..at)?.chars().next_back()
}

/// The length of the character at `at`; what a backslash escape skips along with the backslash.
fn escaped_len(text: &str, at: usize) -> usize {
    char_at(text, at).map_or(0, char::len_utf8)
}

/// `MARKDOWN_PUNCTUATION`: `[!-/:-@[-`{-~¡-¿‐-‧‰-⁞]`.
fn is_markdown_punctuation(c: char) -> bool {
    matches!(c, '!'..='/' | ':'..='@' | '['..='`' | '{'..='~' | '\u{a1}'..='\u{bf}' | '\u{2010}'..='\u{2027}' | '\u{2030}'..='\u{205e}')
}

/// `isMarkdownSpace`: no character (an edge of the text) counts as a space.
fn is_markdown_space(c: Option<char>) -> bool {
    c.is_none_or(is_js_space)
}

struct OpenFence {
    marker: char,
    length: usize,
    start: usize,
}

/// `openFence(text)`: the fence the text ends inside of, line by line.
fn open_fence(text: &str) -> Option<OpenFence> {
    let mut open: Option<OpenFence> = None;
    let mut line_start = 0;
    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(fence) = FENCE_LINE.exec(line) {
            let marks = fence.get(1).unwrap_or("");
            let first = marks.chars().next().unwrap_or('`');
            match &open {
                None => open = Some(OpenFence { marker: first, length: marks.len(), start: line_start }),
                Some(current) => {
                    if first == current.marker && marks.len() >= current.length && js_trim(fence.get(2).unwrap_or("")).is_empty() {
                        open = None;
                    }
                }
            }
        }
        line_start += raw_line.len() + 1;
    }
    open
}

/// `trimPartialOpeningFence`: the opening fence line arrives a token at a time (``` then ```py then ```python), so the
/// card appears with its first code character instead of opening empty and being relabelled.
fn trim_partial_opening_fence<'a>(text: &'a str, fence: &OpenFence) -> &'a str {
    let line_end = text.get(fence.start..).and_then(|rest| rest.find('\n')).map(|at| at + fence.start);
    match line_end {
        Some(end) if text[end + 1..].chars().any(|c| !is_js_space(c)) => text,
        _ => text.get(..fence.start).unwrap_or(text),
    }
}

/// `trimPendingBlockMarker`: a last line holding only a block marker is held back until its first content character (a
/// lone `-` or `=` would turn the paragraph above into a heading, `2` is a lazy continuation until its `.` arrives).
fn trim_pending_block_marker(text: &str) -> &str {
    match PENDING_BLOCK_MARKER_LINE.exec(text) {
        None => text,
        Some(pending) => &text[..pending.start() + usize::from(pending.whole().starts_with('\n'))],
    }
}

/// `trimPartialClosingFence`: a closing fence shorter than the opening one is not code yet, and is not shown.
fn trim_partial_closing_fence<'a>(text: &'a str, fence: &OpenFence) -> &'a str {
    let Some(partial) = PARTIAL_CLOSING_FENCE.exec(text) else { return text };
    let run = partial.get(1).unwrap_or("");
    if run.is_empty() || !run.starts_with(fence.marker) || run.len() >= fence.length {
        return text;
    }
    &text[..partial.start()]
}

/// `closeInlineCode`.
fn close_inline_code(text: &str, pending: PendingPath<'_>) -> String {
    let bytes = text.as_bytes();
    let mut open = 0;
    let mut open_index = 0;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1 + escaped_len(text, index + 1),
            b'`' => {
                let mut end = index + 1;
                while end < bytes.len() && bytes[end] == b'`' {
                    end += 1;
                }
                let run = end - index;
                if open == 0 {
                    open = run;
                    open_index = index;
                } else if run == open {
                    open = 0;
                }
                index = end;
            }
            _ => index += 1,
        }
    }
    // An opener with nothing after it yet closes into an empty span, which parses as a literal backtick run that then
    // vanishes into code.
    if open > 0 {
        let after = &text[open_index + open..];
        if after.is_empty() || pending.is_some_and(|is_pending| is_pending(after)) {
            return text[..open_index].to_owned();
        }
        return format!("{text}{}", "`".repeat(open));
    }
    text.to_owned()
}

/// `maskCode`: fenced blocks and inline code spans written as spaces (newlines kept), byte for byte, so offsets found in
/// the mask are offsets of the text.
fn mask_code(text: &str) -> String {
    let blanked = |code: &str| -> String { code.chars().map(|c| if c == '\n' { "\n".to_owned() } else { " ".repeat(c.len_utf8()) }).collect() };
    let without_blocks = FENCED_BLOCK.replace_all(text, |block| blanked(block.whole()));
    INLINE_CODE_SPAN.replace_all(&without_blocks, |span| " ".repeat(span.whole().len()))
}

struct EmphasisRun {
    marker: u8,
    length: usize,
    can_open: bool,
    can_close: bool,
    at: usize,
    end: usize,
}

/// `scanEmphasisRuns`: the delimiter runs of `*`, `_` and `~` of a masked text, flanking as CommonMark has it.
fn scan_emphasis_runs(masked: &str) -> Vec<EmphasisRun> {
    let bytes = masked.as_bytes();
    let mut runs = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let marker = bytes[index];
        if marker == b'\\' {
            index += 1 + escaped_len(masked, index + 1);
            continue;
        }
        if !matches!(marker, b'*' | b'_' | b'~') {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        while end < bytes.len() && bytes[end] == marker {
            end += 1;
        }
        let length = end - index;
        let before = char_before(masked, index);
        let after = char_at(masked, end);
        let before_space = is_markdown_space(before);
        let after_space = is_markdown_space(after);
        let before_punctuation = before.is_some_and(is_markdown_punctuation);
        let after_punctuation = after.is_some_and(is_markdown_punctuation);
        let left = !after_space && (!after_punctuation || before_space || before_punctuation);
        let right = !before_space && (!before_punctuation || after_space || after_punctuation);
        runs.push(match marker {
            // A single tilde is inert, but at the end it may be half of `~~`.
            b'~' => EmphasisRun { marker, length: length.min(2), can_open: left && length >= 2, can_close: right && length >= 2, at: index, end },
            b'_' => EmphasisRun {
                marker,
                length,
                can_open: left && (!right || before_punctuation),
                can_close: right && (!left || after_punctuation),
                at: index,
                end,
            },
            _ => EmphasisRun { marker, length, can_open: left, can_close: right, at: index, end },
        });
        index = end;
    }
    runs
}

/// `closeEmphasis`: the closers of the emphasis still open at the end of the text, before its trailing whitespace.
fn close_emphasis(text: &str) -> String {
    let runs = scan_emphasis_runs(&mask_code(text));
    let last = runs.len().checked_sub(1);
    // (marker, length left to close)
    let mut open: Vec<(u8, usize)> = Vec::new();
    for (at, run) in runs.iter().enumerate() {
        let mut length = run.length;
        while run.can_close && length > 0 {
            let Some(found) = open.iter().rposition(|opener| opener.0 == run.marker) else { break };
            let used = open[found].1.min(length);
            open[found].1 -= used;
            length -= used;
            open.truncate(if open[found].1 > 0 { found + 1 } else { found });
        }
        // A run ending the text that closed nothing has no content after it yet: it painted as a literal `**` until the
        // next token turned it into style.
        if Some(at) == last && run.end == text.len() && length == run.length {
            return close_emphasis(&text[..run.at]);
        }
        if length > 0 && run.can_open {
            open.push((run.marker, length));
        }
    }
    // Closers go before trailing whitespace: `**word ` closed after the space could not close (a closing run must
    // follow non-space) and stayed literal.
    let body = js_trim_end(text);
    let closers: String = open.iter().rev().map(|opener| char::from(opener.0).to_string().repeat(opener.1.min(3))).collect();
    if closers.is_empty() {
        return text.to_owned();
    }
    format!("{body}{closers}{}", &text[body.len()..])
}

/// `linkDestinationEnd`: the `)` closing the link destination whose `(` is at `start`, if it has arrived.
fn link_destination_end(text: &str, start: usize) -> Option<usize> {
    let mut depth = 1usize;
    let mut delimiter: Option<char> = None;
    let mut chars = text[start + 1..].char_indices().map(|(at, c)| (at + start + 1, c));
    while let Some((index, c)) = chars.next() {
        if c == '\\' {
            chars.next();
            continue;
        }
        if let Some(close) = delimiter {
            if c == close {
                delimiter = None;
            }
            continue;
        }
        if c == '<' && js_trim(&text[start + 1..index]).is_empty() {
            delimiter = Some('>');
        } else if (c == '"' || c == '\'') && char_before(text, index).is_some_and(is_js_space) {
            delimiter = Some(c);
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

/// `healIncompleteLink`: the unfinished link or image at the end of the text closed as an inert link (an empty
/// destination: a streamed URL never becomes clickable before its closing parenthesis arrives), an image as its alt.
/// The outermost `[` still open at the end of `masked`, the `]` that closed it without a destination, and the bracket
/// depth left open.
fn open_link_bracket(masked: &str) -> (Option<usize>, Option<usize>, usize) {
    let bytes = masked.as_bytes();
    let mut open: Option<usize> = None;
    let mut depth = 0usize;
    let mut label: Option<usize> = None;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                index += 1 + escaped_len(masked, index + 1);
                continue;
            }
            b'[' => {
                if depth == 0 {
                    open = Some(index);
                }
                depth += 1;
            }
            b']' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    label = Some(index);
                    if bytes.get(index + 1) == Some(&b'(') {
                        match link_destination_end(masked, index + 1) {
                            None => break,
                            Some(end) => index = end,
                        }
                    } else if index == bytes.len() - 1 {
                        break;
                    }
                    open = None;
                    label = None;
                }
            }
            _ => {}
        }
        index += 1;
    }
    (open, label, depth)
}

fn heal_incomplete_link(text: &str, pending: PendingPath<'_>) -> String {
    let masked = mask_code(text);
    let bytes = masked.as_bytes();
    let (open, label, depth) = open_link_bracket(&masked);
    let Some(open) = open else { return text.to_owned() };
    let caption = &text[open + 1..label.unwrap_or(text.len())];
    // Footnotes and task boxes are not unfinished inline links.
    let line_start = text[..open].rfind('\n').map_or(0, |at| at + 1);
    let line_prefix = &text[line_start..open];
    if caption.starts_with('^') || caption.contains("\n\n") || (LINK_LIST_PREFIX.test(line_prefix) && matches!(caption, "" | " " | "x" | "X")) {
        return text.to_owned();
    }
    let image = open > 0 && bytes[open - 1] == b'!';
    let prefix = &text[..if image { open - 1 } else { open }];
    if image {
        return format!("{prefix}{caption}");
    }
    if label.is_none() && pending.is_some_and(|is_pending| is_pending(caption)) {
        return prefix.to_owned();
    }
    // Keep link typography from the first label token, including the `]` to `(` boundary.
    format!("{prefix}[{}{}]()", close_emphasis(caption), "]".repeat(depth.saturating_sub(1)))
}

/// `text.split(/(?<!\\)\|/)`: the pieces between the `|` that are not escaped.
pub(crate) fn split_unescaped_pipes(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut pieces = Vec::new();
    let mut start = 0;
    for (at, byte) in bytes.iter().enumerate() {
        if *byte == b'|' && (at == 0 || bytes[at - 1] != b'\\') {
            pieces.push(&text[start..at]);
            start = at + 1;
        }
    }
    pieces.push(&text[start..]);
    pieces
}

/// `tableCells(line)`: how many cells the row has, an empty edge cell (the leading or trailing pipe) not counted.
fn table_cell_count(line: &str) -> usize {
    let mut cells = split_unescaped_pipes(js_trim(line));
    if js_trim(cells[0]).is_empty() {
        cells.remove(0);
    }
    if cells.last().is_some_and(|cell| js_trim(cell).is_empty()) {
        cells.pop();
    }
    cells.len()
}

/// `hasCellPipe`: a cell separator outside inline code, so the line can head a table.
fn has_cell_pipe(line: &str) -> bool {
    let bare = INLINE_CODE_SPAN.replace_all(line, |_| String::new());
    split_unescaped_pipes(&bare).len() > 1
}

/// `trimPendingTableHead`: a table streams in as its header row, then its delimiter row a token at a time. Until the
/// delimiter is complete (with the header's cell count) the rows are a paragraph of raw pipes that would then lay out as
/// a table of another height, so both rows are held back until the table can form in one step.
fn trim_pending_table_head(text: &str) -> &str {
    let mut offset = 0;
    while let Some(blank) = BLANK_LINE.exec_from(text, offset) {
        offset = blank.end();
    }
    let lines: Vec<&str> = text[offset..].split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    // A row that ended with its newline is still the block's last row: the empty line after it is not a (partial)
    // delimiter row.
    let mut last = lines.len() - 1;
    if last >= 1 && js_trim(lines[last]).is_empty() {
        last -= 1;
    }
    let mut head = last;
    if last >= 1 && PARTIAL_DELIMITER_ROW.test(lines[last]) && has_cell_pipe(lines[last - 1]) {
        let delimiter = lines[last];
        if DELIMITER_ROW.test(delimiter) && table_cell_count(delimiter) == table_cell_count(lines[last - 1]) {
            return text;
        }
        head = last - 1;
    }
    if !(PIPE_ROW.test(lines[head]) || has_cell_pipe(lines[head])) {
        return text;
    }
    // Rows below a delimiter belong to a table that already formed.
    if lines[..head].iter().any(|line| DELIMITER_ROW.test(line)) {
        return text;
    }
    // The row lengths are those of the lines without their carriage returns, as the offsets are written in Node.
    let units = utf16_len(&text[..offset]) + lines[..head].iter().map(|line| utf16_len(line) + 1).sum::<usize>();
    &text[..utf16_to_byte(text, units)]
}

/// `healStreamingMarkdownTail(text, isPendingLocalPath)`: `text` with the unfinished tail of its last line closed.
/// `pending` is the renderer's file-link grammar: an unfinished final token that could still grow into a compact file
/// link is held back.
pub fn heal_streaming_markdown_tail_with(text: &str, pending: PendingPath<'_>) -> String {
    let fence = if text.contains('`') || text.contains('~') { open_fence(text) } else { None };
    if let Some(fence) = fence {
        return trim_partial_opening_fence(trim_partial_closing_fence(text, &fence), &fence).to_owned();
    }
    let unmarked = trim_pending_block_marker(text);
    let value = if unmarked.contains('|') { trim_pending_table_head(unmarked) } else { unmarked };
    let has_syntax = value.contains(['`', '*', '_', '~', '[']);
    if value.is_empty() || (!has_syntax && pending.is_none()) {
        return value.to_owned();
    }
    let healed = if has_syntax { close_emphasis(&heal_incomplete_link(&close_inline_code(value, pending), pending)) } else { value.to_owned() };
    // Only an unfinished final token can still grow into a compact file link; code and completed links stay intact.
    if let Some(is_pending) = pending
        && let Some(tail) = LAST_WORD.exec(&mask_code(&healed))
        && is_pending(tail.whole())
    {
        return healed[..tail.start()].to_owned();
    }
    healed
}

/// `healStreamingMarkdownTail(text)`: [`heal_streaming_markdown_tail_with`] without a file-link grammar.
pub fn heal_streaming_markdown_tail(text: &str) -> String {
    heal_streaming_markdown_tail_with(text, None)
}

/// `balanceStreamingMarkdown(text)`: `text` with its unclosed emphasis, code spans and fences closed (the streaming
/// renderer's name for [`heal_streaming_markdown_tail`]).
pub fn balance_streaming_markdown(text: &str) -> String {
    heal_streaming_markdown_tail(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfinished_emphasis_is_closed_before_trailing_space() {
        assert_eq!(heal_streaming_markdown_tail("a **bold and _it"), "a **bold and _it_**");
        assert_eq!(heal_streaming_markdown_tail("**word "), "**word** ");
        assert_eq!(heal_streaming_markdown_tail("text **"), "text ");
        assert_eq!(heal_streaming_markdown_tail("~~gone"), "~~gone~~");
        assert_eq!(heal_streaming_markdown_tail("a ~ b"), "a ~ b");
    }

    #[test]
    fn code_spans_are_closed_or_held_back() {
        assert_eq!(heal_streaming_markdown_tail("use `x"), "use `x`");
        assert_eq!(heal_streaming_markdown_tail("use ``x`y"), "use ``x`y``");
        assert_eq!(heal_streaming_markdown_tail("use `"), "use ");
        assert_eq!(heal_streaming_markdown_tail("`a` and **b"), "`a` and **b**");
    }

    #[test]
    fn links_become_inert_until_their_destination_closes() {
        assert_eq!(heal_streaming_markdown_tail("see [the doc"), "see [the doc]()");
        assert_eq!(heal_streaming_markdown_tail("see [the doc](http://x"), "see [the doc]()");
        assert_eq!(heal_streaming_markdown_tail("see [the doc](http://x)"), "see [the doc](http://x)");
        assert_eq!(heal_streaming_markdown_tail("see ![alt"), "see alt");
        assert_eq!(heal_streaming_markdown_tail("- [ ] task"), "- [ ] task");
        assert_eq!(heal_streaming_markdown_tail("note[^1"), "note[^1");
    }

    #[test]
    fn fences_hold_back_their_partial_lines() {
        assert_eq!(heal_streaming_markdown_tail("text\n```py"), "text\n");
        assert_eq!(heal_streaming_markdown_tail("```py\n"), "");
        assert_eq!(heal_streaming_markdown_tail("```py\ncode\n``"), "```py\ncode");
        assert_eq!(heal_streaming_markdown_tail("```py\ncode\n```"), "```py\ncode\n```");
        assert_eq!(heal_streaming_markdown_tail("```py\ncode **x"), "```py\ncode **x");
    }

    #[test]
    fn block_markers_and_table_heads_wait_for_content() {
        assert_eq!(heal_streaming_markdown_tail("para\n-"), "para\n");
        assert_eq!(heal_streaming_markdown_tail("para\n2"), "para\n");
        assert_eq!(heal_streaming_markdown_tail("para\n\n| a | b |\n|--"), "para\n\n");
        assert_eq!(heal_streaming_markdown_tail("| a | b |\n| - | - |"), "| a | b |\n| - | - |");
        assert_eq!(heal_streaming_markdown_tail("| a | b |\n| - | - |\n| 1"), "| a | b |\n| - | - |\n| 1");
    }

    #[test]
    fn a_pending_path_is_held_back_when_the_grammar_says_so() {
        let is_path = |token: &str| token.starts_with("src/");
        assert_eq!(heal_streaming_markdown_tail_with("open src/ma", Some(&is_path)), "open ");
        assert_eq!(heal_streaming_markdown_tail_with("open `src/ma`", Some(&is_path)), "open `src/ma`");
        assert_eq!(heal_streaming_markdown_tail_with("open a", Some(&is_path)), "open a");
    }
}
