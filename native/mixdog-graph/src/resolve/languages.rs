// The direct, fileSet-backed resolution leg: one language's own rules for
// turning an import spec into a repo-relative path.
//
// Nothing here consults the GraphIndex — a spec resolves against the set of
// files the graph already indexed, or it resolves to nothing. `resolve_graph_import`
// at the bottom is the dispatch every language enters through.

use std::collections::HashSet;

use mixdog_graph::tokens;

use super::paths::{
    dirname_str, file_stem_rel, is_same_or_under, normalize_import_spec, path_join_norm, rel_dir,
};

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

// JS `_resolveJsLikeImport` (relative-only). Candidate exts plus index.*,
// and the .js→.ts retry via the extension-stripped base.
fn resolve_js_like(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    if !spec.starts_with('.') {
        return None;
    }
    let base = path_join_norm(rel_dir(rel), spec);
    resolve_js_base(&base, file_set)
}

pub(crate) fn resolve_js_base(base: &str, file_set: &HashSet<String>) -> Option<String> {
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

// A spec that names a path relative to the importing file: join it against
// the importer's directory and keep it only when the graph indexed that file.
// An empty spec names nothing, and an absolute `/foo` is a filesystem location
// this repository cannot name, so joining it importer-relative would forge a
// bogus repo path.
fn resolve_relative_to_importer(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
) -> Option<String> {
    let norm = normalize_import_spec(spec);
    if norm.is_empty() || norm.starts_with('/') {
        return None;
    }
    let candidate = path_join_norm(rel_dir(rel), &norm);
    file_set.contains(&candidate).then_some(candidate)
}

// Bash `source path` / `. path`: resolve a relative path against the
// importing file's dir. Only relative specs (`./x`, `../x`, or a bare
// `x.sh`) are resolvable in fileSet space; absolute/PATH-looked-up specs
// have no repo-relative target and return None.
fn resolve_bash_source(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    resolve_relative_to_importer(rel, spec, file_set)
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
    if has_uri_scheme(&norm) {
        return None;
    }
    resolve_relative_to_importer(rel, &norm, file_set)
}

// R `source("path.R")` (or a relative `library`/`require` arg, rare): resolve
// the quoted path against the importing file's dir. Library/require names that
// reference installed packages are not relative paths and won't match the
// fileSet, so only an actual relative source path resolves.
fn resolve_r_source(rel: &str, spec: &str, file_set: &HashSet<String>) -> Option<String> {
    resolve_relative_to_importer(rel, spec, file_set)
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

// Every indexed file with extension `ext` sitting DIRECTLY inside the
// repo-relative directory `dir`, sorted. No recursion: a nested directory is a
// separate terraform module and a separate Go package, never part of this one.
fn files_directly_in(dir: &str, ext: &str, file_set: &HashSet<String>) -> Vec<String> {
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let mut hits: Vec<String> = file_set
        .iter()
        .filter(|path| {
            if !path.ends_with(ext) {
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

// Terraform local module: `module "x" { source = "./modules/x" }`.
//
// A TERRAFORM MODULE IS A DIRECTORY, not a file: terraform loads every `.tf`
// in it as one configuration, and no single file is "the module". So the
// source path resolves to the directory and the edge fans out to EVERY `.tf`
// file directly inside it (no recursion — nested directories are separate
// modules). Only local paths are edges: the outline rule already restricts
// `source` to `./`, `../` and `/`, and an absolute `/…` path is a filesystem
// location this repository cannot name, so it resolves to nothing.
pub(crate) fn resolve_hcl_module(rel: &str, spec: &str, file_set: &HashSet<String>) -> Vec<String> {
    let norm = normalize_import_spec(spec);
    if !(norm.starts_with("./") || norm.starts_with("../")) {
        return Vec::new();
    }
    files_directly_in(&path_join_norm(rel_dir(rel), &norm), ".tf", file_set)
}

pub(crate) fn resolve_go_relative(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
) -> Vec<String> {
    if !spec.starts_with('.') {
        return Vec::new();
    }
    files_directly_in(&path_join_norm(rel_dir(rel), spec), ".go", file_set)
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

pub(crate) fn resolve_rust_mod(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
) -> Option<String> {
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

pub(crate) fn rust_crate_src_for(rel: &str, crate_srcs: &[String]) -> String {
    let dir = rel_dir(rel);
    let mut best = "src".to_string();
    let mut best_len = 0usize;
    for src in crate_srcs {
        let crate_root = dirname_str(src);
        let matches = is_same_or_under(dir, src)
            || (!crate_root.is_empty() && is_same_or_under(dir, &crate_root));
        if matches && src.len() >= best_len {
            best_len = src.len();
            best = src.clone();
        }
    }
    best
}

pub(crate) fn expand_rust_use_spec(spec: &str) -> Vec<String> {
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

pub(crate) fn resolve_rust_use_path(
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

// JS `_resolveGraphImport` dispatch (the direct, fileSet-backed leg).
pub(crate) fn resolve_graph_import(
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
