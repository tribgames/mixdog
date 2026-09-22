// Project manifests read from the tree, not from the fileSet.
//
// This is the only part of the resolution layer that touches the filesystem:
// pubspec/composer/tsconfig/package.json/Cargo.toml/go.mod declare where a
// package's sources live, and the indexed resolvers need those declarations
// before they can map a spec to a repo-relative path. Everything else in
// `resolve` is pure string work over the fileSet.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::paths::{path_join_norm, rel_dir, rel_strip_prefix};

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

/// Child entries in a fixed order. `fs::read_dir` hands back whatever order
/// the filesystem happens to have, so two manifests competing for the same key
/// would otherwise win arbitrarily — and differently between runs or machines.
fn sorted_dir_entries(dir: &Path) -> Vec<fs::DirEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    entries
}

/// Longest key first, then the key itself: a TOTAL order. Length alone leaves
/// equal-length keys tied, which made the winning manifest depend on directory
/// traversal order.
pub(crate) fn by_key_length_desc(left: &str, right: &str) -> std::cmp::Ordering {
    right.len().cmp(&left.len()).then_with(|| left.cmp(right))
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
        for entry in sorted_dir_entries(dir) {
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

pub(crate) fn load_dart_packages(root: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut consider = |yaml: PathBuf, lib_dir: String| {
        if let Ok(text) = fs::read_to_string(&yaml) {
            if let Some(name) = parse_pubspec_name(&text) {
                out.insert(name, lib_dir);
            }
        }
    };
    consider(root.join("pubspec.yaml"), "lib".to_string());
    for entry in sorted_dir_entries(root) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().replace('\\', "/");
        let yaml = path.join("pubspec.yaml");
        if yaml.is_file() {
            consider(yaml, format!("{name}/lib"));
        }
        for child in sorted_dir_entries(&path) {
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

pub(crate) fn load_php_psr4(root: &Path) -> Vec<(String, String)> {
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
    for entry in sorted_dir_entries(root) {
        let path = entry.path().join("composer.json");
        if path.is_file() {
            consider(path, entry.file_name().to_string_lossy().replace('\\', "/"));
        }
    }
    // Longest namespace first, so `resolve_php_use` takes the most specific
    // PSR-4 root and never depends on which composer.json was read first.
    out.sort_by(|left, right| by_key_length_desc(&left.0, &right.0));
    out
}

pub(crate) struct TsConfigScope {
    pub(crate) dir: String,
    pub(crate) base_url: String,
    pub(crate) aliases: Vec<(String, Vec<String>)>,
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

pub(crate) fn load_ts_configs(root: &Path) -> Vec<TsConfigScope> {
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
        scope
            .aliases
            .sort_by(|left, right| by_key_length_desc(&left.0, &right.0));
        Some(scope)
    }
    for (dir, path) in files {
        if let Some(scope) = resolve_one(&path, &dir, root, &mut Vec::new()) {
            if !scope.aliases.is_empty() || scope.base_url != "." {
                out.push(scope);
            }
        }
    }
    out.sort_by(|left, right| by_key_length_desc(&left.dir, &right.dir));
    out
}

pub(crate) struct JsPackage {
    pub(crate) dir: String,
    pub(crate) main: String,
    pub(crate) imports: Vec<(String, String)>,
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

pub(crate) fn load_js_packages(root: &Path) -> Vec<(String, JsPackage)> {
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
    out.sort_by(|left, right| by_key_length_desc(&left.0, &right.0));
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
    out.sort_by(|left, right| by_key_length_desc(&left.0, &right.0));
    out
}

pub(crate) fn load_rust_crate_srcs(root: &Path) -> Vec<String> {
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
        dir = super::paths::dirname_str(&dir);
    }
    None
}

// JS goImportPath derivation (code-graph.mjs L2609-2611): join the module
// path with the file dir's offset from the module root.
pub(crate) fn go_import_path(
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
