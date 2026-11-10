//! Golden tests: every `fixtures/tools/code_graph/*.json` case against a small project.
#![allow(
    clippy::disallowed_methods,
    reason = "the test builds a project on disk with blocking filesystem calls"
)]


use std::fs;
use std::path::Path;

use serde_json::Value;

use super::args::Args;
use super::dispatch;

const PROJECT: [(&str, &str); 4] = [
    (
        "src/lib/math.mjs",
        "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n",
    ),
    (
        "src/lib/util.mjs",
        "import { add } from './math.mjs';\n\nexport const twice = (x) => add(x, x);\n",
    ),
    (
        "src/main.mjs",
        "import { add, sub } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2) + sub(5, 3);\n}\n\nexport function other() {\n  return add(3, 4);\n}\n",
    ),
    (
        "src/app.py",
        "def greet(name):\n    return name\n\n\nclass Greeter:\n    def run(self):\n        return 1\n",
    ),
];

#[test]
fn code_graph_matches_golden_fixtures() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("ws");
    for (rel, text) in PROJECT {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let root = root.canonicalize().unwrap();
    let root_text = root.display().to_string();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools/code_graph");
    let mut cases = 0;
    let mut failures: Vec<String> = Vec::new();
    let (_cache_dir, cache) = no_cache();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let case: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let env = dispatch::Env { trust: &no_roots(), cache: &cache, session_cwd: &root };
        let got = dispatch::run(&Args::parse(&case["input"]), &root, &env)
            .map(|answer| answer.text.replace(&root_text, "<ROOT>"))
            .map_err(|e| e.replace(&root_text, "<ROOT>"));
        let want = match case.get("thrown") {
            Some(t) => Err(t.as_str().unwrap().to_owned()),
            // These goldens were recorded on Windows, where Node's graph-cache manifest key is
            // lowercased and so is not "self": the call federated over its own cwd and gained a
            // `# project ws [<ROOT>]` header. A clean run has no header (see code_graph_routing).
            None => Ok(case["text"].as_str().unwrap().trim_start_matches("# project ws [<ROOT>]\n").to_owned()),
        };
        cases += 1;
        if got != want {
            failures.push(format!("{}\n  want: {want:?}\n  got:  {got:?}", path.display()));
        }
    }
    assert!(cases >= 20);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn project_with_sentinel() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("src/a.mjs"), "export const a = 1;\n").unwrap();
    fs::write(root.join("src/b.mjs"), "import { a } from './a.mjs';\nexport const b = a;\n").unwrap();
    let root = root.canonicalize().unwrap();
    (tmp, root)
}

fn roots_of(input: Value, cwd: &Path) -> Option<Vec<std::path::PathBuf>> {
    run_with(input, cwd).dependency_roots
}

/// A cache in a temp directory that lives as long as the returned guard.
fn no_cache() -> (tempfile::TempDir, super::GraphCache) {
    let dir = tempfile::tempdir().unwrap();
    let cache = super::GraphCache::new(dir.path().join("cache"));
    (dir, cache)
}

struct NoTrust;

#[async_trait::async_trait]
impl super::TrustedRoots for NoTrust {
    async fn registered(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }

    async fn selected(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

/// `prewarmCodeGraphIfProject`: a folder inside a project warms the project's graph into the cache; a
/// folder that is no project (here a bare temp folder: the implicit walk stops at it) warms nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prewarm_builds_the_graph_of_the_project_and_only_of_a_project() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = std::sync::Arc::new(cache);
    let tool = super::CodeGraphTool::new(std::sync::Arc::new(NoTrust), cache.clone());
    let tokens = mixdog_rt::testing::tokens();
    let cancel = mixdog_rt::CancellationToken::new();
    assert!(tool.prewarm_if_project(&root.join("src"), tokens.maintenance_io, &cancel).await);
    cache.flush().unwrap();
    assert_eq!(cache.load(&root).map(|files| files.len()), Some(2), "both source files are cached");
    let bare = tempfile::tempdir().unwrap();
    assert!(!tool.prewarm_if_project(bare.path(), tokens.maintenance_io, &cancel).await);
}

/// A trust snapshot that knows no registered, selected or cached root.
fn no_roots() -> super::federation::TrustSnapshot {
    super::federation::TrustSnapshot::default()
}

fn run_with(input: Value, cwd: &Path) -> super::dispatch::Answer {
    let (_dir, cache) = no_cache();
    let env = dispatch::Env { trust: &no_roots(), cache: &cache, session_cwd: cwd };
    dispatch::run(&Args::parse(&input), cwd, &env).unwrap()
}

#[test]
fn a_build_reuses_cached_files_only_while_their_signature_matches() {
    let (_tmp, root) = project_with_sentinel();
    let (cache_dir, cache) = no_cache();
    let text_of = |graph: &super::graph::Graph| graph.node("src/a.mjs").unwrap().text.clone();
    let first = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(text_of(&first), "export const a = 1;\n");
    cache.flush().unwrap();
    // Alter the cached copy in place: a build that answers with it has reused the entry.
    let payload = fs::read_dir(cache_dir.path().join("cache"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().unwrap() != "manifest.json")
        .unwrap();
    let altered = fs::read_to_string(&payload).unwrap().replace("a = 1;", "a = 9;");
    fs::write(&payload, altered).unwrap();
    let reused = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(text_of(&reused), "export const a = 9;\n", "an unchanged file comes from the cache");
    // A changed file (new size) is read and parsed again.
    fs::write(root.join("src/a.mjs"), "export const a = 123;\n").unwrap();
    let reparsed = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(text_of(&reparsed), "export const a = 123;\n");
    assert_eq!(reparsed.node("src/b.mjs").unwrap().resolved_imports, vec!["src/a.mjs".to_owned()]);
}

#[test]
fn a_fanned_out_call_with_one_missing_file_is_incomplete() {
    let (_tmp, root) = project_with_sentinel();
    let good = run_with(serde_json::json!({ "mode": "imports", "files": ["src/a.mjs", "src/b.mjs"] }), &root);
    assert!(good.complete, "{}", good.text);
    let mixed = run_with(serde_json::json!({ "mode": "imports", "files": ["src/a.mjs", "src/none.mjs"] }), &root);
    assert!(mixed.text.contains("# imports src/none.mjs\nError:"), "{}", mixed.text);
    assert!(!mixed.complete);
    let symbols = run_with(serde_json::json!({ "mode": "find_symbol", "symbol": "a", "files": ["src/a.mjs", "src/none.mjs"] }), &root);
    assert!(!symbols.complete, "{}", symbols.text);
}


#[test]
fn dependency_roots_are_the_graph_root_and_each_anchor_as_node_records_them() {
    let (_tmp, root) = project_with_sentinel();
    // No anchor: just the root the graph was built from.
    assert_eq!(roots_of(serde_json::json!({ "mode": "overview" }), &root), Some(vec![root.clone()]));
    // From a subfolder the root is the enclosing project, not the cwd.
    assert_eq!(roots_of(serde_json::json!({ "mode": "overview" }), &root.join("src")), Some(vec![root.clone()]));
    // A file anchor adds its absolute path next to the root.
    assert_eq!(
        roots_of(serde_json::json!({ "mode": "imports", "file": "src/b.mjs" }), &root),
        Some(vec![root.clone(), root.join("src/b.mjs")])
    );
    // An aggregate inside a project records every anchor, deduplicated, and not the cwd.
    assert_eq!(
        roots_of(serde_json::json!({ "mode": "imports", "files": ["src/a.mjs", "src/b.mjs", "src/a.mjs"] }), &root),
        Some(vec![root.clone(), root.join("src/a.mjs"), root.join("src/b.mjs")])
    );
    // A missing file answers without recording anything, so the answer is never cached.
    assert_eq!(roots_of(serde_json::json!({ "mode": "imports", "file": "src/none.mjs" }), &root), None);
}

#[test]
fn an_aggregate_with_no_project_at_the_cwd_also_depends_on_the_cwd() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join("loose");
    fs::create_dir_all(&base).unwrap();
    fs::write(base.join("x.mjs"), "export const x = 1;\n").unwrap();
    let base = base.canonicalize().unwrap();
    let roots = roots_of(serde_json::json!({ "mode": "imports", "files": ["x.mjs"] }), &base).unwrap();
    assert_eq!(roots.first(), Some(&base), "routing hangs off the cwd when no project is there");
    assert!(roots.contains(&base.join("x.mjs")));
}

#[test]
fn the_tool_output_carries_the_roots_in_meta() {
    let output = super::ToolOutput {
        meta: Some(serde_json::json!({ super::DEPENDENCY_ROOTS_META: ["/p", "/p/a.rs"] })),
        ..super::ToolOutput::default()
    };
    assert_eq!(super::dependency_roots(&output), Some(vec!["/p".to_owned(), "/p/a.rs".to_owned()]));
    assert_eq!(super::dependency_roots(&super::ToolOutput::default()), None);
}
