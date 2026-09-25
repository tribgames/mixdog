// =====================================================================
// Import resolution + dependents (ported from the JS code-graph.mjs
// import-resolution layer, L658-954). All paths here are repo-relative
// and forward-slash normalized (same form as `FileRecord.rel`); the
// fileSet is a HashSet of those rels. Resolution that the JS layer did
// in absolute-path space is done here in repo-relative space — the root
// directory maps to the empty string "".
// =====================================================================
//
// MODULES
// -------
//   * `paths`     — the repo-relative path algebra every leg shares.
//   * `manifests` — pubspec/composer/tsconfig/package.json/Cargo.toml/go.mod,
//                   the only part of this layer that reads the filesystem.
//   * `languages` — the direct, fileSet-backed leg, one language at a time.
//
// This file owns the GraphIndex those manifests and records build, the
// index-backed fallbacks, and `resolve_and_link` — the single entry point
// `main.rs` calls.

mod languages;
mod manifests;
mod paths;

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rayon::prelude::*;

use crate::FileRecord;
use languages::{
    expand_rust_use_spec, resolve_go_relative, resolve_graph_import, resolve_hcl_module,
    resolve_js_base, resolve_rust_mod, resolve_rust_use_path, rust_crate_src_for,
};
use manifests::{
    by_key_length_desc, go_import_path, load_dart_packages, load_js_packages, load_php_psr4,
    load_rust_crate_srcs, load_ts_configs, JsPackage, TsConfigScope,
};
use paths::{file_stem_rel, is_same_or_under, normalize_import_spec, path_join_norm, rel_dir};

// Case-insensitive strip of a leading `static\s+` (Java/C# static imports).
fn strip_static_prefix(s: &str) -> String {
    let keyword = "static".len();
    if s.get(..keyword)
        .is_some_and(|head| head.eq_ignore_ascii_case("static"))
        && s[keyword..].starts_with(char::is_whitespace)
    {
        return s[keyword..].trim_start().to_string();
    }
    s.to_string()
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
        if !(scope.dir.is_empty() || is_same_or_under(importer_dir, &scope.dir)) {
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
        .filter(|pkg| pkg.dir.is_empty() || is_same_or_under(importer_dir, &pkg.dir))
        .collect();
    pkgs.sort_by(|left, right| by_key_length_desc(&left.dir, &right.dir));
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
    // `php_psr4` is ordered longest-namespace-first, so the FIRST match is the
    // most specific one and a later equal-length namespace must not replace it.
    // An empty PSR-4 key is a legal catch-all root, so "no match yet" is
    // distinguished from "matched length 0" rather than compared as a length.
    for (ns, dir) in &index.php_psr4 {
        if !cleaned.starts_with(ns.as_str())
            || best.as_ref().is_some_and(|(len, _)| ns.len() <= *len)
        {
            continue;
        }
        let tail = cleaned[ns.len()..].replace('\\', "/");
        best = Some((ns.len(), format!("{dir}{tail}.php")));
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

/// Longest dotted prefix of `spec` that the index knows, from the full name
/// down to the bare head.
///
/// Four languages walked this ladder with four spellings of the same loop.
/// They agree on the candidate sequence and on taking the FIRST hit; the two
/// corners where the old spellings differed cannot arise, because none of
/// these indexes carries an empty key or a key ending in `.`:
///   * an empty `spec` looked up `""` in three of them and nothing in the
///     fourth;
///   * a `spec` ending in `.` looked up that trailing-dot form first in two
///     of them.
fn resolve_by_dotted_prefix(spec: &str, index: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut name = spec.trim().trim_end_matches('.').to_string();
    loop {
        if let Some(hits) = index.get(&name) {
            return hits.clone();
        }
        match name.rfind('.') {
            Some(idx) => name.truncate(idx),
            None => return Vec::new(),
        }
    }
}

fn resolve_elixir(spec: &str, index: &GraphIndex) -> Vec<String> {
    resolve_by_dotted_prefix(spec, &index.elixir_modules)
}

fn resolve_swift(spec: &str, index: &GraphIndex) -> Vec<String> {
    let head = spec.split('.').next().unwrap_or(spec).trim();
    if head.is_empty() {
        return Vec::new();
    }
    index.swift_modules.get(head).cloned().unwrap_or_default()
}

fn resolve_scala(spec: &str, index: &GraphIndex) -> Vec<String> {
    resolve_by_dotted_prefix(spec, &index.scala_types)
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

// In-memory analogue of JS `_buildGraphIndex` for the indexed resolvers
// (go/java/kotlin/csharp plus convention indexes). Values are repo-relative rels.
#[derive(Default)]
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
    // The manifest-backed fields; the record-backed maps start empty and are
    // filled below.
    let mut index = GraphIndex {
        dart_packages: load_dart_packages(root),
        php_psr4: load_php_psr4(root),
        ts_configs: load_ts_configs(root),
        js_packages: load_js_packages(root),
        rust_crate_srcs: load_rust_crate_srcs(root),
        ..GraphIndex::default()
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

/// A wildcard import names a PACKAGE; anything else is a type, resolved by its
/// longest known FQCN prefix.
fn resolve_java_like(spec: &str, index: &GraphIndex) -> Vec<String> {
    let cleaned = normalize_java_like_import(spec, index);
    if let Some(pkg) = cleaned.strip_suffix(".*") {
        return index.package_members.get(pkg).cloned().unwrap_or_default();
    }
    resolve_by_dotted_prefix(&cleaned, &index.type_by_fqcn)
}

/// `mod::` paths name a file directly; a `use` path may expand into several
/// specs, each resolved against the importer's crate root.
fn resolve_rust_indexed(
    rel: &str,
    spec: &str,
    file_set: &HashSet<String>,
    index: &GraphIndex,
) -> Vec<String> {
    if spec.starts_with("mod::") {
        return resolve_rust_mod(rel, spec, file_set).into_iter().collect();
    }
    let crate_src = rust_crate_src_for(rel, &index.rust_crate_srcs);
    let mut out = Vec::new();
    for one in expand_rust_use_spec(spec) {
        if let Some(hit) = resolve_rust_use_path(rel, &one, file_set, &crate_src) {
            if !out.contains(&hit) {
                out.push(hit);
            }
        }
    }
    out
}

/// `using Alias = Some.Namespace` resolves the aliased target; the name is
/// then matched against the longest known namespace prefix.
fn resolve_csharp(spec: &str, index: &GraphIndex) -> Vec<String> {
    let mut cleaned = strip_static_prefix(spec).trim().to_string();
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
    resolve_by_dotted_prefix(&cleaned, &index.csharp_namespaces)
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
        "java" | "kotlin" => resolve_java_like(&normalized, index),
        "rust" => resolve_rust_indexed(&rec.rel, &normalized, file_set, index),
        "csharp" => resolve_csharp(&normalized, index),
        // bash/lua/solidity/haskell resolve entirely via the direct fileSet
        // leg above (resolve_graph_import); they have no index-backed
        // fallback — a solidity spec that is not vendored in the tree and a
        // haskell module that is not in the source path are external
        // dependencies, not edges.
        "bash" | "lua" | "r" | "solidity" | "haskell" => Vec::new(),
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
pub(crate) fn resolve_and_link(
    records: &mut [FileRecord],
    root: &Path,
    file_set: &HashSet<String>,
) {
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
    for (rec, resolved_imports) in records.iter_mut().zip(resolved) {
        rec.resolved_imports = resolved_imports;
        if let Some(importers) = reverse.remove(&rec.rel) {
            rec.imported_by = importers;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mixdog-resolve-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Two packages whose names are the SAME LENGTH both match an import of
    /// either name. Sorting by length alone left them tied, so the winner came
    /// out of `fs::read_dir` order — a different edge per run or per machine,
    /// which then churns the cached graph. The order is now total, so the
    /// resolved edge is pinned.
    #[test]
    fn equal_length_package_names_resolve_deterministically() {
        let root = temp_root("js-packages");
        for (dir, name) in [("beta", "pkg-bb"), ("alpha", "pkg-aa")] {
            std::fs::create_dir_all(root.join(dir).join("src")).expect("package dir");
            std::fs::write(
                root.join(dir).join("package.json"),
                format!("{{\"name\":\"{name}\",\"main\":\"src/index.js\"}}\n"),
            )
            .expect("package.json");
        }

        let packages = load_js_packages(&root);
        let names: Vec<&str> = packages.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["pkg-aa", "pkg-bb"], "total order, not read_dir");

        let index = GraphIndex {
            js_packages: packages,
            ..GraphIndex::default()
        };
        let file_set: HashSet<String> = ["alpha/src/index.js", "beta/src/index.js"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            resolve_js_package("pkg-aa", &file_set, &index).as_deref(),
            Some("alpha/src/index.js")
        );
        assert_eq!(
            resolve_js_package("pkg-bb", &file_set, &index).as_deref(),
            Some("beta/src/index.js")
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// Same defect on the PHP side: two PSR-4 namespaces of equal length in
    /// sibling composer.json files. `resolve_php_use` keeps the first match of
    /// the length-ordered list, so the chosen root no longer depends on which
    /// manifest the filesystem listed first.
    #[test]
    fn equal_length_psr4_namespaces_resolve_deterministically() {
        let root = temp_root("psr4");
        for (dir, namespace) in [("second", "Bb\\\\"), ("first", "Aa\\\\")] {
            std::fs::create_dir_all(root.join(dir)).expect("package dir");
            std::fs::write(
                root.join(dir).join("composer.json"),
                format!("{{\"autoload\":{{\"psr-4\":{{\"{namespace}\":\"src/\"}}}}}}\n"),
            )
            .expect("composer.json");
        }

        let psr4 = load_php_psr4(&root);
        let namespaces: Vec<&str> = psr4.iter().map(|(ns, _)| ns.as_str()).collect();
        assert_eq!(
            namespaces,
            vec!["Aa\\", "Bb\\"],
            "total order, not read_dir"
        );

        let index = GraphIndex {
            php_psr4: psr4,
            ..GraphIndex::default()
        };
        let file_set: HashSet<String> = ["first/src/Thing.php", "second/src/Thing.php"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            resolve_php_use("Aa\\Thing", &file_set, &index),
            vec!["first/src/Thing.php".to_string()]
        );
        assert_eq!(
            resolve_php_use("Bb\\Thing", &file_set, &index),
            vec!["second/src/Thing.php".to_string()]
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
