//! In-process line diffs for the turn-change paths, bounded the way Node bounds them (Node
//! `bounded-line-diff.mjs`): every file gets a short timeout, every operation (one tool call, one
//! review or seal pass) a total budget. A file over the size limits, past its timeout or past the
//! spent budget gets one replacement hunk between its common line prefix and suffix instead, still
//! an exact patch that applies, only not a minimal one. Results are cached by content, so the same
//! pair is not diffed again across calls and reviews.
//!
//! The diff itself is jsdiff's line Myers (`diffLines` + `structuredPatch`, version 9), step for
//! step: the same tie-breaks, the same hunk shapes, the same `formatPatch` text.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

use mixdog_js::utf16_len;
use sha1::Digest;
use sha1::Sha1;

/// Longest a single file's Myers diff may run (codex's per-file value).
pub const LINE_DIFF_FILE_TIMEOUT_MS: f64 = 100.0;
/// Total Myers diff time one operation may spend across its files.
pub const LINE_DIFF_OPERATION_BUDGET_MS: f64 = 150.0;
// A side over either limit is never Myers-diffed.
const LINE_DIFF_MAX_CHARS: usize = 1024 * 1024;
const LINE_DIFF_MAX_LINES: usize = 20_000;
const CONTEXT_LINES: usize = 3;
const CACHE_MAX_ENTRIES: usize = 512;
// Cached hunks reference their texts: bound the cache by their length.
const CACHE_MAX_CHARS: usize = 32 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Hunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct HunkSet {
    pub hunks: Vec<Hunk>,
    pub exact: bool,
}

/// One operation's diff budget; pass it to every [`LineDiffer::hunks`] call of it.
pub struct LineDiffBudget {
    pub remaining_ms: f64,
    // A fallback forced by the spent budget is final within its operation.
    fallbacks: HashMap<String, Arc<HunkSet>>,
}

impl LineDiffBudget {
    pub fn new(total_ms: f64) -> Self {
        Self { remaining_ms: total_ms, fallbacks: HashMap::new() }
    }
}

impl Default for LineDiffBudget {
    fn default() -> Self {
        Self::new(LINE_DIFF_OPERATION_BUDGET_MS)
    }
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, (Arc<HunkSet>, usize)>,
    order: VecDeque<String>,
    chars: usize,
}

impl Cache {
    fn get(&mut self, key: &str) -> Option<Arc<HunkSet>> {
        let (result, _) = self.entries.get(key)?;
        let result = result.clone();
        self.order.retain(|k| k != key);
        self.order.push_back(key.to_owned());
        Some(result)
    }

    fn set(&mut self, key: String, result: Arc<HunkSet>, chars: usize) {
        if chars > CACHE_MAX_CHARS {
            return;
        }
        if let Some((_, old)) = self.entries.remove(&key) {
            self.chars -= old;
            self.order.retain(|k| *k != key);
        }
        self.entries.insert(key.clone(), (result, chars));
        self.order.push_back(key);
        self.chars += chars;
        while self.entries.len() > CACHE_MAX_ENTRIES || self.chars > CACHE_MAX_CHARS {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some((_, old)) = self.entries.remove(&oldest) {
                self.chars -= old;
            }
        }
    }
}

/// The line differ with its result cache (one per process, like Node's module cache).
#[derive(Default)]
pub struct LineDiffer {
    cache: Mutex<Cache>,
}

fn sha1_hex(bytes: &[u8]) -> String {
    let digest = Sha1::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn over_limits(text: &str) -> bool {
    if utf16_len(text) > LINE_DIFF_MAX_CHARS {
        return true;
    }
    text.bytes().filter(|b| *b == b'\n').count() > LINE_DIFF_MAX_LINES
}

/// Lines with their `\n` (the last one may lack it), as jsdiff tokenizes.
pub fn line_tokens(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut tokens = Vec::new();
    let mut start = 0usize;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            tokens.push(&text[start..=index]);
            start = index + 1;
        }
    }
    if start < text.len() {
        tokens.push(&text[start..]);
    }
    tokens
}

fn push_lines(lines: &mut Vec<String>, mark: char, tokens: &[&str]) {
    for token in tokens {
        match token.strip_suffix('\n') {
            Some(body) => lines.push(format!("{mark}{body}")),
            None => {
                lines.push(format!("{mark}{token}"));
                lines.push("\\ No newline at end of file".to_owned());
            }
        }
    }
}

/// The one hunk replacing everything between the texts' common line prefix and suffix, with up to
/// three context lines each side, in jsdiff's hunk shape (`\ No newline at end of file` included).
fn replacement_hunks(old_text: &str, new_text: &str) -> Vec<Hunk> {
    let before = line_tokens(old_text);
    let after = line_tokens(new_text);
    let shortest = before.len().min(after.len());
    let mut start = 0usize;
    while start < shortest && before[start] == after[start] {
        start += 1;
    }
    let mut end = 0usize;
    while end < shortest - start && before[before.len() - 1 - end] == after[after.len() - 1 - end] {
        end += 1;
    }
    let lead = CONTEXT_LINES.min(start);
    let trail = CONTEXT_LINES.min(end);
    let mut lines = Vec::new();
    push_lines(&mut lines, ' ', &before[start - lead..start]);
    push_lines(&mut lines, '-', &before[start..before.len() - end]);
    push_lines(&mut lines, '+', &after[start..after.len() - end]);
    push_lines(&mut lines, ' ', &before[before.len() - end..before.len() - end + trail]);
    let first = start - lead;
    vec![Hunk {
        old_start: first + 1,
        old_lines: before.len() - end + trail - first,
        new_start: first + 1,
        new_lines: after.len() - end + trail - first,
        lines,
    }]
}

// ── jsdiff's Myers over line tokens ─────────────────────────────────────────

struct Component {
    count: usize,
    added: bool,
    removed: bool,
    previous: Option<Rc<Component>>,
}

#[derive(Clone)]
struct Path {
    old_pos: isize,
    last: Option<Rc<Component>>,
}

fn add_to_path(path: &Path, added: bool, removed: bool, old_pos_inc: isize) -> Path {
    let component = match &path.last {
        Some(last) if last.added == added && last.removed == removed => {
            Component { count: last.count + 1, added, removed, previous: last.previous.clone() }
        }
        last => Component { count: 1, added, removed, previous: last.clone() },
    };
    Path { old_pos: path.old_pos + old_pos_inc, last: Some(Rc::new(component)) }
}

fn extract_common(base: &mut Path, new_tokens: &[&str], old_tokens: &[&str], diagonal: isize) -> isize {
    let new_len = new_tokens.len() as isize;
    let old_len = old_tokens.len() as isize;
    let mut old_pos = base.old_pos;
    let mut new_pos = old_pos - diagonal;
    let mut common = 0usize;
    while new_pos + 1 < new_len && old_pos + 1 < old_len && old_tokens[(old_pos + 1) as usize] == new_tokens[(new_pos + 1) as usize] {
        new_pos += 1;
        old_pos += 1;
        common += 1;
    }
    if common > 0 {
        base.last = Some(Rc::new(Component { count: common, added: false, removed: false, previous: base.last.take() }));
    }
    base.old_pos = old_pos;
    new_pos
}

/// One run of the diff: `lines` are the tokens it covers.
struct Change<'a> {
    added: bool,
    removed: bool,
    lines: Vec<&'a str>,
}

fn build_values<'a>(last: Option<Rc<Component>>, new_tokens: &[&'a str], old_tokens: &[&'a str]) -> Vec<Change<'a>> {
    let mut components: Vec<(usize, bool, bool)> = Vec::new();
    let mut cursor = last;
    while let Some(component) = cursor {
        components.push((component.count, component.added, component.removed));
        cursor = component.previous.clone();
    }
    components.reverse();
    let (mut new_pos, mut old_pos) = (0usize, 0usize);
    let mut out = Vec::with_capacity(components.len());
    for (count, added, removed) in components {
        if !removed {
            out.push(Change { added, removed, lines: new_tokens[new_pos..new_pos + count].to_vec() });
            new_pos += count;
            if !added {
                old_pos += count;
            }
        } else {
            out.push(Change { added, removed, lines: old_tokens[old_pos..old_pos + count].to_vec() });
            old_pos += count;
        }
    }
    out
}

/// jsdiff `diffLines` (default options) with `timeout`: `None` once the time is spent.
fn diff_lines<'a>(old_tokens: &[&'a str], new_tokens: &[&'a str], timeout_ms: f64) -> Option<Vec<Change<'a>>> {
    let new_len = new_tokens.len() as isize;
    let old_len = old_tokens.len() as isize;
    let mut edit_length: isize = 1;
    let max_edit_length = new_len + old_len;
    let started = Instant::now();
    let elapsed_ms = || started.elapsed().as_secs_f64() * 1000.0;
    let offset = (max_edit_length + 2) as usize;
    let mut best_path: Vec<Option<Path>> = vec![None; 2 * offset + 3];
    let slot = |diagonal: isize| (diagonal + offset as isize) as usize;
    let mut seed = Path { old_pos: -1, last: None };
    let new_pos = extract_common(&mut seed, new_tokens, old_tokens, 0);
    if seed.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
        return Some(build_values(seed.last, new_tokens, old_tokens));
    }
    best_path[slot(0)] = Some(seed);
    let mut min_diagonal = isize::MIN;
    let mut max_diagonal = isize::MAX;
    while edit_length <= max_edit_length && elapsed_ms() <= timeout_ms {
        let mut diagonal = min_diagonal.max(-edit_length);
        // The bound is read again at every step: reaching an edge of the graph moves it.
        while diagonal <= max_diagonal.min(edit_length) {
            let remove_path = best_path[slot(diagonal - 1)].take();
            let add_path = best_path[slot(diagonal + 1)].clone();
            let mut can_add = false;
            if let Some(add) = &add_path {
                let add_new_pos = add.old_pos - diagonal;
                can_add = 0 <= add_new_pos && add_new_pos < new_len;
            }
            let can_remove = remove_path.as_ref().is_some_and(|r| r.old_pos + 1 < old_len);
            if !can_add && !can_remove {
                best_path[slot(diagonal)] = None;
                diagonal += 2;
                continue;
            }
            let remove_ref = remove_path.as_ref();
            let mut base = if !can_remove || (can_add && remove_ref.is_some_and(|r| r.old_pos < add_path.as_ref().map_or(0, |a| a.old_pos))) {
                add_to_path(add_path.as_ref().expect("add path"), true, false, 0)
            } else {
                add_to_path(remove_ref.expect("remove path"), false, true, 1)
            };
            let new_pos = extract_common(&mut base, new_tokens, old_tokens, diagonal);
            if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                return Some(build_values(base.last, new_tokens, old_tokens));
            }
            if base.old_pos + 1 >= old_len {
                max_diagonal = max_diagonal.min(diagonal - 1);
            }
            if new_pos + 1 >= new_len {
                min_diagonal = min_diagonal.max(diagonal + 1);
            }
            best_path[slot(diagonal)] = Some(base);
            diagonal += 2;
        }
        edit_length += 1;
    }
    None
}

/// jsdiff `structuredPatch(..., { context: 3, timeout })` hunks; `None` when the diff timed out.
fn structured_hunks(old_text: &str, new_text: &str, timeout_ms: f64) -> Option<Vec<Hunk>> {
    let old_tokens = line_tokens(old_text);
    let new_tokens = line_tokens(new_text);
    let mut diff = diff_lines(&old_tokens, &new_tokens, timeout_ms)?;
    // The sentinel jsdiff appends to make cleanup easier.
    diff.push(Change { added: false, removed: false, lines: Vec::new() });
    let context = CONTEXT_LINES;
    let mut hunks = Vec::new();
    let (mut old_range_start, mut new_range_start) = (0usize, 0usize);
    let mut cur_range: Vec<String> = Vec::new();
    let (mut old_line, mut new_line) = (1usize, 1usize);
    let last_index = diff.len();
    for i in 0..diff.len() {
        let lines = diff[i].lines.clone();
        if diff[i].added || diff[i].removed {
            if old_range_start == 0 {
                old_range_start = old_line;
                new_range_start = new_line;
                if i > 0 {
                    let prev = &diff[i - 1].lines;
                    let from = prev.len().saturating_sub(context);
                    cur_range = prev[from..].iter().map(|l| format!(" {l}")).collect();
                    old_range_start -= cur_range.len();
                    new_range_start -= cur_range.len();
                }
            }
            let mark = if diff[i].added { '+' } else { '-' };
            for line in &lines {
                cur_range.push(format!("{mark}{line}"));
            }
            if diff[i].added {
                new_line += lines.len();
            } else {
                old_line += lines.len();
            }
        } else {
            if old_range_start != 0 {
                if lines.len() <= context * 2 && i + 2 < last_index {
                    for line in &lines {
                        cur_range.push(format!(" {line}"));
                    }
                } else {
                    let context_size = lines.len().min(context);
                    for line in &lines[..context_size] {
                        cur_range.push(format!(" {line}"));
                    }
                    hunks.push(Hunk {
                        old_start: old_range_start,
                        old_lines: old_line - old_range_start + context_size,
                        new_start: new_range_start,
                        new_lines: new_line - new_range_start + context_size,
                        lines: std::mem::take(&mut cur_range),
                    });
                    old_range_start = 0;
                    new_range_start = 0;
                }
            }
            old_line += lines.len();
            new_line += lines.len();
        }
    }
    for hunk in &mut hunks {
        let mut lines = Vec::with_capacity(hunk.lines.len());
        for line in hunk.lines.drain(..) {
            match line.strip_suffix('\n') {
                Some(body) => lines.push(body.to_owned()),
                None => {
                    lines.push(line);
                    lines.push("\\ No newline at end of file".to_owned());
                }
            }
        }
        hunk.lines = lines;
    }
    Some(hunks)
}

impl LineDiffer {
    pub fn new() -> Self {
        Self::default()
    }

    fn side_hash(source: Option<&[u8]>, text: &str) -> String {
        sha1_hex(source.unwrap_or(text.as_bytes()))
    }

    /// Hunks (context 3, jsdiff's structuredPatch shape) turning `old_text` into `new_text`:
    /// jsdiff's own when its diff finishes within the file timeout and what is left of `budget`
    /// (`exact`), else the replacement hunk. `sources` are the raw bytes the texts came from (their
    /// hash is the cache key; `None` hashes the text).
    pub fn hunks(&self, old_text: &str, new_text: &str, budget: &mut LineDiffBudget, sources: [Option<&[u8]>; 2]) -> Arc<HunkSet> {
        if old_text == new_text {
            return Arc::new(HunkSet { hunks: Vec::new(), exact: true });
        }
        let key = format!("{}:{}", Self::side_hash(sources[0], old_text), Self::side_hash(sources[1], new_text));
        let cached = {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.get(&key)
        };
        if let Some(hit) = cached.or_else(|| budget.fallbacks.get(&key).cloned()) {
            return hit;
        }
        let mut result: Option<HunkSet> = None;
        // A fallback forced by the operation's spent budget is not this pair's own outcome: it is
        // not cached, so a later operation can still diff it.
        let mut repeatable = true;
        if !over_limits(old_text) && !over_limits(new_text) {
            if budget.remaining_ms > 0.0 {
                let timeout = LINE_DIFF_FILE_TIMEOUT_MS.min(budget.remaining_ms);
                let started = Instant::now();
                let patch = structured_hunks(old_text, new_text, timeout);
                budget.remaining_ms -= started.elapsed().as_secs_f64() * 1000.0;
                match patch {
                    Some(hunks) => result = Some(HunkSet { hunks, exact: true }),
                    None => repeatable = timeout >= LINE_DIFF_FILE_TIMEOUT_MS,
                }
            } else {
                repeatable = false;
            }
        }
        let result = Arc::new(result.unwrap_or_else(|| HunkSet { hunks: replacement_hunks(old_text, new_text), exact: false }));
        if repeatable {
            let chars = utf16_len(old_text) + utf16_len(new_text);
            self.cache.lock().unwrap_or_else(|e| e.into_inner()).set(key, result.clone(), chars);
        } else {
            // Within its own operation it is final: the budget never grows back.
            budget.fallbacks.insert(key, result.clone());
        }
        result
    }
}

// ── jsdiff formatPatch ──────────────────────────────────────────────────────

/// jsdiff's `quoteFileNameIfNeeded`: C-style quoting (git's, with UTF-8 octal escapes) for a name
/// holding a control character, a non-ASCII character, a quote or a backslash.
fn quote_file_name(name: &str) -> String {
    let needs = name.chars().any(|c| c < '\u{20}' || c > '\u{7e}' || c == '"' || c == '\\');
    if !needs {
        return name.to_owned();
    }
    let mut out = String::from("\"");
    for byte in name.bytes() {
        match byte {
            0x07 => out.push_str("\\a"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0a => out.push_str("\\n"),
            0x0b => out.push_str("\\v"),
            0x0c => out.push_str("\\f"),
            0x0d => out.push_str("\\r"),
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x20..=0x7e => out.push(byte as char),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out.push('"');
    out
}

/// The `--- `/`+++ ` headers and hunks of `hunks`, as jsdiff formats them, ending in exactly one
/// newline.
pub fn unified_hunks_body(old_header: &str, new_header: &str, hunks: &[Hunk]) -> String {
    let mut ret: Vec<String> = Vec::new();
    ret.push(format!("--- {}", quote_file_name(old_header)));
    ret.push(format!("+++ {}", quote_file_name(new_header)));
    for hunk in hunks {
        // Unified Diff Format quirk: with a chunk size of 0 the first number is one lower.
        let old_start = if hunk.old_lines == 0 { hunk.old_start - 1 } else { hunk.old_start };
        let new_start = if hunk.new_lines == 0 { hunk.new_start - 1 } else { hunk.new_start };
        ret.push(format!("@@ -{old_start},{} +{new_start},{} @@", hunk.old_lines, hunk.new_lines));
        ret.extend(hunk.lines.iter().cloned());
    }
    let mut generated = ret.join("\n");
    generated.push('\n');
    let trimmed = generated.trim_end_matches('\n').len();
    generated.truncate(trimmed);
    generated.push('\n');
    generated
}
