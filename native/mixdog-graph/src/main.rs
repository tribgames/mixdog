// mixdog-graph — native fast-path for code-graph build.
//
// Stage-2: walk a project root, identify source files by extension,
// read each file, and extract per-language metadata:
//   - identifier tokens (Unicode-aware, language-agnostic)
//   - raw imports (per-language regex)
//   - package / namespace names (Java/Kotlin/C#)
//   - go package + top-level type names (Java/Kotlin/C#/Go)
//
// Output (JSONL on stdout, one object per file):
//   {"rel": "...", "lang": "...", "fp": "...", "size": N,
//    "tokens": [...], "rawImports": [...], "packageName": "...",
//    "namespaceName": "...", "goPackageName": "...",
//    "topLevelTypes": [...]}
//
// Per-file errors are silent — Node-side keeps its own JS fallback for
// any language Rust skipped. Exits 0 regardless of partial failures.

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
use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, Query, QueryCursor};

// Mirrors CODE_GRAPH_MAX_FILES on the Node side. --walk caps parse work
// here so large repos don't pay full parse cost before truncation.
const MAX_FILES: usize = 10_000;

#[derive(Serialize)]
struct FileRecord {
    rel: String,
    lang: &'static str,
    fp: String,
    size: u64,
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

// Map a language NAME (as sent by JS, e.g. "java") to the interned
// &'static str the resolvers/index switch on. Unknown names map to "".
fn lang_static(name: &str) -> &'static str {
    match name {
        "javascript" => "javascript",
        "typescript" => "typescript",
        "python" => "python",
        "go" => "go",
        "rust" => "rust",
        "java" => "java",
        "kotlin" => "kotlin",
        "csharp" => "csharp",
        "ruby" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "c" => "c",
        "cpp" => "cpp",
        "scala" => "scala",
        "bash" => "bash",
        "lua" => "lua",
        "dart" => "dart",
        "objc" => "objc",
        "elixir" => "elixir",
        "zig" => "zig",
        "r" => "r",
        _ => "",
    }
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
        tokens: Vec::new(),
        raw_imports: meta.raw_imports,
        package_name: meta.package_name,
        namespace_name: meta.namespace_name,
        go_package_name: meta.go_package_name,
        top_level_types: meta.top_level_types,
        resolved_imports: Vec::new(),
        imported_by: Vec::new(),
        symbols: Vec::new(),
    }
}

fn lang_for(ext: &str) -> Option<&'static str> {
    match ext {
        "js" | "mjs" | "cjs" | "jsx" => Some("javascript"),
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "py" => Some("python"),
        "go" => Some("go"),
        "rs" => Some("rust"),
        "java" => Some("java"),
        "kt" | "kts" => Some("kotlin"),
        "cs" => Some("csharp"),
        "rb" => Some("ruby"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => Some("cpp"),
        "scala" | "sc" => Some("scala"),
        "sh" | "bash" | "zsh" => Some("bash"),
        "lua" => Some("lua"),
        "dart" => Some("dart"),
        // Objective-C `.m` / Objective-C++ `.mm`.
        "m" | "mm" => Some("objc"),
        "ex" | "exs" => Some("elixir"),
        "zig" => Some("zig"),
        // lang_for receives the raw extension (no case normalization), so the
        // uppercase `.R` form must be matched explicitly alongside `.r`.
        "r" | "R" => Some("r"),
        _ => None,
    }
}

struct Patterns {
    token: Regex,
    js_import: Regex,
    py_from_import: Regex,
    py_import: Regex,
    go_import_block: Regex,
    go_import_quoted: Regex,
    rust_use: Regex,
    java_kotlin_import: Regex,
    csharp_using: Regex,
    c_cpp_include: Regex,
    ruby_require: Regex,
    php_use: Regex,
    swift_import: Regex,
    scala_import: Regex,
    bash_source: Regex,
    lua_require: Regex,
    dart_import: Regex,
    objc_import: Regex,
    elixir_import: Regex,
    zig_import: Regex,
    r_require: Regex,
    java_kotlin_package: Regex,
    csharp_namespace: Regex,
    go_package: Regex,
    type_decl_jks: Regex,
    go_type: Regex,
}

impl Patterns {
    fn new() -> Self {
        let token = Regex::new(r"[$@]?[\p{XID_Start}_][\p{XID_Continue}]*[!?]?").unwrap();
        let js_import = Regex::new(
            r#"(?m)(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)"#,
        )
        .unwrap();
        let py_from_import = Regex::new(r"(?m)^\s*from\s+([.\w]+)\s+import\s+").unwrap();
        let py_import = Regex::new(r"(?m)^\s*import\s+([A-Za-z0-9_., ]+)").unwrap();
        let go_import_block =
            Regex::new(r#"(?ms)import\s*(?:\(([\s\S]*?)\)|"([^"]+)")"#).unwrap();
        let go_import_quoted = Regex::new(r#""([^"]+)""#).unwrap();
        let rust_use = Regex::new(r"(?m)^\s*use\s+([^;]+);").unwrap();
        let java_kotlin_import = Regex::new(r"(?m)^\s*import\s+([^\n;]+);?$").unwrap();
        let csharp_using = Regex::new(r"(?m)^\s*using\s+([^;]+);$").unwrap();
        let c_cpp_include = Regex::new(r#"(?m)^\s*#include\s+"([^"]+)""#).unwrap();
        let ruby_require =
            Regex::new(r#"(?m)^\s*require(?:_relative)?\s+["']([^"']+)["']"#).unwrap();
        let php_use = Regex::new(r"(?m)^\s*use\s+([^;]+);$").unwrap();
        // Swift: `import Foo` / `import Foo.Bar` / `import class Foo.Bar`.
        let swift_import = Regex::new(
            r"(?m)^\s*import\s+(?:typealias\s+|struct\s+|class\s+|enum\s+|protocol\s+|let\s+|var\s+|func\s+)?([A-Za-z_][A-Za-z0-9_.]*)",
        )
        .unwrap();
        // Scala: `import x.y.z`, `import x.y.{a, b}`, `import x.y._`. Capture
        // the dotted prefix; selector braces/wildcard are dropped downstream.
        let scala_import =
            Regex::new(r"(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)").unwrap();
        // Bash: `source path` or `. path` (POSIX dot-include).
        let bash_source = Regex::new(
            r#"(?m)^\s*(?:source|\.)\s+["']?([^\s"';]+)["']?"#,
        )
        .unwrap();
        // Lua: `require("x")`, `require 'x'`, `require[[x]]`.
        let lua_require = Regex::new(
            r#"require\s*(?:\(\s*)?["']([^"']+)["']"#,
        )
        .unwrap();
        // Dart: `import 'package:x/y.dart';` / `import './local.dart';`
        // (also export/part). Capture the quoted uri. `part of 'lib.dart'` is
        // deliberately NOT captured: it points BACK to the owning library, and
        // the forward `part 'x.dart'` edge already records the library→part
        // pair, so the reverse edge would be redundant.
        let dart_import = Regex::new(
            r#"(?m)^\s*(?:import|export|part)\s+["']([^"']+)["']"#,
        )
        .unwrap();
        // Objective-C: `#import <Foo/Bar.h>` / `#import "Bar.h"` and the
        // module form `@import UIKit;`. Capture whichever spec form matched.
        let objc_import = Regex::new(
            r#"(?m)^\s*(?:#import\s+(?:<([^>]+)>|"([^"]+)")|@import\s+([A-Za-z_][A-Za-z0-9_.]*))"#,
        )
        .unwrap();
        // Elixir: `import`/`alias`/`require`/`use Foo.Bar`. Capture the dotted
        // module alias (begins with an uppercase letter).
        let elixir_import = Regex::new(
            r"(?m)^\s*(?:import|alias|require|use)\s+([A-Z][A-Za-z0-9_.]*)",
        )
        .unwrap();
        // Zig: `@import("std")` / `@import("./x.zig")`. Capture the quoted spec.
        let zig_import = Regex::new(
            r#"@import\s*\(\s*"([^"]+)"\s*\)"#,
        )
        .unwrap();
        // R: `library(x)` / `require(x)` (bare or quoted name) and
        // `source("path.R")` (quoted path). Capture whichever form matched.
        let r_require = Regex::new(
            r#"(?m)(?:library|require)\s*\(\s*["']?([A-Za-z_][A-Za-z0-9_.]*)["']?\s*\)|source\s*\(\s*["']([^"']+)["']\s*\)"#,
        )
        .unwrap();
        let java_kotlin_package =
            Regex::new(r"(?m)^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?\s*$").unwrap();
        let csharp_namespace =
            Regex::new(r"(?m)^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*[;{]").unwrap();
        let go_package =
            Regex::new(r"(?m)^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\s*$").unwrap();
        let type_decl_jks = Regex::new(
            r"\b(?:class|interface|enum|record|object|struct)\s+([A-Za-z_][A-Za-z0-9_]*)",
        )
        .unwrap();
        let go_type =
            Regex::new(r"(?m)^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b").unwrap();
        Patterns {
            token,
            js_import,
            py_from_import,
            py_import,
            go_import_block,
            go_import_quoted,
            rust_use,
            java_kotlin_import,
            csharp_using,
            c_cpp_include,
            ruby_require,
            php_use,
            swift_import,
            scala_import,
            bash_source,
            lua_require,
            dart_import,
            objc_import,
            elixir_import,
            zig_import,
            r_require,
            java_kotlin_package,
            csharp_namespace,
            go_package,
            type_decl_jks,
            go_type,
        }
    }
}

fn extract_tokens(text: &str, p: &Patterns) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in p.token.find_iter(text) {
        let s = m.as_str();
        if seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out
}

// String-aware comment stripper for JS-like languages. Replaces `//`
// line comments and `/* */` block comments with whitespace (preserving
// line breaks so regex anchors `^\s*` still work). String literals
// (single/double/backtick) are passed through verbatim so `//` inside
// a quoted spec doesn't get stripped. Mirrors JS's
// `_stripCommentsForImports` closely enough for import detection on
// js/ts/jsx/tsx/java/kotlin/csharp/c/cpp/rust files.
fn strip_comments_curly(text: &str, mask_strings: bool) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0usize;
    let n = bytes.len();
    let mut in_string: Option<u8> = None;
    while i < n {
        let c = bytes[i];
        if let Some(delim) = in_string {
            if c == b'\\' && i + 1 < n {
                if mask_strings {
                    // Mask both bytes; ASCII-space substitution preserves
                    // byte length and UTF-8 validity.
                    out.push(b' ');
                    let nxt = bytes[i + 1];
                    out.push(if nxt == b'\n' { b'\n' } else { b' ' });
                } else {
                    // Import-spec extraction keeps string contents verbatim,
                    // so copy the escape pair as-is.
                    out.push(c);
                    out.push(bytes[i + 1]);
                }
                i += 2;
                continue;
            }
            if c == delim {
                in_string = None;
                out.push(c);
            } else if c == b'\n' {
                // Preserve newlines (template literals can span lines) so
                // downstream `^\s*` anchors keep their line geometry.
                out.push(b'\n');
            } else if mask_strings {
                // Mask every other byte so symbol search does not fire on
                // identifiers embedded in string literals. Per-byte ASCII-
                // space substitution preserves byte length and UTF-8 validity.
                out.push(b' ');
            } else {
                // Import-spec extraction needs the quoted module path inside
                // the literal, so keep the byte verbatim.
                out.push(c);
            }
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
            // block comment: skip until */; preserve newlines so line
            // anchors downstream still work
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
    String::from_utf8(out).expect("strip_comments_curly preserves UTF-8 invariant")
}

// Python/Ruby/shell-style # line-comment stripper. Simpler than the
// curly-brace variant because there's no block-comment form to track.
fn strip_comments_hash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        if let Some(idx) = line.find('#') {
            out.push_str(&line[..idx]);
            if line.ends_with('\n') {
                out.push('\n');
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

// Lua line/block-comment stripper. Lua comments are `--` to end of line, and
// `--[[ ... ]]` (with optional `=` level markers, e.g. `--[==[ ... ]==]`) for
// block comments. Replaces comment bytes with spaces (newlines preserved) so
// downstream line anchors keep their geometry. String literals are not tracked
// (import detection only needs `require("x")` outside comments, and a `--`
// inside a string is rare enough to tolerate).
fn strip_comments_lua(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0usize;
    let n = bytes.len();
    while i < n {
        // A comment starts only at `--`.
        if bytes[i] == b'-' && i + 1 < n && bytes[i + 1] == b'-' {
            // Space-replace the `--` so tokens on either side stay separated
            // (e.g. `requ--[[x]]ire` must not join into `require`).
            out.push(b' ');
            out.push(b' ');
            i += 2;
            // Possible long-bracket block comment: `[`, optional `=`*, `[`.
            let j = i;
            if j < n && bytes[j] == b'[' {
                let mut level = 0usize;
                let mut k = j + 1;
                while k < n && bytes[k] == b'=' {
                    level += 1;
                    k += 1;
                }
                if k < n && bytes[k] == b'[' {
                    // Long block comment: skip until matching `]` `=`*level `]`.
                    // Space-replace the opener bytes (`[` `=`*level `[`).
                    for _ in j..=k {
                        out.push(b' ');
                    }
                    i = k + 1;
                    loop {
                        if i >= n {
                            break;
                        }
                        if bytes[i] == b']' {
                            let mut m = i + 1;
                            let mut eq = 0usize;
                            while m < n && bytes[m] == b'=' {
                                eq += 1;
                                m += 1;
                            }
                            if eq == level && m < n && bytes[m] == b']' {
                                // Space-replace the closer (`]` `=`*level `]`).
                                for _ in i..=m {
                                    out.push(b' ');
                                }
                                i = m + 1;
                                break;
                            }
                        }
                        if bytes[i] == b'\n' {
                            out.push(b'\n');
                        } else {
                            out.push(b' ');
                        }
                        i += 1;
                    }
                    continue;
                }
            }
            // Line comment: skip to end of line, keep the newline.
            while i < n && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).expect("strip_comments_lua preserves UTF-8 invariant")
}

fn extract_raw_imports(text: &str, lang: &str, p: &Patterns) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |s: &str| {
        let trimmed = s.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    };
    // Comment-strip per language family before applying import regex so
    // commented-out imports don't appear as live dependencies. JS-style
    // // + /* */ for the curly-brace family; # for Python/Ruby/shell.
    let cleaned: String;
    let scan_text: &str = match lang {
        "javascript" | "typescript" | "java" | "kotlin" | "csharp"
        | "c" | "cpp" | "rust" | "go" | "php" | "scala"
        // Dart/Obj-C/Zig share the `//` + `/* */` comment family. Their import
        // specs live in quoted strings (dart uri, objc header, zig @import),
        // so keep string bodies verbatim (mask_strings = false) like JS.
        | "dart" | "objc" | "zig" => {
            cleaned = strip_comments_curly(text, false);
            cleaned.as_str()
        }
        // Swift imports are never inside string literals (unlike JS, where a
        // module spec lives in a quoted string), so mask string bodies to
        // stop a literal `import Foo` inside a multiline string from matching.
        // LIMITATION: strip_comments_curly does not track nested block
        // comments, so Swift's nested `/* /* */ */` closes at the first `*/`;
        // a stray `import` in the still-open outer comment tail could match.
        // Acceptable for import detection (rare, and only over-reports a dep).
        "swift" => {
            cleaned = strip_comments_curly(text, true);
            cleaned.as_str()
        }
        "python" | "ruby" | "bash" | "elixir" | "r" => {
            cleaned = strip_comments_hash(text);
            cleaned.as_str()
        }
        "lua" => {
            cleaned = strip_comments_lua(text);
            cleaned.as_str()
        }
        _ => text,
    };
    match lang {
        "javascript" | "typescript" => {
            for cap in p.js_import.captures_iter(scan_text) {
                let spec = cap
                    .get(1)
                    .or_else(|| cap.get(2))
                    .or_else(|| cap.get(3))
                    .map(|m| m.as_str());
                if let Some(s) = spec {
                    push(s);
                }
            }
        }
        "python" => {
            for cap in p.py_from_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
            for cap in p.py_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    for part in m.as_str().split(',') {
                        let base = part.trim().split_whitespace().next().unwrap_or("");
                        push(base);
                    }
                }
            }
        }
        "go" => {
            for cap in p.go_import_block.captures_iter(scan_text) {
                if let Some(direct) = cap.get(2) {
                    push(direct.as_str());
                    continue;
                }
                if let Some(block) = cap.get(1) {
                    for inner in p.go_import_quoted.captures_iter(block.as_str()) {
                        if let Some(m) = inner.get(1) {
                            push(m.as_str());
                        }
                    }
                }
            }
        }
        "rust" => {
            for cap in p.rust_use.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "java" | "kotlin" => {
            for cap in p.java_kotlin_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "csharp" => {
            for cap in p.csharp_using.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "c" | "cpp" => {
            for cap in p.c_cpp_include.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "ruby" => {
            for cap in p.ruby_require.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "php" => {
            for cap in p.php_use.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "swift" => {
            for cap in p.swift_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "scala" => {
            for cap in p.scala_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    // The regex stops at `{` (so `import x.y.{a,b}` captures
                    // `x.y.`) but the `_` wildcard is a valid identifier char,
                    // so `import x.y._` captures `x.y._`. Strip a trailing `_`
                    // wildcard segment and any trailing dot to leave just the
                    // dotted-identifier prefix.
                    let mut spec = m.as_str().trim();
                    if let Some(stripped) = spec.strip_suffix("._") {
                        spec = stripped;
                    }
                    push(spec.trim_end_matches('.'));
                }
            }
        }
        "bash" => {
            for cap in p.bash_source.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "lua" => {
            for cap in p.lua_require.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "dart" => {
            for cap in p.dart_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "objc" => {
            for cap in p.objc_import.captures_iter(scan_text) {
                // Group 1 = `<...>` header, 2 = `"..."` header, 3 = `@import`
                // module. Exactly one matches per capture.
                let spec = cap
                    .get(1)
                    .or_else(|| cap.get(2))
                    .or_else(|| cap.get(3))
                    .map(|m| m.as_str());
                if let Some(s) = spec {
                    push(s);
                }
            }
        }
        "elixir" => {
            for cap in p.elixir_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "zig" => {
            for cap in p.zig_import.captures_iter(scan_text) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
        "r" => {
            for cap in p.r_require.captures_iter(scan_text) {
                // Group 1 = library/require name, 2 = source("path").
                let spec = cap.get(1).or_else(|| cap.get(2)).map(|m| m.as_str());
                if let Some(s) = spec {
                    push(s);
                }
            }
        }
        _ => {}
    }
    out
}

fn extract_package(text: &str, lang: &str, p: &Patterns) -> String {
    match lang {
        "java" | "kotlin" => p
            .java_kotlin_package
            .captures(text)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_namespace(text: &str, lang: &str, p: &Patterns) -> String {
    match lang {
        "csharp" => p
            .csharp_namespace
            .captures(text)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_go_package(text: &str, p: &Patterns) -> String {
    p.go_package
        .captures(text)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .unwrap_or_default()
}

fn extract_top_level_types(text: &str, lang: &str, p: &Patterns) -> Vec<String> {
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

// Tree-sitter symbol extraction across every supported language
// (js/ts/py/go/rs/java/c/cpp/cs/ruby/php). The parser knows real token
// boundaries, so comments, string literals, and control-flow keywords
// (`if`, `for`, ...) are never mistaken for declarations.
#[derive(Serialize)]
struct SymbolInfo {
    name: String,
    line: u32,
    // End line (1-indexed) of the full declaration node, captured via the
    // `@def` query capture. Lets JS-side enclosing-symbol resolution test
    // `line <= callSite <= endLine` instead of guessing from declaration
    // order alone. For patterns without a `@def` capture (wrapper bindings),
    // end_line falls back to `line`.
    #[serde(rename = "endLine")]
    end_line: u32,
    // Full declaration range for column-precise enclosing resolution on
    // minified / same-line code (multiple decls sharing one physical line).
    // Columns are 1-based to match the reference scanner's `match.index + 1`
    // (1-based char column); ASCII same-line code has byte == char.
    #[serde(rename = "startLine")]
    start_line: u32,
    #[serde(rename = "startCol")]
    start_col: u32,
    #[serde(rename = "endCol")]
    end_col: u32,
    kind: &'static str,
}

fn extract_source_symbols(text: &str, lang: &str) -> Vec<SymbolInfo> {
    let (language, query_src, kinds) = match lang {
        "typescript" => (
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            r#"
            (function_declaration name: (identifier) @name) @def
            (function_signature name: (identifier) @name) @def
            (class_declaration name: (type_identifier) @name) @def
            (abstract_class_declaration name: (type_identifier) @name) @def
            (interface_declaration name: (type_identifier) @name) @def
            (type_alias_declaration name: (type_identifier) @name) @def
            (enum_declaration name: (identifier) @name) @def
            (method_definition name: (property_identifier) @name) @def
            (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def))
            (program (lexical_declaration (variable_declarator name: (identifier) @name) @def))
            (export_statement (variable_declaration (variable_declarator name: (identifier) @name) @def))
            (program (variable_declaration (variable_declarator name: (identifier) @name) @def))
            (function_expression name: (identifier) @name) @def
            (generator_function name: (identifier) @name) @def
            (class name: (type_identifier) @name) @def
            "#,
            &["function", "function", "class", "class", "interface", "type", "enum", "method", "binding", "binding", "binding", "binding", "function", "function", "class"][..],
        ),
        "javascript" => (
            tree_sitter_javascript::LANGUAGE.into(),
            r#"
            (function_declaration name: (identifier) @name) @def
            (class_declaration name: (identifier) @name) @def
            (method_definition name: (property_identifier) @name) @def
            (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def))
            (program (lexical_declaration (variable_declarator name: (identifier) @name) @def))
            (export_statement (variable_declaration (variable_declarator name: (identifier) @name) @def))
            (program (variable_declaration (variable_declarator name: (identifier) @name) @def))
            (function_expression name: (identifier) @name) @def
            (generator_function name: (identifier) @name) @def
            (class name: (identifier) @name) @def
            "#,
            &["function", "class", "method", "binding", "binding", "binding", "binding", "function", "function", "class"][..],
        ),
        "python" => (
            tree_sitter_python::LANGUAGE.into(),
            r#"
            (function_definition name: (identifier) @name) @def
            (class_definition name: (identifier) @name) @def
"#,
            &["function", "class"][..],
        ),
        "go" => (
            tree_sitter_go::LANGUAGE.into(),
            r#"
            (function_declaration name: (identifier) @name) @def
            (method_declaration name: (field_identifier) @name) @def
            (type_spec name: (type_identifier) @name) @def
            "#,
            &["function", "method", "type"][..],
        ),
        "rust" => (
            tree_sitter_rust::LANGUAGE.into(),
            r#"
            (function_item name: (identifier) @name) @def
            (struct_item name: (type_identifier) @name) @def
            (enum_item name: (type_identifier) @name) @def
            (trait_item name: (type_identifier) @name) @def
            (mod_item name: (identifier) @name) @def
            (const_item name: (identifier) @name) @def
            "#,
            &["function", "struct", "enum", "trait", "module", "const"][..],
        ),
        "java" => (
            tree_sitter_java::LANGUAGE.into(),
            r#"
            (class_declaration name: (identifier) @name) @def
            (interface_declaration name: (identifier) @name) @def
            (enum_declaration name: (identifier) @name) @def
            (method_declaration name: (identifier) @name) @def
            (constructor_declaration name: (identifier) @name) @def
            (record_declaration name: (identifier) @name) @def
            "#,
            &["class", "interface", "enum", "method", "constructor", "record"][..],
        ),
        "c" => (
            tree_sitter_c::LANGUAGE.into(),
            r#"
            (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
            (function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def
            (struct_specifier name: (type_identifier) @name) @def
            (enum_specifier name: (type_identifier) @name) @def
            "#,
            &["function", "function", "struct", "enum"][..],
        ),
        "cpp" => (
            tree_sitter_cpp::LANGUAGE.into(),
            r#"
            (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
            (function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def
            (class_specifier name: (type_identifier) @name) @def
            (struct_specifier name: (type_identifier) @name) @def
            "#,
            &["function", "function", "class", "struct"][..],
        ),
        "csharp" => (
            tree_sitter_c_sharp::LANGUAGE.into(),
            r#"
            (class_declaration name: (identifier) @name) @def
            (interface_declaration name: (identifier) @name) @def
            (struct_declaration name: (identifier) @name) @def
            (method_declaration name: (identifier) @name) @def
            (enum_declaration name: (identifier) @name) @def
            (constructor_declaration name: (identifier) @name) @def
            (local_function_statement name: (identifier) @name) @def
            (record_declaration name: (identifier) @name) @def
            "#,
            &["class", "interface", "struct", "method", "enum", "constructor", "local-function", "record"][..],
        ),
        "ruby" => (
            tree_sitter_ruby::LANGUAGE.into(),
            r#"
            (method name: (identifier) @name) @def
            (method name: (setter) @name) @def
            (singleton_method name: (identifier) @name) @def
            (class name: (constant) @name) @def
            (module name: (constant) @name) @def
            "#,
            &["method", "method", "method", "class", "module"][..],
        ),
        "php" => (
            tree_sitter_php::LANGUAGE_PHP.into(),
            r#"
            (function_definition name: (name) @name) @def
            (class_declaration name: (name) @name) @def
            (method_declaration name: (name) @name) @def
            (interface_declaration name: (name) @name) @def
            "#,
            &["function", "class", "method", "interface"][..],
        ),
        "kotlin" => (
            tree_sitter_kotlin_ng::LANGUAGE.into(),
            // tree-sitter-kotlin-ng exposes the declared name via a `name:`
            // field of type `identifier` on all three declaration nodes
            // (the legacy tree-sitter-kotlin grammar used unnamed
            // simple_identifier/type_identifier children with no field).
            r#"
            (function_declaration name: (identifier) @name) @def
            (class_declaration name: (identifier) @name) @def
            (object_declaration name: (identifier) @name) @def
            "#,
            &["function", "class", "object"][..],
        ),
        "swift" => (
            tree_sitter_swift::LANGUAGE.into(),
            // `class_declaration` is the shared node for class/struct/enum/
            // actor/extension; the `declaration_kind` field carries the
            // keyword token, so match it to split struct/enum from class.
            r#"
            (function_declaration name: (simple_identifier) @name) @def
            (class_declaration declaration_kind: "class" name: (type_identifier) @name) @def
            (class_declaration declaration_kind: "struct" name: (type_identifier) @name) @def
            (class_declaration declaration_kind: "enum" name: (type_identifier) @name) @def
            (class_declaration declaration_kind: "actor" name: (type_identifier) @name) @def
            (protocol_declaration name: (type_identifier) @name) @def
            "#,
            &["function", "class", "struct", "enum", "actor", "protocol"][..],
        ),
        "scala" => (
            tree_sitter_scala::LANGUAGE.into(),
            r#"
            (function_definition name: (identifier) @name) @def
            (class_definition name: (identifier) @name) @def
            (object_definition name: (identifier) @name) @def
            (trait_definition name: (identifier) @name) @def
            "#,
            &["function", "class", "object", "trait"][..],
        ),
        "bash" => (
            tree_sitter_bash::LANGUAGE.into(),
            r#"
            (function_definition name: (word) @name) @def
            "#,
            &["function"][..],
        ),
        "lua" => (
            tree_sitter_lua::LANGUAGE.into(),
            // `function_declaration` covers `function f()`, `local function f()`
            // (aliased to the same node), `function M.f()` (dot index) and
            // `function M:f()` (method index). Anonymous `function_definition`
            // (assigned to a variable) has no name and is intentionally skipped.
            r#"
            (function_declaration name: (identifier) @name) @def
            (function_declaration name: (dot_index_expression field: (identifier) @name)) @def
            (function_declaration name: (method_index_expression method: (identifier) @name)) @def
            "#,
            &["function", "function", "function"][..],
        ),
        "dart" => (
            tree_sitter_dart::LANGUAGE.into(),
            // Dart names live behind `signature:` wrappers. A `method_declaration`
            // (signature + body fields) nests a signature inside its
            // `method_signature`; capturing @def on `method_declaration` spans the
            // body so endLine covers the closing brace. The nested signature is a
            // `function_signature` (plain method), `getter_signature`,
            // `setter_signature`, or `operator_signature` — each is captured so
            // accessors and operators become symbols, not just plain methods.
            // Accessors are class members, so they map to `method` (consistent
            // with the surrounding `method_declaration`). The operator name is the
            // `binary_operator` token (`+`, `==`, …); the unnamed `[]`/`[]=`/`~`
            // operator tokens are NOT identifier-bindable, so those specific
            // operators are the one documented omission. class/mixin/enum/extension
            // expose `name:`.
            r#"
            (class_declaration name: (identifier) @name) @def
            (mixin_declaration name: (identifier) @name) @def
            (enum_declaration name: (identifier) @name) @def
            (extension_declaration name: (identifier) @name) @def
            (function_declaration signature: (function_signature name: (identifier) @name)) @def
            (method_declaration signature: (method_signature (function_signature name: (identifier) @name))) @def
            (method_declaration signature: (method_signature (getter_signature name: (identifier) @name))) @def
            (method_declaration signature: (method_signature (setter_signature name: (identifier) @name))) @def
            (method_declaration signature: (method_signature (operator_signature operator: (binary_operator) @name))) @def
            "#,
            &["class", "mixin", "enum", "extension", "function", "method", "method", "method", "method"][..],
        ),
        "objc" => (
            tree_sitter_objc::LANGUAGE.into(),
            // @interface/@implementation → class; the FIRST child identifier is
            // the class name (`.` anchor stops the superclass identifier from
            // also matching). @protocol → protocol. Obj-C methods carry the
            // selector head as the first `identifier` child of the method node;
            // plain C functions reuse the C `function_declarator` shape.
            r#"
            (class_interface . (identifier) @name) @def
            (class_implementation . (identifier) @name) @def
            (protocol_declaration . (identifier) @name) @def
            (method_declaration (identifier) @name) @def
            (method_definition (identifier) @name) @def
            (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
            "#,
            &["class", "class", "protocol", "method", "method", "function"][..],
        ),
        "elixir" => (
            tree_sitter_elixir::LANGUAGE.into(),
            // Elixir has no dedicated def nodes — defmodule/def/defp/defmacro
            // are generic `call` nodes. APPROACH: capture the call target AND
            // the name, then filter by the target keyword in Rust below (the
            // QueryCursor does NOT auto-evaluate #eq?/#any-of? predicates). A
            // module name is an `(alias)`; a function/macro clause nests a
            // `(call target: (identifier))`, with a `when`-guard variant whose
            // clause sits inside a `binary_operator`.
            r#"
            (call target: (identifier) @target (arguments (alias) @name)) @def
            (call target: (identifier) @target (arguments (call target: (identifier) @name))) @def
            (call target: (identifier) @target (arguments (binary_operator left: (call target: (identifier) @name) operator: "when"))) @def
            (call target: (identifier) @target (arguments (identifier) @name)) @def
            "#,
            // Kinds are resolved per-match from the @target keyword, so the
            // pattern-indexed slice only needs placeholders here.
            &["module", "function", "function", "function"][..],
        ),
        "zig" => (
            tree_sitter_zig::LANGUAGE.into(),
            // `fn name()` → function_declaration with a `name:` field. Container
            // types are `const X = struct/enum/union {...}`: the grammar exposes
            // the binding name as the first `identifier` child of the
            // `variable_declaration` and the container kind as the sibling
            // struct/enum/union_declaration node.
            r#"
            (function_declaration name: (identifier) @name) @def
            (variable_declaration (identifier) @name (struct_declaration)) @def
            (variable_declaration (identifier) @name (enum_declaration)) @def
            (variable_declaration (identifier) @name (union_declaration)) @def
            "#,
            &["function", "struct", "enum", "union"][..],
        ),
        "r" => (
            tree_sitter_r::LANGUAGE.into(),
            // R function defs are assignments: `name <- function(...)` or
            // `name = function(...)`. Capture the lhs identifier; the `rhs:
            // (function_definition)` constraint excludes ordinary value
            // assignments.
            r#"
            (binary_operator lhs: (identifier) @name operator: "<-" rhs: (function_definition)) @def
            (binary_operator lhs: (identifier) @name operator: "=" rhs: (function_definition)) @def
            "#,
            &["function", "function"][..],
        ),
        _ => return Vec::new(),
    };
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let tree = match parser.parse(text, None) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let query = match Query::new(&language, query_src) {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };
    let src = text.as_bytes();
    // Resolve capture slots once: `@name` is the identifier, `@def` (when the
    // pattern declares it) is the full declaration node whose end row is the
    // body end. Patterns without `@def` (wrapper bindings) yield None here.
    let name_idx = query.capture_index_for_name("name");
    let def_idx = query.capture_index_for_name("def");
    // Elixir resolves a symbol's kind from the def-form keyword (the `call`
    // target), not the pattern index, since defmodule/def/defp/defmacro all
    // share the generic `call` node. Non-Elixir queries declare no @target,
    // so this stays None and the pattern-indexed `kinds` slice is used as-is.
    let target_idx = query.capture_index_for_name("target");
    let mut cursor = QueryCursor::new();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut matches = cursor.matches(&query, tree.root_node(), src);
    while let Some(m) = matches.next() {
        // Invariant: `kinds` is sized to match the query's pattern count above.
        // A drift would be a programmer bug, not runtime fallback.
        let mut kind = kinds[m.pattern_index];
        let mut name_node = None;
        let mut def_node = None;
        let mut target_node = None;
        for cap in m.captures {
            if Some(cap.index) == name_idx {
                name_node = Some(cap.node);
            } else if Some(cap.index) == def_idx {
                def_node = Some(cap.node);
            } else if Some(cap.index) == target_idx {
                target_node = Some(cap.node);
            }
        }
        // Elixir: filter generic `call` matches by the def-form keyword and
        // map it to the symbol kind. A keyword that is not a definition form
        // (import/alias/require/use, control-flow, arbitrary calls) is skipped
        // so only real declarations become symbols. The QueryCursor never
        // evaluates #any-of?/#eq? itself, so this is the manual equivalent.
        if target_idx.is_some() {
            let kw = target_node
                .and_then(|n| n.utf8_text(src).ok())
                .unwrap_or("");
            kind = match kw {
                "defmodule" | "defprotocol" | "defimpl" => "module",
                "def" | "defp" => "function",
                "defmacro" | "defmacrop" => "macro",
                _ => continue,
            };
        }
        let name_node = match name_node {
            Some(n) => n,
            None => continue,
        };
        if let Ok(name) = name_node.utf8_text(src) {
            if name.is_empty() {
                continue;
            }
            let line = name_node.start_position().row as u32 + 1;
            // `@def` spans the whole declaration; without it, fall back to the
            // name node so non-body symbols still serialize a coherent range.
            let range_node = def_node.unwrap_or(name_node);
            let start_line = range_node.start_position().row as u32 + 1;
            let start_col = range_node.start_position().column as u32 + 1;
            let end_line = range_node.end_position().row as u32 + 1;
            let end_col = range_node.end_position().column as u32;
            if seen.insert((name.to_string(), line)) {
                out.push(SymbolInfo {
                    name: name.to_string(),
                    line,
                    end_line,
                    start_line,
                    start_col,
                    end_col,
                    kind,
                });
            }
        }
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

fn run_search(root: &Path, symbol: &str) {
    let escaped = regex::escape(symbol);
    // Use a simple non-anchored regex and emulate Unicode-aware word
    // boundary via lookbehind-style char checks (the regex crate's
    // default disables lookbehind for linear-time guarantees).
    let re_simple = match Regex::new(&format!("({})", escaped)) {
        Ok(r) => r,
        Err(_) => return,
    };
    // Build an ID_Continue test using regex (single-char match)
    let id_continue = Regex::new(r"\p{XID_Continue}").unwrap();

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
            let lang = match lang_for(ext) {
                Some(l) => l,
                None => return Vec::new(),
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
            // Mask comments/strings so identifiers inside them don't
            // produce false call-sites. Per-language family.
            let masked: String = match lang {
                "javascript" | "typescript" | "java" | "kotlin" | "csharp"
                | "c" | "cpp" | "rust" | "go" | "php" | "swift" | "scala"
                | "dart" | "objc" | "zig" => {
                    strip_comments_curly(&text, true)
                }
                "python" | "ruby" | "bash" | "elixir" | "r" => strip_comments_hash(&text),
                "lua" => strip_comments_lua(&text),
                _ => text.clone(),
            };
            let mut out = Vec::new();
            // Scan masked text line-by-line; emit corresponding
            // unmasked line text for display.
            let original_lines: Vec<&str> = text.lines().collect();
            for (i, line) in masked.lines().enumerate() {
                if !line.contains(symbol) {
                    continue;
                }
                for m in re_simple.find_iter(line) {
                    let start = m.start();
                    let end = m.end();
                    // Unicode-aware word boundary emulation: check chars
                    // immediately before/after the match aren't
                    // ID_Continue. `$` is also OK as JS-style prefix.
                    let before_ok = if start == 0 {
                        true
                    } else {
                        let prev_ch = line[..start].chars().last();
                        match prev_ch {
                            None => true,
                            Some(c) => !id_continue.is_match(&c.to_string()) && c != '$',
                        }
                    };
                    let after_ok = if end >= line.len() {
                        true
                    } else {
                        let next_ch = line[end..].chars().next();
                        match next_ch {
                            None => true,
                            // Mirror the before_ok check: `$` is JS-style
                            // identifier-continue too, so `foo` inside
                            // `foo$bar` must not match.
                            Some(c) => !id_continue.is_match(&c.to_string()) && c != '$',
                        }
                    };
                    if !before_ok || !after_ok {
                        continue;
                    }
                    let display = original_lines
                        .get(i)
                        .map(|s| s.trim())
                        .unwrap_or("")
                        .to_string();
                    // Take first 80 chars of trimmed display line.
                    let trimmed = if display.len() > 80 {
                        display.chars().take(80).collect::<String>()
                    } else {
                        display
                    };
                    out.push(SearchHit {
                        rel: rel.clone(),
                        line: (i + 1) as u32,
                        col: (start + 1) as u32,
                        text: trimmed,
                    });
                }
            }
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
// Returns None for unreadable/non-UTF8 files so the graph isn't poisoned with
// empty records that masquerade as real parses.
fn parse_file_from(src: &SrcFile, patterns: &Patterns) -> Option<FileRecord> {
    let lang = src.lang;
    let text = fs::read_to_string(&src.path).ok()?;
    let tokens = extract_tokens(&text, patterns);
    let raw_imports = extract_raw_imports(&text, lang, patterns);
    let package_name = extract_package(&text, lang, patterns);
    let namespace_name = extract_namespace(&text, lang, patterns);
    let go_package_name = if lang == "go" {
        extract_go_package(&text, patterns)
    } else {
        String::new()
    };
    let top_level_types = extract_top_level_types(&text, lang, patterns);
    let symbols = extract_source_symbols(&text, lang);
    Some(FileRecord {
        rel: src.rel.clone(),
        lang,
        fp: fingerprint_for(&src.rel, src.size, src.mtime_ms),
        size: src.size,
        tokens,
        raw_imports,
        package_name,
        namespace_name,
        go_package_name,
        top_level_types,
        resolved_imports: Vec::new(),
        imported_by: Vec::new(),
        symbols,
    })
}

// Stat-and-parse a single path (used by --files, where paths come from the
// caller, not the walk). One metadata read, then parse_file_from.
fn parse_file(path: &Path, root: &Path, patterns: &Patterns) -> Option<FileRecord> {
    let lang = path.extension().and_then(|s| s.to_str()).and_then(lang_for)?;
    let meta = fs::metadata(path).ok()?;
    let size = meta.len();
    if size > 2 * 1024 * 1024 {
        return None;
    }
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    parse_file_from(&SrcFile { path: path.to_path_buf(), rel, lang, size, mtime_ms }, patterns)
}

fn emit_records(records: &[FileRecord]) {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    for rec in records {
        let line = match serde_json::to_string(rec) {
            Ok(s) => s,
            Err(_) => continue,
        };
        use std::io::Write;
        let _ = writeln!(handle, "{}", line);
    }
}

// Collect source files under root with metadata read exactly once. Applies
// every drop condition (lang, readable metadata, 2MB cap) before sorting, so
// the filtered+sorted list is the single source of truth: run_walk truncates
// it and run_manifest takes it whole, so run_walk parses exactly the first
// MAX_FILES of the manifest (JS `indexed`).
fn collect_source_files(root: &Path) -> Vec<SrcFile> {
    // Phase 1 (sequential walk, no stat): gather candidate paths + lang. The
    // ignore-crate walk is inherently sequential, but doing zero I/O here keeps
    // it cheap.
    let candidates: Vec<(PathBuf, &'static str)> = WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(false)
        .build()
        .filter_map(Result::ok)
        .filter(|d| d.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|d| {
            let path = d.path();
            let lang = path.extension().and_then(|s| s.to_str()).and_then(lang_for)?;
            Some((path.to_path_buf(), lang))
        })
        .collect();
    // Phase 2 (parallel): one stat per candidate for size/mtime + the 2MB gate.
    let mut files: Vec<SrcFile> = candidates
        .par_iter()
        .filter_map(|(path, lang)| {
            let meta = fs::metadata(path).ok()?;
            let size = meta.len();
            if size > 2 * 1024 * 1024 {
                return None;
            }
            let rel = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(SrcFile { path: path.clone(), rel, lang, size, mtime_ms })
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
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
                if parts.last().map_or(true, |p| *p == "..") {
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
        if base.ends_with(ext) {
            return base[..base.len() - ext.len()].to_string();
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
    let base_no_ext = strip_js_ext(&base);
    let candidates = [
        base.clone(),
        format!("{}.ts", base),
        format!("{}.tsx", base),
        format!("{}.js", base),
        format!("{}.jsx", base),
        format!("{}.mjs", base),
        format!("{}.cjs", base),
        format!("{}.ts", base_no_ext),
        format!("{}.tsx", base_no_ext),
        format!("{}.js", base_no_ext),
        format!("{}.jsx", base_no_ext),
        format!("{}.mjs", base_no_ext),
        format!("{}.cjs", base_no_ext),
        path_join_norm(&base, "index.ts"),
        path_join_norm(&base, "index.tsx"),
        path_join_norm(&base, "index.js"),
        path_join_norm(&base, "index.jsx"),
        path_join_norm(&base, "index.mjs"),
        path_join_norm(&base, "index.cjs"),
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
    let candidates = [
        format!("{}.py", target),
        path_join_norm(&target, "__init__.py"),
    ];
    candidates.into_iter().find(|p| file_set.contains(p))
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
    None
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
    let candidates = [
        format!("{}.lua", base),
        path_join_norm(&base, "init.lua"),
    ];
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
        // Obj-C `#import`/`@import`, Elixir `import/alias/...`, and Zig
        // `@import` of the std/package graph name modules/frameworks/SDK
        // headers, not repo-relative file paths (Obj-C header includes that DO
        // map to a path are out of scope here), so there is no fileSet target.
        // Documented unsupported — never a silent fallthrough.
        "objc" | "elixir" | "zig" => None,
        // Swift/scala module-system resolution (SwiftPM/Gradle module graphs,
        // package-name → file mapping) is out of scope; their imports name
        // modules, not file paths, so there is no fileSet target to resolve.
        "swift" | "scala" => None,
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

// In-memory analogue of JS `_buildGraphIndex` for the indexed resolvers
// (go/java/kotlin/csharp). Values are repo-relative rels.
struct GraphIndex {
    package_members: HashMap<String, Vec<String>>,
    type_by_fqcn: HashMap<String, Vec<String>>,
    csharp_namespaces: HashMap<String, Vec<String>>,
    go_import_paths: HashMap<String, Vec<String>>,
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
            "csharp" => {
                if !rec.namespace_name.is_empty() {
                    push_index_set(&mut index.csharp_namespaces, &rec.namespace_name, &rec.rel);
                }
            }
            "go" => {
                let gip = go_import_path(&rec.rel, root, &mut go_mod_cache);
                if !gip.is_empty() {
                    push_index_set(&mut index.go_import_paths, &gip, &rec.rel);
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
        "go" => index
            .go_import_paths
            .get(&normalized)
            .cloned()
            .unwrap_or_default(),
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
            let mut mod_path = normalized.clone();
            if let Some(stripped) = mod_path.strip_prefix("crate::") {
                mod_path = stripped.to_string();
            }
            if let Some(stripped) = mod_path.strip_prefix("::") {
                mod_path = stripped.to_string();
            }
            let parts: Vec<&str> = mod_path
                .split("::")
                .filter(|p| !p.is_empty() && *p != "*" && *p != "self" && *p != "super")
                .collect();
            if parts.is_empty() {
                return Vec::new();
            }
            for i in (1..=parts.len()).rev() {
                let sub = parts[..i].join("/");
                let candidates = [
                    path_join_norm("", &format!("{}.rs", sub)),
                    path_join_norm(&sub, "mod.rs"),
                ];
                if let Some(hit) = candidates.into_iter().find(|p| file_set.contains(p)) {
                    return vec![hit];
                }
            }
            Vec::new()
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
        // bash/lua resolve entirely via the direct fileSet leg above
        // (resolve_graph_import); they have no index-backed fallback.
        "bash" | "lua" => Vec::new(),
        // Dart/R resolve entirely via the direct fileSet leg above
        // (resolve_graph_import: dart relative import, r source path); they
        // have no index-backed fallback.
        "dart" | "r" => Vec::new(),
        // Obj-C / Elixir / Zig name frameworks/modules/std packages, not
        // repo-relative file targets — out of scope. Documented unsupported
        // rather than a silent fallthrough.
        "objc" | "elixir" | "zig" => Vec::new(),
        // Swift/scala module-system resolution (SwiftPM/Gradle package graphs)
        // is out of scope — no fileSet/index target — so report unresolved
        // rather than silently falling through.
        "swift" | "scala" => Vec::new(),
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
                    if seen.insert(dep.clone()) {
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
            if entry.last().map_or(true, |v| v != importer) {
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

fn run_walk(root: &Path) {
    let patterns = Patterns::new();
    let mut files = collect_source_files(root);
    // Cap cold parse work at MAX_FILES so large repos never pay the full
    // native parse cost just to be truncated afterwards.
    files.truncate(MAX_FILES);
    let mut records: Vec<FileRecord> = files
        .par_iter()
        .filter_map(|s| parse_file_from(s, &patterns))
        .collect();
    // fileSet = every parsed record's rel; resolve imports + dependents.
    let file_set: HashSet<String> = records.iter().map(|r| r.rel.clone()).collect();
    resolve_and_link(&mut records, root, &file_set);
    emit_records(&records);
}

fn run_files(root: &Path, files: &[String]) {
    let patterns = Patterns::new();
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
    let fresh: Vec<FileRecord> = paths
        .par_iter()
        .filter_map(|p| parse_file(p.as_path(), root, &patterns))
        .collect();

    // Design-A protocol: stdin is JSONL, ONE LINE PER REUSED NODE, each a
    // ReusedMeta (rel/lang/rawImports/package/namespace/goPackage/types).
    // Deserialize into lightweight records so the GraphIndex + resolution
    // see the WHOLE graph, not just the freshly-parsed subset. Malformed
    // lines are skipped silently (partial input never poisons the graph).
    let reused: Vec<FileRecord> = {
        use std::io::Read;
        let mut buf = String::new();
        let _ = std::io::stdin().read_to_string(&mut buf);
        buf.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<ReusedMeta>(l).ok())
            .filter(|m| !m.rel.is_empty())
            .map(record_from_reused)
            .collect()
    };

    // ALL nodes = fresh parsed + reused metas. Index + resolution run over
    // the union so reused nodes resolve and the package/type index is whole.
    let mut records: Vec<FileRecord> = fresh;
    records.extend(reused);

    // fileSet = every node's rel (fresh + reused). Empty stdin → fallback to
    // fresh rels only (subset behaviour, same as before reused metas existed).
    let file_set: HashSet<String> = records.iter().map(|r| r.rel.clone()).collect();

    resolve_and_link(&mut records, root, &file_set);

    // Fresh nodes emit a full FileRecord; reused nodes emit a lightweight
    // record (rel + resolvedImports — empty tokens/symbols/rawImports are
    // skipped by serde, importedBy is ignored by JS).
    emit_records(&records);
}

// Manifest mode: emit fp/rel/size/lang only, no text parsing. Reuses the
// metadata already read by collect_source_files.
fn parse_meta_from(src: &SrcFile) -> FileRecord {
    FileRecord {
        rel: src.rel.clone(),
        lang: src.lang,
        fp: fingerprint_for(&src.rel, src.size, src.mtime_ms),
        size: src.size,
        tokens: Vec::new(),
        raw_imports: Vec::new(),
        package_name: String::new(),
        namespace_name: String::new(),
        go_package_name: String::new(),
        top_level_types: Vec::new(),
        resolved_imports: Vec::new(),
        imported_by: Vec::new(),
        symbols: Vec::new(),
    }
}

fn run_manifest(root: &Path) {
    // Full manifest — every source file, no MAX_FILES cap. fp-only, so even
    // huge repos stay cheap, and the Node side hashes the full set for the
    // change-detect signature.
    let files = collect_source_files(root);
    let records: Vec<FileRecord> = files
        .par_iter()
        .map(parse_meta_from)
        .collect();
    emit_records(&records);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cwd = match args.get(1) {
        Some(p) if !p.is_empty() => p.clone(),
        _ => {
            eprintln!("usage: mixdog-graph <cwd> [<symbol> | --files <path>... | --manifest]");
            process::exit(2);
        }
    };
    let root = Path::new(&cwd);
    if !root.is_dir() {
        eprintln!("mixdog-graph: not a directory: {}", cwd);
        process::exit(2);
    }
    match args.get(2) {
        Some(flag) if flag == "--files" => run_files(root, &args[3..]),
        Some(flag) if flag == "--manifest" => run_manifest(root),
        Some(sym) if !sym.is_empty() => run_search(root, sym),
        _ => run_walk(root),
    }
}
