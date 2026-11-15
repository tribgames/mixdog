//! The post-processing of an EXPANDED tool result body (ctrl+o), `components/tool-output-format.mjs`: every tool surface
//! renders the same way instead of a flat run of plain lines.
//!
//! * language inference from the read/grep path argument (its file extension);
//! * JSON auto pretty-print (precision safe, size capped);
//! * URL to OSC 8 hyperlink;
//! * stray underline SGR removal (shell output leaks these);
//! * the oversized-output guard (a 64 MB dump is never wrapped or scanned line by line);
//! * per line: the `<n>→` / `<file>:<n>:` line-number gutter is split into a dim column and the body is
//!   syntax-highlighted with the markdown code-block highlighter, so colours follow the active theme.
//!
//! The functions return ANSI strings, one per logical line; [`wrap_expanded_result_lines`] then makes every physical
//! terminal row map one to one to a row of the result rail.

use std::collections::VecDeque;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, is_js_space, js_to_lowercase, js_trim, json_parse, json_stringify_indent_parsed, string_to_number, utf16_len};
use mixdog_markdown_ansi::format::{
    ExtraColorizers, colorize_diff_line, highlight_code_block_to_lines, highlight_code_line, lang_family, looks_like_unified_diff, styles,
};
use mixdog_markdown_ansi::render::{RenderOptions, has_markdown_syntax, render_token_ansi_segments};
use mixdog_markdown_ansi::table::build_table_render;
use mixdog_termtext::wrap::wrap_lines;
use mixdog_termtext::{StringWidthOptions, display_width, string_width, strip_ansi};
use mixdog_tui_style::theme::RESULT_GUTTER;
use serde_json::Value;

/// Text beyond this many UTF-16 units gets no per-line processing.
const MAX_EXPANDED_CHARS: usize = 256 * 1024;
/// The logical-line safety ceiling; the physical mount cap is separate.
const MAX_EXPANDED_LINES: usize = 4000;
/// JSON text longer than this is not pretty-printed.
const MAX_JSON_FORMAT_LENGTH: usize = 10_000;
/// A line longer than this is not token-scanned.
const MAX_HIGHLIGHT_LINE_CHARS: usize = 2000;
/// The narrowest body column of an expanded result.
const MIN_EXPANDED_BODY_COLS: usize = 24;
/// The tab stop of expanded output (cosmetic: what matters is that no raw tab survives the width math).
const TOOL_OUTPUT_TAB_SIZE: usize = 2;
/// The default cap of physical rows one expanded body mounts.
const DEFAULT_MAX_RENDER_LINES: usize = 600;
/// The width a markdown body is laid out at.
const MARKDOWN_WIDTH: usize = 80;

/// `<n>→<content>` (read).
static READ_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\s*)(\d+)(\u2192)(.*)$", ""));
/// `<n>:<content>` or `<path>:<n>:<content>` (grep). A Windows absolute path has `X:\` so its drive colon does not end the
/// path prefix.
static GREP_LINE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(\s*)((?:[A-Za-z]:[\\/](?:[^\n:])*|[^\n:]*):\d+:|\d+:)(\s?)(.*)$", ""));
/// http(s) URLs not wrapped in quotes, brackets or whitespace (conservative).
static URL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"https?://[^\s"'<>\x1b\\)\]]+"#, "g"));

/// The cap of physical rows one expanded body mounts, from `MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES` (0 disables) and,
/// when that is unset or blank, the older `MIXDOG_TUI_EXPANDED_MAX_ROWS`; 600 when neither is a usable number.
pub fn resolve_max_render_lines(primary: Option<&str>, legacy: Option<&str>) -> usize {
    let positive = |raw: &str| {
        let value = string_to_number(raw);
        (value.is_finite() && value > 0.0).then(|| value.floor() as usize)
    };
    if let Some(raw) = primary.filter(|raw| !js_trim(raw).is_empty()) {
        let value = string_to_number(raw);
        if value.is_finite() && value <= 0.0 {
            return 0;
        }
        if let Some(rows) = positive(raw) {
            return rows;
        }
    }
    legacy.filter(|raw| !js_trim(raw).is_empty()).and_then(positive).unwrap_or(DEFAULT_MAX_RENDER_LINES)
}

/// [`resolve_max_render_lines`] of this process's environment.
pub fn max_render_lines_from_env() -> usize {
    let read = |name: &str| std::env::var(name).ok();
    resolve_max_render_lines(read("MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES").as_deref(), read("MIXDOG_TUI_EXPANDED_MAX_ROWS").as_deref())
}

fn omitted_physical_rows_marker(omitted: usize, is_shell: bool) -> String {
    if is_shell {
        let n = omitted.max(1);
        return format!("\u{2026} [{n} line{} omitted above \u{2014} showing newest output below]", if n == 1 { "" } else { "s" });
    }
    "\u{2026} [output truncated for display \u{2014} collapse (ctrl+o) or re-read a narrower range]".to_owned()
}

fn shell_logical_omitted_marker(omitted_lines: usize, omitted_chars: bool, c: &ExtraColorizers) -> Option<String> {
    if omitted_lines > 0 {
        return Some(c.syn_comment.apply(&omitted_physical_rows_marker(omitted_lines, true)));
    }
    omitted_chars.then(|| c.syn_comment.apply("\u{2026} [earlier output omitted above \u{2014} showing newest output below]"))
}

fn finalize_shell_physical_cap(buffer: Vec<String>, omitted: usize, max_rows: usize) -> Vec<String> {
    let body_slots = max_rows.saturating_sub(1);
    if omitted == 0 {
        return if buffer.is_empty() { vec![" ".to_owned()] } else { buffer };
    }
    let tail_from = buffer.len().saturating_sub(body_slots);
    let tail = if body_slots > 0 { buffer[tail_from..].to_vec() } else { Vec::new() };
    let mut out = vec![omitted_physical_rows_marker(omitted + tail_from, true)];
    out.extend(tail);
    out.truncate(max_rows);
    out
}

/// The byte length of the SGR (`ESC [ digits ; m`) or OSC (`ESC ] ... BEL` or `... ESC \`) sequence `text` starts with.
fn ansi_seq_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&0x1b) {
        return None;
    }
    match bytes.get(1) {
        Some(b'[') => {
            let mut at = 2;
            while at < bytes.len() && (bytes[at].is_ascii_digit() || bytes[at] == b';') {
                at += 1;
            }
            (bytes.get(at) == Some(&b'm')).then_some(at + 1)
        }
        Some(b']') => {
            let mut at = 2;
            while at < bytes.len() {
                if bytes[at] == 0x07 {
                    return Some(at + 1);
                }
                if bytes[at] == 0x1b && bytes.get(at + 1) == Some(&b'\\') {
                    return Some(at + 2);
                }
                at += 1;
            }
            None
        }
        _ => None,
    }
}

fn cell_width(ch: char) -> usize {
    string_width(ch.encode_utf8(&mut [0; 4]), StringWidthOptions::default())
}

/// ANSI-aware control normalisation: tabs become spaces to the next stop (two), CR and CRLF become LF, every other C0
/// control and DEL becomes one space. SGR and OSC 8 escapes are copied through verbatim (zero visible columns), so coloured
/// shell output and links keep their escapes while their visible text is normalised.
fn normalize_tool_output_controls(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut column = 0usize;
    let mut at = 0usize;
    while at < input.len() {
        let rest = &input[at..];
        if let Some(len) = ansi_seq_len(rest) {
            out.push_str(&rest[..len]);
            at += len;
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        at += ch.len_utf8();
        match ch {
            '\n' => {
                out.push('\n');
                column = 0;
            }
            '\r' => {
                out.push('\n');
                column = 0;
                if input[at..].starts_with('\n') {
                    at += 1;
                }
            }
            '\t' => {
                let advance = TOOL_OUTPUT_TAB_SIZE - column % TOOL_OUTPUT_TAB_SIZE;
                out.extend(std::iter::repeat_n(' ', advance));
                column += advance;
            }
            c if c <= '\u{1f}' || c == '\u{7f}' => {
                out.push(' ');
                column += 1;
            }
            c => {
                out.push(c);
                column += cell_width(c);
            }
        }
    }
    out
}

/// The highlighter family of a read/grep path argument's extension.
fn infer_lang_family(path_arg: &str) -> Option<&'static str> {
    let path = js_to_lowercase(js_trim(path_arg));
    let (_, extension) = path.rsplit_once('.')?;
    if extension.is_empty() || !extension.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return None;
    }
    lang_family(extension)
}

/// Strips ONLY the underline SGR parameters (4 and 24); other styles and colours are kept.
fn strip_underline_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0usize;
    while at < text.len() {
        let rest = &text[at..];
        if rest.as_bytes().get(1) == Some(&b'[')
            && let Some(len) = ansi_seq_len(rest)
        {
            let params = &rest[2..len - 1];
            if params.is_empty() {
                out.push_str(&rest[..len]);
            } else {
                let kept: Vec<&str> = params.split(';').filter(|p| !p.is_empty() && *p != "4" && *p != "24").collect();
                if !kept.is_empty() {
                    out.push_str(&format!("\u{1b}[{}m", kept.join(";")));
                }
            }
            at += len;
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        at += ch.len_utf8();
    }
    out
}

/// Wraps bare URLs in OSC 8 hyperlinks (a terminal that ignores them shows the URL). Escape sequences already in the text
/// are left alone.
fn linkify_urls(text: &str) -> String {
    if !text.contains("http://") && !text.contains("https://") {
        return text.to_owned();
    }
    let link = |chunk: &str| {
        URL.replace_all_with(chunk, |found| {
            let url = found.get(0).unwrap_or_default();
            format!("\u{1b}]8;;{url}\u{7}{url}\u{1b}]8;;\u{7}")
        })
    };
    let mut out = String::with_capacity(text.len() + 32);
    let (mut last, mut at) = (0usize, 0usize);
    while at < text.len() {
        if text.as_bytes()[at] == 0x1b
            && let Some(len) = ansi_seq_len(&text[at..])
        {
            out.push_str(&link(&text[last..at]));
            out.push_str(&text[at..at + len]);
            at += len;
            last = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&link(&text[last..]));
    out
}

fn without_spaces(text: &str) -> String {
    text.chars().filter(|c| !is_js_space(*c)).collect()
}

fn parsed_container(text: &str) -> Option<Value> {
    let first = text.chars().next()?;
    if first != '{' && first != '[' {
        return None;
    }
    json_parse(text).ok().filter(|value| matches!(value, Value::Object(_) | Value::Array(_)))
}

/// A precision-safe JSON pretty-print of one line; the line itself on a miss.
fn try_format_json_line(line: &str) -> String {
    let trimmed = js_trim(line);
    let Some(parsed) = parsed_container(trimmed) else { return line.to_owned() };
    let pretty = json_stringify_indent_parsed(&parsed, 2);
    // Bail out when a big integer lost precision on the round trip.
    let before = without_spaces(&trimmed.replace("\\/", "/"));
    let after = without_spaces(&json_stringify_indent_parsed(&parsed, 0));
    if before == after { pretty } else { line.to_owned() }
}

/// Auto pretty-print of a whole result, line by line, size capped.
fn try_format_json(text: &str) -> String {
    if utf16_len(text) > MAX_JSON_FORMAT_LENGTH {
        return text.to_owned();
    }
    text.split('\n').map(try_format_json_line).collect::<Vec<_>>().join("\n")
}

/// The whole body is a JSON object or array (not markdown prose).
fn is_json_document(text: &str) -> bool {
    parsed_container(js_trim(text)).is_some()
}

fn has_ansi(text: &str) -> bool {
    text.contains("\u{1b}[")
}

fn line_has_tool_gutter(line: &str) -> bool {
    READ_LINE.is_match(line) || GREP_LINE.is_match(line)
}

/// Whole-result markdown render for prose-like tool output (headings, emphasis, fences). Skipped for shell, ANSI and diff
/// bodies, read/grep gutters and a path whose language is not markdown (those stay per-line syntax highlight).
fn should_render_expanded_markdown(src: &str, lines: &[&str], carries_ansi: bool, is_shell: bool, diff_mode: bool, family: Option<&str>) -> bool {
    if carries_ansi || is_shell || diff_mode || is_json_document(src) || lines.iter().any(|line| line_has_tool_gutter(line)) {
        return false;
    }
    match family {
        Some("md") => true,
        Some(_) => false,
        None => has_markdown_syntax(src),
    }
}

/// The markdown lexer's output as one ANSI string per terminal row (tables by the table layout).
fn format_expanded_markdown_lines(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for segment in render_token_ansi_segments(src, RenderOptions { width: MARKDOWN_WIDTH, trim_partial_fences: false }).iter() {
        if segment.is_table() {
            out.extend(build_table_render(segment.token(), MARKDOWN_WIDTH).iter().map(|line| linkify_urls(line)));
        } else if let Some(ansi) = segment.ansi().filter(|ansi| !ansi.is_empty()) {
            out.extend(ansi.split('\n').map(linkify_urls));
        }
    }
    out
}

/// A line split at its read/grep line-number gutter.
struct Gutter {
    indent: String,
    gutter: String,
    body: String,
}

fn split_gutter(line: &str) -> Gutter {
    for regex in [&*READ_LINE, &*GREP_LINE] {
        if let Some(found) = regex.captures(line) {
            let part = |n| found.get(n).unwrap_or_default();
            return Gutter { indent: part(1).to_owned(), gutter: format!("{}{}", part(2), part(3)), body: part(4).to_owned() };
        }
    }
    Gutter { indent: String::new(), gutter: String::new(), body: line.to_owned() }
}

/// A block syntax highlight of a non-diff code body (multi-line tokens colour correctly).
fn format_syntax_block(lines: &[&str], c: &ExtraColorizers, family: &str) -> Vec<String> {
    let parts: Vec<Gutter> = lines.iter().map(|line| split_gutter(line)).collect();
    let too_long = |part: &Gutter| utf16_len(&part.body) > MAX_HIGHLIGHT_LINE_CHARS;
    let bodies: Vec<&str> = parts.iter().map(|part| if too_long(part) { "" } else { part.body.as_str() }).collect();
    let highlighted = highlight_code_block_to_lines(&bodies.join("\n"), Some(family), c);
    parts
        .iter()
        .enumerate()
        .map(|(at, part)| {
            let body = if too_long(part) { c.body.apply(&part.body) } else { highlighted.get(at).cloned().unwrap_or_default() };
            let linked = linkify_urls(&body);
            if part.gutter.is_empty() { linked } else { format!("{}{}{linked}", part.indent, c.syn_comment.apply(&part.gutter)) }
        })
        .collect()
}

/// How one line of a body is coloured.
struct LineMode<'a> {
    family: Option<&'a str>,
    diff_mode: bool,
    carries_ansi: bool,
    is_shell: bool,
}

/// One line: the line-number gutter split off, the body highlighted or flat-coloured and its URLs linked.
fn format_line(line: &str, c: &ExtraColorizers, mode: &LineMode) -> String {
    // Shell and already coloured output keep their ANSI verbatim: only the underline leaks are fixed and URLs linked.
    if mode.carries_ansi || mode.is_shell {
        return linkify_urls(&strip_underline_ansi(line));
    }
    let part = split_gutter(line);
    let coloured = highlight_body(&part.body, c, mode);
    let linked = linkify_urls(&coloured);
    if part.gutter.is_empty() { linked } else { format!("{}{}{linked}", part.indent, c.syn_comment.apply(&part.gutter)) }
}

fn highlight_body(body: &str, c: &ExtraColorizers, mode: &LineMode) -> String {
    if body.is_empty() {
        return String::new();
    }
    if utf16_len(body) > MAX_HIGHLIGHT_LINE_CHARS {
        return c.body.apply(body);
    }
    if mode.diff_mode {
        return colorize_diff_line(body, c);
    }
    match mode.family {
        Some(family) if family != "md" => highlight_code_line(body, Some(family), c),
        _ => c.body.apply(body),
    }
}

/// Processes an expanded tool-result body into one ANSI string per logical line. `path_arg` is the read/grep path (language
/// inference); `is_shell` keeps existing ANSI and does no highlighting.
pub fn format_expanded_result(text: &str, path_arg: &str, is_shell: bool) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut src = text.to_owned();
    // Oversized guard: cut before any O(n) per-line work and say so.
    let (mut truncated_chars, mut shell_omitted_lines, mut shell_omitted_chars) = (false, 0usize, false);
    if utf16_len(&src) > MAX_EXPANDED_CHARS {
        let units: Vec<u16> = src.encode_utf16().collect();
        src = String::from_utf16_lossy(if is_shell { &units[units.len() - MAX_EXPANDED_CHARS..] } else { &units[..MAX_EXPANDED_CHARS] });
        if is_shell {
            shell_omitted_chars = true;
        } else {
            truncated_chars = true;
        }
    }
    let carries_ansi = has_ansi(&src);
    // Tabs and stray controls are fixed whatever the text carries: a raw tab measures zero cells but the terminal expands it.
    src = normalize_tool_output_controls(&src);
    // JSON is pretty-printed only when the text is not already coloured.
    if !carries_ansi {
        src = try_format_json(&src);
    }
    let mut lines: Vec<&str> = src.split('\n').collect();
    let mut truncated_lines = false;
    if lines.len() > MAX_EXPANDED_LINES {
        if is_shell {
            shell_omitted_lines = lines.len() - MAX_EXPANDED_LINES;
            lines = lines.split_off(shell_omitted_lines);
        } else {
            lines.truncate(MAX_EXPANDED_LINES);
            truncated_lines = true;
        }
    }
    let styles = styles();
    let c = &styles.extra;
    // A diff body is coloured as a diff whatever its file family.
    let diff_mode = !carries_ansi && !is_shell && looks_like_unified_diff(&src);
    let family = if is_shell || carries_ansi { None } else { infer_lang_family(path_arg) };

    let mut out = if should_render_expanded_markdown(&src, &lines, carries_ansi, is_shell, diff_mode, family) {
        let mut rendered = format_expanded_markdown_lines(&src);
        if rendered.len() > MAX_EXPANDED_LINES {
            if is_shell {
                shell_omitted_lines += rendered.len() - MAX_EXPANDED_LINES;
                rendered = rendered.split_off(rendered.len() - MAX_EXPANDED_LINES);
            } else {
                rendered.truncate(MAX_EXPANDED_LINES);
                truncated_lines = true;
            }
        }
        rendered
    } else if let Some(family) = family.filter(|family| *family != "md" && !diff_mode && !carries_ansi && !is_shell) {
        format_syntax_block(&lines, c, family)
    } else {
        let mode = LineMode { family, diff_mode, carries_ansi, is_shell };
        lines.iter().map(|line| format_line(line, c, &mode)).collect()
    };

    if is_shell {
        return match shell_logical_omitted_marker(shell_omitted_lines, shell_omitted_chars, c) {
            Some(marker) => std::iter::once(marker).chain(out).collect(),
            None => out,
        };
    }
    if truncated_chars || truncated_lines {
        out.push(c.syn_comment.apply("\u{2026} [output truncated for display \u{2014} re-read a narrower range]"));
    }
    out
}

/// The body width of an expanded result: the columns less the rail.
fn expanded_result_body_width(columns: usize) -> usize {
    let columns = if columns == 0 { 80 } else { columns };
    MIN_EXPANDED_BODY_COLS.max(columns.saturating_sub(string_width(RESULT_GUTTER, StringWidthOptions::default())))
}

/// `text` split after `plain_target` columns of visible text; an escape sequence is never cut.
fn split_ansi_by_plain_width(text: &str, plain_target: usize) -> (&str, &str) {
    if text.is_empty() || plain_target == 0 {
        return ("", text);
    }
    let (mut at, mut plain) = (0usize, 0usize);
    while at < text.len() && plain < plain_target {
        let rest = &text[at..];
        if let Some(len) = ansi_seq_len(rest) {
            at += len;
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        plain += display_width(ch.encode_utf8(&mut [0; 4]));
        at += ch.len_utf8();
    }
    text.split_at(at)
}

/// The visible width of the line-number gutter a plain line starts with.
fn leading_prefix_plain_width(plain_line: &str) -> usize {
    let gutter = split_gutter(plain_line);
    if gutter.gutter.is_empty() { 0 } else { display_width(&format!("{}{}", gutter.indent, gutter.gutter)) }
}

/// Hard-cuts an ANSI string so its visible width is at most `max_width`. Escapes are copied verbatim (zero width) and never
/// cut, including the closers after the cut point, so a clamped coloured or linked row cannot leave a sequence open. The
/// final safety clamp: the wrapper measures with string-width, so a row it accepts can still be wider under the wide policy.
fn clamp_row_to_display_width(row: &str, max_width: usize) -> String {
    if max_width == 0 || display_width(row) <= max_width {
        return row.to_owned();
    }
    let (mut out, mut plain, mut overflowed, mut at) = (String::with_capacity(row.len()), 0usize, false, 0usize);
    while at < row.len() {
        let rest = &row[at..];
        if let Some(len) = ansi_seq_len(rest) {
            out.push_str(&rest[..len]);
            at += len;
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        at += ch.len_utf8();
        if !overflowed {
            let width = display_width(ch.encode_utf8(&mut [0; 4]));
            if plain + width > max_width {
                overflowed = true;
            } else {
                out.push(ch);
                plain += width;
            }
        }
    }
    out
}

/// One logical line as the physical rows that fit `max_width`; a continuation row is indented under the gutter.
fn wrap_one_logical_line(line: &str, max_width: usize) -> Vec<String> {
    if line.is_empty() {
        return vec![" ".to_owned()];
    }
    if display_width(line) <= max_width {
        return vec![line.to_owned()];
    }
    let prefix_width = leading_prefix_plain_width(&strip_ansi(line));
    let (prefix, body) = if prefix_width > 0 { split_ansi_by_plain_width(line, prefix_width) } else { ("", line) };
    let prefix_cells = display_width(prefix);
    let pieces = wrap_lines(body, max_width.saturating_sub(prefix_cells).max(1), true);
    if pieces.len() <= 1 {
        return vec![clamp_row_to_display_width(line, max_width)];
    }
    pieces
        .iter()
        .enumerate()
        .map(|(at, piece)| {
            let row = if at == 0 { format!("{prefix}{piece}") } else { format!("{}{piece}", " ".repeat(prefix_cells)) };
            clamp_row_to_display_width(&row, max_width)
        })
        .collect()
}

/// The logical lines as physical rows that fit the body column: one output row per row of the result rail. `max_rows` caps
/// the rows (0 disables the cap): a shell body keeps its newest tail and says how many rows it dropped above, any other
/// body keeps its head and ends with a truncation marker.
pub fn wrap_expanded_result_lines(logical_lines: &[String], columns: usize, is_shell: bool, max_rows: usize) -> Vec<String> {
    let max_width = expanded_result_body_width(columns);
    let clamp_all = |rows: Vec<String>| rows.iter().map(|row| clamp_row_to_display_width(row, max_width)).collect::<Vec<_>>();
    let or_blank = |rows: Vec<String>| if rows.is_empty() { vec![" ".to_owned()] } else { clamp_all(rows) };

    if max_rows == 0 {
        return or_blank(logical_lines.iter().flat_map(|line| wrap_one_logical_line(line, max_width)).collect());
    }
    if is_shell {
        let (mut kept, mut omitted): (VecDeque<String>, usize) = (VecDeque::new(), 0);
        for row in logical_lines.iter().flat_map(|line| wrap_one_logical_line(line, max_width)) {
            kept.push_back(row);
            if kept.len() > max_rows {
                kept.pop_front();
                omitted += 1;
            }
        }
        return clamp_all(finalize_shell_physical_cap(kept.into_iter().collect(), omitted, max_rows));
    }
    // Any other surface keeps the head of the body (read, grep, json).
    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    'lines: for line in logical_lines {
        for row in wrap_one_logical_line(line, max_width) {
            if out.len() < max_rows {
                out.push(row);
            } else {
                truncated = true;
                break 'lines;
            }
        }
    }
    if truncated {
        out.truncate(max_rows.saturating_sub(1));
        out.push(omitted_physical_rows_marker(1, false));
        out.truncate(max_rows);
        return clamp_all(out);
    }
    or_blank(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_cap_follows_the_environment_rules() {
        assert_eq!(resolve_max_render_lines(Some("3"), None), 3);
        assert_eq!(resolve_max_render_lines(Some("0"), Some("1")), 0);
        assert_eq!(resolve_max_render_lines(Some(" "), Some("7")), 7);
        assert_eq!(resolve_max_render_lines(None, Some("0")), 600);
        assert_eq!(resolve_max_render_lines(Some("abc"), None), 600);
        assert_eq!(resolve_max_render_lines(None, None), 600);
    }

    #[test]
    fn shell_row_caps_keep_the_newest_tail_and_count_every_omitted_row() {
        let omitted = "\u{2026} [3 lines omitted above \u{2014} showing newest output below]";
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c", "d", "e"]), 160, true, 3), rows(&[omitted, "d", "e"]));
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c"]), 160, true, 3), rows(&["a", "b", "c"]));
        assert_eq!(wrap_expanded_result_lines(&[], 160, true, 3), rows(&[" "]));
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c"]), 160, true, 1), rows(&[omitted]));
    }

    #[test]
    fn non_shell_row_caps_retain_the_head_and_reserve_one_truncation_marker() {
        let marker = "\u{2026} [output truncated for display \u{2014} collapse (ctrl+o) or re-read a narrower range]";
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c", "d"]), 160, false, 3), rows(&["a", "b", marker]));
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c"]), 160, false, 3), rows(&["a", "b", "c"]));
        assert_eq!(wrap_expanded_result_lines(&[], 160, false, 3), rows(&[" "]));
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b"]), 160, false, 1), rows(&[marker]));
    }

    #[test]
    fn a_disabled_cap_keeps_every_row() {
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c"]), 160, false, 0), rows(&["a", "b", "c"]));
        assert_eq!(wrap_expanded_result_lines(&rows(&["a", "b", "c"]), 160, true, 0), rows(&["a", "b", "c"]));
    }

    #[test]
    fn shell_normalization_preserves_ansi_and_osc_bytes_while_removing_visible_controls() {
        assert_eq!(format_expanded_result("\u{1b}[4;31mA\tB\u{1b}[24;39m\r\nC\0D", "", true), rows(&["\u{1b}[31mA B\u{1b}[39m", "C D"]));
        for end in ["\u{7}", "\u{1b}\\"] {
            let link = format!("\u{1b}]8;;https://example.test{end}label\u{1b}]8;;{end}");
            assert_eq!(format_expanded_result(&link, "", true), vec![link]);
        }
    }

    #[test]
    fn a_long_row_wraps_under_its_line_number_gutter() {
        let line = format!("12\u{2192}{}", "x".repeat(100));
        let wrapped = wrap_expanded_result_lines(&[line], 40, false, 600);
        assert!(wrapped.len() > 2);
        assert!(wrapped[0].starts_with("12\u{2192}x"));
        assert!(wrapped[1].starts_with("   ") && wrapped[1].trim_start().starts_with('x'));
        assert!(wrapped.iter().all(|row| display_width(row) <= 35));
    }

    #[test]
    fn json_is_pretty_printed_unless_a_number_would_change() {
        assert_eq!(try_format_json_line("{\"a\":1}"), "{\n  \"a\": 1\n}");
        assert_eq!(try_format_json_line("{\"a\":1e2}"), "{\"a\":1e2}");
        assert_eq!(try_format_json_line("plain"), "plain");
    }

    #[test]
    fn a_url_becomes_an_osc_8_link_outside_escapes() {
        assert_eq!(linkify_urls("see https://a.b/c now"), "see \u{1b}]8;;https://a.b/c\u{7}https://a.b/c\u{1b}]8;;\u{7} now");
        assert_eq!(linkify_urls("no link"), "no link");
    }

    #[test]
    fn the_language_follows_the_path_extension() {
        assert_eq!(infer_lang_family("src/Main.RS"), Some("rust"));
        assert_eq!(infer_lang_family("Makefile"), None);
        assert_eq!(infer_lang_family(""), None);
    }
}
