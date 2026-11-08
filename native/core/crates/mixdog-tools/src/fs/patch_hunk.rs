//! The V4A text engine behind `apply_patch`: line model with per-line terminators, anchor and
//! hunk location, ambiguity notices, and the failure hints. Pure text in, text or model-facing
//! error out. Locating mirrors Node's `v4a-convert` / `v4a-anchors` / `matcher` so a patch lands
//! where Node lands it and a miss reads the way Node's reads.

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::js_words;
use mixdog_js::json_stringify;
use mixdog_js::utf16_len;
use mixdog_protocol::JsonValue;
use unicode_normalization::UnicodeNormalization;

use super::hints::compact_preview;
use super::hints::longest_common_substring;
use super::hints::nearest_line;
use super::patch_native::find_hunk_match;
use super::patch_native::first_failing_detail;
use super::patch_native::first_meaningful;
use super::patch_window::Restored;
use super::patch_window::context_tolerant_window;
use super::patch_window::edit_distance_window;
use super::patch_window::escape_equiv_start;
use super::patch_window::outer_context_trimmed_window;
use super::patch_window::plus_window_covers_match;
use super::patch_window::restore_opcode_prefix_window;
use super::patch_window::restore_plus_as_context;

const EXCERPT_MAX_LINES: usize = 14;
const EXCERPT_MAX_CHARS: usize = 1000;
const NOTICE_CAP: usize = 4;

// ---- parsed patch ----

#[derive(Clone, Default)]
pub(super) struct Hunk {
    pub anchors: Vec<String>,
    /// Tagged lines: ` ` context, `-` delete, `+` add.
    pub lines: Vec<String>,
    pub eof: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Update,
    Add,
    Delete,
}

#[derive(Clone)]
pub(super) struct Section {
    pub kind: Kind,
    pub path: String,
    pub move_path: Option<String>,
    pub hunks: Vec<Hunk>,
    pub lines: Vec<String>,
}

// ---- lines with terminators ----

#[derive(Clone)]
pub(super) struct Lines {
    pub text: Vec<String>,
    pub terms: Vec<String>,
    pub eol: String,
}

/// The dominant line ending: a lone CR file is CR, otherwise CRLF only when it covers half the LFs.
pub(super) fn dominant_eol(text: &str) -> &'static str {
    if text.contains('\r') && !text.contains('\n') {
        return "\r";
    }
    let (mut lf, mut crlf) = (0usize, 0usize);
    let bytes = text.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            lf += 1;
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            }
        }
    }
    if lf > 0 && crlf * 2 >= lf { "\r\n" } else { "\n" }
}

impl Lines {
    pub(super) fn split(raw: &str) -> Self {
        let eol = dominant_eol(raw);
        let split_lone_cr = eol == "\r";
        let bytes = raw.as_bytes();
        let (mut text, mut terms) = (Vec::new(), Vec::new());
        let (mut start, mut i) = (0usize, 0usize);
        while i < bytes.len() {
            match bytes[i] {
                b'\n' => {
                    text.push(raw[start..i].to_owned());
                    terms.push("\n".to_owned());
                    i += 1;
                    start = i;
                }
                b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                    text.push(raw[start..i].to_owned());
                    terms.push("\r\n".to_owned());
                    i += 2;
                    start = i;
                }
                b'\r' if split_lone_cr => {
                    text.push(raw[start..i].to_owned());
                    terms.push("\r".to_owned());
                    i += 1;
                    start = i;
                }
                _ => i += 1,
            }
        }
        if start < raw.len() {
            text.push(raw[start..].to_owned());
            terms.push(String::new());
        }
        Self { text, terms, eol: eol.to_owned() }
    }

    /// Terminators are authoritative; a missing one on a non-last line borrows its predecessor's.
    pub(super) fn join(&self) -> String {
        let mut out = String::new();
        for (i, line) in self.text.iter().enumerate() {
            let last = i + 1 == self.text.len();
            let mut term = self.terms.get(i).cloned().unwrap_or_default();
            if term.is_empty() && !last {
                term = if i > 0 && !self.terms[i - 1].is_empty() { self.terms[i - 1].clone() } else { self.eol.clone() };
            }
            out.push_str(line);
            out.push_str(&term);
        }
        out
    }

    /// A replaced window's own last terminator, else its neighbours', else the file's.
    fn local_terminator(&self, start: usize, old_len: usize) -> String {
        let replaced = &self.terms[start.min(self.terms.len())..(start + old_len).min(self.terms.len())];
        if let Some(last) = replaced.last().filter(|t| !t.is_empty()) {
            return last.clone();
        }
        if start > 0 && !self.terms[start - 1].is_empty() {
            return self.terms[start - 1].clone();
        }
        self.terms.get(start).filter(|t| !t.is_empty()).cloned().unwrap_or_else(|| self.eol.clone())
    }

    fn splice(&mut self, start: usize, old_len: usize, new_lines: Vec<String>, new_terms: Option<Vec<String>>) {
        let local = self.local_terminator(start, old_len);
        let replaced_terms: Vec<String> = self.terms[start..start + old_len].to_vec();
        let replaced_lines: Vec<String> = self.text[start..start + old_len].to_vec();
        let explicit = new_terms.filter(|t| t.len() == new_lines.len());
        let next_terms: Vec<String> = new_lines
            .iter()
            .enumerate()
            .map(|(k, line)| match &explicit {
                Some(t) => t[k].clone(),
                None => match (replaced_lines.get(k), replaced_terms.get(k)) {
                    (Some(old), Some(term)) if old == line => term.clone(),
                    _ => local.clone(),
                },
            })
            .collect();
        self.terms.splice(start..start + old_len, next_terms);
        self.text.splice(start..start + old_len, new_lines);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Context,
    Delete,
    Add,
}

/// Op-wise terminators of one hunk's output lines: context keeps its own, a delete feeds its run,
/// an add takes the terminator of the delete it replaces, else the local convention.
fn terminators_for_ops(ops: &[(Op, String)], old_terms: &[String], fallback: &str) -> Vec<String> {
    struct Slot {
        line: String,
        term: Option<String>,
        used: bool,
        run: usize,
    }
    let mut pool: Vec<Slot> = Vec::new();
    let (mut cursor, mut run) = (0usize, 0usize);
    for (op, line) in ops {
        match op {
            Op::Context => {
                cursor += 1;
                run += 1;
            }
            Op::Delete => {
                pool.push(Slot { line: line.clone(), term: old_terms.get(cursor).cloned(), used: false, run });
                cursor += 1;
            }
            Op::Add => {}
        }
    }
    let (mut out, mut old_cursor, mut current_run) = (Vec::new(), 0usize, 0usize);
    let mut last_claimed: isize = -1;
    for (op, line) in ops {
        match op {
            Op::Context => {
                out.push(old_terms.get(old_cursor).cloned().unwrap_or_else(|| fallback.to_owned()));
                old_cursor += 1;
                current_run += 1;
            }
            Op::Delete => old_cursor += 1,
            Op::Add => {
                let after = pool.iter().enumerate().position(|(i, s)| !s.used && s.line == *line && (i as isize) > last_claimed);
                let any = || pool.iter().position(|s| !s.used && s.line == *line);
                let same_run = || pool.iter().position(|s| !s.used && s.run == current_run);
                let index = after.or_else(any).or_else(same_run);
                let mut inherited = None;
                if let Some(i) = index {
                    pool[i].used = true;
                    last_claimed = i as isize;
                    inherited = pool[i].term.clone();
                }
                out.push(inherited.unwrap_or_else(|| fallback.to_owned()));
            }
        }
    }
    out
}

// ---- text normalization ----

fn is_rust_ws(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{D}' | ' ' | '\u{85}' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}')
}

fn fold_typographic(c: char) -> char {
    match c {
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
        '\u{A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
        other => other,
    }
}

/// NFC, Rust-style trim, then dashes, quotes and unusual spaces folded to ASCII.
pub(super) fn normalize_typographic(s: &str) -> String {
    let nfc: String = s.nfc().collect();
    nfc.trim_matches(is_rust_ws).chars().map(fold_typographic).collect()
}

fn normalize_anchor_text(value: &str) -> String {
    js_trim(value)
        .chars()
        .map(|c| match c {
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{2018}'..='\u{201B}' => '\'',
            '\u{201C}'..='\u{201F}' => '"',
            '\u{A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

fn collapse_ws(s: &str) -> String {
    js_words(s).collect::<Vec<_>>().join(" ")
}

// ---- line sequence search ----

type Eq2 = fn(&str, &str) -> bool;

const LINE_TIERS: [Eq2; 5] = [
    |a, b| a == b,
    |a, b| js_trim_end(a) == js_trim_end(b),
    |a, b| js_trim(a) == js_trim(b),
    |a, b| collapse_ws(a) == collapse_ws(b),
    |a, b| normalize_typographic(a) == normalize_typographic(b),
];

fn matching_starts(lines: &[String], needle: &[String], from: usize, eq: Eq2, limit: usize) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut i = from;
    while i + needle.len() <= lines.len() && starts.len() < limit {
        if needle.iter().enumerate().all(|(k, n)| eq(&lines[i + k], n)) {
            starts.push(i);
        }
        i += 1;
    }
    starts
}

/// A single long needle line may still land on the one line sharing at least half of it verbatim.
fn best_substring_line(lines: &[String], needle: &str, from: usize) -> Option<usize> {
    let want = collapse_ws(needle);
    if utf16_len(&want) < 40 {
        return None;
    }
    let min_lcs = 40.max(utf16_len(&want) / 2);
    let (mut best_idx, mut best_lcs, mut ties) = (None, 0usize, 0usize);
    for (i, line) in lines.iter().enumerate().skip(from) {
        let cand = collapse_ws(line);
        if cand.is_empty() {
            continue;
        }
        let lcs = longest_common_substring(&cand, &want);
        if lcs < min_lcs {
            continue;
        }
        if lcs > best_lcs {
            best_lcs = lcs;
            best_idx = Some(i);
            ties = 1;
        } else if lcs == best_lcs {
            ties += 1;
        }
    }
    best_idx.filter(|_| ties == 1)
}

pub(super) fn find_line_sequence(lines: &[String], needle: &[String], from_line: usize, preferred: usize, fuzzy: bool, eof: bool) -> Option<usize> {
    if needle.is_empty() {
        return Some(if preferred > 0 { preferred } else { from_line });
    }
    let mut min_start = from_line;
    if eof && needle.len() <= lines.len() {
        min_start = min_start.max(lines.len() - needle.len());
    }
    let tiers: &[Eq2] = if fuzzy { &LINE_TIERS } else { &LINE_TIERS[..1] };
    for (tier, eq) in tiers.iter().enumerate() {
        let starts = matching_starts(lines, needle, min_start, *eq, usize::MAX);
        if starts.is_empty() || (tier > 0 && starts.len() != 1) {
            continue;
        }
        return starts.into_iter().min_by_key(|s| (s.abs_diff(preferred), *s));
    }
    if fuzzy && !eof && min_start > 0 {
        let starts = matching_starts(lines, needle, 0, LINE_TIERS[0], 2);
        if starts.len() == 1 {
            return Some(starts[0]);
        }
    }
    if fuzzy && needle.len() == 1 {
        return best_substring_line(lines, &needle[0], min_start);
    }
    None
}

/// Start of every verbatim occurrence of `pattern`, at most `cap`.
pub(super) fn exact_starts(lines: &[String], pattern: &[String], cap: usize) -> Vec<usize> {
    if pattern.is_empty() {
        return Vec::new();
    }
    matching_starts(lines, pattern, 0, LINE_TIERS[0], cap)
}

pub(super) fn unique_exact_start(lines: &[String], pattern: &[String]) -> Option<usize> {
    let starts = exact_starts(lines, pattern, 2);
    (starts.len() == 1).then(|| starts[0])
}

// ---- anchors ----

pub(super) struct Stats {
    pub old_count: usize,
    pub new_count: usize,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    /// ` ` or `-` for each old line.
    pub old_tags: Vec<char>,
}

pub(super) fn stats(hunk: &Hunk) -> Stats {
    let mut s = Stats { old_count: 0, new_count: 0, old_lines: Vec::new(), new_lines: Vec::new(), old_tags: Vec::new() };
    for raw in &hunk.lines {
        let Some(tag) = raw.chars().next() else { continue };
        let body = raw[tag.len_utf8()..].to_owned();
        match tag {
            ' ' => {
                s.old_count += 1;
                s.new_count += 1;
                s.old_lines.push(body.clone());
                s.new_lines.push(body);
                s.old_tags.push(' ');
            }
            '-' => {
                s.old_count += 1;
                s.old_lines.push(body);
                s.old_tags.push('-');
            }
            '+' => {
                s.new_count += 1;
                s.new_lines.push(body);
            }
            _ => {}
        }
    }
    s
}

fn real_anchors(hunk: &Hunk) -> Vec<String> {
    hunk.anchors.iter().map(|a| js_trim(a).to_owned()).filter(|a| !a.is_empty()).collect()
}

fn seek_anchor(lines: &[String], anchor: &str, cursor: usize) -> Option<usize> {
    let passes: [Box<dyn Fn(&str) -> bool>; 4] = [
        Box::new(|l| l.contains(anchor)),
        Box::new(|l| js_trim_end(l).contains(js_trim_end(anchor))),
        Box::new(|l| js_trim(l).contains(js_trim(anchor))),
        Box::new(|l| normalize_anchor_text(l).contains(&normalize_anchor_text(anchor))),
    ];
    for matches in &passes {
        if let Some(found) = lines.iter().enumerate().skip(cursor).find(|(_, l)| matches(l)).map(|(i, _)| i) {
            return Some(found);
        }
    }
    None
}

fn seek_anchor_chain(lines: &[String], anchors: &[String], from_line: usize) -> Option<usize> {
    let mut cursor = from_line;
    for anchor in anchors {
        cursor = seek_anchor(lines, anchor, cursor)? + 1;
    }
    Some(cursor)
}

/// A single all-digit anchor of 1-7 digits naming a real line of the file (1-based).
fn numeric_anchor_hint(anchors: &[String], line_count: usize) -> Option<usize> {
    let list: Vec<&str> = anchors.iter().map(|a| js_trim(a)).filter(|a| !a.is_empty()).collect();
    if list.len() != 1 || list[0].is_empty() || list[0].len() > 7 || !list[0].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: usize = list[0].parse().ok()?;
    (1..=line_count).contains(&n).then_some(n)
}

fn find_anchor_line(lines: &[String], hunk: &Hunk, from_line: usize) -> Option<usize> {
    let list = real_anchors(hunk);
    if list.is_empty() {
        return Some(from_line);
    }
    if let Some(forward) = seek_anchor_chain(lines, &list, from_line) {
        return Some(forward);
    }
    // Hunks listed out of file order leave the cursor past an anchor that is still present; retrying
    // from the top is safe only when every anchor occurs exactly once.
    if from_line > 0 && list.iter().all(|a| lines.iter().filter(|l| l.contains(a.as_str())).take(2).count() == 1) {
        if let Some(top) = seek_anchor_chain(lines, &list, 0) {
            return Some(top);
        }
    }
    numeric_anchor_hint(&list, lines.len())
}

// ---- notices ----

#[derive(Default)]
pub(super) struct Notices {
    list: Vec<String>,
    /// Hunks skipped under `reject_partial: false`: the section's path and why.
    rejected: Vec<(String, String)>,
}

impl Notices {
    fn push(&mut self, text: String) {
        if !self.list.contains(&text) {
            self.list.push(text);
        }
    }

    fn note_ambiguity(&mut self, display: &str, source: &[String], loc: &Loc) {
        if self.list.len() >= NOTICE_CAP || loc.anchored || loc.match_len == 0 {
            return;
        }
        if exact_starts(source, &loc.pattern, 2).len() < 2 {
            return;
        }
        self.push(format!(
            "{display}: hunk context matches more than one place; applied at line {} (first match after the previous hunk). Add an @@ anchor to target a different one.",
            loc.start + 1
        ));
    }

    fn note_eof_ignored(&mut self, display: &str, loc: &Loc) {
        if self.list.len() >= NOTICE_CAP || !loc.eof_ignored {
            return;
        }
        self.push(format!(
            "{display}: hunk carried *** End of File but its context is at line {}, not the end of file; the marker was ignored. Drop it unless the hunk really ends the file.",
            loc.start + 1
        ));
    }

    /// Node `rejectedHunkTail`: the skipped hunks, appended to a successful report.
    pub(super) fn rejected_tail(&self) -> String {
        if self.rejected.is_empty() {
            return String::new();
        }
        let mut lines = vec![String::new(), format!("hunk-level rejected (rejectPartial=false, V4A): {}", self.rejected.len())];
        for (file, reason) in &self.rejected {
            let file = if file.is_empty() { "(unknown)" } else { file.as_str() };
            lines.push(format!("  REJECT {file} — {}", js_trim(reason.split(';').next().unwrap_or(""))));
        }
        format!("\n{}", lines.join("\n"))
    }

    /// The pending notices as warning rows.
    pub(super) fn take_rows(&mut self) -> Vec<String> {
        std::mem::take(&mut self.list).into_iter().map(|n| format!("\u{26A0}\u{FE0F} {n}")).collect()
    }
}

// ---- hints ----

pub(super) fn js_string(s: &str) -> String {
    json_stringify(&JsonValue::String(s.to_owned()))
}

fn locator(hunk: &Hunk) -> String {
    let list: Vec<&str> = hunk.anchors.iter().map(String::as_str).filter(|a| !a.is_empty()).collect();
    if list.is_empty() { "(no anchor)".to_owned() } else { list.join(" > ") }
}

fn nearest_hint(lines: &[String], expected: &str, preferred: usize) -> Option<String> {
    nearest_line(lines, expected, preferred).map(|i| format!("nearest line {}: {}", i + 1, js_string(&compact_preview(&lines[i], 140))))
}

fn anchor_miss_hint(lines: &[String], hunk: &Hunk) -> String {
    let anchors: Vec<&str> = hunk.anchors.iter().map(String::as_str).filter(|a| !a.is_empty()).collect();
    if anchors.is_empty() {
        return " use an existing @@ anchor from the current file or add exact context lines.".to_owned();
    }
    let nearest = anchors.iter().find_map(|a| nearest_hint(lines, a, 0));
    let note = nearest.map(|n| format!(" nearest anchor candidate: {n}.")).unwrap_or_default();
    format!(" use an existing @@ anchor from the current file or add exact context lines; no stubs.{note}")
}

/// Verbatim window of the current file around a failed match, numbered.
fn source_excerpt(lines: &[String], center: Option<usize>, span: usize) -> String {
    let Some(center) = center.filter(|_| !lines.is_empty()) else { return String::new() };
    let want = (span + 4).clamp(6, EXCERPT_MAX_LINES);
    let before = 3.min(want / 3);
    let start = center.saturating_sub(before).min(lines.len().saturating_sub(want));
    let end = lines.len().min(start + want);
    let (mut out, mut chars) = (Vec::new(), 0usize);
    for (i, line) in lines.iter().enumerate().take(end).skip(start) {
        let text = format!("{:>5}| {}", i + 1, compact_preview(line, 120));
        chars += utf16_len(&text) + 1;
        if chars > EXCERPT_MAX_CHARS {
            out.push("     | …".to_owned());
            break;
        }
        out.push(text);
    }
    if out.is_empty() {
        return String::new();
    }
    format!("\ncurrent file lines {}-{} (verbatim — build the retry from these):\n{}", start + 1, start + out.len(), out.join("\n"))
}

/// When the first old line exists verbatim, the real mismatch is a later line of the block.
fn first_divergence(source: &[String], old: &[String], anchor_line: usize) -> Option<(String, usize)> {
    let first_idx = old.iter().position(|l| !js_trim(l).is_empty())?;
    let first = &old[first_idx];
    let starts: Vec<isize> = source.iter().enumerate().filter(|(_, l)| *l == first).map(|(i, _)| i as isize - first_idx as isize).collect();
    let pref = anchor_line as isize;
    let start = starts.into_iter().filter(|s| *s >= 0).min_by_key(|s| ((s - pref).abs(), *s))? as usize;
    for (k, exp) in old.iter().enumerate() {
        let act = source.get(start + k);
        if act != Some(exp) {
            let act_text = act.map_or_else(|| "(past EOF)".to_owned(), |a| js_string(&compact_preview(a, 140)));
            return Some((
                format!(
                    "first divergent line: old[{}] expected {} vs file line {} actual {act_text}",
                    k + 1,
                    js_string(&compact_preview(exp, 140)),
                    start + k + 1
                ),
                start + k,
            ));
        }
    }
    None
}

fn context_miss_hint(source: &[String], s: &Stats, anchor_line: usize) -> String {
    let expected = s.old_lines.iter().find(|l| !js_trim(l).is_empty()).cloned().unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut center: Option<usize> = None;
    if !expected.is_empty() {
        parts.push(format!("expected first old line: {}", js_string(&compact_preview(&expected, 140))));
        if let Some(n) = nearest_hint(source, &expected, anchor_line) {
            parts.push(n);
        }
        if let Some((text, idx)) = first_divergence(source, &s.old_lines, anchor_line) {
            parts.push(text);
            center = Some(idx);
        } else {
            center = nearest_line(source, &expected, anchor_line);
        }
    }
    let center = center.or(Some(anchor_line));
    parts.push("use exact current context or a broader @@ anchor; no stubs.".to_owned());
    format!(
        " {} Copy the context lines verbatim from the excerpt below — do not retype them from memory.{}",
        parts.join("; "),
        source_excerpt(source, center, s.old_lines.len())
    )
}

/// A V4A envelope marker among the old lines means the patch text is broken, not the context.
fn envelope_marker(source: &[String], old: &[String]) -> Option<(usize, String)> {
    for (index, text) in old.iter().enumerate() {
        let t = js_trim(text).to_ascii_lowercase();
        let is_marker = ["*** begin patch", "*** end patch", "*** update file:", "*** add file:", "*** delete file:", "*** move to:"]
            .iter()
            .any(|m| t.starts_with(m));
        if is_marker && !source.contains(text) {
            return Some((index, text.clone()));
        }
    }
    None
}

// ---- resolution ----

pub(super) struct Loc {
    pub start: usize,
    pub match_len: usize,
    pub new_lines: Vec<String>,
    pub next_search: usize,
    pub pattern: Vec<String>,
    pub anchored: bool,
    pub eof_ignored: bool,
    ops: Option<Vec<(Op, String)>>,
}

enum Resolved {
    Skip,
    Err(String),
    At(Loc),
}

struct Window {
    start: Option<usize>,
    old: Vec<String>,
    new: Vec<String>,
    eof_ignored: bool,
    /// The seek dropped the trailing blank line standing in for the region's final newline.
    trimmed_trailing: bool,
}

fn eof_insertion_index(lines: &[String]) -> usize {
    match lines.last() {
        Some(l) if l.is_empty() => lines.len() - 1,
        _ => lines.len(),
    }
}

fn leading_ws(s: &str) -> &str {
    &s[..s.len() - s.trim_start_matches([' ', '\t']).len()]
}

/// Whole-window trim-start match: same text, wrong leading indent, unique in the file.
fn indent_normalized_window(source: &[String], old: &[String]) -> Option<usize> {
    let n = old.len();
    if n == 0 {
        return None;
    }
    let mut starts = Vec::new();
    let mut i = 0;
    while i + n <= source.len() {
        let mut ok = true;
        let mut changed = false;
        for k in 0..n {
            let (pat, src) = (&old[k], &source[i + k]);
            if pat.trim_start_matches([' ', '\t']) != src.trim_start_matches([' ', '\t']) {
                ok = false;
                break;
            }
            if pat != src {
                changed = true;
            }
        }
        if ok && changed {
            starts.push(i);
        }
        i += 1;
    }
    (starts.len() == 1).then(|| starts[0])
}

/// Remaps a matched window to the file's own lines on both sides; `None` on any ambiguity.
fn remap_window(source: &[String], start: usize, old: &[String], new: &[String], skip_equal: bool, strict: bool) -> Option<(usize, Vec<String>, Vec<String>)> {
    let mut remapped: Vec<(String, String)> = Vec::new();
    for (k, pat) in old.iter().enumerate() {
        let src = &source[start + k];
        if skip_equal && src == pat {
            continue;
        }
        if strict && old.iter().filter(|l| *l == pat).count() > 1 {
            return None;
        }
        match remapped.iter().find(|(p, _)| p == pat) {
            Some((_, s)) if s != src => return None,
            Some(_) => {}
            None => remapped.push((pat.clone(), src.clone())),
        }
    }
    let new_lines = new.iter().map(|l| remapped.iter().find(|(p, _)| p == l).map_or_else(|| l.clone(), |(_, s)| s.clone())).collect();
    let old_lines = (0..old.len()).map(|k| source[start + k].clone()).collect();
    Some((remapped.len(), new_lines, old_lines))
}

/// New lines carrying a remapped leading indent where the matched old line differed only there.
fn remap_new_indents(old: &[String], source_slice: &[String], new: &[String]) -> Vec<String> {
    let mut prefix_map: Vec<(String, String)> = Vec::new();
    for (k, pat) in old.iter().enumerate() {
        let src = source_slice.get(k).map(String::as_str).unwrap_or("");
        if pat.trim_start_matches([' ', '\t']) != src.trim_start_matches([' ', '\t']) {
            continue;
        }
        let (from, to) = (leading_ws(pat), leading_ws(src));
        if from == to {
            continue;
        }
        match prefix_map.iter().find(|(f, _)| f == from) {
            Some((_, t)) if t != to => return new.to_vec(),
            Some(_) => {}
            None => prefix_map.push((from.to_owned(), to.to_owned())),
        }
    }
    if prefix_map.is_empty() {
        return new.to_vec();
    }
    new.iter()
        .map(|line| {
            let lead = leading_ws(line);
            match prefix_map.iter().find(|(f, _)| f == lead) {
                Some((_, to)) => format!("{to}{}", &line[lead.len()..]),
                None => line.clone(),
            }
        })
        .collect()
}

/// Adopts a window a tier rebuilt (peeled opcodes, trimmed outer context).
fn adopt_window(w: &mut Window, restored: Restored, mark_eof_ignored: bool) {
    w.start = Some(restored.start);
    w.old = restored.old;
    w.new = restored.new;
    if mark_eof_ignored {
        w.eof_ignored = true;
    }
}

/// Locates the window at `start` when its remap to the file's own lines is unambiguous.
fn adopt_remapped_window(source: &[String], w: &mut Window, start: usize, strict: bool) -> bool {
    let Some((_, new, old)) = remap_window(source, start, &w.old, &w.new, strict, strict) else { return false };
    w.new = new;
    w.old = old;
    w.start = Some(start);
    true
}

/// Node's `recoverHunkWindow`: the fuzzy recovery tiers, cheapest first. Each runs only while the
/// hunk is still unlocated; the peeled-`+` tier may also refine a located match.
fn recover(source: &[String], hunk: &Hunk, s: &Stats, anchor_line: usize, w: &mut Window, eof: bool) {
    let unlocated = |w: &Window| w.start.is_none() && !w.old.is_empty();
    if unlocated(w) {
        if let Some(restored) = restore_opcode_prefix_window(source, hunk) {
            adopt_window(w, restored, eof);
        }
    }
    if let Some(restored) = restore_plus_as_context(source, hunk) {
        if plus_window_covers_match(restored.start, restored.old.len(), w.start) {
            adopt_window(w, restored, eof);
        }
    }
    if unlocated(w) {
        if let Some(at) = indent_normalized_window(source, &w.old) {
            if adopt_remapped_window(source, w, at, false) && eof {
                w.eof_ignored = true;
            }
        }
    }
    // Escape equivalence: the marker is dropped before the scan whether or not it finds anything.
    if unlocated(w) {
        if eof {
            w.eof_ignored = true;
        }
        if let Some(alt) = escape_equiv_start(source, &w.old, anchor_line.saturating_sub(1)) {
            adopt_remapped_window(source, w, alt, false);
        }
    }
    if w.start.is_none() && w.old.len() >= 3 {
        let tags = if w.trimmed_trailing { &s.old_tags[..s.old_tags.len().saturating_sub(1)] } else { &s.old_tags[..] };
        if let Some(at) = context_tolerant_window(source, &w.old, tags) {
            adopt_remapped_window(source, w, at, true);
        }
    }
    if w.start.is_none() && !w.trimmed_trailing {
        if let Some(trimmed) = outer_context_trimmed_window(source, hunk, s) {
            adopt_window(w, trimmed, false);
        }
    }
    if w.start.is_none() && w.old.len() >= 3 {
        if let Some(at) = edit_distance_window(source, &w.old) {
            adopt_remapped_window(source, w, at, true);
        }
    }
}

fn resolve(source: &[String], hunk: &Hunk, next_search: usize, fuzzy: bool) -> Resolved {
    let s = stats(hunk);
    if s.old_count == 0 && s.new_count == 0 {
        return Resolved::Skip;
    }
    let eof = hunk.eof;
    let anchor_line = match find_anchor_line(source, hunk, next_search) {
        Some(a) => Some(a),
        None if fuzzy => unique_exact_start(source, &s.old_lines).map(|u| u + 1),
        None => None,
    };
    let Some(anchor_line) = anchor_line else {
        return Resolved::Err(format!("V4A hunk anchor not found: {};{}", locator(hunk), anchor_miss_hint(source, hunk)));
    };
    let mut w = Window { start: None, old: s.old_lines.clone(), new: s.new_lines.clone(), eof_ignored: false, trimmed_trailing: false };
    let search_from = anchor_line.saturating_sub(1);
    // Seek.
    if s.old_count == 0 {
        w.start = Some(eof_insertion_index(source));
    } else {
        w.start = find_line_sequence(source, &w.old, search_from, search_from, fuzzy, eof);
        // Retry without the trailing blank line standing in for the region's final newline.
        if w.start.is_none() && w.old.last().is_some_and(String::is_empty) {
            w.old.pop();
            w.trimmed_trailing = true;
            if w.new.last().is_some_and(String::is_empty) {
                w.new.pop();
            }
            w.start = if w.old.is_empty() { Some(anchor_line) } else { find_line_sequence(source, &w.old, search_from, search_from, fuzzy, eof) };
        }
    }
    let unlocated = |w: &Window| w.start.is_none() && !w.old.is_empty();
    // `*** End of File` is a hint: retry as an ordinary in-file search.
    if eof && unlocated(&w) {
        if let Some(r) = find_line_sequence(source, &w.old, search_from, search_from, fuzzy, false) {
            w.start = Some(r);
            w.eof_ignored = true;
        }
    }
    // A bare line-number anchor is also a positional claim.
    if unlocated(&w) {
        if let Some(hint) = numeric_anchor_hint(&real_anchors(hunk), source.len()) {
            let leading = hunk
                .lines
                .iter()
                .filter(|l| matches!(l.as_bytes().first(), Some(b' ' | b'-')))
                .take_while(|l| l.starts_with(' '))
                .count();
            let from = (hint - 1).saturating_sub(leading);
            if let Some(at) = find_line_sequence(source, &w.old, from, from, fuzzy, false) {
                w.start = Some(at);
                if eof {
                    w.eof_ignored = true;
                }
            }
        }
    }
    if fuzzy {
        recover(source, hunk, &s, anchor_line, &mut w, eof);
    }
    if let Some(start) = w.start.filter(|_| !w.old.is_empty()) {
        let slice: Vec<String> = source[start..start + w.old.len()].to_vec();
        w.new = remap_new_indents(&w.old, &slice, &w.new);
        if let Some((count, new, old)) = remap_window(source, start, &w.old, &w.new, true, false) {
            if count > 0 {
                w.new = new;
                w.old = old;
            }
        }
    }
    let Some(start) = w.start else {
        if let Some((index, line)) = envelope_marker(source, &s.old_lines) {
            return Resolved::Err(format!(
                "V4A hunk structure error (malformed patch envelope): {} appears as a content line at old[{}]. The section body ended early or is missing its `*** Update File: <path>` header. Rebuild the envelope and resend; the file was never searched, so no context excerpt applies.",
                js_string(&compact_preview(&line, 140)),
                index + 1
            ));
        }
        return Resolved::Err(format!("V4A hunk context not found: {};{}", locator(hunk), context_miss_hint(source, &s, anchor_line)));
    };
    let match_len = if s.old_count == 0 { 0 } else { w.old.len() };
    Resolved::At(Loc {
        start,
        match_len,
        next_search: if match_len == 0 { next_search } else { start + match_len },
        ops: ops_for(hunk, match_len, w.new.len()),
        pattern: w.old,
        anchored: !real_anchors(hunk).is_empty(),
        eof_ignored: w.eof_ignored,
        new_lines: w.new,
    })
}

/// The hunk's op sequence, but only when it still describes the window that was matched.
fn ops_for(hunk: &Hunk, match_len: usize, new_len: usize) -> Option<Vec<(Op, String)>> {
    let mut ops = Vec::new();
    for raw in &hunk.lines {
        if raw.is_empty() || is_eof_marker(raw) {
            continue;
        }
        let tag = raw.as_bytes()[0];
        let rest = raw[1..].to_owned();
        ops.push(match tag {
            b'-' => (Op::Delete, rest),
            b'+' => (Op::Add, rest),
            b' ' => (Op::Context, rest),
            _ => (Op::Context, raw.clone()),
        });
    }
    let old_count = ops.iter().filter(|(o, _)| *o != Op::Add).count();
    let new_count = ops.iter().filter(|(o, _)| *o != Op::Delete).count();
    (old_count == match_len && new_count == new_len).then_some(ops)
}

pub(super) fn is_eof_marker(raw: &str) -> bool {
    let t = js_trim(raw);
    t == "*** End of File" || t.strip_prefix("*** End of File").is_some_and(|rest| rest.chars().all(|c| is_js_space(c) || c == '*'))
}

// ---- ordering and application ----

fn resolves_in_order(source: &[String], hunks: &[Hunk], fuzzy: bool) -> bool {
    let mut next = 0;
    for h in hunks {
        let s = stats(h);
        if s.old_count == 0 && s.new_count == 0 {
            continue;
        }
        match resolve(source, h, next, fuzzy) {
            Resolved::At(loc) => next = loc.next_search,
            _ => return false,
        }
    }
    true
}

/// Hunks in file order, but only when they do not already resolve in the order given.
fn order_hunks(source: &[String], hunks: &[Hunk], fuzzy: bool) -> Vec<Hunk> {
    if hunks.len() <= 1 || resolves_in_order(source, hunks, fuzzy) {
        return hunks.to_vec();
    }
    let mut keyed: Vec<(usize, usize, Hunk)> = Vec::new();
    for (idx, h) in hunks.iter().enumerate() {
        let s = stats(h);
        if s.old_count == 0 && s.new_count == 0 {
            keyed.push((usize::MAX, idx, h.clone()));
            continue;
        }
        let seq: Vec<String> = h
            .lines
            .iter()
            .filter(|l| !is_eof_marker(l))
            .filter_map(|l| matches!(l.as_bytes().first(), Some(b' ' | b'-')).then(|| l[1..].to_owned()))
            .collect();
        match (!seq.is_empty()).then(|| unique_exact_start(source, &seq)).flatten() {
            Some(pos) => keyed.push((pos, idx, h.clone())),
            None => return hunks.to_vec(),
        }
    }
    keyed.sort_by_key(|(k, i, _)| (*k, *i));
    keyed.into_iter().map(|(_, _, h)| h).collect()
}

pub(super) struct Applied {
    pub lines: Lines,
}

/// Applies every hunk of `hunks` to `source`. `path` names the section in hunk errors (`V4A hunk
/// <path>: …`); `notices` collects the non-fatal warnings.
pub(super) fn apply_hunks(
    source: &Lines,
    hunks: &[Hunk],
    fuzzy: bool,
    path: Option<&str>,
    display: &str,
    mut notices: Option<&mut Notices>,
    overlap_label: &str,
    reject_partial: bool,
) -> Result<Applied, String> {
    let mut lines = source.clone();
    let ordered = order_hunks(&source.text, hunks, fuzzy);
    let mut next = 0;
    let mut reps: Vec<Loc> = Vec::new();
    for h in &ordered {
        match resolve(&source.text, h, next, fuzzy) {
            Resolved::Skip => {}
            Resolved::Err(e) => {
                let message = match path {
                    Some(p) => e.replacen("V4A hunk ", &format!("V4A hunk {p}: "), 1),
                    None => e,
                };
                match (reject_partial, notices.as_deref_mut()) {
                    (false, Some(n)) => n.rejected.push((path.unwrap_or_default().to_owned(), message)),
                    _ => return Err(message),
                }
            }
            Resolved::At(loc) => {
                if let Some(n) = notices.as_deref_mut() {
                    n.note_ambiguity(display, &source.text, &loc);
                    n.note_eof_ignored(display, &loc);
                }
                next = loc.next_search;
                reps.push(loc);
            }
        }
    }
    reps.sort_by_key(|l| l.start);
    assert_safe_plan(&reps.iter().map(|l| (l.start, l.match_len)).collect::<Vec<_>>(), overlap_label)?;
    for loc in reps.into_iter().rev() {
        let old_terms: Vec<String> = lines.terms[loc.start..loc.start + loc.match_len].to_vec();
        let new_terms = loc.ops.as_ref().map(|ops| terminators_for_ops(ops, &old_terms, &lines.local_terminator(loc.start, loc.match_len)));
        lines.splice(loc.start, loc.match_len, loc.new_lines, new_terms);
    }
    Ok(Applied { lines })
}

// ---- unified conversion ----

/// One resolved hunk as a unified-diff hunk: the header, the body lines and the numbers jsdiff's
/// parser would read from the header (a zero-length old range has its start bumped by one).
#[derive(Clone)]
pub(super) struct UHunk {
    pub header: String,
    pub old_start: usize,
    pub lines: Vec<String>,
}

/// The unified-diff body replacing `old` with `new`: shared lines at either end stay context.
fn emit_unified_replacement(old: &[String], new: &[String]) -> Vec<String> {
    let mut body = Vec::new();
    let mut a = 0;
    while a < old.len() && a < new.len() && old[a] == new[a] {
        body.push(format!(" {}", old[a]));
        a += 1;
    }
    let b = a;
    let (mut old_end, mut new_end) = (old.len(), new.len());
    while old_end > a && new_end > b && old[old_end - 1] == new[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    body.extend(old[a..old_end].iter().map(|l| format!("-{l}")));
    body.extend(new[b..new_end].iter().map(|l| format!("+{l}")));
    body.extend(old[old_end..].iter().map(|l| format!(" {l}")));
    body
}

fn unified_hunk(hunk: &Hunk, loc: &Loc) -> UHunk {
    let tail = hunk.anchors.iter().filter(|a| !a.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    let old: &[String] = if loc.match_len == 0 { &[] } else { &loc.pattern };
    let (emitted_old, emitted_new) = (old.len(), loc.new_lines.len());
    // A zero-length old range is an insertion: its header start is the 0-based insertion index
    // (`-N,0` inserts after source line N); a replacement starts at its 1-based first line.
    let start = if emitted_old == 0 { loc.start } else { loc.start + 1 };
    UHunk {
        header: format!("@@ -{start},{emitted_old} +{start},{emitted_new} @@{}", if tail.is_empty() { String::new() } else { format!(" {tail}") }),
        old_start: if emitted_old == 0 { start + 1 } else { start },
        lines: emit_unified_replacement(old, &loc.new_lines),
    }
}

/// Node `unifiedUpdateHunks`: the section's hunks resolved against `source`, as unified hunks in
/// resolved-position order (the applying engine walks them with a forward-only cursor). Overlaps
/// are not checked here; the engine that applies the hunks reports them.
pub(super) fn unified_update_hunks(
    source: &Lines,
    hunks: &[Hunk],
    fuzzy: bool,
    path: &str,
    display: &str,
    notices: &mut Notices,
    reject_partial: bool,
) -> Result<Vec<UHunk>, String> {
    let mut found: Vec<(usize, usize, UHunk)> = Vec::new();
    let mut next = 0;
    for h in &order_hunks(&source.text, hunks, fuzzy) {
        match resolve(&source.text, h, next, fuzzy) {
            Resolved::Skip => {}
            Resolved::Err(e) => {
                let message = e.replacen("V4A hunk ", &format!("V4A hunk {path}: "), 1);
                if reject_partial {
                    return Err(message);
                }
                notices.rejected.push((path.to_owned(), message));
            }
            Resolved::At(loc) => {
                found.push((loc.start, found.len(), unified_hunk(h, &loc)));
                notices.note_ambiguity(display, &source.text, &loc);
                notices.note_eof_ignored(display, &loc);
                next = loc.next_search;
            }
        }
    }
    found.sort_by_key(|(start, order, _)| (*start, *order));
    Ok(found.into_iter().map(|(_, _, h)| h).collect())
}
// ---- applying a unified patch's own hunks (the codec-preserving writer) ----

/// Which side of a hunk carries a `\ No newline at end of file` marker.
fn unified_eof_intent(hunk: &UHunk) -> (bool, bool) {
    let (mut old_no_newline, mut new_no_newline) = (false, false);
    let mut last: Option<char> = None;
    for raw in hunk.lines.iter().filter(|l| !l.is_empty()) {
        match raw.chars().next() {
            Some('\\') => {
                match last {
                    Some(' ') => {
                        old_no_newline = true;
                        new_no_newline = true;
                    }
                    Some('-') => old_no_newline = true,
                    Some('+') => new_no_newline = true,
                    _ => {}
                }
            }
            Some(t @ (' ' | '-' | '+')) => last = Some(t),
            _ => last = None,
        }
    }
    (old_no_newline, new_no_newline)
}

fn set_final_newline(lines: &mut Lines, has_newline: bool) {
    let Some(last) = lines.terms.len().checked_sub(1) else { return };
    if !has_newline {
        lines.terms[last] = String::new();
    } else if lines.terms[last].is_empty() {
        lines.terms[last] = if last > 0 && !lines.terms[last - 1].is_empty() { lines.terms[last - 1].clone() } else { lines.eol.clone() };
    }
}

/// Node `unifiedHunkMissMessage`.
fn unified_miss_message(display: &str, hunk: &UHunk, lines: &[String]) -> String {
    let detail = first_failing_detail(lines, hunk).or_else(|| first_meaningful(hunk));
    let (expected, preferred) = detail.unwrap_or_default();
    let mut out = format!("apply_patch: hunk context not found in {display}");
    if !expected.is_empty() {
        out.push_str(&format!("; expected first old/context line: {}", js_string(&compact_preview(&expected, 140))));
        if let Some(i) = nearest_line(lines, &expected, preferred) {
            out.push_str(&format!("; nearest line {}: {}", i + 1, js_string(&compact_preview(&lines[i], 140))));
        }
    }
    out.push_str("; use exact current lines, no stubs.");
    out.push_str(&source_excerpt(lines, Some(preferred), hunk.lines.len()));
    out
}

/// Rejects a plan whose ranges overlap or share a start (insertions at one index excepted).
fn assert_safe_plan(plan: &[(usize, usize)], label: &str) -> Result<(), String> {
    for pair in plan.windows(2) {
        let ((prev_start, prev_len), (start, len)) = (pair[0], pair[1]);
        if start == prev_start {
            if prev_len == 0 && len == 0 {
                continue;
            }
            return Err(format!(
                "{label}: two hunks resolve to the same position (line {}) and at least one of them replaces existing lines; widen their context or split them into separate patches.",
                start + 1
            ));
        }
        if start < prev_start + prev_len {
            return Err(format!(
                "{label}: hunks overlap — line {} falls inside lines {}-{} already replaced by an earlier hunk; widen their context or split them into separate patches.",
                start + 1,
                prev_start + 1,
                prev_start + prev_len
            ));
        }
    }
    Ok(())
}

/// Node `applyUnifiedHunksToLines`: each hunk is first tried at its own declared line and then
/// fuzz-matched forward; the plan is checked for overlaps before anything is spliced, and the
/// hunks are applied last-first so earlier positions stay valid.
pub(super) fn apply_unified_hunks(source: &Lines, hunks: &[UHunk], fuzz: usize, display: &str) -> Result<Lines, String> {
    struct Rep {
        start: usize,
        old_len: usize,
        new_lines: Vec<String>,
        ops: Vec<(Op, String)>,
        intent: (bool, bool),
        at_eof: bool,
    }
    let mut lines = source.clone();
    let mut reps: Vec<Rep> = Vec::new();
    let mut min_start = 0;
    for h in hunks {
        let Some((start, end)) = find_hunk_match(&lines, h, min_start, fuzz) else {
            return Err(unified_miss_message(display, h, &lines.text));
        };
        let mut new_lines = Vec::new();
        let mut ops = Vec::new();
        for raw in h.lines.iter().filter(|l| !l.is_empty()) {
            let rest = raw[1..].to_owned();
            match raw.as_bytes()[0] {
                b' ' => {
                    new_lines.push(rest.clone());
                    ops.push((Op::Context, rest));
                }
                b'-' => ops.push((Op::Delete, rest)),
                b'+' => {
                    new_lines.push(rest.clone());
                    ops.push((Op::Add, rest));
                }
                _ => {}
            }
        }
        reps.push(Rep { start, old_len: end - start, new_lines, ops, intent: unified_eof_intent(h), at_eof: end >= lines.text.len() });
        min_start = min_start.max(end);
    }
    reps.sort_by_key(|r| r.start);
    assert_safe_plan(&reps.iter().map(|r| (r.start, r.old_len)).collect::<Vec<_>>(), &format!("apply_patch: {display}"))?;
    for rep in reps.into_iter().rev() {
        let old_terms: Vec<String> = lines.terms[rep.start..rep.start + rep.old_len].to_vec();
        let new_terms = terminators_for_ops(&rep.ops, &old_terms, &lines.local_terminator(rep.start, rep.old_len));
        lines.splice(rep.start, rep.old_len, rep.new_lines, Some(new_terms));
        // Explicit markers win in both directions; a hunk silent about the terminator leaves the
        // file's own state alone.
        if rep.at_eof {
            let (old_no_newline, new_no_newline) = rep.intent;
            if new_no_newline {
                set_final_newline(&mut lines, false);
            } else if old_no_newline {
                set_final_newline(&mut lines, true);
            }
        }
    }
    Ok(lines)
}