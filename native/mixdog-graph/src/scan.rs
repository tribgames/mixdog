// Structural scan mode — `mixdog-graph <cwd> --scan --rules <path|-> [--files
// <rel>...] [--fix]` — and the language registry dump `--langs`.
//
// The scan runs ast-grep rules (the exact `sg scan` YAML schema: id, language,
// severity, message, note, rule, constraints, utils, transform, rewriters,
// fix, files/ignores) over the repository and reports matches as JSONL on
// stdout. Rust NEVER writes a source file here: `--fix` only computes the
// replacement text and the byte range it would replace; applying it is the
// caller's job.
//
// stdout protocol, one JSON object per match, in file order (files sorted by
// path) and then by byte offset within a file:
//
//   {"file":"src/a.ts","lang":"typescript","ruleId":"no-await-in-loop",
//    "severity":"warning","message":"...",
//    "range":{"start":{"line":0,"column":0},"end":{"line":0,"column":9},
//             "byteOffset":[0,9]},
//    "fix":{"byteOffset":[0,9],"text":"..."}|null}
//
// LINES AND COLUMNS ARE ZERO-BASED. `line` is a zero-based row; `column` is a
// zero-based character (not byte) offset within that row, matching ast-grep's
// own JSON output. `byteOffset` is a [start, end) byte range into the file as
// read from disk. The `fix` key is emitted only when `--fix` was passed; it is
// `null` for a match whose rule has no `fix`.
//
// The last stdout line is always the summary:
//
//   {"summary":{"files":N,"matches":M,"fixable":F,"errors":["..."]}}
//
// `files` counts files that were parsed and scanned (a file whose language has
// no applicable rule is never read), `matches` counts emitted match objects,
// `fixable` counts matches whose rule carries a fix (independent of `--fix`),
// and `errors` collects per-file read/parse failures, which are not fatal.
//
// Exit codes are decided by the caller in main.rs: 0 success (with or without
// matches), 1 internal error, 2 usage or rule-parse error.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use ast_grep_config::{
    from_yaml_string, CombinedScan, GlobalRules, RuleCollection, RuleConfig, Severity,
};
use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::{AstGrep, NodeMatch};
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::Serialize;

use crate::scan_lang::{scan_lang_for_path, ScanLang, LANG_INFOS};

/// Same cap as the extraction walk: files above it are skipped silently.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Scan failures split by exit code: `Usage` → 2, `Internal` → 1.
pub enum ScanError {
    Usage(String),
    Internal(String),
}

#[derive(Serialize)]
struct PositionJson {
    line: usize,
    column: usize,
}

#[derive(Serialize)]
struct RangeJson {
    start: PositionJson,
    end: PositionJson,
    #[serde(rename = "byteOffset")]
    byte_offset: [usize; 2],
}

#[derive(Serialize)]
struct FixJson {
    #[serde(rename = "byteOffset")]
    byte_offset: [usize; 2],
    text: String,
}

#[derive(Serialize)]
pub struct MatchRecord {
    file: String,
    lang: &'static str,
    #[serde(rename = "ruleId")]
    rule_id: String,
    severity: &'static str,
    message: String,
    range: RangeJson,
    // Outer None → key omitted (no `--fix`); Some(None) → `null` (rule has no
    // fix); Some(Some(..)) → the computed replacement.
    #[serde(skip_serializing_if = "Option::is_none")]
    fix: Option<Option<FixJson>>,
    // Not serialized: sort key so one file's matches are emitted in source
    // order regardless of the order rules fired.
    #[serde(skip)]
    sort_key: (usize, usize, String),
    // Not serialized: whether the matched rule carries a fix, so the summary's
    // `fixable` count is the same with and without `--fix`.
    #[serde(skip)]
    rule_fixable: bool,
}

#[derive(Serialize)]
struct SummaryBody {
    files: usize,
    matches: usize,
    fixable: usize,
    errors: Vec<String>,
}

#[derive(Serialize)]
struct SummaryLine {
    summary: SummaryBody,
}

#[derive(Serialize)]
struct LangJson {
    id: &'static str,
    extensions: &'static [&'static str],
    scan: bool,
    extract: bool,
    /// `Stage-2 kind → unified kind` for this language (`outline::KIND_MAP`).
    /// The symbol `kind` vocabulary changed in Stage 3-C, and this is the
    /// declared mapping a parity run checks every changed kind against.
    /// Omitted for a language that reports no symbols.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    kinds: BTreeMap<&'static str, &'static str>,
    /// Outline rules of this language that parsed but cannot run. Omitted when
    /// empty, which is the healthy build.
    #[serde(rename = "ruleErrors", skip_serializing_if = "Vec::is_empty")]
    rule_errors: Vec<String>,
}

#[derive(Serialize)]
struct LangsLine {
    languages: Vec<LangJson>,
    /// Wire format of the FileRecord `calls` array (see `calls::CALLS_FORMAT`).
    /// v2 is the positional tuple `[name, line, col, kind, recv, inSymbol]`;
    /// the consumer reads this instead of sniffing the shape.
    #[serde(rename = "callsFormat")]
    calls_format: u8,
    /// Rule-load problems that belong to no single language (broken or
    /// multi-rule YAML documents). Omitted when empty.
    #[serde(rename = "ruleErrors", skip_serializing_if = "Vec::is_empty")]
    rule_errors: Vec<String>,
}

/// A file selected for scanning.
pub struct ScanFile {
    pub path: PathBuf,
    /// repo-relative, forward slashes
    pub rel: String,
    pub lang: ScanLang,
}

/// Parsed rules plus the language set they cover. `globals` must outlive the
/// collection: rule references into the global registry are weak pointers.
pub struct Rules {
    collection: RuleCollection<ScanLang>,
    langs: HashSet<ScanLang>,
    #[allow(dead_code)]
    globals: GlobalRules,
}

impl Rules {
    pub fn is_empty(&self) -> bool {
        self.langs.is_empty()
    }
}

/// Flatten a thiserror chain — the top-level message alone ("Fail to parse
/// yaml as RuleConfig") never says which rule or field is wrong.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        message.push_str(": ");
        message.push_str(&inner.to_string());
        source = inner.source();
    }
    message
}

/// Parse multi-document ast-grep rule YAML. Rules with `severity: off` are
/// dropped by the collection, exactly like `sg scan`.
pub fn parse_rules(yaml: &str) -> Result<Rules, String> {
    let globals = GlobalRules::default();
    let configs = from_yaml_string::<ScanLang>(yaml, &globals)
        .map_err(|err| format!("rule parse failed: {}", error_chain(&err)))?;
    let mut langs = HashSet::new();
    for config in &configs {
        if !matches!(config.severity, Severity::Off) {
            langs.insert(config.language);
        }
    }
    let collection = RuleCollection::try_new(configs)
        .map_err(|err| format!("rule file/ignores glob is invalid: {err}"))?;
    Ok(Rules {
        collection,
        langs,
        globals,
    })
}

fn severity_str(severity: &Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
        Severity::Hint => "hint",
        // Off rules are filtered out before scanning; map defensively.
        Severity::Off => "off",
    }
}

fn record_for(
    rel: &str,
    lang: ScanLang,
    rule: &RuleConfig<ScanLang>,
    node_match: &NodeMatch<'_, StrDoc<ScanLang>>,
    include_fix: bool,
) -> MatchRecord {
    let node = node_match.get_node();
    let range = node_match.range();
    let start = node_match.start_pos();
    let end = node_match.end_pos();
    let fix = if include_fix {
        Some(rule.fixer.first().map(|fixer| {
            let edit = node_match.make_edit(&rule.matcher, fixer);
            FixJson {
                byte_offset: [edit.position, edit.position + edit.deleted_length],
                text: String::from_utf8_lossy(&edit.inserted_text).into_owned(),
            }
        }))
    } else {
        None
    };
    MatchRecord {
        file: rel.to_string(),
        lang: lang.id(),
        rule_id: rule.id.clone(),
        severity: severity_str(&rule.severity),
        message: rule.get_message(node_match),
        range: RangeJson {
            start: PositionJson {
                line: start.line(),
                column: start.column(node),
            },
            end: PositionJson {
                line: end.line(),
                column: end.column(node),
            },
            byte_offset: [range.start, range.end],
        },
        fix,
        sort_key: (range.start, range.end, rule.id.clone()),
        rule_fixable: !rule.fixer.is_empty(),
    }
}

/// Scan one in-memory source. Returns matches in source order; `Err` carries a
/// parse failure for this file only (the scan itself keeps going).
pub fn scan_source(
    rel: &str,
    lang: ScanLang,
    source: &str,
    rules: &Rules,
    include_fix: bool,
) -> Result<Vec<MatchRecord>, String> {
    let applicable = rules.collection.get_rule_from_lang(Path::new(rel), lang);
    if applicable.is_empty() {
        return Ok(Vec::new());
    }
    let root = AstGrep::<StrDoc<ScanLang>>::try_new(source, lang)
        .map_err(|err| format!("parse failed: {err}"))?;
    let combined = CombinedScan::new(applicable);
    // `separate_fix` only routes fixable rules into `diffs`; the match set is
    // the same either way, and both lists are merged below.
    let result = combined.scan(&root, true);
    let mut records = Vec::new();
    for (rule, node_match) in &result.diffs {
        records.push(record_for(rel, lang, rule, node_match, include_fix));
    }
    for (rule, node_matches) in &result.matches {
        for node_match in node_matches {
            records.push(record_for(rel, lang, rule, node_match, include_fix));
        }
    }
    records.sort_by(|a, b| a.sort_key.cmp(&b.sort_key));
    Ok(records)
}

/// Walk `root` with the same ignore semantics as the extraction walk
/// (`collect_source_files`): standard ignore filters on, hidden files kept,
/// files over 2MB skipped, results sorted by path. The language classifier is
/// the scan registry (31 languages) instead of the extraction one.
pub fn collect_scan_files(root: &Path) -> Result<Vec<ScanFile>, String> {
    let mut candidates: Vec<(PathBuf, ScanLang)> = Vec::new();
    for entry in WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(false)
        .build()
    {
        let dir_entry =
            entry.map_err(|err| format!("walk failed under {}: {err}", root.display()))?;
        if !dir_entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let path = dir_entry.path();
        let Some(lang) = scan_lang_for_path(path) else {
            continue;
        };
        candidates.push((path.to_path_buf(), lang));
    }
    let results: Vec<Result<Option<ScanFile>, String>> = candidates
        .par_iter()
        .map(|(path, lang)| {
            let meta = fs::metadata(path)
                .map_err(|err| format!("metadata failed for {}: {err}", path.display()))?;
            if meta.len() > MAX_FILE_BYTES {
                return Ok(None);
            }
            Ok(Some(ScanFile {
                path: path.clone(),
                rel: rel_path(root, path)?,
                lang: *lang,
            }))
        })
        .collect();
    let mut files = Vec::with_capacity(results.len());
    for result in results {
        if let Some(file) = result? {
            files.push(file);
        }
    }
    files.par_sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn rel_path(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|err| format!("path is outside scan root ({}): {err}", path.display()))?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// Lexically resolve `.` / `..` in a repo-relative selection. `None` means the
/// path is not a file under the scan root: it climbs above the root, or it
/// carries a root/drive component (an absolute path in disguise).
fn normalize_relative_selection(candidate: &Path) -> Option<Vec<String>> {
    use std::path::Component;
    let mut parts: Vec<String> = Vec::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` with nothing to pop escapes the scan root.
                parts.pop()?;
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

/// Lexically resolve `.` / `..` in an absolute selection, so a path like
/// `<root>/../secrets.ts` cannot slip past the `strip_prefix` root check.
fn normalize_absolute_selection(candidate: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Popping past the drive/root escapes the filesystem root.
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Explicit `--files` selection: repo-relative (or absolute) paths, keeping
/// only those with a scan language. Unsupported extensions are skipped, and
/// so are files over the same 2MB cap the walk and `parse_file` apply, so a
/// caller-supplied path can never pull an unbounded file into memory.
/// A path that resolves outside the scan root is rejected outright — the scan
/// is confined to `cwd` exactly like every other mode.
pub(crate) fn selected_scan_files(root: &Path, files: &[String]) -> Result<Vec<ScanFile>, String> {
    let mut selected = Vec::new();
    for raw in files {
        let candidate = Path::new(raw);
        let (path, rel) = if candidate.is_absolute() {
            let normalized = normalize_absolute_selection(candidate).ok_or_else(|| {
                format!("path is outside scan root ({}): escapes the filesystem root", raw)
            })?;
            let rel = rel_path(root, &normalized)?;
            (normalized, rel)
        } else {
            let parts = normalize_relative_selection(candidate).ok_or_else(|| {
                format!("path is outside scan root ({}): not a file under the root", raw)
            })?;
            let mut path = root.to_path_buf();
            for part in &parts {
                path.push(part);
            }
            (path, parts.join("/"))
        };
        let Some(lang) = scan_lang_for_path(&path) else {
            continue;
        };
        // Missing/unreadable metadata is NOT fatal here: the file stays in the
        // list so the read failure lands in `summary.errors` (exit 0).
        if fs::metadata(&path)
            .map(|meta| meta.len() > MAX_FILE_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        selected.push(ScanFile { path, rel, lang });
    }
    // Same emission order as the walk (by path), and one scan per file even if
    // the caller listed it twice — duplicate match records would otherwise ask
    // the fix pipeline to apply the same edit twice.
    selected.sort_by(|a, b| a.path.cmp(&b.path));
    selected.dedup_by(|a, b| a.path == b.path);
    Ok(selected)
}

struct FileOutcome {
    scanned: bool,
    records: Vec<MatchRecord>,
    error: Option<String>,
}

fn scan_file(file: &ScanFile, rules: &Rules, include_fix: bool) -> FileOutcome {
    // Skip before any I/O when no rule targets this language at all.
    if !rules.langs.contains(&file.lang) {
        return FileOutcome {
            scanned: false,
            records: Vec::new(),
            error: None,
        };
    }
    if rules
        .collection
        .get_rule_from_lang(Path::new(&file.rel), file.lang)
        .is_empty()
    {
        return FileOutcome {
            scanned: false,
            records: Vec::new(),
            error: None,
        };
    }
    let source = match fs::read_to_string(&file.path) {
        Ok(text) => text,
        Err(err) => {
            return FileOutcome {
                scanned: false,
                records: Vec::new(),
                error: Some(format!("{}: read failed: {err}", file.rel)),
            }
        }
    };
    match scan_source(&file.rel, file.lang, &source, rules, include_fix) {
        Ok(records) => FileOutcome {
            scanned: true,
            records,
            error: None,
        },
        Err(err) => FileOutcome {
            scanned: false,
            records: Vec::new(),
            error: Some(format!("{}: {err}", file.rel)),
        },
    }
}

fn emit(records: &[MatchRecord], summary: SummaryLine) -> Result<(), String> {
    let stdout = std::io::stdout();
    let mut handle = std::io::BufWriter::new(stdout.lock());
    for (index, record) in records.iter().enumerate() {
        let line = serde_json::to_string(record)
            .map_err(|err| format!("serialize failed for match {index}: {err}"))?;
        writeln!(handle, "{line}")
            .map_err(|err| format!("stdout write failed for match {index}: {err}"))?;
    }
    let line = serde_json::to_string(&summary)
        .map_err(|err| format!("serialize failed for summary: {err}"))?;
    writeln!(handle, "{line}").map_err(|err| format!("stdout write failed for summary: {err}"))?;
    handle
        .flush()
        .map_err(|err| format!("stdout flush failed: {err}"))
}

struct ScanArgs {
    rules: String,
    files: Vec<String>,
    fix: bool,
}

const USAGE: &str =
    "usage: mixdog-graph <cwd> --scan --rules <path|-> [--files <rel>...] [--fix]";

fn parse_args(args: &[String]) -> Result<ScanArgs, String> {
    let mut rules: Option<String> = None;
    let mut files = Vec::new();
    let mut fix = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--rules" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return Err(format!("--rules needs a path or `-`\n{USAGE}"));
                };
                rules = Some(value.clone());
                index += 1;
            }
            "--fix" => {
                fix = true;
                index += 1;
            }
            "--files" => {
                index += 1;
                while let Some(value) = args.get(index) {
                    if value.starts_with("--") {
                        break;
                    }
                    files.push(value.clone());
                    index += 1;
                }
            }
            other => return Err(format!("unknown scan argument `{other}`\n{USAGE}")),
        }
    }
    let Some(rules) = rules else {
        return Err(format!("--rules is required\n{USAGE}"));
    };
    Ok(ScanArgs { rules, files, fix })
}

pub(crate) fn read_rule_text(spec: &str) -> Result<String, String> {
    let text = if spec == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|err| format!("rule stdin read failed: {err}"))?;
        buf
    } else {
        fs::read_to_string(spec).map_err(|err| format!("rule file read failed ({spec}): {err}"))?
    };
    // Windows editors and PowerShell pipes prefix a UTF-8 BOM; YAML keeps it
    // as part of the first key, which would fail every rule with a confusing
    // "missing field `language`". Source files are NOT stripped — their byte
    // offsets must stay true to the bytes on disk.
    Ok(strip_bom(text))
}

fn strip_bom(text: String) -> String {
    match text.strip_prefix('\u{feff}') {
        Some(stripped) => stripped.to_string(),
        None => text,
    }
}

/// `--scan` entry point. Never writes files.
pub fn run(root: &Path, args: &[String]) -> Result<(), ScanError> {
    let args = parse_args(args).map_err(ScanError::Usage)?;
    let rule_text = read_rule_text(&args.rules).map_err(ScanError::Usage)?;
    let rules = parse_rules(&rule_text).map_err(ScanError::Usage)?;
    let files = if args.files.is_empty() {
        collect_scan_files(root).map_err(ScanError::Internal)?
    } else {
        selected_scan_files(root, &args.files).map_err(ScanError::Internal)?
    };
    let outcomes: Vec<FileOutcome> = if rules.is_empty() {
        Vec::new()
    } else {
        files
            .par_iter()
            .map(|file| scan_file(file, &rules, args.fix))
            .collect()
    };
    let mut records = Vec::new();
    let mut errors = Vec::new();
    let mut scanned = 0usize;
    for outcome in outcomes {
        if outcome.scanned {
            scanned += 1;
        }
        if let Some(error) = outcome.error {
            errors.push(error);
        }
        records.extend(outcome.records);
    }
    // Rule-driven, so the count is identical with and without `--fix`.
    let fixable = records.iter().filter(|record| record.rule_fixable).count();
    let summary = SummaryLine {
        summary: SummaryBody {
            files: scanned,
            matches: records.len(),
            fixable,
            errors,
        },
    };
    emit(&records, summary).map_err(ScanError::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Scan an in-memory fixture the same way `run` scans a file on disk.
    fn scan_fixture(rel: &str, source: &str, yaml: &str, include_fix: bool) -> Vec<MatchRecord> {
        let rules = parse_rules(yaml).expect("rules should parse");
        let lang = scan_lang_for_path(Path::new(rel)).expect("fixture has a scan language");
        scan_source(rel, lang, source, &rules, include_fix).expect("scan should succeed")
    }

    fn rule_yaml(id: &str, language: &str, rule: &str) -> String {
        format!("id: {id}\nlanguage: {language}\nseverity: warning\nmessage: hit\nrule:\n  {rule}\n")
    }

    // One match, and its byte offsets must slice exactly the matched text out
    // of the original source — the property every downstream rewrite needs.
    fn assert_single_match(rel: &str, source: &str, language: &str, rule: &str, expected: &str) {
        let yaml = rule_yaml("single", language, rule);
        let records = scan_fixture(rel, source, &yaml, false);
        assert_eq!(records.len(), 1, "{language}: expected exactly one match");
        let record = &records[0];
        assert_eq!(record.lang, expected_lang_id(rel), "{language}: lang id");
        assert_eq!(record.rule_id, "single");
        assert_eq!(record.severity, "warning");
        let [start, end] = record.range.byte_offset;
        assert_eq!(&source[start..end], expected, "{language}: byte offsets");
        assert!(record.fix.is_none(), "{language}: no fix without --fix");
    }

    fn expected_lang_id(rel: &str) -> &'static str {
        scan_lang_for_path(Path::new(rel))
            .expect("fixture has a scan language")
            .id()
    }

    #[test]
    fn pattern_rules_match_across_languages() {
        // pattern rules, one per language family
        assert_single_match(
            "a.ts",
            "const a: number = foo(1);\n",
            "typescript",
            "pattern: foo($A)",
            "foo(1)",
        );
        assert_single_match(
            "a.js",
            "console.log('hi');\n",
            "javascript",
            "pattern: console.log($A)",
            "console.log('hi')",
        );
        assert_single_match(
            "a.py",
            "value = 1\nprint(value)\n",
            "python",
            "pattern: print($A)",
            "print(value)",
        );
        assert_single_match(
            "a.rs",
            "fn main() {\n    let x = foo(1);\n}\n",
            "rust",
            "pattern: foo($A)",
            "foo(1)",
        );
        assert_single_match(
            "a.go",
            "package main\n\nfunc main() {\n\tfoo(1)\n}\n",
            "go",
            "pattern: foo($A)",
            "foo(1)",
        );
        // C parses a bare `foo($A)` as a declaration, so the call pattern
        // needs statement context — the match is then the statement.
        assert_single_match(
            "a.c",
            "int main(void) {\n  foo(1);\n  return 0;\n}\n",
            "c",
            "pattern: foo($A);",
            "foo(1);",
        );
        assert_single_match(
            "a.cpp",
            "int main() {\n  bar(2);\n  return 0;\n}\n",
            "cpp",
            "pattern: bar($A)",
            "bar(2)",
        );
        // Objective-C shares C's declaration ambiguity, hence the `;`.
        assert_single_match(
            "a.m",
            "@implementation Thing\n- (void)run {\n  NSLog(@\"x\");\n}\n@end\n",
            "objc",
            "pattern: NSLog($A);",
            "NSLog(@\"x\");",
        );
        assert_single_match(
            "a.zig",
            "pub fn main() void {\n    foo(1);\n}\n",
            "zig",
            "pattern: foo($A)",
            "foo(1)",
        );
        assert_single_match(
            "a.r",
            "x <- foo(1)\n",
            "r",
            "pattern: foo($A)",
            "foo(1)",
        );
    }

    #[test]
    fn kind_rules_match_non_programming_languages() {
        assert_single_match(
            "a.css",
            "a {\n  color: red;\n}\n",
            "css",
            "kind: declaration",
            "color: red;",
        );
        assert_single_match(
            "a.yaml",
            "name: mixdog\n",
            "yaml",
            "kind: block_mapping_pair",
            "name: mixdog",
        );
        assert_single_match(
            "a.md",
            "# Title\n\ntext\n",
            "markdown",
            "kind: atx_heading",
            "# Title\n",
        );
    }

    #[test]
    fn kind_rule_matches_typescript_node() {
        assert_single_match(
            "a.ts",
            "class A {}\n",
            "typescript",
            "kind: class_declaration",
            "class A {}",
        );
    }

    #[test]
    fn fix_is_computed_only_with_fix_flag() {
        let source = "const a = foo(1);\n";
        let yaml = "id: rewrite-foo\nlanguage: typescript\nseverity: error\nmessage: use bar\nrule:\n  pattern: foo($A)\nfix: bar($A)\n";

        let without = scan_fixture("a.ts", source, yaml, false);
        assert_eq!(without.len(), 1);
        assert!(without[0].fix.is_none());
        assert!(without[0].rule_fixable, "rule carries a fix");

        let with = scan_fixture("a.ts", source, yaml, true);
        assert_eq!(with.len(), 1);
        let fix = with[0]
            .fix
            .as_ref()
            .expect("fix key present with --fix")
            .as_ref()
            .expect("rule has a fix");
        let [start, end] = fix.byte_offset;
        assert_eq!(&source[start..end], "foo(1)");
        assert_eq!(fix.text, "bar(1)");
        assert_eq!(with[0].severity, "error");
    }

    #[test]
    fn fix_is_null_when_rule_has_no_fix() {
        let records = scan_fixture(
            "a.py",
            "print(1)\n",
            &rule_yaml("no-print", "python", "pattern: print($A)"),
            true,
        );
        assert_eq!(records.len(), 1);
        let value = serde_json::to_value(&records[0]).expect("serializes");
        assert_eq!(value["fix"], json!(null));
        assert!(!records[0].rule_fixable);
    }

    #[test]
    fn python_fix_replaces_expected_bytes() {
        let source = "print('a')\nprint('b')\n";
        let yaml = "id: py-fix\nlanguage: python\nseverity: info\nmessage: log instead\nrule:\n  pattern: print($A)\nfix: log($A)\n";
        let records = scan_fixture("a.py", source, yaml, true);
        assert_eq!(records.len(), 2);
        for (record, expected) in records.iter().zip(["log('a')", "log('b')"]) {
            let fix = record.fix.as_ref().unwrap().as_ref().unwrap();
            let [start, end] = fix.byte_offset;
            assert_eq!(&source[start..end], record_text(source, record));
            assert_eq!(fix.text, expected);
        }
        // emitted in source order
        assert!(records[0].range.byte_offset[0] < records[1].range.byte_offset[0]);
    }

    fn record_text<'a>(source: &'a str, record: &MatchRecord) -> &'a str {
        &source[record.range.byte_offset[0]..record.range.byte_offset[1]]
    }

    #[test]
    fn match_json_matches_the_documented_protocol() {
        let source = "const a = foo(1);\n";
        let yaml = "id: rewrite-foo\nlanguage: typescript\nseverity: warning\nmessage: found $A\nrule:\n  pattern: foo($A)\nfix: bar($A)\n";
        let records = scan_fixture("src/a.ts", source, yaml, true);
        let value = serde_json::to_value(&records[0]).expect("serializes");
        assert_eq!(
            value,
            json!({
                "file": "src/a.ts",
                "lang": "typescript",
                "ruleId": "rewrite-foo",
                "severity": "warning",
                "message": "found 1",
                "range": {
                    "start": {"line": 0, "column": 10},
                    "end": {"line": 0, "column": 16},
                    "byteOffset": [10, 16]
                },
                "fix": {"byteOffset": [10, 16], "text": "bar(1)"}
            })
        );
    }

    #[test]
    fn positions_are_zero_based_rows_and_char_columns() {
        // second line, and a multi-byte prefix so column is chars, not bytes
        let source = "// ★★\nlet x = foo(1);\n";
        let records = scan_fixture(
            "a.ts",
            source,
            &rule_yaml("pos", "typescript", "pattern: foo($A)"),
            false,
        );
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].range.start.line, 1);
        assert_eq!(records[0].range.start.column, 8);
        assert_eq!(records[0].range.end.line, 1);
        assert_eq!(records[0].range.end.column, 14);
        assert_eq!(record_text(source, &records[0]), "foo(1)");
    }

    #[test]
    fn multi_document_rules_all_run() {
        let yaml = "id: one\nlanguage: typescript\nseverity: warning\nmessage: one\nrule:\n  pattern: foo($A)\n---\nid: two\nlanguage: typescript\nseverity: hint\nmessage: two\nrule:\n  pattern: bar($A)\n";
        let records = scan_fixture("a.ts", "foo(1);\nbar(2);\n", yaml, false);
        let ids: Vec<&str> = records.iter().map(|r| r.rule_id.as_str()).collect();
        assert_eq!(ids, vec!["one", "two"]);
        assert_eq!(records[1].severity, "hint");
    }

    #[test]
    fn severity_off_rules_are_skipped() {
        let yaml = "id: off-rule\nlanguage: typescript\nseverity: off\nmessage: nope\nrule:\n  pattern: foo($A)\n";
        let records = scan_fixture("a.ts", "foo(1);\n", yaml, false);
        assert!(records.is_empty());
        assert!(parse_rules(yaml).expect("parses").is_empty());
    }

    #[test]
    fn file_globs_restrict_rules() {
        let yaml = "id: only-src\nlanguage: typescript\nseverity: warning\nmessage: hit\nrule:\n  pattern: foo($A)\nfiles:\n  - 'src/**'\n";
        assert_eq!(scan_fixture("src/a.ts", "foo(1);\n", yaml, false).len(), 1);
        assert!(scan_fixture("test/a.ts", "foo(1);\n", yaml, false).is_empty());
    }

    #[test]
    fn constraints_and_transform_are_supported() {
        let yaml = concat!(
            "id: constrained\n",
            "language: typescript\n",
            "severity: info\n",
            "message: $UP\n",
            "rule:\n",
            "  pattern: foo($A)\n",
            "constraints:\n",
            "  A:\n",
            "    regex: '^1$'\n",
            "transform:\n",
            "  UP:\n",
            "    replace:\n",
            "      source: $A\n",
            "      replace: '1'\n",
            "      by: one\n",
        );
        let records = scan_fixture("a.ts", "foo(1);\nfoo(2);\n", yaml, false);
        assert_eq!(records.len(), 1);
        assert_eq!(record_text("foo(1);\nfoo(2);\n", &records[0]), "foo(1)");
        assert_eq!(records[0].message, "one");
    }

    #[test]
    fn rule_text_with_a_utf8_bom_still_parses() {
        let yaml = format!(
            "\u{feff}{}",
            rule_yaml("bom", "typescript", "pattern: foo($A)")
        );
        let rules = parse_rules(&strip_bom(yaml)).expect("BOM-prefixed rules parse");
        let records = scan_source(
            "a.ts",
            scan_lang_for_path(Path::new("a.ts")).expect("lang"),
            "foo(1);\n",
            &rules,
            false,
        )
        .expect("scan");
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn unsupported_language_is_a_rule_parse_error() {
        let yaml = "id: bad\nlanguage: cobol\nseverity: warning\nmessage: hit\nrule:\n  pattern: foo($A)\n";
        let Err(error) = parse_rules(yaml) else {
            panic!("unsupported language must fail");
        };
        assert!(error.contains("cobol"), "{error}");
    }

    #[test]
    fn broken_source_reports_no_match_not_a_crash() {
        // Tree-sitter always produces a tree (with ERROR nodes); the scan must
        // simply not match, never panic.
        let records = scan_fixture(
            "a.ts",
            "const = = = ;;;\n",
            &rule_yaml("broken", "typescript", "pattern: foo($A)"),
            false,
        );
        assert!(records.is_empty());
    }

    #[test]
    fn collect_scan_files_walks_like_the_extraction_walk() {
        let dir = std::env::temp_dir().join(format!(
            "mixdog-scan-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("sub")).expect("temp dir");
        fs::write(dir.join("a.ts"), "foo(1);\n").expect("write ts");
        fs::write(dir.join("notes.txt"), "ignored\n").expect("write txt");
        fs::write(dir.join("sub").join("b.py"), "print(1)\n").expect("write py");
        fs::write(dir.join("big.ts"), "x".repeat(3 * 1024 * 1024)).expect("write big");

        let files = collect_scan_files(&dir).expect("walk");
        let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["a.ts", "sub/b.py"]);
        assert_eq!(files[0].lang.id(), "typescript");
        assert_eq!(files[1].lang.id(), "python");

        let selected = selected_scan_files(&dir, &["sub/b.py".into(), "notes.txt".into()])
            .expect("selection");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].rel, "sub/b.py");

        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn selected_files_stay_inside_the_root_and_respect_the_size_cap() {
        let base = std::env::temp_dir().join(format!(
            "mixdog-scan-select-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let root = base.join("repo");
        fs::create_dir_all(root.join("src")).expect("temp dir");
        fs::write(base.join("outside.ts"), "foo(9);\n").expect("write outside");
        fs::write(root.join("src").join("a.ts"), "foo(1);\n").expect("write a");
        fs::write(root.join("src").join("b.ts"), "foo(2);\n").expect("write b");
        fs::write(root.join("huge.ts"), "x".repeat(3 * 1024 * 1024)).expect("write huge");

        // Every route out of the root is refused, relative or absolute.
        for escape in [
            "../outside.ts".to_string(),
            "src/../../outside.ts".to_string(),
            base.join("outside.ts").to_string_lossy().into_owned(),
            root.join("..")
                .join("outside.ts")
                .to_string_lossy()
                .into_owned(),
        ] {
            let selection = selected_scan_files(&root, std::slice::from_ref(&escape));
            assert!(selection.is_err(), "{escape} must be rejected");
        }

        // Oversize files are dropped exactly like the walk drops them.
        assert!(selected_scan_files(&root, &["huge.ts".into()])
            .expect("selection")
            .is_empty());

        // Sorted by path and scanned once even when listed twice.
        let selected = selected_scan_files(
            &root,
            &[
                "src/b.ts".into(),
                "./src/a.ts".into(),
                "src/a.ts".into(),
                "src/nested/../a.ts".into(),
            ],
        )
        .expect("selection");
        let rels: Vec<&str> = selected.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["src/a.ts", "src/b.ts"]);

        fs::remove_dir_all(&base).expect("cleanup");
    }

    #[test]
    fn summary_counts_scanned_files_and_fixables() {
        let yaml = "id: fixable\nlanguage: typescript\nseverity: warning\nmessage: hit\nrule:\n  pattern: foo($A)\nfix: bar($A)\n";
        let rules = parse_rules(yaml).expect("rules");
        let dir = std::env::temp_dir().join(format!(
            "mixdog-scan-summary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(dir.join("a.ts"), "foo(1);\nfoo(2);\n").expect("write ts");
        // python file: no rule targets it, so it is never read or counted
        fs::write(dir.join("b.py"), "print(1)\n").expect("write py");
        let files = collect_scan_files(&dir).expect("walk");
        let outcomes: Vec<FileOutcome> = files
            .iter()
            .map(|file| scan_file(file, &rules, true))
            .collect();
        let scanned = outcomes.iter().filter(|o| o.scanned).count();
        let records: Vec<&MatchRecord> = outcomes.iter().flat_map(|o| o.records.iter()).collect();
        assert_eq!(scanned, 1);
        assert_eq!(records.len(), 2);
        assert_eq!(records.iter().filter(|r| r.rule_fixable).count(), 2);
        assert!(outcomes.iter().all(|o| o.error.is_none()));
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}

/// `--langs` entry point: one JSON line describing the merged registry.
pub fn run_langs() -> Result<(), String> {
    let languages = LANG_INFOS
        .iter()
        .map(|info| LangJson {
            id: info.id,
            extensions: info.extensions,
            scan: info.scan,
            extract: info.extract(),
            kinds: crate::outline::kind_map_for(info.id),
            rule_errors: crate::outline::language_rule_errors(info.id),
        })
        .collect();
    let line = serde_json::to_string(&LangsLine {
        languages,
        calls_format: crate::calls::CALLS_FORMAT,
        rule_errors: crate::outline::rule_errors().to_vec(),
    })
        .map_err(|err| format!("serialize failed for languages: {err}"))?;
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{line}").map_err(|err| format!("stdout write failed: {err}"))
}
