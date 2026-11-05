//! Routing goldens: every `fixtures/tools/code_graph_routing/*.json` case, recorded from the Node
//! tool — federation over discovered and trusted roots, the symbol-mode cwd-anchor drop, and the
//! dependency roots each call records.
#![allow(
    clippy::disallowed_methods,
    reason = "the test builds a workspace on disk with blocking filesystem calls"
)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::args::Args;
use super::dispatch::{self, Env};
use super::federation::TrustSnapshot;

/// A recorded path with `<ROOT>` forward-slashed, the way the recorder writes it.
fn scrub(text: &str, ws: &Path, fs_root: &Path) -> String {
    let ws_text = ws.display().to_string();
    let text = text
        .replace(&ws_text, "<ROOT>")
        .replace(&ws_text.replace('\\', "/"), "<ROOT>")
        .replace(&format!("'{}'", fs_root.display()), "'<FSROOT>'");
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find("<ROOT>") {
        out.push_str(&rest[..at + 6]);
        rest = &rest[at + 6..];
        let end = rest.find(|c: char| c.is_whitespace() || "]\"',)".contains(c)).unwrap_or(rest.len());
        out.push_str(&rest[..end].replace('\\', "/"));
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn fill(text: &str, ws: &Path, fs_root: &Path) -> String {
    text.replace("<ROOT>", &ws.display().to_string().replace('\\', "/"))
        .replace("<FSROOT>", &fs_root.display().to_string().replace('\\', "/"))
}

#[test]
fn routing_matches_the_node_goldens() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools/code_graph_routing");
    let workspace: Value = serde_json::from_str(&fs::read_to_string(dir.join("workspace.json")).unwrap()).unwrap();
    let mut failures: Vec<String> = Vec::new();
    let mut cases = 0;
    let mut entries: BTreeMap<String, PathBuf> = BTreeMap::new();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        if name != "workspace" {
            entries.insert(name, path);
        }
    }
    for (name, path) in entries {
        let case: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        for (rel, text) in workspace["files"].as_object().unwrap() {
            let target = ws.join(rel);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, text.as_str().unwrap()).unwrap();
        }
        let fs_root = tmp.path().ancestors().last().unwrap().to_path_buf();
        let cwd = match case["cwd"].as_str().unwrap() {
            "<FSROOT>" => fs_root.clone(),
            rel => ws.join(rel),
        };
        let session = case.get("session").and_then(Value::as_str).map(|rel| ws.join(rel)).unwrap_or_else(|| cwd.clone());
        let session = if session.is_file() { session.parent().unwrap().to_path_buf() } else { session };
        let registered = TrustSnapshot::of(
            case.get("registered")
                .and_then(Value::as_array)
                .map(|rels| rels.iter().map(|rel| ws.join(rel.as_str().unwrap())).collect())
                .unwrap_or_default(),
        );
        let input: Value = serde_json::from_str(&fill(&case["input"].to_string(), &ws, &fs_root)).unwrap();
        let cache = super::GraphCache::new(tmp.path().join("cache"));
        let env = Env { trust: &registered, cache: &cache, session_cwd: &session };
        let got = dispatch::run(&Args::parse(&input), &cwd, &env);
        cases += 1;
        let (text, roots, complete) = match &got {
            Ok(answer) => (Ok(scrub(&answer.text, &ws, &fs_root)), answer.dependency_roots.clone(), answer.complete),
            Err(message) => (Err(scrub(message, &ws, &fs_root)), None, true),
        };
        let want_text = match case.get("thrown") {
            Some(thrown) => Err(thrown.as_str().unwrap().to_owned()),
            None => Ok(case["text"].as_str().unwrap().to_owned()),
        };
        if text != want_text {
            failures.push(format!("{name}: text\n  got : {text:?}\n  want: {want_text:?}"));
            continue;
        }
        // A thrown call records the roots it resolved before failing; Rust returns no answer then.
        if got.is_ok() {
            let mut got_roots: Vec<String> = roots
                .unwrap_or_default()
                .iter()
                .map(|root| if root == &fs_root { "<FSROOT>".to_owned() } else { scrub(&root.display().to_string(), &ws, &fs_root) })
                .collect();
            got_roots.sort();
            got_roots.dedup();
            let want_roots: Vec<String> = case["dependencyRoots"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_owned()).collect();
            if got_roots != want_roots {
                failures.push(format!("{name}: dependency roots\n  got : {got_roots:?}\n  want: {want_roots:?}"));
            }
            if complete != case["complete"].as_bool().unwrap() {
                failures.push(format!("{name}: complete is {complete}, want {}", case["complete"]));
            }
        }
    }
    assert!(cases >= 30, "only {cases} routing goldens found");
    assert!(failures.is_empty(), "{} of {cases} routing cases differ:\n{}", failures.len(), failures.join("\n"));
}
