#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! User-facing workspace text search and replace (port of
//! `workspace-search.ts`). Patterns run on `regress`, an ECMAScript-syntax
//! engine, so syntax, flags and match results are those of the Node product.
//! Columns count UTF-16 code units, as JavaScript string indexes do.

use std::fs;
use std::path::Path;

use regex::Regex;
use serde::Serialize;

use crate::error::WsError;
use crate::error::WsResult;
use crate::glob::glob_list;
use crate::glob::normalize_path;
use crate::pathguard::project_entry_path;
use crate::text;
use crate::walk::text_files;

const MAX_FILE_BYTES: u64 = 2_097_152;
pub const MAX_REPLACE_FILES: usize = 100;
const PREVIEW_UNITS: usize = 1_000;

/// Which strings of a text search held an unpaired surrogate escape on the wire, read as U+FFFD. Node kept the code unit,
/// which no path or text decoded from disk holds: such a query finds nothing ([`Pattern::compile`]) and such a selector entry
/// selects nothing ([`selectors`]). The selectors are lists: `include` and `exclude` are the `char` indices of the units that
/// were lone, so only the entry holding one is affected.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueryLone {
    pub query: bool,
    pub include: Vec<usize>,
    pub exclude: Vec<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct TextQuery {
    pub query: String,
    pub lone: QueryLone,
    pub regex: bool,
    pub match_case: bool,
    pub whole_word: bool,
    pub include: String,
    pub exclude: String,
    pub max_results: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub line: usize,
    pub column: usize,
    pub end_column: usize,
    pub preview: String,
    pub match_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub rel_path: String,
    pub matches: Vec<TextMatch>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub files: Vec<FileMatches>,
    pub match_count: usize,
    pub limit_hit: bool,
}

/// One compiled pattern with JavaScript semantics.
pub struct Pattern(regress::Regex);

fn escape_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl Pattern {
    /// A pattern is checked by `mixdog_js::js_regex_error` (V8's message, byte for byte; the flags
    /// shown are the ones Node's search builds) and then compiled by `regress`, whose
    /// ECMAScript syntax keeps the matching semantics.
    ///
    /// A plain-text query that held a lone surrogate matches nothing: Node's is a `u` RegExp of the lone code point, which text
    /// decoded from UTF-8 never holds (workspace-search.ts:107), while the core's U+FFFD would match every real one. A regex
    /// query keeps U+FFFD (decisions.md "frame-lone-surrogate").
    pub fn compile(query: &TextQuery) -> WsResult<Self> {
        if query.lone.query && !query.regex {
            return Ok(Self(regress::Regex::with_flags("[]", "u").expect("the empty class compiles")));
        }
        let source = if query.regex { query.query.clone() } else { escape_literal(&query.query) };
        let shown = if query.match_case { "gu" } else { "giu" };
        if let Some(message) = mixdog_js::js_regex_error(&source, shown) {
            return Err(WsError::invalid(format!("Invalid search pattern: {message}")));
        }
        let flags = if query.match_case { "u" } else { "iu" };
        regress::Regex::with_flags(&source, flags).map(Self).map_err(|_| {
            WsError::invalid(format!("Invalid search pattern: Invalid regular expression: /{source}/{shown}: Regular expression too large"))
        })
    }
}
fn word_character() -> Regex {
    Regex::new(r"^[\p{L}\p{N}_]$").expect("static pattern")
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_whole_word(content: &str, start: usize, end: usize, word: &Regex) -> bool {
    let before = content[..start].chars().next_back();
    let after = content[end..].chars().next();
    let is_word = |c: Option<char>| c.is_some_and(|c| word.is_match(c.encode_utf8(&mut [0; 4])));
    !is_word(before) && !is_word(after)
}

fn line_matches(
    line: &str,
    number: usize,
    pattern: &Pattern,
    whole_word: bool,
    word: &Regex,
    remaining: usize,
) -> Vec<TextMatch> {
    let mut out = Vec::new();
    for found in pattern.0.find_iter(line) {
        if out.len() >= remaining {
            break;
        }
        let (start, end) = (found.start(), found.end());
        if whole_word && !is_whole_word(line, start, end, word) {
            continue;
        }
        let column = units(&line[..start]) + 1;
        let text_units = units(&line[start..end]);
        out.push(TextMatch {
            line: number,
            column,
            end_column: column + text_units,
            preview: preview(line),
            match_text: line[start..end].to_owned(),
        });
    }
    out
}

fn preview(line: &str) -> String {
    if units(line) <= PREVIEW_UNITS {
        return line.to_owned();
    }
    let mut count = 0;
    let mut out = String::new();
    for c in line.chars() {
        count += c.len_utf16();
        if count > PREVIEW_UNITS {
            break;
        }
        out.push(c);
    }
    out
}

/// A candidate's text; `None` when it is no searchable text file.
pub fn readable_text(root: &Path, rel: &str) -> Option<String> {
    let path = project_entry_path(root, rel).ok()?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let decoded = text::decode(&fs::read(&path).ok()?);
    (!decoded.binary).then_some(decoded.content)
}

pub fn clamp_max(query: &TextQuery) -> usize {
    query.max_results.unwrap_or(2_000).clamp(1, 5_000)
}

/// Node's `globList` (workspace-search.ts:45-56) of `list`. An entry that held a lone surrogate (`lone`: `char` indices of the
/// units that were lone) is Node's entry holding the lone unit: a case-insensitive RegExp of it matches no path read from disk,
/// so it matches nothing (an include of only such entries selects no file; such an exclude excludes none). Every other entry,
/// one holding a real U+FFFD included, is Node's.
fn selectors(list: &str, lone: &[usize]) -> Vec<Regex> {
    if lone.is_empty() {
        return glob_list(list);
    }
    let mut start = 0;
    let mut out = Vec::new();
    for raw in list.split(',') {
        let end = start + raw.chars().count();
        let held = lone.iter().any(|&at| (start..end).contains(&at));
        start = end + 1;
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        if held {
            out.push(Regex::new(r"\z.").expect("static pattern"));
        } else {
            out.extend(glob_list(entry));
        }
    }
    out
}

fn accepts(path: &str, include: &[Regex], exclude: &[Regex]) -> bool {
    !exclude.iter().any(|p| p.is_match(path)) && (include.is_empty() || include.iter().any(|p| p.is_match(path)))
}

pub fn search(root: &Path, query: &TextQuery, stop: &dyn Fn() -> bool) -> WsResult<SearchOutcome> {
    let maximum = clamp_max(query);
    let pattern = Pattern::compile(query)?;
    let word = word_character();
    let (include, exclude) = (selectors(&query.include, &query.lone.include), selectors(&query.exclude, &query.lone.exclude));
    let mut files = Vec::new();
    let mut count = 0;
    for rel in text_files(root, stop) {
        if count >= maximum || stop() {
            break;
        }
        if !accepts(&rel, &include, &exclude) {
            continue;
        }
        let Some(content) = readable_text(root, &rel) else { continue };
        let mut matches = Vec::new();
        for (index, line) in content.split('\n').enumerate() {
            if count >= maximum {
                break;
            }
            let line = line.strip_suffix('\r').unwrap_or(line);
            let found = line_matches(line, index + 1, &pattern, query.whole_word, &word, maximum - count);
            count += found.len();
            matches.extend(found);
        }
        if !matches.is_empty() {
            files.push(FileMatches { rel_path: rel, matches });
        }
    }
    Ok(SearchOutcome { files, match_count: count, limit_hit: count >= maximum })
}

fn replacement_text(template: &str, found: &regress::Match, input: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' || i + 1 >= chars.len() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let key = chars[i + 1];
        match key {
            '$' => {
                out.push('$');
                i += 2;
            }
            '&' => {
                out.push_str(&input[found.range()]);
                i += 2;
            }
            '`' => {
                out.push_str(&input[..found.start()]);
                i += 2;
            }
            '\'' => {
                out.push_str(&input[found.end()..]);
                i += 2;
            }
            d if d.is_ascii_digit() => {
                let two = chars.get(i + 2).filter(|c| c.is_ascii_digit());
                let digits: String = std::iter::once(d).chain(two.copied()).collect();
                let index: usize = digits.parse().expect("ascii digits");
                if index > 0 && index <= found.captures.len() {
                    if let Some(range) = found.group(index) {
                        out.push_str(&input[range]);
                    }
                    i += 2 + digits.len() - 1;
                } else {
                    out.push('$');
                    i += 1;
                }
            }
            _ => {
                out.push('$');
                i += 1;
            }
        }
    }
    out
}

fn replace_content(content: &str, query: &TextQuery, pattern: &Pattern, word: &Regex, replacement: &str) -> (String, usize) {
    let mut parts = String::new();
    let (mut cursor, mut replacements) = (0usize, 0usize);
    for found in pattern.0.find_iter(content) {
        let (start, end) = (found.start(), found.end());
        if query.whole_word && !is_whole_word(content, start, end, word) {
            continue;
        }
        parts.push_str(&content[cursor..start]);
        if query.regex {
            parts.push_str(&replacement_text(replacement, &found, content));
        } else {
            parts.push_str(replacement);
        }
        cursor = end;
        replacements += 1;
    }
    if replacements == 0 {
        return (content.to_owned(), 0);
    }
    parts.push_str(&content[cursor..]);
    (parts, replacements)
}

#[derive(Clone, Debug)]
pub struct PlannedWrite {
    pub rel_path: String,
    pub content: String,
    pub expected_content: String,
}

pub struct ReplacePlan {
    pub writes: Vec<PlannedWrite>,
    pub replacements: usize,
}

pub fn plan_replace(
    root: &Path,
    query: &TextQuery,
    replacement: &str,
    rel_paths: Option<&[String]>,
    stop: &dyn Fn() -> bool,
) -> WsResult<ReplacePlan> {
    let found = search(root, query, stop)?;
    if found.limit_hit {
        return Err(WsError::invalid("Search result limit reached. Narrow the search before replacing."));
    }
    // `rel_paths` is `None` for no list or an empty one (every match); a list emptied by the caller of paths that name no file
    // selects nothing.
    let requested: Option<Vec<String>> = rel_paths.map(|p| p.iter().map(|s| normalize_path(s)).collect());
    let pattern = Pattern::compile(query)?;
    let word = word_character();
    let mut writes = Vec::new();
    let mut replacements = 0;
    for file in found.files {
        if requested.as_ref().is_some_and(|r| !r.contains(&file.rel_path)) {
            continue;
        }
        let Some(expected) = readable_text(root, &file.rel_path) else { continue };
        let (content, count) = replace_content(&expected, query, &pattern, &word, replacement);
        if count == 0 || content == expected {
            continue;
        }
        writes.push(PlannedWrite { rel_path: file.rel_path, content, expected_content: expected });
        replacements += count;
    }
    if writes.len() > MAX_REPLACE_FILES {
        return Err(WsError::invalid(format!(
            "Replace affects {} files. Narrow the search to {MAX_REPLACE_FILES} files or fewer.",
            writes.len()
        )));
    }
    Ok(ReplacePlan { writes, replacements })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "Hello World\nhello world\nHELLO\nbye\n").unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/x.mjs"), "const hello = \"Hello\";\nfunction helloWorld() {}\n").unwrap();
        dir
    }

    fn q(query: &str) -> TextQuery {
        TextQuery { query: query.into(), ..Default::default() }
    }

    #[test]
    fn matches_the_recorded_node_results() {
        let dir = project();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let found = search(&root, &q("hello"), &|| false).unwrap();
        assert_eq!(found.match_count, 6);
        assert_eq!(found.files[1].matches[0].column, 7);
        assert_eq!(found.files[1].matches[0].end_column, 12);
        let words = search(&root, &TextQuery { whole_word: true, ..q("hello") }, &|| false).unwrap();
        assert_eq!(words.match_count, 5);
        let capped = search(&root, &TextQuery { max_results: Some(2), ..q("hello") }, &|| false).unwrap();
        assert!(capped.limit_hit && capped.match_count == 2);
        let regex = search(&root, &TextQuery { regex: true, ..q("hel+o\\w*") }, &|| false).unwrap();
        assert_eq!(regex.files[1].matches[2].match_text, "helloWorld");
        let look = search(&root, &TextQuery { regex: true, match_case: true, ..q("(?<=const )hello") }, &|| false).unwrap();
        assert_eq!(look.match_count, 1);
    }

    #[test]
    fn invalid_pattern_message_is_the_node_text() {
        let dir = project();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let error = search(&root, &TextQuery { regex: true, ..q("(") }, &|| false).unwrap_err();
        assert_eq!(error.message, "Invalid search pattern: Invalid regular expression: /(/giu: Unterminated group");
    }

    #[test]
    fn replace_plans_exact_writes() {
        let dir = project();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let plan = plan_replace(&root, &TextQuery { match_case: true, ..q("hello") }, "bye", None, &|| false).unwrap();
        assert_eq!(plan.writes.len(), 2);
        assert_eq!(plan.replacements, 3);
    }

    /// Node finds nothing for a plain-text query holding a lone surrogate, and replaces nothing with it (recorded as
    /// native/core/fixtures/inbound-lone-surrogate `search-lone-query`, `replace-lone-query`); a real U+FFFD is found.
    #[test]
    fn a_plain_query_that_held_a_lone_surrogate_matches_nothing() {
        let dir = project();
        fs::write(dir.path().join("r.txt"), "a\u{fffd}b\n").unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let lone = TextQuery { lone: QueryLone { query: true, ..QueryLone::default() }, ..q("\u{fffd}") };
        let found = search(&root, &lone, &|| false).unwrap();
        assert_eq!((found.files.len(), found.match_count, found.limit_hit), (0, 0, false));
        assert!(plan_replace(&root, &lone, "x", None, &|| false).unwrap().writes.is_empty());
        assert_eq!(search(&root, &q("\u{fffd}"), &|| false).unwrap().match_count, 1);
    }

    /// An include, exclude or path list entry that held a lone surrogate names no file (Node: a RegExp of the lone unit, an
    /// equality with it, workspace-search.ts:45-56, :238-240), even beside a file whose name holds a real U+FFFD.
    #[test]
    fn selectors_that_held_a_lone_surrogate_select_nothing() {
        let dir = project();
        fs::write(dir.path().join("a\u{fffd}.txt"), "hello\n").unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let named = |include: &str, exclude: &str, lone: QueryLone| {
            let query = TextQuery { include: include.into(), exclude: exclude.into(), lone, ..q("hello") };
            search(&root, &query, &|| false).unwrap().files.into_iter().map(|f| f.rel_path).collect::<Vec<_>>()
        };
        let include = |at: &[usize]| QueryLone { include: at.to_vec(), ..QueryLone::default() };
        let exclude = |at: &[usize]| QueryLone { exclude: at.to_vec(), ..QueryLone::default() };
        assert_eq!(named("a\u{fffd}.txt", "", include(&[1])), Vec::<String>::new());
        assert_eq!(named("a\u{fffd}.txt, a.txt", "", include(&[1])), ["a.txt"]);
        assert_eq!(named("a\u{fffd}.txt", "", QueryLone::default()), ["a\u{fffd}.txt"]);
        assert_eq!(named("", "a\u{fffd}.txt", exclude(&[1])), named("", "", QueryLone::default()));
        // Only the entry that held the lone unit is out: `b\ud800.txt` beside a real `a\ufffd.txt` (Node selects or excludes
        // the real one).
        assert_eq!(named("a\u{fffd}.txt,b\u{fffd}.txt", "", include(&[8])), ["a\u{fffd}.txt"]);
        assert!(!named("", "a\u{fffd}.txt,b\u{fffd}.txt", exclude(&[8])).contains(&"a\u{fffd}.txt".to_owned()));
        let plan = plan_replace(&root, &q("hello"), "bye", Some(&[]), &|| false).unwrap();
        assert!(plan.writes.is_empty(), "a list of only paths that held a lone surrogate selects nothing");
    }
}
