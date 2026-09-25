// mixdog-graph — native fast-path for code-graph build.
//
// Walk a project root, identify source files by extension, read each file,
// and extract per-language metadata from ONE ast-grep parse per file:
//   - identifier tokens (grammar identifier nodes; see `tokens.rs`)
//   - raw imports + symbols + call sites (outline/call rules)
//   - package / namespace names (Java/Kotlin/C#) and the Go package, from
//     their declaration nodes
//   - top-level type names (Java/Kotlin/C#/Go) — the one regex survivor,
//     see `TypePatterns`
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
//
// MODULES
// -------
// This file owns the record shape, the walk/parse/emit pipeline and the CLI
// dispatch. `resolve` owns the import-resolution layer that turns a record's
// `rawImports` into `resolvedImports`/`importedBy`; it enters through the
// single `resolve_and_link` call the two graph modes below make.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

use ignore::WalkBuilder;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use mixdog_graph::calls::CallInfo;
use mixdog_graph::lang::{lang_for, lang_static};
use mixdog_graph::outline::{self, SymbolInfo};
use mixdog_graph::scan;
use mixdog_graph::scan_lang::scan_lang_for_path;
use mixdog_graph::serve_search;
use mixdog_graph::{walk_classified_files, write_jsonl};

mod resolve;

use resolve::resolve_and_link;

// Mirrors CODE_GRAPH_MAX_FILES on the Node side. --walk caps parse work
// here so large repos don't pay full parse cost before truncation.
const MAX_FILES: usize = 10_000;

// The walk, the `--files` path and the symbol search share the one cap the
// library defines, so the scan can never disagree with them about which files
// are too large to index.
use mixdog_graph::MAX_FILE_BYTES;

// Task Manager's Processes tab groups rows by AppUserModelID — not by the
// parent/child chain, and not by the version resource build.rs stamps. This
// helper is spawned by a Mixdog session shard and is resident for the life of
// a search session, so with no identity of its own it advertised none and sat
// at the top level as an unrelated row beside the app that owns it (user:
// 카테고리 안으로 들어오게). Claiming the desktop app's AUMID — the same
// io.mixdog.desktop that electron-builder.yml declares as `appId` and that
// main/index.ts passes to app.setAppUserModelId on Windows — folds it into the
// existing Mixdog group.
//
// Purely cosmetic and best-effort: the identity affects taskbar/Task Manager
// grouping only, so a failing or unsupported call just leaves the previous
// ungrouped presentation in place and never blocks the engine from starting.
#[cfg(windows)]
fn adopt_desktop_app_identity() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    // PCWSTR: UTF-16 and NUL-terminated. Built once, borrowed for the call.
    let app_id: Vec<u16> = "io.mixdog.desktop\0".encode_utf16().collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}

// The emitted record. `pub(crate)` because the `resolve` module reads the
// declared metadata and writes the two edge lists back.
#[derive(Serialize)]
pub(crate) struct FileRecord {
    pub(crate) rel: String,
    pub(crate) lang: &'static str,
    fp: String,
    size: u64,
    #[serde(rename = "parseError", skip_serializing_if = "String::is_empty")]
    parse_error: String,
    tokens: Vec<String>,
    #[serde(rename = "rawImports", skip_serializing_if = "Vec::is_empty")]
    pub(crate) raw_imports: Vec<String>,
    #[serde(rename = "packageName", skip_serializing_if = "String::is_empty")]
    pub(crate) package_name: String,
    #[serde(rename = "namespaceName", skip_serializing_if = "String::is_empty")]
    pub(crate) namespace_name: String,
    #[serde(rename = "goPackageName", skip_serializing_if = "String::is_empty")]
    go_package_name: String,
    #[serde(rename = "topLevelTypes", skip_serializing_if = "Vec::is_empty")]
    pub(crate) top_level_types: Vec<String>,
    #[serde(rename = "resolvedImports", skip_serializing_if = "Vec::is_empty")]
    pub(crate) resolved_imports: Vec<String>,
    #[serde(rename = "importedBy", skip_serializing_if = "Vec::is_empty")]
    pub(crate) imported_by: Vec<String>,
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

// Build a lightweight FileRecord from a reused-node meta: carries just
// enough (rel/lang/imports/package/types) for GraphIndex construction and
// import resolution. tokens/symbols stay empty — they aren't re-emitted.
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
        // Reused nodes are not parsed here; JS already holds their calls.
        calls: None,
    }
}

// THE ONE REGEX SURVIVOR: `topLevelTypes`.
//
// Every other file-level field now comes from the parse tree — tokens and
// package/namespace/goPackage from the outline walk, imports and symbols from
// the rules. `topLevelTypes` cannot follow, because its VALUE SET is not the
// set of declared types: the pattern is a plain word scan, so it also reports
// * the word after a keyword pair — `enum class Mode` yields `class`;
// * matches in prose — a doc comment saying "the struct value is …" yields
//   `value`, and this repo's own C# sources carry `value`, `child`, `raw`,
//   `is`, `accessible`, … in `topLevelTypes` today.
// Those strings are not noise the graph can drop: `java`/`kotlin` import
// resolution indexes `<packageName>.<type>` by exactly these strings
// (`type_by_fqcn`), and the field is part of the reused-node protocol the JS
// side sends back on `--files`. An AST rule can only ever report real type
// declarations, which is a DIFFERENT set, so the scan stays a regex and the
// `regex` crate stays a dependency.
struct TypePatterns {
    type_decl_jks: Regex,
    go_type: Regex,
}

impl TypePatterns {
    fn new() -> Self {
        let type_decl_jks = Regex::new(
            r"\b(?:class|interface|enum|record|object|struct)\s+([A-Za-z_][A-Za-z0-9_]*)",
        )
        .unwrap();
        let go_type = Regex::new(r"(?m)^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b").unwrap();
        TypePatterns {
            type_decl_jks,
            go_type,
        }
    }
}

fn extract_top_level_types(text: &str, lang: &str, p: &TypePatterns) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    match lang {
        "java" | "kotlin" | "csharp" => {
            for line in text.lines() {
                if let Some(cap) = p.type_decl_jks.captures(line) {
                    if let Some(m) = cap.get(1) {
                        let s = m.as_str();
                        if seen.insert(s.to_string()) {
                            out.push(s.to_string());
                        }
                    }
                }
            }
        }
        "go" => {
            for cap in p.go_type.captures_iter(text) {
                if let Some(m) = cap.get(1) {
                    let s = m.as_str();
                    if seen.insert(s.to_string()) {
                        out.push(s.to_string());
                    }
                }
            }
        }
        _ => {}
    }
    out
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

// `mixdog-graph <root> <symbol>`: every occurrence of `symbol` AS AN
// IDENTIFIER, one JSONL hit per occurrence.
//
// Stage 3-D replaced the masked-text regex scan with the parse tree: a hit is
// an identifier node whose text IS the symbol, which is the same answer the
// word-boundary regex gave on masked text, minus the masking approximations —
// comments and string bodies cannot produce a node of an identifier kind, and
// an identifier inside a string interpolation still does.
fn run_search(root: &Path, symbol: &str) -> Result<(), String> {
    if symbol.is_empty() {
        return Ok(());
    }

    let mut entries: Vec<_> = WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(false)
        .build()
        .filter_map(Result::ok)
        .filter(|d| d.file_type().map(|t| t.is_file()).unwrap_or(false))
        .collect();
    entries.sort_by(|a, b| a.path().cmp(b.path()));

    let hits: Vec<SearchHit> = entries
        .par_iter()
        .flat_map(|entry| {
            let path = entry.path();
            let ext = match path.extension().and_then(|s| s.to_str()) {
                Some(e) => e,
                None => return Vec::new(),
            };
            if lang_for(ext).is_none() {
                return Vec::new();
            }
            let Some(scan_lang) = scan_lang_for_path(path) else {
                return Vec::new();
            };
            let rel = match path.strip_prefix(root) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => return Vec::new(),
            };
            let meta = match fs::metadata(path) {
                Ok(m) => m,
                Err(_) => return Vec::new(),
            };
            if meta.len() > MAX_FILE_BYTES {
                return Vec::new();
            }
            let text = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => return Vec::new(),
            };
            if !text.contains(symbol) {
                return Vec::new();
            }
            let original_lines: Vec<&str> = text.lines().collect();
            let mut out: Vec<SearchHit> = outline::identifier_hits(&text, scan_lang, symbol)
                .into_iter()
                .map(|(line, col)| {
                    let display = original_lines
                        .get(line as usize - 1)
                        .map(|s| s.trim())
                        .unwrap_or("");
                    // One trimmed, 80-character preview of the hit's line.
                    let trimmed: String = display.chars().take(80).collect();
                    SearchHit {
                        rel: rel.clone(),
                        line,
                        col,
                        text: trimmed,
                    }
                })
                .collect();
            out.sort_by_key(|hit| (hit.line, hit.col));
            out
        })
        .collect();

    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    emit_search_hits(&hits, &mut handle)
}

// Every serialization and write failure is fatal, like the graph emitter: a
// dropped hit would otherwise leave the caller with a silently short list and
// exit code 0.
fn emit_search_hits(hits: &[SearchHit], out: &mut impl std::io::Write) -> Result<(), String> {
    write_jsonl(hits, "hit", out)
}

// A source file discovered by the walk, with its metadata read exactly once.
// Parsing reuses size/mtime/rel/lang so stat happens a single time (collect),
// not twice (collect + parse).
struct SrcFile {
    path: PathBuf,
    rel: String,
    lang: &'static str,
    size: u64,
    mtime_ms: u64,
}

// Stat one candidate path into a SrcFile: the size cap, the repo-relative
// `rel` and the mtime the fingerprint keys on, all from ONE metadata call.
// `Ok(None)` means the file is over the cap and is not indexed. Both the walk
// and the `--files` path go through here, so neither can drift from the other.
fn src_file_from(path: &Path, root: &Path, lang: &'static str) -> Result<Option<SrcFile>, String> {
    let meta = fs::metadata(path)
        .map_err(|err| format!("metadata failed for {}: {err}", path.display()))?;
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Ok(None);
    }
    let rel = path
        .strip_prefix(root)
        .map_err(|err| format!("path is outside graph root ({}): {err}", path.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(SrcFile {
        path: path.to_path_buf(),
        rel,
        lang,
        size,
        mtime_ms,
    }))
}

// Full parse (tokens/imports/symbols) from an already-collected SrcFile.
// Unreadable files fail the build; unsupported encodings produce a parse-error
// record without claiming that call extraction ran.
fn parse_file_from(src: &SrcFile, patterns: &TypePatterns) -> Result<FileRecord, String> {
    let lang = src.lang;
    let bytes = fs::read(&src.path)
        .map_err(|err| format!("read failed for {}: {err}", src.path.display()))?;
    let decoded = decode_source_text(bytes);
    let (text, parse_error) = match decoded {
        Ok(text) => (text, String::new()),
        Err(error) => (String::new(), error.to_string()),
    };
    // ONE ast-grep parse per file feeds tokens, imports, symbols, call sites
    // and the package/namespace metadata; the grammar comes from the registry
    // (`.tsx` is parsed as tsx, reported as typescript).
    let outline = match scan_lang_for_path(&src.path) {
        Some(scan_lang) => outline::extract(&text, lang, scan_lang),
        None => outline::Extraction::default(),
    };
    let tokens = outline.tokens;
    let raw_imports = outline.imports;
    let symbols = outline.symbols;
    // A file that never decoded was not parsed, so its call list is unknown
    // (key omitted) rather than known-empty — `outline::extract` saw an empty
    // source here, not the file's real contents.
    let calls = if parse_error.is_empty() {
        outline.calls
    } else {
        None
    };
    let package_name = outline.package_name;
    let namespace_name = outline.namespace_name;
    let go_package_name = outline.go_package_name;
    let top_level_types = extract_top_level_types(&text, lang, patterns);
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

fn decode_source_text(bytes: Vec<u8>) -> Result<String, &'static str> {
    String::from_utf8(bytes).map_err(|_| "unsupported source encoding; file not indexed")
}

// Stat-and-parse a single path (used by --files, where paths come from the
// caller, not the walk). One metadata read, then parse_file_from.
fn parse_file(
    path: &Path,
    root: &Path,
    patterns: &TypePatterns,
) -> Result<Option<FileRecord>, String> {
    let Some(lang) = path.extension().and_then(|s| s.to_str()).and_then(lang_for) else {
        return Ok(None);
    };
    let Some(src) = src_file_from(path, root, lang)? else {
        return Ok(None);
    };
    parse_file_from(&src, patterns).map(Some)
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
    // Phase 1 (sequential walk, no stat): gather candidate paths + lang. The
    // ignore-crate walk is inherently sequential, but doing zero I/O here keeps
    // it cheap.
    let candidates = walk_classified_files(root, |path| {
        path.extension().and_then(|s| s.to_str()).and_then(lang_for)
    })?;
    // Phase 2 (parallel): one stat per candidate for size/mtime + the 2MB gate.
    let file_results: Vec<Result<Option<SrcFile>, String>> = candidates
        .par_iter()
        .map(|(path, lang)| src_file_from(path, root, lang))
        .collect();
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
    let patterns = TypePatterns::new();
    let mut files = collect_source_files(root)?;
    // Cap cold parse work at MAX_FILES so large repos never pay the full
    // native parse cost just to be truncated afterwards.
    files.truncate(MAX_FILES);
    let parsed: Vec<Result<FileRecord, String>> = files
        .par_iter()
        .map(|s| parse_file_from(s, &patterns))
        .collect();
    let mut records: Vec<FileRecord> = parsed.into_iter().collect::<Result<_, _>>()?;
    // fileSet = every parsed record's rel; resolve imports + dependents.
    let file_set: HashSet<String> = records.iter().map(|r| r.rel.clone()).collect();
    resolve_and_link(&mut records, root, &file_set);
    emit_records(&records)
}

fn run_files(root: &Path, files: &[String]) -> Result<(), String> {
    let patterns = TypePatterns::new();
    // Path::join replaces the root when a path is absolute.
    let paths: Vec<PathBuf> = files.iter().map(|f| root.join(f)).collect();
    // Full-parse the fresh subset (tokens/symbols/imports/package/types).
    let fresh_results: Vec<Result<Option<FileRecord>, String>> = paths
        .par_iter()
        .map(|p| parse_file(p.as_path(), root, &patterns))
        .collect();
    let mut fresh = Vec::with_capacity(fresh_results.len());
    for result in fresh_results {
        if let Some(record) = result? {
            fresh.push(record);
        }
    }

    // Design-A protocol: stdin is JSONL, ONE LINE PER REUSED NODE, each a
    // ReusedMeta (rel/lang/rawImports/package/namespace/goPackage/types).
    // Deserialize into lightweight records so the GraphIndex + resolution
    // see the WHOLE graph, not just the freshly-parsed subset. Malformed input
    // is fatal because silently dropping a reused node corrupts graph edges.
    let reused: Vec<FileRecord> = {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|err| format!("stdin read failed: {err}"))?;
        let mut records = Vec::new();
        for (index, line) in buf.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let meta = serde_json::from_str::<ReusedMeta>(line)
                .map_err(|err| format!("invalid reused JSONL at line {}: {err}", index + 1))?;
            if meta.rel.is_empty() {
                return Err(format!(
                    "invalid reused JSONL at line {}: rel is empty",
                    index + 1
                ));
            }
            records.push(record_from_reused(meta));
        }
        records
    };

    // ALL nodes = fresh parsed + reused metas. Index + resolution run over
    // the union so reused nodes resolve and the package/type index is whole.
    let mut records: Vec<FileRecord> = fresh;
    records.extend(reused);

    // fileSet = every node's rel (fresh + reused). Empty stdin means this is an
    // explicitly requested standalone subset.
    let file_set: HashSet<String> = records.iter().map(|r| r.rel.clone()).collect();

    resolve_and_link(&mut records, root, &file_set);

    // Fresh nodes emit a full FileRecord; reused nodes emit a lightweight
    // record (rel + resolvedImports — empty tokens/symbols/rawImports are
    // skipped by serde, importedBy is ignored by JS).
    emit_records(&records)
}

// Manifest mode: emit fp/rel/size/lang only, no text parsing. Reuses the
// metadata already read by collect_source_files.
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
        // Manifest mode reads no text at all, so calls stay unknown.
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
    // Before any work: the identity has to be in place while Task Manager is
    // free to sample this process, and it costs nothing on the CLI paths.
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
        // Structural ast-grep scan. Usage / rule-parse problems exit 2 like
        // the other argument errors; everything else falls through to the
        // exit-1 internal error path below.
        Some(flag) if flag == "--scan" => exit_on_usage_error(scan::run(root, &args[3..])),
        // Outline debug dump: the raw rule output per file, for validating
        // outline rule files against real sources.
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
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe closed",
                ));
            }
            self.lines += buf.iter().filter(|byte| **byte == b'\n').count();
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// The file header promises that every I/O and serialization failure is
    /// fatal. `run_search` used to `continue` past a serialization error and
    /// ignore the write result, so a broken pipe produced a TRUNCATED hit list
    /// with exit code 0 — a caller could cache that as the whole answer.
    #[test]
    fn a_failed_hit_write_is_fatal_instead_of_dropping_the_hit() {
        let hits = vec![
            SearchHit {
                rel: "a.rs".to_string(),
                line: 1,
                col: 0,
                text: "fn run() {}".to_string(),
            },
            SearchHit {
                rel: "b.rs".to_string(),
                line: 2,
                col: 4,
                text: "run();".to_string(),
            },
        ];

        let mut all = Vec::new();
        emit_search_hits(&hits, &mut all).expect("a healthy writer takes every hit");
        assert_eq!(all.iter().filter(|byte| **byte == b'\n').count(), 2);

        // The pipe closes after the first line: the second hit cannot be
        // written, and that has to surface as an error, not a short list.
        let mut broken = FailingWriter {
            ok_lines: 1,
            lines: 0,
        };
        let error = emit_search_hits(&hits, &mut broken).expect_err("a write failure is fatal");
        assert!(
            error.starts_with("stdout write failed for hit 1"),
            "{error}"
        );
    }
}
