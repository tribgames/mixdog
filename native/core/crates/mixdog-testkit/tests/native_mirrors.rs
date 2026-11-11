//! The packages that build a native tool's library from the tool's own sources (crates/mixdog-{spawn,patch,graph,
//! secure-desktop}; why: crates/mixdog-spawn/Cargo.toml) must declare what the tool's own manifest declares, or the core
//! links a library built unlike the one Node's build of the tool tests and ships.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_testkit::canonical;
use mixdog_testkit::entry_names;
use mixdog_testkit::exists;
use mixdog_testkit::is_dir;
use mixdog_testkit::read_string;
use toml::Table;
use toml::Value;

/// Each package's directory under `native/core/crates` and the tool's under `native`: the same name.
const MIRRORED: [&str; 4] = ["mixdog-spawn", "mixdog-patch", "mixdog-graph", "mixdog-secure-desktop"];

/// The [package] keys Cargo hands a compile as `CARGO_PKG_*`, which the library may read with `env!`.
const PACKAGE_KEYS: [&str; 12] =
    ["name", "version", "edition", "rust-version", "description", "license", "license-file", "authors", "homepage", "repository", "documentation", "readme"];

fn manifest(dir: &Path) -> Table {
    read_string(dir.join("Cargo.toml")).parse().unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
}

/// The dependencies of the given kinds (`dependencies`, `dev-dependencies`, ...), for every target too, keyed by
/// target, kind and name, each `path` resolved from the manifest's directory. A member's workspace-hack dependency
/// (cargo hakari's) is no package of the build.
fn dependencies(manifest: &Table, dir: &Path, kinds: &[&str]) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let mut add = |scope: &str, table: &Table| {
        for kind in kinds {
            for (name, spec) in table.get(*kind).and_then(Value::as_table).into_iter().flatten() {
                if name == "mixdog-workspace-hack" {
                    continue;
                }
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
    if let Some(workspace) = manifest.get("workspace").and_then(Value::as_table) {
        add("workspace ", workspace);
    }
    out
}

/// Every manifest under `dir`, sources and tests aside.
fn manifests(dir: &Path, out: &mut Vec<PathBuf>) {
    if exists(dir.join("Cargo.toml")) {
        out.push(dir.to_path_buf());
    }
    for name in entry_names(dir) {
        let path = dir.join(&name);
        if is_dir(&path) && !["src", "tests", "target", "fixtures", "benches"].iter().any(|n| name == *n) {
            manifests(&path, out);
        }
    }
}

fn lib_source(manifest: &Table, dir: &Path) -> PathBuf {
    canonical(dir.join(manifest["lib"].get("path").and_then(Value::as_str).unwrap_or("src/lib.rs")))
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
        assert_eq!(core["lib"].get("name"), tool["lib"].get("name"), "{name}: [lib] name differs from native/{name}/Cargo.toml");
        assert_eq!(lib_source(&core, &core_dir), lib_source(&tool, &tool_dir), "{name}: the library is not built from native/{name}'s sources");
        assert_eq!(core.get("features"), tool.get("features"), "{name}: [features] differ from native/{name}/Cargo.toml");
        let normal = ["dependencies"];
        assert_eq!(
            dependencies(&core, &core_dir, &normal),
            dependencies(&tool, &tool_dir, &normal),
            "{name}: dependencies differ from native/{name}/Cargo.toml"
        );
    }
}

/// Every package of the core's build is inside the workspace root: Cargo names a path package outside it by its absolute
/// path, so the package and every crate above it got other names (`-C metadata`) in each checkout.
#[test]
fn every_path_dependency_is_inside_the_workspace_root() {
    let root = canonical(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let mut dirs = vec![root.clone()];
    manifests(&root.join("crates"), &mut dirs);
    let kinds = ["dependencies", "dev-dependencies", "build-dependencies"];
    for dir in dirs {
        for (key, spec) in dependencies(&manifest(&dir), &dir, &kinds) {
            if let Some(path) = spec.get("path").and_then(Value::as_str) {
                assert!(Path::new(path).starts_with(&root), "{}: `{key}` is outside the workspace root: {path}", dir.join("Cargo.toml").display());
            }
        }
    }
}
