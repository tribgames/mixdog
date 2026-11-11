//! The edit engine behind `edit`: dialect normalization, the line-ending plan, and the two ways of
//! applying a plan. Everything here is pure text in, text or model-facing error out.

use std::cmp::Reverse;
use std::sync::OnceLock;

use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::utf16_len;
use unicode_normalization::char::decompose_canonical;

use super::common::fail;
use super::hints::nearest_line;

pub(super) const SAME_STRINGS: &str = "Error: old_string and new_string are exactly the same — no change needed; the file may already contain it, re-read before retrying";

fn conflict(matches: u32, text: String) -> ToolError {
    fail(ToolErrorCode::Conflict { matches }, text)
}

// ---- dialect: replacement hygiene, typographic rematch, deletion absorption ----

/// Trailing spaces and tabs of every line of the replacement. A lone `\r` at the very end is not a
/// line break, so the last line is trimmed as it stands.
fn strip_trailing_blanks(text: &str) -> String {
    let last = text.split('\n').count() - 1;
    text.split('\n')
        .enumerate()
        .map(|(i, seg)| match seg.strip_suffix('\r') {
            Some(body) if i < last => format!("{}\r", body.trim_end_matches([' ', '\t'])),
            _ => seg.trim_end_matches([' ', '\t']).to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One UTF-16 unit with dashes, curly quotes and unusual spaces folded to ASCII. Every folded
/// character is a single unit on both sides, so a hit in the folded text maps onto the file's own
/// units at the same offsets.
fn fold_unit(u: u16) -> u16 {
    match u {
        0x2010..=0x2015 | 0x2212 => u16::from(b'-'),
        0x2018..=0x201B => u16::from(b'\''),
        0x201C..=0x201F => u16::from(b'"'),
        0x00A0 | 0x2002..=0x200A | 0x202F | 0x205F | 0x3000 => u16::from(b' '),
        other => other,
    }
}

fn opens_quote(prev: Option<char>) -> bool {
    matches!(prev, None | Some(' ' | '\t' | '\n' | '\r' | '(' | '[' | '{' | '\u{2014}' | '\u{2013}'))
}

fn is_letter(c: char) -> bool {
    static LETTER: OnceLock<regex::Regex> = OnceLock::new();
    let re = LETTER.get_or_init(|| regex::Regex::new(r"^\p{L}$").expect("static pattern"));
    re.is_match(c.encode_utf8(&mut [0; 4]))
}

/// Plain quotes of the replacement take the matched span's curly style: open or close by position,
/// an apostrophe between two letters closes.
fn apply_file_quote_style(span: &str, replacement: &str) -> String {
    let has_double = span.contains(['\u{201C}', '\u{201D}']);
    let has_single = span.contains(['\u{2018}', '\u{2019}']);
    if !has_double && !has_single {
        return replacement.to_owned();
    }
    let chars: Vec<char> = replacement.chars().collect();
    let mut out = String::with_capacity(replacement.len());
    for (i, &c) in chars.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| chars[p]);
        if c == '"' && has_double {
            out.push(if opens_quote(prev) { '\u{201C}' } else { '\u{201D}' });
        } else if c == '\'' && has_single {
            let prev_letter = prev.is_some_and(is_letter);
            let next_letter = chars.get(i + 1).copied().is_some_and(is_letter);
            out.push(if prev_letter && next_letter {
                '\u{2019}'
            } else if opens_quote(prev) {
                '\u{2018}'
            } else {
                '\u{2019}'
            });
        } else {
            out.push(c);
        }
    }
    out
}

/// `old` missed byte-exact but matches after the 1:1 fold: the file's own span, with the
/// replacement in the file's quote style. With `replace_all` every span must be identical, so no
/// occurrence is silently skipped.
fn typographic_rematch(content: &str, old: &str, new: &str, replace_all: bool) -> Option<(String, String)> {
    let units: Vec<u16> = content.encode_utf16().collect();
    let folded: Vec<u16> = units.iter().copied().map(fold_unit).collect();
    let want: Vec<u16> = old.encode_utf16().map(fold_unit).collect();
    let len = want.len();
    let mut spans: Vec<&[u16]> = Vec::new();
    let mut at = 0;
    while spans.len() < 64 && at + len <= folded.len() {
        if folded[at..at + len] == want[..] {
            spans.push(&units[at..at + len]);
        }
        at += 1;
    }
    let first = *spans.first()?;
    let old_units: Vec<u16> = old.encode_utf16().collect();
    if first == &old_units[..] || (replace_all && !spans.iter().all(|s| *s == first)) {
        return None;
    }
    let span = String::from_utf16_lossy(first);
    let styled = apply_file_quote_style(&span, new);
    Some((span, styled))
}

/// The replacement and `old_string` as the plan starts from them.
pub(super) fn dialect(content: &str, markdown: bool, mut old: String, mut new: String, replace_all: bool) -> (String, String) {
    if !markdown {
        new = strip_trailing_blanks(&new);
    }
    if !content.contains(&old) {
        if let Some((span, styled)) = typographic_rematch(content, &old, &new, replace_all) {
            old = span;
            new = styled;
        }
    }
    if new.is_empty() && !old.ends_with('\n') {
        if content.contains(&format!("{old}\r\n")) {
            old.push_str("\r\n");
        } else if content.contains(&format!("{old}\n")) {
            old.push('\n');
        }
    }
    (old, new)
}

// ---- line-ending plan ----

fn has_eol(text: &str) -> bool {
    text.contains(['\r', '\n'])
}

fn convert_eol(text: &str, eol: &str) -> String {
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    if eol == "\n" { lf } else { lf.replace('\n', eol) }
}

/// The first line break of `text`, `\r\n` counting as one.
fn first_eol(text: &str) -> Option<&'static str> {
    let at = text.find(['\r', '\n'])?;
    Some(if text[at..].starts_with("\r\n") {
        "\r\n"
    } else if text[at..].starts_with('\n') {
        "\n"
    } else {
        "\r"
    })
}

/// The convention around one match: the style inside the matched span, else the terminator of the
/// line the match sits on. Only the replaced span adopts it.
fn surrounding_eol(content: &str, start: usize, end: usize, matched: &str) -> Option<&'static str> {
    if matched.contains("\r\n") {
        return Some("\r\n");
    }
    if matched.contains('\n') {
        return Some("\n");
    }
    if matched.contains('\r') {
        return Some("\r");
    }
    if let Some(after) = first_eol(&content[end..]) {
        return Some(after);
    }
    let before = &content[..start];
    let nl = before.rfind('\n');
    let cr = before.rfind('\r');
    if nl.is_some_and(|n| n > 0 && before.as_bytes()[n - 1] == b'\r') {
        return Some("\r\n");
    }
    if nl.is_some() || cr.is_some() {
        let (n, c) = (nl.map_or(-1, |n| n as isize), cr.map_or(-1, |c| c as isize));
        return Some(if n > c { "\n" } else { "\r" });
    }
    None
}

fn find_occurrences(content: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut from = 0;
    while let Some(rel) = content[from..].find(needle) {
        out.push(from + rel);
        from += rel + needle.len();
    }
    out
}

struct Plan {
    old: String,
    rebased: bool,
    positions: Vec<usize>,
    replacements: Vec<String>,
    uniform: bool,
}

/// `old` is rebased onto the file's own line endings for matching only, and every occurrence gets
/// its own replacement speaking that occurrence's local convention.
fn plan_eol(content: &str, old: &str, new: &str, absorb_trailing_newline: bool) -> Plan {
    let mut match_old = old.to_owned();
    let mut rebased = false;
    if !content.contains(&match_old) && has_eol(&match_old) {
        for eol in ["\r\n", "\n", "\r"] {
            let candidate = convert_eol(&match_old, eol);
            if candidate != match_old && content.contains(&candidate) {
                match_old = candidate;
                rebased = true;
                break;
            }
        }
        // A block deletion absorbs its own trailing terminator. The test looks at the last two UTF-16
        // units of the match, so a block whose last line is one character long is left as it is.
        let tail: Vec<u16> = match_old.encode_utf16().collect();
        let tail_has_eol = tail[tail.len().saturating_sub(2)..].iter().any(|u| *u == 0x0A || *u == 0x0D);
        if absorb_trailing_newline && rebased && new.is_empty() && !tail_has_eol {
            for eol in ["\r\n", "\n", "\r"] {
                if content.contains(&format!("{match_old}{eol}")) {
                    match_old.push_str(eol);
                    break;
                }
            }
        }
    }
    let positions = find_occurrences(content, &match_old);
    let replacements: Vec<String> = positions
        .iter()
        .map(|&at| {
            if !has_eol(new) {
                return new.to_owned();
            }
            match surrounding_eol(content, at, at + match_old.len(), &match_old) {
                Some(eol) => convert_eol(new, eol),
                None => new.to_owned(),
            }
        })
        .collect();
    let uniform = replacements.iter().all(|r| r == new);
    Plan { old: match_old, rebased, positions, replacements, uniform }
}

// ---- appliers ----

/// The edited text and replacement count, or the model-facing failure. `utf8` is false for a
/// UTF-16 file, which only the exact applier splices.
/// `occupation` is a same-anchor batch member's `editOccurrence.expected`: when exactly that many occurrences remain, the
/// first is consumed (`applyEditOccupation`); any other count falls through to the strict ambiguity reject.
pub(super) fn apply(content: &str, old: &str, new: &str, replace_all: bool, utf8: bool, occupation: Option<u32>) -> Result<(String, usize), ToolError> {
    let plan = plan_eol(content, old, new, occupation.is_none());
    if !plan.positions.is_empty() && plan.replacements.iter().all(|r| *r == plan.old) {
        return Err(super::common::invalid("new_string", "same_as_old", SAME_STRINGS));
    }
    if let Some(expected) = occupation
        && !replace_all
        && expected >= 2
        && plan.positions.len() == expected as usize
    {
        let at = plan.positions[0];
        return Ok((format!("{}{}{}", &content[..at], plan.replacements[0], &content[at + plan.old.len()..]), 1));
    }
    if !utf8 || plan.rebased || !plan.uniform {
        return apply_exact(content, &plan, replace_all);
    }
    apply_tiered(content, &plan.old, new, replace_all)
}

fn apply_exact(content: &str, plan: &Plan, replace_all: bool) -> Result<(String, usize), ToolError> {
    let n = plan.positions.len();
    if n == 0 {
        let message = "old_string not found";
        return Err(conflict(0, format!("Error: edit failed ({message}){}", failure_excerpt(content, &plan.old, message))));
    }
    if n > 1 && !replace_all {
        let message = format!("old_string found {n} times");
        return Err(conflict(
            n as u32,
            format!(
                "Error: edit failed ({message}{}; pass replace_all:true or extend old_string){}",
                match_line_hint(content, &plan.old),
                failure_excerpt(content, &plan.old, &message)
            ),
        ));
    }
    let count = if replace_all { n } else { 1 };
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0;
    for k in 0..count {
        let at = plan.positions[k];
        out.push_str(&content[cursor..at]);
        out.push_str(&plan.replacements[k]);
        cursor = at + plan.old.len();
    }
    out.push_str(&content[cursor..]);
    Ok((out, count))
}

enum Miss {
    NotFound(String),
    Many(usize),
}

fn apply_tiered(content: &str, old: &str, new: &str, replace_all: bool) -> Result<(String, usize), ToolError> {
    let spans = match locate(content, old, replace_all) {
        Ok(spans) => spans,
        Err(Miss::NotFound(hint)) => {
            let message = format!("old_string not found{hint}");
            return Err(conflict(0, format!("Error: edit failed ({message}){}", failure_excerpt(content, old, &message))));
        }
        Err(Miss::Many(n)) => {
            let message = format!(
                "old_string found {n} times; add surrounding lines to make it unique, or set replace_all to true to change every occurrence"
            );
            let hinted = message.replacen(&format!("found {n} times"), &format!("found {n} times{}", match_line_hint(content, old)), 1);
            return Err(conflict(n as u32, format!("Error: edit failed ({hinted}){}", failure_excerpt(content, old, &message))));
        }
    };
    let bytes = content.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    let count = spans.len();
    for (start, mut end) in spans {
        // A deleted block takes its own line break with it.
        if new.is_empty() && !old.ends_with('\n') && !old.ends_with('\r') {
            if bytes.get(end) == Some(&b'\r') && bytes.get(end + 1) == Some(&b'\n') {
                end += 2;
            } else if matches!(bytes.get(end), Some(b'\n' | b'\r')) {
                end += 1;
            }
        }
        out.extend_from_slice(&bytes[cursor..start]);
        out.extend_from_slice(&preserve_eol(new, &bytes[start..end], bytes));
        cursor = end;
    }
    out.extend_from_slice(&bytes[cursor..]);
    // Spans fall on character boundaries and the replacement is text.
    Ok((String::from_utf8(out).expect("spliced text stays valid UTF-8"), count))
}

// ---- tiered location ----

#[derive(Clone, Copy)]
enum Tier {
    Exact,
    Curly,
    Nfc,
    Crlf,
}

fn fold_curly(c: char) -> char {
    match c {
        '\u{2018}'..='\u{201B}' => '\'',
        '\u{201C}'..='\u{201F}' => '"',
        other => other,
    }
}

/// `s` as one entry per normalized char, each paired with the byte span of the source it covers.
struct View {
    chars: Vec<char>,
    spans: Vec<(usize, usize)>,
}

fn view(s: &str, tier: Tier) -> View {
    let mut chars = Vec::new();
    let mut spans = Vec::new();
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let span = (i, i + c.len_utf8());
        match tier {
            Tier::Exact => {
                chars.push(c);
                spans.push(span);
            }
            Tier::Curly => {
                chars.push(fold_curly(c));
                spans.push(span);
            }
            Tier::Nfc => decompose_canonical(c, |d| {
                chars.push(d);
                spans.push(span);
            }),
            Tier::Crlf => {
                if c == '\r' {
                    if let Some(&(j, '\n')) = it.peek() {
                        it.next();
                        chars.push('\n');
                        spans.push((i, j + 1));
                        continue;
                    }
                }
                chars.push(c);
                spans.push(span);
            }
        }
    }
    View { chars, spans }
}

fn find_aligned(view: &View, needle: &[char]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= view.chars.len() {
        if view.chars[i..i + needle.len()] == *needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out.retain(|&m| aligned(view, m, needle.len()));
    out
}

/// A match is usable only when it starts at the first unit of a source char and ends at the last.
fn aligned(view: &View, m: usize, len: usize) -> bool {
    let start_ok = m == 0 || view.spans[m].0 != view.spans[m - 1].0;
    let last = m + len - 1;
    let end_ok = last + 1 == view.chars.len() || view.spans[last].1 != view.spans[last + 1].1;
    start_ok && end_ok
}

/// Occurrences counting overlaps: `aa` in `aaa` is two.
fn count_overlapping(view: &View, needle: &[char]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while i + needle.len() <= view.chars.len() {
        if view.chars[i..i + needle.len()] == *needle && aligned(view, i, needle.len()) {
            n += 1;
        }
        i += 1;
    }
    n
}

fn locate(source: &str, old: &str, replace_all: bool) -> Result<Vec<(usize, usize)>, Miss> {
    for tier in [Tier::Exact, Tier::Curly, Tier::Nfc, Tier::Crlf] {
        let v = view(source, tier);
        let needle = view(old, tier).chars;
        if needle.is_empty() {
            continue;
        }
        let matches = find_aligned(&v, &needle);
        if matches.is_empty() {
            continue;
        }
        if !replace_all {
            let overlap = count_overlapping(&v, &needle);
            if overlap > 1 {
                return Err(Miss::Many(overlap));
            }
        }
        let chosen = if replace_all { &matches[..] } else { &matches[..1] };
        return Ok(chosen.iter().map(|&m| (v.spans[m].0, v.spans[m + needle.len() - 1].1)).collect());
    }
    Err(Miss::NotFound(nearest_match_hint(source, old)))
}

/// First file line holding the longest token of `old`'s first non-blank line.
fn nearest_match_hint(source: &str, old: &str) -> String {
    let keyword = old
        .lines()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| line.split_whitespace().max_by_key(|token| token.len()))
        .unwrap_or("");
    if keyword.chars().count() < 4 {
        return String::new();
    }
    for (index, line) in source.lines().enumerate() {
        if line.contains(keyword) {
            let trimmed = line.trim();
            let content: String = trimmed.chars().take(120).collect();
            let ellipsis = if trimmed.chars().count() > 120 { "…" } else { "" };
            return format!("; nearest match on line {}: {content}{ellipsis}", index + 1);
        }
    }
    String::new()
}

/// The replacement with the line endings of the slice it replaces; a file that mixes endings is
/// never given endings it did not already use.
fn preserve_eol(new: &str, slice: &[u8], file: &[u8]) -> Vec<u8> {
    let slice_str = String::from_utf8_lossy(slice);
    let has_crlf = slice_str.contains("\r\n");
    let has_lf = slice_str.contains('\n');
    if !has_crlf && !has_lf {
        if file.contains(&b'\r') && !file.contains(&b'\n') {
            return new.replace("\r\n", "\n").replace('\n', "\r").into_bytes();
        }
        if !file.windows(2).any(|w| w == b"\r\n") {
            return new.as_bytes().to_vec();
        }
        for i in 0..file.len() {
            if file[i] == b'\n' && (i == 0 || file[i - 1] != b'\r') {
                return new.as_bytes().to_vec();
            }
        }
        return new.replace("\r\n", "\n").replace('\n', "\r\n").into_bytes();
    }
    let lf = new.replace("\r\n", "\n");
    let mut result = if has_crlf { lf.replace('\n', "\r\n") } else { lf };
    if slice_str.ends_with('\r') && !result.ends_with('\r') && !result.ends_with('\n') {
        result.push('\r');
    }
    result.into_bytes()
}

// ---- failure text ----

/// ` at lines 1, 3` for the first eight non-overlapping occurrences, `, …` when there are more.
fn match_line_hint(content: &str, old: &str) -> String {
    let positions = find_occurrences(content, old);
    if positions.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = positions.iter().take(8).map(|p| (content[..*p].matches('\n').count() + 1).to_string()).collect();
    if positions.len() > lines.len() {
        lines.push("…".to_owned());
    }
    format!(" at lines {}", lines.join(", "))
}

/// The line number after `nearest match on line `, matched without regard to ASCII case.
fn nearest_match_line(text: &str) -> Option<usize> {
    const KEY: &[u8] = b"nearest match on line ";
    let bytes = text.as_bytes();
    let at = (0..bytes.len().saturating_sub(KEY.len() - 1)).find(|&i| bytes[i..i + KEY.len()].eq_ignore_ascii_case(KEY))?;
    let digits: String = text[at + KEY.len()..].chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    Some(digits.parse::<usize>().unwrap_or(usize::MAX))
}

fn excerpt_center(source: &str, lines: &[String], old: &str, error_text: &str) -> Option<usize> {
    if let Some(n) = nearest_match_line(error_text) {
        return Some(n.saturating_sub(1));
    }
    if !old.is_empty() {
        if let Some(at) = source.find(old) {
            return Some(source[..at].matches('\n').count());
        }
    }
    let mut tokens: Vec<&str> = js_words(old).filter(|t| utf16_len(t) >= 4).collect();
    tokens.sort_by_key(|t| Reverse(utf16_len(t)));
    for token in tokens.into_iter().take(5) {
        if let Some(hit) = lines.iter().position(|l| l.contains(token)) {
            return Some(hit);
        }
    }
    let wanted = old.split('\n').find(|l| !js_trim(l).is_empty())?;
    nearest_line(lines, wanted, 0)
}

fn failure_excerpt(content: &str, old: &str, error_text: &str) -> String {
    let source = content.replace("\r\n", "\n");
    let lines: Vec<String> = source.split('\n').map(str::to_owned).collect();
    let Some(center) = excerpt_center(&source, &lines, old, error_text) else {
        return format!(
            "\ncurrent file has {} line(s) and contains nothing resembling old_string — verify the path and re-read before retrying.",
            lines.len()
        );
    };
    let start = center.saturating_sub(3);
    let end = lines.len().min(start.saturating_add(10));
    let mut rows: Vec<String> = Vec::new();
    let mut chars = 0;
    for raw in lines.get(start..end).unwrap_or_default() {
        let shown = if utf16_len(raw) > 240 { format!("{}…", mixdog_js::slice_utf16(raw, 240)) } else { raw.clone() };
        chars += utf16_len(&shown) + 1;
        if chars > 3000 {
            rows.push("…".to_owned());
            break;
        }
        rows.push(shown);
    }
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "\ncurrent file excerpt lines {}-{} (use exact current text for retry):\n{}",
        start + 1,
        start + rows.len(),
        rows.join("\n")
    )
}
