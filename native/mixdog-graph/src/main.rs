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

use std::collections::{HashMap, HashSet};
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
use mixdog_graph::tokens;

// Mirrors CODE_GRAPH_MAX_FILES on the Node side. --walk caps parse work
// here so large repos don't pay full parse cost before truncation.
const MAX_FILES: usize = 10_000;

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

// JSON-with-comments stripper for `tsconfig.json` / `jsconfig.json` /
// `package.json`: replaces `//` line comments and `/* */` block comments with
// whitespace (newlines preserved) while passing string literals through
// verbatim, so a `//` inside a quoted path survives. Source files are never
// stripped any more — comments and string bodies are excluded from tokens,
// symbols and search by the parse tree itself.
fn strip_jsonc_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0usize;
    let n = bytes.len();
    let mut in_string: Option<u8> = None;
    while i < n {
        let c = bytes[i];
        if let Some(delim) = in_string {
            if c == b'\\' && i + 1 < n {
                // Keep the escape pair as-is: the quoted value is the payload.
                out.push(c);
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if c == delim {
                in_string = None;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            in_string = Some(c);
            out.push(c);
            i += 1;
            continue;
        }
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            // line comment: replace with spaces until \n, keep \n
            i += 2;
            while i < n && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            // block comment: skip until */, keeping newlines
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    out.push(b'\n');
                }
                i += 1;
            }
            if i + 1 < n {
                i += 2;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    // Input was &str (valid UTF-8) and we only ever emit verbatim bytes from
    // it or ASCII spaces; the result is always valid UTF-8.
    String::from_utf8(out).expect("strip_jsonc_comments preserves UTF-8 invariant")
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
fn run_search(root: &Path, symbol: &str) {
    if symbol.is_empty() {
        return;
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
            if meta.len() > 2 * 1024 * 1024 {
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
                    // Take first 80 chars of the trimmed display line.
                    let trimmed = if display.len() > 80 {
                        display.chars().take(80).collect::<String>()
                    } else {
                        display.to_string()
                    };
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
    for hit in &hits {
        let line = match serde_json::to_string(hit) {
            Ok(s) => s,
            Err(_) => continue,
        };
        use std::io::Write;
        let _ = writeln!(handle, "{}", line);
    }
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

// Full parse (tokens/imports/symbols) from an already-collected SrcFile.
// Unreadable/non-UTF8 files fail the build instead of producing a partial
// graph that can be mistaken for a complete cache entry.
fn parse_file_from(src: &SrcFile, patterns: &TypePatterns) -> Result<FileRecord, String> {
    let lang = src.lang;
    let bytes = fs::read(&src.path)
        .map_err(|err| format!("read failed for {}: {err}", src.path.display()))?;
    let decoded = decode_source_text(&bytes);
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

fn decode_source_text(bytes: &[u8]) -> Result<String, &'static str> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "unsupported source encoding; file not indexed")
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
    let meta = fs::metadata(path)
        .map_err(|err| format!("metadata failed for {}: {err}", path.display()))?;
    let size = meta.len();
    if size > 2 * 1024 * 1024 {
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
    parse_file_from(
        &SrcFile {
            path: path.to_path_buf(),
            rel,
            lang,
            size,
            mtime_ms,
        },
        patterns,
    )
    .map(Some)
}

fn emit_records(records: &[FileRecord]) -> Result<(), String> {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    for (index, rec) in records.iter().enumerate() {
        let line = serde_json::to_string(rec)
            .map_err(|err| format!("serialize failed for record {index}: {err}"))?;
        writeln!(handle, "{}", line)
            .map_err(|err| format!("stdout write failed for record {index}: {err}"))?;
    }
    Ok(())
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
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
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
        let Some(lang) = path.extension().and_then(|s| s.to_str()).and_then(lang_for) else {
            continue;
        };
        candidates.push((path.to_path_buf(), lang));
    }
    // Phase 2 (parallel): one stat per candidate for size/mtime + the 2MB gate.
    let file_results: Vec<Result<Option<SrcFile>, String>> = candidates
        .par_iter()
        .map(|(path, lang)| {
            let meta = fs::metadata(path)
                .map_err(|err| format!("metadata failed for {}: {err}", path.display()))?;
            let size = meta.len();
            if size > 2 * 1024 * 1024 {
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
                path: path.clone(),
                rel,
                lang,
                size,
                mtime_ms,
            }))
        })
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

// =====================================================================
// Import resolution + dependents (ported from the JS code-graph.mjs
// import-resolution layer, L658-954). All paths here are repo-relative
// and forward-slash normalized (same form as `FileRecord.rel`); the
// fileSet is a HashSet of those rels. Resolution that the JS layer did
// in absolute-path space is done here in repo-relative space — the root
// directory maps to the empty string "".
// =====================================================================

// Mirror of JS `_normalizeImportSpec`: trim + backslash→forward-slash.
fn normalize_import_spec(spec: &str) -> String {
    spec.trim().replace('\\', "/")
}

// dirname for a repo-relative path. "a/b/c.ts" → "a/b"; "c.ts" → "".
fn rel_dir(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

// Owned parent of a repo-relative dir. "a/b" → "a"; "a" → ""; "" → "".
fn dirname_str(d: &str) -> String {
    match d.rfind('/') {
        Some(i) => d[..i].to_string(),
        None => String::new(),
    }
}

// Repo-relative analogue of `pathResolve(base, spec)`: join `base` (a
// repo-relative dir) with `spec`, collapse `.`/`..` segments, and emit a
// forward-slash repo-relative path. Leading `..` that escapes the root is
// preserved as a literal `..` segment so the result can never spuriously
// match a repo-relative fileSet entry (which never contains `..`).
fn path_join_norm(base: &str, spec: &str) -> String {
    let combined = if base.is_empty() {
        spec.to_string()
    } else {
        format!("{}/{}", base, spec)
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_none_or(|p| *p == "..") {
                    parts.push("..");
                } else {
                    parts.pop();
                }
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

// Strip a trailing js-like extension (.js/.jsx/.mjs/.cjs), mirroring the
// JS `base.replace(/\.(js|jsx|mjs|cjs)$/, '')`.
fn strip_js_ext(base: &str) -> String {
    for ext in [".js", ".jsx", ".mjs", ".cjs"] {
        if let Some(stripped) = base.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    base.to_string()
}

// Case-insensitive strip of a leading `static\s+` (Java/C# static imports).
fn strip_static_prefix(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("static") {
        let rest = &s["static".len()..];
        if rest.starts_with(char::is_whitespace) {
            return rest.trim_start().to_string();
        }
    }
    s.to_string()
}

// JS `_resolveJsLikeImport` (relative-only). Candidate exts plus index.*,
// and the .js→.ts retry via the extension-stripped base.
fn resolve_js_like(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    if !spec.starts_with('.') {
        return None;
    }
    let base = path_join_norm(rel_dir(rel), spec);
    resolve_js_base(&base, file_set)
}

fn resolve_js_base(base: &str, file_set: &HashSet<String>) -> Option<String> {
    let base_no_ext = strip_js_ext(base);
    let candidates = [
        base.to_string(),
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.mts"),
        format!("{base}.cts"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}.mjs"),
        format!("{base}.cjs"),
        format!("{base_no_ext}.ts"),
        format!("{base_no_ext}.tsx"),
        format!("{base_no_ext}.mts"),
        format!("{base_no_ext}.cts"),
        format!("{base_no_ext}.js"),
        format!("{base_no_ext}.jsx"),
        format!("{base_no_ext}.mjs"),
        format!("{base_no_ext}.cjs"),
        path_join_norm(base, "index.ts"),
        path_join_norm(base, "index.tsx"),
        path_join_norm(base, "index.mts"),
        path_join_norm(base, "index.cts"),
        path_join_norm(base, "index.js"),
        path_join_norm(base, "index.jsx"),
        path_join_norm(base, "index.mjs"),
        path_join_norm(base, "index.cjs"),
    ];
    candidates.into_iter().find(|p| file_set.contains(p))
}

// JS `_resolvePyImport`. rootDir maps to "" in repo-relative space.
fn resolve_py(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    if spec.is_empty() {
        return None;
    }
    let target = if spec.starts_with('.') {
        let levels = spec.chars().take_while(|&c| c == '.').count();
        let module_tail = spec[levels..].replace('.', "/");
        let mut base = rel_dir(rel).to_string();
        for _ in 1..levels {
            base = dirname_str(&base);
        }
        if module_tail.is_empty() {
            base
        } else {
            path_join_norm(&base, &module_tail)
        }
    } else {
        path_join_norm("", &spec.replace('.', "/"))
    };
    let mut prefixes = vec![String::new()];
    if !spec.starts_with('.') {
        prefixes.push("src".to_string());
        prefixes.push("lib".to_string());
    }
    for prefix in prefixes {
        let path = if prefix.is_empty() {
            target.clone()
        } else {
            path_join_norm(&prefix, &target)
        };
        for cand in [
            format!("{path}.py"),
            format!("{path}.pyi"),
            path_join_norm(&path, "__init__.py"),
            path_join_norm(&path, "__init__.pyi"),
        ] {
            if file_set.contains(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

// JS `_resolveInclude` (c/cpp). Tries file-relative then root-relative.
fn resolve_include(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    let rel_candidate = path_join_norm(rel_dir(rel), &norm);
    if file_set.contains(&rel_candidate) {
        return Some(rel_candidate);
    }
    let root_candidate = path_join_norm("", &norm);
    if file_set.contains(&root_candidate) {
        return Some(root_candidate);
    }
    let suffix = format!("/{norm}");
    let mut hits: Vec<&String> = file_set
        .iter()
        .filter(|path| path.ends_with(&suffix) || *path == &norm)
        .collect();
    hits.sort();
    hits.into_iter().next().cloned()
}

// JS `_resolveRubyImport`.
fn resolve_ruby(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    let rel_base = path_join_norm(rel_dir(rel), &norm);
    let root_base = path_join_norm("", &norm);
    let candidates = [
        format!("{}.rb", rel_base),
        path_join_norm(&rel_base, "index.rb"),
        format!("{}.rb", root_base),
        path_join_norm(&root_base, "index.rb"),
    ];
    candidates.into_iter().find(|p| file_set.contains(p))
}

// Bash `source path` / `. path`: resolve a relative path against the
// importing file's dir. Only relative specs (`./x`, `../x`, or a bare
// `x.sh`) are resolvable in fileSet space; absolute/PATH-looked-up specs
// have no repo-relative target and return None.
fn resolve_bash_source(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || norm.starts_with('/') {
        return None;
    }
    let candidate = path_join_norm(rel_dir(rel), &norm);
    if file_set.contains(&candidate) {
        return Some(candidate);
    }
    None
}

// Lua `require "a.b"`: dots map to path separators, resolved against the
// repo root as `a/b.lua` then `a/b/init.lua`.
fn resolve_lua_require(spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() {
        return None;
    }
    let base = path_join_norm("", &norm.replace('.', "/"));
    let candidates = [format!("{}.lua", base), path_join_norm(&base, "init.lua")];
    candidates.into_iter().find(|p| file_set.contains(p))
}

// True if `spec` begins with a generic URI scheme `^[a-z][a-z0-9+.-]*:`
// (package:, dart:, http:, file:, …). A leading drive-letter like `C:` won't
// reach here — Dart specs are URIs and `normalize_import_spec` already mapped
// `\` to `/`; callers also reject absolute `/` paths separately.
fn has_uri_scheme(spec: &str) -> bool {
    let mut chars = spec.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    for (_, c) in chars {
        if c == ':' {
            return true;
        }
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '.' || c == '-' {
            continue;
        }
        return false;
    }
    false
}

// Dart relative import / part: `import './x.dart'`, `import 'src/y.dart'`,
// `part 'a.g.dart'`. Dart relative URIs commonly omit the leading `.`, so any
// spec without a URI scheme is treated as repo-relative and joined against the
// importing file's dir (the spec already carries the `.dart` extension).
// Rejected: an absolute `/foo.dart` (joining it importer-relative would forge a
// bogus repo path), and any URI with a scheme `^[a-z][a-z0-9+.-]*:` — this
// covers `package:`/`dart:` plus `http:`/`file:`/etc. — none of which name a
// repo-relative target.
fn resolve_dart_import(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || norm.starts_with('/') || has_uri_scheme(&norm) {
        return None;
    }
    let candidate = path_join_norm(rel_dir(rel), &norm);
    if file_set.contains(&candidate) {
        return Some(candidate);
    }
    None
}

// R `source("path.R")` (or a relative `library`/`require` arg, rare): resolve
// the quoted path against the importing file's dir. Library/require names that
// reference installed packages are not relative paths and won't match the
// fileSet, so only an actual relative source path resolves.
fn resolve_r_source(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || norm.starts_with('/') {
        return None;
    }
    let candidate = path_join_norm(rel_dir(rel), &norm);
    if file_set.contains(&candidate) {
        return Some(candidate);
    }
    None
}

// Solidity `import "…"` / `import {A} from "…"`. Three legs, in the order
// solc itself tries them once remappings are out of the picture:
//   1. a RELATIVE spec (`./x.sol`, `../lib/y.sol`) against the importing
//      file's directory — the only form solc resolves relative to the source;
//   2. `node_modules/<spec>` — how `@openzeppelin/contracts/...` and every
//      other npm-published library is vendored (hardhat/truffle layouts);
//   3. the project root — the foundry/`remappings.txt` flat layout, where
//      `src/Token.sol` names a repo path directly.
// A spec is only an edge when it lands on a file the graph actually indexed,
// so a dependency that is not checked in (the usual `node_modules` case)
// resolves to nothing instead of a phantom node.
fn resolve_solidity_import(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || norm.starts_with('/') {
        return None;
    }
    if norm.starts_with("./") || norm.starts_with("../") {
        let candidate = path_join_norm(rel_dir(rel), &norm);
        return file_set.contains(&candidate).then_some(candidate);
    }
    let vendored = format!("node_modules/{norm}");
    if file_set.contains(&vendored) {
        return Some(vendored);
    }
    let from_root = path_join_norm("", &norm);
    file_set.contains(&from_root).then_some(from_root)
}

// Haskell `import A.B.C`: the module path is a directory path plus `.hs`
// (or a literate `.lhs`). GHC finds it on the source-import search path, which
// a repository expresses as its own layout, so the search starts in the
// importing file's directory and walks UP through every ancestor, trying the
// ancestor itself and its `src/`, `lib/`, `app/` and `test/` subdirectories —
// the four roots cabal/stack projects declare as `hs-source-dirs`. The first
// existing file wins, so the nearest enclosing project answers before a
// sibling package with the same module name.
const HASKELL_SOURCE_DIRS: [&str; 5] = ["", "src", "lib", "app", "test"];

fn resolve_haskell_import(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let module = normalize_import_spec(spec);
    if module.is_empty() || !tokens::is_dotted_path(&module) {
        return None;
    }
    let tail = module.replace('.', "/");
    let mut dir = rel_dir(rel).to_string();
    loop {
        for source_dir in HASKELL_SOURCE_DIRS {
            let base = if source_dir.is_empty() {
                dir.clone()
            } else {
                path_join_norm(&dir, source_dir)
            };
            for ext in ["hs", "lhs"] {
                let candidate = path_join_norm(&base, &format!("{tail}.{ext}"));
                if file_set.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }
        if dir.is_empty() {
            break;
        }
        dir = dirname_str(&dir);
    }
    None
}

// Terraform local module: `module "x" { source = "./modules/x" }`.
//
// A TERRAFORM MODULE IS A DIRECTORY, not a file: terraform loads every `.tf`
// in it as one configuration, and no single file is "the module". So the
// source path resolves to the directory and the edge fans out to EVERY `.tf`
// file directly inside it (no recursion — nested directories are separate
// modules). Only local paths are edges: the outline rule already restricts
// `source` to `./`, `../` and `/`, and an absolute `/…` path is a filesystem
// location this repository cannot name, so it resolves to nothing.
fn resolve_hcl_module(rel: &str, spec: &str, file_set: &HashSet<String>) -> Vec<String> {
    let norm = normalize_import_spec(spec);
    if !(norm.starts_with("./") || norm.starts_with("../")) {
        return Vec::new();
    }
    let dir = path_join_norm(rel_dir(rel), &norm);
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let mut hits: Vec<String> = file_set
        .iter()
        .filter(|path| {
            if !path.ends_with(".tf") {
                return false;
            }
            if dir.is_empty() {
                !path.contains('/')
            } else {
                path.starts_with(&prefix) && !path[prefix.len()..].contains('/')
            }
        })
        .cloned()
        .collect();
    hits.sort();
    hits
}

fn file_stem_rel(rel: &str) -> Option<&str> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|s| !s.is_empty())
}

fn resolve_go_relative(rel: &str, spec: &str, file_set: &HashSet<String>) -> Vec<String> {
    if !spec.starts_with('.') {
        return Vec::new();
    }
    let dir = path_join_norm(rel_dir(rel), spec);
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let mut hits: Vec<String> = file_set
        .iter()
        .filter(|path| {
            if !path.ends_with(".go") {
                return false;
            }
            if dir.is_empty() {
                !path.contains('/')
            } else {
                path.starts_with(&prefix) && !path[prefix.len()..].contains('/')
            }
        })
        .cloned()
        .collect();
    hits.sort();
    hits
}

fn resolve_php_require(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || norm.starts_with('/') {
        return None;
    }
    if !norm.ends_with(".php") && !norm.starts_with('.') {
        return None;
    }
    let rel_base = path_join_norm(rel_dir(rel), &norm);
    let root_base = path_join_norm("", &norm);
    [
        rel_base.clone(),
        format!("{rel_base}.php"),
        root_base.clone(),
        format!("{root_base}.php"),
    ]
    .into_iter()
    .find(|p| file_set.contains(p))
}

fn resolve_zig(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || matches!(norm.as_str(), "std" | "builtin" | "root" | "c") {
        return None;
    }
    let with_ext = if norm.ends_with(".zig") {
        norm.clone()
    } else {
        format!("{norm}.zig")
    };
    let rel_c = path_join_norm(rel_dir(rel), &with_ext);
    if file_set.contains(&rel_c) {
        return Some(rel_c);
    }
    let root_c = path_join_norm("", &with_ext);
    file_set.contains(&root_c).then_some(root_c)
}

fn resolve_rust_mod(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    let name = spec.strip_prefix("mod::")?;
    if name.is_empty() {
        return None;
    }
    let dir = rel_dir(rel);
    let stem = file_stem_rel(rel).unwrap_or("");
    let parent = if stem == "mod" || stem == "lib" || stem == "main" {
        dir.to_string()
    } else if dir.is_empty() {
        stem.to_string()
    } else {
        format!("{dir}/{stem}")
    };
    [
        path_join_norm(&parent, &format!("{name}.rs")),
        path_join_norm(&parent, &format!("{name}/mod.rs")),
    ]
    .into_iter()
    .find(|path| file_set.contains(path))
}

fn parse_pubspec_name(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("name:") else {
            continue;
        };
        let name = rest.trim().trim_matches('"').trim_matches('\'');
        if !name.is_empty() && !name.contains(char::is_whitespace) {
            return Some(name.to_string());
        }
    }
    None
}

fn load_dart_packages(root: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut consider = |yaml: PathBuf, lib_dir: String| {
        if let Ok(text) = fs::read_to_string(&yaml) {
            if let Some(name) = parse_pubspec_name(&text) {
                out.insert(name, lib_dir);
            }
        }
    };
    consider(root.join("pubspec.yaml"), "lib".to_string());
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().replace('\\', "/");
        let yaml = path.join("pubspec.yaml");
        if yaml.is_file() {
            consider(yaml, format!("{name}/lib"));
        }
        let Ok(inner) = fs::read_dir(&path) else {
            continue;
        };
        for child in inner.flatten() {
            let yaml = child.path().join("pubspec.yaml");
            if yaml.is_file() {
                let rel = format!("{name}/{}", child.file_name().to_string_lossy());
                consider(yaml, format!("{rel}/lib"));
            }
        }
    }
    out
}

fn parse_composer_psr4(text: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in ["autoload", "autoload-dev"] {
        let Some(map) = value
            .get(key)
            .and_then(|item| item.get("psr-4"))
            .and_then(|item| item.as_object())
        else {
            continue;
        };
        for (ns, path) in map {
            let dirs: Vec<String> = match path {
                serde_json::Value::String(s) => vec![s.clone()],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect(),
                _ => continue,
            };
            for dir in dirs {
                let dir = dir.replace('\\', "/").trim_start_matches("./").to_string();
                out.push((ns.replace("\\\\", "\\"), dir));
            }
        }
    }
    out
}

fn load_php_psr4(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut consider = |path: PathBuf, base: String| {
        let Ok(text) = fs::read_to_string(&path) else {
            return;
        };
        for (ns, dir) in parse_composer_psr4(&text) {
            let joined = if base.is_empty() {
                dir
            } else {
                path_join_norm(&base, &dir)
            };
            let dir = if joined.is_empty() || joined.ends_with('/') {
                joined
            } else {
                format!("{joined}/")
            };
            out.push((ns, dir));
        }
    };
    consider(root.join("composer.json"), String::new());
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path().join("composer.json");
            if path.is_file() {
                consider(path, entry.file_name().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out
}

fn visit_shallow_files(root: &Path, names: &[&str], mut on_file: impl FnMut(PathBuf, String)) {
    fn walk(
        dir: &Path,
        rel: &str,
        depth: usize,
        names: &[&str],
        on_file: &mut dyn FnMut(PathBuf, String),
    ) {
        for name in names {
            let path = dir.join(name);
            if path.is_file() {
                on_file(path, rel.to_string());
            }
        }
        if depth == 0 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().replace('\\', "/");
            if name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == "dist"
                || name == "vendor"
            {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            walk(&path, &child_rel, depth - 1, names, on_file);
        }
    }
    walk(root, "", 3, names, &mut on_file);
}

fn parse_tsconfig_raw(
    text: &str,
) -> Option<(Option<String>, Option<String>, Vec<(String, Vec<String>)>)> {
    let cleaned = strip_jsonc_comments(text);
    let value: serde_json::Value = serde_json::from_str(&cleaned).ok()?;
    let extends = value
        .get("extends")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());
    let opts = value.get("compilerOptions");
    let base_url = opts
        .and_then(|item| item.get("baseUrl"))
        .and_then(|item| item.as_str())
        .map(|s| s.replace('\\', "/"));
    let mut aliases = Vec::new();
    if let Some(paths) = opts
        .and_then(|item| item.get("paths"))
        .and_then(|item| item.as_object())
    {
        for (pattern, targets) in paths {
            let prefix = pattern.trim_end_matches('*').to_string();
            if prefix.is_empty() {
                continue;
            }
            let mapped: Vec<String> = match targets {
                serde_json::Value::String(s) => vec![s.trim_end_matches('*').replace('\\', "/")],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|s| s.trim_end_matches('*').replace('\\', "/"))
                    .collect(),
                _ => continue,
            };
            if !mapped.is_empty() {
                aliases.push((prefix, mapped));
            }
        }
    }
    Some((extends, base_url, aliases))
}

fn load_ts_configs(root: &Path) -> Vec<TsConfigScope> {
    let mut out = Vec::new();
    let mut files = Vec::new();
    visit_shallow_files(
        root,
        &["tsconfig.json", "jsconfig.json", "tsconfig.base.json"],
        |path, dir| files.push((dir, path)),
    );
    fn resolve_one(
        path: &Path,
        dir: &str,
        root: &Path,
        stack: &mut Vec<PathBuf>,
    ) -> Option<TsConfigScope> {
        if stack.iter().any(|seen| seen == path) {
            return None;
        }
        let text = fs::read_to_string(path).ok()?;
        let (extends, base_url, paths) = parse_tsconfig_raw(&text)?;
        stack.push(path.to_path_buf());
        let mut scope = TsConfigScope {
            dir: dir.to_string(),
            base_url: base_url.clone().unwrap_or_else(|| ".".to_string()),
            aliases: paths.clone(),
        };
        if let Some(ext) = extends {
            if !ext.starts_with('@') {
                let file = if ext.ends_with(".json") {
                    ext.clone()
                } else {
                    format!("{ext}.json")
                };
                let parent_path = path.parent().unwrap_or(root).join(file);
                let parent_dir = parent_path
                    .strip_prefix(root)
                    .ok()
                    .and_then(|rel| rel.parent())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if let Some(parent) = resolve_one(&parent_path, &parent_dir, root, stack) {
                    if paths.is_empty() {
                        scope.aliases = parent.aliases;
                        scope.dir = parent.dir;
                        if base_url.is_none() {
                            scope.base_url = parent.base_url;
                        }
                    }
                }
            }
        }
        stack.pop();
        scope.aliases.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        Some(scope)
    }
    for (dir, path) in files {
        if let Some(scope) = resolve_one(&path, &dir, root, &mut Vec::new()) {
            if !scope.aliases.is_empty() || scope.base_url != "." {
                out.push(scope);
            }
        }
    }
    out.sort_by(|a, b| b.dir.len().cmp(&a.dir.len()));
    out
}

fn parse_js_package(text: &str, dir: String) -> Option<(String, JsPackage)> {
    let cleaned = strip_jsonc_comments(text);
    let value: serde_json::Value = serde_json::from_str(&cleaned).ok()?;
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let mut main = value
        .get("main")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .replace('\\', "/");
    if let Some(exports) = value.get("exports") {
        let entry = exports.get(".").or(Some(exports)).and_then(|item| {
            item.as_str()
                .or_else(|| item.get("import").and_then(|v| v.as_str()))
                .or_else(|| item.get("default").and_then(|v| v.as_str()))
                .or_else(|| item.get("require").and_then(|v| v.as_str()))
        });
        if let Some(entry) = entry {
            if main.is_empty() {
                main = entry.trim_start_matches("./").replace('\\', "/");
            }
        }
    }
    Some((
        name.to_string(),
        JsPackage {
            dir,
            main: main.trim_start_matches("./").to_string(),
            imports: parse_js_imports_field(&value),
        },
    ))
}

fn load_js_packages(root: &Path) -> Vec<(String, JsPackage)> {
    let mut out = Vec::new();
    visit_shallow_files(root, &["package.json"], |path, dir| {
        if dir == "node_modules" || dir.starts_with("node_modules/") {
            return;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Some(entry) = parse_js_package(&text, dir) {
                out.push(entry);
            }
        }
    });
    out.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    out
}

fn parse_js_imports_field(value: &serde_json::Value) -> Vec<(String, String)> {
    let Some(map) = value.get("imports").and_then(|item| item.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (pattern, target) in map {
        let prefix = pattern.trim_end_matches('*').to_string();
        if prefix.is_empty() {
            continue;
        }
        let mapped = match target {
            serde_json::Value::String(s) => s
                .trim_end_matches('*')
                .trim_start_matches("./")
                .replace('\\', "/"),
            serde_json::Value::Object(obj) => obj
                .get("import")
                .or_else(|| obj.get("default"))
                .or_else(|| obj.get("require"))
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .trim_end_matches('*')
                .trim_start_matches("./")
                .replace('\\', "/"),
            _ => continue,
        };
        if !mapped.is_empty() {
            out.push((prefix, mapped));
        }
    }
    out.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    out
}

fn load_rust_crate_srcs(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    visit_shallow_files(root, &["Cargo.toml"], |_, dir| {
        out.push(if dir.is_empty() {
            "src".to_string()
        } else {
            format!("{dir}/src")
        });
    });
    if !out.iter().any(|src| src == "src") {
        out.push("src".to_string());
    }
    out
}

fn rust_crate_src_for(rel: &str, crate_srcs: &[String]) -> String {
    let dir = rel_dir(rel);
    let mut best = "src".to_string();
    let mut best_len = 0usize;
    for src in crate_srcs {
        let crate_root = dirname_str(src);
        let matches = dir == src
            || dir.starts_with(&format!("{src}/"))
            || (!crate_root.is_empty()
                && (dir == crate_root || dir.starts_with(&format!("{crate_root}/"))));
        if matches && src.len() >= best_len {
            best_len = src.len();
            best = src.clone();
        }
    }
    best
}

fn expand_rust_use_spec(spec: &str) -> Vec<String> {
    let spec = spec.trim();
    let spec = if !spec.contains('{') {
        spec.split(" as ").next().unwrap_or(spec).trim()
    } else {
        spec
    };
    let Some(open) = spec.find('{') else {
        return vec![spec.to_string()];
    };
    let prefix = spec[..open].trim();
    let inner = spec[open + 1..].trim().trim_end_matches('}').trim();
    if inner.contains('{') {
        return vec![prefix.trim_end_matches(':').to_string()];
    }
    inner
        .split(',')
        .filter_map(|part| {
            let mut name = part.trim();
            if let Some(idx) = name.find(" as ") {
                name = name[..idx].trim();
            }
            if name.is_empty() {
                return None;
            }
            if name == "*" {
                return Some(prefix.trim_end_matches(':').to_string());
            }
            Some(format!("{prefix}{name}"))
        })
        .collect()
}

fn rust_mod_candidates(base: &str, parts: &[&str]) -> Vec<String> {
    if parts.is_empty() {
        return vec![
            path_join_norm(base, "lib.rs"),
            path_join_norm(base, "mod.rs"),
            format!("{base}.rs"),
        ];
    }
    let sub = parts.join("/");
    vec![
        path_join_norm(base, &format!("{sub}.rs")),
        path_join_norm(base, &format!("{sub}/mod.rs")),
        path_join_norm(base, &format!("{sub}/lib.rs")),
    ]
}

fn resolve_rust_use_path(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
    crate_src: &str,
) -> Option<String> {
    let segs: Vec<&str> = spec
        .split("::")
        .map(str::trim)
        .filter(|seg| !seg.is_empty() && *seg != "*")
        .collect();
    if segs.is_empty() {
        return None;
    }
    let (base, rest): (String, &[&str]) = if segs[0] == "crate" {
        (crate_src.to_string(), &segs[1..])
    } else if segs[0] == "super" || segs[0] == "self" {
        let stem = file_stem_rel(rel).unwrap_or("");
        let mut dir = if stem == "mod" || stem == "lib" || stem == "main" {
            rel_dir(rel).to_string()
        } else if rel_dir(rel).is_empty() {
            stem.to_string()
        } else {
            format!("{}/{}", rel_dir(rel), stem)
        };
        let mut i = 0usize;
        while i < segs.len() {
            match segs[i] {
                "self" => i += 1,
                "super" => {
                    dir = dirname_str(&dir);
                    i += 1;
                }
                _ => break,
            }
        }
        (dir, &segs[i..])
    } else {
        (crate_src.to_string(), segs.as_slice())
    };
    rust_mod_candidates(&base, rest)
        .into_iter()
        .find(|path| file_set.contains(path))
        .or_else(|| {
            if rest.is_empty() {
                return None;
            }
            rust_mod_candidates(&base, &rest[..rest.len() - 1])
                .into_iter()
                .find(|path| file_set.contains(path))
        })
}

fn resolve_ts_alias(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Option<String> {
    if spec.starts_with('.') {
        return None;
    }
    let importer_dir = rel_dir(rel);
    for scope in &index.ts_configs {
        let in_scope = scope.dir.is_empty()
            || importer_dir == scope.dir
            || importer_dir.starts_with(&format!("{}/", scope.dir));
        if !in_scope {
            continue;
        }
        for (prefix, targets) in &scope.aliases {
            let Some(rest) = spec.strip_prefix(prefix.as_str()) else {
                continue;
            };
            for target in targets {
                let mapped = format!("{target}{rest}");
                let base = path_join_norm(&scope.dir, &path_join_norm(&scope.base_url, &mapped));
                if let Some(hit) = resolve_js_base(&base, file_set) {
                    return Some(hit);
                }
            }
        }
        if scope.aliases.is_empty() {
            let base = path_join_norm(&scope.dir, &path_join_norm(&scope.base_url, spec));
            if let Some(hit) = resolve_js_base(&base, file_set) {
                return Some(hit);
            }
        }
    }
    None
}

fn resolve_js_hash_import(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Option<String> {
    if !spec.starts_with('#') {
        return None;
    }
    let importer_dir = rel_dir(rel);
    let mut pkgs: Vec<&JsPackage> = index
        .js_packages
        .iter()
        .map(|(_, pkg)| pkg)
        .filter(|pkg| {
            pkg.dir.is_empty()
                || importer_dir == pkg.dir
                || importer_dir.starts_with(&format!("{}/", pkg.dir))
        })
        .collect();
    pkgs.sort_by_key(|pkg| std::cmp::Reverse(pkg.dir.len()));
    for pkg in pkgs {
        for (prefix, target) in &pkg.imports {
            let Some(rest) = spec.strip_prefix(prefix.as_str()) else {
                continue;
            };
            let base = path_join_norm(&pkg.dir, &format!("{target}{rest}"));
            if let Some(hit) = resolve_js_base(&base, file_set) {
                return Some(hit);
            }
        }
    }
    None
}

fn resolve_js_package(
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Option<String> {
    if spec.starts_with('.') {
        return None;
    }
    for (name, pkg) in &index.js_packages {
        let rest = if spec == name {
            ""
        } else if let Some(tail) = spec.strip_prefix(&format!("{name}/")) {
            tail
        } else {
            continue;
        };
        if rest.is_empty() {
            if !pkg.main.is_empty() {
                let main = path_join_norm(&pkg.dir, &pkg.main);
                if let Some(hit) = resolve_js_base(&main, file_set) {
                    return Some(hit);
                }
            }
            for index_base in ["index", "src/index", "lib/index"] {
                let base = path_join_norm(&pkg.dir, index_base);
                if let Some(hit) = resolve_js_base(&base, file_set) {
                    return Some(hit);
                }
            }
        } else {
            let base = path_join_norm(&pkg.dir, rest);
            if let Some(hit) = resolve_js_base(&base, file_set) {
                return Some(hit);
            }
        }
    }
    None
}

fn elixir_module_from_rel(rel: &str) -> Option<String> {
    let lower = rel.to_ascii_lowercase();
    let tail = if let Some(idx) = lower.find("/lib/") {
        &rel[idx + 5..]
    } else if lower.starts_with("lib/") {
        &rel[4..]
    } else {
        return None;
    };
    let without_ext = tail
        .strip_suffix(".ex")
        .or_else(|| tail.strip_suffix(".exs"))?;
    let module = without_ext
        .split('/')
        .filter(|seg| !seg.is_empty())
        .map(|seg| {
            seg.split('_')
                .map(|part| {
                    let mut chars = part.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(".");
    (!module.is_empty()).then_some(module)
}

fn resolve_php_use(spec: &str, file_set: &HashSet<String>, index: &GraphIndex) -> Vec<String> {
    let mut cleaned = spec
        .trim()
        .trim_start_matches(['\\', '/'])
        .replace('/', "\\");
    for prefix in ["function ", "const "] {
        if let Some(rest) = cleaned.strip_prefix(prefix) {
            cleaned = rest.trim().to_string();
        }
    }
    if let Some(idx) = cleaned.find(" as ") {
        cleaned = cleaned[..idx].trim().to_string();
    }
    if cleaned.contains('{') {
        return Vec::new();
    }
    let mut best: Option<(usize, String)> = None;
    for (ns, dir) in &index.php_psr4 {
        if cleaned.starts_with(ns.as_str())
            && ns.len() >= best.as_ref().map(|(len, _)| *len).unwrap_or(0)
        {
            let tail = cleaned[ns.len()..].replace('\\', "/");
            best = Some((ns.len(), format!("{dir}{tail}.php")));
        }
    }
    if let Some((_, cand)) = best {
        let cand = cand.replace('\\', "/");
        if file_set.contains(&cand) {
            return vec![cand];
        }
    }
    let path = cleaned.replace('\\', "/");
    for cand in [
        format!("{path}.php"),
        format!("src/{path}.php"),
        format!("app/{path}.php"),
    ] {
        if file_set.contains(&cand) {
            return vec![cand];
        }
    }
    Vec::new()
}

fn resolve_dart_package(
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Option<String> {
    let rest = spec.strip_prefix("package:")?;
    let (pkg, path) = rest.split_once('/')?;
    let lib = index.dart_packages.get(pkg)?;
    let cand = path_join_norm(lib, path);
    file_set.contains(&cand).then_some(cand)
}

fn resolve_elixir(spec: &str, index: &GraphIndex) -> Vec<String> {
    let mut name = spec.trim().to_string();
    while name.contains('.') {
        if let Some(hits) = index.elixir_modules.get(&name) {
            return hits.clone();
        }
        match name.rfind('.') {
            Some(idx) => name = name[..idx].to_string(),
            None => break,
        }
    }
    index.elixir_modules.get(&name).cloned().unwrap_or_default()
}

fn resolve_swift(spec: &str, index: &GraphIndex) -> Vec<String> {
    let head = spec.split('.').next().unwrap_or(spec).trim();
    if head.is_empty() {
        return Vec::new();
    }
    index.swift_modules.get(head).cloned().unwrap_or_default()
}

fn resolve_scala(spec: &str, index: &GraphIndex) -> Vec<String> {
    let mut name = spec.trim().trim_end_matches('.').to_string();
    while !name.is_empty() {
        if let Some(hits) = index.scala_types.get(&name) {
            return hits.clone();
        }
        match name.rfind('.') {
            Some(idx) => name = name[..idx].to_string(),
            None => break,
        }
    }
    Vec::new()
}

fn resolve_objc_header(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Vec<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || (!norm.contains('.') && !norm.contains('/')) {
        return Vec::new();
    }
    let rel_c = path_join_norm(rel_dir(rel), &norm);
    if file_set.contains(&rel_c) {
        return vec![rel_c];
    }
    if let Some(hits) = index.objc_headers.get(&norm) {
        return hits.clone();
    }
    if let Some(base) = norm.rsplit('/').next() {
        if let Some(hits) = index.objc_headers.get(base) {
            return hits.clone();
        }
    }
    Vec::new()
}

// JS `_resolveGraphImport` dispatch (the direct, fileSet-backed leg).
fn resolve_graph_import(
    rel: &str,
    spec: &str,
    lang: &str,
    file_set: &HashSet<String>,
) -> Option<String> {
    match lang {
        "typescript" | "javascript" => resolve_js_like(rel, spec, file_set),
        "python" => resolve_py(rel, spec, file_set),
        "c" | "cpp" => resolve_include(rel, spec, file_set),
        "ruby" => resolve_ruby(rel, spec, file_set),
        "bash" => resolve_bash_source(rel, spec, file_set),
        "lua" => resolve_lua_require(spec, file_set),
        "dart" => resolve_dart_import(rel, spec, file_set),
        "r" => resolve_r_source(rel, spec, file_set),
        "php" => resolve_php_require(rel, spec, file_set),
        "zig" => resolve_zig(rel, spec, file_set),
        "rust" => resolve_rust_mod(rel, spec, file_set),
        "solidity" => resolve_solidity_import(rel, spec, file_set),
        "haskell" => resolve_haskell_import(rel, spec, file_set),
        _ => None,
    }
}

// JS `_parseGoModulePath`: /^\s*module\s+(\S+)\s*$/m.
fn parse_go_module_path(text: &str) -> String {
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("module") {
            if rest.starts_with(char::is_whitespace) {
                let mut toks = rest.split_whitespace();
                if let Some(tok) = toks.next() {
                    // `\S+\s*$` — exactly one token after `module`.
                    if toks.next().is_none() && !tok.is_empty() {
                        return tok.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

// JS `_findNearestGoModule` in repo-relative space. Walks up from the
// file's directory (inclusive of the repo root "") looking for a go.mod,
// reading + caching the module path of the nearest one found.
fn find_nearest_go_module(
    rel: &str,
    root: &Path,
    cache: &mut HashMap<String, Option<(String, String)>>,
) -> Option<(String, String)> {
    let mut dir = rel_dir(rel).to_string();
    loop {
        if let Some(cached) = cache.get(&dir) {
            return cached.clone();
        }
        let go_mod = root.join(&dir).join("go.mod");
        if go_mod.is_file() {
            let module_path = fs::read_to_string(&go_mod)
                .ok()
                .map(|t| parse_go_module_path(&t))
                .unwrap_or_default();
            let info = if module_path.is_empty() {
                None
            } else {
                Some((dir.clone(), module_path))
            };
            cache.insert(dir.clone(), info.clone());
            return info;
        }
        if dir.is_empty() {
            break;
        }
        dir = dirname_str(&dir);
    }
    None
}

// Relative path from an ancestor dir `from` to `to` (both repo-relative).
fn rel_strip_prefix(from: &str, to: &str) -> String {
    if from.is_empty() {
        to.to_string()
    } else if to == from {
        String::new()
    } else if let Some(tail) = to.strip_prefix(&format!("{}/", from)) {
        tail.to_string()
    } else {
        to.to_string()
    }
}

// JS goImportPath derivation (code-graph.mjs L2609-2611): join the module
// path with the file dir's offset from the module root.
fn go_import_path(
    rel: &str,
    root: &Path,
    cache: &mut HashMap<String, Option<(String, String)>>,
) -> String {
    let (module_root, module_path) = match find_nearest_go_module(rel, root, cache) {
        Some(m) => m,
        None => return String::new(),
    };
    let tail = rel_strip_prefix(&module_root, rel_dir(rel));
    let mut parts: Vec<&str> = Vec::new();
    if !module_path.is_empty() {
        parts.push(&module_path);
    }
    if !tail.is_empty() {
        parts.push(&tail);
    }
    let joined = parts.join("/");
    joined.trim_end_matches('/').to_string()
}

struct TsConfigScope {
    dir: String,
    base_url: String,
    aliases: Vec<(String, Vec<String>)>,
}

struct JsPackage {
    dir: String,
    main: String,
    imports: Vec<(String, String)>,
}

// In-memory analogue of JS `_buildGraphIndex` for the indexed resolvers
// (go/java/kotlin/csharp plus convention indexes). Values are repo-relative rels.
struct GraphIndex {
    package_members: HashMap<String, Vec<String>>,
    type_by_fqcn: HashMap<String, Vec<String>>,
    csharp_namespaces: HashMap<String, Vec<String>>,
    go_import_paths: HashMap<String, Vec<String>>,
    dart_packages: HashMap<String, String>,
    php_psr4: Vec<(String, String)>,
    elixir_modules: HashMap<String, Vec<String>>,
    swift_modules: HashMap<String, Vec<String>>,
    scala_types: HashMap<String, Vec<String>>,
    objc_headers: HashMap<String, Vec<String>>,
    ts_configs: Vec<TsConfigScope>,
    js_packages: Vec<(String, JsPackage)>,
    rust_crate_srcs: Vec<String>,
}

fn push_index_set(map: &mut HashMap<String, Vec<String>>, key: &str, value: &str) {
    if key.is_empty() || value.is_empty() {
        return;
    }
    let entry = map.entry(key.to_string()).or_default();
    if !entry.iter().any(|v| v == value) {
        entry.push(value.to_string());
    }
}

fn build_graph_index(records: &[FileRecord], root: &Path) -> GraphIndex {
    let mut index = GraphIndex {
        package_members: HashMap::new(),
        type_by_fqcn: HashMap::new(),
        csharp_namespaces: HashMap::new(),
        go_import_paths: HashMap::new(),
        dart_packages: load_dart_packages(root),
        php_psr4: load_php_psr4(root),
        elixir_modules: HashMap::new(),
        swift_modules: HashMap::new(),
        scala_types: HashMap::new(),
        objc_headers: HashMap::new(),
        ts_configs: load_ts_configs(root),
        js_packages: load_js_packages(root),
        rust_crate_srcs: load_rust_crate_srcs(root),
    };
    let mut go_mod_cache: HashMap<String, Option<(String, String)>> = HashMap::new();
    for rec in records {
        match rec.lang {
            "java" | "kotlin" => {
                if !rec.package_name.is_empty() {
                    push_index_set(&mut index.package_members, &rec.package_name, &rec.rel);
                }
                for type_name in &rec.top_level_types {
                    let fqcn = if rec.package_name.is_empty() {
                        type_name.clone()
                    } else {
                        format!("{}.{}", rec.package_name, type_name)
                    };
                    push_index_set(&mut index.type_by_fqcn, &fqcn, &rec.rel);
                }
            }
            "csharp" if !rec.namespace_name.is_empty() => {
                push_index_set(&mut index.csharp_namespaces, &rec.namespace_name, &rec.rel);
            }
            "go" => {
                let gip = go_import_path(&rec.rel, root, &mut go_mod_cache);
                if !gip.is_empty() {
                    push_index_set(&mut index.go_import_paths, &gip, &rec.rel);
                }
            }
            "elixir" => {
                if let Some(module) = elixir_module_from_rel(&rec.rel) {
                    push_index_set(&mut index.elixir_modules, &module, &rec.rel);
                }
            }
            "swift" => {
                if let Some(stem) = file_stem_rel(&rec.rel) {
                    push_index_set(&mut index.swift_modules, stem, &rec.rel);
                }
                let parts: Vec<&str> = rec.rel.split('/').collect();
                if let Some(i) = parts.iter().position(|part| *part == "Sources") {
                    if let Some(module) = parts.get(i + 1) {
                        push_index_set(&mut index.swift_modules, module, &rec.rel);
                    }
                }
            }
            "scala" => {
                if let Some(without) = rec
                    .rel
                    .strip_suffix(".scala")
                    .or_else(|| rec.rel.strip_suffix(".sc"))
                {
                    push_index_set(&mut index.scala_types, &without.replace('/', "."), &rec.rel);
                }
            }
            "objc" | "c" => {
                if let Some(name) = rec.rel.rsplit('/').next() {
                    if name.ends_with(".h") || name.ends_with(".m") || name.ends_with(".mm") {
                        push_index_set(&mut index.objc_headers, name, &rec.rel);
                        if let Some((parent, _)) = rec.rel.rsplit_once('/') {
                            if let Some(dir) = parent.rsplit('/').next() {
                                push_index_set(
                                    &mut index.objc_headers,
                                    &format!("{dir}/{name}"),
                                    &rec.rel,
                                );
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    index
}

// JS `_normalizeJavaLikeImport`.
fn normalize_java_like_import(spec: &str, index: &GraphIndex) -> String {
    let mut cleaned = strip_static_prefix(&normalize_import_spec(spec));
    if cleaned.ends_with(".*") {
        return cleaned;
    }
    while cleaned.contains('.') && !index.type_by_fqcn.contains_key(&cleaned) {
        cleaned = cleaned[..cleaned.rfind('.').unwrap()].to_string();
    }
    cleaned
}

// JS `_resolveIndexedGraphImport`: direct fileSet resolution first, then
// the per-language indexed fallbacks (go/java/kotlin/rust/csharp).
fn resolve_indexed_graph_import(
    rec: &FileRecord,
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Vec<String> {
    let normalized = normalize_import_spec(spec);
    if normalized.is_empty() {
        return Vec::new();
    }
    if let Some(direct) = resolve_graph_import(&rec.rel, &normalized, rec.lang, file_set) {
        return vec![direct];
    }

    match rec.lang {
        "javascript" | "typescript" => resolve_ts_alias(&rec.rel, &normalized, file_set, index)
            .or_else(|| resolve_js_hash_import(&rec.rel, &normalized, file_set, index))
            .or_else(|| resolve_js_package(&normalized, file_set, index))
            .into_iter()
            .collect(),
        "go" => {
            let relative = resolve_go_relative(&rec.rel, &normalized, file_set);
            if !relative.is_empty() {
                relative
            } else {
                index
                    .go_import_paths
                    .get(&normalized)
                    .cloned()
                    .unwrap_or_default()
            }
        }
        "java" | "kotlin" => {
            let mut cleaned = normalize_java_like_import(&normalized, index);
            if cleaned.ends_with(".*") {
                let pkg = &cleaned[..cleaned.len() - 2];
                return index.package_members.get(pkg).cloned().unwrap_or_default();
            }
            if let Some(hit) = index.type_by_fqcn.get(&cleaned) {
                return hit.clone();
            }
            while cleaned.split('.').count() > 1 {
                cleaned = cleaned[..cleaned.rfind('.').unwrap()].to_string();
                if let Some(hit) = index.type_by_fqcn.get(&cleaned) {
                    return hit.clone();
                }
            }
            Vec::new()
        }
        "rust" => {
            if normalized.starts_with("mod::") {
                return resolve_rust_mod(&rec.rel, &normalized, file_set)
                    .into_iter()
                    .collect();
            }
            let crate_src = rust_crate_src_for(&rec.rel, &index.rust_crate_srcs);
            let mut out = Vec::new();
            for one in expand_rust_use_spec(&normalized) {
                if let Some(hit) = resolve_rust_use_path(&rec.rel, &one, file_set, &crate_src) {
                    if !out.contains(&hit) {
                        out.push(hit);
                    }
                }
            }
            out
        }
        "csharp" => {
            let mut cleaned = strip_static_prefix(&normalized).trim().to_string();
            // `Alias = Some.Namespace` → resolve the aliased target.
            if let Some(eq) = cleaned.find('=') {
                let (lhs, rhs) = cleaned.split_at(eq);
                let lhs = lhs.trim();
                let is_ident = !lhs.is_empty()
                    && lhs.chars().enumerate().all(|(i, c)| {
                        if i == 0 {
                            c.is_ascii_alphabetic() || c == '_'
                        } else {
                            c.is_ascii_alphanumeric() || c == '_'
                        }
                    });
                if is_ident {
                    let rhs = rhs[1..].trim();
                    if !rhs.is_empty() {
                        cleaned = rhs.to_string();
                    }
                }
            }
            if let Some(hit) = index.csharp_namespaces.get(&cleaned) {
                return hit.clone();
            }
            while cleaned.contains('.') {
                cleaned = cleaned[..cleaned.rfind('.').unwrap()].to_string();
                if let Some(hit) = index.csharp_namespaces.get(&cleaned) {
                    return hit.clone();
                }
            }
            Vec::new()
        }
        // bash/lua/solidity/haskell resolve entirely via the direct fileSet
        // leg above (resolve_graph_import); they have no index-backed
        // fallback — a solidity spec that is not vendored in the tree and a
        // haskell module that is not in the source path are external
        // dependencies, not edges.
        "bash" | "lua" => Vec::new(),
        "r" => Vec::new(),
        "solidity" | "haskell" => Vec::new(),
        // A terraform module is a directory, so this one resolves to MANY
        // files and cannot use the single-answer direct leg.
        "hcl" => resolve_hcl_module(&rec.rel, &normalized, file_set),
        "dart" => resolve_dart_package(&normalized, file_set, index)
            .into_iter()
            .collect(),
        "php" => resolve_php_use(&normalized, file_set, index),
        "elixir" => resolve_elixir(&normalized, index),
        "objc" => resolve_objc_header(&rec.rel, &normalized, file_set, index),
        "swift" => resolve_swift(&normalized, index),
        "scala" => resolve_scala(&normalized, index),
        _ => Vec::new(),
    }
}

// Post-join: resolve every record's rawImports → resolvedImports (rel,
// deduped, order-preserving), then a reverse pass fills importedBy.
fn resolve_and_link(records: &mut [FileRecord], root: &Path, file_set: &HashSet<String>) {
    let index = build_graph_index(records, root);
    let resolved: Vec<Vec<String>> = records
        .par_iter()
        .map(|rec| {
            let mut out = Vec::new();
            let mut seen = HashSet::new();
            for spec in &rec.raw_imports {
                for dep in resolve_indexed_graph_import(rec, spec, file_set, &index) {
                    if dep != rec.rel && seen.insert(dep.clone()) {
                        out.push(dep);
                    }
                }
            }
            out
        })
        .collect();
    // Reverse edges (importedBy), in record order, deduped per target.
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
    for (i, deps) in resolved.iter().enumerate() {
        let importer = &records[i].rel;
        for dep in deps {
            let entry = reverse.entry(dep.clone()).or_default();
            if entry.last() != Some(importer) {
                entry.push(importer.clone());
            }
        }
    }
    for (i, rec) in records.iter_mut().enumerate() {
        rec.resolved_imports = resolved[i].clone();
        if let Some(importers) = reverse.remove(&rec.rel) {
            rec.imported_by = importers;
        }
    }
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
    let paths: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            let p = Path::new(f);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                root.join(p)
            }
        })
        .collect();
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
        Some(flag) if flag == "--scan" => match scan::run(root, &args[3..]) {
            Ok(()) => Ok(()),
            Err(scan::ScanError::Usage(message)) => {
                eprintln!("mixdog-graph: {message}");
                process::exit(2);
            }
            Err(scan::ScanError::Internal(message)) => Err(message),
        },
        // Outline debug dump: the raw rule output per file, for validating
        // outline rule files against real sources.
        Some(flag) if flag == "--outline" => match outline::run(root, &args[3..]) {
            Ok(()) => Ok(()),
            Err(scan::ScanError::Usage(message)) => {
                eprintln!("mixdog-graph: {message}");
                process::exit(2);
            }
            Err(scan::ScanError::Internal(message)) => Err(message),
        },
        Some(flag) if flag == "--langs" => scan::run_langs(),
        Some(flag) if flag == "--serve-search" => {
            serve_search::run();
            Ok(())
        }
        Some(sym) if !sym.is_empty() => {
            run_search(root, sym);
            Ok(())
        }
        _ => run_walk(root),
    };
    if let Err(error) = result {
        eprintln!("mixdog-graph: {error}");
        process::exit(1);
    }
}
