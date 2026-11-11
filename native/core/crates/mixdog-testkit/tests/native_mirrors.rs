//! The packages that build a native tool's library from the tool's own sources (crates/mixdog-{spawn,patch,graph,
//! secure-desktop}; why: crates/mixdog-spawn/Cargo.toml) must declare what the tool's own manifest declares, or the core
//! links a library built unlike the one Node's build of the tool tests and ships.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_testkit::canonical;
use mixdog_testkit::exists;
use mixdog_testkit::read_string;
use toml::Table;
use toml::Value;

/// Each package's directory under `native/core/crates` and the tool's under `native`: the same name.
const MIRRORED: [&str; 4] = ["mixdog-spawn", "mixdog-patch", "mixdog-graph", "mixdog-secure-desktop"];

/// The [package] keys Cargo hands a compile as `CARGO_PKG_*`, which the library may read with `env!`, and `links`.
const PACKAGE_KEYS: [&str; 13] = [
    "name",
    "version",
    "edition",
    "rust-version",
    "description",
    "license",
    "license-file",
    "authors",
    "homepage",
    "repository",
    "documentation",
    "readme",
    "links",
];

/// The [lib] keys that decide what the library is.
const LIB_KEYS: [&str; 3] = ["name", "crate-type", "proc-macro"];

/// What a build script prints that reaches the library or the crates above it (rather than only the package's own
/// linked executables, as the tools' Windows version resource does).
const REACHES_THE_LIBRARY: [&str; 6] = ["rustc-cfg", "rustc-check-cfg", "rustc-env", "rustc-link-lib", "rustc-flags", "OUT_DIR"];

/// The tables whose entries name packages, and so may name one by `path`.
const PACKAGE_TABLES: [&str; 5] = ["dependencies", "dev-dependencies", "build-dependencies", "patch", "replace"];

fn manifest(dir: &Path) -> Table {
    read_string(dir.join("Cargo.toml")).parse().unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
}

/// The dependencies of the given kinds (`dependencies`, `build-dependencies`, ...), for every target too, keyed by
/// target, kind and name, each `path` resolved from the manifest's directory (version, features, optional, ... as
/// written).
fn dependencies(manifest: &Table, dir: &Path, kinds: &[&str]) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let mut add = |scope: &str, table: &Table| {
        for kind in kinds {
            for (name, spec) in table.get(*kind).and_then(Value::as_table).into_iter().flatten() {
                let mut spec = spec.clone();
                if let Some(path) = spec.get("path").and_then(Value::as_str).map(|p| canonical(dir.join(p))) {
                    spec.as_table_mut().unwrap().insert("path".to_owned(), Value::String(path.display().to_string()));
                }
                out.insert(format!("{scope}{kind} {name}"), spec);
            }
        }
    };
    add("", manifest);
    for (cfg, target) in manifest.get("target").and_then(Value::as_table).into_iter().flatten() {
        add(&format!("{cfg} "), target.as_table().unwrap());
    }
    out
}

/// The directories of every manifest of the workspace rooted at `root`: the root, its members and excluded packages,
/// and every package one of them names by path, with each path a package table names (manifest, keys, path).
fn workspace_paths(root: &Path) -> (usize, Vec<(PathBuf, String, String)>) {
    let (mut seen, mut todo, mut out) = (Vec::new(), vec![root.to_path_buf()], Vec::new());
    while let Some(dir) = todo.pop() {
        let dir = canonical(dir);
        if seen.contains(&dir) {
            continue;
        }
        seen.push(dir.clone());
        let manifest = Value::Table(manifest(&dir));
        let mut paths = Vec::new();
        package_paths(&manifest, "", false, &mut paths);
        for listed in ["members", "exclude"] {
            for member in manifest.get("workspace").and_then(|w| w.get(listed)).and_then(Value::as_array).into_iter().flatten() {
                todo.push(dir.join(member.as_str().unwrap()));
            }
        }
        for (keys, path) in paths {
            if exists(dir.join(&path).join("Cargo.toml")) {
                todo.push(dir.join(&path));
            }
            out.push((dir.clone(), keys, path));
        }
    }
    (seen.len(), out)
}

/// Every `path` a package table of `value` names (at any depth: `[target.'…'.dependencies]`,
/// `[workspace.dependencies]`, `[patch.<source>]`, `[replace]`), with the keys that lead to it.
fn package_paths(value: &Value, keys: &str, in_package_table: bool, out: &mut Vec<(String, String)>) {
    let Some(table) = value.as_table() else { return };
    for (key, value) in table {
        let keys = format!("{keys}.{key}");
        let inside = in_package_table || PACKAGE_TABLES.contains(&key.as_str());
        if let (true, Some(path)) = (inside, value.get("path").and_then(Value::as_str)) {
            out.push((keys.clone(), path.to_owned()));
        }
        package_paths(value, &keys, inside, out);
    }
}

fn lib_source(manifest: &Table, dir: &Path) -> PathBuf {
    canonical(dir.join(manifest["lib"].get("path").and_then(Value::as_str).unwrap_or("src/lib.rs")))
}

/// The package's build script, if it has one.
fn build_script(manifest: &Table, dir: &Path) -> Option<PathBuf> {
    match manifest["package"].get("build") {
        Some(Value::Boolean(false)) => None,
        Some(Value::String(path)) => Some(canonical(dir.join(path))),
        _ => exists(dir.join("build.rs")).then(|| canonical(dir.join("build.rs"))),
    }
}

/// A Rust file without its comment lines.
fn code(file: &Path) -> String {
    read_string(file).lines().filter(|l| !l.trim().starts_with("//")).collect::<Vec<_>>().join("\n")
}

/// The files a build script includes as modules (`#[path = "…"] mod …;`), resolved.
fn included_modules(script: &Path) -> Vec<PathBuf> {
    let text = read_string(script);
    let dir = script.parent().unwrap();
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("#[path = \"")?.split('"').next().map(|p| canonical(dir.join(p))))
        .collect()
}

#[test]
fn each_core_package_declares_what_its_tool_declares() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for name in MIRRORED {
        let (core_dir, tool_dir) = (crates.join(name), crates.join("../../").join(name));
        let (core, tool) = (manifest(&core_dir), manifest(&tool_dir));
        for key in PACKAGE_KEYS {
            assert_eq!(core["package"].get(key), tool["package"].get(key), "{name}: [package] {key} differs from native/{name}/Cargo.toml");
        }
        for key in LIB_KEYS {
            assert_eq!(core["lib"].get(key), tool["lib"].get(key), "{name}: [lib] {key} differs from native/{name}/Cargo.toml");
        }
        assert_eq!(lib_source(&core, &core_dir), lib_source(&tool, &tool_dir), "{name}: the library is not built from native/{name}'s sources");
        assert_eq!(core.get("features"), tool.get("features"), "{name}: [features] differ from native/{name}/Cargo.toml");
        let normal = ["dependencies"];
        assert_eq!(
            dependencies(&core, &core_dir, &normal),
            dependencies(&tool, &tool_dir, &normal),
            "{name}: dependencies differ from native/{name}/Cargo.toml"
        );

        // The build scripts. The core's prints nothing itself: whatever it prints comes from a module the tool's build
        // script includes too. What the tool's script does beyond those modules reaches only its own executable: the
        // Windows version resource, the one thing the core's script leaves out, with its `winresource`.
        let tool_script = build_script(&tool, &tool_dir);
        let tool_modules = tool_script.as_deref().map(included_modules).unwrap_or_default();
        let core_script = build_script(&core, &core_dir);
        if let Some(script) = &core_script {
            let own = code(script);
            assert!(!own.contains("cargo:") && !own.contains("winresource"), "{name}: the core's build script prints by itself");
            for module in included_modules(script) {
                assert!(tool_modules.contains(&module), "{name}: native/{name}'s build script does not include {}", module.display());
            }
        }
        if let Some(script) = &tool_script {
            let shared: Vec<_> = core_script.as_deref().map(included_modules).unwrap_or_default();
            for file in std::iter::once(script.clone()).chain(tool_modules.iter().filter(|m| !shared.contains(m)).cloned()) {
                let text = code(&file);
                for directive in REACHES_THE_LIBRARY {
                    assert!(!text.contains(directive), "{name}: {} uses {directive}, which the core's build does not", file.display());
                }
            }
        }
        let mut tool_build = dependencies(&tool, &tool_dir, &["build-dependencies"]);
        tool_build.retain(|key, _| !key.ends_with(" winresource"));
        assert_eq!(
            dependencies(&core, &core_dir, &["build-dependencies"]),
            tool_build,
            "{name}: build-dependencies differ from native/{name}/Cargo.toml"
        );
    }
}

/// Every package of the core's build is inside the workspace root: Cargo names a path package outside it by its absolute
/// path, so the package and every crate above it got other names (`-C metadata`) in each checkout. Every manifest under
/// the root, every table that names packages.
#[test]
fn every_path_dependency_is_inside_the_workspace_root() {
    let root = canonical(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let (manifests, paths) = workspace_paths(&root);
    assert!(manifests > 40, "only {manifests} manifests read from {}", root.display());
    for (dir, keys, path) in paths {
        let resolved = canonical(dir.join(&path));
        assert!(resolved.starts_with(&root), "{}: `{keys}` is outside the workspace root: {path}", dir.join("Cargo.toml").display());
    }
}
