//! Where a `code_graph` call looks: a folder that is a project answers from itself; a folder that only holds projects
//! answers per project; a folder with neither is refused or read plain; an anchor that names the working folder means
//! "search here".
#![allow(clippy::disallowed_methods, reason = "the test builds a tree on disk with blocking filesystem calls")]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::args::Args;
use super::dispatch::{self, Answer, Env};
use super::federation::TrustSnapshot;

const SENTINEL: &str = "{\"name\":\"p\"}\n";

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A tree where the walk up from a folder ends at the tree: no sentinel of the machine above it is ever found.
fn tree() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    super::roots::LAYOUT.with(|l| *l.borrow_mut() = Some(super::roots::Layout { root: root.clone(), boundaries: None }));
    for (name, text) in [("alpha", "src/a.mjs"), ("beta", "lib/b.mjs")] {
        write(&root, &format!("multi/{name}/package.json"), SENTINEL);
        write(&root, &format!("multi/{name}/{text}"), "export function shared() {\n  return 1;\n}\n");
    }
    write(&root, "multi/beta/lib/b.mjs", "export function shared() {\n  return 2;\n}\n\nexport function onlyBeta() {\n  return 3;\n}\n");
    write(&root, "multi/plain/c.mjs", "export function plainFn() {\n  return 1;\n}\n");
    write(&root, "one/solo/package.json", SENTINEL);
    write(&root, "one/solo/s.mjs", "export function soloFn() {\n  return 1;\n}\n");
    write(&root, "proj/package.json", SENTINEL);
    write(&root, "proj/src/a.mjs", "export function alpha() {\n  return 1;\n}\n");
    for n in 1..=10 {
        write(&root, &format!("many/p{n:02}/package.json"), SENTINEL);
        write(&root, &format!("many/p{n:02}/x.mjs"), "export function f() {\n  return 1;\n}\n");
    }
    (tmp, root)
}

fn ask(cwd: &Path, input: Value) -> Result<Answer, String> {
    let cache_dir = tempfile::tempdir().unwrap();
    let cache = super::GraphCache::new(cache_dir.path().join("cache"));
    let trust = TrustSnapshot::default();
    let env = Env { trust: &trust, cache: &cache, session_cwd: cwd };
    dispatch::run(&Args::parse(&input), cwd, &env)
}

fn sorted(roots: Option<Vec<PathBuf>>) -> Vec<PathBuf> {
    let mut roots = roots.unwrap_or_default();
    roots.sort();
    roots
}

#[test]
fn a_folder_that_holds_several_projects_answers_one_section_per_project() {
    let (_tmp, root) = tree();
    let multi = root.join("multi");
    let answer = ask(&multi, json!({ "mode": "overview" })).unwrap();
    let sections: Vec<&str> = answer.text.lines().filter(|l| l.starts_with("# project ")).collect();
    assert_eq!(sections.len(), 2, "{}", answer.text);
    assert!(sections[0].starts_with("# project alpha [") && sections[1].starts_with("# project beta ["), "{}", answer.text);
    assert_eq!(sorted(answer.dependency_roots), vec![multi.clone(), multi.join("alpha"), multi.join("beta")]);
    assert!(answer.complete);
}

#[test]
fn a_symbol_search_over_several_projects_says_which_project_has_no_match() {
    let (_tmp, root) = tree();
    let text = ask(&root.join("multi"), json!({ "mode": "find_symbol", "symbol": "onlyBeta" })).unwrap().text;
    let (alpha, beta) = text.split_once("# project beta [").expect("a section for beta");
    assert!(alpha.starts_with("# project alpha [") && alpha.contains("(no symbol matches in cwd="), "{text}");
    assert!(beta.contains("lib/b.mjs:5-7") && beta.contains("export function onlyBeta() {"), "{text}");
}

#[test]
fn a_mode_that_needs_one_project_is_refused_where_the_folder_holds_two() {
    let (_tmp, root) = tree();
    let refusal = ask(&root.join("multi"), json!({ "mode": "imports" })).err().expect("the call is refused");
    assert!(refusal.starts_with("code_graph: cwd '"), "{refusal}");
    assert!(refusal.contains("is not inside a project") && refusal.contains("holds 2 separate project roots (\"alpha\", \"beta\")"), "{refusal}");
    assert!(
        refusal.ends_with(
            "Refusing to index an arbitrary tree. Switch Project with the session tool (set-project), or pass an explicit 'cwd' (repo root) or a 'file' anchor."
        ),
        "{refusal}"
    );
}

#[test]
fn a_nearest_sentinel_above_the_temp_boundary_is_named_but_never_adopted() {
    let tmp = tempfile::tempdir().unwrap();
    let above = tmp.path().canonicalize().unwrap().join("above");
    let temp = above.join("temp");
    let multi = temp.join("ws/multi");
    write(&above, "package.json", SENTINEL);
    for name in ["alpha", "beta"] {
        write(&multi, &format!("{name}/package.json"), SENTINEL);
        write(&multi, &format!("{name}/x.mjs"), "export function x() {}\n");
    }
    super::roots::LAYOUT.with(|l| {
        *l.borrow_mut() = Some(super::roots::Layout { root: tmp.path().canonicalize().unwrap(), boundaries: Some(vec![temp.clone()]) });
    });
    let refusal = ask(&multi, json!({ "mode": "imports" })).err().expect("the call is refused");
    assert!(refusal.contains("The nearest sentinel is at '") && refusal.contains("(home/temp), which is never auto-adopted."), "{refusal}");
}

#[test]
fn a_folder_over_the_child_cap_federates_only_the_first_eight_projects() {
    let (_tmp, root) = tree();
    let many = root.join("many");
    let answer = ask(&many, json!({ "mode": "overview" })).unwrap();
    let sections = answer.text.lines().filter(|l| l.starts_with("# project ")).count();
    assert_eq!(sections, 8, "{}", answer.text);
    assert!(answer.text.contains("# project p08 [") && !answer.text.contains("# project p09 ["), "{}", answer.text);
}

#[test]
fn a_folder_holding_one_project_is_answered_as_that_project() {
    let (_tmp, root) = tree();
    let one = root.join("one");
    let answer = ask(&one, json!({ "mode": "overview" })).unwrap();
    assert!(answer.text.starts_with("# project solo ["), "{}", answer.text);
    assert_eq!(sorted(answer.dependency_roots), vec![one.clone(), one.join("solo")]);
}

#[test]
fn a_loose_folder_with_no_project_below_is_read_as_it_is() {
    let (_tmp, root) = tree();
    let plain = root.join("multi/plain");
    let answer = ask(&plain, json!({ "mode": "overview" })).unwrap();
    assert_eq!(answer.text, "files\t1\nedges\t0\njavascript\t1");
    assert_eq!(answer.dependency_roots, Some(vec![plain]));
}

#[test]
fn a_file_anchor_routes_the_call_to_the_project_that_owns_it() {
    let (_tmp, root) = tree();
    let multi = root.join("multi");
    let answer = ask(&multi, json!({ "mode": "overview", "file": "alpha/src/a.mjs" })).unwrap();
    assert!(answer.text.starts_with("file: alpha/src/a.mjs\nlanguage: javascript"), "{}", answer.text);
    assert_eq!(sorted(answer.dependency_roots), vec![multi.clone(), multi.join("alpha/src/a.mjs")]);
}

#[test]
fn file_anchors_in_two_projects_are_refused_with_the_projects_to_choose_from() {
    let (_tmp, root) = tree();
    let refusal = ask(&root.join("multi"), json!({ "mode": "overview", "files": ["alpha/src/a.mjs", "beta/lib/b.mjs"] })).err().expect("the call is refused");
    assert!(refusal.contains("aggregate file anchors do not all exist under exactly one detectable project root"), "{refusal}");
    assert!(refusal.ends_with("Project roots under this cwd: \"alpha\", \"beta\" — anchor the call inside one of them."), "{refusal}");
}

#[test]
fn an_anchor_that_is_the_working_folder_means_search_here_for_symbol_modes() {
    let (_tmp, root) = tree();
    let proj = root.join("proj");
    let found = ask(&proj, json!({ "mode": "find_symbol", "symbol": "alpha", "file": "." })).unwrap();
    assert!(found.text.contains("src/a.mjs:1-3") && found.text.contains("export function alpha() {"), "{}", found.text);
    assert_eq!(found.dependency_roots, Some(vec![proj.clone()]), "the dropped anchor adds no root");
    let also = ask(&proj, json!({ "mode": "find_symbol", "symbol": "alpha", "files": [".", "./"] })).unwrap();
    assert_eq!(also.text, found.text);
}
