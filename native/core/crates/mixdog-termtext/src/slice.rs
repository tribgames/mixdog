//! `slice-ansi` 9.0.0 (with its `tokenize-ansi.js`): a cell range of a string with its escapes kept.
//!
//! Width: this module measures with the rules of slice-ansi's own tokenizer, not with `string_width`: a grapheme
//! cluster is 2 cells when one of its code points is Fullwidth or Wide (`is-fullwidth-code-point`), when it holds a
//! regional indicator, or when it is an emoji-style cluster (a code point with Emoji_Presentation, U+FE0F, or
//! U+20E3); otherwise 1. A continuation of a cluster that an escape sequence splits is 0.
//!
//! Strings are walked as chars; slice-ansi walks UTF-16 units. The two differ only in how far an index moves over a
//! character outside the BMP, which no decision depends on.

use unicode_segmentation::UnicodeSegmentation;

use crate::ansi::{
    BEL, C1_APC, C1_CSI, C1_DCS, C1_OSC, C1_PM, C1_SOS, C1_ST, ESC, is_close_code, is_csi_final, is_csi_parameter,
    is_fullwidth_code_point, is_intermediate, js_parse_int, sgr_code, style_close,
};

/// The code points with the Unicode property Emoji_Presentation (Unicode 16.0, as V8 of Node 22 answers
/// `/\p{Emoji_Presentation}/v`), sorted, inclusive.
static EMOJI_PRESENTATION: &[(u32, u32)] = &[
    (0x231a, 0x231b), (0x23e9, 0x23ec), (0x23f0, 0x23f0), (0x23f3, 0x23f3), (0x25fd, 0x25fe), (0x2614, 0x2615),
    (0x2648, 0x2653), (0x267f, 0x267f), (0x2693, 0x2693), (0x26a1, 0x26a1), (0x26aa, 0x26ab), (0x26bd, 0x26be),
    (0x26c4, 0x26c5), (0x26ce, 0x26ce), (0x26d4, 0x26d4), (0x26ea, 0x26ea), (0x26f2, 0x26f3), (0x26f5, 0x26f5),
    (0x26fa, 0x26fa), (0x26fd, 0x26fd), (0x2705, 0x2705), (0x270a, 0x270b), (0x2728, 0x2728), (0x274c, 0x274c),
    (0x274e, 0x274e), (0x2753, 0x2755), (0x2757, 0x2757), (0x2795, 0x2797), (0x27b0, 0x27b0), (0x27bf, 0x27bf),
    (0x2b1b, 0x2b1c), (0x2b50, 0x2b50), (0x2b55, 0x2b55), (0x1f004, 0x1f004), (0x1f0cf, 0x1f0cf),
    (0x1f18e, 0x1f18e), (0x1f191, 0x1f19a), (0x1f1e6, 0x1f1ff), (0x1f201, 0x1f201), (0x1f21a, 0x1f21a),
    (0x1f22f, 0x1f22f), (0x1f232, 0x1f236), (0x1f238, 0x1f23a), (0x1f250, 0x1f251), (0x1f300, 0x1f320),
    (0x1f32d, 0x1f335), (0x1f337, 0x1f37c), (0x1f37e, 0x1f393), (0x1f3a0, 0x1f3ca), (0x1f3cf, 0x1f3d3),
    (0x1f3e0, 0x1f3f0), (0x1f3f4, 0x1f3f4), (0x1f3f8, 0x1f43e), (0x1f440, 0x1f440), (0x1f442, 0x1f4fc),
    (0x1f4ff, 0x1f53d), (0x1f54b, 0x1f54e), (0x1f550, 0x1f567), (0x1f57a, 0x1f57a), (0x1f595, 0x1f596),
    (0x1f5a4, 0x1f5a4), (0x1f5fb, 0x1f64f), (0x1f680, 0x1f6c5), (0x1f6cc, 0x1f6cc), (0x1f6d0, 0x1f6d2),
    (0x1f6d5, 0x1f6d7), (0x1f6dc, 0x1f6df), (0x1f6eb, 0x1f6ec), (0x1f6f4, 0x1f6fc), (0x1f7e0, 0x1f7eb),
    (0x1f7f0, 0x1f7f0), (0x1f90c, 0x1f93a), (0x1f93c, 0x1f945), (0x1f947, 0x1f9ff), (0x1fa70, 0x1fa7c),
    (0x1fa80, 0x1fa89), (0x1fa8f, 0x1fac6), (0x1face, 0x1fadc), (0x1fadf, 0x1fae9), (0x1faf0, 0x1faf8),
];

fn has_emoji_presentation(ch: char) -> bool {
    let cp = u32::from(ch);
    EMOJI_PRESENTATION
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_escape_start(ch: char) -> bool {
    matches!(ch, ESC | C1_DCS | C1_SOS | C1_CSI | C1_ST | C1_OSC | C1_PM | C1_APC)
}

fn is_sgr_parameter(ch: char) -> bool {
    ch.is_ascii_digit() || ch == ';' || ch == ':'
}

fn collect(chars: &[char], from: usize, to: usize) -> String {
    chars[from..to].iter().collect()
}

/// One piece of a SGR sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fragment {
    Reset,
    End { end_code: String },
    Start { code: String, end_code: String },
}

#[derive(Debug, Clone)]
enum Token {
    Sgr { code: String, fragments: Vec<Fragment> },
    Hyperlink(Hyperlink),
    Control { code: String },
    Character { value: String, visible_width: usize, continuation: bool },
}

/// An OSC 8 sequence; `open` is false for the one with an empty URL, which closes.
#[derive(Debug, Clone)]
struct Hyperlink {
    code: String,
    open: bool,
    close_prefix: &'static str,
    terminator: &'static str,
}

struct Parsed {
    token: Token,
    end: usize,
}

fn control(code: String, end: usize) -> Parsed {
    Parsed { token: Token::Control { code }, end }
}

fn is_emoji_style_grapheme(grapheme: &str) -> bool {
    grapheme.chars().any(|ch| has_emoji_presentation(ch) || ch == '\u{fe0f}' || ch == '\u{20e3}')
}

fn grapheme_width(grapheme: &str) -> usize {
    let mut regional_indicators = 0;
    for ch in grapheme.chars() {
        if is_fullwidth_code_point(ch) {
            return 2;
        }
        if ('\u{1f1e6}'..='\u{1f1ff}').contains(&ch) {
            regional_indicators += 1;
        }
    }
    if regional_indicators >= 1 || is_emoji_style_grapheme(grapheme) {
        return 2;
    }
    1
}

fn sgr_prefix(code: &str) -> &'static str {
    if code.starts_with(C1_CSI) { "\u{9b}" } else { "\u{1b}[" }
}

fn create_sgr_code(prefix: &str, values: &[&str]) -> String {
    format!("{prefix}{}m", values.join(";"))
}

fn extended_end_code(code_number: i64) -> String {
    sgr_code(if code_number == 38 { 39 } else { 49 })
}

fn sgr_fragments(code: &str) -> Vec<Fragment> {
    let prefix = sgr_prefix(code);
    let chars: Vec<char> = code.chars().collect();
    let parameters: String = if code.starts_with("\u{1b}[") {
        chars[2..chars.len() - 1].iter().collect()
    } else if code.starts_with(C1_CSI) {
        chars[1..chars.len() - 1].iter().collect()
    } else {
        return Vec::new();
    };
    let raw_codes: Vec<&str> = if parameters.is_empty() { vec!["0"] } else { parameters.split(';').collect() };
    let mut fragments = Vec::new();
    let mut index = 0;
    while index < raw_codes.len() {
        let Some(code_number) = js_parse_int(raw_codes[index]) else {
            index += 1;
            continue;
        };
        if code_number == 0 {
            fragments.push(Fragment::Reset);
            index += 1;
            continue;
        }
        if code_number == 38 || code_number == 48 {
            let color_type = raw_codes.get(index + 1).and_then(|raw| js_parse_int(raw));
            if color_type == Some(5) && index + 2 < raw_codes.len() {
                fragments.push(Fragment::Start {
                    code: create_sgr_code(prefix, &raw_codes[index..index + 3]),
                    end_code: extended_end_code(code_number),
                });
                index += 3;
                continue;
            }
            if color_type == Some(2) && index + 4 < raw_codes.len() {
                fragments.push(Fragment::Start {
                    code: create_sgr_code(prefix, &raw_codes[index..index + 5]),
                    end_code: extended_end_code(code_number),
                });
                index += 5;
                continue;
            }
            fragments.push(Fragment::Start {
                code: create_sgr_code(prefix, &[raw_codes[index]]),
                end_code: extended_end_code(code_number),
            });
            index += 1;
            continue;
        }
        if is_close_code(code_number) {
            fragments.push(Fragment::End { end_code: sgr_code(code_number) });
            index += 1;
            continue;
        }
        let open_code = create_sgr_code(prefix, &[raw_codes[index]]);
        let end_code = style_close(code_number).map_or_else(|| sgr_code(0), sgr_code);
        fragments.push(Fragment::Start { code: open_code, end_code });
        index += 1;
    }
    if fragments.is_empty() {
        fragments.push(Fragment::Reset);
    }
    fragments
}

fn parse_csi(chars: &[char], index: usize) -> Option<Parsed> {
    let start = match chars[index] {
        ESC if chars.get(index + 1) == Some(&'[') => index + 2,
        C1_CSI => index + 1,
        _ => return None,
    };
    let mut canonical = true;
    let mut at = start;
    while at < chars.len() {
        let ch = chars[at];
        if is_csi_final(ch) {
            let code = collect(chars, index, at + 1);
            if ch != 'm' || !canonical {
                return Some(control(code, at + 1));
            }
            let fragments = sgr_fragments(&code);
            return Some(Parsed { token: Token::Sgr { code, fragments }, end: at + 1 });
        }
        if is_csi_parameter(ch) {
            if !is_sgr_parameter(ch) {
                canonical = false;
            }
        } else if is_intermediate(ch) {
            canonical = false;
        } else {
            return Some(control(collect(chars, index, at), at));
        }
        at += 1;
    }
    Some(control(collect(chars, index, chars.len()), chars.len()))
}

fn starts_with_at(chars: &[char], at: usize, prefix: &str) -> bool {
    let mut cursor = at;
    for expected in prefix.chars() {
        if chars.get(cursor) != Some(&expected) {
            return false;
        }
        cursor += 1;
    }
    true
}

fn parse_hyperlink(chars: &[char], index: usize) -> Option<Parsed> {
    let (prefix_len, close_prefix) = if chars[index] == ESC && starts_with_at(chars, index, "\u{1b}]8;") {
        (4, "\u{1b}]8;;")
    } else if chars[index] == C1_OSC && starts_with_at(chars, index, "\u{9d}8;") {
        (3, "\u{9d}8;;")
    } else {
        return None;
    };
    let Some(uri_start) = (index + prefix_len..chars.len()).find(|&at| chars[at] == ';') else {
        return Some(control(collect(chars, index, chars.len()), chars.len()));
    };
    for at in uri_start + 1..chars.len() {
        let ch = chars[at];
        let (end, terminator) = if ch == BEL {
            (at + 1, "\u{7}")
        } else if ch == ESC && chars.get(at + 1) == Some(&'\\') {
            (at + 2, "\u{1b}\\")
        } else if ch == C1_ST {
            (at + 1, "\u{9c}")
        } else {
            continue;
        };
        let hyperlink = Hyperlink {
            code: collect(chars, index, end),
            open: at != uri_start + 1,
            close_prefix,
            terminator,
        };
        return Some(Parsed { token: Token::Hyperlink(hyperlink), end });
    }
    Some(control(collect(chars, index, chars.len()), chars.len()))
}

fn parse_control_string(chars: &[char], index: usize) -> Option<Parsed> {
    let ch = chars[index];
    let (start, bell) = match ch {
        ESC => match chars.get(index + 1) {
            Some(']') => (index + 2, true),
            Some('P' | 'X' | '^' | '_') => (index + 2, false),
            Some('\\') => return Some(control("\u{1b}\\".to_owned(), index + 2)),
            _ => return None,
        },
        C1_OSC => (index + 1, true),
        C1_DCS | C1_SOS | C1_PM | C1_APC => (index + 1, false),
        C1_ST => return Some(control(C1_ST.to_string(), index + 1)),
        _ => return None,
    };
    for at in start..chars.len() {
        if bell && chars[at] == BEL {
            return Some(control(collect(chars, index, at + 1), at + 1));
        }
        if chars[at] == ESC && chars.get(at + 1) == Some(&'\\') {
            return Some(control(collect(chars, index, at + 2), at + 2));
        }
        if chars[at] == C1_ST {
            return Some(control(collect(chars, index, at + 1), at + 1));
        }
    }
    Some(control(collect(chars, index, chars.len()), chars.len()))
}

fn parse_ansi_code(chars: &[char], index: usize) -> Option<Parsed> {
    if matches!(chars[index], ESC | C1_OSC)
        && let Some(hyperlink) = parse_hyperlink(chars, index)
    {
        return Some(hyperlink);
    }
    parse_control_string(chars, index).or_else(|| parse_csi(chars, index))
}

fn append_trailing_ansi_tokens(chars: &[char], mut index: usize, tokens: &mut Vec<Token>) -> usize {
    while index < chars.len() && is_escape_start(chars[index]) {
        let Some(code) = parse_ansi_code(chars, index) else { break };
        tokens.push(code.token);
        index = code.end;
    }
    index
}

/// The grapheme clusters of the raw string as `[start, end)` char ranges (`Intl.Segmenter`'s `containing`).
struct Segments {
    ranges: Vec<(usize, usize)>,
}

impl Segments {
    fn of(text: &str) -> Self {
        let mut ranges = Vec::new();
        let mut at = 0;
        for segment in text.graphemes(true) {
            let end = at + segment.chars().count();
            ranges.push((at, end));
            at = end;
        }
        Self { ranges }
    }

    /// The cluster that starts exactly at `index`.
    fn starting_at(&self, index: usize) -> Option<(usize, usize)> {
        let at = self.ranges.partition_point(|&(start, _)| start <= index);
        let (start, end) = *self.ranges.get(at.checked_sub(1)?)?;
        (start == index && index < end).then_some((start, end))
    }
}

/// The cluster of the raw string that starts at `index`: its text, its width, and where it ends.
fn raw_character(chars: &[char], index: usize, segments: &Segments) -> Option<(String, usize, usize)> {
    let (start, end) = segments.starting_at(index)?;
    let value = collect(chars, start, end);
    let visible_width = grapheme_width(&value);
    Some((value, visible_width, end))
}

/// Whether `left` and `right` written together form one grapheme cluster (no boundary between them).
fn same_grapheme(left: &str, right: &str) -> bool {
    let pair = format!("{left}{right}");
    !pair.grapheme_indices(true).any(|(at, _)| at == left.len())
}

fn split_continuation_ahead(chars: &[char], start: usize, previous: &str, segments: &Segments) -> bool {
    let mut index = start;
    let mut has_ansi = false;
    while index < chars.len() {
        if is_escape_start(chars[index])
            && let Some(code) = parse_ansi_code(chars, index)
        {
            has_ansi = true;
            index = code.end;
            continue;
        }
        if !has_ansi {
            return false;
        }
        return raw_character(chars, index, segments).is_none_or(|(value, _, _)| same_grapheme(previous, &value));
    }
    false
}

struct VisibleCharacter {
    value: char,
    visible_width: usize,
    continuation: bool,
}

fn collect_visible_characters(chars: &[char]) -> Vec<VisibleCharacter> {
    let mut visible = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if is_escape_start(chars[index])
            && let Some(code) = parse_ansi_code(chars, index)
        {
            index = code.end;
            continue;
        }
        visible.push(VisibleCharacter { value: chars[index], visible_width: 1, continuation: false });
        index += 1;
    }
    visible
}

fn apply_grapheme_metadata(visible: &mut [VisibleCharacter]) {
    if visible.is_empty() {
        return;
    }
    let text: String = visible.iter().map(|ch| ch.value).collect();
    let mut at = 0;
    for segment in text.graphemes(true) {
        let count = segment.chars().count();
        for (offset, ch) in visible[at..at + count].iter_mut().enumerate() {
            ch.visible_width = if offset == 0 { grapheme_width(segment) } else { 0 };
            ch.continuation = offset != 0;
        }
        at += count;
    }
}

/// The tokens when escape sequences split grapheme clusters: clusters are those of the visible text alone.
fn tokenize_with_visible_segmentation(chars: &[char], end_character: usize) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut visible_characters = collect_visible_characters(chars);
    apply_grapheme_metadata(&mut visible_characters);
    let mut index = 0;
    let mut visible_index = 0;
    let mut visible_count = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if is_escape_start(ch)
            && let Some(code) = parse_ansi_code(chars, index)
        {
            tokens.push(code.token);
            index = code.end;
            continue;
        }
        let (visible_width, continuation) = match visible_characters.get(visible_index) {
            Some(visible) => (visible.visible_width, visible.continuation),
            None => (if is_fullwidth_code_point(ch) { 2 } else { ch.len_utf16() }, false),
        };
        tokens.push(Token::Character { value: ch.to_string(), visible_width, continuation });
        index += 1;
        visible_index += 1;
        visible_count += visible_width;
        if visible_count >= end_character {
            let next_is_continuation = visible_characters.get(visible_index).is_some_and(|next| next.continuation);
            if !next_is_continuation {
                append_trailing_ansi_tokens(chars, index, &mut tokens);
                break;
            }
        }
    }
    tokens
}

fn tokenize_ansi(text: &str, end_character: usize) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let segments = Segments::of(text);
    let mut tokens = Vec::new();
    let mut index = 0;
    let mut visible_count = 0usize;
    let mut previous_visible: Option<String> = None;
    let mut has_ansi_since_visible = false;
    while index < chars.len() {
        if is_escape_start(chars[index])
            && let Some(code) = parse_ansi_code(&chars, index)
        {
            tokens.push(code.token);
            index = code.end;
            has_ansi_since_visible = true;
            continue;
        }
        let Some((value, visible_width, end)) = raw_character(&chars, index, &segments) else {
            return tokenize_with_visible_segmentation(&chars, end_character);
        };
        if has_ansi_since_visible
            && let Some(previous) = &previous_visible
            && same_grapheme(previous, &value)
        {
            return tokenize_with_visible_segmentation(&chars, end_character);
        }
        visible_count += visible_width;
        has_ansi_since_visible = false;
        tokens.push(Token::Character { value: value.clone(), visible_width, continuation: false });
        previous_visible = Some(value);
        index = end;
        if visible_count >= end_character {
            let previous = previous_visible.as_deref().unwrap_or_default();
            if split_continuation_ahead(&chars, index, previous, &segments) {
                return tokenize_with_visible_segmentation(&chars, end_character);
            }
            append_trailing_ansi_tokens(&chars, index, &mut tokens);
            break;
        }
    }
    tokens
}

/// The SGR styles in force, by the code that ends them, in the order they were set.
type ActiveStyles = Vec<(String, String)>;

fn apply_sgr_fragments(active: &mut ActiveStyles, fragments: &[Fragment]) {
    for fragment in fragments {
        match fragment {
            Fragment::Reset => active.clear(),
            Fragment::End { end_code } => active.retain(|(end, _)| end != end_code),
            Fragment::Start { code, end_code } => {
                active.retain(|(end, _)| end != end_code);
                active.push((end_code.clone(), code.clone()));
            }
        }
    }
}

fn should_include_sgr_after_end(fragments: &[Fragment], active: &ActiveStyles) -> bool {
    let mut has_start = false;
    let mut has_closing_effect = false;
    for fragment in fragments {
        match fragment {
            Fragment::Start { .. } => has_start = true,
            Fragment::Reset => {
                if !active.is_empty() {
                    has_closing_effect = true;
                }
            }
            Fragment::End { end_code } => {
                if active.iter().any(|(end, _)| end == end_code) {
                    has_closing_effect = true;
                }
            }
        }
    }
    has_closing_effect && !has_start
}

#[derive(Default)]
struct Slicer {
    active_styles: ActiveStyles,
    active_hyperlink: Option<Hyperlink>,
    hyperlink_has_visible_text: bool,
    hyperlink_output_index: Option<usize>,
    pending_sgr_output_index: Option<usize>,
    pending_sgr_active_styles: Option<ActiveStyles>,
    position: usize,
    out: String,
    include: bool,
}

impl Slicer {
    /// Drops the opening code of a hyperlink that has shown no text.
    fn discard_pending_hyperlink(&mut self) {
        if let Some(link) = &self.active_hyperlink
            && !self.hyperlink_has_visible_text
            && let Some(at) = self.hyperlink_output_index
        {
            let length = link.code.len();
            self.out.replace_range(at..at + length, "");
            if let Some(pending) = self.pending_sgr_output_index
                && pending > at
            {
                self.pending_sgr_output_index = Some(pending - length);
            }
        }
        self.active_hyperlink = None;
        self.hyperlink_has_visible_text = false;
        self.hyperlink_output_index = None;
    }

    fn apply_sgr(&mut self, code: &str, fragments: &[Fragment], is_past_end: bool) {
        if is_past_end && !should_include_sgr_after_end(fragments, &self.active_styles) {
            return;
        }
        if self.include
            && fragments.iter().any(|fragment| matches!(fragment, Fragment::Start { .. }))
            && self.pending_sgr_output_index.is_none()
        {
            self.pending_sgr_output_index = Some(self.out.len());
            self.pending_sgr_active_styles = Some(self.active_styles.clone());
        }
        apply_sgr_fragments(&mut self.active_styles, fragments);
        if self.include {
            self.out.push_str(code);
        }
    }

    fn apply_hyperlink(&mut self, link: &Hyperlink, is_past_end: bool) {
        if is_past_end && (link.open || self.active_hyperlink.is_none()) {
            return;
        }
        if link.open {
            self.active_hyperlink = Some(link.clone());
            self.hyperlink_has_visible_text = false;
            self.hyperlink_output_index = self.include.then_some(self.out.len());
        } else {
            if self.include && self.active_hyperlink.is_some() && !self.hyperlink_has_visible_text {
                self.discard_pending_hyperlink();
                return;
            }
            self.active_hyperlink = None;
            self.hyperlink_has_visible_text = false;
            self.hyperlink_output_index = None;
        }
        if self.include {
            self.out.push_str(&link.code);
        }
    }

    fn apply_character(&mut self, value: &str, visible_width: usize, continuation: bool, start: usize) {
        if !self.include && self.position >= start && !continuation {
            self.include = true;
            self.out = self.active_styles.iter().map(|(_, code)| code.as_str()).collect();
            if let Some(link) = &self.active_hyperlink {
                self.hyperlink_output_index = Some(self.out.len());
                self.out.push_str(&link.code);
            }
        }
        if self.include {
            self.out.push_str(value);
            self.pending_sgr_output_index = None;
            self.pending_sgr_active_styles = None;
            if self.active_hyperlink.is_some() {
                self.hyperlink_has_visible_text = true;
            }
        }
        self.position += visible_width;
    }
}

fn is_past_end_boundary(token: &Token, position: usize, end: Option<usize>) -> bool {
    let Some(end) = end else { return false };
    if position >= end {
        return true;
    }
    matches!(token, Token::Character { visible_width, continuation: false, .. } if position + visible_width > end)
}

/// `sliceAnsi(text, start, end)`: the cells from `start` up to `end` (the end of the text when `None`). The styles
/// and the hyperlink active at `start` are opened first and everything still open at the end is closed.
pub fn slice_ansi(text: &str, start: usize, end: Option<usize>) -> String {
    let tokens = tokenize_ansi(text, end.unwrap_or(usize::MAX));
    // For each token: whether the next character token is a continuation of a cluster.
    let mut continuation_ahead = vec![false; tokens.len()];
    let mut next_is_continuation = false;
    for (at, token) in tokens.iter().enumerate().rev() {
        continuation_ahead[at] = next_is_continuation;
        if let Token::Character { continuation, .. } = token {
            next_is_continuation = *continuation;
        }
    }
    let mut state = Slicer::default();
    for (at, token) in tokens.iter().enumerate() {
        let mut is_past_end = is_past_end_boundary(token, state.position, end);
        if is_past_end && !matches!(token, Token::Character { .. }) && continuation_ahead[at] {
            is_past_end = false;
        }
        if is_past_end && matches!(token, Token::Character { continuation: false, .. }) {
            if state.active_hyperlink.is_some() && !state.hyperlink_has_visible_text {
                state.discard_pending_hyperlink();
            }
            if let Some(pending) = state.pending_sgr_output_index.take() {
                state.out.truncate(pending);
                if let Some(styles) = state.pending_sgr_active_styles.take() {
                    state.active_styles = styles;
                }
            }
            break;
        }
        match token {
            Token::Sgr { code, fragments } => state.apply_sgr(code, fragments, is_past_end),
            Token::Hyperlink(link) => state.apply_hyperlink(link, is_past_end),
            Token::Control { code } => {
                if !is_past_end && state.include {
                    state.out.push_str(code);
                }
            }
            Token::Character { value, visible_width, continuation } => {
                state.apply_character(value, *visible_width, *continuation, start);
            }
        }
    }
    if !state.include {
        return String::new();
    }
    if let Some(link) = &state.active_hyperlink {
        state.out.push_str(link.close_prefix);
        state.out.push_str(link.terminator);
    }
    for (end_code, _) in state.active_styles.iter().rev() {
        state.out.push_str(end_code);
    }
    state.out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_cut_by_cells() {
        assert_eq!(slice_ansi("abcdef", 1, Some(4)), "bcd");
        assert_eq!(slice_ansi("abcdef", 0, None), "abcdef");
        assert_eq!(slice_ansi("abcdef", 4, None), "ef");
        assert_eq!(slice_ansi("abc", 5, None), "");
        assert_eq!(slice_ansi("abc", 2, Some(2)), "");
    }

    #[test]
    fn styles_open_at_the_start_and_close_at_the_end() {
        assert_eq!(slice_ansi("\x1b[31mabcdef\x1b[39m", 2, Some(4)), "\x1b[31mcd\x1b[39m");
        assert_eq!(slice_ansi("\x1b[1m\x1b[31mabcdef", 1, Some(3)), "\x1b[1m\x1b[31mbc\x1b[39m\x1b[22m");
        assert_eq!(slice_ansi("a\x1b[31mb\x1b[39mcd", 0, Some(3)), "a\x1b[31mb\x1b[39mc");
    }

    #[test]
    fn a_style_set_just_before_the_cut_is_not_kept() {
        assert_eq!(slice_ansi("ab\x1b[31mcd", 0, Some(2)), "ab");
    }

    #[test]
    fn wide_characters_are_never_split() {
        assert_eq!(slice_ansi("日本語", 0, Some(3)), "日");
        assert_eq!(slice_ansi("日本語", 0, Some(4)), "日本");
        assert_eq!(slice_ansi("日本語", 1, Some(4)), "本");
        assert_eq!(slice_ansi("a🙂b", 1, Some(3)), "🙂");
        assert_eq!(slice_ansi("e\u{301}x", 0, Some(1)), "e\u{301}");
    }

    #[test]
    fn hyperlinks_are_reopened_and_closed() {
        let text = "\x1b]8;;http://u\x07abcdef\x1b]8;;\x07";
        assert_eq!(slice_ansi(text, 2, Some(4)), "\x1b]8;;http://u\x07cd\x1b]8;;\x07");
        assert_eq!(slice_ansi(text, 0, None), text);
    }

    #[test]
    fn a_hyperlink_with_no_text_is_dropped() {
        assert_eq!(slice_ansi("ab\x1b]8;;http://u\x07cd\x1b]8;;\x07", 0, Some(2)), "ab");
        assert_eq!(slice_ansi("a\x1b]8;;http://u\x07\x1b]8;;\x07b", 0, None), "ab");
    }

    #[test]
    fn control_sequences_inside_the_range_are_kept() {
        assert_eq!(slice_ansi("a\x1b[2Kb", 0, None), "a\x1b[2Kb");
        assert_eq!(slice_ansi("a\x1b]0;t\x07b", 0, Some(1)), "a");
    }

    #[test]
    fn escapes_after_the_last_cell_that_close_styles_are_kept() {
        assert_eq!(slice_ansi("\x1b[31mab\x1b[39mcd", 0, Some(2)), "\x1b[31mab\x1b[39m");
    }

    #[test]
    fn an_escape_inside_a_cluster_keeps_the_cluster_whole() {
        assert_eq!(slice_ansi("e\x1b[31m\u{301}x", 0, Some(1)), "e\x1b[31m\u{301}\x1b[39m");
    }

    #[test]
    fn sgr_codes_split_into_fragments() {
        let fragments = sgr_fragments("\x1b[1;38;5;9;49;0m");
        assert_eq!(
            fragments,
            [
                Fragment::Start { code: "\x1b[1m".to_owned(), end_code: "\x1b[22m".to_owned() },
                Fragment::Start { code: "\x1b[38;5;9m".to_owned(), end_code: "\x1b[39m".to_owned() },
                Fragment::End { end_code: "\x1b[49m".to_owned() },
                Fragment::Reset,
            ]
        );
        assert_eq!(sgr_fragments("\x1b[m"), [Fragment::Reset]);
        assert_eq!(sgr_fragments("\x1b[5m"), [Fragment::Start { code: "\x1b[5m".to_owned(), end_code: "\x1b[0m".to_owned() }]);
    }

    #[test]
    fn emoji_presentation_table_is_sorted() {
        assert!(EMOJI_PRESENTATION.windows(2).all(|pair| pair[0].1 < pair[1].0));
        assert!(has_emoji_presentation('🙂'));
        assert!(!has_emoji_presentation('a'));
        assert_eq!(grapheme_width("\u{231a}"), 2);
        assert_eq!(grapheme_width("\u{2764}\u{fe0f}"), 2);
        assert_eq!(grapheme_width("\u{2764}"), 1);
        assert_eq!(grapheme_width("1\u{fe0f}\u{20e3}"), 2);
    }
}
