//! ANSI-aware wrapping: `wrap-ansi` 10.0.2, the Ink fork's `wrap-text.js` (with the display-width repair it adds
//! around wrap-ansi and cli-truncate), `measure-text.js`, `sanitize-ansi.js`, and the `hardWrapAnsiLines` of
//! `src/tui/markdown/ansi-line-wrap.mjs`.
//!
//! Which width each part measures with, as its Node counterpart does:
//! - [`wrap_ansi`] and everything it calls: plain `string_width` with escape codes counted (they were removed
//!   already), never the display-width policy;
//! - [`wrap_text`] / [`wrap_text_with`]: wrap-ansi and cli-truncate with plain `string_width` first, then the
//!   display-width policy re-checks every produced line (reflowing the overflow of a wrapped line, cutting a
//!   truncated one);
//! - [`measure_text`], [`slice_text_by_display_width`], [`hard_wrap_ansi_lines`]: the display-width policy.
//!
//! The policy of the process is read from `crate::policy` (`display_width`); the `_with` functions take it as an
//! argument, which is what the twin tests use to run both settings in one process.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::ansi::{BEL, ESC, InkTokenKind, is_close_code, js_parse_int, js_trim_end, js_trim_start, sgr_code, style_close, tokenize_ink};
use crate::lone;
use crate::policy::{display_width, display_width_with};
use crate::slice::slice_ansi;
use crate::strip::strip_ansi;
use crate::truncate::{TruncatePosition, truncate};
use crate::width::{StringWidthOptions, string_width};

/// The options of `wrapAnsi(text, columns, options)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrapOptions {
    /// Break words longer than a line.
    pub hard: bool,
    /// Wrap at word boundaries (the default) or only where a line is full.
    pub word_wrap: bool,
    /// Trim the white space a wrap leaves at a line's start (the default).
    pub trim: bool,
}

impl Default for WrapOptions {
    fn default() -> Self {
        Self { hard: false, word_wrap: true, trim: true }
    }
}

/// How Ink's text component fits text into a width.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WrapMode {
    Wrap,
    Hard,
    TruncateStart,
    TruncateMiddle,
    TruncateEnd,
}

const TAB_SIZE: usize = 8;

// ---------------------------------------------------------------------------------------------------------------
// Escape sequences as wrap-ansi recognises them.
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum EscapeKind<'a> {
    /// `CSI [0-9;:]* m`: the parameters.
    Sgr(&'a str),
    /// `OSC 8 ; parameters ; uri ST`.
    Link { parameters: &'a str, uri: &'a str },
    /// Any other CSI sequence or OSC string.
    Other,
}

#[derive(Debug, Clone, Copy)]
struct EscapeMatch<'a> {
    /// Length in bytes.
    len: usize,
    kind: EscapeKind<'a>,
}

#[derive(Debug, Clone, Copy)]
enum Segment<'a> {
    Plain(&'a str),
    Escape(&'a str),
}

fn is_control(ch: char) -> bool {
    matches!(ch, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// The end (in bytes, after the terminator) of an OSC payload `[^controls]*` and a BEL or `ESC \` terminator that
/// starts at `from`.
fn osc_payload_end(text: &str, from: usize) -> Option<(usize, usize)> {
    let end = text[from..].char_indices().find(|&(_, ch)| is_control(ch)).map_or(text.len(), |(offset, _)| from + offset);
    terminator_end(text, end).map(|after| (end, after))
}

fn terminator_end(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    match bytes.get(at) {
        Some(&b) if b == BEL as u8 => Some(at + 1),
        Some(&b) if b == ESC as u8 && bytes.get(at + 1) == Some(&b'\\') => Some(at + 2),
        _ => None,
    }
}

/// `OSC 8 ; parameters ; uri` with the introducer already consumed: `(parameters, uri, end)`.
fn link_at(text: &str, from: usize) -> Option<(&str, &str, usize)> {
    let rest = text.get(from..)?.strip_prefix("8;")?;
    let params_from = from + 2;
    let params_len = rest.find(|ch: char| ch == ';' || is_control(ch))?;
    if rest.as_bytes()[params_len] != b';' {
        return None;
    }
    let parameters = &text[params_from..params_from + params_len];
    let uri_from = params_from + params_len + 1;
    let (uri_end, after) = osc_payload_end(text, uri_from)?;
    Some((parameters, &text[uri_from..uri_end], after))
}

/// A complete escape sequence that starts at byte `at`, if one does (`matchAnsiEscape`).
fn match_ansi_escape(text: &str, at: usize) -> Option<EscapeMatch<'_>> {
    let bytes = text.as_bytes();
    let from = match bytes.get(at)? {
        0x1b => match bytes.get(at + 1)? {
            b'[' => at + 2,
            b']' => {
                let body = at + 2;
                if let Some((parameters, uri, after)) = link_at(text, body) {
                    return Some(EscapeMatch { len: after - at, kind: EscapeKind::Link { parameters, uri } });
                }
                let (_, after) = osc_payload_end(text, body)?;
                return Some(EscapeMatch { len: after - at, kind: EscapeKind::Other });
            }
            _ => return None,
        },
        0xc2 if bytes.get(at + 1) == Some(&0x9b) => at + 2,
        _ => return None,
    };
    let mut cursor = from;
    while bytes.get(cursor).is_some_and(|b| b.is_ascii_digit() || matches!(b, b';' | b':')) {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'm') {
        return Some(EscapeMatch { len: cursor + 1 - at, kind: EscapeKind::Sgr(&text[from..cursor]) });
    }
    cursor = from;
    while bytes.get(cursor).is_some_and(|b| (0x30..=0x3f).contains(b)) {
        cursor += 1;
    }
    while bytes.get(cursor).is_some_and(|b| (0x20..=0x2f).contains(b)) {
        cursor += 1;
    }
    bytes.get(cursor).filter(|b| (0x40..=0x7e).contains(*b)).map(|_| EscapeMatch { len: cursor + 1 - at, kind: EscapeKind::Other })
}

/// `forEachSegment`: the string as alternating plain text and complete escape sequences. A character that looks
/// like an introducer but starts no valid sequence stays plain text.
fn segments(text: &str) -> Vec<Segment<'_>> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut plain_start = 0;
    let mut index = 0;
    while index < bytes.len() {
        let introducer = (index..bytes.len()).find(|&at| bytes[at] == 0x1b || (bytes[at] == 0xc2 && bytes.get(at + 1) == Some(&0x9b)));
        let Some(at) = introducer else { break };
        let Some(found) = match_ansi_escape(text, at) else {
            index = at + if bytes[at] == 0x1b { 1 } else { 2 };
            continue;
        };
        if at > plain_start {
            out.push(Segment::Plain(&text[plain_start..at]));
        }
        out.push(Segment::Escape(&text[at..at + found.len]));
        index = at + found.len;
        plain_start = index;
    }
    if plain_start < text.len() {
        out.push(Segment::Plain(&text[plain_start..]));
    }
    out
}

/// `getStringWidth`: escape sequences were removed already, so their characters are not scanned again.
fn get_string_width(text: &str) -> usize {
    string_width(text, StringWidthOptions { count_ansi_escape_codes: true, ..StringWidthOptions::default() })
}

/// `getWidth`: the visible width of a string, ignoring complete escape sequences.
fn get_width(text: &str) -> usize {
    let plain: String = segments(text)
        .into_iter()
        .filter_map(|segment| match segment {
            Segment::Plain(part) => Some(part),
            Segment::Escape(..) => None,
        })
        .collect();
    get_string_width(&plain)
}

struct Token {
    value: String,
    width: usize,
}

/// `getTokens`: escape sequences (zero width, never split) and grapheme clusters.
fn get_tokens(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    for segment in segments(text) {
        match segment {
            Segment::Plain(part) if part.bytes().all(|b| (0x20..=0x7e).contains(&b)) => {
                tokens.extend(part.chars().map(|ch| Token { value: ch.to_string(), width: 1 }));
            }
            Segment::Plain(part) => {
                tokens.extend(part.graphemes(true).map(|cluster| Token { value: cluster.to_owned(), width: get_string_width(cluster) }));
            }
            Segment::Escape(code) => tokens.push(Token { value: code.to_owned(), width: 0 }),
        }
    }
    tokens
}

struct Word {
    value: String,
    plain_text: String,
    width: usize,
}

/// `splitWords`: split on spaces, ignoring spaces that appear inside a recognised sequence.
fn split_words(text: &str) -> Vec<Word> {
    let mut words = vec![Word { value: String::new(), plain_text: String::new(), width: 0 }];
    for segment in segments(text) {
        match segment {
            Segment::Plain(part) => {
                let mut pieces = part.split(' ');
                if let Some(first) = pieces.next()
                    && let Some(current) = words.last_mut()
                {
                    current.value.push_str(first);
                    current.plain_text.push_str(first);
                }
                for piece in pieces {
                    words.push(Word { value: piece.to_owned(), plain_text: piece.to_owned(), width: 0 });
                }
            }
            Segment::Escape(code) => {
                if let Some(current) = words.last_mut() {
                    current.value.push_str(code);
                }
            }
        }
    }
    // Measured once per word rather than per run, so a grapheme cluster split by an escape still counts once.
    for word in &mut words {
        word.width = get_string_width(&word.plain_text);
    }
    words
}

// ---------------------------------------------------------------------------------------------------------------
// SGR state carried across rows.
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ActiveStyle {
    family: String,
    open: String,
    close: i64,
}

#[derive(Debug)]
struct SgrToken {
    code: i64,
    open: String,
    has_arguments: bool,
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `getColonColorToken`: `38:5:n`, `38:2:r:g:b` and `38:2:space:r:g:b` (and the 48 and 58 forms).
fn colon_color_token(parameter: &str) -> Option<SgrToken> {
    let parts: Vec<&str> = parameter.split(':').collect();
    let code = js_parse_int(parts[0]);
    let mode = parts.get(1).and_then(|part| js_parse_int(part));
    let code = code.filter(|code| matches!(code, 38 | 48 | 58))?;
    let token = || SgrToken { code, open: parameter.to_owned(), has_arguments: true };
    if mode == Some(5) && parts.len() == 3 && all_digits(parts[2]) {
        return Some(token());
    }
    if mode != Some(2) {
        return None;
    }
    let (components, color_space) = if parts.len() == 6 { (&parts[3..], Some(parts[2])) } else { (&parts[2..], None) };
    let space_ok = color_space.is_none_or(|space| space.is_empty() || all_digits(space));
    (components.len() == 3 && components.iter().all(|component| all_digits(component)) && space_ok).then(token)
}

/// `getSgrTokens`: the codes of the parameters of one SGR sequence.
fn sgr_tokens(parameters: &str) -> Vec<SgrToken> {
    let parameters: Vec<&str> = parameters.split(';').collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < parameters.len() {
        let parameter = parameters[index];
        if parameter.contains(':') {
            if let Some(token) = colon_color_token(parameter) {
                tokens.push(token);
            }
            index += 1;
            continue;
        }
        let code = if parameter.is_empty() { Some(0) } else { js_parse_int(parameter) };
        let Some(code) = code else {
            index += 1;
            continue;
        };
        if matches!(code, 38 | 48 | 58) {
            if index + 1 >= parameters.len() {
                break;
            }
            let value = |offset: usize| parameters.get(index + offset).and_then(|raw| js_parse_int(raw));
            let (mode, first, second, third) = (value(1), value(2), value(3), value(4));
            if mode == Some(5)
                && let Some(color) = first
            {
                tokens.push(SgrToken { code, open: format!("{code};5;{color}"), has_arguments: true });
                index += 3;
                continue;
            }
            if mode == Some(2)
                && let (Some(red), Some(green), Some(blue)) = (first, second, third)
            {
                tokens.push(SgrToken { code, open: format!("{code};2;{red};{green};{blue}"), has_arguments: true });
                index += 5;
                continue;
            }
            break;
        }
        tokens.push(SgrToken { code, open: code.to_string(), has_arguments: false });
        index += 1;
    }
    tokens
}

fn remove_active_style(active: &mut Vec<ActiveStyle>, family: &str) {
    if let Some(at) = active.iter().position(|style| style.family == family) {
        active.remove(at);
    }
}

fn upsert_active_style(active: &mut Vec<ActiveStyle>, style: ActiveStyle) {
    remove_active_style(active, &style.family);
    active.push(style);
}

fn color_style(token: &SgrToken) -> Option<ActiveStyle> {
    let code = token.code;
    let (family, close) = if matches!(code, 30..=37 | 90..=97) || (code == 38 && token.has_arguments) {
        ("foreground", 39)
    } else if matches!(code, 40..=47 | 100..=107) || (code == 48 && token.has_arguments) {
        ("background", 49)
    } else if code == 58 && token.has_arguments {
        ("underlineColor", 59)
    } else {
        return None;
    };
    Some(ActiveStyle { family: family.to_owned(), open: token.open.clone(), close })
}

/// `applySgrResetCode`: whether `code` was a reset (of everything, a colour, or a modifier) and has been applied.
fn apply_sgr_reset_code(code: i64, active: &mut Vec<ActiveStyle>) -> bool {
    match code {
        0 => active.clear(),
        39 => remove_active_style(active, "foreground"),
        49 => remove_active_style(active, "background"),
        59 => remove_active_style(active, "underlineColor"),
        _ if is_close_code(code) => active.retain(|style| !(style.family.starts_with("modifier-") && style.close == code)),
        _ => return false,
    }
    true
}

fn apply_sgr_token(token: &SgrToken, active: &mut Vec<ActiveStyle>) {
    if apply_sgr_reset_code(token.code, active) {
        return;
    }
    if let Some(style) = color_style(token) {
        upsert_active_style(active, style);
        return;
    }
    if let Some(close) = style_close(token.code).filter(|&close| close != 0) {
        upsert_active_style(active, ActiveStyle { family: format!("modifier-{}", token.code), open: token.open.clone(), close });
    }
}

fn apply_sgr_parameters(parameters: &str, active: &mut Vec<ActiveStyle>) {
    for token in sgr_tokens(parameters) {
        apply_sgr_token(&token, active);
    }
}

fn apply_sgr_resets(parameters: &str, active: &mut Vec<ActiveStyle>) {
    for token in sgr_tokens(parameters) {
        apply_sgr_reset_code(token.code, active);
    }
}

/// `applyLeadingSgrResets`: the resets among the escape sequences that start the row at `start`.
fn apply_leading_sgr_resets(text: &str, start: usize, active: &mut Vec<ActiveStyle>) {
    let mut index = start;
    while index < text.len() {
        let Some(found) = match_ansi_escape(text, index) else { break };
        if let EscapeKind::Sgr(parameters) = found.kind {
            apply_sgr_resets(parameters, active);
        }
        index += found.len;
    }
}

fn closing_sgr_sequence(active: &[ActiveStyle]) -> String {
    active.iter().rev().map(|style| sgr_code(style.close)).collect()
}

fn opening_sgr_sequence(active: &[ActiveStyle]) -> String {
    active.iter().map(|style| sgr_code(&style.open)).collect()
}

fn hyperlink_code(url: &str, parameters: &str) -> String {
    format!("\u{1b}]8;{parameters};{url}\u{7}")
}

/// `restoreStylesAcrossRows`: the styles and the hyperlink are closed before every row break and reopened after,
/// so each row stands on its own.
fn restore_styles_across_rows(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut active_hyperlink: Option<(String, String)> = None;
    let mut active: Vec<ActiveStyle> = Vec::new();
    let mut index = 0;
    let mut copied = 0;
    while index < bytes.len() {
        let boundary = (index..bytes.len()).find(|&at| matches!(bytes[at], b'\n' | 0x1b) || (bytes[at] == 0xc2 && bytes.get(at + 1) == Some(&0x9b)));
        let Some(at) = boundary else { break };
        index = at;
        if bytes[at] != b'\n' {
            let Some(found) = match_ansi_escape(text, at) else {
                index += if bytes[at] == 0x1b { 1 } else { 2 };
                continue;
            };
            match found.kind {
                EscapeKind::Sgr(parameters) => apply_sgr_parameters(parameters, &mut active),
                EscapeKind::Link { parameters, uri } => {
                    active_hyperlink = (!uri.is_empty()).then(|| (parameters.to_owned(), uri.to_owned()));
                }
                EscapeKind::Other => {}
            }
            index += found.len;
            continue;
        }
        // Everything up to the row break is copied verbatim, sequences included.
        out.push_str(&text[copied..index]);
        // An empty row never reopened anything, so there is nothing to close.
        if index > copied {
            if active_hyperlink.is_some() {
                out.push_str(&hyperlink_code("", ""));
            }
            out.push_str(&closing_sgr_sequence(&active));
        }
        out.push('\n');
        index += 1;
        copied = index;
        // An empty row has nothing to style, so the styles stay closed until the next row with content. A
        // trailing row break leaves no row at all.
        if index < bytes.len() && bytes[index] != b'\n' {
            let mut opening = active.clone();
            apply_leading_sgr_resets(text, index, &mut opening);
            out.push_str(&opening_sgr_sequence(&opening));
            if let Some((parameters, uri)) = &active_hyperlink {
                out.push_str(&hyperlink_code(uri, parameters));
            }
        }
    }
    out.push_str(&text[copied..]);
    out
}

// ---------------------------------------------------------------------------------------------------------------
// wrap-ansi.
// ---------------------------------------------------------------------------------------------------------------

/// `wrapWord`: a long word across several rows. Takes the width of the last row and returns the width of the row
/// the word ends on.
fn wrap_word(rows: &mut Vec<String>, word: &str, columns: usize, row_width: usize) -> usize {
    let tokens = get_tokens(word);
    let mut visible = row_width;
    for (index, token) in tokens.iter().enumerate() {
        // Escape sequences and combining marks are zero width, so they always stay on the current row.
        if token.width > 0 && visible > 0 && visible + token.width > columns {
            rows.push(String::new());
            visible = 0;
        }
        if let Some(last) = rows.last_mut() {
            last.push_str(&token.value);
        }
        visible += token.width;
        if visible == columns && index + 1 < tokens.len() {
            rows.push(String::new());
            visible = 0;
        }
    }
    // The last row may be only escape characters: they go to the row before.
    if visible == 0 && rows.len() > 1 && rows.last().is_some_and(|row| !row.is_empty()) {
        let tail = rows.pop().unwrap_or_default();
        if let Some(last) = rows.last_mut() {
            last.push_str(&tail);
        }
    }
    rows.last().map_or(0, |row| get_width(row))
}

/// `stringVisibleTrimSpacesRight`: the spaces after the last visible character, the invisible sequences among
/// them kept.
fn trim_spaces_right(row: &str) -> String {
    if !row.contains(' ') {
        return row.to_owned();
    }
    let mut parts: Vec<(String, bool)> = segments(row)
        .into_iter()
        .map(|segment| match segment {
            Segment::Plain(part) => (part.to_owned(), false),
            Segment::Escape(code) => (code.to_owned(), true),
        })
        .collect();
    for (value, is_escape) in parts.iter_mut().rev() {
        if *is_escape {
            continue;
        }
        let trimmed = value.trim_end_matches(' ').len();
        value.truncate(trimmed);
        if get_string_width(value) > 0 {
            break;
        }
    }
    parts.into_iter().map(|(value, _)| value).collect()
}

fn expand_tabs(line: &str) -> String {
    if !line.contains('\t') {
        return line.to_owned();
    }
    let mut visible = 0;
    let mut expanded = String::new();
    let mut since_tab = String::new();
    for segment in segments(line) {
        match segment {
            Segment::Plain(part) => {
                let pieces: Vec<&str> = part.split('\t').collect();
                for (at, piece) in pieces.iter().enumerate() {
                    expanded.push_str(piece);
                    since_tab.push_str(piece);
                    if at + 1 < pieces.len() {
                        visible += get_string_width(&since_tab);
                        since_tab.clear();
                        let spaces = TAB_SIZE - visible % TAB_SIZE;
                        expanded.push_str(&" ".repeat(spaces));
                        visible += spaces;
                    }
                }
            }
            Segment::Escape(code) => expanded.push_str(code),
        }
    }
    expanded
}

/// `exec(string, columns, options)`: one line (no newline in it).
///
/// `columns` is the whole cells a row may take and `measured` the width as Node was given it, a fraction when Yoga measured
/// the text at one: a `rowLength >= columns` comparison is against its ceiling (a length is a whole number, so
/// `length >= 33.68` is `length >= 34`), and the hard-wrap break counts divide by it as Node does.
fn exec(text: &str, columns: usize, measured: f64, options: WrapOptions) -> String {
    let ge_columns = measured.ceil() as usize;
    if options.trim && js_trim_start(js_trim_end(text)).is_empty() {
        return String::new();
    }
    let words = split_words(text);
    let mut rows = vec![String::new()];
    // Tracked as rows are built: remeasuring the row for every word makes wrapping quadratic in the line length.
    let mut row_length = 0usize;
    // Words are only appended, so a row that starts with content can never become trimmable again.
    let mut trimmed_row_index: Option<usize> = None;
    let mut is_first_word = true;
    for word in &words {
        let row_index = rows.len() - 1;
        if options.trim && trimmed_row_index != Some(row_index) {
            let trimmed = js_trim_start(&rows[row_index]);
            if trimmed.len() != rows[row_index].len() {
                let trimmed = trimmed.to_owned();
                row_length = get_width(&trimmed);
                rows[row_index] = trimmed;
            }
            if !rows[row_index].is_empty() {
                trimmed_row_index = Some(row_index);
            }
        }
        if is_first_word {
            is_first_word = false;
        } else {
            if row_length >= ge_columns && (!options.word_wrap || !options.trim) {
                // A new word starts and the row is as long as the columns: add a row.
                rows.push(String::new());
                row_length = 0;
            }
            if row_length > 0 || !options.trim {
                if let Some(last) = rows.last_mut() {
                    last.push(' ');
                }
                row_length += 1;
            }
        }
        // In hard wrap mode no line is allowed to extend past `columns`.
        if options.hard && options.word_wrap && word.width > columns {
            // Zero columns: the Node code divides by zero, both counts are Infinity or NaN and the comparison is
            // false, so no row is started here.
            if columns > 0 {
                // JavaScript numbers: `Math.floor((lengths[index] - remainingColumns - 1) / columns)`.
                let remaining = measured - row_length as f64;
                let width = word.width as f64;
                let breaks_starting_this_line = 1.0 + ((width - remaining - 1.0) / measured).floor();
                let breaks_starting_next_line = ((width - 1.0) / measured).floor();
                if breaks_starting_next_line < breaks_starting_this_line {
                    rows.push(String::new());
                    row_length = 0;
                }
            }
            row_length = wrap_word(&mut rows, &word.value, columns, row_length);
            continue;
        }
        if row_length + word.width > columns && row_length > 0 && word.width > 0 {
            if !options.word_wrap && row_length < ge_columns {
                row_length = wrap_word(&mut rows, &word.value, columns, row_length);
                continue;
            }
            rows.push(String::new());
            row_length = 0;
        }
        if row_length + word.width > columns && !options.word_wrap {
            row_length = wrap_word(&mut rows, &word.value, columns, row_length);
            continue;
        }
        if let Some(last) = rows.last_mut() {
            last.push_str(&word.value);
        }
        row_length += word.width;
    }
    if options.trim {
        rows = rows.iter().map(|row| trim_spaces_right(row)).collect();
    }
    restore_styles_across_rows(&rows.join("\n"))
}

/// `normalizeText`: NFC the text, but not the sequences (a combining mark after a sequence would compose with its
/// last character and destroy it).
fn normalize_text(text: &str) -> String {
    if text.is_ascii() {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    for segment in segments(text) {
        match segment {
            Segment::Plain(part) => out.extend(part.nfc()),
            Segment::Escape(code) => out.push_str(code),
        }
    }
    out
}

/// `wrapAnsi(text, columns, options)`: each line (lines end at `\n` or `\r\n`) wrapped on its own.
pub fn wrap_ansi(text: &str, columns: usize, options: WrapOptions) -> String {
    wrap_ansi_measured(text, columns, columns as f64, options)
}

/// [`wrap_ansi`] at the width Node was given, which may be a fraction (see `exec`).
fn wrap_ansi_measured(text: &str, columns: usize, measured: f64, options: WrapOptions) -> String {
    normalize_text(text).replace("\r\n", "\n").split('\n').map(|line| exec(&expand_tabs(line), columns, measured, options)).collect::<Vec<_>>().join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// The Ink fork's wrap-text: wrap-ansi and cli-truncate, then the display-width repair.
// ---------------------------------------------------------------------------------------------------------------

/// A cut of one line at a display width: the head (with the styles and the link closed) and the tail (with them
/// reopened).
struct Split {
    head: String,
    tail: String,
}

/// The length in bytes of the escape sequence at the start of `rest` that `^ESC(?:\[[0-9;]*m|\].*?(?:BEL|ESC\\))`
/// matches: an SGR sequence, or an OSC string up to its first terminator (the `.` does not cross a line break).
fn leading_escape_len(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    if bytes.first() != Some(&0x1b) {
        return None;
    }
    match bytes.get(1)? {
        b'[' => {
            let mut at = 2;
            while bytes.get(at).is_some_and(|b| b.is_ascii_digit() || *b == b';') {
                at += 1;
            }
            (bytes.get(at) == Some(&b'm')).then_some(at + 1)
        }
        b']' => {
            let mut at = 2;
            while at < bytes.len() {
                if let Some(after) = terminator_end(rest, at) {
                    return Some(after);
                }
                let ch = rest[at..].chars().next()?;
                if matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                    return None;
                }
                at += ch.len_utf8();
            }
            None
        }
        _ => None,
    }
}

/// `^ESC\[([0-9;]*)m$` on a whole sequence: the parameters.
fn sgr_parameters_of(code: &str) -> Option<&str> {
    code.strip_prefix("\u{1b}[")?.strip_suffix('m').filter(|params| params.bytes().all(|b| b.is_ascii_digit() || b == b';'))
}

/// `^ESC\]8;([^BEL ESC]*);([^BEL ESC]*)(?:BEL|ESC\\)` on a whole sequence: the URL, when there is one.
fn osc8_uri_of(code: &str) -> Option<&str> {
    let body = code.strip_prefix("\u{1b}]8;")?;
    let stop = body.find(['\u{7}', '\u{1b}']).unwrap_or(body.len());
    let terminator = &body[stop..];
    if !(terminator.starts_with('\u{7}') || terminator.starts_with("\u{1b}\\")) {
        return None;
    }
    let payload = &body[..stop];
    let last = payload.rfind(';')?;
    Some(&payload[last + 1..])
}

/// `splitAtDisplayWidth(line, max, forceFirst)`.
fn split_at_display_width(line: &str, max: usize, force_first: bool, wide: bool) -> Split {
    if display_width_with(line, wide) <= max {
        return Split { head: line.to_owned(), tail: String::new() };
    }
    let mut head = String::new();
    let mut width = 0usize;
    let mut rest = line;
    // The SGR open codes seen so far, so the tail can reopen them; a reset ('' or '0') clears them.
    let mut open_sgr = String::new();
    let mut saw_open_style = false;
    // An open OSC 8 hyperlink (an empty URL closes it).
    let mut open_link = String::new();
    while !rest.is_empty() {
        if let Some(length) = leading_escape_len(rest) {
            let code = &rest[..length];
            head.push_str(code);
            if let Some(parameters) = sgr_parameters_of(code) {
                if parameters.is_empty() || parameters == "0" {
                    open_sgr.clear();
                    saw_open_style = false;
                } else {
                    open_sgr.push_str(code);
                    saw_open_style = true;
                }
            } else if let Some(uri) = osc8_uri_of(code) {
                // The complete opener is kept, with its optional parameters such as `id=x`.
                open_link = if uri.is_empty() { String::new() } else { code.to_owned() };
            }
            rest = &rest[length..];
            continue;
        }
        let Some(segment) = rest.graphemes(true).next() else { break };
        let segment_width = display_width_with(segment, wide);
        // Progress guarantee: when nothing visible has landed on the head yet, the first cluster goes through even
        // when it alone exceeds `max`.
        if width + segment_width > max && (width > 0 || !force_first) {
            break;
        }
        head.push_str(segment);
        width += segment_width;
        rest = &rest[segment.len()..];
    }
    // Close any style or link still open at the cut and reopen it on the tail.
    if !open_link.is_empty() {
        head.push_str("\u{1b}]8;;\u{7}");
    }
    if saw_open_style {
        head.push_str("\u{1b}[0m");
    }
    let tail = if rest.is_empty() { String::new() } else { format!("{open_sgr}{open_link}{rest}") };
    Split { head, tail }
}

/// `reflowToDisplayWidth`: no visible content may be dropped; the overflow goes to the following lines.
fn reflow_to_display_width(line: &str, max: usize, wide: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = line.to_owned();
    while display_width_with(&current, wide) > max {
        let Split { head, tail } = split_at_display_width(&current, max, true, wide);
        // The cut always advances (at least one cluster goes to the head); if the tail still failed to shrink,
        // the remainder is flushed with the closes the head carries.
        if tail.is_empty() || tail == current {
            out.push(if head.is_empty() { current } else { head });
            return out;
        }
        out.push(head);
        current = tail;
    }
    out.push(current);
    out
}

/// `hardCutToDisplayWidth`: cutting is the intended behaviour; the overflow is dropped on a cluster boundary.
fn hard_cut_to_display_width(line: &str, max: usize, wide: bool) -> String {
    split_at_display_width(line, max, true, wide).head
}

/// `strictCutToDisplayWidth`: a two-cell cluster in a one-cell remainder is dropped, never forced through the edge.
fn strict_cut_to_display_width(line: &str, max: usize, wide: bool) -> String {
    if max == 0 { String::new() } else { split_at_display_width(line, max, false, wide).head }
}

/// `sliceTextByDisplayWidthWithPolicy(line, from, to, wide)`: the cells `from..to` of a line, cut at the same
/// cluster boundaries as wrapping.
pub fn slice_text_by_display_width_with(line: &str, from: usize, to: usize, wide: bool) -> String {
    let start = from;
    let end = to.max(start);
    let plain = strip_ansi(line);
    // The exact slice-ansi bytes are kept unless the policy changes this line's measured width.
    if !wide || display_width_with(&plain, true) == display_width_with(&plain, false) {
        return slice_ansi(line, start, Some(end));
    }
    if end <= start {
        return String::new();
    }
    let mut remainder = line.to_owned();
    if start > 0 {
        let prefix = split_at_display_width(&remainder, start, true, wide);
        remainder = prefix.tail;
        // When `start` lands inside a wide cluster, that whole cluster is consumed: half of it at the left edge
        // would still cross the clip boundary.
        if !remainder.is_empty() && display_width_with(&prefix.head, wide) < start {
            remainder = split_at_display_width(&remainder, 1, true, wide).tail;
        }
    }
    strict_cut_to_display_width(&remainder, end - start, wide)
}

/// `sliceTextByDisplayWidth(line, from, to)`: under the policy of this process.
pub fn slice_text_by_display_width(line: &str, from: usize, to: usize) -> String {
    slice_text_by_display_width_with(line, from, to, process_policy())
}

/// The display-width policy of this process (`policy::display_width` widens an enclosed alphanumeric when it is on).
fn process_policy() -> bool {
    static POLICY: OnceLock<bool> = OnceLock::new();
    *POLICY.get_or_init(|| display_width("\u{2460}") == 2)
}

fn has_problem_glyph(text: &str) -> bool {
    text.chars().any(|ch| matches!(ch, '\u{2190}'..='\u{21ff}' | '\u{2460}'..='\u{24ff}'))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Enforce {
    Reflow,
    Cut,
}

/// `enforceDisplayWidth`: with the policy on and a problem glyph in the text, every produced line is held to the
/// display-width budget again.
fn enforce_display_width(wrapped: String, max_width: usize, how: Enforce, wide: bool) -> String {
    if !wide || !has_problem_glyph(&strip_ansi(&wrapped)) {
        return wrapped;
    }
    let lines = wrapped.split('\n');
    match how {
        Enforce::Cut => lines.map(|line| hard_cut_to_display_width(line, max_width, wide)).collect::<Vec<_>>().join("\n"),
        Enforce::Reflow => lines.flat_map(|line| reflow_to_display_width(line, max_width, wide)).collect::<Vec<_>>().join("\n"),
    }
}

/// Ink's `wrapText(text, maxWidth, wrapType)` under the display-width policy `wide` (no cache).
pub fn wrap_text_with(text: &str, max_width: usize, mode: WrapMode, wide: bool) -> String {
    match mode {
        WrapMode::Wrap => {
            let wrapped = wrap_ansi(text, max_width, WrapOptions { trim: false, hard: true, word_wrap: true });
            enforce_display_width(wrapped, max_width, Enforce::Reflow, wide)
        }
        WrapMode::Hard => {
            let wrapped = wrap_ansi(text, max_width, WrapOptions { trim: false, hard: true, word_wrap: false });
            enforce_display_width(wrapped, max_width, Enforce::Reflow, wide)
        }
        WrapMode::TruncateEnd => {
            let cut = truncate(text, max_width, TruncatePosition::End);
            enforce_display_width(cut, max_width, Enforce::Cut, wide)
        }
        WrapMode::TruncateMiddle => truncate(text, max_width, TruncatePosition::Middle),
        WrapMode::TruncateStart => truncate(text, max_width, TruncatePosition::Start),
    }
}

/// Ink's `wrapText(text, maxWidth, wrapType)` with the width Yoga measured a text at, which is a fraction when a row
/// shrinks its texts in proportion (`floor(33.68)` columns, but a line is over the width when it is longer than that, and
/// a row full to the width starts a new row only when it reaches the next whole number). A whole width is the plain
/// [`wrap_text`]. Wrapping modes only: a truncating mode takes the whole columns.
///
/// With the display-width policy on and an arrow or enclosed glyph in the text, the repair measures every wrapped line
/// against the width again, so a line that wrapping itself leaves one cell over a fractional width (it keeps the blank it
/// added before the word that did not fit) is cut there, its overflow becoming a row of its own.
pub fn wrap_text_fractional(text: &str, max_width: f64, mode: WrapMode) -> String {
    let whole = max_width.round();
    if max_width < 1.0 || (max_width - whole).abs() < 1e-4 {
        return wrap_text(text, whole.max(0.0) as usize, mode);
    }
    let floor = max_width.floor() as usize;
    let word_wrap = match mode {
        WrapMode::Wrap => true,
        WrapMode::Hard => false,
        _ => return wrap_text(text, floor, mode),
    };
    let wide = process_policy();
    let wrapped = wrap_ansi_measured(text, floor, max_width, WrapOptions { trim: false, hard: true, word_wrap });
    enforce_display_width(wrapped, floor, Enforce::Reflow, wide)
}

/// Entries after which a cache is emptied: the Node caches are unbounded, a long session must not be.
const CACHE_LIMIT: usize = 4096;

type WrapCache = Mutex<HashMap<(String, usize, WrapMode), String>>;

fn wrap_cache() -> &'static WrapCache {
    static CACHE: OnceLock<WrapCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ink's `wrapText(text, maxWidth, wrapType)` under the policy of this process, cached by text, width and mode.
pub fn wrap_text(text: &str, max_width: usize, mode: WrapMode) -> String {
    let key = (text.to_owned(), max_width, mode);
    if let Some(hit) = wrap_cache().lock().unwrap_or_else(PoisonError::into_inner).get(&key).filter(|hit| !hit.is_empty()) {
        return hit.clone();
    }
    let wrapped = wrap_text_with(text, max_width, mode, process_policy());
    let mut cache = wrap_cache().lock().unwrap_or_else(PoisonError::into_inner);
    if cache.len() >= CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(key, wrapped.clone());
    wrapped
}

/// The size of a text: the widest line in cells and the number of lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextSize {
    pub width: usize,
    pub height: usize,
}

/// Ink's `measureText(text)` under the display-width policy `wide` (no cache): an empty text is 0 by 0.
pub fn measure_text_with(text: &str, wide: bool) -> TextSize {
    if text.is_empty() {
        return TextSize { width: 0, height: 0 };
    }
    let width = text.split('\n').map(|line| display_width_with(line, wide)).max().unwrap_or(0);
    TextSize { width, height: text.split('\n').count() }
}

fn measure_cache() -> &'static Mutex<HashMap<String, TextSize>> {
    static CACHE: OnceLock<Mutex<HashMap<String, TextSize>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ink's `measureText(text)` under the policy of this process, cached by text.
pub fn measure_text(text: &str) -> TextSize {
    if let Some(hit) = measure_cache().lock().unwrap_or_else(PoisonError::into_inner).get(text) {
        return *hit;
    }
    let size = measure_text_with(text, process_policy());
    let mut cache = measure_cache().lock().unwrap_or_else(PoisonError::into_inner);
    if cache.len() >= CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(text.to_owned(), size);
    size
}

/// `sanitizeAnsi(text)`: the escape sequences that would conflict with Ink's layout are removed. Kept: SGR
/// sequences (`CSI` digits, `:` and `;`, `m`) and OSC strings (hyperlinks and the like). Everything else that is an
/// escape or a C1 control, and an unterminated sequence with all that follows it, is dropped.
pub fn sanitize_ansi(text: &str) -> String {
    if !crate::ansi::has_ansi_control_characters(text) {
        return text.to_owned();
    }
    let mut out = String::new();
    for token in tokenize_ink(text) {
        let keep = match token.kind {
            InkTokenKind::Text | InkTokenKind::Osc => true,
            InkTokenKind::Csi => {
                token.final_char == Some('m')
                    && token.intermediates.is_empty()
                    && token.parameters.bytes().all(|b| b.is_ascii_digit() || b == b':' || b == b';')
            }
            _ => false,
        };
        if keep {
            out.push_str(&token.value);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// src/tui/markdown/ansi-line-wrap.mjs
// ---------------------------------------------------------------------------------------------------------------

/// `wrapText(text, width, { hard })` of `ansi-line-wrap.mjs`: the non-empty lines of the text wrapped (never trimmed
/// at the start), or one empty line. A width of 0 returns the text as one line.
pub fn wrap_lines(text: &str, width: usize, hard: bool) -> Vec<String> {
    if width == 0 {
        return vec![text.to_owned()];
    }
    let wrapped = wrap_ansi(js_trim_end(text), width, WrapOptions { hard, trim: false, word_wrap: true });
    let lines: Vec<String> = wrapped.split('\n').filter(|line| !line.is_empty()).map(str::to_owned).collect();
    if lines.is_empty() { vec![String::new()] } else { lines }
}

/// The display width of UTF-16 units, as Node measures a string that may hold half of a surrogate pair: such a half
/// is a cluster of its own and takes no cell (string-width counts `\p{Surrogate}` as zero), so the width is that of the
/// well-formed runs between the halves.
fn width_of_units(units: &[u16], wide: bool) -> usize {
    display_width_with(&lone::from_units(units), wide)
}

/// `hardWrapAnsiLines(text, width)` under the display-width policy `wide`: a half of a cut pair is U+FFFD in the
/// lines, which is what Node writes to a terminal for it.
pub fn hard_wrap_ansi_lines_with(text: &str, columns: usize, wide: bool) -> Vec<String> {
    hard_wrap_ansi_lines_carrying(text, columns, wide).iter().map(|line| lone::replace_carriers(line)).collect()
}

/// `hardWrapAnsiLines(text, width)` with the halves of a cut pair carried as [`lone`] carriers (zero cells wide, one
/// unit long), so that a later cut or measure of these lines reads them as Node reads the halves. The text may hold
/// the carriers of an earlier cut.
pub fn hard_wrap_ansi_lines_carrying(text: &str, columns: usize, wide: bool) -> Vec<String> {
    let max = columns.max(1);
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut out = Vec::new();
    for soft_line in wrap_lines(text, max, true) {
        if soft_line.chars().any(|c| c.len_utf16() == 2) {
            // The Node code cuts at UTF-16 units (the longest prefix that fits, at least one unit), so a cut can
            // fall inside a surrogate pair and leave a half on each side.
            let mut units: Vec<u16> = lone::to_units(&soft_line);
            while !units.is_empty() && width_of_units(&units, wide) > max {
                let mut take = 1;
                for at in 1..=units.len() {
                    if width_of_units(&units[..at], wide) <= max {
                        take = at;
                    } else {
                        break;
                    }
                }
                out.push(lone::from_units(&units[..take]));
                units.drain(..take);
            }
            if !units.is_empty() {
                out.push(lone::from_units(&units));
            }
            continue;
        }
        let mut rest: &str = &soft_line;
        while !rest.is_empty() && display_width_with(rest, wide) > max {
            // The longest prefix, at a character boundary, whose width fits (the first prefix that does not fit ends
            // the search); at least one character.
            let mut take = rest.chars().next().map_or(0, char::len_utf8);
            for (at, ch) in rest.char_indices() {
                let end = at + ch.len_utf8();
                if display_width_with(&rest[..end], wide) <= max {
                    take = end;
                } else {
                    break;
                }
            }
            out.push(rest[..take].to_owned());
            rest = &rest[take..];
        }
        if !rest.is_empty() {
            out.push(rest.to_owned());
        }
    }
    if out.is_empty() { vec![String::new()] } else { out }
}

/// `hardWrapAnsiLines(text, width)` with the halves of a cut pair carried (see [`hard_wrap_ansi_lines_carrying`]), for a
/// caller that cuts or measures the lines again.
pub fn hard_wrap_ansi_lines_carried(text: &str, columns: usize) -> Vec<String> {
    hard_wrap_ansi_lines_carrying(text, columns, process_policy())
}

/// `hardWrapAnsiLines(text, width)`: the lines of `text` cut at `columns` cells, escapes carried across the cuts.
pub fn hard_wrap_ansi_lines(text: &str, columns: usize) -> Vec<String> {
    hard_wrap_ansi_lines_with(text, columns, process_policy())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(text: &str, columns: usize) -> String {
        wrap_ansi(text, columns, WrapOptions::default())
    }

    fn hard(text: &str, columns: usize) -> String {
        wrap_ansi(text, columns, WrapOptions { hard: true, ..WrapOptions::default() })
    }

    #[test]
    fn a_hard_cut_falls_between_the_units_of_a_pair_as_node_cuts() {
        // A half of a pair takes no cell; each half is the replacement character in the lines.
        assert_eq!(hard_wrap_ansi_lines_with("\u{1F642}a", 1, false), ["\u{FFFD}", "\u{FFFD}", "a"]);
        assert_eq!(hard_wrap_ansi_lines_with("\u{1F642}\u{1F642}", 2, false), ["\u{1F642}", "\u{1F642}"]);
    }

    #[test]
    fn a_carried_half_takes_no_cell_when_the_lines_are_cut_again() {
        let half = lone::carrier_of(0xde42);
        let fits = hard_wrap_ansi_lines_carrying(&format!("{half}ab"), 2, false);
        assert_eq!(fits.len(), 1, "the half and two letters are two cells");
        let cut = hard_wrap_ansi_lines_carrying(&format!("{half}a b"), 2, false);
        let shown: Vec<String> = cut.iter().map(|line| lone::replace_carriers(line)).collect();
        assert_eq!(shown, ["\u{FFFD}a ", "b"]);
    }

    #[test]
    fn words_wrap_at_spaces() {
        assert_eq!(wrap("the quick brown fox", 10), "the quick\nbrown fox");
        assert_eq!(wrap("abc def", 7), "abc def");
        assert_eq!(wrap("", 5), "");
        assert_eq!(wrap("   ", 5), "");
    }

    #[test]
    fn a_long_word_stays_whole_unless_hard() {
        assert_eq!(wrap("abcdefghij", 4), "abcdefghij");
        assert_eq!(hard("abcdefghij", 4), "abcd\nefgh\nij");
    }

    #[test]
    fn wide_characters_wrap_whole() {
        assert_eq!(hard("界界界", 4), "界界\n界");
        assert_eq!(hard("e\u{301}e\u{301}e\u{301}", 2), "éé\né");
    }

    #[test]
    fn styles_are_closed_and_reopened_across_rows() {
        assert_eq!(hard("\x1b[31mabcdef\x1b[39m", 3), "\x1b[31mabc\x1b[39m\n\x1b[31mdef\x1b[39m");
        assert_eq!(wrap("\x1b[1m\x1b[31mab cd\x1b[39m\x1b[22m", 3), "\x1b[1m\x1b[31mab\x1b[39m\x1b[22m\n\x1b[1m\x1b[31mcd\x1b[39m\x1b[22m");
    }

    #[test]
    fn hyperlinks_are_closed_and_reopened_across_rows() {
        let text = "\x1b]8;;http://u\x07abcdef\x1b]8;;\x07";
        assert_eq!(hard(text, 3), "\x1b]8;;http://u\x07abc\x1b]8;;\x07\n\x1b]8;;http://u\x07def\x1b]8;;\x07");
    }

    #[test]
    fn tabs_expand_to_eight_columns() {
        assert_eq!(wrap("a\tb", 20), "a       b");
        assert_eq!(wrap("12345678\tb", 20), "12345678        b");
    }

    #[test]
    fn trim_false_keeps_the_leading_spaces() {
        let options = WrapOptions { trim: false, ..WrapOptions::default() };
        assert_eq!(wrap_ansi("  ab cd", 20, options), "  ab cd");
        assert_eq!(wrap_ansi("ab  cd", 3, options), "ab \n cd");
    }

    #[test]
    fn crlf_is_a_line_break() {
        assert_eq!(wrap("a\r\nb", 5), "a\nb");
    }

    #[test]
    fn text_is_normalised_but_sequences_are_not() {
        assert_eq!(wrap("e\u{301}", 5), "\u{e9}");
        assert_eq!(wrap("\x1b[31m\u{301}", 5), "\x1b[31m\u{301}");
    }

    #[test]
    fn escapes_are_recognised_like_the_regular_expression() {
        let m = |text: &str| match_ansi_escape(text, 0).map(|found| found.len);
        assert_eq!(m("\x1b[31mx"), Some(5));
        assert_eq!(m("\x1b[?25hx"), Some(6));
        assert_eq!(m("\u{9b}1mx"), Some(4));
        assert_eq!(m("\x1b]8;;u\x07x"), Some(7));
        assert_eq!(m("\x1b]0;t\x1b\\x"), Some(7));
        assert_eq!(m("\x1b]0;t"), None);
        assert_eq!(m("\x1b]0;a\u{9c}"), None);
        assert_eq!(m("\x1b[1;"), None);
        assert_eq!(m("\x1bx"), None);
        assert!(matches!(match_ansi_escape("\x1b]8;id=x;http://u\x07", 0).map(|f| f.kind), Some(EscapeKind::Link { parameters: "id=x", uri: "http://u" })));
        assert!(matches!(match_ansi_escape("\x1b]8;a\x07", 0).map(|f| f.kind), Some(EscapeKind::Other)));
        assert!(matches!(match_ansi_escape("\x1b[m", 0).map(|f| f.kind), Some(EscapeKind::Sgr(""))));
        assert!(matches!(match_ansi_escape("\x1b[?1m", 0).map(|f| f.kind), Some(EscapeKind::Other)));
    }

    #[test]
    fn sgr_tokens_keep_extended_colours_together() {
        let tokens = sgr_tokens("1;38;5;196;48;2;1;2;3");
        let opens: Vec<&str> = tokens.iter().map(|t| t.open.as_str()).collect();
        assert_eq!(opens, ["1", "38;5;196", "48;2;1;2;3"]);
        assert_eq!(sgr_tokens("38;2;1").len(), 0);
        assert_eq!(sgr_tokens("38:5:9").len(), 1);
        assert_eq!(sgr_tokens("38:2::1:2:3").len(), 1);
        assert_eq!(sgr_tokens("38:2:1:2").len(), 0);
    }

    #[test]
    fn nested_styles_reset_by_their_own_codes() {
        let wrapped = hard("\x1b[1mab\x1b[22m\x1b[31mcdef\x1b[39m", 3);
        assert_eq!(wrapped, "\x1b[1mab\x1b[22m\x1b[31mc\x1b[39m\n\x1b[31mdef\x1b[39m");
    }

    #[test]
    fn sanitize_keeps_sgr_and_osc_only() {
        assert_eq!(sanitize_ansi("a\x1b[31mb\x1b[2Jc\x1b[?25hd"), "a\x1b[31mbcd");
        assert_eq!(sanitize_ansi("\x1b]8;;u\x07x\x1b]8;;\x07"), "\x1b]8;;u\x07x\x1b]8;;\x07");
        assert_eq!(sanitize_ansi("a\x1b]0;unterminated"), "a");
        assert_eq!(sanitize_ansi("a\x1b[1;38:2::1:2:3mb"), "a\x1b[1;38:2::1:2:3mb");
        assert_eq!(sanitize_ansi("a\x1b[1 qb"), "ab");
        assert_eq!(sanitize_ansi("a\u{85}b\x1bcb"), "abb");
        assert_eq!(sanitize_ansi("plain"), "plain");
    }

    #[test]
    fn measure_is_the_widest_line_and_the_line_count() {
        assert_eq!(measure_text_with("", true), TextSize { width: 0, height: 0 });
        assert_eq!(measure_text_with("ab\n日本語\nc", false), TextSize { width: 6, height: 3 });
        assert_eq!(measure_text_with("\u{2460}", true).width, 2);
        assert_eq!(measure_text_with("\u{2460}", false).width, 1);
    }

    #[test]
    fn ink_wrap_modes() {
        assert_eq!(wrap_text_with("abcdef ghij", 5, WrapMode::Wrap, false), "abcde\nf \nghij");
        assert_eq!(wrap_text_with("abcdefgh", 3, WrapMode::Hard, false), "abc\ndef\ngh");
        assert_eq!(wrap_text_with("abcdefghij", 6, WrapMode::TruncateEnd, false), "abcde\u{2026}");
        assert_eq!(wrap_text_with("abcdefghij", 6, WrapMode::TruncateStart, false), "\u{2026}fghij");
        assert_eq!(wrap_text_with("abcdefghij", 6, WrapMode::TruncateMiddle, false), "abc\u{2026}ij");
    }

    #[test]
    fn the_policy_reflows_a_wrapped_line_that_overflows() {
        // Plain string_width counts each circled digit 1; the policy 2.
        assert_eq!(wrap_text_with("\u{2460}\u{2461}\u{2462}\u{2463}\u{2464}", 7, WrapMode::Wrap, false), "\u{2460}\u{2461}\u{2462}\u{2463}\u{2464}");
        assert_eq!(wrap_text_with("\u{2460}\u{2461}\u{2462}\u{2463}\u{2464}", 7, WrapMode::Wrap, true), "\u{2460}\u{2461}\u{2462}\n\u{2463}\u{2464}");
    }

    #[test]
    fn a_reflow_cut_closes_what_it_leaves_open_and_reopens_it() {
        let wrap_on = |text: &str, columns, mode| wrap_text_with(text, columns, mode, true);
        assert_eq!(wrap_on("\x1b[31m①②③\x1b[39m", 5, WrapMode::Wrap), "\x1b[31m①②\x1b[0m\n\x1b[31m③\x1b[39m");
        assert_eq!(wrap_on("\x1b]8;;http://u\x07①②③\x1b]8;;\x07", 5, WrapMode::Wrap), "\x1b]8;;http://u\x07①②\x1b]8;;\x07\n\x1b]8;;http://u\x07③\x1b]8;;\x07");
        assert_eq!(wrap_on("\x1b[31;1m①②\x1b[0m③", 3, WrapMode::Hard), "\x1b[31;1m①\x1b[0m\n\x1b[31;1m②\x1b[0m\n③");
    }

    #[test]
    fn a_truncated_line_is_cut_to_the_budget_under_the_policy() {
        assert_eq!(wrap_text_with("①②③④", 5, WrapMode::TruncateEnd, true), "①②");
        assert_eq!(wrap_text_with("①②③④", 5, WrapMode::TruncateEnd, false), "①②③④");
        assert_eq!(wrap_text_with("\x1b[31m①②③④\x1b[39m", 5, WrapMode::TruncateEnd, true), "\x1b[31m①②\x1b[0m");
    }

    #[test]
    fn slicing_by_display_width_keeps_slice_ansi_bytes_without_the_policy() {
        assert_eq!(slice_text_by_display_width_with("\x1b[31mabcdef\x1b[39m", 1, 3, false), "\x1b[31mbc\x1b[39m");
        assert_eq!(slice_text_by_display_width_with("\u{2460}\u{2461}\u{2462}", 2, 4, true), "\u{2461}");
        assert_eq!(slice_text_by_display_width_with("\u{2460}\u{2461}\u{2462}", 1, 4, true), "\u{2461}");
    }

    #[test]
    fn hard_wrap_lines() {
        assert_eq!(hard_wrap_ansi_lines_with("", 5, false), [""]);
        assert_eq!(hard_wrap_ansi_lines_with("abcdefgh", 3, false), ["abc", "def", "gh"]);
        assert_eq!(hard_wrap_ansi_lines_with("abcdefgh", 0, false), ["a", "b", "c", "d", "e", "f", "g", "h"]);
        assert_eq!(hard_wrap_ansi_lines_with("ab\n\ncd  \n", 5, false), ["ab", "cd"]);
        assert_eq!(hard_wrap_ansi_lines_with("  \n", 5, false), [""]);
        assert_eq!(hard_wrap_ansi_lines_with("\u{2460}\u{2461}\u{2462}\u{2463}", 4, true), ["\u{2460}\u{2461}", "\u{2462}\u{2463}"]);
    }

    #[test]
    fn wrap_lines_returns_the_text_for_no_width() {
        assert_eq!(wrap_lines(" a\n\nb  \n", 0, false), [" a\n\nb  \n"]);
        assert_eq!(wrap_lines("  a\n\nb  \n", 80, false), ["  a", "b"]);
        assert_eq!(wrap_lines(" \n\t", 80, false), [""]);
        assert_eq!(wrap_lines("abcdef", 3, false), ["abcdef"]);
        assert_eq!(wrap_lines("abcdef", 3, true), ["abc", "def"]);
    }

    #[test]
    fn hard_wrap_at_zero_columns_starts_no_empty_row() {
        // Recorded from wrap-ansi 10.0.2: one cell per row, no leading empty row.
        let hard = WrapOptions { hard: true, ..WrapOptions::default() };
        assert_eq!(wrap_ansi("abc", 0, hard), "a\nb\nc");
        assert_eq!(wrap_ansi("ab cd", 0, WrapOptions { trim: false, ..hard }), "a\nb\n \nc\nd");
        assert_eq!(wrap_ansi("a", 0, hard), "a");
    }

    #[test]
    fn caches_return_what_was_computed() {
        assert_eq!(wrap_text("abc def", 3, WrapMode::Wrap), wrap_text("abc def", 3, WrapMode::Wrap));
        assert_eq!(measure_text("abc"), measure_text("abc"));
    }
}
