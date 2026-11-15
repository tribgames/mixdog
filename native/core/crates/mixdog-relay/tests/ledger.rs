//! The ledger of the relay port: every test of the Node relay (`apps/relay/security.test.mjs`, `lib/*.test.mjs`,
//! `deploy/*.test.mjs`, `deploy/coturn/*.test.mjs`) has a row in a fragment under `tests/ledger/`, and every row names
//! something that exists: a Rust test (in a test target or in the `tests` module of a source file), a twin scenario
//! file, or a case of the shell test. `tests/ledger/node-test-titles.json` is the frozen list of the Node titles; while
//! the Node files exist it must equal what they contain, so a new Node test cannot land without a Rust counterpart.
//!
//! A row is `{"node": "<path>::<title>", ...}` plus at least one of
//! - `"rust"`: `<test target>::<test>` (the target is a file of `tests/`; a path with a `tests` segment such as
//!   `http1::util::tests::<test>` is the inline test module of `src/http1/util.rs`; `twin::<dir>/<scenario>` is a twin
//!   scenario file),
//! - `"twin"`: `<dir>/<scenario>` or `nr-relay-twin-<area>: <scenario>, <scenario>` (a list; `;` also separates),
//! - `"covered_by"`: a list of `"rust"` targets,
//! - `"shell"`: `<path>::<case>`, a case of a shell test that the file names.
//!
//! `"note"` is prose and is not checked. A Node test of which several tasks each port a part has one row per part: a
//! title is covered when at least one row names it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_relay::js;
use regex::Regex;
use serde_json::Value;

const FROZEN: &str = "node-test-titles.json";
const NODE_ROOT: &str = "apps/relay";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    crate_dir().join("../../../..")
}

fn read(path: &Path) -> String {
    mixdog_fsio::read_to_string(&Unlaned, path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn json_of(path: &Path) -> Value {
    js::parse(&read(path)).unwrap_or_else(|e| panic!("parse {}: {e:?}", path.display()))
}

/// The entries of a directory, sorted; empty when the directory is not there.
fn entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(listing) = mixdog_fsio::read_dir(&Unlaned, dir) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = listing.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
    paths.sort();
    paths
}

fn report(what: &str, problems: &[String]) {
    if problems.is_empty() {
        return;
    }
    let shown: Vec<&str> = problems.iter().take(25).map(String::as_str).collect();
    panic!("{what}: {} problem(s)\n{}", problems.len(), shown.join("\n"));
}

// ---- the rows ----

enum Target {
    Rust(String),
    Twin(String),
    Shell(String),
}

struct Row {
    fragment: String,
    node: String,
    targets: Vec<Target>,
}

impl Row {
    fn label(&self) -> String {
        format!("{}: {}", self.fragment, self.node)
    }
}

fn load_rows() -> (Vec<Row>, Vec<String>) {
    let mut rows = Vec::new();
    let mut problems = Vec::new();
    for path in entries(&crate_dir().join("tests/ledger")) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
        if !name.ends_with(".json") || name == FROZEN {
            continue;
        }
        let Value::Array(list) = json_of(&path) else {
            problems.push(format!("{name}: a fragment is an array of rows"));
            continue;
        };
        for (index, value) in list.iter().enumerate() {
            let at = format!("{name}[{index}]");
            let Value::Object(map) = value else {
                problems.push(format!("{at}: a row is an object"));
                continue;
            };
            let Some(node) = map.get("node").and_then(Value::as_str) else {
                problems.push(format!("{at}: a row names its Node test or source in \"node\""));
                continue;
            };
            let mut targets = Vec::new();
            for (key, value) in map {
                match (key.as_str(), value) {
                    ("node" | "note", Value::String(_)) | ("twin", Value::Null) => {}
                    ("rust", Value::String(text)) => targets.push(Target::Rust(text.clone())),
                    ("twin", Value::String(text)) => targets.push(Target::Twin(text.clone())),
                    ("shell", Value::String(text)) => targets.push(Target::Shell(text.clone())),
                    ("covered_by", Value::Array(items)) => {
                        for item in items {
                            match item.as_str() {
                                Some(text) => targets.push(Target::Rust(text.to_owned())),
                                None => problems.push(format!("{at}: covered_by lists strings")),
                            }
                        }
                    }
                    _ => problems.push(format!("{at}: unexpected or mistyped key \"{key}\"")),
                }
            }
            if targets.is_empty() {
                problems.push(format!("{at} ({node}): a row names a Rust test, a twin scenario or a shell case"));
            }
            rows.push(Row { fragment: name.clone(), node: node.to_owned(), targets });
        }
    }
    (rows, problems)
}

// ---- what a row names ----

/// Whether `line` declares `fn <name>` (any of `pub`, `async` in front).
fn declares(line: &str, name: &str) -> bool {
    let rest = line.trim_start();
    let rest = rest.strip_prefix("pub ").unwrap_or(rest);
    let rest = rest.strip_prefix("async ").unwrap_or(rest);
    let Some(rest) = rest.strip_prefix("fn ") else { return false };
    rest.strip_prefix(name).is_some_and(|after| !after.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
}

/// The attribute and comment lines right above `fn <name>`, or `None` when the source has no such function.
fn attributes_of(source: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();
    let at = lines.iter().position(|line| declares(line, name))?;
    let mut attributes = String::new();
    for line in lines[..at].iter().rev() {
        let line = line.trim_start();
        if !(line.starts_with("#[") || line.starts_with("//")) {
            break;
        }
        attributes.push_str(line);
        attributes.push('\n');
    }
    Some(attributes)
}

fn twin_dir(task: &str) -> Option<&'static str> {
    match task {
        "nr-relay-twin-web" => Some("web"),
        "nr-relay-twin-identity" => Some("identity"),
        "nr-relay-twin-legs" => Some("legs"),
        "nr-relay-twin-services" => Some("services"),
        "nr-relay-twin-data" => Some("data"),
        _ => None,
    }
}

/// `pair-code redial` -> `pair_code_redial`: how a scenario file is named after its title.
fn scenario_file_name(title: &str) -> String {
    let mut name = String::new();
    for c in title.trim().chars() {
        if c.is_alphanumeric() {
            name.extend(c.to_lowercase());
        } else if !name.ends_with('_') && !name.is_empty() {
            name.push('_');
        }
    }
    name.trim_end_matches('_').to_owned()
}

fn scenario_exists(dir: &str, name: &str) -> bool {
    mixdog_fsio::is_file(&Unlaned, crate_dir().join("tests/twin/scenarios").join(dir).join(format!("{name}.json")))
}

fn check_twin(text: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let mut dir: Option<&str> = None;
    for part in text.split([';', ',']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let name = if let Some((task, name)) = part.split_once(':') {
            match twin_dir(task.trim()) {
                Some(found) => dir = Some(found),
                None => {
                    problems.push(format!("twin \"{part}\": \"{}\" is not a twin task", task.trim()));
                    continue;
                }
            }
            name
        } else if let Some((named, name)) = part.split_once('/') {
            dir = ["web", "identity", "legs", "services", "data", "smoke"].into_iter().find(|known| *known == named);
            name
        } else {
            part
        };
        let Some(dir) = dir else {
            problems.push(format!("twin \"{part}\" names no scenario directory"));
            continue;
        };
        if !scenario_exists(dir, &scenario_file_name(name)) {
            problems.push(format!("twin \"{part}\": no tests/twin/scenarios/{dir}/{}.json", scenario_file_name(name)));
        }
    }
    problems
}

fn check_rust(target: &str) -> Result<(), String> {
    let segments: Vec<&str> = target.split("::").collect();
    let (name, modules) = segments.split_last().ok_or_else(|| format!("rust \"{target}\" is empty"))?;
    if modules.is_empty() {
        return Err(format!("rust \"{target}\": a row is <test target>::<test>"));
    }
    if modules == ["twin"] && name.contains('/') {
        let (dir, scenario) = name.split_once('/').unwrap_or_default();
        return if scenario_exists(dir, scenario) { Ok(()) } else { Err(format!("rust \"{target}\": no such twin scenario file")) };
    }
    let crate_dir = crate_dir();
    let file = if let Some(at) = modules.iter().position(|m| *m == "tests") {
        let path = modules[..at].join("/");
        [crate_dir.join(format!("src/{path}.rs")), crate_dir.join(format!("src/{path}/mod.rs"))]
            .into_iter()
            .find(|candidate| mixdog_fsio::is_file(&Unlaned, candidate))
    } else if modules[0] == "twin" {
        entries(&crate_dir.join("tests/twin"))
            .into_iter()
            .filter(|path| path.extension().is_some_and(|e| e == "rs"))
            .find(|path| attributes_of(&read(path), name).is_some())
    } else {
        Some(crate_dir.join(format!("tests/{}.rs", modules[0]))).filter(|path| mixdog_fsio::is_file(&Unlaned, path))
    };
    let Some(file) = file else { return Err(format!("rust \"{target}\": there is no such test target or source file")) };
    let Some(attributes) = attributes_of(&read(&file), name) else {
        return Err(format!("rust \"{target}\": no `fn {name}` in {}", file.display()));
    };
    if attributes.contains("#[ignore") {
        return Err(format!("rust \"{target}\": the test is ignored"));
    }
    if !(attributes.contains("#[test") || attributes.contains("#[tokio::test")) {
        return Err(format!("rust \"{target}\": `fn {name}` is not a test"));
    }
    Ok(())
}

fn check_shell(target: &str) -> Result<(), String> {
    let (path, case) = target.split_once("::").ok_or_else(|| format!("shell \"{target}\": a row is <path>::<case>"))?;
    let file = repo_root().join(path);
    if !mixdog_fsio::is_file(&Unlaned, &file) {
        return Err(format!("shell \"{target}\": {path} does not exist"));
    }
    if read(&file).contains(case) { Ok(()) } else { Err(format!("shell \"{target}\": {path} has no case \"{case}\"")) }
}

// ---- the Node titles ----

fn title_pattern() -> Regex {
    Regex::new(r#"(?m)^[ \t]*test\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)"#).expect("the title pattern is valid")
}

fn unescape(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// The `test('<title>'` titles of one Node source, as they read at run time; a template title is looked up in
/// `templates` (written by hand: `<file>::<template>` to its expansions).
fn titles_of(file: &str, source: &str, templates: &BTreeMap<String, Vec<String>>) -> Result<Vec<String>, String> {
    let mut titles = Vec::new();
    for found in title_pattern().captures_iter(source) {
        let raw = (1..=3).find_map(|group| found.get(group)).map_or("", |m| m.as_str());
        let title = unescape(raw);
        if let Some(expanded) = templates.get(&format!("{file}::{title}")) {
            titles.extend(expanded.iter().cloned());
        } else if title.contains("${") {
            return Err(format!("{file}::{title}: a template title is expanded by hand in {FROZEN} (\"templates\")"));
        } else {
            titles.push(title);
        }
    }
    Ok(titles)
}

struct Frozen {
    kept: BTreeSet<String>,
    templates: BTreeMap<String, Vec<String>>,
    titles: BTreeMap<String, Vec<String>>,
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn string_lists(value: &Value) -> BTreeMap<String, Vec<String>> {
    value.as_object().map(|map| map.iter().map(|(key, list)| (key.clone(), strings(list))).collect()).unwrap_or_default()
}

fn frozen() -> Frozen {
    let value = json_of(&crate_dir().join("tests/ledger").join(FROZEN));
    Frozen { kept: strings(&value["kept"]).into_iter().collect(), templates: string_lists(&value["templates"]), titles: string_lists(&value["titles"]) }
}

/// Every Node test file of the relay, relative to `apps/relay`.
fn node_test_files(root: &Path) -> Vec<String> {
    let mut files = vec!["security.test.mjs".to_owned()];
    for dir in ["lib", "deploy", "deploy/coturn", "scripts"] {
        for path in entries(&root.join(dir)) {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name.ends_with(".test.mjs") {
                files.push(format!("{dir}/{name}"));
            }
        }
    }
    files
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

// ---- the checks ----

/// (b) and (c): every target of every row exists, and no Rust target is an ignored test.
#[test]
fn every_row_names_something_that_exists_and_runs() {
    let (rows, mut problems) = load_rows();
    for row in &rows {
        for target in &row.targets {
            match target {
                Target::Rust(text) => problems.extend(check_rust(text).err().map(|e| format!("{}: {e}", row.label()))),
                Target::Twin(text) => problems.extend(check_twin(text).into_iter().map(|e| format!("{}: {e}", row.label()))),
                Target::Shell(text) => problems.extend(check_shell(text).err().map(|e| format!("{}: {e}", row.label()))),
            }
        }
    }
    report("ledger rows", &problems);
}

/// (a): every frozen Node title has a row, except the titles of a kept Node test (a build tool that stays Node). And
/// no row names a title of a Node test file that is not in the frozen list.
#[test]
fn every_node_test_title_has_a_row() {
    let (rows, _) = load_rows();
    let frozen = frozen();
    let mut covered: BTreeMap<&str, usize> = BTreeMap::new();
    for row in &rows {
        *covered.entry(row.node.as_str()).or_default() += 1;
    }
    let mut problems = Vec::new();
    for (file, titles) in &frozen.titles {
        if frozen.kept.contains(file) {
            continue;
        }
        for title in titles {
            if !covered.contains_key(format!("{NODE_ROOT}/{file}::{title}").as_str()) {
                problems.push(format!("{NODE_ROOT}/{file}::{title}: no row"));
            }
        }
    }
    for row in &rows {
        let Some((path, title)) = row.node.split_once("::") else { continue };
        let Some(file) = path.strip_prefix(&format!("{NODE_ROOT}/")) else { continue };
        if let Some(titles) = frozen.titles.get(file)
            && !titles.iter().any(|known| known == title)
        {
            problems.push(format!("{}: {NODE_ROOT}/{file} has no test of this title", row.label()));
        }
    }
    report("node titles", &problems);
}

/// The frozen list equals what the Node files contain, while they exist.
#[test]
fn the_frozen_titles_equal_the_node_files() {
    let root = repo_root().join(NODE_ROOT);
    if !mixdog_fsio::is_file(&Unlaned, root.join("security.test.mjs")) {
        return;
    }
    let frozen = frozen();
    let mut problems = Vec::new();
    let files = node_test_files(&root);
    for file in &files {
        match titles_of(file, &read(&root.join(file)), &frozen.templates) {
            Err(e) => problems.push(e),
            Ok(titles) => match frozen.titles.get(file) {
                None => problems.push(format!("{file}: a Node test file that {FROZEN} does not list")),
                Some(known) if sorted(known.clone()) != sorted(titles.clone()) => {
                    for title in titles.iter().filter(|t| !known.contains(t)) {
                        problems.push(format!("{file}: a Node test is not in {FROZEN}: {title}"));
                    }
                    for title in known.iter().filter(|t| !titles.contains(t)) {
                        problems.push(format!("{file}: {FROZEN} lists a test the file no longer has: {title}"));
                    }
                }
                Some(_) => {}
            },
        }
    }
    for file in frozen.titles.keys().filter(|file| !files.contains(file)) {
        problems.push(format!("{file}: listed in {FROZEN} but not a Node test file"));
    }
    report("frozen titles", &problems);
}

/// (d): every JSON text of the relay goes through `src/js.rs`, so it reads and writes as JavaScript does.
#[test]
fn no_source_file_but_js_rs_calls_serde_json_to_read_or_write_text() {
    let calls = Regex::new(r"serde_json::(from_str|from_slice|from_reader|to_string_pretty|to_string|to_vec|to_writer)\b").expect("valid");
    let imports = Regex::new(r"use serde_json::\{[^}]*\b(from_str|from_slice|from_reader|to_string_pretty|to_string|to_vec|to_writer)\b").expect("valid");
    let src = crate_dir().join("src");
    let mut pending = vec![src.clone()];
    let mut problems = Vec::new();
    while let Some(dir) = pending.pop() {
        for path in entries(&dir) {
            if mixdog_fsio::is_dir(&Unlaned, &path) {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") && path != src.join("js.rs") {
                for (number, line) in read(&path).lines().enumerate() {
                    if !line.trim_start().starts_with("//") && (calls.is_match(line) || imports.is_match(line)) {
                        problems.push(format!("{}:{}: {}", path.strip_prefix(&src).unwrap_or(&path).display(), number + 1, line.trim()));
                    }
                }
            }
        }
    }
    report("serde_json text calls outside src/js.rs", &problems);
}

// ---- the helpers ----

#[test]
fn a_scenario_title_is_named_like_its_file() {
    assert_eq!(scenario_file_name("pair-code redial"), "pair_code_redial");
    assert_eq!(scenario_file_name(" pair-code-request over WebSocket "), "pair_code_request_over_websocket");
    assert_eq!(scenario_file_name("static_healthz"), "static_healthz");
}

#[test]
fn a_list_of_scenarios_keeps_the_directory_of_the_one_before() {
    // `identity/pair_code_redial` exists; a bare name after a `nr-relay-twin-<area>:` prefix takes that area's directory.
    assert!(check_twin("identity/pair_code_redial").is_empty());
    assert!(check_twin("nr-relay-twin-identity: pair-code redial, pair-code request over WebSocket").is_empty());
    assert!(!check_twin("nr-relay-twin-identity: no such scenario").is_empty());
    assert!(!check_twin("nr-relay-twin-nothing: pair-code redial").is_empty());
}

#[test]
fn a_function_is_found_by_its_whole_name_with_its_attributes_above_it() {
    let source = "#[test]\nfn alpha_one() {}\n\n#[ignore]\n#[test]\nasync fn alpha() {}\npub fn beta() {}\n";
    assert_eq!(attributes_of(source, "alpha").as_deref(), Some("#[test]\n#[ignore]\n"));
    assert_eq!(attributes_of(source, "alpha_one").as_deref(), Some("#[test]\n"));
    assert_eq!(attributes_of(source, "beta").as_deref(), Some(""));
    assert_eq!(attributes_of(source, "gamma"), None);
}

#[test]
fn titles_are_read_as_node_prints_them_and_a_template_must_be_expanded() {
    let source = "test('plain', () => {});\n  test(\"it\\'s \\\\x01\", () => {});\ntest(`${name} logo`, () => {});\ntest.after(() => {});\n";
    let mut templates = BTreeMap::new();
    assert!(titles_of("a.test.mjs", source, &templates).is_err());
    templates.insert("a.test.mjs::${name} logo".to_owned(), vec!["/a logo".to_owned(), "/b logo".to_owned()]);
    assert_eq!(titles_of("a.test.mjs", source, &templates), Ok(vec!["plain".to_owned(), "it's \\x01".to_owned(), "/a logo".to_owned(), "/b logo".to_owned()]));
}
