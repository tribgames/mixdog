// mixdog-graph — native fast-path for code-graph build.
//
// Walk a project root, identify source files by extension, read each file,
// and extract per-language metadata from ONE ast-grep parse per file:
//   - identifier tokens (grammar identifier nodes; see `tokens.rs`)
//   - raw imports + symbols + call sites (outline/call rules)
//   - package / namespace names (Java/Kotlin/C#) and the Go package, from
//     their declaration nodes
//   - top-level type names (Java/Kotlin/C#/Go) — the one regex survivor,
//     see `mixdog_graph::resolve::extract_top_level_types`
//
// Output (JSONL on stdout, one object per file):
//   {"rel": "...", "lang": "...", "fp": "...", "size": N,
//    "tokens": [...], "rawImports": [...], "packageName": "...",
//    "namespaceName": "...", "goPackageName": "...",
//    "topLevelTypes": [...]}
//
// Files above the documented size cap are intentionally omitted. Every I/O,
// protocol and serialization failure is fatal so callers never cache a graph
// that only looks complete. There is no JS parse fallback.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process;

use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use mixdog_graph::calls::CallInfo;
use mixdog_graph::lang::{lang_for, lang_static};
use mixdog_graph::outline::{self, SymbolInfo};
use mixdog_graph::resolve::{ImportRecord, extract_top_level_types, resolve_and_link};
use mixdog_graph::scan;
use mixdog_graph::scan_lang::scan_lang_for_path;
use mixdog_graph::serve_search;
use mixdog_graph::{walk_classified_files, write_jsonl};

// Mirrors CODE_GRAPH_MAX_FILES on the Node side. --walk caps parse work
// here so large repos don't pay full parse cost before truncation.
const MAX_FILES: usize = 10_000;

use mixdog_graph::MAX_FILE_BYTES;

// Task Manager groups rows by AppUserModelID, so claiming the desktop app's
// (`appId` in electron-builder.yml) folds this helper into the Mixdog group.
// Cosmetic and best-effort: a failing call is ignored.
#[cfg(windows)]
fn adopt_desktop_app_identity() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let app_id: Vec<u16> = "io.mixdog.desktop\0".encode_utf16().collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}

#[derive(Serialize)]
struct FileRecord {
    rel: String,
    lang: &'static str,
    fp: String,
    size: u64,
    #[serde(rename = "parseError", skip_serializing_if = "String::is_empty")]
    parse_error: String,
    tokens: Vec<String>,
    #[serde(rename = "rawImports", skip_serializing_if = "Vec::is_empty")]
    raw_imports: Vec<String>,
    #[serde(rename = "packageName", skip_serializing_if = "String::is_empty")]
    package_name: String,
    #[serde(rename = "namespaceName", skip_serializing_if = "String::is_empty")]
    namespace_name: String,
    #[serde(rename = "goPackageName", skip_serializing_if = "String::is_empty")]
    go_package_name: String,
    #[serde(rename = "topLevelTypes", skip_serializing_if = "Vec::is_empty")]
    top_level_types: Vec<String>,
    #[serde(rename = "resolvedImports", skip_serializing_if = "Vec::is_empty")]
    resolved_imports: Vec<String>,
    #[serde(rename = "importedBy", skip_serializing_if = "Vec::is_empty")]
    imported_by: Vec<String>,
    #[serde(rename = "symbols", skip_serializing_if = "Vec::is_empty")]
    symbols: Vec<SymbolInfo>,
    // Call sites from the same outline walk (Stage 3-A). Additive, and
    // TRI-STATE: `[]` is a KNOWN-EMPTY answer (an extraction language parsed
    // this file and it has no call sites), while an omitted key means no call
    // extraction ran for this record at all — a manifest/reused record, a
    // file that failed to decode, or a language with no rules. The consumer
    // falls back to its text heuristic only on the omitted case, so an empty
    // parse result must NOT be omitted.
    #[serde(rename = "calls", skip_serializing_if = "Option::is_none")]
    calls: Option<Vec<CallInfo>>,
}

impl ImportRecord for FileRecord {
    fn rel(&self) -> &str {
        &self.rel
    }

    fn lang(&self) -> &str {
        self.lang
    }

    fn raw_imports(&self) -> &[String] {
        &self.raw_imports
    }

    fn package_name(&self) -> &str {
        &self.package_name
    }

    fn namespace_name(&self) -> &str {
        &self.namespace_name
    }

    fn top_level_types(&self) -> &[String] {
        &self.top_level_types
    }

    fn set_edges(&mut self, resolved_imports: Vec<String>, imported_by: Vec<String>) {
        self.resolved_imports = resolved_imports;
        self.imported_by = imported_by;
    }
}

// Reused-node meta arriving on stdin for --files full-graph resolution.
// One JSON object per line. JS sends the metadata it already cached for
// every node it is REUSING (not re-parsing), so the native side can build
// a complete GraphIndex and resolve reused nodes' imports too. Missing
// fields default to empty so partial metas never panic.
#[derive(Deserialize)]
struct ReusedMeta {
    #[serde(default)]
    rel: String,
    #[serde(default)]
    lang: String,
    #[serde(default, rename = "parseError")]
    parse_error: String,
    #[serde(default, rename = "rawImports")]
    raw_imports: Vec<String>,
    #[serde(default, rename = "packageName")]
    package_name: String,
    #[serde(default, rename = "namespaceName")]
    namespace_name: String,
    #[serde(default, rename = "goPackageName")]
    go_package_name: String,
    #[serde(default, rename = "topLevelTypes")]
    top_level_types: Vec<String>,
}

fn record_from_reused(meta: ReusedMeta) -> FileRecord {
    FileRecord {
        rel: meta.rel,
        lang: lang_static(&meta.lang),
        fp: String::new(),
        size: 0,
        parse_error: meta.parse_error,
        tokens: Vec::new(),
        raw_imports: meta.raw_imports,
        package_name: meta.package_name,
        namespace_name: meta.namespace_name,
        go_package_name: meta.go_package_name,
        top_level_types: meta.top_level_types,
        resolved_imports: Vec::new(),
        imported_by: Vec::new(),
        symbols: Vec::new(),
        calls: None,
    }
}

fn fingerprint_for(rel: &str, size: u64, mtime_ms: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rel.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(size.to_le_bytes());
    hasher.update(b"\x1f");
    hasher.update(mtime_ms.to_le_bytes());
    let bytes = hasher.finalize();
    hex::encode(&bytes[..8])
}

#[derive(Serialize)]
struct SearchHit {
    rel: String,
    line: u32,
    col: u32,
    text: String,
}

fn search_file(path: &Path, root: &Path, symbol: &str) -> Result<Vec<SearchHit>, String> {
    let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
        return Ok(Vec::new());
    };
    if lang_for(ext).is_none() {
        return Ok(Vec::new());
    }
    let Some(scan_lang) = scan_lang_for_path(path) else {
        return Ok(Vec::new());
    };
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(Vec::new());
    };
    let rel = relative.to_string_lossy().replace('\\', "/");
    let meta = fs::metadata(path).map_err(|err| format!("metadata failed for {}: {err}", path.display()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|err| format!("read failed for {}: {err}", path.display()))?;
    // Undecodable text is an unsupported encoding, not an I/O failure: the
    // graph build indexes such files with no content either.
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(Vec::new());
    };
    if !text.contains(symbol) {
        return Ok(Vec::new());
    }
    let lines: Vec<&str> = text.lines().collect();
    let mut hits: Vec<SearchHit> = outline::identifier_hits(&text, scan_lang, symbol)
        .into_iter()
        .map(|(line, col)| {
            let display = lines.get(line as usize - 1).map(|s| s.trim()).unwrap_or("");
            SearchHit { rel: rel.clone(), line, col, text: display.chars().take(80).collect() }
        })
        .collect();
    hits.sort_by_key(|hit| (hit.line, hit.col));
    Ok(hits)
}

fn search_hits(root: &Path, symbol: &str) -> Result<Vec<SearchHit>, String> {
    let mut entries: Vec<_> = WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(false)
        .build()
        .filter_map(Result::ok)
        .filter(|d| d.file_type().map(|t| t.is_file()).unwrap_or(false))
        .collect();
    entries.sort_by(|a, b| a.path().cmp(b.path()));
    let per_file: Vec<Vec<SearchHit>> = entries.par_iter().map(|entry| search_file(entry.path(), root, symbol)).collect::<Result<_, _>>()?;
    Ok(per_file.into_iter().flatten().collect())
}

fn run_search(root: &Path, symbol: &str) -> Result<(), String> {
    if symbol.is_empty() {
        return Ok(());
    }
    write_jsonl(&search_hits(root, symbol)?, "hit", &mut std::io::stdout().lock())
}

struct SrcFile {
    path: PathBuf,
    rel: String,
    lang: &'static str,
    size: u64,
    mtime_ms: u64,
}

fn src_file_from(path: &Path, root: &Path, lang: &'static str) -> Result<Option<SrcFile>, String> {
    let meta = fs::metadata(path).map_err(|err| format!("metadata failed for {}: {err}", path.display()))?;
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Ok(None);
    }
    let rel = path.strip_prefix(root).map_err(|err| format!("path is outside graph root ({}): {err}", path.display()))?.to_string_lossy().replace('\\', "/");
    let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Some(SrcFile { path: path.to_path_buf(), rel, lang, size, mtime_ms }))
}

fn parse_file_from(src: &SrcFile) -> Result<FileRecord, String> {
    let lang = src.lang;
    let bytes = fs::read(&src.path).map_err(|err| format!("read failed for {}: {err}", src.path.display()))?;
    let (text, parse_error) = match String::from_utf8(bytes) {
        Ok(text) => (text, String::new()),
        Err(_) => (String::new(), "unsupported source encoding; file not indexed".to_string()),
    };
    let outline = match scan_lang_for_path(&src.path) {
        Some(scan_lang) => outline::extract(&text, lang, scan_lang),
        None => outline::Extraction::default(),
    };
    let tokens = outline.tokens;
    let raw_imports = outline.imports;
    let symbols = outline.symbols;
    let calls = if parse_error.is_empty() { outline.calls } else { None };
    let package_name = outline.package_name;
    let namespace_name = outline.namespace_name;
    let go_package_name = outline.go_package_name;
    let top_level_types = extract_top_level_types(&text, lang);
    Ok(FileRecord {
        rel: src.rel.clone(),
        lang,
        fp: fingerprint_for(&src.rel, src.size, src.mtime_ms),
        size: src.size,
        parse_error,
        tokens,
        raw_imports,
        package_name,
        namespace_name,
        go_package_name,
        top_level_types,
        resolved_imports: Vec::new(),
        imported_by: Vec::new(),
        symbols,
        calls,
    })
}

fn parse_file(path: &Path, root: &Path) -> Result<Option<FileRecord>, String> {
    let Some(lang) = path.extension().and_then(|s| s.to_str()).and_then(lang_for) else {
        return Ok(None);
    };
    let Some(src) = src_file_from(path, root, lang)? else {
        return Ok(None);
    };
    parse_file_from(&src).map(Some)
}

fn emit_records(records: &[FileRecord]) -> Result<(), String> {
    write_jsonl(records, "record", &mut std::io::stdout().lock())
}

// Collect source files under root with metadata read exactly once. Applies
// every drop condition (lang, readable metadata, 2MB cap) before sorting, so
// the filtered+sorted list is the single source of truth: run_walk truncates
// it and run_manifest takes it whole, so run_walk parses exactly the first
// MAX_FILES of the manifest (JS `indexed`).
fn collect_source_files(root: &Path) -> Result<Vec<SrcFile>, String> {
    let candidates = walk_classified_files(root, |path| path.extension().and_then(|s| s.to_str()).and_then(lang_for))?;
    let file_results: Vec<Result<Option<SrcFile>, String>> = candidates.par_iter().map(|(path, lang)| src_file_from(path, root, lang)).collect();
    let mut files = Vec::with_capacity(file_results.len());
    for result in file_results {
        if let Some(file) = result? {
            files.push(file);
        }
    }
    files.par_sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn run_walk(root: &Path) -> Result<(), String> {
    let mut files = collect_source_files(root)?;
    files.truncate(MAX_FILES);
    let parsed: Vec<Result<FileRecord, String>> = files.par_iter().map(parse_file_from).collect();
    let mut records: Vec<FileRecord> = parsed.into_iter().collect::<Result<_, _>>()?;
    let file_set: HashSet<String> = records.iter().map(|r| r.rel.clone()).collect();
    resolve_and_link(&mut records, root, &file_set);
    emit_records(&records)
}

/// `--files` stdin protocol: one JSON `ReusedMeta` per line for every node the caller reuses, so resolution
/// sees the whole graph. Malformed input is fatal because dropping a reused node corrupts graph edges.
fn parse_reused_jsonl(input: &str) -> Result<Vec<FileRecord>, String> {
    let mut records = Vec::new();
    for (index, line) in input.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let meta = serde_json::from_str::<ReusedMeta>(line).map_err(|err| format!("invalid reused JSONL at line {}: {err}", index + 1))?;
        if meta.rel.is_empty() {
            return Err(format!("invalid reused JSONL at line {}: rel is empty", index + 1));
        }
        records.push(record_from_reused(meta));
    }
    Ok(records)
}

fn run_files(root: &Path, files: &[String]) -> Result<(), String> {
    let paths: Vec<PathBuf> = files.iter().map(|f| root.join(f)).collect();
    let fresh_results: Vec<Result<Option<FileRecord>, String>> = paths.par_iter().map(|p| parse_file(p.as_path(), root)).collect();
    let mut records = Vec::with_capacity(fresh_results.len());
    for result in fresh_results {
        if let Some(record) = result? {
            records.push(record);
        }
    }

    let mut stdin = String::new();
    std::io::stdin().read_to_string(&mut stdin).map_err(|err| format!("stdin read failed: {err}"))?;
    records.extend(parse_reused_jsonl(&stdin)?);

    let file_set: HashSet<String> = records.iter().map(|r| r.rel.clone()).collect();
    resolve_and_link(&mut records, root, &file_set);
    emit_records(&records)
}

fn parse_meta_from(src: &SrcFile) -> FileRecord {
    FileRecord {
        rel: src.rel.clone(),
        lang: src.lang,
        fp: fingerprint_for(&src.rel, src.size, src.mtime_ms),
        size: src.size,
        parse_error: String::new(),
        tokens: Vec::new(),
        raw_imports: Vec::new(),
        package_name: String::new(),
        namespace_name: String::new(),
        go_package_name: String::new(),
        top_level_types: Vec::new(),
        resolved_imports: Vec::new(),
        imported_by: Vec::new(),
        symbols: Vec::new(),
        calls: None,
    }
}

fn run_manifest(root: &Path) -> Result<(), String> {
    // Full manifest — every source file, no MAX_FILES cap. fp-only, so even
    // huge repos stay cheap, and the Node side hashes the full set for the
    // change-detect signature.
    let files = collect_source_files(root)?;
    let records: Vec<FileRecord> = files.par_iter().map(parse_meta_from).collect();
    emit_records(&records)
}

/// A usage or rule-parse problem exits 2 like the other argument errors; an
/// internal failure falls through to the exit-1 path in `main`.
fn exit_on_usage_error(result: Result<(), scan::ScanError>) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(scan::ScanError::Usage(message)) => {
            eprintln!("mixdog-graph: {message}");
            process::exit(2);
        }
        Err(scan::ScanError::Internal(message)) => Err(message),
    }
}

fn main() {
    adopt_desktop_app_identity();
    let args: Vec<String> = env::args().collect();
    let cwd = match args.get(1) {
        Some(p) if !p.is_empty() => p.clone(),
        _ => {
            eprintln!(
                "usage: mixdog-graph <cwd> [<symbol> | --files <path>... | --manifest | --langs | --scan --rules <path|-> [--files <rel>...] [--fix] | --outline [--rules <path|->] [--files <rel>...]]"
            );
            process::exit(2);
        }
    };
    let root = Path::new(&cwd);
    if !root.is_dir() {
        eprintln!("mixdog-graph: not a directory: {}", cwd);
        process::exit(2);
    }
    let result = match args.get(2) {
        Some(flag) if flag == "--files" => run_files(root, &args[3..]),
        Some(flag) if flag == "--manifest" => run_manifest(root),
        Some(flag) if flag == "--scan" => exit_on_usage_error(scan::run(root, &args[3..])),
        Some(flag) if flag == "--outline" => exit_on_usage_error(outline::run(root, &args[3..])),
        Some(flag) if flag == "--langs" => scan::run_langs(),
        Some(flag) if flag == "--serve-search" => {
            serve_search::run();
            Ok(())
        }
        Some(sym) if !sym.is_empty() => run_search(root, sym),
        _ => run_walk(root),
    };
    if let Err(error) = result {
        eprintln!("mixdog-graph: {error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A writer that accepts `ok_lines` complete lines and then fails,
    /// standing in for a closed pipe or a full disk. `writeln!` splits one
    /// line across several `write` calls, so the budget counts newlines.
    struct FailingWriter {
        ok_lines: usize,
        lines: usize,
    }

    impl std::io::Write for FailingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.lines >= self.ok_lines {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe closed"));
            }
            self.lines += buf.iter().filter(|byte| **byte == b'\n').count();
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_failed_hit_write_is_fatal_instead_of_dropping_the_hit() {
        let hits = vec![
            SearchHit { rel: "a.rs".to_string(), line: 1, col: 0, text: "fn run() {}".to_string() },
            SearchHit { rel: "b.rs".to_string(), line: 2, col: 4, text: "run();".to_string() },
        ];

        let mut all = Vec::new();
        write_jsonl(&hits, "hit", &mut all).expect("a healthy writer takes every hit");
        assert_eq!(all.iter().filter(|byte| **byte == b'\n').count(), 2);

        let mut broken = FailingWriter { ok_lines: 1, lines: 0 };
        let error = write_jsonl(&hits, "hit", &mut broken).expect_err("a write failure is fatal");
        assert!(error.starts_with("stdout write failed for hit 1"), "{error}");
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mixdog-graph-main-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn search_hits_lists_identifier_occurrences_only_with_a_trimmed_preview() {
        let dir = scratch_dir("search");
        fs::write(dir.join("a.rs"), "fn run() {}\n// run\n    run();\n").unwrap();
        fs::write(dir.join("notes.txt"), "run\n").unwrap();
        let hits = search_hits(&dir, "run").expect("readable tree");
        let _ = fs::remove_dir_all(&dir);
        let seen: Vec<_> = hits.iter().map(|hit| (hit.rel.as_str(), hit.line, hit.col, hit.text.as_str())).collect();
        assert_eq!(seen, vec![("a.rs", 1, 4, "fn run() {}"), ("a.rs", 3, 5, "run();")]);
    }

    #[test]
    fn an_unreadable_search_file_fails_the_search_instead_of_dropping_the_file() {
        let dir = scratch_dir("search-io");
        let error = search_file(&dir.join("vanished.rs"), &dir, "run").err();
        let _ = fs::remove_dir_all(&dir);
        let error = error.expect("a metadata failure is fatal");
        assert!(error.starts_with("metadata failed for "), "{error}");
    }

    #[test]
    fn reused_jsonl_skips_blank_lines_and_rejects_malformed_or_nameless_nodes() {
        let records = parse_reused_jsonl("{\"rel\":\"a.ts\",\"lang\":\"typescript\",\"rawImports\":[\"./b\"]}\n\n{\"rel\":\"b.ts\"}\n").unwrap();
        assert_eq!(records.iter().map(|record| record.rel.as_str()).collect::<Vec<_>>(), vec!["a.ts", "b.ts"]);
        assert_eq!(records[0].raw_imports, vec!["./b".to_string()]);
        assert!(records[0].calls.is_none());
        assert_eq!(parse_reused_jsonl("{\"lang\":\"go\"}\n").err().as_deref(), Some("invalid reused JSONL at line 1: rel is empty"));
        assert!(parse_reused_jsonl("{\"rel\":\"a\"}\nnot json\n").err().unwrap().starts_with("invalid reused JSONL at line 2:"));
    }
}
