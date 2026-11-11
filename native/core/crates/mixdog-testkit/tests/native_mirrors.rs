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

/// What the module walk reads of a Rust file: identifiers and keywords, string literals (their content) and single
/// punctuation characters; comments, character literals and lifetimes' quotes are dropped.
#[derive(Debug, PartialEq)]
enum Token {
    Word(String),
    Text(String),
    Mark(char),
}

fn tokens(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            // Block comments nest.
            let mut depth = 1;
            i += 2;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if c == '"' {
            let mut text = String::new();
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1;
                }
                text.extend(chars.get(i));
                i += 1;
            }
            i += 1;
            out.push(Token::Text(text));
        } else if c == 'r' && matches!(next, Some('"' | '#')) && !out.last().is_some_and(|t| matches!(t, Token::Word(_)) && i > 0 && word(chars[i - 1])) {
            // A raw string `r"…"`, `r#"…"#`; `r#name` (a raw identifier) falls through to the word below.
            let hashes = chars[i + 1..].iter().take_while(|c| **c == '#').count();
            let open = i + 1 + hashes;
            if chars.get(open) == Some(&'"') {
                let mut end = open + 1;
                while end < chars.len() && !(chars[end] == '"' && (1..=hashes).all(|k| chars.get(end + k) == Some(&'#'))) {
                    end += 1;
                }
                out.push(Token::Text(chars[open + 1..end.min(chars.len())].iter().collect()));
                i = end + 1 + hashes;
            } else if hashes == 1 && chars.get(open).is_some_and(|c| word(*c)) {
                // `r#type`: the identifier `type`, read as the word that follows.
                i = open;
            } else {
                out.push(Token::Word("r".to_owned()));
                i += 1;
            }
        } else if c == '\'' {
            // `'\n'`, `'x'`: a character literal, skipped whole. Otherwise a lifetime: only its quote is skipped.
            if next == Some('\\') {
                i += 2;
                while i < chars.len() && chars[i] != '\'' {
                    i += 1;
                }
                i += 1;
            } else if chars.get(i + 2) == Some(&'\'') {
                i += 3;
            } else {
                i += 1;
            }
        } else if word(c) {
            let start = i;
            while i < chars.len() && word(chars[i]) {
                i += 1;
            }
            out.push(Token::Word(chars[start..i].iter().collect()));
        } else {
            if !c.is_whitespace() {
                out.push(Token::Mark(c));
            }
            i += 1;
        }
    }
    out
}

/// Every file a build script compiles from, the script included: each `mod name;` wherever it is written — at the top
/// of a file or inside inline modules (`mod outer { mod inner; }` is `outer/inner.rs`) — at its `path` attribute when it
/// has one (also inside a `cfg_attr`), else `name.rs` or `name/mod.rs` where Rust looks for it; and each
/// `include!`/`include_str!`/`include_bytes!` of a literal path. Followed through the Rust files they bring in.
fn script_files(script: &Path) -> Vec<PathBuf> {
    use Token::{Mark, Text, Word};
    let mut files = vec![canonical(script)];
    let mut at = 0;
    while at < files.len() {
        let file = files[at].clone();
        at += 1;
        if file.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        let dir = file.parent().unwrap().to_path_buf();
        // A module of a file that is not a crate root or `mod.rs` lives in the directory named after the file.
        let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
        let module_dir = if at == 1 || stem == "mod" { dir.clone() } else { dir.join(&stem) };
        let tokens = tokens(&read_string(&file));
        // The inline modules open at this point, each with the brace depth it was opened at.
        let mut inline: Vec<(String, usize)> = Vec::new();
        let mut depth = 0usize;
        let mut path_attribute: Option<String> = None;
        let mut i = 0;
        while i < tokens.len() {
            match &tokens[i..] {
                // An attribute: skipped whole; a `path = "…"` anywhere in it belongs to the item that follows.
                [Mark('#'), Mark('['), ..] | [Mark('#'), Mark('!'), Mark('['), ..] => {
                    let open = i + tokens[i..].iter().position(|t| *t == Mark('[')).unwrap();
                    let mut brackets = 0;
                    let mut end = open;
                    for (offset, token) in tokens[open..].iter().enumerate() {
                        match token {
                            Mark('[') => brackets += 1,
                            Mark(']') => brackets -= 1,
                            _ => {}
                        }
                        if brackets == 0 {
                            end = open + offset;
                            break;
                        }
                    }
                    for window in tokens[open..end].windows(3) {
                        if let [Word(key), Mark('='), Text(path)] = window
                            && key == "path"
                        {
                            path_attribute = Some(path.clone());
                        }
                    }
                    i = end + 1;
                    continue;
                }
                [Word(keyword), Word(name), Mark(';'), ..] if keyword == "mod" => {
                    let found = match path_attribute.take() {
                        Some(path) => {
                            assert!(inline.is_empty(), "{}: a `path` attribute on `mod {name};` inside an inline module is not followed by this test", file.display());
                            dir.join(path)
                        }
                        None => {
                            let base = inline.iter().fold(module_dir.clone(), |base, (outer, _)| base.join(outer));
                            [base.join(format!("{name}.rs")), base.join(name).join("mod.rs")]
                                .into_iter()
                                .find(|p| exists(p))
                                .unwrap_or_else(|| panic!("{}: module `{name}` not found under {}", file.display(), base.display()))
                        }
                    };
                    files.push(canonical(found));
                    i += 3;
                    continue;
                }
                [Word(keyword), Word(name), Mark('{'), ..] if keyword == "mod" => {
                    assert!(path_attribute.take().is_none(), "{}: a `path` attribute on the inline module `{name}` is not followed by this test", file.display());
                    inline.push((name.clone(), depth));
                    depth += 1;
                    i += 3;
                    continue;
                }
                // Any other `mod` (one a macro writes: `mod $name;`) names a file this walk cannot find.
                [Word(keyword), ..] if keyword == "mod" => {
                    panic!("{}: a `mod` that is not `mod name;` or `mod name {{` (a macro-generated module?) is not followed by this test", file.display())
                }
                [Word(keyword), Mark('!'), Mark('('), Text(path), ..] if ["include", "include_str", "include_bytes"].contains(&keyword.as_str()) => {
                    files.push(canonical(dir.join(path)));
                }
                [Mark('{'), ..] => {
                    depth += 1;
                    path_attribute = None;
                }
                [Mark('}'), ..] => {
                    depth = depth.saturating_sub(1);
                    if inline.last().is_some_and(|(_, opened_at)| *opened_at == depth) {
                        inline.pop();
                    }
                    path_attribute = None;
                }
                [Mark(';'), ..] => path_attribute = None,
                _ => {}
            }
            i += 1;
        }
    }
    files.sort();
    files.dedup();
    files
}

#[test]
fn the_module_walk_follows_nested_inline_and_attributed_modules() {
    let dir = std::env::temp_dir().join(format!("native-mirrors-walk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let write = |name: &str, text: &str| {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write(
        "build.rs",
        "// mod commented;\nmod plain;\nmod r#type;\nmod outer { pub mod inner; mod deeper { mod leaf; } }\n#[cfg_attr(windows, path = \"elsewhere/attributed.rs\")]\nmod attributed;\nconst RULES: &str = include_str!(\"rules.yml\");\nfn main() { let _ = \"mod in_a_string;\"; }\n",
    );
    write("plain.rs", "mod child;\n");
    write("plain/child.rs", "");
    write("outer/inner.rs", "");
    write("outer/deeper/leaf.rs", "");
    write("elsewhere/attributed.rs", "");
    write("type.rs", "");
    write("rules.yml", "mod not_rust;\n");
    let mut found: Vec<String> = script_files(&dir.join("build.rs")).iter().map(|f| f.strip_prefix(canonical(&dir)).unwrap().to_string_lossy().replace('\\', "/")).collect();
    found.sort();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(found, ["build.rs", "elsewhere/attributed.rs", "outer/deeper/leaf.rs", "outer/inner.rs", "plain.rs", "plain/child.rs", "rules.yml", "type.rs"]);
}

#[test]
#[should_panic(expected = "macro-generated module")]
fn the_module_walk_refuses_a_module_a_macro_writes() {
    let dir = std::env::temp_dir().join(format!("native-mirrors-macro-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("build.rs"), "macro_rules! m { ($n:ident) => { mod $n; } }\nm!(hidden);\nfn main() {}\n").unwrap();
    script_files(&dir.join("build.rs"));
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
        let tool_files = tool_script.as_deref().map(script_files).unwrap_or_default();
        let core_script = build_script(&core, &core_dir);
        let core_files = core_script.as_deref().map(script_files).unwrap_or_default();
        if let Some(script) = &core_script {
            let own = code(script);
            assert!(!own.contains("cargo:") && !own.contains("rustc-") && !own.contains("winresource"), "{name}: the core's build script prints by itself");
            for file in core_files.iter().filter(|f| *f != script) {
                assert!(tool_files.contains(file), "{name}: native/{name}'s build script does not compile {}", file.display());
            }
        }
        if tool_script.is_some() {
            for file in tool_files.iter().filter(|f| !core_files.contains(f)) {
                let text = code(file);
                assert!(!text.contains("rustc-"), "{name}: {} prints a rustc directive, which the core's build does not", file.display());
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
