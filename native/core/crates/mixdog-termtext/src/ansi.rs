//! Splitting a string into text and escape sequences: the tokenizer of the Ink fork (`node_modules/ink/build/
//! ansi-tokenizer.js`, with `sanitize-ansi.js` on top in `wrap`) and `@alcalzone/ansi-tokenize` 0.3.0, which Ink's
//! output buffer uses to clip and to diff styles.
//!
//! Widths: the characters of [`StyledToken::Char`] are classified the way `@alcalzone/ansi-tokenize` does it
//! (`is-fullwidth-code-point`, a variation selector 16, a regional indicator): 2 or 1 cell. The Ink tokenizer
//! measures nothing.
//!
//! Strings are walked as chars; the JavaScript code walks UTF-16 units. The two differ only in how far an index
//! moves over a character outside the BMP, which no decision in either tokenizer depends on.

use std::cmp::Ordering;
use std::fmt::Display;

use unicode_segmentation::UnicodeSegmentation;

use crate::width_tables::WIDE;

pub(crate) const ESC: char = '\u{1b}';
pub(crate) const BEL: char = '\u{7}';
pub(crate) const C1_CSI: char = '\u{9b}';
pub(crate) const C1_ST: char = '\u{9c}';
pub(crate) const C1_OSC: char = '\u{9d}';
pub(crate) const C1_DCS: char = '\u{90}';
pub(crate) const C1_PM: char = '\u{9e}';
pub(crate) const C1_APC: char = '\u{9f}';
pub(crate) const C1_SOS: char = '\u{98}';

/// The SGR sequence of a code: `ansiStyles.color.ansi(code)`.
pub(crate) fn sgr_code(code: impl Display) -> String {
    format!("\u{1b}[{code}m")
}

/// `ansiStyles.codes.get(code)` of ansi-styles 6.2.3: the code that closes an opening SGR code.
pub(crate) fn style_close(code: i64) -> Option<i64> {
    match code {
        0 => Some(0),
        1 | 2 => Some(22),
        3 => Some(23),
        4 => Some(24),
        53 => Some(55),
        7 => Some(27),
        8 => Some(28),
        9 => Some(29),
        30..=37 | 90..=97 => Some(39),
        40..=47 | 100..=107 => Some(49),
        _ => None,
    }
}

/// Whether `code` is the closing code of some style (the values of `ansiStyles.codes`).
pub(crate) fn is_close_code(code: i64) -> bool {
    matches!(code, 0 | 22 | 23 | 24 | 55 | 27 | 28 | 29 | 39 | 49)
}

/// `String.prototype.trim`'s white space: the WhiteSpace and LineTerminator productions of ECMAScript.
pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\u{b}' | '\u{c}' | ' ' | '\u{a0}' | '\u{feff}' | '\n' | '\r' | '\u{2028}' | '\u{2029}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

/// `text.trimStart()`.
pub(crate) fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `text.trimEnd()`.
pub(crate) fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// `Number.parseInt(text, 10)`: the leading integer, or `None` for NaN. Values past `i64` saturate.
pub(crate) fn js_parse_int(text: &str) -> Option<i64> {
    let text = js_trim_start(text);
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let count = digits.bytes().take_while(u8::is_ascii_digit).count();
    if count == 0 {
        return None;
    }
    let value = digits[..count].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// `isFullwidthCodePoint(cp)` of is-fullwidth-code-point 5.1.0: Fullwidth or Wide in the East Asian Width tables.
pub(crate) fn is_fullwidth_code_point(ch: char) -> bool {
    let cp = u32::from(ch);
    WIDE.binary_search_by(|&(lo, hi)| {
        if hi < cp {
            Ordering::Less
        } else if lo > cp {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    })
    .is_ok()
}

// ---------------------------------------------------------------------------------------------------------------
// The tokenizer of the Ink fork.
// ---------------------------------------------------------------------------------------------------------------

/// A piece of a string: visible text, or one escape sequence (SGR, cursor, OSC 8 hyperlink).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnsiToken {
    Text(String),
    Escape(String),
}

/// The kind of a token of the Ink tokenizer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InkTokenKind {
    Text,
    /// `ESC [` or U+009B, parameters, intermediates, a final byte.
    Csi,
    /// `ESC`, intermediates, a final byte (or a lone ESC, which the Node tokenizer drops).
    Esc,
    Osc,
    Dcs,
    Pm,
    Apc,
    Sos,
    /// A lone U+009C.
    St,
    /// Any other C1 control.
    C1,
    /// A sequence without its end: the rest of the text, which callers drop as one unsafe unit.
    Invalid,
}

/// One token of [`tokenize_ink`]. The fields after `value` are set for `Csi` tokens only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InkToken {
    pub kind: InkTokenKind,
    pub value: String,
    pub parameters: String,
    pub intermediates: String,
    pub final_char: Option<char>,
}

impl InkToken {
    fn plain(kind: InkTokenKind, value: String) -> Self {
        Self { kind, value, parameters: String::new(), intermediates: String::new(), final_char: None }
    }

    fn csi(value: String, csi: CsiSequence) -> Self {
        Self { kind: InkTokenKind::Csi, value, parameters: csi.parameters, intermediates: csi.intermediates, final_char: Some(csi.final_char) }
    }
}

pub(crate) fn is_csi_parameter(ch: char) -> bool {
    ('\u{30}'..='\u{3f}').contains(&ch)
}

pub(crate) fn is_intermediate(ch: char) -> bool {
    ('\u{20}'..='\u{2f}').contains(&ch)
}

pub(crate) fn is_csi_final(ch: char) -> bool {
    ('\u{40}'..='\u{7e}').contains(&ch)
}

fn is_escape_final(ch: char) -> bool {
    ('\u{30}'..='\u{7e}').contains(&ch)
}

fn is_c1_control(ch: char) -> bool {
    ('\u{80}'..='\u{9f}').contains(&ch)
}

/// `hasAnsiControlCharacters(text)`: an ESC or a C1 control is present.
pub fn has_ansi_control_characters(text: &str) -> bool {
    text.chars().any(|ch| ch == ESC || is_c1_control(ch))
}

struct CsiSequence {
    end: usize,
    parameters: String,
    intermediates: String,
    final_char: char,
}

fn collect(chars: &[char], from: usize, to: usize) -> String {
    chars[from..to].iter().collect()
}

fn read_csi(chars: &[char], from: usize) -> Option<CsiSequence> {
    let mut at = from;
    while chars.get(at).is_some_and(|&c| is_csi_parameter(c)) {
        at += 1;
    }
    let parameters = collect(chars, from, at);
    let intermediates_from = at;
    while chars.get(at).is_some_and(|&c| is_intermediate(c)) {
        at += 1;
    }
    let intermediates = collect(chars, intermediates_from, at);
    let final_char = *chars.get(at).filter(|&&c| is_csi_final(c))?;
    Some(CsiSequence { end: at + 1, parameters, intermediates, final_char })
}

/// The end of the control string whose payload starts at `from`: after BEL (when allowed), U+009C or `ESC \`.
/// `ESC ESC` is an escaped ESC of the payload (tmux).
fn find_terminator(chars: &[char], from: usize, allow_bell: bool) -> Option<usize> {
    let mut at = from;
    while at < chars.len() {
        let ch = chars[at];
        if (allow_bell && ch == BEL) || ch == C1_ST {
            return Some(at + 1);
        }
        if ch == ESC {
            match chars.get(at + 1) {
                Some(&ESC) => {
                    at += 2;
                    continue;
                }
                Some(&'\\') => return Some(at + 2),
                _ => {}
            }
        }
        at += 1;
    }
    None
}

/// `ESC`, intermediates, a final character: the end of the sequence.
fn read_escape(chars: &[char], from: usize) -> Option<usize> {
    let mut at = from;
    while chars.get(at).is_some_and(|&c| is_intermediate(c)) {
        at += 1;
    }
    chars.get(at).filter(|&&c| is_escape_final(c)).map(|_| at + 1)
}

fn control_string_of_escape(ch: char) -> Option<(InkTokenKind, bool)> {
    match ch {
        ']' => Some((InkTokenKind::Osc, true)),
        'P' => Some((InkTokenKind::Dcs, false)),
        '^' => Some((InkTokenKind::Pm, false)),
        '_' => Some((InkTokenKind::Apc, false)),
        'X' => Some((InkTokenKind::Sos, false)),
        _ => None,
    }
}

fn control_string_of_c1(ch: char) -> Option<(InkTokenKind, bool)> {
    match ch {
        C1_OSC => Some((InkTokenKind::Osc, true)),
        C1_DCS => Some((InkTokenKind::Dcs, false)),
        C1_PM => Some((InkTokenKind::Pm, false)),
        C1_APC => Some((InkTokenKind::Apc, false)),
        C1_SOS => Some((InkTokenKind::Sos, false)),
        _ => None,
    }
}

fn push_text(tokens: &mut Vec<InkToken>, chars: &[char], from: usize, upto: usize) {
    if upto > from {
        tokens.push(InkToken::plain(InkTokenKind::Text, collect(chars, from, upto)));
    }
}

/// The text before a sequence that never ends, then the rest of the input as one `Invalid` token.
fn push_invalid_rest(tokens: &mut Vec<InkToken>, chars: &[char], text_start: usize, at: usize) {
    push_text(tokens, chars, text_start, at);
    tokens.push(InkToken::plain(InkTokenKind::Invalid, collect(chars, at, chars.len())));
}

/// `tokenizeAnsi(text)` of the Ink fork. A text without ESC or C1 controls is one `Text` token. An incomplete
/// sequence ends the walk: the text before it, then the rest as one `Invalid` token. A lone ESC (not followed by
/// an escape sequence) is an `Esc` token holding just the ESC; the Node tokenizer drops it, and every consumer
/// drops an `Esc` token, so nothing changes but that the tokens now join back to the input.
pub fn tokenize_ink(text: &str) -> Vec<InkToken> {
    if !has_ansi_control_characters(text) {
        return vec![InkToken::plain(InkTokenKind::Text, text.to_owned())];
    }
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut text_start = 0;
    let mut at = 0;
    while at < chars.len() {
        let ch = chars[at];
        if ch == ESC {
            let Some(&following) = chars.get(at + 1) else {
                push_invalid_rest(&mut tokens, &chars, text_start, at);
                return tokens;
            };
            if following == '[' {
                let Some(csi) = read_csi(&chars, at + 2) else {
                    push_invalid_rest(&mut tokens, &chars, text_start, at);
                    return tokens;
                };
                push_text(&mut tokens, &chars, text_start, at);
                let end = csi.end;
                tokens.push(InkToken::csi(collect(&chars, at, end), csi));
                at = end;
                text_start = at;
                continue;
            }
            if let Some((kind, bell)) = control_string_of_escape(following) {
                let Some(end) = find_terminator(&chars, at + 2, bell) else {
                    push_invalid_rest(&mut tokens, &chars, text_start, at);
                    return tokens;
                };
                push_text(&mut tokens, &chars, text_start, at);
                tokens.push(InkToken::plain(kind, collect(&chars, at, end)));
                at = end;
                text_start = at;
                continue;
            }
            match read_escape(&chars, at + 1) {
                None => {
                    if is_intermediate(following) {
                        push_invalid_rest(&mut tokens, &chars, text_start, at);
                        return tokens;
                    }
                    push_text(&mut tokens, &chars, text_start, at);
                    tokens.push(InkToken::plain(InkTokenKind::Esc, ESC.to_string()));
                    at += 1;
                    text_start = at;
                }
                Some(end) => {
                    push_text(&mut tokens, &chars, text_start, at);
                    tokens.push(InkToken::plain(InkTokenKind::Esc, collect(&chars, at, end)));
                    at = end;
                    text_start = at;
                }
            }
            continue;
        }
        if ch == C1_CSI {
            let Some(csi) = read_csi(&chars, at + 1) else {
                push_invalid_rest(&mut tokens, &chars, text_start, at);
                return tokens;
            };
            push_text(&mut tokens, &chars, text_start, at);
            let end = csi.end;
            tokens.push(InkToken::csi(collect(&chars, at, end), csi));
            at = end;
            text_start = at;
            continue;
        }
        if let Some((kind, bell)) = control_string_of_c1(ch) {
            let Some(end) = find_terminator(&chars, at + 1, bell) else {
                push_invalid_rest(&mut tokens, &chars, text_start, at);
                return tokens;
            };
            push_text(&mut tokens, &chars, text_start, at);
            tokens.push(InkToken::plain(kind, collect(&chars, at, end)));
            at = end;
            text_start = at;
            continue;
        }
        if is_c1_control(ch) {
            push_text(&mut tokens, &chars, text_start, at);
            let kind = if ch == C1_ST { InkTokenKind::St } else { InkTokenKind::C1 };
            tokens.push(InkToken::plain(kind, ch.to_string()));
            at += 1;
            text_start = at;
            continue;
        }
        at += 1;
    }
    push_text(&mut tokens, &chars, text_start, chars.len());
    tokens
}

/// The tokens of `text`, in order; joined again they give `text`. Visible text is `Text`; every escape sequence,
/// and an unterminated one with everything after it, is `Escape`.
pub fn tokenize(text: &str) -> Vec<AnsiToken> {
    tokenize_ink(text)
        .into_iter()
        .map(|token| match token.kind {
            InkTokenKind::Text => AnsiToken::Text(token.value),
            _ => AnsiToken::Escape(token.value),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// @alcalzone/ansi-tokenize 0.3.0.
// ---------------------------------------------------------------------------------------------------------------

const LINK_PREFIX: &str = "\u{1b}]8;";
const LINK_END: &str = "\u{1b}]8;;\u{7}";
const LINK_END_ST: &str = "\u{1b}]8;;\u{1b}\\";
const LINK_END_C1_ST: &str = "\u{1b}]8;;\u{9c}";

/// An SGR or hyperlink code with the code that ends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnsiCode {
    pub code: String,
    pub end_code: String,
}

/// A token of [`tokenize_styled`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StyledToken {
    /// An SGR code (compound ones split into one token per code) or an OSC 8 hyperlink.
    Ansi(AnsiCode),
    /// Another OSC sequence: zero width, nothing to end.
    Control(String),
    Char {
        value: String,
        full_width: bool,
    },
}

/// A visible character with the styles active at it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledChar {
    pub value: String,
    pub full_width: bool,
    pub styles: Vec<AnsiCode>,
}

/// `getLinkStartCode(url, params)`: the OSC 8 opener, its parameters joined as `key=value:key=value`.
pub fn link_start_code(url: &str, params: &[(&str, &str)]) -> String {
    let joined: Vec<String> = params.iter().map(|(key, value)| format!("{key}={value}")).collect();
    format!("{LINK_PREFIX}{};{url}{BEL}", joined.join(":"))
}

/// The number of an SGR code written canonically (`ESC [ n m`, no leading zeros), the only form ansi-styles knows.
fn canonical_sgr(code: &str) -> Option<i64> {
    let number = code.strip_prefix("\u{1b}[")?.strip_suffix('m')?.parse::<i64>().ok()?;
    (sgr_code(number) == code).then_some(number)
}

/// `getEndCode(code)`: the code that ends `code`.
pub fn end_code_of(code: &str) -> String {
    if let Some(number) = canonical_sgr(code) {
        if is_close_code(number) {
            return code.to_owned();
        }
        if let Some(close) = style_close(number) {
            return sgr_code(close);
        }
    }
    if code.starts_with(LINK_PREFIX) {
        if code.ends_with("\u{1b}\\") {
            return LINK_END_ST.to_owned();
        }
        if code.ends_with(C1_ST) {
            return LINK_END_C1_ST.to_owned();
        }
        return LINK_END.to_owned();
    }
    let rest = code.char_indices().nth(2).map_or("", |(at, _)| &code[at..]);
    if rest.starts_with("38") {
        return sgr_code(39);
    }
    if rest.starts_with("48") {
        return sgr_code(49);
    }
    match js_parse_int(rest).and_then(style_close) {
        Some(close) if close != 0 => sgr_code(close),
        _ => sgr_code(0),
    }
}

fn is_intensity(code: &AnsiCode) -> bool {
    code.code == "\u{1b}[1m" || code.code == "\u{1b}[2m"
}

/// The index of the last char of the first OSC terminator at or after `from`: BEL, U+009C, or the `\` of `ESC \`.
fn osc_terminator_index(chars: &[char], from: usize) -> Option<usize> {
    let mut at = from;
    while at < chars.len() {
        let ch = chars[at];
        if ch == BEL || ch == C1_ST {
            return Some(at);
        }
        if ch == ESC && chars.get(at + 1) == Some(&'\\') {
            return Some(at + 1);
        }
        at += 1;
    }
    None
}

/// `parseLinkCode`: `rest` starts at the escape; the code is `?]8;`, the parameters, `;`, the URL and a terminator.
/// Only the three chars after the first are compared with the prefix.
fn parse_link_code(rest: &[char]) -> Option<usize> {
    if rest.get(1) != Some(&']') || rest.get(2) != Some(&'8') || rest.get(3) != Some(&';') {
        return None;
    }
    let params_end = rest.iter().enumerate().skip(4).find(|&(_, &c)| c == ';').map(|(at, _)| at)?;
    osc_terminator_index(rest, params_end + 1).map(|last| last + 1)
}

/// `parseSGRSequence`: `ESC [`, digits and semicolons, `m`.
fn parse_sgr_sequence(rest: &[char]) -> Option<usize> {
    for (at, &ch) in rest.iter().enumerate().skip(2) {
        if ch == 'm' {
            return Some(at + 1);
        }
        if ch != ';' && !ch.is_ascii_digit() {
            return None;
        }
    }
    None
}

/// `splitCompoundSGRSequences(code)`: `ESC[1;3;31m` as `ESC[1m`, `ESC[3m`, `ESC[31m`; an extended colour stays whole.
fn split_compound_sgr(code: &[char]) -> Vec<String> {
    if !code.contains(&';') {
        return vec![code.iter().collect()];
    }
    let inner: String = code[2..code.len() - 1].iter().collect();
    let parts: Vec<&str> = inner.split(';').collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < parts.len() {
        let raw = parts[at];
        if raw == "38" || raw == "48" {
            if at + 2 < parts.len() && parts[at + 1] == "5" {
                out.push(parts[at..at + 3].join(";"));
                at += 3;
                continue;
            }
            if at + 4 < parts.len() && parts[at + 1] == "2" {
                out.push(parts[at..at + 5].join(";"));
                at += 5;
                continue;
            }
        }
        out.push(raw.to_owned());
        at += 1;
    }
    out.into_iter().map(|part| format!("\u{1b}[{part}m")).collect()
}

fn is_fullwidth_grapheme(grapheme: &str, base: char) -> bool {
    is_fullwidth_code_point(base) || grapheme.contains('\u{fe0f}') || ('\u{1f1e6}'..='\u{1f1ff}').contains(&base)
}

/// `tokenize(str, endChar)`: ANSI codes and visible grapheme clusters; the walk stops once `end_char` cells are
/// visible (the whole text when `None`).
pub fn tokenize_styled(text: &str, end_char: Option<usize>) -> Vec<StyledToken> {
    let chars: Vec<char> = text.chars().collect();
    let end_char = end_char.unwrap_or(usize::MAX);
    let mut out = Vec::new();
    let mut visible = 0usize;
    let mut code_end = 0usize;
    let mut index = 0usize;
    for segment in text.graphemes(true) {
        let at = index;
        index += segment.chars().count();
        if at < code_end {
            continue;
        }
        let base = chars[at];
        if base == ESC || base == C1_CSI {
            let rest = &chars[at..];
            let mut length = None;
            match chars.get(at + 1) {
                Some(&']') => {
                    if let Some(len) = parse_link_code(rest) {
                        let code: String = rest[..len].iter().collect();
                        out.push(StyledToken::Ansi(AnsiCode { end_code: end_code_of(&code), code }));
                        length = Some(len);
                    } else if let Some(last) = osc_terminator_index(rest, 2) {
                        out.push(StyledToken::Control(rest[..=last].iter().collect()));
                        length = Some(last + 1);
                    }
                }
                Some(&'[') => {
                    if let Some(len) = parse_sgr_sequence(rest) {
                        for code in split_compound_sgr(&rest[..len]) {
                            out.push(StyledToken::Ansi(AnsiCode { end_code: end_code_of(&code), code }));
                        }
                        length = Some(len);
                    }
                }
                _ => {}
            }
            if let Some(len) = length {
                code_end = at + len;
                continue;
            }
        }
        let full_width = is_fullwidth_grapheme(segment, base);
        out.push(StyledToken::Char { value: segment.to_owned(), full_width });
        visible += if full_width { 2 } else { 1 };
        if visible >= end_char {
            break;
        }
    }
    out
}

/// `reduceAnsiCodesIncremental(codes, newCodes)`: `codes` is already reduced; the codes of `new_codes` are applied.
pub fn reduce_ansi_codes_incremental(codes: &[AnsiCode], new_codes: &[AnsiCode]) -> Vec<AnsiCode> {
    let mut out = codes.to_vec();
    for code in new_codes {
        if code.code == "\u{1b}[0m" {
            out.clear();
        } else if canonical_sgr(&code.code).is_some_and(is_close_code) {
            out.retain(|kept| kept.end_code != code.code);
        } else if is_intensity(code) {
            if !out.iter().any(|kept| kept.code == code.code && kept.end_code == code.end_code) {
                out.push(code.clone());
            }
        } else {
            out.retain(|kept| kept.end_code != code.end_code);
            out.push(code.clone());
        }
    }
    out
}

/// `reduceAnsiCodes(codes)`: the fewest codes that give the same style.
pub fn reduce_ansi_codes(codes: &[AnsiCode]) -> Vec<AnsiCode> {
    reduce_ansi_codes_incremental(&[], codes)
}

/// `undoAnsiCodes(codes)`: the codes that undo `codes`, last first.
pub fn undo_ansi_codes(codes: &[AnsiCode]) -> Vec<AnsiCode> {
    reduce_ansi_codes(codes).into_iter().rev().map(|code| AnsiCode { code: code.end_code.clone(), end_code: code.end_code }).collect()
}

/// `diffAnsiCodes(from, to)`: the codes that take the style `from` to the style `to` (both reduced).
pub fn diff_ansi_codes(from: &[AnsiCode], to: &[AnsiCode]) -> Vec<AnsiCode> {
    let end_codes_in_to: Vec<&str> = to.iter().map(|code| code.end_code.as_str()).collect();
    let start_codes_in_to: Vec<&str> = to.iter().map(|code| code.code.as_str()).collect();
    let start_codes_in_from: Vec<&str> = from.iter().map(|code| code.code.as_str()).collect();
    let to_undo: Vec<AnsiCode> = from
        .iter()
        .filter(|code| if is_intensity(code) { !start_codes_in_to.contains(&code.code.as_str()) } else { !end_codes_in_to.contains(&code.end_code.as_str()) })
        .cloned()
        .collect();
    let mut out = undo_ansi_codes(&to_undo);
    out.extend(to.iter().filter(|code| !start_codes_in_from.contains(&code.code.as_str())).cloned());
    out
}

/// `ansiCodesToString(codes)`: the codes joined, a code that repeats written once.
pub fn ansi_codes_to_string(codes: &[AnsiCode]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for code in codes {
        if !seen.contains(&code.code.as_str()) {
            seen.push(&code.code);
        }
    }
    seen.concat()
}

/// `styledCharsFromTokens(tokens)`: the characters, each with the reduced styles active at it.
pub fn styled_chars_from_tokens(tokens: &[StyledToken]) -> Vec<StyledChar> {
    let mut codes: Vec<AnsiCode> = Vec::new();
    let mut out = Vec::new();
    for token in tokens {
        match token {
            StyledToken::Ansi(code) => codes = reduce_ansi_codes_incremental(&codes, std::slice::from_ref(code)),
            StyledToken::Char { value, full_width } => {
                out.push(StyledChar { value: value.clone(), full_width: *full_width, styles: codes.clone() });
            }
            StyledToken::Control(_) => {}
        }
    }
    out
}

/// `styledCharsToString(chars)`: the characters with the least codes between them; the styles are closed at the end.
pub fn styled_chars_to_string(chars: &[StyledChar]) -> String {
    let mut out = String::new();
    for (at, ch) in chars.iter().enumerate() {
        if at == 0 {
            out.push_str(&ansi_codes_to_string(&ch.styles));
        } else {
            out.push_str(&ansi_codes_to_string(&diff_ansi_codes(&chars[at - 1].styles, &ch.styles)));
        }
        out.push_str(&ch.value);
        if at == chars.len() - 1 {
            out.push_str(&ansi_codes_to_string(&diff_ansi_codes(&ch.styles, &[])));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(text: &str) -> AnsiCode {
        AnsiCode { code: text.to_owned(), end_code: end_code_of(text) }
    }

    #[test]
    fn the_ink_tokenizer_splits_text_and_sequences() {
        let kinds: Vec<(InkTokenKind, String)> = tokenize_ink("a\x1b[31mb\x1b]8;;u\x07c\x1b[?25h").into_iter().map(|t| (t.kind, t.value)).collect();
        assert_eq!(
            kinds,
            [
                (InkTokenKind::Text, "a".to_owned()),
                (InkTokenKind::Csi, "\x1b[31m".to_owned()),
                (InkTokenKind::Text, "b".to_owned()),
                (InkTokenKind::Osc, "\x1b]8;;u\x07".to_owned()),
                (InkTokenKind::Text, "c".to_owned()),
                (InkTokenKind::Csi, "\x1b[?25h".to_owned()),
            ]
        );
    }

    #[test]
    fn a_csi_token_carries_its_parts() {
        let token = &tokenize_ink("\x1b[1;2 q")[0];
        assert_eq!((token.parameters.as_str(), token.intermediates.as_str(), token.final_char), ("1;2", " ", Some('q')));
    }

    #[test]
    fn an_unterminated_sequence_leaves_the_rest_invalid() {
        let tokens = tokenize_ink("ab\x1b]0;title");
        assert_eq!(tokens[0].kind, InkTokenKind::Text);
        assert_eq!((tokens[1].kind, tokens[1].value.as_str()), (InkTokenKind::Invalid, "\x1b]0;title"));
        assert_eq!(tokenize_ink("x\x1b[31")[1].kind, InkTokenKind::Invalid);
        assert_eq!(tokenize_ink("x\x1b")[1].kind, InkTokenKind::Invalid);
        // ESC and an intermediate with no final byte is malformed too.
        assert_eq!(tokenize_ink("a\x1b ")[1].kind, InkTokenKind::Invalid);
    }

    #[test]
    fn a_lone_escape_and_c1_controls_are_tokens() {
        let kinds: Vec<InkTokenKind> = tokenize_ink("a\x1b\u{7f}b\u{9c}c\u{85}d").into_iter().map(|t| t.kind).collect();
        assert_eq!(
            kinds,
            [InkTokenKind::Text, InkTokenKind::Esc, InkTokenKind::Text, InkTokenKind::St, InkTokenKind::Text, InkTokenKind::C1, InkTokenKind::Text]
        );
    }

    #[test]
    fn tmux_doubled_escapes_stay_inside_a_control_string() {
        let tokens = tokenize_ink("\x1bPq\x1b\x1b\\x\x1b\\tail");
        assert_eq!((tokens[0].kind, tokens[0].value.as_str()), (InkTokenKind::Dcs, "\x1bPq\x1b\x1b\\x\x1b\\"));
        assert_eq!(tokens[1].value, "tail");
    }

    #[test]
    fn tokens_join_back_to_the_text() {
        for text in ["plain", "a\x1b[31mb\x1b[0m", "x\x1b]0;t", "a\x1bb\u{9b}1m", "\x1b", "é\u{85}ü"] {
            let joined: String = tokenize(text)
                .into_iter()
                .map(|t| match t {
                    AnsiToken::Text(s) | AnsiToken::Escape(s) => s,
                })
                .collect();
            assert_eq!(joined, text);
        }
    }

    #[test]
    fn styled_tokens_split_compound_codes() {
        let tokens = tokenize_styled("\x1b[1;3;31mab\x1b[0m", None);
        let codes: Vec<(String, String)> = tokens
            .iter()
            .filter_map(|t| match t {
                StyledToken::Ansi(c) => Some((c.code.clone(), c.end_code.clone())),
                _ => None,
            })
            .collect();
        let want = [("1", "22"), ("3", "23"), ("31", "39"), ("0", "0")];
        let want: Vec<(String, String)> = want.iter().map(|(a, b)| (sgr_code(a), sgr_code(b))).collect();
        assert_eq!(codes, want);
    }

    #[test]
    fn styled_tokens_keep_extended_colours_whole_and_find_links() {
        let tokens = tokenize_styled("\x1b[38;2;1;2;3mx\x1b]8;;http://u\x07y\x1b]8;;\x07\x1b]0;t\x07", None);
        assert!(matches!(&tokens[0], StyledToken::Ansi(c) if c.code == "\x1b[38;2;1;2;3m" && c.end_code == "\x1b[39m"));
        assert!(matches!(&tokens[2], StyledToken::Ansi(c) if c.end_code == "\x1b]8;;\x07"));
        assert!(matches!(&tokens[5], StyledToken::Control(c) if c == "\x1b]0;t\x07"));
    }

    #[test]
    fn styled_characters_know_their_width() {
        let tokens = tokenize_styled("a日🙂🇯🇵e\u{301}\u{2764}\u{fe0f}", None);
        let full: Vec<bool> = tokens
            .iter()
            .filter_map(|t| match t {
                StyledToken::Char { full_width, .. } => Some(*full_width),
                _ => None,
            })
            .collect();
        assert_eq!(full, [false, true, true, true, false, true]);
    }

    #[test]
    fn the_walk_stops_when_enough_cells_are_visible() {
        assert_eq!(tokenize_styled("abcdef", Some(3)).len(), 3);
    }

    #[test]
    fn end_codes() {
        assert_eq!(end_code_of("\x1b[31m"), "\x1b[39m");
        assert_eq!(end_code_of("\x1b[1m"), "\x1b[22m");
        assert_eq!(end_code_of("\x1b[22m"), "\x1b[22m");
        assert_eq!(end_code_of("\x1b[48;5;9m"), "\x1b[49m");
        assert_eq!(end_code_of("\x1b[38;2;1;2;3m"), "\x1b[39m");
        assert_eq!(end_code_of("\x1b[5m"), "\x1b[0m");
        assert_eq!(end_code_of("\x1b[m"), "\x1b[0m");
        assert_eq!(end_code_of("\x1b]8;;u\x07"), "\x1b]8;;\x07");
        assert_eq!(end_code_of("\x1b]8;;u\x1b\\"), "\x1b]8;;\x1b\\");
        assert_eq!(link_start_code("http://u", &[("id", "x"), ("a", "b")]), "\x1b]8;id=x:a=b;http://u\x07");
    }

    #[test]
    fn reducing_drops_what_is_overridden() {
        let reduced = reduce_ansi_codes(&[code("\x1b[31m"), code("\x1b[1m"), code("\x1b[32m"), code("\x1b[2m")]);
        let text: Vec<&str> = reduced.iter().map(|c| c.code.as_str()).collect();
        assert_eq!(text, ["\x1b[1m", "\x1b[32m", "\x1b[2m"]);
        assert!(reduce_ansi_codes(&[code("\x1b[1m"), code("\x1b[0m")]).is_empty());
        let after_end = reduce_ansi_codes(&[code("\x1b[1m"), code("\x1b[31m"), code("\x1b[39m")]);
        assert_eq!(after_end.len(), 1);
    }

    #[test]
    fn styled_characters_are_written_with_the_least_codes() {
        let tokens = tokenize_styled("\x1b[31mab\x1b[39mc\x1b[1md", None);
        let chars = styled_chars_from_tokens(&tokens);
        assert_eq!(styled_chars_to_string(&chars), "\x1b[31mab\x1b[39mc\x1b[1md\x1b[22m");
    }

    #[test]
    fn diff_undoes_what_to_does_not_keep() {
        let from = vec![code("\x1b[1m"), code("\x1b[31m")];
        let to = vec![code("\x1b[1m"), code("\x1b[32m")];
        let diff: Vec<String> = diff_ansi_codes(&from, &to).into_iter().map(|c| c.code).collect();
        // The 31 is overwritten by the 32 (both end with 39) and the 1 is in both: nothing is undone.
        assert_eq!(diff, ["\x1b[32m"]);
        let dropped: Vec<String> = diff_ansi_codes(&from, &[code("\x1b[1m")]).into_iter().map(|c| c.code).collect();
        assert_eq!(dropped, ["\x1b[39m"]);
    }

    #[test]
    fn parse_int_follows_javascript() {
        assert_eq!(js_parse_int("12abc"), Some(12));
        assert_eq!(js_parse_int("  -3"), Some(-3));
        assert_eq!(js_parse_int("m"), None);
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_parse_int("8;;http"), Some(8));
        assert_eq!(js_parse_int("1:2"), Some(1));
    }

    #[test]
    fn trimming_uses_the_javascript_white_space() {
        assert_eq!(js_trim_start("\u{feff}\u{a0} a "), "a ");
        assert_eq!(js_trim_end(" a\u{2028}\u{3000}"), " a");
        // U+0085 is white space for Rust but not for String.prototype.trim.
        assert_eq!(js_trim_start("\u{85}a"), "\u{85}a");
    }
}
